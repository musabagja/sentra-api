import type { Request, Response, NextFunction } from 'express';
import prisma from '../../lib/prisma';
import { Prisma } from '../../generated/prisma/client';

import Bcrypt from '../utils/bcrypt.util';
import { USER_STATUS, isRestrictedAccess } from '../utils/access.util';

const MIN_PASSWORD_LENGTH = 8;
const MAX_NAME_LENGTH = 120;
const CODE_ATTEMPTS = 5;

const httpError = (status: number, message: string) => {
  const err = new Error(message);
  (err as any).status = status;
  return err;
};

/** Never expose the password hash */
const userSelect = {
  id: true,
  code: true,
  name: true,
  circleCode: true,
  status: true,
  createdAt: true,
  circle: { select: { name: true } }
} satisfies Prisma.UserSelect;

/** 13 digits, like the existing generated user codes (a millisecond timestamp plus jitter) */
const generateUserCode = () =>
  `${Date.now()}`.slice(-10) + String(Math.floor(Math.random() * 1000)).padStart(3, '0');

// A user code is what the person types to sign in: letters and digits only, any case
// (stored upper-case, so two codes can never differ only by letter case)
const USER_CODE_PATTERN = /^[A-Z0-9]{4,20}$/;
const USER_CODE_HINT = 'Gunakan 4-20 karakter: hanya huruf dan angka';

const normalizeUserCode = (value: unknown): string =>
  typeof value === 'string' ? value.trim().toUpperCase() : '';

const isUserCodeTaken = async (code: string) =>
  !!(await prisma.user.findUnique({ where: { code }, select: { id: true } }));

const cleanName = (value: unknown): string => {
  const name = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (!name) throw httpError(400, 'Nama wajib diisi');
  if (name.length > MAX_NAME_LENGTH) throw httpError(400, `Nama maksimal ${MAX_NAME_LENGTH} karakter`);
  return name;
};

const cleanPassword = (value: unknown): string => {
  if (typeof value !== 'string' || value.length < MIN_PASSWORD_LENGTH) {
    throw httpError(400, `Password minimal ${MIN_PASSWORD_LENGTH} karakter`);
  }
  return value;
};

const requireCircle = async (circleCode: unknown): Promise<string> => {
  if (typeof circleCode !== 'string' || !circleCode) throw httpError(400, 'Circle wajib dipilih');
  const circle = await prisma.circle.findUnique({ where: { code: circleCode } });
  if (!circle) throw httpError(400, `Circle tidak dikenal: ${circleCode}`);
  return circle.code;
};

/** Codes the caller currently holds (active permissions) */
const callerAccessCodes = async (userCode: string): Promise<string[]> => {
  const permissions = await prisma.permission.findMany({
    where: { userCode, status: true },
    select: { accessCode: true }
  });
  return permissions.map((p) => p.accessCode);
};

/**
 * Validates requested access codes: an array of existing, non-restricted codes
 * that the caller holds themselves. Returns the de-duplicated list.
 */
const validateAccessCodes = async (value: unknown): Promise<string[]> => {
  if (!Array.isArray(value) || value.some((c) => typeof c !== 'string')) {
    throw httpError(400, 'Daftar akses tidak valid');
  }
  const requested: string[] = [...new Set(value as string[])];

  const restricted = requested.filter(isRestrictedAccess);
  if (restricted.length > 0) {
    throw httpError(403, `Akses ini tidak dapat diberikan lewat aplikasi: ${restricted.join(', ')}`);
  }

  const known = await prisma.access.findMany({
    where: { code: { in: requested } },
    select: { code: true }
  });
  const unknown = requested.filter((c) => !known.some((a) => a.code === c));
  if (unknown.length > 0) throw httpError(400, `Kode akses tidak dikenal: ${unknown.join(', ')}`);

  return requested;
};

class UserAdminController {
  /** Accesses that can be granted from the User form (restricted ones are never listed) */
  static async getAccessOptions(req: Request, res: Response, next: NextFunction) {
    try {
      const all = await prisma.access.findMany({
        select: { code: true, name: true, description: true },
        orderBy: { id: 'asc' }
      });
      res.status(200).json({
        message: 'Accesses retrieved successfully',
        data: { accesses: all.filter((access) => !isRestrictedAccess(access.code)) }
      });
    } catch (error) {
      next(error);
    }
  }

  /** Live check while the admin types a code in the create form */
  static async checkCode(req: Request, res: Response, next: NextFunction) {
    try {
      const code = normalizeUserCode(req.query.code);
      if (!USER_CODE_PATTERN.test(code)) {
        res.status(200).json({
          message: 'Code checked',
          data: { code, valid: false, available: false, reason: USER_CODE_HINT }
        });
        return;
      }
      res.status(200).json({
        message: 'Code checked',
        data: { code, valid: true, available: !(await isUserCodeTaken(code)) }
      });
    } catch (error) {
      next(error);
    }
  }

  /** An unused generated code for the "Buat otomatis" button */
  static async suggestCode(req: Request, res: Response, next: NextFunction) {
    try {
      for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt++) {
        const code = generateUserCode();
        if (!(await isUserCodeTaken(code))) {
          res.status(200).json({ message: 'Code suggested', data: { code } });
          return;
        }
      }
      throw httpError(503, 'Tidak menemukan kode yang masih kosong, coba lagi');
    } catch (error) {
      next(error);
    }
  }

  static async getUsers(req: Request, res: Response, next: NextFunction) {
    try {
      const { page = 1, limit = 10, search, circle, status } = req.query;

      const where: Prisma.UserWhereInput = {};
      if (circle) where.circleCode = String(circle);
      if (status) where.status = String(status);
      if (search) {
        where.OR = [
          { code: { contains: String(search) } },
          { name: { contains: String(search) } }
        ];
      }

      // Tab counts follow the search/circle filters but not the status tab itself
      const { status: _ignored, ...countWhere } = where;

      const [users, total, grouped] = await Promise.all([
        prisma.user.findMany({
          where,
          select: {
            ...userSelect,
            _count: { select: { permissions: true } }
          },
          skip: (Number(page) - 1) * Number(limit),
          take: Number(limit),
          orderBy: [{ name: 'asc' }, { id: 'asc' }]
        }),
        prisma.user.count({ where }),
        prisma.user.groupBy({
          by: ['status'],
          where: countWhere,
          _count: { _all: true }
        })
      ]);

      const counts = { all: 0, active: 0, frozen: 0 };
      for (const row of grouped) {
        counts.all += row._count._all;
        if (row.status === USER_STATUS.ACTIVE) counts.active = row._count._all;
        if (row.status === USER_STATUS.FROZEN) counts.frozen = row._count._all;
      }

      res.status(200).json({
        message: 'Users retrieved successfully',
        data: {
          users: users.map(({ _count, ...user }) => ({ ...user, accessCount: _count.permissions })),
          counts
        },
        pagination: {
          page: Number(page),
          limit: Number(limit),
          total,
          pages: Math.ceil(total / Number(limit))
        }
      });
    } catch (error) {
      next(error);
    }
  }

  static async getUser(req: Request, res: Response, next: NextFunction) {
    try {
      const code = String(req.params.code);
      const [user, activeSession] = await Promise.all([
        prisma.user.findUnique({
          where: { code },
          select: {
            ...userSelect,
            updatedAt: true,
            permissions: {
              where: { status: true },
              orderBy: { access: { id: 'asc' } },
              select: {
                accessCode: true,
                access: { select: { code: true, name: true, description: true } }
              }
            }
          }
        }),
        // Whether the user is signed in right now: an unexpired session exists.
        // Only the start time is exposed, never the session id.
        prisma.session.findFirst({
          where: { userCode: code, expiresAt: { gt: new Date() } },
          orderBy: { createdAt: 'desc' },
          select: { createdAt: true }
        })
      ]);
      if (!user) throw httpError(404, 'User tidak ditemukan');

      const { permissions, ...rest } = user;
      // Accesses of the Manajemen Akun menu are granted only in the database and never listed
      const shown = permissions.filter((p) => !isRestrictedAccess(p.accessCode));
      res.status(200).json({
        message: 'User retrieved successfully',
        data: {
          user: {
            ...rest,
            accessCodes: shown.map((p) => p.accessCode),
            accesses: shown.map((p) => p.access),
            signedInSince: activeSession?.createdAt ?? null
          }
        }
      });
    } catch (error) {
      next(error);
    }
  }

  static async createUser(req: Request, res: Response, next: NextFunction) {
    try {
      const name = cleanName(req.body.name);
      const password = cleanPassword(req.body.password);
      const circleCode = await requireCircle(req.body.circleCode);
      const accessCodes = await validateAccessCodes(req.body.accessCodes ?? []);

      const held = await callerAccessCodes(req.user!.code);
      const notHeld = accessCodes.filter((c) => !held.includes(c));
      if (notHeld.length > 0) {
        throw httpError(403, `Anda tidak dapat memberikan akses yang tidak Anda miliki: ${notHeld.join(', ')}`);
      }

      const passwordHash = Bcrypt.hash(password);

      // A code typed by the admin is used as is (and must be free); without one it is generated
      const requestedCode = normalizeUserCode(req.body.code);
      if (req.body.code !== undefined && req.body.code !== '' && !USER_CODE_PATTERN.test(requestedCode)) {
        throw httpError(400, USER_CODE_HINT);
      }
      if (requestedCode && (await isUserCodeTaken(requestedCode))) {
        throw httpError(409, 'Kode ini sudah dipakai user lain');
      }

      let user;
      for (let attempt = 1; !user; attempt++) {
        const code = requestedCode || generateUserCode();
        try {
          user = await prisma.$transaction(async (tx) => {
            const created = await tx.user.create({
              data: { code, name, circleCode, password: passwordHash, status: USER_STATUS.ACTIVE },
              select: userSelect
            });
            if (accessCodes.length > 0) {
              await tx.permission.createMany({
                data: accessCodes.map((accessCode) => ({ userCode: code, accessCode, status: true }))
              });
            }
            return created;
          });
        } catch (error) {
          const isDuplicate =
            error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
          // Someone took the typed code between the check and the insert
          if (isDuplicate && requestedCode) throw httpError(409, 'Kode ini sudah dipakai user lain');
          if (!isDuplicate || attempt >= CODE_ATTEMPTS) throw error;
        }
      }

      res.status(201).json({
        message: 'User created successfully',
        data: { user: { ...user, accessCodes } }
      });
    } catch (error) {
      next(error);
    }
  }

  static async updateUser(req: Request, res: Response, next: NextFunction) {
    try {
      const code = String(req.params.code);
      const existing = await prisma.user.findUnique({ where: { code } });
      if (!existing) throw httpError(404, 'User tidak ditemukan');

      // The code is the sign-in name and the key of every record of the user: never changed
      if (req.body.code !== undefined && normalizeUserCode(req.body.code) !== existing.code.toUpperCase()) {
        throw httpError(400, 'Kode user tidak dapat diubah');
      }

      const { name, circleCode, accessCodes, password } = req.body;
      const data: Prisma.UserUpdateInput = {};
      if (name !== undefined) data.name = cleanName(name);
      if (circleCode !== undefined) {
        data.circle = { connect: { code: await requireCircle(circleCode) } };
      }
      if (password !== undefined && password !== '') {
        data.password = Bcrypt.hash(cleanPassword(password));
      }

      let toAdd: string[] = [];
      let toRemove: string[] = [];
      if (accessCodes !== undefined) {
        const requested = await validateAccessCodes(accessCodes);
        const [held, current] = await Promise.all([
          callerAccessCodes(req.user!.code),
          callerAccessCodes(code)
        ]);
        // Restricted accesses are outside this form: never part of the diff
        const currentManaged = current.filter((c) => !isRestrictedAccess(c));
        toAdd = requested.filter((c) => !currentManaged.includes(c));
        toRemove = currentManaged.filter((c) => !requested.includes(c));

        const notHeld = [...toAdd, ...toRemove].filter((c) => !held.includes(c));
        if (notHeld.length > 0) {
          throw httpError(403, `Anda tidak dapat memberi atau mencabut akses yang tidak Anda miliki: ${notHeld.join(', ')}`);
        }
      }

      const updated = await prisma.$transaction(async (tx) => {
        const user = await tx.user.update({ where: { code }, data, select: userSelect });

        for (const accessCode of toAdd) {
          await tx.permission.upsert({
            where: { userCode_accessCode: { userCode: code, accessCode } },
            update: { status: true },
            create: { userCode: code, accessCode, status: true }
          });
        }
        if (toRemove.length > 0) {
          // Revoke by deleting: sign-in returns every permission row regardless of status
          await tx.permission.deleteMany({
            where: { userCode: code, accessCode: { in: toRemove } }
          });
        }

        // A password reset signs the user out everywhere
        if (data.password) await tx.session.deleteMany({ where: { userCode: code } });

        return user;
      });

      res.status(200).json({
        message: 'User updated successfully',
        data: { user: updated, added: toAdd, removed: toRemove }
      });
    } catch (error) {
      next(error);
    }
  }

  /** Builds the freeze / unfreeze handler */
  static setFrozen(freeze: boolean) {
    return async (req: Request, res: Response, next: NextFunction) => {
      try {
        const code = String(req.params.code);
        if (freeze && code === req.user!.code) {
          throw httpError(400, 'Anda tidak dapat membekukan akun Anda sendiri');
        }

        const existing = await prisma.user.findUnique({ where: { code } });
        if (!existing) throw httpError(404, 'User tidak ditemukan');

        const user = await prisma.$transaction(async (tx) => {
          const updated = await tx.user.update({
            where: { code },
            data: { status: freeze ? USER_STATUS.FROZEN : USER_STATUS.ACTIVE },
            select: userSelect
          });
          // Removing sessions makes the user's next request fail right away,
          // instead of waiting for the 15-minute access token to expire
          if (freeze) await tx.session.deleteMany({ where: { userCode: code } });
          return updated;
        });

        res.status(200).json({
          message: freeze ? 'User frozen successfully' : 'User unfrozen successfully',
          data: { user }
        });
      } catch (error) {
        next(error);
      }
    };
  }
}

export default UserAdminController;
