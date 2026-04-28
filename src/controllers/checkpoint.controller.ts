import type { Request, Response, NextFunction } from 'express';
import prisma from '../../lib/prisma';
import { Prisma } from '../../generated/prisma/client';

class CheckpointController {
  static async createCheckpoint(req: Request, res: Response, next: NextFunction) {
    try {
      const { code, type, name } = req.body;

      const checkpoint = await prisma.checkpoint.create({
        data: {
          code,
          type,
          name
        }
      });

      res.status(201).json({
        message: 'Checkpoint created successfully',
        data: checkpoint
      });
    } catch (error) {
      next(error);
    }
  }

  static async getCheckpoints(req: Request, res: Response, next: NextFunction) {
    try {
      const { page = 1, limit = 10, type, search } = req.query;

      const where: Prisma.CheckpointWhereInput = {};
      if (type) {
        where.type = type as any;
      }

      if (search) {
        where.OR = [
          {
            code: {
              contains: search as string,
              mode: 'insensitive'
            }
          },
          {
            name: {
              contains: search as string,
              mode: 'insensitive'
            }
          }
        ]
      }

      const findManyOptions: any = {
        where,
        skip: (Number(page) - 1) * Number(limit),
        include: {
          _count: {
            select: {
              cards: true,
              merges: true
            }
          }
        },
        orderBy: { createdAt: 'desc' }
      };

      if (limit) {
        findManyOptions.take = Number(limit);
      }

      const [checkpoints, total] = await Promise.all([
        prisma.checkpoint.findMany(findManyOptions),
        prisma.checkpoint.count({ where })
      ]);

      res.status(200).json({
        message: 'Checkpoints retrieved successfully',
        data: checkpoints,
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

  static async getCheckpoint(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;

      const checkpoint = await prisma.checkpoint.findUnique({
        where: { id: Number(id) },
        include: {
          cards: {
            include: {
              movements: {
                orderBy: { createdAt: 'desc' },
                take: 5
              }
            }
          },
          _count: {
            select: {
              cards: true
            }
          }
        }
      });

      if (!checkpoint) {
        throw new Error('Checkpoint not found');
      }

      const [totalCard, totalSold, totalVerified] = await Promise.all([
        prisma.card.count({
          where: {
            checkpointCode: checkpoint.code
          }
        }),
        prisma.card.count({
          where: {
            checkpointCode: checkpoint.code,
            status: 'SOLD'
          }
        }),
        prisma.card.count({
          where: {
            checkpointCode: checkpoint.code,
            status: 'VERIFIED'
          }
        })
      ]);

      if (!checkpoint) {
        throw new Error('Checkpoint not found');
      }

      res.status(200).json({
        message: 'Checkpoint retrieved successfully',
        data: {
          checkpoint,
          amount: {
            card: totalCard,
            sold: totalSold,
            verified: totalVerified
          }
        }
      });
    } catch (error) {
      next(error);
    }
  }

  static async updateCheckpoint(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const { code, type, name } = req.body;

      const checkpoint = await prisma.checkpoint.update({
        where: { id: Number(id) },
        data: {
          ...(code && { code }),
          ...(type && { type }),
          ...(name && { name })
        }
      });

      res.status(200).json({
        message: 'Checkpoint updated successfully',
        data: checkpoint
      });
    } catch (error) {
      next(error);
    }
  }

  static async deleteCheckpoint(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;

      await prisma.checkpoint.delete({
        where: { id: Number(id) }
      });

      res.status(200).json({
        message: 'Checkpoint deleted successfully'
      });
    } catch (error) {
      next(error);
    }
  }
}

export default CheckpointController
