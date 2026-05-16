import type { NextFunction, Request, Response } from "express";
import prisma from "../../lib/prisma";
import { OpnameConditionStatus } from "../../generated/prisma/enums";
import { hasCheckpointAccess, resolveCheckpointFilter } from "../utils/access.util";

class OpnameController {
  static async updateOpnameProgress(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const { status, cardKey } = req.body;

      const validStatuses: OpnameConditionStatus[] = ["OK", "BROKEN", "LOST"];
      if (!status || !validStatuses.includes(status)) {
        const err = new Error(`Invalid status. Must be one of: ${validStatuses.join(', ')}`);
        (err as any).status = 400;
        throw err;
      }

      const allowed = req.checkpointCodes ?? [];

      const updatedOpname = await prisma.$transaction(async (tx) => {
        const [opname, card] = await Promise.all([
          tx.opname.findUnique({ where: { id: Number(id) } }),
          tx.card.findUnique({ where: { key: cardKey } })
        ]);

        if (!opname || !hasCheckpointAccess(opname.checkpointCode, allowed)) {
          const err = new Error('Opname not found');
          (err as any).status = 404;
          throw err;
        }

        if (opname.status !== "ONGOING") {
          throw new Error('Opname is not running');
        }

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

        // Prevent duplicate scans of the same card within this opname
        const existingUpdate = await tx.opnameUpdate.findFirst({
          where: { opnameID: Number(id), itemID: card.id }
        });
        if (existingUpdate) {
          throw new Error('Card has already been scanned in this opname');
        }

        const [opnameProgresses, cardStock] = await Promise.all([
          tx.opnameUpdate.findMany({
            where: { opnameID: Number(id) },
            select: { itemID: true }
          }),
          tx.cardStock.findFirst({
            where: { checkpointCode: opname.checkpointCode },
            orderBy: { createdAt: 'desc' }
          })
        ]);

        if (!cardStock) {
          throw new Error('Card stock not found');
        }

        // Count unique cards scanned so far; the new card (not yet inserted) adds 1
        const uniqueScannedCount = new Set(opnameProgresses.map(u => u.itemID)).size;

        await tx.opnameUpdate.create({
          data: {
            itemID: card.id,
            status,
            opnameID: Number(id),
            userCode: req.user!.code
          }
        });

        // Adjust stock only when the physical state differs from the system state.
        // card.status is the system truth; status is the physical observation.
        if (card.status === "VERIFIED" && (status === "BROKEN" || status === "LOST")) {
          // Physically missing/broken but system says VERIFIED → decrement
          await tx.cardStock.create({
            data: {
              amount: cardStock.amount - 1,
              checkpointCode: opname.checkpointCode
            }
          });
        } else if (card.status !== "VERIFIED" && status === "OK") {
          // Physically present and OK but system says not VERIFIED → increment
          await tx.cardStock.create({
            data: {
              amount: cardStock.amount + 1,
              checkpointCode: opname.checkpointCode
            }
          });
        }

        return await tx.opname.update({
          where: { id: Number(id) },
          data: { progress: uniqueScannedCount + 1 }
        });
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
      const allowed = req.checkpointCodes ?? [];

      if (!hasCheckpointAccess(checkpointCode, allowed)) {
        const err = new Error('Checkpoint not found');
        (err as any).status = 404;
        throw err;
      }

      const opname = await prisma.$transaction(async (tx) => {
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
            status: "ONGOING"
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
        const nextBatchNum = lastOpname?.batch ? Number(lastOpname.batch.split('/')[2]) + 1 : 1;
        const batch = `OP/${checkpointCode}/${nextBatchNum}`;
  
        const opname = await tx.opname.create({
          data: {
            amount,
            progress: 0,
            batch,
            type: "ICCID",
            checkpointCode,
            status: "ONGOING",
            userCode: req.user!.code
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

  static async closeOpname(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const allowed = req.checkpointCodes ?? [];
      const { signURL, picSignURL, documentationURL } = req.body;

      // documentationURL may be a single string or an array (2 files max)
      const documentationURLs: string[] = Array.isArray(documentationURL)
        ? documentationURL
        : documentationURL ? [documentationURL] : [];

      const existing = await prisma.opname.findUnique({ where: { id: Number(id) } });
      if (!existing || !hasCheckpointAccess(existing.checkpointCode, allowed)) {
        const err = new Error('Opname not found');
        (err as any).status = 404;
        throw err;
      }

      if (existing.status !== "ONGOING") {
        const err = new Error('Opname is not running');
        (err as any).status = 400;
        throw err;
      }

      const result = await prisma.$transaction(async (tx) => {
        const opname = await tx.opname.update({
          where: { id: Number(id) },
          data: { status: "COMPLETED" }
        });

        const submittance = await tx.opnameSubmittance.create({
          data: {
            opnameID: Number(id),
            userCode: req.user!.code,
            signURL: signURL || null,
            picSignURL: picSignURL || null,
            ...(documentationURLs.length > 0 && {
              documentations: {
                createMany: {
                  data: documentationURLs.map(url => ({ url }))
                }
              }
            })
          },
          include: {
            documentations: true
          }
        });

        return { opname, submittance };
      });

      res.status(200).json({
        message: 'Opname closed successfully',
        data: {
          opname: result.opname,
          submittance: result.submittance
        }
      });
    } catch (error) {
      next(error);
    }
  }

  static async getOpnames(req: Request, res: Response, next: NextFunction) {
    try {
      const { page = 1, limit = 10, checkpointCode, type } = req.query;
      const allowed = req.checkpointCodes ?? [];

      const where: any = {
        checkpointCode: { in: resolveCheckpointFilter(checkpointCode as string | undefined, allowed) }
      };
      if (type) where.type = type;

      const [opnames, total] = await Promise.all([
        prisma.opname.findMany({
          where,
          skip: (Number(page) - 1) * Number(limit),
          take: Number(limit),
          include: {
            updates: {
              take: 10,
              orderBy: { createdAt: 'desc' }
            },
            submittance: {
              include: { documentations: true }
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
        data: { opnames },
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
      const allowed = req.checkpointCodes ?? [];

      const opname = await prisma.opname.findUnique({
        where: { id: Number(id) },
        include: {
          updates: {
            orderBy: { createdAt: 'desc' }
          },
          submittance: {
            include: { documentations: true }
          }
        }
      });

      if (!opname || !hasCheckpointAccess(opname.checkpointCode, allowed)) {
        const err = new Error('Opname not found');
        (err as any).status = 404;
        throw err;
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
      const allowed = req.checkpointCodes ?? [];

      const validStatuses = ["ONGOING", "COMPLETED", "CANCELLED"];
      if (!status || !validStatuses.includes(status)) {
        const err = new Error(`Invalid status. Must be one of: ${validStatuses.join(', ')}`);
        (err as any).status = 400;
        throw err;
      }

      const existing = await prisma.opname.findUnique({ where: { id: Number(id) } });
      if (!existing || !hasCheckpointAccess(existing.checkpointCode, allowed)) {
        const err = new Error('Opname not found');
        (err as any).status = 404;
        throw err;
      }

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
      const allowed = req.checkpointCodes ?? [];

      const existing = await prisma.opname.findUnique({ where: { id: Number(id) } });
      if (!existing || !hasCheckpointAccess(existing.checkpointCode, allowed)) {
        const err = new Error('Opname not found');
        (err as any).status = 404;
        throw err;
      }

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