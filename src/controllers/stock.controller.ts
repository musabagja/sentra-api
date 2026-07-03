import type { Request, Response, NextFunction } from 'express';
import prisma from '../../lib/prisma';
import * as xlsx from 'xlsx';

import { hasCheckpointAccess, resolveCheckpointFilter, checkpointInCircle } from '../utils/access.util';

class StockController {

  static async dashboardSync (req: Request, res: Response, next: NextFunction) {
    try {
      const allowed = req.checkpointCodes ?? [];
      const circleCode = req.user!.circleCode;
      const dcCode    = req.query.dcCode    as string | undefined;
      const storeCode = req.query.storeCode as string | undefined;

      const now          = new Date();
      const currentYear  = now.getFullYear();
      const currentMonth = now.getMonth() + 1; // 1-indexed

      const year  = Number(req.query.year)  || currentYear;
      const month = Number(req.query.month) || currentMonth;

      // Cutoff: end of today when viewing the current month, otherwise last day of the requested month
      const isCurrentPeriod = year === currentYear && month === currentMonth;
      const cutoff = isCurrentPeriod
        ? new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999)
        : new Date(year, month, 0, 23, 59, 59, 999); // day 0 of next month = last day of this month

      const yearStart = new Date(year, 0, 1);

      const scopeFilter = {
        status: 'DELIVERED' as const,
        OR: [{ source: checkpointInCircle(circleCode) }, { target: checkpointInCircle(circleCode) }],
        createdAt: { lte: cutoff }
      };

      const dcMonthlyWhere = {
        ...scopeFilter,
        target: { type: 'DC', ...(dcCode && { code: dcCode }) },
        createdAt: { gte: yearStart, lte: cutoff }
      };

      const storeMonthlyWhere = {
        ...scopeFilter,
        target: { type: 'STORE', ...(storeCode && { code: storeCode }) },
        createdAt: { gte: yearStart, lte: cutoff }
      };

      const [dcAggregate, storeAggregate, allCheckpoints, latestStocks, baseInitialCount, brokenLostCards, topSaleByUser, dcMonthlyRows, storeMonthlyRows] = await Promise.all([
        // 1. Cards distributed TO DC checkpoints up to cutoff
        prisma.distribution.aggregate({
          _sum: { amount: true },
          where: { ...scopeFilter, target: { type: 'DC' } }
        }),

        // 2. Cards distributed TO STORE checkpoints up to cutoff
        prisma.distribution.aggregate({
          _sum: { amount: true },
          where: { ...scopeFilter, target: { type: 'STORE' } }
        }),

        // Shared checkpoint fetch
        prisma.checkpoint.findMany({
          where: checkpointInCircle(circleCode)
        }),

        // Latest stock snapshot per checkpoint up to cutoff.
        // Queried flat (not as a nested `include`) — a nested include would batch-load
        // via `WHERE checkpointCode IN (<every checkpoint id just fetched>)`, which can
        // exceed SQL Server's ~2100 parameter limit for large circles (e.g. HQ).
        prisma.cardStock.findMany({
          where: { checkpoint: checkpointInCircle(circleCode), createdAt: { lte: cutoff } },
          orderBy: { createdAt: 'desc' },
          distinct: ['checkpointCode']
        }),

        // Base initial stock: active cards created up to cutoff
        prisma.card.count({
          where: {
            checkpoint: checkpointInCircle(circleCode),
            status: { in: ['VERIFIED', 'SOLD', 'DELIVERY', 'OPNAME'] },
            createdAt: { lte: cutoff }
          }
        }),

        // BROKEN/LOST candidates — need to check if opname-traced
        prisma.card.findMany({
          where: {
            checkpoint: checkpointInCircle(circleCode),
            status: { in: ['BROKEN', 'LOST'] },
            createdAt: { lte: cutoff }
          },
          select: { id: true }
        }),

        // Top 10 users by total sales (merges) up to cutoff
        prisma.merge.groupBy({
          by: ['userCode'],
          where: { checkpoint: checkpointInCircle(circleCode), createdAt: { lte: cutoff } },
          _count: { userCode: true },
          orderBy: { _count: { userCode: 'desc' } },
          take: 10
        }),

        // Monthly DC distributions for selected year up to cutoff
        prisma.distribution.findMany({
          where: dcMonthlyWhere,
          select: { amount: true, createdAt: true }
        }),

        // Monthly STORE distributions for selected year up to cutoff
        prisma.distribution.findMany({
          where: storeMonthlyWhere,
          select: { amount: true, createdAt: true }
        })
      ]);

      // Cards that are BROKEN/LOST but discovered via opname still count toward initial stock.
      const brokenLostIds = brokenLostCards.map(c => c.id);
      const [opnamedBrokenLostCount, topSaleByCheckpoint] = await Promise.all([
        brokenLostIds.length > 0
          ? prisma.opnameUpdate.groupBy({
              by: ['itemID'],
              where: { itemID: { in: brokenLostIds }, createdAt: { lte: cutoff } }
            }).then(groups => groups.length)
          : Promise.resolve(0),

        // Top 10 STORE checkpoints by total sales (merges) up to cutoff
        prisma.merge.groupBy({
          by: ['checkpointCode'],
          where: { checkpoint: { type: 'STORE', ...checkpointInCircle(circleCode) }, createdAt: { lte: cutoff } },
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

      const stockByCheckpoint = Object.fromEntries(latestStocks.map(s => [s.checkpointCode, s.amount]));

      // Final stock: sum of latest CardStock snapshot per checkpoint up to cutoff
      const finalStock = allCheckpoints.reduce(
        (sum, c) => sum + (stockByCheckpoint[c.code] ?? 0), 0
      );

      const withStock = (c: typeof allCheckpoints[number]) =>
        ({ ...c, currentStock: stockByCheckpoint[c.code] ?? 0 });

      const topLeastStoreStock = allCheckpoints
        .filter(c => c.type === 'STORE')
        .map(withStock)
        .sort((a, b) => a.currentStock - b.currentStock)
        .slice(0, 10);

      const topMostDCStock = allCheckpoints
        .filter(c => c.type === 'DC')
        .map(withStock)
        .sort((a, b) => b.currentStock - a.currentStock)
        .slice(0, 10);

      const checkpointMap = Object.fromEntries(allCheckpoints.map(c => [c.code, c]));

      const topHighestSaleByCheckpoint = topSaleByCheckpoint.map(row => ({
        checkpoint: checkpointMap[row.checkpointCode!],
        totalSales: row._count.checkpointCode
      }));

      const topHighestSaleByUser = topSaleByUser.map(row => ({
        user: userDetailMap[row.userCode] ?? { code: row.userCode, name: null },
        totalSales: row._count.userCode
      }));

      // 12-element monthly arrays — months after cutoff will be 0
      const buildMonthlyTotals = (rows: { amount: number; createdAt: Date }[]) => {
        const months = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, amount: 0 }));
        for (const row of rows) {
          months[new Date(row.createdAt).getMonth()]!.amount += row.amount ?? 0;
        }
        return months;
      };

      const distributedToDCByMonth    = buildMonthlyTotals(dcMonthlyRows);
      const distributedToStoreByMonth = buildMonthlyTotals(storeMonthlyRows);

      res.status(200).json({
        message: 'Dashboard synced successfully',
        data: {
          year,
          month,
          cutoff,
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

  static async getDCDistributionChart(req: Request, res: Response, next: NextFunction) {
    try {
      const allowed = req.checkpointCodes ?? [];
      const circleCode = req.user!.circleCode;
      const checkpointCode = req.query.checkpointCode as string | undefined;

      const now         = new Date();
      const currentYear = now.getFullYear();
      const year        = Number(req.query.year) || currentYear;

      const cutoff = year === currentYear
        ? new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999)
        : new Date(year, 11, 31, 23, 59, 59, 999);

      const yearStart = new Date(year, 0, 1);

      if (checkpointCode && !allowed.includes(checkpointCode)) {
        const err = new Error('Checkpoint not found');
        (err as any).status = 404;
        throw err;
      }

      const [dcCheckpoints, rows] = await Promise.all([
        prisma.checkpoint.findMany({
          where: { ...checkpointInCircle(circleCode), type: 'DC' },
          select: { code: true, name: true },
          orderBy: { name: 'asc' }
        }),
        prisma.distribution.findMany({
          where: {
            status: 'DELIVERED',
            OR: [{ source: checkpointInCircle(circleCode) }, { target: checkpointInCircle(circleCode) }],
            target: { type: 'DC', ...(checkpointCode && { code: checkpointCode }) },
            createdAt: { gte: yearStart, lte: cutoff }
          },
          select: { amount: true, createdAt: true }
        })
      ]);

      const chart = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, amount: 0 }));
      for (const row of rows) {
        chart[new Date(row.createdAt).getMonth()]!.amount += row.amount ?? 0;
      }

      res.status(200).json({
        message: 'DC distribution chart retrieved successfully',
        data: { year, cutoff, checkpoints: dcCheckpoints, chart }
      });
    } catch (error) {
      next(error);
    }
  }

  static async getStoreDistributionChart(req: Request, res: Response, next: NextFunction) {
    try {
      const allowed = req.checkpointCodes ?? [];
      const circleCode = req.user!.circleCode;
      const checkpointCode = req.query.checkpointCode as string | undefined;

      const now         = new Date();
      const currentYear = now.getFullYear();
      const year        = Number(req.query.year) || currentYear;

      const cutoff = year === currentYear
        ? new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999)
        : new Date(year, 11, 31, 23, 59, 59, 999);

      const yearStart = new Date(year, 0, 1);

      if (checkpointCode && !allowed.includes(checkpointCode)) {
        const err = new Error('Checkpoint not found');
        (err as any).status = 404;
        throw err;
      }

      const [storeCheckpoints, rows] = await Promise.all([
        prisma.checkpoint.findMany({
          where: { ...checkpointInCircle(circleCode), type: 'STORE' },
          select: { code: true, name: true },
          orderBy: { name: 'asc' }
        }),
        prisma.distribution.findMany({
          where: {
            status: 'DELIVERED',
            OR: [{ source: checkpointInCircle(circleCode) }, { target: checkpointInCircle(circleCode) }],
            target: { type: 'STORE', ...(checkpointCode && { code: checkpointCode }) },
            createdAt: { gte: yearStart, lte: cutoff }
          },
          select: { amount: true, createdAt: true }
        })
      ]);

      const chart = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, amount: 0 }));
      for (const row of rows) {
        chart[new Date(row.createdAt).getMonth()]!.amount += row.amount ?? 0;
      }

      res.status(200).json({
        message: 'Store distribution chart retrieved successfully',
        data: { year, cutoff, checkpoints: storeCheckpoints, chart }
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
      const circleCode = req.user!.circleCode;

      const allowedStatus = ['ONGOING', 'COMPLETED'];

      if (status && !allowedStatus.includes(status as string)) {
        const err = new Error('Invalid status');
        (err as any).status = 400;
        throw err;
      }

      const where: any = {
        cards: { some: { checkpoint: checkpointInCircle(circleCode) } }
      };
      if (status) {
        where.status = status;
      }
      if (search) {
        where.OR = [
          { code: { contains: search as string } },
          { name: { contains: search as string } }
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
        prisma.card.count({ where: { checkpoint: checkpointInCircle(circleCode) } }),
        prisma.card.count({ where: { checkpoint: checkpointInCircle(circleCode), status: 'VERIFIED' } }),
        prisma.card.count({ where: { checkpoint: checkpointInCircle(circleCode), status: 'UNVERIFIED' } })
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
      const circleCode = req.user!.circleCode;

      const where: any = {
        // Scope to checkpoints in the user's circle; intersect with any requested checkpointCode
        checkpoint: checkpointInCircle(circleCode, checkpointCode as string | undefined)
      };
      if (status) where.status = status;
      if (search) {
        where.OR = [
          { key: { contains: search as string } },
          { name: { contains: search as string } }
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
            code: { contains: batch as string }
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
        prisma.card.count({ where: { checkpoint: checkpointInCircle(circleCode) } }),
        prisma.card.count({ where: { checkpoint: checkpointInCircle(circleCode), status: "SOLD" } }),
        prisma.card.count({ where: { checkpoint: checkpointInCircle(circleCode), status: "VERIFIED" } })
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
      const key = String(req.params.key);
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

  static async uploadSoldExcel(req: Request, res: Response, next: NextFunction) {
    try {
      const file = (req as any).file;

      if (!file) {
        const err = new Error('No file uploaded');
        (err as any).status = 400;
        throw err;
      }

      const workbook = xlsx.read(file.buffer, { type: 'buffer' });
      const sheet = workbook.Sheets[workbook.SheetNames[0]!];
      if (!sheet) {
        const err = new Error('Excel file has no sheets');
        (err as any).status = 422;
        throw err;
      }

      const rows: any[] = xlsx.utils.sheet_to_json(sheet);

      type SoldRow = { iccid: string; msisdn: string; storeCode: string };
      const parsed: SoldRow[] = [];
      const seen = new Set<string>();
      for (const r of rows) {
        const iccid     = String(r.ICCID     ?? r.iccid     ?? '').trim();
        const msisdn    = String(r.MSISDN    ?? r.msisdn    ?? '').trim();
        const storeCode = String(r.STORE_CODE ?? r.store_code ?? '').trim();
        if (!iccid || seen.has(iccid)) continue;
        seen.add(iccid);
        parsed.push({ iccid, msisdn, storeCode });
      }

      if (parsed.length === 0) {
        const err = new Error('No ICCID values found in the file');
        (err as any).status = 422;
        throw err;
      }

      const allowed = req.checkpointCodes ?? [];
      const iccids  = parsed.map(r => r.iccid);
      const msisdns = parsed.map(r => r.msisdn).filter(Boolean);

      // Fetch merges, cards, and numbers in parallel
      const [merges, cards, numbers] = await Promise.all([
        prisma.merge.findMany({
          where: { cardKey: { in: iccids } },
          select: { cardKey: true, numberKey: true, checkpointCode: true, soldAt: true, verifiedAt: true }
        }),
        prisma.card.findMany({
          where: { key: { in: iccids } },
          select: { key: true, status: true, validatedAt: true }
        }),
        msisdns.length > 0
          ? prisma.number.findMany({
              where: { key: { in: msisdns } },
              select: { key: true, status: true }
            })
          : Promise.resolve([])
      ]);

      const mergeMap  = new Map(merges.map(m => [m.cardKey, m]));
      const cardMap   = new Map(cards.map(c => [c.key, c]));
      const numberMap = new Map(numbers.map(n => [n.key, n]));

      const notInMerge: string[]       = [];
      const storeNotAccessible: string[] = [];
      const mismatched: string[]       = [];
      const checkpointMismatch: string[] = [];
      const noSoldAt: string[]         = [];
      const notSoldStatus: string[]    = [];
      const numberNotSold: string[]    = [];
      const neverValidated: string[]   = [];

      for (const row of parsed) {
        const merge = mergeMap.get(row.iccid);
        const card  = cardMap.get(row.iccid);

        // 1. Must have a Merge record
        if (!merge) { notInMerge.push(row.iccid); continue; }

        // 2. STORE_CODE must be in the user's accessible checkpoints
        if (row.storeCode && !allowed.includes(row.storeCode)) {
          storeNotAccessible.push(row.iccid); continue;
        }

        // 3. MSISDN must match merge.numberKey
        if (row.msisdn && merge.numberKey !== row.msisdn) {
          mismatched.push(`${row.iccid} (expected ${merge.numberKey}, got ${row.msisdn})`); continue;
        }

        // 4. merge.checkpointCode must match STORE_CODE
        if (row.storeCode && merge.checkpointCode !== row.storeCode) {
          checkpointMismatch.push(`${row.iccid} (sold at ${merge.checkpointCode ?? 'unknown'}, got ${row.storeCode})`); continue;
        }

        // 5. merge.soldAt must not be null
        if (!merge.soldAt) {
          noSoldAt.push(row.iccid); continue;
        }

        // 6. card.status must be SOLD
        if (!card || card.status !== 'SOLD') {
          notSoldStatus.push(row.iccid); continue;
        }

        // 7. number.status must be SOLD
        const number = numberMap.get(merge.numberKey);
        if (!number || number.status !== 'SOLD') {
          numberNotSold.push(`${row.iccid} (MSISDN ${merge.numberKey} status: ${number?.status ?? 'not found'})`); continue;
        }

        // 8. card must have been physically validated
        if (!card.validatedAt) {
          neverValidated.push(row.iccid);
        }
      }

      const errors: string[] = [];
      if (notInMerge.length > 0)        errors.push(`not in merge: ${notInMerge.join(', ')}`);
      if (storeNotAccessible.length > 0) errors.push(`store not accessible: ${storeNotAccessible.join(', ')}`);
      if (mismatched.length > 0)        errors.push(`MSISDN mismatch: ${mismatched.join('; ')}`);
      if (checkpointMismatch.length > 0) errors.push(`store mismatch: ${checkpointMismatch.join('; ')}`);
      if (noSoldAt.length > 0)          errors.push(`soldAt missing: ${noSoldAt.join(', ')}`);
      if (notSoldStatus.length > 0)     errors.push(`card not SOLD: ${notSoldStatus.join(', ')}`);
      if (numberNotSold.length > 0)     errors.push(`number not SOLD: ${numberNotSold.join('; ')}`);
      if (neverValidated.length > 0)    errors.push(`never validated: ${neverValidated.join(', ')}`);

      if (errors.length > 0) {
        const err = new Error(errors.join(' | '));
        (err as any).status = 422;
        throw err;
      }

      const toUpdate = iccids.filter(k => mergeMap.get(k)!.verifiedAt === null);
      const skipped  = iccids.length - toUpdate.length;

      if (toUpdate.length > 0) {
        await prisma.merge.updateMany({
          where: { cardKey: { in: toUpdate } },
          data: { verifiedAt: new Date() }
        });
      }

      res.status(200).json({
        message: 'Sold cards updated successfully',
        data: { total: iccids.length, updated: toUpdate.length, skipped }
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
      const circleCode = req.user!.circleCode;

      // Numbers with no checkpoint are globally visible (available stock);
      // numbers with a checkpoint are restricted to the user's circle.
      const where: any = {
        AND: [
          { OR: [{ checkpoint: checkpointInCircle(circleCode, checkpointCode as string | undefined) }, { checkpointCode: null }] }
        ]
      };
      if (status) where.status = status;
      if (search) {
        where.OR = [
          { key: { contains: search as string } },
          { name: { contains: search as string } }
        ];
      }
      if (remark) {
        where.remark = {
          contains: remark as string
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
          { checkpoint: checkpointInCircle(circleCode, checkpointCode as string | undefined) },
          { checkpointCode: null }
        ]
      };
      const mergeAmountWhere = { checkpoint: checkpointInCircle(circleCode) };

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
      const circleCode = req.user!.circleCode;

      let where: any = {
        checkpoint: checkpointInCircle(circleCode, checkpointCode as string | undefined)
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
      const baseCountWhere = { checkpoint: checkpointInCircle(circleCode) };
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