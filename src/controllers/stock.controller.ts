import type { Request, Response, NextFunction } from 'express';
import {
  wibEndOfDay, wibMonthEnd, wibMonthIndex, wibMonthStart, wibStartOfDay, wibToday, wibYearEnd, wibYearStart, wibYmd
} from '../utils/wib.util';
import prisma from '../../lib/prisma';
import * as xlsx from 'xlsx';

import { hasCheckpointAccess, resolveCheckpointFilter, checkpointInCircle, circleScope } from '../utils/access.util';
import { batchInScope, buildBatchWhere, buildCardWhere, buildNumberWhere, csvParam } from '../utils/list-filters.util';
import { rankSalesByPlace } from '../utils/sales-ranking.util';
import { sheetRows, normalizeKeyCell, chunkArray, fetchChunked, errorBucket, MAX_LISTED_ERRORS, type RowIssue } from '../utils/upload.util';
export type { RowIssue };

// A cross-location sale note is stored in Merge.remark
const MAX_NOTE_LENGTH = 255;

// Cards held at one location but reported sold at another, grouped per route.
const groupByRoute = (items: RowIssue[]) => {
  const groups = new Map<string, { from: string; to: string; count: number; items: { row: number; iccid: string; msisdn: string | undefined }[] }>();
  for (const it of items) {
    const from = it.fromCode ?? '';
    const to = it.storeCode ?? '';
    const key = `${from}>${to}`;
    const group = groups.get(key) ?? { from, to, count: 0, items: [] };
    group.items.push({ row: it.row, iccid: it.iccid, msisdn: it.msisdn });
    group.count = group.items.length;
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
};

class StockController {

  static async dashboardSync (req: Request, res: Response, next: NextFunction) {
    try {
      const allowed = req.checkpointCodes ?? [];
      const circleCode = circleScope(req);
      const dcCode    = req.query.dcCode    as string | undefined;
      const storeCode = req.query.storeCode as string | undefined;

      // The calendar is Jakarta's, whatever time zone the server runs in
      const now          = new Date();
      const { year: currentYear, month: currentMonth } = wibYmd(now); // month is 1-indexed

      const year  = Number(req.query.year)  || currentYear;
      const month = Number(req.query.month) || currentMonth;

      // Cutoff: end of today when viewing the current month, otherwise last day of the requested month
      const isCurrentPeriod = year === currentYear && month === currentMonth;
      const cutoff = isCurrentPeriod ? wibEndOfDay(now) : wibMonthEnd(year, month);

      const yearStart = wibYearStart(year);

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

      const [dcAggregate, storeAggregate, allCheckpoints, latestStocks, baseInitialCount, brokenLostCards, topSaleByUser, dcMonthlyRows, storeMonthlyRows, pendingRows] = await Promise.all([
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
        }),

        // Cards uploaded to a checkpoint but not yet validated. These are held
        // physically but carry no CardStock entry — CardStock is only credited on
        // UNVERIFIED -> VERIFIED (see validateCard) — so they are reported separately
        // as `pendingStock` rather than folded into `currentStock`.
        // Grouped via a relation filter, not an `IN` list, to stay under SQL Server's
        // ~2100 parameter limit for large circles.
        prisma.card.groupBy({
          by: ['checkpointCode'],
          where: {
            checkpoint: checkpointInCircle(circleCode),
            status: 'UNVERIFIED',
            createdAt: { lte: cutoff }
          },
          _count: { _all: true }
        })
      ]);

      // Cards that are BROKEN/LOST but discovered via opname still count toward initial stock.
      const brokenLostIds = brokenLostCards.map(c => c.id);
      const [opnamedBrokenLostCount, topSaleByCheckpoint, totalSales] = await Promise.all([
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
        }),

        // Circle-wide sales (merges) up to cutoff. Same unit as the per-row
        // `totalSales` on topHighestSaleByCheckpoint/ByUser below, which are its
        // breakdown — so the dashboard figures reconcile. Note this is NOT the
        // `Card.status = 'SOLD'` count exposed as `amount.sold` by the card list.
        prisma.merge.count({
          where: { checkpoint: checkpointInCircle(circleCode), createdAt: { lte: cutoff } }
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

      const pendingByCheckpoint = Object.fromEntries(pendingRows.map(r => [r.checkpointCode, r._count._all]));

      const withStock = (c: typeof allCheckpoints[number]) =>
        ({
          ...c,
          currentStock: stockByCheckpoint[c.code] ?? 0,
          pendingStock: pendingByCheckpoint[c.code] ?? 0
        });

      const storeStocks = allCheckpoints.filter(c => c.type === 'STORE').map(withStock);
      const dcStocks    = allCheckpoints.filter(c => c.type === 'DC').map(withStock);
      // HQ. Filtered as "neither STORE nor DC" rather than `type === 'HQ'` so that a
      // checkpoint whose free-form `type` string drifts (casing, a new value) still
      // lands somewhere: `finalStock` sums every checkpoint, so anything missed here
      // would make totalStoreStock + totalDCStock silently under-report it.
      const hqStocks = allCheckpoints.filter(c => c.type !== 'STORE' && c.type !== 'DC').map(withStock);

      // Ranked by highest stock. Sorting ascending here would only ever surface the
      // checkpoints that have no CardStock snapshot yet (they fall back to 0), which
      // vastly outnumber the ones actually holding cards.
      // Response key kept as `topLeastStoreStock` for frontend compatibility.
      // Tie-broken by pendingStock so a list of all-zero validated stock (every DC today)
      // still ranks by what is actually sitting at the checkpoint awaiting validation.
      const byStockThenPending = (a: { currentStock: number; pendingStock: number }, b: typeof a) =>
        b.currentStock - a.currentStock || b.pendingStock - a.pendingStock;

      const topLeastStoreStock = [...storeStocks].sort(byStockThenPending).slice(0, 10);
      const topMostDCStock     = [...dcStocks].sort(byStockThenPending).slice(0, 10);

      // Every store / DC with its stock, lowest first, for the dashboard's "Lihat semua" modal
      const byLowestStock = (a: { currentStock: number; name: string }, b: typeof a) =>
        a.currentStock - b.currentStock || a.name.localeCompare(b.name);
      const stockList = (rows: typeof storeStocks) =>
        rows
          .map(({ name, code, currentStock, pendingStock }) => ({ name, code, currentStock, pendingStock }))
          .sort(byLowestStock);
      const allStoreStock = stockList(storeStocks);
      const allDCStock    = stockList(dcStocks);

      // Circle-wide totals across every checkpoint of the type, not just the top 10
      const totalStoreStock   = storeStocks.reduce((sum, c) => sum + c.currentStock, 0);
      const totalDCStock      = dcStocks.reduce((sum, c) => sum + c.currentStock, 0);
      const totalStorePending = storeStocks.reduce((sum, c) => sum + c.pendingStock, 0);
      const totalDCPending    = dcStocks.reduce((sum, c) => sum + c.pendingStock, 0);
      const totalHQStock      = hqStocks.reduce((sum, c) => sum + c.currentStock, 0);
      const totalHQPending    = hqStocks.reduce((sum, c) => sum + c.pendingStock, 0);
      // Invariant: totalStock === finalStock
      const totalStock        = totalStoreStock + totalDCStock + totalHQStock;
      const totalPending      = totalStorePending + totalDCPending + totalHQPending;

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
          months[wibMonthIndex(row.createdAt)]!.amount += row.amount ?? 0;
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
          allStoreStock,
          allDCStock,
          totalStoreStock,
          totalDCStock,
          totalStorePending,
          totalDCPending,
          totalHQStock,
          totalHQPending,
          totalStock,
          totalPending,
          totalSales,
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
      const circleCode = circleScope(req);
      const checkpointCode = req.query.checkpointCode as string | undefined;

      const now         = new Date();
      const currentYear = wibYmd(now).year;
      const year        = Number(req.query.year) || currentYear;

      const cutoff = year === currentYear ? wibEndOfDay(now) : wibYearEnd(year);

      const yearStart = wibYearStart(year);

      if (checkpointCode && !allowed.includes(checkpointCode)) {
        const err = new Error('Checkpoint tidak ditemukan');
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
        chart[wibMonthIndex(row.createdAt)]!.amount += row.amount ?? 0;
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
      const circleCode = circleScope(req);
      const checkpointCode = req.query.checkpointCode as string | undefined;

      const now         = new Date();
      const currentYear = wibYmd(now).year;
      const year        = Number(req.query.year) || currentYear;

      const cutoff = year === currentYear ? wibEndOfDay(now) : wibYearEnd(year);

      const yearStart = wibYearStart(year);

      if (checkpointCode && !allowed.includes(checkpointCode)) {
        const err = new Error('Checkpoint tidak ditemukan');
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
        chart[wibMonthIndex(row.createdAt)]!.amount += row.amount ?? 0;
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
      const circleCode = circleScope(req);

      const batch = await prisma.uploadBatch.findFirst({
        where: { id: Number(id), AND: [batchInScope(circleCode)] },
        include: { progress: { take: 1, orderBy: { createdAt: 'desc' } } }
      });

      if (!batch) {
        const err = new Error('Batch tidak ditemukan');
        (err as any).status = 404;
        throw err;
      }

      // Exact counts for the whole batch. The cards and numbers themselves are paged
      // through GET /batches/:id/items, so the page never works from a partial list.
      const [cards, unverified, numbers] = await Promise.all([
        prisma.card.count({ where: { batchCode: batch.code, checkpoint: checkpointInCircle(circleCode) } }),
        prisma.card.count({ where: { batchCode: batch.code, checkpoint: checkpointInCircle(circleCode), status: 'UNVERIFIED' } }),
        prisma.number.count({
          where: { batchCode: batch.code, OR: [{ checkpoint: checkpointInCircle(circleCode) }, { checkpointCode: null }] }
        })
      ]);

      res.status(200).json({
        message: 'Batch retrieved successfully',
        data: { batch, counts: { cards, unverified, verified: cards - unverified, numbers } }
      });
    } catch (error) {
      next(error);
    }
  }

  // GET /api/stock/batches/:id/items?type=cards|numbers&page&limit&search
  static async getBatchItems(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const { type = 'cards', page = 1, limit = 10, search } = req.query;
      const circleCode = circleScope(req);

      if (type !== 'cards' && type !== 'numbers') {
        const err = new Error("Parameter type harus 'cards' atau 'numbers'");
        (err as any).status = 422;
        throw err;
      }
      const take = Math.min(100, Math.max(1, Number(limit) || 10));
      const pageNumber = Math.max(1, Number(page) || 1);

      const batch = await prisma.uploadBatch.findFirst({
        where: { id: Number(id), AND: [batchInScope(circleCode)] },
        select: { code: true }
      });
      if (!batch) {
        const err = new Error('Batch tidak ditemukan');
        (err as any).status = 404;
        throw err;
      }

      const keyFilter = search ? { key: { contains: String(search) } } : {};

      if (type === 'cards') {
        const where = { batchCode: batch.code, checkpoint: checkpointInCircle(circleCode), ...keyFilter };
        const [items, total] = await Promise.all([
          prisma.card.findMany({
            where,
            skip: (pageNumber - 1) * take,
            take,
            orderBy: { id: 'desc' },
            select: { id: true, key: true, status: true, createdAt: true, validatedAt: true }
          }),
          prisma.card.count({ where })
        ]);
        res.status(200).json({
          message: 'Batch cards retrieved successfully',
          data: { items },
          pagination: { page: pageNumber, limit: take, total, pages: Math.ceil(total / take) }
        });
        return;
      }

      const where = {
        batchCode: batch.code,
        OR: [{ checkpoint: checkpointInCircle(circleCode) }, { checkpointCode: null }],
        ...keyFilter
      };
      const [items, total] = await Promise.all([
        prisma.number.findMany({
          where,
          skip: (pageNumber - 1) * take,
          take,
          orderBy: { id: 'desc' },
          select: { id: true, key: true, remark: true, batchCode: true, createdAt: true }
        }),
        prisma.number.count({ where })
      ]);
      res.status(200).json({
        message: 'Batch numbers retrieved successfully',
        data: { items },
        pagination: { page: pageNumber, limit: take, total, pages: Math.ceil(total / take) }
      });
    } catch (error) {
      next(error);
    }
  }

  static async getBatches(req: Request, res: Response, next: NextFunction) {
    try {
      const { page = 1, limit = 10, status, search } = req.query;
      const circleCode = circleScope(req);

      const allowedStatus = ['ONGOING', 'COMPLETED'];

      if (status && !allowedStatus.includes(status as string)) {
        const err = new Error('Status tidak valid');
        (err as any).status = 400;
        throw err;
      }

      // Shared with the Excel export so the file always matches the list
      const where: any = buildBatchWhere(req.query, circleCode);

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

      // The tiles describe the batches the list is showing (same search and status filter)
      const cardsInView = { checkpoint: checkpointInCircle(circleCode), uploadBatch: where };
      const [totalBatch, totalCards, totalVerified, totalUnverified] = await Promise.all([
        prisma.uploadBatch.count({ where }),
        prisma.card.count({ where: cardsInView }),
        prisma.card.count({ where: { ...cardsInView, status: 'VERIFIED' } }),
        prisma.card.count({ where: { ...cardsInView, status: 'UNVERIFIED' } })
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

      const batch = await prisma.$transaction(async (tx) => {
        const currentBatch = await tx.uploadBatch.findFirst({
          where: { id: Number(id), AND: [batchInScope(circleScope(req))] }
        });

        if (!currentBatch) {
          const err = new Error('Batch tidak ditemukan');
          (err as any).status = 404;
          throw err;
        }

        if (currentBatch.status === 'COMPLETED') {
          const err = new Error('Batch ini sudah selesai diverifikasi');
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

      const batch = await prisma.uploadBatch.findFirst({
        where: { id: Number(id), AND: [batchInScope(circleScope(req))] },
        include: {
          cards: {
            select: { key: true, id: true, status: true, checkpointCode: true }
          },
          numbers: { select: { key: true, id: true, status: true, checkpointCode: true } }
        }
      });

      if (!batch) {
        const err = new Error('Batch tidak ditemukan');
        (err as any).status = 404;
        throw err;
      }

      // Deleting removes everything in the batch, so all of it must belong to the caller's circle.
      // A batch that only carries MSISDNs is visible to everyone (numbers without a checkpoint are
      // shared stock) and is therefore not the caller's to delete; neither is one that holds cards
      // or numbers of another circle.
      // (A holder of the all-circles access owns every circle, so none of this applies to them.)
      // Codes are compared ignoring letter case, like the database does (a card may carry "Andalas07"
      // where the checkpoint is "ANDALAS07")
      const mine = new Set((req.checkpointCodes ?? []).map((c) => c.toUpperCase()));
      const isMine = (code: string | null) => !!code && mine.has(code.toUpperCase());
      if (!req.allCircles && batch.cards.length === 0) {
        const err = new Error('Batch yang tidak berisi ICCID tidak dapat dihapus karena tidak terkait dengan circle Anda');
        (err as any).status = 403;
        throw err;
      }
      const foreignCards = batch.cards.filter(c => !isMine(c.checkpointCode)).length;
      const foreignNumbers = batch.numbers.filter(n => n.checkpointCode && !isMine(n.checkpointCode)).length;
      if (!req.allCircles && (foreignCards > 0 || foreignNumbers > 0)) {
        const err = new Error(
          `Batch tidak dapat dihapus: ${foreignCards + foreignNumbers} item milik circle lain`
        );
        (err as any).status = 403;
        throw err;
      }

      if (batch.status === 'COMPLETED') {
        const err = new Error('Batch yang sudah selesai tidak dapat dihapus');
        (err as any).status = 400;
        throw err;
      }

      const allowedStatuses = ['VERIFIED', 'UNVERIFIED', 'BROKEN', 'LOST'];
      const invalidCards = batch.cards.filter(card => !allowedStatuses.includes(card.status));

      if (invalidCards.length > 0) {
        const invalidStatusList = [...new Set(invalidCards.map(c => c.status))].join(', ');
        const err = new Error(`Batch tidak dapat dihapus: ${invalidCards.length} kartu berstatus (${invalidStatusList}) sehingga tidak dapat dihapus`);
        (err as any).status = 400;
        throw err;
      }

      // A number that has already been sold is tied to a sale record and must not vanish with its batch
      const invalidNumbers = batch.numbers.filter(n => n.status === 'SOLD');
      if (invalidNumbers.length > 0) {
        const err = new Error(`Batch tidak dapat dihapus: ${invalidNumbers.length} nomor sudah terjual`);
        (err as any).status = 400;
        throw err;
      }

      const cardIds = batch.cards.map(c => c.id);
      const numberIds = batch.numbers.map(n => n.id);
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

        // A number's own movements go with it (they point at the number and would block the delete)
        for (const ids of chunkArray(numberIds)) {
          await tx.numberMovement.deleteMany({ where: { numberID: { in: ids } } });
        }
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
      const { page = 1, limit = 10 } = req.query;
      const circleCode = circleScope(req);

      // Shared with the Excel export so the file always matches the list
      const where: any = buildCardWhere(req.query, circleCode);

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
        throw new Error('User tidak ditemukan');
      }

      if (!file) {
        const err = new Error('Belum ada file yang diunggah');
        (err as any).status = 400;
        throw err;
      }

      // Parse Excel outside the transaction — CPU-bound work should not hold a DB connection
      const workbook = xlsx.read(file.buffer, { type: 'buffer' });

      if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
        const err = new Error('File Excel tidak memiliki sheet');
        (err as any).status = 422;
        throw err;
      }

      const firstWorksheet = workbook.Sheets[workbook.SheetNames[0]!];
      if (!firstWorksheet) {
        const err = new Error('Sheet tidak ditemukan');
        (err as any).status = 422;
        throw err;
      }

      const allowedSheets = ['ICCID', 'MSISDN'];
      const parsedSheets: { sheet: string; rows: any[] }[] = [];

      for (const sheet of workbook.SheetNames) {
        const sheetData = workbook.Sheets[sheet];
        if (!sheetData || !allowedSheets.includes(sheet)) continue;
        parsedSheets.push({ sheet, rows: sheetRows(sheetData) });
      }

      if (parsedSheets.length === 0) {
        const err = new Error(
          `File tidak memiliki sheet bernama ICCID atau MSISDN (ditemukan: ${workbook.SheetNames.join(', ')}). Unduh template dan pertahankan nama sheet-nya.`
        );
        (err as any).status = 422;
        throw err;
      }

      const { batchID } = req.body;
      const userCode = req.user.code;
      const allowed = req.checkpointCodes ?? [];

      // Prepare rows without batchCode; batchCode is injected inside the transaction.
      // Every row that is not imported is counted under a reason, so the person who uploaded
      // the file is told what happened to it instead of seeing a silent "success".
      //  - ICCID rows need a CHECKPOINT inside the user's circle (cards cannot exist without one).
      //  - MSISDN rows may omit CHECKPOINT (numbers are globally accessible), but a CHECKPOINT
      //    that is given must be one the user can use.
      // Checkpoint codes are matched ignoring letter case and stored exactly as the checkpoint
      // spells them, so "dc02" and "DC02" can never end up as two different codes.
      const canonicalCheckpoint = new Map(allowed.map(code => [code.toLowerCase(), code]));
      const skipReasons: Record<string, number> = {};
      const skipSamples: { sheet: string; row: number; key: string; reason: string }[] = [];
      const noteSkip = (sheet: string, row: number, key: string, reason: string) => {
        skipReasons[reason] = (skipReasons[reason] ?? 0) + 1;
        if (skipSamples.length < MAX_LISTED_ERRORS) skipSamples.push({ sheet, row, key, reason });
      };

      const preparedSheets = parsedSheets.map(({ sheet, rows }) => {
        const seen = new Set<string>();
        const data: { key: string; checkpointCode: string | null; remark: string; row: number }[] = [];

        rows.forEach((row: any, index: number) => {
          const rowNumber = index + 2; // the sheet's own row number (row 1 is the header)
          const cell = normalizeKeyCell(row.KEY ?? row.key);
          const shownKey = String(row.KEY ?? row.key ?? '').trim();

          if (cell.unreadable) return noteSkip(sheet, rowNumber, shownKey, 'unreadableKey');
          if (!cell.key || cell.key === 'undefined') return noteSkip(sheet, rowNumber, shownKey, 'emptyKey');

          const rawCheckpoint = String(row.CHECKPOINT ?? row.checkpoint ?? '').trim();
          const checkpointCode = rawCheckpoint ? canonicalCheckpoint.get(rawCheckpoint.toLowerCase()) : undefined;
          if (sheet === 'ICCID') {
            if (!rawCheckpoint) return noteSkip(sheet, rowNumber, cell.key, 'missingCheckpoint');
            if (!checkpointCode) return noteSkip(sheet, rowNumber, cell.key, 'checkpointNotAllowed');
          } else if (rawCheckpoint && !checkpointCode) {
            return noteSkip(sheet, rowNumber, cell.key, 'checkpointNotAllowed');
          }

          if (seen.has(cell.key)) return noteSkip(sheet, rowNumber, cell.key, 'duplicateInFile');
          seen.add(cell.key);

          data.push({
            key: cell.key,
            checkpointCode: checkpointCode ?? null,
            remark: String(row.REMARK ?? row.remark ?? '').trim(),
            row: rowNumber
          });
        });
        return { sheet, data, received: rows.length };
      });

      const CHUNK_SIZE = 500;
      const chunk = <T,>(arr: T[], size: number): T[][] => {
        const chunks: T[][] = [];
        for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
        return chunks;
      };

      // One timestamp for the whole upload, so a card's validatedAt, its INITIAL
      // movement and the stock snapshot all agree.
      const validatedAt = new Date();

      const { totalCreated, perSheet } = await prisma.$transaction(async (tx) => {
        let batch: { id: number; code: string };
        // Stock is written once per checkpoint, never once per card: CardStock is a
        // latest-row-wins snapshot, so N rows per checkpoint would leave the
        // intermediate arithmetic wrong. Scoped inside the transaction so a retry
        // starts from an empty tally rather than double-counting.
        const perCheckpoint = new Map<string, number>();

        if (batchID) {
          const existing = await tx.uploadBatch.findUnique({ where: { id: Number(batchID) } });
          if (!existing) {
            const err = new Error(`Batch ${batchID} tidak ditemukan`);
            (err as any).status = 404;
            throw err;
          }
          if (existing.status === 'COMPLETED') {
            const err = new Error(`Batch ${batchID} sudah selesai`);
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
          data: data.map(({ row: _row, ...rest }) => ({ ...rest, batchCode: batch.code }))
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
              const existingSet = new Set<string>();
              for (const keyChunk of chunk(keys, CHUNK_SIZE)) {
                const existing = await tx.card.findMany({ where: { key: { in: keyChunk } }, select: { key: true } });
                existing.forEach(c => existingSet.add(c.key));
              }
              const newRows = (data as any[]).filter((r: any) => !existingSet.has(r.key));
              const existingKeys = (data as any[]).filter((r: any) => existingSet.has(r.key)).map((r: any) => r.key);
              let count = 0;
              // Uploaded cards enter stock immediately — no separate validation step.
              // That means reproducing every side effect validateCard would have
              // written, or the dashboard's two stock figures drift apart:
              // initialStock counts cards, finalStock sums CardStock.
              for (const rowChunk of chunk(newRows, CHUNK_SIZE)) {
                const created = await tx.card.createMany({
                  data: rowChunk.map((r: any) => ({ ...r, status: 'VERIFIED', validatedAt: validatedAt }))
                });
                count += created.count;

                const inserted = await tx.card.findMany({
                  where: { key: { in: rowChunk.map((r: any) => r.key) } },
                  select: { id: true, checkpointCode: true }
                });
                await tx.cardMovement.createMany({
                  data: inserted.map(c => ({
                    cardID: c.id,
                    type: 'INITIAL',
                    userCode,
                    sourceCode: null,
                    targetCode: c.checkpointCode,
                    createdAt: validatedAt
                  }))
                });
                for (const c of inserted) {
                  perCheckpoint.set(c.checkpointCode, (perCheckpoint.get(c.checkpointCode) ?? 0) + 1);
                }
              }
              return { sheet, count, existingKeys };
            } else {
              const existingSet = new Set<string>();
              for (const keyChunk of chunk(keys, CHUNK_SIZE)) {
                const existing = await tx.number.findMany({ where: { key: { in: keyChunk } }, select: { key: true } });
                existing.forEach(n => existingSet.add(n.key));
              }
              const newRows = data.filter((r: any) => !existingSet.has(r.key));
              const existingKeys = data.filter((r: any) => existingSet.has(r.key)).map((r: any) => r.key);
              let count = 0;
              for (const rowChunk of chunk(newRows, CHUNK_SIZE)) {
                const created = await tx.number.createMany({ data: rowChunk });
                count += created.count;
              }
              return { sheet, count, existingKeys };
            }
          })
        );

        const totalCreated = result.reduce((sum, r) => sum + r.count, 0);

        const newCardsCount = result[jsonData.findIndex(s => s.sheet === 'ICCID')]?.count ?? 0;

        if (batchID) {
          await tx.uploadBatch.update({
            where: { id: batch.id },
            data: { total: { increment: newCardsCount } }
          });
        } else if (totalCreated === 0) {
          await tx.uploadBatch.delete({ where: { id: batch.id } });
        }

        if (totalCreated > 0) {
          // One aggregated snapshot per checkpoint, carried from that checkpoint's
          // most recent amount.
          for (const [checkpointCode, added] of perCheckpoint) {
            const latest = await tx.cardStock.findFirst({
              where: { checkpointCode },
              orderBy: { id: 'desc' }
            });
            await tx.cardStock.create({
              data: { checkpointCode, amount: Number(latest?.amount ?? 0) + added, createdAt: validatedAt }
            });
          }

          if (newCardsCount > 0) {
            const lastProgress = await tx.uploadBatchProgress.findFirst({
              where: { batchCode: batch.code },
              orderBy: { id: 'desc' }
            });
            await tx.uploadBatchProgress.create({
              data: {
                batchCode: batch.code,
                progress: (lastProgress?.progress ?? 0) + newCardsCount,
                createdAt: validatedAt
              }
            });
          }

          // Nothing is left to validate, so the batch is closed on arrival.
          await tx.uploadBatch.update({ where: { id: batch.id }, data: { status: 'COMPLETED' } });
        }

        return { totalCreated, perSheet: result };
      }, {
        timeout: Number(process.env.UPLOAD_TX_TIMEOUT_MS) || 120000,
        maxWait: Number(process.env.UPLOAD_TX_MAXWAIT_MS) || 10000
      });

      // Rows that were fine but already exist in the system are skipped too: tell the person
      const reasons: Record<string, number> = { ...skipReasons };
      const samples = [...skipSamples];
      let alreadyExists = 0;
      for (const { sheet, existingKeys } of perSheet) {
        alreadyExists += existingKeys.length;
        for (const key of existingKeys.slice(0, Math.max(0, MAX_LISTED_ERRORS - samples.length))) {
          const row = preparedSheets.find(p => p.sheet === sheet)?.data.find(d => d.key === key)?.row ?? 0;
          samples.push({ sheet, row, key, reason: 'alreadyExists' });
        }
      }
      if (alreadyExists > 0) reasons.alreadyExists = alreadyExists;

      const sheetSummary = (name: string) => {
        const prepared = preparedSheets.find(p => p.sheet === name);
        if (!prepared) return null;
        const created = perSheet.find(r => r.sheet === name)?.count ?? 0;
        return { received: prepared.received, created, skipped: prepared.received - created };
      };
      const received = preparedSheets.reduce((sum, p) => sum + p.received, 0);

      res.status(200).json({
        message: 'Upload completed successfully',
        data: {
          total: received,
          created: totalCreated,
          skipped: received - totalCreated,
          iccid: sheetSummary('ICCID'),
          msisdn: sheetSummary('MSISDN'),
          reasons,
          samples,
          ignoredSheets: workbook.SheetNames.filter(name => !allowedSheets.includes(name))
        }
      });
    } catch (error) {
      next(error);
    }
  }

  static async uploadSoldExcel(req: Request, res: Response, next: NextFunction) {
    try {
      const file = (req as any).file;

      if (!file) {
        const err = new Error('Belum ada file yang diunggah');
        (err as any).status = 400;
        throw err;
      }

      const workbook = xlsx.read(file.buffer, { type: 'buffer' });
      const sheet = workbook.Sheets[workbook.SheetNames[0]!];
      if (!sheet) {
        const err = new Error('File Excel tidak memiliki sheet');
        (err as any).status = 422;
        throw err;
      }

      const rows: any[] = sheetRows(sheet);

      // Notes for cards sold from a different location than they are held at: { [iccid]: text }.
      // Sent as a multipart text field by the "Perlu catatan" step; only rows that need one use it.
      const notes = new Map<string, string>();
      const rawNotes = (req as any).body?.notes;
      if (rawNotes !== undefined && rawNotes !== '') {
        let parsedNotes: unknown;
        try {
          parsedNotes = JSON.parse(String(rawNotes));
        } catch {
          const err = new Error('Format catatan tidak valid: harus berupa objek JSON { ICCID: catatan }');
          (err as any).status = 422;
          throw err;
        }
        if (!parsedNotes || typeof parsedNotes !== 'object' || Array.isArray(parsedNotes)) {
          const err = new Error('Format catatan tidak valid: harus berupa objek JSON { ICCID: catatan }');
          (err as any).status = 422;
          throw err;
        }
        for (const [iccid, value] of Object.entries(parsedNotes as Record<string, unknown>)) {
          const text = typeof value === 'string' ? value.trim() : '';
          if (text.length > MAX_NOTE_LENGTH) {
            const err = new Error(`Catatan untuk ICCID ${iccid} lebih dari ${MAX_NOTE_LENGTH} karakter`);
            (err as any).status = 422;
            throw err;
          }
          if (text) notes.set(iccid, text);
        }
      }

      type SoldRow = { row: number; iccid: string; msisdn: string; storeCode: string; trn: string | null };
      const parsed: SoldRow[] = [];
      const unreadableIccid: RowIssue[] = [];
      const duplicateInFile: RowIssue[] = [];
      const seen = new Map<string, number>();
      for (const [index, r] of rows.entries()) {
        // +2: one for the header row, one because spreadsheets count from 1.
        const row = index + 2;
        const iccidCell  = normalizeKeyCell(r.ICCID  ?? r.iccid);
        const msisdnCell = normalizeKeyCell(r.MSISDN ?? r.msisdn);
        const storeCode  = String(r.STORE_CODE ?? r.store_code ?? '').trim();
        const trn        = String(r.TRN ?? r.trn ?? '').trim();
        if (iccidCell.unreadable) {
          unreadableIccid.push({ row, iccid: iccidCell.key, storeCode,
            detail: 'Excel menyimpan ICCID ini sebagai angka, sehingga digitnya sudah berubah' });
          continue;
        }
        const iccid = iccidCell.key;
        if (!iccid) continue;
        const firstRow = seen.get(iccid);
        if (firstRow) {
          duplicateInFile.push({ row, iccid, storeCode, detail: `ICCID yang sama sudah ada di baris ${firstRow}` });
          continue;
        }
        seen.set(iccid, row);
        parsed.push({ row, iccid, msisdn: msisdnCell.key, storeCode, trn: trn || null });
      }

      if (parsed.length === 0 && unreadableIccid.length === 0) {
        const err = new Error('Tidak ada nomor ICCID di dalam file');
        (err as any).status = 422;
        throw err;
      }

      if (!req.user) {
        const err = new Error('User tidak ditemukan');
        (err as any).status = 401;
        throw err;
      }
      const userCode = req.user.code;
      const allowed  = req.checkpointCodes ?? [];

      const iccids  = parsed.map(r => r.iccid);
      const msisdns = [...new Set(parsed.map(r => r.msisdn).filter(Boolean))];

      // Merges are looked up by both keys: cardKey decides verify-vs-create, numberKey
      // catches an MSISDN already bound to a different card (Merge.numberKey is @unique).
      const [merges, mergesByNumber, cards, numbers] = await Promise.all([
        fetchChunked(iccids, batch => prisma.merge.findMany({
          where: { cardKey: { in: batch } },
          select: { cardKey: true, numberKey: true, checkpointCode: true, soldAt: true, verifiedAt: true }
        })),
        fetchChunked(msisdns, batch => prisma.merge.findMany({
          where: { numberKey: { in: batch } },
          select: { numberKey: true, cardKey: true }
        })),
        fetchChunked(iccids, batch => prisma.card.findMany({
          where: { key: { in: batch } },
          select: { id: true, key: true, status: true, validatedAt: true, checkpointCode: true }
        })),
        fetchChunked(msisdns, batch => prisma.number.findMany({
          where: { key: { in: batch } },
          select: { key: true, status: true }
        }))
      ]);

      const mergeMap       = new Map(merges.map(m => [m.cardKey, m]));
      const mergeNumberMap = new Map(mergesByNumber.map(m => [m.numberKey, m]));
      const cardMap        = new Map(cards.map(c => [c.key, c]));
      const numberMap      = new Map(numbers.map(n => [n.key, n]));

      // A row may leave MSISDN blank, in which case the merge's own numberKey was never
      // in the fetch above — without this the verify path reports a bogus "number not SOLD".
      const unfetchedNumberKeys = [...new Set(
        merges.map(m => m.numberKey).filter(k => !numberMap.has(k))
      )];
      if (unfetchedNumberKeys.length > 0) {
        const extra = await fetchChunked(unfetchedNumberKeys, batch => prisma.number.findMany({
          where: { key: { in: batch } },
          select: { key: true, status: true }
        }));
        extra.forEach(n => numberMap.set(n.key, n));
      }

      // Verify path (merge already exists)
      const storeNotAccessible: RowIssue[] = [];
      const mismatched: RowIssue[]         = [];
      const checkpointMismatch: RowIssue[] = [];
      const noSoldAt: RowIssue[]           = [];
      const notSoldStatus: RowIssue[]      = [];
      const numberNotSold: RowIssue[]      = [];
      const neverValidated: RowIssue[]     = [];

      // Create path (no merge yet)
      const cardNotFound: RowIssue[]          = [];
      const cardNotVerified: RowIssue[]       = [];
      const cardCheckpointMismatch: RowIssue[] = [];
      const storeCodeMissing: RowIssue[]      = [];
      const msisdnMissing: RowIssue[]         = [];
      const numberAlreadySold: RowIssue[]     = [];
      const numberBoundToOtherCard: RowIssue[] = [];
      const duplicateMsisdn: RowIssue[]       = [];

      // holderCode: where the card physically is (stock leaves from here); storeCode: where it was sold.
      type CreateRow = SoldRow & { cardID: number; holderCode: string; remark: string | null };
      const toCreate: CreateRow[] = [];
      const toVerify: string[] = [];
      const msisdnSeen = new Map<string, string>();

      for (const row of parsed) {
        const merge = mergeMap.get(row.iccid);
        const card  = cardMap.get(row.iccid);

        // STORE_CODE, when present, must be inside the caller's accessible checkpoints
        const issue = { row: row.row, iccid: row.iccid, msisdn: row.msisdn, storeCode: row.storeCode };

        if (row.storeCode && !hasCheckpointAccess(row.storeCode, allowed)) {
          storeNotAccessible.push({ ...issue, detail: `toko ${row.storeCode} bukan checkpoint yang dapat Anda akses` });
          continue;
        }

        if (merge) {
          // ---- Verify path: unchanged reconciliation rules ----
          if (row.msisdn && merge.numberKey !== row.msisdn) {
            mismatched.push({ ...issue, detail: `ICCID ini dipasangkan dengan ${merge.numberKey}, bukan ${row.msisdn}` });
            continue;
          }
          if (row.storeCode && merge.checkpointCode !== row.storeCode) {
            checkpointMismatch.push({ ...issue, detail: `penjualan tercatat di ${merge.checkpointCode ?? 'lokasi tidak diketahui'}, bukan ${row.storeCode}` });
            continue;
          }
          if (!merge.soldAt) {
            noSoldAt.push({ ...issue, detail: 'data penjualan tidak punya tanggal' }); continue;
          }
          if (!card || card.status !== 'SOLD') {
            notSoldStatus.push({ ...issue, detail: `status kartu ${card?.status ?? 'tidak diketahui'}, seharusnya SOLD` }); continue;
          }

          const number = numberMap.get(merge.numberKey);
          if (!number || number.status !== 'SOLD') {
            numberNotSold.push({ ...issue, detail: `status MSISDN ${merge.numberKey} ${number?.status ?? 'tidak ditemukan'}, seharusnya SOLD` });
            continue;
          }
          if (!card.validatedAt) {
            neverValidated.push({ ...issue, detail: 'kartu belum pernah diverifikasi ke dalam stok' }); continue;
          }

          toVerify.push(row.iccid);
          continue;
        }

        // ---- Create path: the sale has not been recorded yet ----

        // Cards are never auto-created: the physical card must already be in stock.
        if (!card) {
          cardNotFound.push({ ...issue, detail: 'ICCID ini tidak ada di sistem' }); continue;
        }
        if (card.status !== 'VERIFIED') {
          cardNotVerified.push({ ...issue, detail: `status kartu ${card.status}; harus VERIFIED sebelum dapat dijual` });
          continue;
        }
        if (!card.validatedAt) {
          neverValidated.push({ ...issue, detail: 'kartu belum pernah diverifikasi ke dalam stok' }); continue;
        }
        if (!row.storeCode) {
          storeCodeMissing.push({ ...issue, detail: 'STORE_CODE kosong' }); continue;
        }
        // Sold somewhere other than where the card is held: allowed only with a note for that card.
        const crossLocation = card.checkpointCode !== row.storeCode;
        if (crossLocation) {
          if (!hasCheckpointAccess(card.checkpointCode, allowed)) {
            storeNotAccessible.push({ ...issue, detail: `kartu berada di ${card.checkpointCode}, yang bukan checkpoint yang dapat Anda akses` });
            continue;
          }
          if (!notes.has(row.iccid)) {
            cardCheckpointMismatch.push({ ...issue, fromCode: card.checkpointCode, detail: `kartu saat ini berada di ${card.checkpointCode}, bukan ${row.storeCode}; tambahkan catatan untuk menjualnya dari ${row.storeCode}` });
            continue;
          }
        }
        if (!row.msisdn) {
          msisdnMissing.push({ ...issue, detail: 'MSISDN kosong' }); continue;
        }

        const firstUse = msisdnSeen.get(row.msisdn);
        if (firstUse) {
          duplicateMsisdn.push({ ...issue, detail: `MSISDN ${row.msisdn} sudah dipakai oleh ICCID ${firstUse}` });
          continue;
        }

        const boundMerge = mergeNumberMap.get(row.msisdn);
        if (boundMerge) {
          numberBoundToOtherCard.push({ ...issue, detail: `MSISDN ${row.msisdn} sudah dipasangkan dengan ${boundMerge.cardKey}` });
          continue;
        }

        // Numbers, unlike cards, are auto-created when absent.
        const number = numberMap.get(row.msisdn);
        if (number && number.status === 'SOLD') {
          numberAlreadySold.push({ ...issue, detail: `MSISDN ${row.msisdn} sudah berstatus SOLD` }); continue;
        }

        msisdnSeen.set(row.msisdn, row.iccid);
        toCreate.push({ ...row, cardID: card.id, holderCode: card.checkpointCode, remark: crossLocation ? notes.get(row.iccid)! : null });
      }

      // Stock is drawn down once per checkpoint rather than once per card.
      const perCheckpoint = new Map<string, number>();
      for (const row of toCreate) {
        perCheckpoint.set(row.holderCode, (perCheckpoint.get(row.holderCode) ?? 0) + 1);
      }

      const insufficientStock: RowIssue[] = [];
      const stockPlan: { checkpointCode: string; nextAmount: number }[] = [];
      // Anchor each stock shortfall to the first row for that store, so the message
      // still points somewhere findable in the sheet.
      const firstRowForStore = new Map<string, CreateRow>();
      for (const r of toCreate) if (!firstRowForStore.has(r.holderCode)) firstRowForStore.set(r.holderCode, r);

      if (perCheckpoint.size > 0) {
        const snapshots = await Promise.all(
          [...perCheckpoint.keys()].map(code =>
            prisma.cardStock.findFirst({ where: { checkpointCode: code }, orderBy: { createdAt: 'desc' } })
              .then(stock => ({ code, amount: Number(stock?.amount ?? 0) }))
          )
        );
        for (const { code, amount } of snapshots) {
          const needed = perCheckpoint.get(code)!;
          if (amount < needed) {
            const anchor = firstRowForStore.get(code);
            insufficientStock.push({
              row: anchor?.row ?? 0,
              iccid: anchor?.iccid ?? '',
              storeCode: code,
              detail: `${code} punya ${amount} kartu di stok, tetapi file ini menjual ${needed} kartu darinya`
            });
          } else {
            stockPlan.push({ checkpointCode: code, nextAmount: amount - needed });
          }
        }
      }

      // Each bucket states the problem and the fix, so the person who uploaded the file
      // can correct it and retry without needing anyone to interpret the response.
      const buckets: { code: string; label: string; action: string; items: RowIssue[] }[] = [
        { code: 'unreadableIccid', label: 'ICCID disimpan Excel sebagai angka',
          action: 'Ubah format kolom ICCID menjadi Teks, ketik ulang ICCID tersebut, lalu ekspor lagi.',
          items: unreadableIccid },
        { code: 'duplicateIccid', label: 'ICCID yang sama muncul lebih dari sekali',
          action: 'Hapus baris duplikat, sisakan satu baris per ICCID.',
          items: duplicateInFile },
        { code: 'cardNotFound', label: 'ICCID tidak ada di sistem',
          action: 'Periksa kembali ICCID (mungkin salah ketik), atau unggah batch stoknya terlebih dahulu.',
          items: cardNotFound },
        { code: 'storeNotAccessible', label: 'STORE_CODE bukan toko yang dapat Anda akses',
          action: 'Ganti STORE_CODE dengan toko di circle Anda.',
          items: storeNotAccessible },
        { code: 'storeCodeMissing', label: 'STORE_CODE kosong',
          action: 'Isi toko tempat kartu dijual.',
          items: storeCodeMissing },
        { code: 'msisdnMissing', label: 'MSISDN kosong',
          action: 'Isi MSISDN yang terjual bersama ICCID ini.',
          items: msisdnMissing },
        { code: 'cardNotVerified', label: 'Kartu belum diverifikasi ke dalam stok',
          action: 'Verifikasi kartu di checkpoint-nya, lalu unggah lagi.',
          items: cardNotVerified },
        { code: 'neverValidated', label: 'Kartu belum pernah diverifikasi secara fisik',
          action: 'Verifikasi kartu di checkpoint-nya, lalu unggah lagi.',
          items: neverValidated },
        { code: 'cardCheckpointMismatch', label: 'Kartu masih berada di lokasi yang berbeda',
          action: 'Tambahkan catatan untuk setiap kartu ini agar dijual dari lokasi kartu berada, atau ubah STORE_CODE sesuai lokasi kartu sebenarnya.',
          items: cardCheckpointMismatch },
        { code: 'duplicateMsisdn', label: 'MSISDN yang sama dipakai di lebih dari satu baris',
          action: 'Satu MSISDN hanya dapat dijual sekali — hapus atau perbaiki baris duplikatnya.',
          items: duplicateMsisdn },
        { code: 'numberBoundToOtherCard', label: 'MSISDN sudah dipasangkan dengan ICCID lain',
          action: 'Periksa ICCID pemilik MSISDN ini, lalu perbaiki barisnya.',
          items: numberBoundToOtherCard },
        { code: 'numberAlreadySold', label: 'MSISDN sudah terjual',
          action: 'Nomor ini sudah terjual sebelumnya — hapus barisnya atau perbaiki MSISDN.',
          items: numberAlreadySold },
        { code: 'insufficientStock', label: 'Stok di toko tidak mencukupi',
          action: 'Toko tidak memiliki cukup kartu untuk penjualan ini — periksa jumlah stoknya.',
          items: insufficientStock },
        { code: 'msisdnMismatch', label: 'MSISDN tidak sesuai dengan penjualan yang tercatat',
          action: 'Ganti MSISDN sesuai yang tercatat untuk ICCID ini.',
          items: mismatched },
        { code: 'storeMismatch', label: 'STORE_CODE tidak sesuai dengan penjualan yang tercatat',
          action: 'Ganti STORE_CODE dengan toko tempat penjualan tercatat.',
          items: checkpointMismatch },
        { code: 'soldAtMissing', label: 'Penjualan yang tercatat tidak punya tanggal',
          action: 'Hubungi tim support — data penjualan ini tidak lengkap.',
          items: noSoldAt },
        { code: 'cardNotSold', label: 'Status kartu bukan SOLD',
          action: 'Hubungi tim support — data penjualan dan kartu tidak sama.',
          items: notSoldStatus },
        { code: 'numberNotSold', label: 'Status nomor bukan SOLD',
          action: 'Hubungi tim support — data penjualan dan nomor tidak sama.',
          items: numberNotSold }
      ];

      const failed = buckets.filter(b => b.items.length > 0);

      // All-or-nothing: one bad row rejects the file and nothing is written.
      if (failed.length > 0) {
        const failedRows = failed.reduce((sum, b) => sum + b.items.length, 0);
        const readyRows  = parsed.length - failedRows + duplicateInFile.length;
        const biggest    = failed.reduce((a, b) => (b.items.length > a.items.length ? b : a));

        // The message is written to stand on its own, so an existing client that only
        // renders `message` still shows the user what to fix and where.
        const EXAMPLES_PER_ISSUE = 3;
        const n = (v: number) => v.toLocaleString('id-ID');

        const sections = failed.map((b, i) => {
          const examples = b.items.slice(0, EXAMPLES_PER_ISSUE).map(it => {
            const where = it.row > 0 ? `baris ${it.row}` : 'file';
            const what  = it.iccid ? ` (ICCID ${it.iccid})` : '';
            return `     - ${where}${what}: ${it.detail ?? b.label}`;
          });
          const rest = b.items.length - examples.length;
          if (rest > 0) examples.push(`     - ...dan ${n(rest)} baris lain dengan masalah ini`);
          return `${i + 1}. ${b.label} - ${n(b.items.length)} baris\n` +
                 `   Cara memperbaiki: ${b.action}\n` +
                 `   Contoh:\n${examples.join('\n')}`;
        });

        const err = new Error(
          `Upload ditolak. ${n(failedRows)} dari ${n(rows.length)} baris tidak dapat diproses, ` +
          `jadi tidak ada data yang disimpan dan tidak ada kartu yang berubah.\n` +
          (readyRows > 0
            ? `${n(readyRows)} baris sudah benar dan akan diproses setelah masalah di bawah ini diperbaiki.\n`
            : '') +
          `\nMasalah yang ditemukan:\n\n${sections.join('\n\n')}\n\n` +
          `Perbaiki baris-baris ini di file Excel, lalu unggah lagi. ` +
          `Seluruh file diproses bersamaan, jadi semua masalah harus diperbaiki sebelum penjualan dicatat.`
        );
        (err as any).status = 422;
        (err as any).details = {
          totalRows: rows.length,
          checkedRows: parsed.length,
          failedRows,
          readyRows: Math.max(0, readyRows),
          errors: Object.fromEntries(
            failed.map(b => [
              b.code,
              {
                label: b.label,
                action: b.action,
                ...errorBucket(b.items),
                // Cross-location sales: EVERY affected card (not capped), grouped by where the card is
                // and where the file says it was sold, so the client can collect a note per card.
                ...(b.code === 'cardCheckpointMismatch' ? { groups: groupByRoute(b.items) } : {})
              }
            ])
          )
        };
        throw err;
      }

      const newNumbers = toCreate.filter(r => !numberMap.has(r.msisdn));

      const result = await prisma.$transaction(async (tx) => {
        const soldAt = new Date();
        let batchCode: string | null = null;

        if (toCreate.length > 0) {
          if (newNumbers.length > 0) {
            const stamp = soldAt.toISOString().slice(0, 10).replace(/-/g, '');
            batchCode = `AUTOSOLD-${stamp}-${Date.now().toString(36).toUpperCase()}`;
            await tx.uploadBatch.create({
              data: { code: batchCode, userCode, status: 'COMPLETED', total: newNumbers.length,
                      note: 'Auto-created from sold Excel upload' }
            });

            for (const batch of chunkArray(newNumbers)) {
              await tx.number.createMany({
                data: batch.map(r => ({
                  key: r.msisdn,
                  checkpointCode: r.storeCode,
                  status: 'VERIFIED',
                  batchCode: batchCode!,
                  remark: 'AUTO_CREATED_FROM_SOLD_UPLOAD'
                }))
              });
            }
          }

          const createMsisdns = toCreate.map(r => r.msisdn);
          const createIccids  = toCreate.map(r => r.iccid);

          for (const batch of chunkArray(createMsisdns)) {
            await tx.number.updateMany({ where: { key: { in: batch } }, data: { status: 'SOLD' } });
          }
          for (const batch of chunkArray(createIccids)) {
            await tx.card.updateMany({ where: { key: { in: batch } }, data: { status: 'SOLD' } });
          }

          for (const batch of chunkArray(toCreate)) {
            await tx.cardMovement.createMany({
              data: batch.map(r => ({
                cardID: r.cardID,
                type: 'SALE',
                userCode,
                sourceCode: r.holderCode,
                targetCode: null
              }))
            });
          }

          for (const { checkpointCode, nextAmount } of stockPlan) {
            await tx.cardStock.create({ data: { checkpointCode, amount: nextAmount } });
          }

          for (const batch of chunkArray(toCreate)) {
            await tx.merge.createMany({
              data: batch.map(r => ({
                cardKey: r.iccid,
                numberKey: r.msisdn,
                checkpointCode: r.storeCode,
                remark: r.remark,
                anomalyNote: r.remark || null,
                anomalyAt: r.remark ? soldAt : null,
                anomalyByCode: r.remark ? userCode : null,
                userCode,
                TRN: r.trn,
                soldAt,
                verifiedAt: soldAt
              }))
            });
          }
        }

        let verified = 0;
        const pending = toVerify.filter(k => mergeMap.get(k)!.verifiedAt === null);
        for (const batch of chunkArray(pending)) {
          const updated = await tx.merge.updateMany({
            where: { cardKey: { in: batch } },
            data: { verifiedAt: soldAt }
          });
          verified += updated.count;
        }

        return { verified, batchCode };
      }, {
        timeout: Number(process.env.UPLOAD_TX_TIMEOUT_MS) || 120000,
        maxWait: Number(process.env.UPLOAD_TX_MAXWAIT_MS) || 10000
      });

      res.status(200).json({
        message: 'Sold cards processed successfully',
        data: {
          total: parsed.length,
          merged: toCreate.length,
          verified: result.verified,
          skipped: toVerify.length - result.verified,
          numbersCreated: newNumbers.length,
          batchCode: result.batchCode
        }
      });
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
          throw new Error('User tidak ditemukan');
        }

        const validTargetStatuses = ['VERIFIED', 'BROKEN'];
        if (!rawStatus || !validTargetStatuses.includes(rawStatus)) {
          const err = new Error("Status harus 'VERIFIED' atau 'BROKEN'");
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
          const err = new Error('Kartu tidak ditemukan');
          (err as any).status = 404;
          throw err;
        }

        const allowed = req.checkpointCodes ?? [];
        if (!hasCheckpointAccess(card.checkpointCode, allowed)) {
          const err = new Error('Kartu tidak ditemukan');
          (err as any).status = 404;
          throw err;
        }

        if (!card.uploadBatch) {
          const err = new Error('Batch upload kartu tidak ditemukan');
          (err as any).status = 404;
          throw err;
        }

        if (card.uploadBatch.status === "COMPLETED") {
          const err = new Error('Batch upload kartu ini sudah selesai');
          (err as any).status = 409;
          throw err;
        }

        if (card.status === 'OPNAME') {
          const err = new Error('Kartu sedang dalam sesi stok opname dan tidak dapat diubah');
          (err as any).status = 409;
          throw err;
        }

        if (card.status === 'DELIVERY') {
          const err = new Error('Kartu sedang dalam pengiriman dan tidak dapat diubah');
          (err as any).status = 409;
          throw err;
        }

        if (card.status === 'SOLD') {
          const err = new Error('Kartu sudah terjual');
          (err as any).status = 409;
          throw err;
        }

        if (card.status !== 'UNVERIFIED') {
          const err = new Error('Kartu sudah diverifikasi');
          (err as any).status = 409;
          throw err;
        }

        // Only an UNVERIFIED card gets here (every other status was refused above), so this is
        // always its first validation: it counts toward the batch progress, and a card that is
        // marked good also enters stock for the first time (INITIAL movement, +1 stock).
        updateData.validatedAt = new Date();

        const updatedCard = await tx.card.update({
          where: { key: key as string },
          data: updateData
        });

        const lastProgress = await tx.uploadBatchProgress.findFirst({
          where: { batchCode: card.uploadBatch.code },
          orderBy: { createdAt: 'desc' }
        });
        await tx.uploadBatchProgress.create({
          data: {
            batchCode: card.uploadBatch.code,
            progress: (lastProgress?.progress || 0) + 1
          }
        });

        if (nextStatus === "VERIFIED") {
          const stock = await tx.cardStock.findFirst({
            where: { checkpointCode: card.checkpointCode },
            orderBy: { createdAt: 'desc' }
          });
          await Promise.all([
            tx.cardMovement.create({
              data: {
                cardID: card.id,
                type: "INITIAL",
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
          ]);
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
      const { page = 1, limit = 10, checkpointCode, sort } = req.query;
      const circleCode = circleScope(req);

      // Shared with the Excel export so the file always matches the list
      const where: any = buildNumberWhere(req.query, circleCode);
      const onlyCode = csvParam(checkpointCode, 'checkpointCode');
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
          { checkpoint: checkpointInCircle(circleCode, onlyCode.length === 1 ? onlyCode[0] : undefined) },
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
            createdAt: { gte: wibMonthStart() }
          }
        }),
        prisma.merge.count({
          where: {
            ...mergeAmountWhere,
            createdAt: { gte: wibToday() }
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

  // Sales per place for the Penjualan > Riwayat tab: every place in the caller's circle with
  // how many sales it has in the date range, most sold first, one page at a time.
  static async getSalesByCheckpoint(req: Request, res: Response, next: NextFunction) {
    try {
      const { page = 1, limit = 20 } = req.query;
      const circleCode = circleScope(req);
      const take = Math.min(100, Math.max(1, Number(limit) || 20));
      const pageNumber = Math.max(1, Number(page) || 1);

      // Shared with the Excel export
      const ranked = await rankSalesByPlace(req.query, circleCode);

      const total = ranked.length;
      const items = ranked.slice((pageNumber - 1) * take, pageNumber * take);

      res.status(200).json({
        message: 'Sales by checkpoint retrieved successfully',
        data: {
          items,
          summary: {
            totalSold: ranked.reduce((sum, r) => sum + r.sold, 0),
            activePlaces: ranked.filter(r => r.sold > 0).length,
            totalPlaces: total
          }
        },
        pagination: { page: pageNumber, limit: take, total, pages: Math.ceil(total / take) }
      });
    } catch (error) {
      next(error);
    }
  }

  static async getMerges(req: Request, res: Response, next: NextFunction) {
    try {
      const { page = 1, limit = 10, checkpointCode, startSoldAt, endSoldAt, cardRemark, search, type, anomaly, keys } = req.query;
      const circleCode = circleScope(req);

      let where: any = {
        checkpoint: checkpointInCircle(circleCode, checkpointCode as string | undefined)
      };
      if (startSoldAt) {
        where.createdAt = {
          gte: wibStartOfDay(String(startSoldAt))
        }
      }
      if (endSoldAt) {
        where.createdAt = {
          ...where.createdAt,
          lte: wibEndOfDay(String(endSoldAt))
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
      if (anomaly === 'true') where.anomalyAt = { not: null };
      const keyList = csvParam(keys, 'keys');
      if (keyList.length) {
        where.AND = [...(where.AND ?? []), { OR: [{ cardKey: { in: keyList } }, { numberKey: { in: keyList } }] }];
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
      const monthStart = wibMonthStart();
      const dayStart = wibToday();

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
          merges: merges.map((merge: any) => ({
            ...merge,
            status: merge.verifiedAt ? 'Teraktivasi' : 'Menunggu Aktivasi',
            isAnomaly: !!merge.anomalyAt
          })),
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

  static async getMerge(req: Request, res: Response, next: NextFunction) {
    try {
      const id = Number(req.params.id);
      const circleCode = circleScope(req);
      const isSimcardQuery = req.query.type === 'SIMCARD' || !req.query.type;

      const merge: any = isSimcardQuery
        ? await prisma.merge.findFirst({
            where: { id, checkpoint: checkpointInCircle(circleCode) },
            include: {
              number: true,
              card: true,
              checkpoint: { select: { code: true, name: true, type: true } },
              user: { select: { code: true, name: true } }
            }
          })
        : await prisma.mergeAdditional.findFirst({
            where: { id, checkpoint: checkpointInCircle(circleCode) },
            include: {
              checkpoint: { select: { code: true, name: true, type: true } },
              user: { select: { code: true, name: true } }
            }
          });
      if (!merge) {
        const err = new Error('Penjualan tidak ditemukan');
        (err as any).status = 404;
        throw err;
      }

      res.status(200).json({
        message: 'Merge retrieved successfully',
        data: {
          merge: {
            ...merge,
            status: merge.verifiedAt ? 'Teraktivasi' : 'Menunggu Aktivasi',
            isAnomaly: !!merge.anomalyAt
          }
        }
      });
    } catch (error) {
      next(error);
    }
  }

  static async getSalesReport(req: Request, res: Response, next: NextFunction) {
    try {
      const { startSoldAt, endSoldAt } = req.query;
      const gte = startSoldAt ? wibStartOfDay(String(startSoldAt)) : wibMonthStart();
      const lte = endSoldAt ? wibEndOfDay(String(endSoldAt)) : undefined;
      if (startSoldAt && endSoldAt) {
        const days = (Number(lte) - Number(gte)) / (24 * 60 * 60 * 1000);
        if (days > 31) {
          const err = new Error('Rentang tanggal maksimal 31 hari');
          (err as any).status = 400;
          throw err;
        }
      }

      const periodWhere: any = { userCode: req.user!.code, createdAt: { gte, ...(lte && { lte }) } };
      const anomalyWhere = { ...periodWhere, anomalyAt: { not: null } };

      const [cards, others, cardAnomalies, otherAnomalies, cardTotal, cardMonthly, cardDaily, otherTotal, otherMonthly, otherDaily] =
        await Promise.all([
          prisma.merge.groupBy({ by: ['checkpointCode'], where: periodWhere, _count: { _all: true } }),
          prisma.mergeAdditional.groupBy({ by: ['checkpointCode'], where: periodWhere, _count: { _all: true } }),
          prisma.merge.groupBy({ by: ['checkpointCode'], where: anomalyWhere, _count: { _all: true } }),
          prisma.mergeAdditional.groupBy({ by: ['checkpointCode'], where: anomalyWhere, _count: { _all: true } }),
          prisma.merge.count({ where: { userCode: req.user!.code } }),
          prisma.merge.count({ where: { userCode: req.user!.code, createdAt: { gte: wibMonthStart() } } }),
          prisma.merge.count({ where: { userCode: req.user!.code, createdAt: { gte: wibToday() } } }),
          prisma.mergeAdditional.count({ where: { userCode: req.user!.code } }),
          prisma.mergeAdditional.count({ where: { userCode: req.user!.code, createdAt: { gte: wibMonthStart() } } }),
          prisma.mergeAdditional.count({ where: { userCode: req.user!.code, createdAt: { gte: wibToday() } } })
        ]);

      const perStore = new Map<string | null, { cardCount: number; otherCount: number; anomalyCount: number }>();
      const bump = (code: string | null, field: 'cardCount' | 'otherCount' | 'anomalyCount', count: number) => {
        const row = perStore.get(code) ?? { cardCount: 0, otherCount: 0, anomalyCount: 0 };
        row[field] += count;
        perStore.set(code, row);
      };
      for (const g of cards) bump(g.checkpointCode, 'cardCount', g._count._all);
      for (const g of others) bump(g.checkpointCode, 'otherCount', g._count._all);
      for (const g of cardAnomalies) bump(g.checkpointCode, 'anomalyCount', g._count._all);
      for (const g of otherAnomalies) bump(g.checkpointCode, 'anomalyCount', g._count._all);

      const codes = [...perStore.keys()].filter((code): code is string => !!code);
      const checkpoints = await prisma.checkpoint.findMany({
        where: { code: { in: codes } },
        select: { code: true, name: true, type: true }
      });
      const byCode = new Map(checkpoints.map((c) => [c.code, c]));

      const stores = [...perStore.entries()]
        .map(([code, counts]) => ({
          checkpointCode: code ?? '',
          name: code ? (byCode.get(code)?.name ?? '') : '',
          type: code ? (byCode.get(code)?.type ?? '') : '',
          ...counts
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

      res.status(200).json({
        message: 'Sales report retrieved successfully',
        data: {
          stores,
          amount: {
            cards: { total: cardTotal, monthly: cardMonthly, daily: cardDaily },
            others: { total: otherTotal, monthly: otherMonthly, daily: otherDaily }
          }
        }
      });
    } catch (error) {
      next(error);
    }
  }
}

export default StockController