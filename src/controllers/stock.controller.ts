import type { Request, Response, NextFunction } from 'express';
import prisma from '../../lib/prisma';
import * as xlsx from 'xlsx';

import { hasCheckpointAccess, resolveCheckpointFilter } from '../utils/access.util';

class StockController {

  static async dashboardSync (req: Request, res: Response, next: NextFunction) {
    try {
      const allowed = req.checkpointCodes ?? [];
      const year = Number(req.query.year) || new Date().getFullYear();
      const dcCode = req.query.dcCode as string | undefined;
      const storeCode = req.query.storeCode as string | undefined;

      const yearStart = new Date(year, 0, 1);
      const yearEnd   = new Date(year, 11, 31, 23, 59, 59, 999);

      const scopeFilter = {
        status: 'DELIVERED' as const,
        OR: [{ sourceCode: { in: allowed } }, { targetCode: { in: allowed } }]
      };

      const dcMonthlyWhere = {
        ...scopeFilter,
        target: { type: 'DC', ...(dcCode && { code: dcCode }) },
        createdAt: { gte: yearStart, lte: yearEnd }
      };

      const storeMonthlyWhere = {
        ...scopeFilter,
        target: { type: 'STORE', ...(storeCode && { code: storeCode }) },
        createdAt: { gte: yearStart, lte: yearEnd }
      };

      const [dcAggregate, storeAggregate, allCheckpoints, baseInitialCount, brokenLostCards, topSaleByUser, dcMonthlyRows, storeMonthlyRows] = await Promise.all([
        // 1. Cards distributed TO DC checkpoints (all-time total)
        prisma.distribution.aggregate({
          _sum: { amount: true },
          where: { ...scopeFilter, target: { type: 'DC' } }
        }),

        // 2. Cards distributed TO STORE checkpoints (all-time total)
        prisma.distribution.aggregate({
          _sum: { amount: true },
          where: { ...scopeFilter, target: { type: 'STORE' } }
        }),

        // Shared checkpoint fetch — split into STORE/DC in JS
        prisma.checkpoint.findMany({
          where: { code: { in: allowed } },
          include: { cardStock: { orderBy: { createdAt: 'desc' }, take: 1 } }
        }),

        // 5a. Base initial stock: VERIFIED + SOLD + DELIVERY + OPNAME
        prisma.card.count({
          where: { checkpointCode: { in: allowed }, status: { in: ['VERIFIED', 'SOLD', 'DELIVERY', 'OPNAME'] } }
        }),

        // 5b. BROKEN/LOST candidates — need to check if opname-traced
        prisma.card.findMany({
          where: { checkpointCode: { in: allowed }, status: { in: ['BROKEN', 'LOST'] } },
          select: { id: true }
        }),

        // Top 10 users by total sales (merges) within scope
        prisma.merge.groupBy({
          by: ['userCode'],
          where: { checkpointCode: { in: allowed } },
          _count: { userCode: true },
          orderBy: { _count: { userCode: 'desc' } },
          take: 10
        }),

        // Monthly DC distributions for selected year
        prisma.distribution.findMany({
          where: dcMonthlyWhere,
          select: { amount: true, createdAt: true }
        }),

        // Monthly STORE distributions for selected year
        prisma.distribution.findMany({
          where: storeMonthlyWhere,
          select: { amount: true, createdAt: true }
        })
      ]);

      const storeCheckpointCodes = allCheckpoints
        .filter(c => c.type === 'STORE')
        .map(c => c.code);

      // Cards that are BROKEN/LOST but discovered via opname still count toward initial stock.
      // OpnameUpdate.itemID = card.id but no Prisma relation exists, so we resolve in two steps.
      const brokenLostIds = brokenLostCards.map(c => c.id);
      const [opnamedBrokenLostCount, topSaleByCheckpoint] = await Promise.all([
        brokenLostIds.length > 0
          ? prisma.opnameUpdate.groupBy({
              by: ['itemID'],
              where: { itemID: { in: brokenLostIds } }
            }).then(groups => groups.length)
          : Promise.resolve(0),

        // Top 10 STORE checkpoints by total sales (merges)
        prisma.merge.groupBy({
          by: ['checkpointCode'],
          where: { checkpointCode: { in: storeCheckpointCodes } },
          _count: { checkpointCode: true },
          orderBy: { _count: { checkpointCode: 'desc' } },
          take: 10
        })
      ]);

      // Enrich top-selling users with their name
      const topUserCodes = topSaleByUser.map(r => r.userCode);
      const topUserDetails = topUserCodes.length > 0
        ? await prisma.user.findMany({
            where: { code: { in: topUserCodes } },
            select: { code: true, name: true }
          })
        : [];
      const userDetailMap = Object.fromEntries(topUserDetails.map(u => [u.code, u]));

      const initialStock = baseInitialCount + opnamedBrokenLostCount;

      // 6. Final stock: sum of latest CardStock per checkpoint
      //    (already nets out sales, opname BROKEN/LOST, and adjustments)
      const finalStock = allCheckpoints.reduce(
        (sum, c) => sum + (c.cardStock[0]?.amount ?? 0), 0
      );

      const withStock = (c: typeof allCheckpoints[number]) =>
        ({ ...c, currentStock: c.cardStock[0]?.amount ?? 0 });

      // 3. Top 10 STORE checkpoints with least current stock
      const topLeastStoreStock = allCheckpoints
        .filter(c => c.type === 'STORE')
        .map(withStock)
        .sort((a, b) => a.currentStock - b.currentStock)
        .slice(0, 10);

      // 4. Top 10 DC checkpoints with most current stock
      const topMostDCStock = allCheckpoints
        .filter(c => c.type === 'DC')
        .map(withStock)
        .sort((a, b) => b.currentStock - a.currentStock)
        .slice(0, 10);

      const checkpointMap = Object.fromEntries(allCheckpoints.map(c => [c.code, c]));

      // Top 10 STORE checkpoints ranked by highest sales
      const topHighestSaleByCheckpoint = topSaleByCheckpoint.map(row => ({
        checkpoint: checkpointMap[row.checkpointCode!],
        totalSales: row._count.checkpointCode
      }));

      // Top 10 users ranked by highest sales
      const topHighestSaleByUser = topSaleByUser.map(row => ({
        user: userDetailMap[row.userCode] ?? { code: row.userCode, name: null },
        totalSales: row._count.userCode
      }));

      // Build 12-element monthly arrays (index 0 = January … 11 = December)
      const buildMonthlyTotals = (rows: { amount: number; createdAt: Date }[]) => {
        const months = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, amount: 0 }));
        for (const row of rows) {
          months[new Date(row.createdAt).getMonth()].amount += row.amount ?? 0;
        }
        return months;
      };

      const distributedToDCByMonth    = buildMonthlyTotals(dcMonthlyRows);
      const distributedToStoreByMonth = buildMonthlyTotals(storeMonthlyRows);

      res.status(200).json({
        message: 'Dashboard synced successfully',
        data: {
          year,
          initialStock,
          finalStock,
          distributedToDC: dcAggregate._sum.amount ?? 0,
          distributedToStore: storeAggregate._sum.amount ?? 0,
          distributedToDCByMonth,
          distributedToStoreByMonth,
          topLeastStoreStock,
          topMostDCStock,
          topHighestSaleByCheckpoint,
          topHighestSaleByUser
        }
      });
    } catch (error) {
      next(error);
    }
  }

  static async getBatch(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const allowed = req.checkpointCodes ?? [];

      const batch = await prisma.uploadBatch.findUnique({
        where: { id: Number(id) },
        include: {
          cards: { take: 50, orderBy: { createdAt: 'desc' } },
          numbers: { take: 50, orderBy: { createdAt: 'desc' } },
          progress: { take: 1, orderBy: { createdAt: 'desc' } }
        }
      });

      if (!batch || (batch.cards.length > 0 && !batch.cards.some(c => allowed.includes(c.checkpointCode)))) {
        const err = new Error('Batch not found');
        (err as any).status = 404;
        throw err;
      }

      res.status(200).json({
        message: 'Batch retrieved successfully',
        data: { batch }
      });
    } catch (error) {
      next(error);
    }
  }

  static async getBatches(req: Request, res: Response, next: NextFunction) {
    try {
      const { page = 1, limit = 10, status, search } = req.query;
      const allowed = req.checkpointCodes ?? [];

      const allowedStatus = ['ONGOING', 'COMPLETED'];

      if (status && !allowedStatus.includes(status as string)) {
        const err = new Error('Invalid status');
        (err as any).status = 400;
        throw err;
      }

      const where: any = {
        cards: { some: { checkpointCode: { in: allowed } } }
      };
      if (status) {
        where.status = status;
      }
      if (search) {
        where.OR = [
          { code: { contains: search as string, mode: 'insensitive' } },
          { name: { contains: search as string, mode: 'insensitive' } }
        ];
      }

      const batches = await prisma.uploadBatch.findMany({
        take: Number(limit),
        skip: (Number(page) - 1) * Number(limit),
        where,
        orderBy: { createdAt: 'desc' },
        include: {
          progress: {
            take: 1,
            orderBy: { createdAt: 'desc' }
          }
        }
      });

      const [totalBatch, totalCards, totalVerified, totalUnverified] = await Promise.all([
        prisma.uploadBatch.count({ where }),
        prisma.card.count({ where: { checkpointCode: { in: allowed } } }),
        prisma.card.count({ where: { checkpointCode: { in: allowed }, status: 'VERIFIED' } }),
        prisma.card.count({ where: { checkpointCode: { in: allowed }, status: 'UNVERIFIED' } })
      ]);

      res.status(200).json({
        message: 'Cards retrieved successfully',
        data: {
          batches,
          amount: {
            totalBatch,
            totalCards,
            totalVerified,
            totalUnverified
          }
        },
        pagination: {
          page: Number(page),
          limit: Number(limit),
          total: Number(totalBatch),
          pages: Math.ceil(Number(totalBatch) / Number(limit))
        }
      });
    } catch (error) {
      next(error);
    }
  }

  static async completeBatch(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const { note } = req.body ?? {};
      const allowed = req.checkpointCodes ?? [];

      const batch = await prisma.$transaction(async (tx) => {
        const currentBatch = await tx.uploadBatch.findUnique({
          where: { id: Number(id) },
          include: { cards: { select: { checkpointCode: true } } }
        });

        if (!currentBatch || (currentBatch.cards.length > 0 && !currentBatch.cards.some(c => allowed.includes(c.checkpointCode)))) {
          const err = new Error('Batch not found');
          (err as any).status = 404;
          throw err;
        }

        if (currentBatch.status === 'COMPLETED') {
          const err = new Error('Batch is already completed');
          (err as any).status = 400;
          throw err;
        }

        await tx.card.updateMany({
          where: {
            batchCode: currentBatch.code,
            status: "UNVERIFIED"
          },
          data: {
            status: "LOST"
          }
        });
        
        return await tx.uploadBatch.update({
          where: {
            id: Number(id)
          },
          data: {
            status: 'COMPLETED',
            note
          }
        });
      })

      res.status(200).json({
        message: 'Batch updated successfully',
        data: { batch }
      });
    } catch (error) {
      next(error);
    }
  }

  static async deleteBatch(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const allowed = req.checkpointCodes ?? [];

      const batch = await prisma.uploadBatch.findUnique({
        where: { id: Number(id) },
        include: {
          cards: {
            select: { key: true, id: true, status: true, checkpointCode: true }
          }
        }
      });

      if (!batch || !batch.cards.some(c => allowed.includes(c.checkpointCode))) {
        const err = new Error('Batch not found');
        (err as any).status = 404;
        throw err;
      }

      if (batch.status === 'COMPLETED') {
        const err = new Error('Cannot delete a completed batch');
        (err as any).status = 400;
        throw err;
      }

      const allowedStatuses = ['VERIFIED', 'UNVERIFIED', 'BROKEN', 'LOST'];
      const invalidCards = batch.cards.filter(card => !allowedStatuses.includes(card.status));

      if (invalidCards.length > 0) {
        const invalidStatusList = [...new Set(invalidCards.map(c => c.status))].join(', ');
        const err = new Error(`Cannot delete batch: ${invalidCards.length} card(s) have status (${invalidStatusList}) that cannot be deleted`);
        (err as any).status = 400;
        throw err;
      }

      const cardIds = batch.cards.map(c => c.id);
      const cardKeys = batch.cards.map(c => c.key);

      // Group VERIFIED cards by checkpoint — only VERIFIED cards contributed to CardStock.
      const verifiedByCheckpoint = batch.cards
        .filter(c => c.status === 'VERIFIED')
        .reduce((acc, c) => {
          acc[c.checkpointCode] = (acc[c.checkpointCode] ?? 0) + 1;
          return acc;
        }, {} as Record<string, number>);

      await prisma.$transaction(async (tx) => {
        if (cardIds.length > 0) {
          await tx.cardMovement.deleteMany({ where: { cardID: { in: cardIds } } });
        }

        if (cardKeys.length > 0) {
          await tx.distributionItem.deleteMany({ where: { itemKey: { in: cardKeys } } });
          await tx.merge.deleteMany({ where: { cardKey: { in: cardKeys } } });
        }

        await tx.card.deleteMany({ where: { batchCode: batch.code } });
        await tx.number.deleteMany({ where: { batchCode: batch.code } });

        // Decrement CardStock only by the VERIFIED cards removed per checkpoint,
        // instead of wiping all CardStock rows (which would erase other batches' contributions).
        for (const [checkpointCode, count] of Object.entries(verifiedByCheckpoint)) {
          const latest = await tx.cardStock.findFirst({
            where: { checkpointCode },
            orderBy: { createdAt: 'desc' }
          });
          await tx.cardStock.create({
            data: { checkpointCode, amount: (latest?.amount ?? 0) - count }
          });
        }

        await tx.uploadBatchProgress.deleteMany({ where: { batchCode: batch.code } });
        await tx.uploadBatch.delete({ where: { id: batch.id } });
      });

      res.status(200).json({
        message: 'Batch deleted successfully'
      });
    } catch (error) {
      next(error);
    }
  }

  static async getCards(req: Request, res: Response, next: NextFunction) {
    try {
      const { page = 1, limit = 10, checkpointCode, status, search, uploadAt, batch, validatedAt } = req.query;
      const allowed = req.checkpointCodes ?? [];

      const where: any = {
        // Scope to checkpoints in the user's circle; intersect with any requested checkpointCode
        checkpointCode: { in: resolveCheckpointFilter(checkpointCode as string | undefined, allowed) }
      };
      if (status) where.status = status;
      if (search) {
        where.OR = [
          { key: { contains: search as string, mode: 'insensitive' } },
          { name: { contains: search as string, mode: 'insensitive' } }
        ];
      }
      // validatedAt filter (related via Card -> Merge)
      if (validatedAt) {
        where.validatedAt = {
          gte: new Date(`${validatedAt}T00:00:00.000Z`),
          lt: new Date(`${validatedAt}T23:59:59.999Z`)
        }
      }
      if (uploadAt || batch) {
        where.uploadBatch = {
          ...(uploadAt && {
            createdAt: {
              gte: new Date(`${uploadAt}T00:00:00.000Z`),
              lt: new Date(`${uploadAt}T23:59:59.999Z`)
            }
          }),     
          ...(batch && {
            code: { contains: batch as string, mode: 'insensitive' }
          })
        };
      }

      const [cards, total] = await Promise.all([
        prisma.card.findMany({
          where,
          skip: (Number(page) - 1) * Number(limit),
          take: Number(limit),
          include: {
            checkpoint: true,
            uploadBatch: true
          },
          orderBy: { createdAt: 'desc' }
        }),
        prisma.card.count({ where })
      ]);

      const [totalUpload, totalSold, totalAvailable] = await Promise.all([
        prisma.card.count({ where: { checkpointCode: { in: allowed } } }),
        prisma.card.count({ where: { checkpointCode: { in: allowed }, status: "SOLD" } }),
        prisma.card.count({ where: { checkpointCode: { in: allowed }, status: "VERIFIED" } })
      ])

      res.status(200).json({
        message: 'Cards retrieved successfully',
        data: {
          cards,
          amount: {
            upload: totalUpload,
            sold: totalSold,
            available: totalAvailable
          }
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

  static async getCard(req: Request, res: Response, next: NextFunction) {
    try {
      const { key } = req.params;
      const allowed = req.checkpointCodes ?? [];

      const card = await prisma.card.findUnique({
        where: { key: key as string },
        include: {
          checkpoint: true,
          movements: { orderBy: { createdAt: 'desc' } }
        }
      });

      if (!card || !hasCheckpointAccess(card.checkpointCode, allowed)) {
        const err = new Error('Card not found');
        (err as any).status = 404;
        throw err;
      }

      res.status(200).json({
        message: 'Card retrieved successfully',
        data: { card }
      });
    } catch (error) {
      next(error);
    }
  }

  static async deleteCard(req: Request, res: Response, next: NextFunction) {
    try {
      const { key } = req.params;
      const allowed = req.checkpointCodes ?? [];

      const existing = await prisma.card.findUnique({ where: { key } });
      if (!existing || !hasCheckpointAccess(existing.checkpointCode, allowed)) {
        const err = new Error('Card not found');
        (err as any).status = 404;
        throw err;
      }

      if (existing.status === 'SOLD' || existing.status === 'DELIVERY' || existing.status === 'OPNAME') {
        const err = new Error(`Cannot delete a ${existing.status.toLowerCase()} card`);
        (err as any).status = 400;
        throw err;
      }

      await prisma.$transaction(async (tx) => {
        await tx.cardMovement.deleteMany({ where: { cardID: existing.id } });
        await tx.merge.deleteMany({ where: { cardKey: existing.key } });
        await tx.distributionItem.deleteMany({ where: { itemKey: existing.key } });
        await tx.card.delete({ where: { id: existing.id } });
      });

      res.status(200).json({
        message: 'Card deleted successfully'
      });
    } catch (error) {
      next(error);
    }
  }

  static async uploadExcel(req: Request, res: Response, next: NextFunction) {
    try {
      const file = (req as any).file;

      if (!req.user) {
        throw new Error('User not found');
      }

      if (!file) {
        const err = new Error('No file uploaded');
        (err as any).status = 400;
        throw err;
      }

      // Parse Excel outside the transaction — CPU-bound work should not hold a DB connection
      const workbook = xlsx.read(file.buffer, { type: 'buffer' });

      if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
        const err = new Error('Excel file has no sheets');
        (err as any).status = 422;
        throw err;
      }

      const firstWorksheet = workbook.Sheets[workbook.SheetNames[0]!];
      if (!firstWorksheet) {
        const err = new Error('Worksheet not found');
        (err as any).status = 422;
        throw err;
      }

      const allowedSheets = ['ICCID', 'MSISDN'];
      const parsedSheets: { sheet: string; rows: any[] }[] = [];

      for (const sheet of workbook.SheetNames) {
        const sheetData = workbook.Sheets[sheet];
        if (!sheetData || !allowedSheets.includes(sheet)) continue;
        parsedSheets.push({ sheet, rows: xlsx.utils.sheet_to_json(sheetData) });
      }

      const { batchID } = req.body;
      const userCode = req.user.code;
      const allowed = req.checkpointCodes ?? [];

      // Prepare rows without batchCode; batchCode is injected inside the transaction.
      // ICCID rows without a CHECKPOINT column are skipped — cards require a checkpoint.
      // ICCID rows whose checkpoint is outside the user's circle are also rejected.
      // MSISDN rows may omit CHECKPOINT (numbers are globally accessible).
      let skippedCardRows = 0;
      const preparedSheets = parsedSheets.map(({ sheet, rows }) => {
        const seen = new Set<string>();
        const data = rows
          .flatMap((row: any) => {
            const key = String(row.KEY || row.key);
            const rawCheckpoint = row.CHECKPOINT || row.checkpoint;
            if (sheet === 'ICCID') {
              if (!rawCheckpoint || !allowed.includes(String(rawCheckpoint))) {
                skippedCardRows++;
                return [];
              }
            }
            return [{
              key,
              checkpointCode: rawCheckpoint ? String(rawCheckpoint) : null,
              remark: row.REMARK || row.remark || ''
            }];
          })
          .filter((item: any) => {
            if (!item.key || item.key === 'undefined' || seen.has(item.key)) return false;
            seen.add(item.key);
            return true;
          });
        return { sheet, data };
      });

      const { totalCreated, parsedTotal } = await prisma.$transaction(async (tx) => {
        let batch: { id: number; code: string };

        if (batchID) {
          const existing = await tx.uploadBatch.findUnique({ where: { id: Number(batchID) } });
          if (!existing) {
            const err = new Error(`Batch ${batchID} not found`);
            (err as any).status = 404;
            throw err;
          }
          if (existing.status === 'COMPLETED') {
            const err = new Error(`Batch ${batchID} is already completed`);
            (err as any).status = 409;
            throw err;
          }
          batch = existing;
        } else {
          const lastBatch = await tx.uploadBatch.findFirst({ orderBy: { id: 'desc' } });
          const batchCode = lastBatch ? `UP${lastBatch.id + 1}` : 'UP1';
          batch = await tx.uploadBatch.create({
            data: { code: batchCode, userCode, status: 'ONGOING', total: 0 }
          });
        }

        // Inject batchCode now that we have it
        const jsonData = preparedSheets.map(({ sheet, data }) => ({
          sheet,
          data: data.map(row => ({ ...row, batchCode: batch.code }))
        }));

        const parsedTotal = jsonData.reduce((sum, s) => sum + s.data.length, 0);

        if (!batchID) {
          await tx.uploadBatch.update({
            where: { id: batch.id },
            data: { total: jsonData.find(s => s.sheet === 'ICCID')?.data.length || 0 }
          });
        }

        const result = await Promise.all(
          jsonData.map(async ({ sheet, data }) => {
            const keys = (data as any[]).map((r: any) => r.key as string);
            if (sheet === 'ICCID') {
              const existing = await tx.card.findMany({ where: { key: { in: keys } }, select: { key: true } });
              const existingSet = new Set(existing.map(c => c.key));
              const newRows = (data as any[]).filter((r: any) => !existingSet.has(r.key));
              return newRows.length > 0 ? tx.card.createMany({ data: newRows }) : { count: 0 };
            } else {
              const existing = await tx.number.findMany({ where: { key: { in: keys } }, select: { key: true } });
              const existingSet = new Set(existing.map(n => n.key));
              const newRows = data.filter((r: any) => !existingSet.has(r.key));
              return newRows.length > 0 ? tx.number.createMany({ data: newRows }) : { count: 0 };
            }
          })
        );

        const totalCreated = result.reduce((sum, r) => sum + r.count, 0);

        if (batchID) {
          const newCardsCount = result[jsonData.findIndex(s => s.sheet === 'ICCID')]?.count ?? 0;
          await tx.uploadBatch.update({
            where: { id: batch.id },
            data: { total: { increment: newCardsCount } }
          });
        } else if (totalCreated === 0) {
          await tx.uploadBatch.delete({ where: { id: batch.id } });
        }

        return { totalCreated, parsedTotal };
      });

      res.status(200).json({
        message: 'Upload completed successfully',
        data: { total: parsedTotal, created: totalCreated, skipped: skippedCardRows }
      });
    } catch (error) {
      next(error);
    }
  }

  static async downloadExcel(req: Request, res: Response, next: NextFunction) {
    try {
      
    } catch (error) {
      next(error);
    }
  }

  static async validateCard(req: Request, res: Response, next: NextFunction) {
    try {
      const { key } = req.params;
      const { status } = req.body;
      const rawStatus = Array.isArray(status) ? status[0] : status;

      const card = await prisma.$transaction(async (tx) => {
        if (!req.user) {
          throw new Error('User not found');
        }

        const validTargetStatuses = ['VERIFIED', 'BROKEN'];
        if (!rawStatus || !validTargetStatuses.includes(rawStatus)) {
          const err = new Error("Status must be 'VERIFIED' or 'BROKEN'");
          (err as any).status = 400;
          throw err;
        }

        const nextStatus = rawStatus as string;
        let updateData: any = {
          status: nextStatus
        };

        const card = await tx.card.findUnique({
          where: { key: key as string },
          include: { uploadBatch: true }
        });

        if (!card) {
          const err = new Error('Card not found');
          (err as any).status = 404;
          throw err;
        }

        const allowed = req.checkpointCodes ?? [];
        if (!hasCheckpointAccess(card.checkpointCode, allowed)) {
          const err = new Error('Card not found');
          (err as any).status = 404;
          throw err;
        }

        if (!card.uploadBatch) {
          const err = new Error('Card upload batch not found');
          (err as any).status = 404;
          throw err;
        }

        if (card.uploadBatch.status === "COMPLETED") {
          const err = new Error('Card upload batch is already completed');
          (err as any).status = 409;
          throw err;
        }

        if (card.status === 'OPNAME') {
          const err = new Error('Card is currently in an opname session and cannot be modified');
          (err as any).status = 409;
          throw err;
        }

        if (card.status === 'DELIVERY') {
          const err = new Error('Card is currently in delivery and cannot be modified');
          (err as any).status = 409;
          throw err;
        }

        if (card.status === 'SOLD') {
          const err = new Error('Card has already been sold');
          (err as any).status = 409;
          throw err;
        }

        if (card.status !== 'UNVERIFIED') {
          const err = new Error(`Card has already been validated`);
          (err as any).status = 409;
          throw err;
        }

        if (card.status === "UNVERIFIED") {
          updateData.validatedAt = new Date();
        }

        const updatedCard = await tx.card.update({
          where: { key: key as string },
          data: updateData
        });

        const lastProgress = await tx.uploadBatchProgress.findFirst({
          where: { batchCode: card.uploadBatch.code },
          orderBy: { createdAt: 'desc' }
        });

        if (card.status === "UNVERIFIED" || card.status === "BROKEN" || card.status === "LOST") {
          if (card.status === "UNVERIFIED") {
            await tx.uploadBatchProgress.create({
              data: {
                batchCode: card.uploadBatch.code,
                progress: (lastProgress?.progress || 0) + 1
              }
            })
          }
          if (nextStatus === "VERIFIED") {
            const stock = await tx.cardStock.findFirst({
              where: { checkpointCode: card.checkpointCode },
              orderBy: { createdAt: 'desc' }
            });
            // UNVERIFIED → VERIFIED is the first time a card enters stock (INITIAL).
            // BROKEN/LOST → VERIFIED is a re-entry after removal (RETURN).
            const movementType = card.status === "UNVERIFIED" ? "INITIAL" : "RETURN";
            await Promise.all([
              tx.cardMovement.create({
                data: {
                  cardID: card.id,
                  type: movementType,
                  userCode: req.user.code,
                  sourceCode: null,
                  targetCode: card.checkpointCode
                }
              }),
              tx.cardStock.create({
                data: {
                  checkpointCode: card.checkpointCode,
                  amount: Number(stock?.amount || 0) + 1
                }
              })
            ])
          }
        } else if (card.status === "VERIFIED") {
          if (nextStatus === "UNVERIFIED" || nextStatus === "BROKEN" || nextStatus === "LOST") {
            const stock = await tx.cardStock.findFirst({
              where: { checkpointCode: card.checkpointCode },
              orderBy: { createdAt: 'desc' }
            });
            await Promise.all([
              tx.cardMovement.create({
                data: {
                  cardID: card.id,
                  type: "ADJUSTMENT",
                  userCode: req.user.code,
                  sourceCode: card.checkpointCode,
                  targetCode: null
                }
              }),
              tx.cardStock.create({
                data: {
                  checkpointCode: card.checkpointCode,
                  amount: Number(stock?.amount || 0) - 1
                }
              })
            ])
          }
        } else {
          const err = new Error('Invalid card status transition');
          (err as any).status = 400;
          throw err;
        }

        return updatedCard;
      })

      res.status(200).json({
        message: 'Card validated successfully',
        data: { card }
      });
    } catch (error) {
      next(error);
    }
  }

  static async bulkMergeSim(req: Request, res: Response, next: NextFunction) {
    try {
      const { sims, checkpointCode, type, trn } = req.body;

      if (!req.user) throw new Error('User not found');
      if (!Array.isArray(sims) || sims.length === 0) {
        const err = new Error('sims must be a non-empty array');
        (err as any).status = 400;
        throw err;
      }
      if (!type) {
        const err = new Error('Type is required');
        (err as any).status = 400;
        throw err;
      }
      if (type === 'SIMCARD' && sims.some((s: any) => !s.cardKey)) {
        const err = new Error('ICCID is required for SIMCARD type');
        (err as any).status = 400;
        throw err;
      }
      if (!checkpointCode) {
        const err = new Error('Checkpoint code is required');
        (err as any).status = 400;
        throw err;
      }
      if (!trn) {
        const err = new Error('TRN is required');
        (err as any).status = 400;
        throw err;
      }

      const allowed = req.checkpointCodes ?? [];
      if (!hasCheckpointAccess(checkpointCode, allowed)) {
        const err = new Error('Checkpoint not found');
        (err as any).status = 404;
        throw err;
      }

      const results = await prisma.$transaction(async (tx) => {
        const checkpoint = await tx.checkpoint.findUnique({ where: { code: checkpointCode } });
        if (!checkpoint) {
          const err = new Error(`Checkpoint not found: ${checkpointCode}`);
          (err as any).status = 404;
          throw err;
        }

        const merged = [];

        for (const { cardKey, numberKey } of sims) {
          if (type === 'SIMCARD' || type === 'ESIM') {
            const number = await tx.number.findUnique({ where: { key: numberKey, status: 'VERIFIED' } });
            if (!number) {
              const err = new Error(`Number not found or not verified: ${numberKey}`);
              (err as any).status = 404;
              throw err;
            }
            if (number.checkpointCode !== null && number.checkpointCode !== checkpointCode) {
              const err = new Error(`Number ${numberKey} belongs to a different checkpoint`);
              (err as any).status = 409;
              throw err;
            }
            await tx.number.update({ where: { key: numberKey }, data: { status: 'SOLD' } });
          }

          let esimCode = '';
          if (type === 'ESIM') {
            esimCode = 'ESIM-' + (Date.now().toString(36) + Math.random().toString(36).slice(2, 6)).toUpperCase();
          } else if (type === 'CPP') {
            esimCode = 'CPP-' + (Date.now().toString(36) + Math.random().toString(36).slice(2, 6)).toUpperCase();
          } else if (type === 'MIGRATION') {
            esimCode = 'MGR-' + (Date.now().toString(36) + Math.random().toString(36).slice(2, 6)).toUpperCase();
          } else {
            esimCode = cardKey;
          }

          if (type === 'SIMCARD') {
            const card = await tx.card.findUnique({ where: { key: cardKey, status: 'VERIFIED' } });
            if (!card) {
              const err = new Error(`Card not found or not verified: ${cardKey}`);
              (err as any).status = 404;
              throw err;
            }
            if (checkpoint.code !== card.checkpointCode) {
              const err = new Error(`Card ${cardKey} is not at checkpoint ${checkpointCode}`);
              (err as any).status = 409;
              throw err;
            }
            await tx.card.update({ where: { key: cardKey }, data: { status: 'SOLD' } });

            const stock = await tx.cardStock.findFirst({
              where: { checkpointCode: card.checkpointCode },
              orderBy: { createdAt: 'desc' }
            });
            if (!stock || Number(stock.amount) <= 0) {
              const err = new Error(`No stock available at checkpoint ${checkpointCode}`);
              (err as any).status = 409;
              throw err;
            }
            await Promise.all([
              tx.cardStock.create({
                data: { checkpointCode: card.checkpointCode, amount: Number(stock.amount) - 1 }
              }),
              tx.cardMovement.create({
                data: {
                  cardID: card.id,
                  type: 'SALE',
                  userCode: req.user!.code,
                  sourceCode: card.checkpointCode,
                  targetCode: null
                }
              })
            ]);

            merged.push(await tx.merge.create({
              data: { cardKey, numberKey, checkpointCode, userCode: req.user!.code, TRN: trn, soldAt: new Date() }
            }));
          } else {
            merged.push(await tx.mergeAdditional.create({
              data: { cardKey: esimCode, numberKey, checkpointCode, userCode: req.user!.code, TRN: trn, type, soldAt: new Date() }
            }));
          }
        }

        return merged;
      });

      res.status(200).json({
        message: 'Sims successfully merged',
        data: { merges: results }
      });
    } catch (error) {
      next(error);
    }
  }

  static async mergeSim(req: Request, res: Response, next: NextFunction) {
    try {
      const { cardKey, numberKey, checkpointCode, type, trn } = req.body;

      if (!req.user) throw new Error('User not found');
      if (!type) {
        const err = new Error('Type is required');
        (err as any).status = 400;
        throw err;
      }
      if (type === 'SIMCARD' && !cardKey) {
        const err = new Error('ICCID is required for SIMCARD type');
        (err as any).status = 400;
        throw err;
      }
      if (!checkpointCode) {
        const err = new Error('Checkpoint code is required');
        (err as any).status = 400;
        throw err;
      }
      if (!trn) {
        const err = new Error('TRN is required');
        (err as any).status = 400;
        throw err;
      }

      const allowed = req.checkpointCodes ?? [];
      if (!hasCheckpointAccess(checkpointCode, allowed)) {
        const err = new Error('Checkpoint not found');
        (err as any).status = 404;
        throw err;
      }

      const sim = await prisma.$transaction(async (tx) => {
        const checkpoint = await tx.checkpoint.findUnique({ where: { code: checkpointCode } });
        if (!checkpoint) {
          const err = new Error('Checkpoint not found');
          (err as any).status = 404;
          throw err;
        }

        if (type === "SIMCARD" || type === "ESIM") {
          const number = await tx.number.findUnique({ where: { key: numberKey, status: "VERIFIED" } });
          if (!number) {
            const err = new Error('Number not found or not verified');
            (err as any).status = 404;
            throw err;
          }
          if (number.checkpointCode !== null && number.checkpointCode !== checkpointCode) {
            const err = new Error('Number belongs to a different checkpoint');
            (err as any).status = 409;
            throw err;
          }
          await tx.number.update({ where: { key: numberKey }, data: { status: 'SOLD' } });
        }
        if (type === "SIMCARD") {
          const card = await tx.card.findUnique({ where: { key: cardKey, status: "VERIFIED" } });
          if (!card) {
            const err = new Error('Card not found or not verified');
            (err as any).status = 404;
            throw err;
          }
          if (checkpoint.code !== card.checkpointCode) {
            const err = new Error('Card is not at the specified checkpoint');
            (err as any).status = 409;
            throw err;
          }
          await tx.card.update({ where: { key: cardKey }, data: { status: 'SOLD' } });
          const stock = await tx.cardStock.findFirst({
            where: { checkpointCode: card.checkpointCode },
            orderBy: { createdAt: 'desc' }
          });
          if (!stock || Number(stock.amount) <= 0) {
            const err = new Error('No stock available at this checkpoint');
            (err as any).status = 409;
            throw err;
          }
          await Promise.all([
            tx.cardStock.create({
              data: { checkpointCode: card.checkpointCode, amount: Number(stock.amount) - 1 }
            }),
            tx.cardMovement.create({
              data: {
                cardID: card.id,
                type: 'SALE',
                userCode: req.user!.code,
                sourceCode: card.checkpointCode,
                targetCode: null
              }
            })
          ]);
        }
  
        let esimCode = "";

        if (type === "ESIM") {
          esimCode = "ESIM-" + (Date.now().toString(36) + Math.random().toString(36).slice(2, 6)).toUpperCase();
        } else if (type === "CPP") {
          esimCode = "CPP-" + (Date.now().toString(36) + Math.random().toString(36).slice(2, 6)).toUpperCase();
        } else if (type === "MIGRATION") {
          esimCode = "MGR-" + (Date.now().toString(36) + Math.random().toString(36).slice(2, 6)).toUpperCase();
        } else {
          esimCode = cardKey;
        }
        let sim

        if (type === "SIMCARD") {
          sim = await tx.merge.create({
            data: {
              cardKey,
              numberKey,
              checkpointCode,
              userCode: req.user!.code,
              TRN: trn,
              soldAt: new Date()
            }
          })
        } else {
          sim = await tx.mergeAdditional.create({
            data: {
              cardKey: esimCode,
              numberKey,
              checkpointCode,
              userCode: req.user!.code,
              TRN: trn,
              type,
              soldAt: new Date()
            }
          })
        }
        return sim
      });

      res.status(200).json({
        message: 'Sim successfully merged',
        data: { sim }
      });
    } catch (error) {
      next(error);
    }
  }

  // ============================================================================
  // NUMBER CRUD OPERATIONS
  // ============================================================================

  static async createNumber(req: Request, res: Response, next: NextFunction) {
    try {
      // const { name, key, checkpointCode, status, remark } = req.body;

      // const number = await prisma.number.create({
      //   data: {
      //     name,
      //     key,
      //     checkpointCode,
      //     status: status || 'VERIFIED',
      //     remark
      //   },
      //   include: {
      //     checkpoint: true
      //   }
      // });

      // res.status(201).json({
      //   message: 'Number created successfully',
      //   data: number
      // });
    } catch (error) {
      next(error);
    }
  }

  static async getNumbers(req: Request, res: Response, next: NextFunction) {
    try {
      const { page = 1, limit = 10, checkpointCode, status, search, remark, sort } = req.query;
      const allowed = req.checkpointCodes ?? [];
      const checkpointFilter = resolveCheckpointFilter(checkpointCode as string | undefined, allowed);

      // Numbers with no checkpoint are globally visible (available stock);
      // numbers with a checkpoint are restricted to the user's circle.
      const where: any = {
        AND: [
          { OR: [{ checkpointCode: { in: checkpointFilter } }, { checkpointCode: null }] }
        ]
      };
      if (status) where.status = status;
      if (search) {
        where.OR = [
          { key: { contains: search as string, mode: 'insensitive' } },
          { name: { contains: search as string, mode: 'insensitive' } }
        ];
      }
      if (remark) {
        where.remark = {
          contains: remark as string, mode: 'insensitive'
        }
      }
      if (sort && sort !== "ASC" && sort !== "DESC") {
        const err = new Error("sort must be 'ASC' or 'DESC'");
        (err as any).status = 400;
        throw err;
      }

      const [numbers, total] = await Promise.all([
        prisma.number.findMany({
          where,
          skip: (Number(page) - 1) * Number(limit),
          take: Number(limit),
          include: {
            checkpoint: true,
            merge: true
          },
          orderBy: { createdAt: sort === 'ASC' ? 'asc' : 'desc' }
        }),
        prisma.number.count({ where })
      ]);

      const numberAmountWhere = {
        OR: [
          { checkpointCode: { in: checkpointFilter } },
          { checkpointCode: null }
        ]
      };
      const mergeAmountWhere = { checkpointCode: { in: allowed } };

      const [totalUpload, totalAvailable, totalMerge, monthlyMerge, dailyMerge] = await Promise.all([
        prisma.number.count({ where: numberAmountWhere }),
        prisma.number.count({ where: { ...numberAmountWhere, status: "VERIFIED" } }),
        prisma.merge.count({ where: mergeAmountWhere }),
        prisma.merge.count({
          where: {
            ...mergeAmountWhere,
            createdAt: { gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1) }
          }
        }),
        prisma.merge.count({
          where: {
            ...mergeAmountWhere,
            createdAt: { gte: new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()) }
          }
        })
      ]);

      res.status(200).json({
        message: 'Numbers retrieved successfully',
        data: {
          numbers,
          amount: {
            upload: totalUpload,
            available: totalAvailable,
            merge: {
              total: totalMerge,
              monthly: monthlyMerge,
              daily: dailyMerge
            }
          }
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

  static async getNumber(req: Request, res: Response, next: NextFunction) {
    try {
      const { key } = req.params;
      const allowed = req.checkpointCodes ?? [];

      const number = await prisma.number.findUnique({
        where: { key: key as string },
        include: {
          checkpoint: true,
          movements: {
            include: { number: true },
            orderBy: { createdAt: 'desc' }
          }
        }
      });

      // allowNull=true: a number with no checkpoint is accessible to everyone
      if (!number || !hasCheckpointAccess(number.checkpointCode, allowed, true)) {
        const err = new Error('Number not found');
        (err as any).status = 404;
        throw err;
      }

      res.status(200).json({
        message: 'Number retrieved successfully',
        data: { number }
      });
    } catch (error) {
      next(error);
    }
  }

  static async updateNumber(req: Request, res: Response, next: NextFunction) {
    try {
      const { key } = req.params;
      const { name, status, remark } = req.body;
      const allowed = req.checkpointCodes ?? [];

      const existing = await prisma.number.findUnique({ where: { key: key as string } });
      if (!existing || !hasCheckpointAccess(existing.checkpointCode, allowed, true)) {
        const err = new Error('Number not found');
        (err as any).status = 404;
        throw err;
      }

      const number = await prisma.number.update({
        where: { key: key as string },
        data: {
          ...(name !== undefined && { name }),
          ...(status && { status }),
          ...(remark !== undefined && { remark })
        },
        include: {
          checkpoint: true
        }
      });

      res.status(200).json({
        message: 'Number updated successfully',
        data: { number }
      });
    } catch (error) {
      next(error);
    }
  }

  static async deleteNumber(req: Request, res: Response, next: NextFunction) {
    try {
      const { key } = req.params;
      const allowed = req.checkpointCodes ?? [];

      const existing = await prisma.number.findUnique({ where: { key: key as string } });
      if (!existing || !hasCheckpointAccess(existing.checkpointCode, allowed, true)) {
        const err = new Error('Number not found');
        (err as any).status = 404;
        throw err;
      }

      await prisma.number.delete({
        where: { key: key as string }
      });

      res.status(200).json({
        message: 'Number deleted successfully'
      });
    } catch (error) {
      next(error);
    }
  }

  static async getMerges(req: Request, res: Response, next: NextFunction) {
    try {
      const { page = 1, limit = 10, checkpointCode, startSoldAt, endSoldAt, cardRemark, search, type } = req.query;
      const allowed = req.checkpointCodes ?? [];

      let where: any = {
        checkpointCode: { in: resolveCheckpointFilter(checkpointCode as string | undefined, allowed) }
      };
      if (startSoldAt) {
        where.createdAt = {
          gte: new Date(new Date(startSoldAt as string).setHours(0, 0, 0, 0))
        }
      }
      if (endSoldAt) {
        where.createdAt = {
          ...where.createdAt,
          lte: new Date(new Date(endSoldAt as string).setHours(23, 59, 59, 999))
        }
      }
      const isSimcardQuery = type === "SIMCARD" || !type;
      if (cardRemark && isSimcardQuery) {
        where.number = { remark: cardRemark as string };
      }
      if (search) {
        if (isSimcardQuery) {
          where.number = { ...where.number, key: { contains: search as string } };
        } else {
          where.cardKey = { contains: search as string };
        }
      }
      let merges

      if (isSimcardQuery) {
        merges = await prisma.merge.findMany({
          skip: (Number(page) - 1) * Number(limit),
          take: Number(limit),
          orderBy: { createdAt: 'desc' },
          where,
          include: { number: true }
        });
      } else {
        merges = await prisma.mergeAdditional.findMany({
          skip: (Number(page) - 1) * Number(limit),
          take: Number(limit),
          orderBy: { createdAt: 'desc' },
          where
        });
      }
      const baseCountWhere = { checkpointCode: { in: allowed } };
      const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
      const dayStart = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());

      const [total, monthly, daily] = isSimcardQuery
        ? await Promise.all([
            prisma.merge.count({ where: baseCountWhere }),
            prisma.merge.count({ where: { ...baseCountWhere, createdAt: { gte: monthStart } } }),
            prisma.merge.count({ where: { ...baseCountWhere, createdAt: { gte: dayStart } } })
          ])
        : await Promise.all([
            prisma.mergeAdditional.count({ where: baseCountWhere }),
            prisma.mergeAdditional.count({ where: { ...baseCountWhere, createdAt: { gte: monthStart } } }),
            prisma.mergeAdditional.count({ where: { ...baseCountWhere, createdAt: { gte: dayStart } } })
          ]);

      res.status(200).json({
        message: 'Merges retrieved successfully',
        data: {
          merges,
          amount: { total, monthly, daily }
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
}

export default StockController