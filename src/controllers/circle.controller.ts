import type { Request, Response, NextFunction } from 'express';
import prisma from '../../lib/prisma';
import { Prisma } from '../../generated/prisma/client';

class CircleController {
  static async getCircles(req: Request, res: Response, next: NextFunction) {
    try {
      const { search } = req.query;

      const where: Prisma.CircleWhereInput = { status: 'ACTIVE' };

      if (search) {
        where.OR = [
          { code: { contains: search as string } },
          { name: { contains: search as string } }
        ];
      }

      const circles = await prisma.circle.findMany({
        where,
        select: { id: true, code: true, name: true, status: true },
        orderBy: { name: 'asc' }
      });

      res.status(200).json({
        message: 'Circles retrieved successfully',
        data: { circles }
      });
    } catch (error) {
      next(error);
    }
  }

  static async createCircle(req: Request, res: Response, next: NextFunction) {
    try {
      const name = typeof req.body.name === 'string' ? req.body.name.trim().replace(/\s+/g, ' ') : '';

      if (!name) {
        const err = new Error('name is required');
        (err as any).status = 400;
        throw err;
      }

      // Circle codes are the uppercased name, matching existing circles (West Java -> WEST JAVA)
      const code = name.toUpperCase();

      const existing = await prisma.circle.findUnique({ where: { code } });
      if (existing) {
        const err = new Error(`${existing.name} already exists`);
        (err as any).status = 409;
        throw err;
      }

      const circle = await prisma.circle.create({
        data: { code, name },
        select: { id: true, code: true, name: true, status: true }
      });

      res.status(201).json({
        message: 'Circle created successfully',
        data: { circle }
      });
    } catch (error) {
      next(error);
    }
  }
}

export default CircleController;
