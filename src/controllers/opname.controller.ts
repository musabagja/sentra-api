import type { NextFunction, Request, Response } from "express";
import prisma from "../../lib/prisma";

class OpnameController {
  static async updateOpnameProgress(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const { status, cardKey } = req.body;

      if (!req.user) {
        throw new Error('User not found');
      }

      const opname = await prisma.opname.findUnique({
        where: { id: Number(id) }
      });

      if (!opname) {
        throw new Error('Opname not found');
      }

      if (opname.status !== "RUNNING") {
        throw new Error('Opname is not running');
      }

      const card = await prisma.card.findUnique({
        where: { key: cardKey }
      });

      if (!card) {
        throw new Error('Card not found');
      }

      if (card.status === "SOLD") {
        throw new Error('Card is sold');
      }

      if (card.status === "UNVERIFIED") {
        throw new Error('Card is not verified');
      }

      if (card.checkpointCode !== opname.checkpointCode) {
        throw new Error('Card is not at the same checkpoint as the opname');
      }
      const opnameProgresses = await prisma.opnameUpdate.findMany({
        where: {
          opnameID: Number(id)
        }
      })

      const totalProgress = [...new Set(opnameProgresses.map(update => update.itemID))];

      const updatedOpname = await prisma.opname.update({
        where: { id: Number(id) },
        data: { progress: totalProgress.length }
      });

      await prisma.opnameUpdate.create({
        data: {
          itemID: card.id,
          status,
          opnameID: Number(id),
          userCode: req.user.code
        }
      });

      res.status(200).json({
        message: 'Opname progress updated successfully',
        data: {
          opname: updatedOpname
        }
      });
    } catch (error) {
      next(error);
    }
  }

  // ============================================================================
  // OPNAME CRUD OPERATIONS
  // ============================================================================

  static async createOpname(req: Request, res: Response, next: NextFunction) {
    try {
      const { checkpointCode } = req.body;

      const opname = await prisma.$transaction(async (tx) => {

        if (!req.user) {
          throw new Error('User not found');
        }
  
        const checkpoint = await tx.checkpoint.findUnique({
          where: {
            code: checkpointCode
          }
        });
  
        if (!checkpoint) {
          throw new Error('Checkpoint not found');
        }
  
        const runningOpname = await tx.opname.findFirst({
          where: {
            checkpointCode: checkpointCode,
            status: "RUNNING"
          },
          orderBy: {
            createdAt: 'desc'
          }
        });
  
        if (runningOpname) {
          throw new Error('Opname is already running');
        }
  
        const cardStock = await tx.cardStock.findFirst({
          where: {
            checkpointCode: checkpointCode
          },
          orderBy: {
            createdAt: 'desc'
          }
        });
  
        const lastOpname = await tx.opname.findFirst({
          where: {
            checkpointCode: checkpointCode
          },
          orderBy: {
            createdAt: 'desc'
          }
        });
  
        if (!cardStock) {
          throw new Error('Card stock not found');
        }
  
        const amount = cardStock.amount;
        const batch = lastOpname && lastOpname.batch ? (Number(lastOpname.batch.split('/')[2]) + 1).toString() : `OP/${checkpointCode}/1`;
  
        const opname = await tx.opname.create({
          data: {
            amount,
            progress: 0,
            batch,
            type: "ICCID",
            checkpointCode,
            status: "RUNNING",
            userCode: req.user.code
          },
          include: {
            updates: true
          }
        });

        return opname;
      })


      res.status(201).json({
        message: 'Opname created successfully',
        data: {
          opname
        }
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
        data: {
          opname
        }
      });
    } catch (error) {
      next(error);
    }
  }

  static async updateOpname(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const { status } = req.body;

      const opname = await prisma.opname.update({
        where: { id: Number(id) },
        data: {
          status
        },
        include: {
          updates: true
        }
      });

      res.status(200).json({
        message: 'Opname updated successfully',
        data: {
          opname
        }
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