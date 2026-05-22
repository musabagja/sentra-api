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

        if (card.status !== "OPNAME") {
          throw new Error('Card is not part of this opname');
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

        const [scannedCount, cardStock] = await Promise.all([
          tx.opnameUpdate.count({ where: { opnameID: Number(id) } }),
          tx.cardStock.findFirst({
            where: { checkpointCode: opname.checkpointCode },
            orderBy: { createdAt: 'desc' }
          })
        ]);

        if (!cardStock) {
          throw new Error('Card stock not found');
        }

        await tx.opnameUpdate.create({
          data: {
            itemID: card.id,
            status,
            opnameID: Number(id),
            userCode: req.user!.code
          }
        });

        // All OPNAME cards were VERIFIED before the opname started.
        // Decrement stock only when physically damaged or missing.
        if (status === "BROKEN" || status === "LOST") {
          if (cardStock.amount <= 0) {
            throw new Error('Stock is already at zero; cannot record further losses');
          }
          await tx.cardStock.create({
            data: {
              amount: cardStock.amount - 1,
              checkpointCode: opname.checkpointCode
            }
          });
        }

        return await tx.opname.update({
          where: { id: Number(id) },
          data: { progress: scannedCount + 1 }
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
      const { checkpointCode, type = 'ICCID' } = req.body;
      const allowed = req.checkpointCodes ?? [];

      const validTypes = ['ICCID', 'MSISDN'];
      if (!validTypes.includes(type)) {
        const err = new Error(`Invalid opname type. Must be one of: ${validTypes.join(', ')}`);
        (err as any).status = 400;
        throw err;
      }

      if (!hasCheckpointAccess(checkpointCode, allowed)) {
        const err = new Error('Checkpoint not found');
        (err as any).status = 404;
        throw err;
      }

      const opname = await prisma.$transaction(async (tx) => {
        const checkpoint = await tx.checkpoint.findUnique({
          where: { code: checkpointCode }
        });

        if (!checkpoint) {
          throw new Error('Checkpoint not found');
        }

        const runningOpname = await tx.opname.findFirst({
          where: { checkpointCode, status: "ONGOING" },
          orderBy: { createdAt: 'desc' }
        });

        if (runningOpname) {
          throw new Error('Opname is already running');
        }

        const [amount, lastOpname] = await Promise.all([
          type === 'ICCID'
            ? tx.card.count({ where: { checkpointCode, status: 'VERIFIED' } })
            : tx.number.count({ where: { checkpointCode, status: 'VERIFIED' } }),
          tx.opname.findFirst({
            where: { checkpointCode },
            orderBy: { createdAt: 'desc' }
          })
        ]);
        const nextBatchNum = lastOpname?.batch ? Number(lastOpname.batch.split('/')[2]) + 1 : 1;
        const batch = `OP/${checkpointCode}/${nextBatchNum}`;

        // Mark all VERIFIED items at this checkpoint as OPNAME so they're scoped to this session
        if (type === 'ICCID') {
          await tx.card.updateMany({
            where: { checkpointCode, status: 'VERIFIED' },
            data: { status: 'OPNAME' }
          });
        } else {
          await tx.number.updateMany({
            where: { checkpointCode, status: 'VERIFIED' },
            data: { status: 'OPNAME' }
          });
        }

        const opname = await tx.opname.create({
          data: {
            amount,
            progress: 0,
            batch,
            type,
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
      const { signURL, picSignURL, picName, documentationURL, note } = req.body;

      // documentationURL may be a single string or an array (2 files max)
      const documentationURLs: string[] = (Array.isArray(documentationURL)
        ? documentationURL
        : documentationURL ? [documentationURL] : []).slice(0, 2);

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
        const opnameId = Number(id);

        // Fetch all scanned updates (itemID + status) in one query
        const scannedUpdates = await tx.opnameUpdate.findMany({
          where: { opnameID: opnameId },
          select: { itemID: true, status: true }
        });
        const scannedIds = new Set(scannedUpdates.map(u => u.itemID));

        // Unscanned = OPNAME cards not in scannedIds (still awaiting scan when opname closed)
        const unscannedCards = await tx.card.findMany({
          where: {
            checkpointCode: existing.checkpointCode,
            status: 'OPNAME',
            ...(scannedIds.size > 0 && { id: { notIn: [...scannedIds] } })
          },
          select: { id: true }
        });

        // Group scanned cards by their opname condition
        const byCondition = scannedUpdates.reduce(
          (acc, u) => {
            acc[u.status as 'OK' | 'BROKEN' | 'LOST'].push(u.itemID);
            return acc;
          },
          { OK: [] as number[], BROKEN: [] as number[], LOST: [] as number[] }
        );

        await Promise.all([
          // Scanned OK → restore to VERIFIED
          byCondition.OK.length > 0 && tx.card.updateMany({
            where: { id: { in: byCondition.OK } },
            data: { status: 'VERIFIED' }
          }),
          // Scanned BROKEN → mark BROKEN
          byCondition.BROKEN.length > 0 && tx.card.updateMany({
            where: { id: { in: byCondition.BROKEN } },
            data: { status: 'BROKEN' }
          }),
          // Scanned LOST → mark LOST
          byCondition.LOST.length > 0 && tx.card.updateMany({
            where: { id: { in: byCondition.LOST } },
            data: { status: 'LOST' }
          }),
        ].filter(Boolean));

        if (unscannedCards.length > 0) {
          const unscannedIds = unscannedCards.map(c => c.id);

          // Auto-LOST: create opname updates and mark cards LOST
          await Promise.all([
            tx.opnameUpdate.createMany({
              data: unscannedIds.map(itemID => ({
                itemID,
                status: 'LOST' as OpnameConditionStatus,
                opnameID: opnameId,
                userCode: req.user!.code
              }))
            }),
            tx.card.updateMany({
              where: { id: { in: unscannedIds } },
              data: { status: 'LOST' }
            })
          ]);

          // Adjust stock: deduct all auto-LOST cards, floor at 0
          const cardStock = await tx.cardStock.findFirst({
            where: { checkpointCode: existing.checkpointCode },
            orderBy: { createdAt: 'desc' }
          });
          if (cardStock) {
            await tx.cardStock.create({
              data: {
                amount: Math.max(0, cardStock.amount - unscannedCards.length),
                checkpointCode: existing.checkpointCode
              }
            });
          }
        }

        const totalProgress = scannedIds.size + unscannedCards.length;

        const opname = await tx.opname.update({
          where: { id: opnameId },
          data: { status: "COMPLETED", progress: totalProgress }
        });

        const submittance = await tx.opnameSubmittance.create({
          data: {
            opnameID: opnameId,
            userCode: req.user!.code,
            signURL: signURL || null,
            picSignURL: picSignURL || null,
            picName: picName || null,
            documentationURL: documentationURLs[0] || null,
            note: note || null,
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
      const { page = 1, limit = 10, checkpointCode, type, startDate, endDate } = req.query;
      const allowed = req.checkpointCodes ?? [];

      const where: any = {
        checkpointCode: { in: resolveCheckpointFilter(checkpointCode as string | undefined, allowed) }
      };
      if (type) where.type = type;
      if (startDate || endDate) {
        where.createdAt = {
          ...(startDate && { gte: new Date(startDate as string) }),
          ...(endDate   && { lte: new Date(endDate as string) })
        };
      }

      const [opnames, total] = await Promise.all([
        prisma.opname.findMany({
          where,
          skip: (Number(page) - 1) * Number(limit),
          take: Number(limit),
          include: {
            checkpoint: { select: { name: true } },
            submittance: { include: { documentations: true } }
          },
          orderBy: { createdAt: 'desc' }
        }),
        prisma.opname.count({ where })
      ]);

      const opnameIds = opnames.map(o => o.id);

      // Per-status update counts per opname
      const updateCounts = opnameIds.length > 0
        ? await prisma.opnameUpdate.groupBy({
            by: ['opnameID', 'status'],
            where: { opnameID: { in: opnameIds } },
            _count: { status: true }
          })
        : [];

      const countMap = updateCounts.reduce((acc, row) => {
        const entry = acc[row.opnameID] ?? { OK: 0, BROKEN: 0, LOST: 0 };
        entry[row.status as 'OK' | 'BROKEN' | 'LOST'] = row._count.status;
        acc[row.opnameID] = entry;
        return acc;
      }, {} as Record<number, { OK: number; BROKEN: number; LOST: number }>);

      const enriched = opnames.map(opname => {
        const counts = countMap[opname.id] ?? { OK: 0, BROKEN: 0, LOST: 0 };
        // opname.amount = COUNT(VERIFIED) at creation time — always the correct initial stock
        return {
          ...opname,
          stats: {
            initialCount: opname.amount,
            totalGood: counts.OK,
            totalBroken: counts.BROKEN,
            totalLost: counts.LOST,
            finalCount: opname.amount - counts.BROKEN - counts.LOST
          }
        };
      });

      res.status(200).json({
        message: 'Opnames retrieved successfully',
        data: { opnames: enriched },
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
          updates: { orderBy: { createdAt: 'desc' } },
          submittance: { include: { documentations: true } }
        }
      });

      if (!opname || !hasCheckpointAccess(opname.checkpointCode, allowed)) {
        const err = new Error('Opname not found');
        (err as any).status = 404;
        throw err;
      }

      const { updates, submittance, ...opnameBase } = opname;

      // Build a lookup of scanned cards: itemID -> update
      const updateByItemId = new Map(updates.map(u => [u.itemID, u]));
      const scannedIds = new Set(updates.map(u => u.itemID));

      type ItemDetail = { id: number; key: string; createdAt: Date; validatedAt?: Date | null; status: string };

      // Fetch cards that are part of this opname's scope:
      // - still OPNAME status (unscanned, awaiting scan) OR
      // - already scanned in this opname (have an OpnameUpdate entry)
      let allItems: ItemDetail[] = [];
      if (opname.type === 'ICCID') {
        allItems = await prisma.card.findMany({
          where: {
            checkpointCode: opname.checkpointCode,
            OR: [
              { status: 'OPNAME' },
              { id: { in: scannedIds.size > 0 ? [...scannedIds] : [-1] } }
            ]
          },
          select: { id: true, key: true, createdAt: true, validatedAt: true, status: true },
          orderBy: { createdAt: 'asc' }
        });
      } else {
        const numbers = await prisma.number.findMany({
          where: {
            checkpointCode: opname.checkpointCode,
            OR: [
              { status: 'OPNAME' },
              { id: { in: scannedIds.size > 0 ? [...scannedIds] : [-1] } }
            ]
          },
          select: { id: true, key: true, createdAt: true, status: true },
          orderBy: { createdAt: 'asc' }
        });
        allItems = numbers.map(n => ({ ...n, validatedAt: null }));
      }

      const items = allItems.map(item => {
        const update = updateByItemId.get(item.id);
        return {
          iccid: item.key,
          createdAt: item.createdAt,
          validatedAt: item.validatedAt ?? null,
          initialCondition: 'VERIFIED',
          verifiedCondition: update?.status ?? null,
          scannedAt: update?.createdAt ?? null
        };
      });

      const totalScanned = updates.length;
      const totalGood    = updates.filter(u => u.status === 'OK').length;
      const totalBroken  = updates.filter(u => u.status === 'BROKEN').length;
      const totalLost    = updates.filter(u => u.status === 'LOST').length;

      res.status(200).json({
        message: 'Opname retrieved successfully',
        data: {
          opname: {
            ...opnameBase,
            stats: {
              initialCount: opname.amount,
              totalScanned,
              totalGood,
              totalBroken,
              totalLost,
              finalCount: opname.amount - totalBroken - totalLost
            },
            items,
            closingReport: submittance
          }
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

      if (status !== "CANCELLED") {
        const err = new Error('Only CANCELLED is a valid status update. Use the close endpoint to complete an opname.');
        (err as any).status = 400;
        throw err;
      }

      const existing = await prisma.opname.findUnique({ where: { id: Number(id) } });
      if (!existing || !hasCheckpointAccess(existing.checkpointCode, allowed)) {
        const err = new Error('Opname not found');
        (err as any).status = 404;
        throw err;
      }

      if (existing.status !== "ONGOING") {
        const err = new Error('Can only cancel an ongoing opname');
        (err as any).status = 400;
        throw err;
      }

      const opname = await prisma.$transaction(async (tx) => {
        // Collect all scanned item IDs from opname updates
        const scannedUpdates = await tx.opnameUpdate.findMany({
          where: { opnameID: Number(id) },
          select: { itemID: true, status: true }
        });
        const scannedIds = scannedUpdates.map(u => u.itemID);
        const damagedCount = scannedUpdates.filter(
          u => u.status === 'BROKEN' || u.status === 'LOST'
        ).length;

        // Revert all scanned items + remaining OPNAME items back to VERIFIED
        if (existing.type === 'ICCID') {
          await tx.card.updateMany({
            where: {
              checkpointCode: existing.checkpointCode,
              OR: [
                { status: 'OPNAME' },
                ...(scannedIds.length > 0 ? [{ id: { in: scannedIds } }] : [])
              ]
            },
            data: { status: 'VERIFIED' }
          });
        } else {
          await tx.number.updateMany({
            where: {
              checkpointCode: existing.checkpointCode,
              OR: [
                { status: 'OPNAME' },
                ...(scannedIds.length > 0 ? [{ id: { in: scannedIds } }] : [])
              ]
            },
            data: { status: 'VERIFIED' }
          });
        }

        // Restore stock for BROKEN/LOST scans (each decremented stock during scanning)
        if (damagedCount > 0) {
          const cardStock = await tx.cardStock.findFirst({
            where: { checkpointCode: existing.checkpointCode },
            orderBy: { createdAt: 'desc' }
          });
          if (cardStock) {
            await tx.cardStock.create({
              data: {
                checkpointCode: existing.checkpointCode,
                amount: cardStock.amount + damagedCount
              }
            });
          }
        }

        return tx.opname.update({
          where: { id: Number(id) },
          data: { status },
          include: { updates: true }
        });
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

      await prisma.$transaction(async (tx) => {
        if (existing.status === "ONGOING") {
          // Collect scanned updates to know which cards had stock decremented
          const scannedUpdates = await tx.opnameUpdate.findMany({
            where: { opnameID: existing.id },
            select: { itemID: true, status: true }
          });
          const scannedIds = scannedUpdates.map(u => u.itemID);
          const damagedCount = scannedUpdates.filter(
            u => u.status === 'BROKEN' || u.status === 'LOST'
          ).length;

          // Restore all OPNAME items + any already-scanned BROKEN/LOST items back to VERIFIED
          if (existing.type === 'ICCID') {
            await tx.card.updateMany({
              where: {
                checkpointCode: existing.checkpointCode,
                OR: [
                  { status: 'OPNAME' },
                  ...(scannedIds.length > 0 ? [{ id: { in: scannedIds } }] : [])
                ]
              },
              data: { status: 'VERIFIED' }
            });
          } else {
            await tx.number.updateMany({
              where: {
                checkpointCode: existing.checkpointCode,
                OR: [
                  { status: 'OPNAME' },
                  ...(scannedIds.length > 0 ? [{ id: { in: scannedIds } }] : [])
                ]
              },
              data: { status: 'VERIFIED' }
            });
          }

          if (damagedCount > 0) {
            const cardStock = await tx.cardStock.findFirst({
              where: { checkpointCode: existing.checkpointCode },
              orderBy: { createdAt: 'desc' }
            });
            if (cardStock) {
              await tx.cardStock.create({
                data: { checkpointCode: existing.checkpointCode, amount: cardStock.amount + damagedCount }
              });
            }
          }
        }

        // Delete children in FK dependency order before deleting the opname
        const submittance = await tx.opnameSubmittance.findUnique({ where: { opnameID: existing.id } });
        if (submittance) {
          await tx.opnameSubmittanceDocumentation.deleteMany({ where: { submittanceID: submittance.id } });
          await tx.opnameSubmittance.delete({ where: { id: submittance.id } });
        }
        await tx.opnameUpdate.deleteMany({ where: { opnameID: existing.id } });
        await tx.opname.delete({ where: { id: existing.id } });
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