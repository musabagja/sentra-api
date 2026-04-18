import type { NextFunction, Request, Response } from "express";
import prisma from "../../lib/prisma";

class OpnameController {
  // ============================================================================
  // OPNAME CRUD OPERATIONS
  // ============================================================================

  static async createOpname(req: Request, res: Response, next: NextFunction) {
    try {
      const { amount, batch, type, checkpointCode, userCode } = req.body;

      const opname = await prisma.opname.create({
        data: {
          amount,
          batch,
          type,
          checkpointCode,
          userCode
        },
        include: {
          updates: {
            include: {
              opname: true
            }
          }
        }
      });

      res.status(201).json({
        message: 'Opname created successfully',
        data: opname
      });
    } catch (error) {
      next(error);
    }
  }

  static async getOpnames(req: Request, res: Response, next: NextFunction) {
    try {
      const { page = 1, limit = 10, checkpointCode, type } = req.query;

      const where: any = {};
      if (checkpointCode) where.checkpointCode = checkpointCode;
      if (type) where.type = type;

      const [opnames, total] = await Promise.all([
        prisma.opname.findMany({
          where,
          skip: (Number(page) - 1) * Number(limit),
          take: Number(limit),
          include: {
            updates: {
              include: {
                opname: true
              },
              take: 10
            },
            _count: {
              select: {
                updates: true
              }
            }
          },
          orderBy: { createdAt: 'desc' }
        }),
        prisma.opname.count({ where })
      ]);

      res.status(200).json({
        message: 'Opnames retrieved successfully',
        data: opnames,
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

  static async getOpname(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;

      const opname = await prisma.opname.findUnique({
        where: { id: Number(id) },
        include: {
          updates: {
            include: {
              opname: true
            },
            orderBy: { createdAt: 'desc' }
          }
        }
      });

      if (!opname) {
        throw new Error('Opname not found');
      }

      res.status(200).json({
        message: 'Opname retrieved successfully',
        data: opname
      });
    } catch (error) {
      next(error);
    }
  }

  static async updateOpname(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const { amount } = req.body;

      const opname = await prisma.opname.update({
        where: { id: Number(id) },
        data: {
          ...(amount !== undefined && { amount })
        },
        include: {
          updates: {
            include: {
              opname: true
            }
          }
        }
      });

      res.status(200).json({
        message: 'Opname updated successfully',
        data: opname
      });
    } catch (error) {
      next(error);
    }
  }

  static async deleteOpname(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;

      await prisma.opname.delete({
        where: { id: Number(id) }
      });

      res.status(200).json({
        message: 'Opname deleted successfully'
      });
    } catch (error) {
      next(error);
    }
  }
}

export default OpnameController;