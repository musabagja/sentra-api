import type { Request, Response, NextFunction } from 'express';
import prisma from '../../lib/prisma';
import { Prisma } from '../../generated/prisma/client';

import { CHECKPOINT_MANAGE_ACCESS, isRestrictedAccess } from '../utils/access.util';

class AccessController {
  static async getAccesses(req: Request, res: Response, next: NextFunction) {
    try {
      const all = await prisma.access.findMany({
        select: { code: true, name: true, description: true },
        orderBy: { id: 'asc' }
      });
      // Restricted accesses (User menu) are granted only in the database
      const accesses = all.filter((access) => !isRestrictedAccess(access.code));

      res.status(200).json({
        message: 'Accesses retrieved successfully',
        data: { accesses }
      });
    } catch (error) {
      next(error);
    }
  }

  static async getUsers(req: Request, res: Response, next: NextFunction) {
    try {
      const { page = 1, limit, search } = req.query;

      // Granters only manage users in their own circle (a holder of the all-circles access: any circle)
      const where: Prisma.UserWhereInput = {
        ...(req.allCircles ? {} : { circleCode: req.user!.circleCode }),
        status: 'ACTIVE'
      };

      if (search) {
        where.OR = [
          { code: { contains: search as string } },
          { name: { contains: search as string } }
        ];
      }

      const paginated = limit !== undefined;

      const [users, total] = await Promise.all([
        prisma.user.findMany({
          where,
          ...(paginated && {
            skip: (Number(page) - 1) * Number(limit),
            take: Number(limit)
          }),
          select: {
            code: true,
            name: true,
            phone: true,
            circleCode: true,
            permissions: { where: { status: true }, select: { accessCode: true } }
          },
          orderBy: { name: 'asc' }
        }),
        prisma.user.count({ where })
      ]);

      res.status(200).json({
        message: 'Users retrieved successfully',
        data: {
          users: users.map(({ permissions, ...user }) => ({
            ...user,
            accessCodes: permissions.map((p) => p.accessCode)
          }))
        },
        ...(paginated && {
          pagination: {
            page: Number(page),
            limit: Number(limit),
            total,
            pages: Math.ceil(total / Number(limit))
          }
        })
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Replaces a user's active accesses with the given set. The granter may only
   * add or remove access codes they hold themselves; codes they don't hold are
   * left as they are.
   */
  static async updateUserAccesses(req: Request, res: Response, next: NextFunction) {
    try {
      const userCode = String(req.params.userCode);
      const { accessCodes } = req.body;

      if (!Array.isArray(accessCodes) || accessCodes.some((c) => typeof c !== 'string')) {
        const err = new Error('Daftar akses tidak valid');
        (err as any).status = 400;
        throw err;
      }

      const target = await prisma.user.findUnique({ where: { code: userCode } });
      if (!target || (!req.allCircles && target.circleCode !== req.user!.circleCode)) {
        const err = new Error('User tidak ditemukan');
        (err as any).status = 404;
        throw err;
      }

      const requested: string[] = [...new Set(accessCodes as string[])];

      // User-menu accesses are granted only in the database
      const restrictedRequested = requested.filter(isRestrictedAccess);
      if (restrictedRequested.length > 0) {
        const err = new Error(`Akses ini tidak dapat diberikan lewat aplikasi: ${restrictedRequested.join(', ')}`);
        (err as any).status = 403;
        throw err;
      }

      const known = await prisma.access.findMany({
        where: { code: { in: requested } },
        select: { code: true }
      });
      const unknown = requested.filter((c) => !known.some((a) => a.code === c));
      if (unknown.length > 0) {
        const err = new Error(`Kode akses tidak dikenal: ${unknown.join(', ')}`);
        (err as any).status = 400;
        throw err;
      }

      const [granterPermissions, targetPermissions] = await Promise.all([
        prisma.permission.findMany({
          where: { userCode: req.user!.code, status: true },
          select: { accessCode: true }
        }),
        prisma.permission.findMany({
          where: { userCode: target.code, status: true },
          select: { accessCode: true }
        })
      ]);
      const granterCodes = granterPermissions.map((p) => p.accessCode);
      // Restricted accesses are never part of this diff, so the list (which hides
      // them) can't silently revoke them
      const currentCodes = targetPermissions
        .map((p) => p.accessCode)
        .filter((code) => !isRestrictedAccess(code));

      const added = requested.filter((c) => !currentCodes.includes(c));
      const removed = currentCodes.filter((c) => !requested.includes(c));

      const notHeld = [...added, ...removed].filter((c) => !granterCodes.includes(c));
      if (notHeld.length > 0) {
        const err = new Error(`Anda tidak dapat memberi atau mencabut akses yang tidak Anda miliki: ${notHeld.join(', ')}`);
        (err as any).status = 403;
        throw err;
      }

      if (target.code === req.user!.code && removed.includes(CHECKPOINT_MANAGE_ACCESS)) {
        const err = new Error('Anda tidak dapat mencabut akses pengelolaan akses milik Anda sendiri');
        (err as any).status = 400;
        throw err;
      }

      await prisma.$transaction(async (tx) => {
        for (const accessCode of added) {
          await tx.permission.upsert({
            where: { userCode_accessCode: { userCode: target.code, accessCode } },
            update: { status: true },
            create: { userCode: target.code, accessCode, status: true }
          });
        }

        // Revoke by deleting: sign-in returns every permission row regardless of status
        if (removed.length > 0) {
          await tx.permission.deleteMany({
            where: { userCode: target.code, accessCode: { in: removed } }
          });
        }
      });

      res.status(200).json({
        message: 'User accesses updated successfully',
        data: { userCode: target.code, accessCodes: requested, added, removed }
      });
    } catch (error) {
      next(error);
    }
  }
}

export default AccessController;
