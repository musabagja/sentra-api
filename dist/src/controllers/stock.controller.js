"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const prisma_1 = __importDefault(require("../../lib/prisma"));
const xlsx = __importStar(require("xlsx"));
const access_util_1 = require("../utils/access.util");
// Excel hands back numeric cells as JS doubles. An ICCID is 19-20 digits, well past
// Number.MAX_SAFE_INTEGER (~9.0e15), so an ICCID column that was not formatted as Text
// arrives silently rounded and never matches the string keys stored in the DB.
// Reading with raw:false makes SheetJS return each cell's displayed text instead.
const sheetRows = (sheet) => xlsx.utils.sheet_to_json(sheet, { raw: false, defval: '' });
// Values Excel already destroyed before we ever saw them, e.g. "8.96211E+18".
const SCIENTIFIC = /^[+-]?\d+(\.\d+)?e[+-]?\d+$/i;
/**
 * Trim the decorations spreadsheets add around identifiers (spaces, NBSP, quotes,
 * thousands separators, a leading +) without stripping trailing check letters that
 * are part of some ICCIDs. `unreadable` marks a cell that reached us as a float.
 */
const normalizeKeyCell = (value) => {
    const raw = value === null || value === undefined ? '' : String(value).trim();
    if (!raw)
        return { key: '', unreadable: false };
    const cleaned = raw.replace(/[\s'"`,\u00a0]/g, '').replace(/^\+/, '');
    if (SCIENTIFIC.test(cleaned))
        return { key: raw, unreadable: true };
    return { key: cleaned, unreadable: false };
};
// SQL Server caps a statement at 2,100 parameters, so `in` lists are always chunked.
const CHUNK = 500;
const chunkArray = (arr, size = CHUNK) => {
    const chunks = [];
    for (let i = 0; i < arr.length; i += size)
        chunks.push(arr.slice(i, i + size));
    return chunks;
};
const fetchChunked = async (keys, fn) => {
    const out = [];
    for (const batch of chunkArray(keys))
        out.push(...(await fn(batch)));
    return out;
};
// Error lists are capped so a bad 5,000-row upload does not return a 5,000-item payload.
const MAX_LISTED_ERRORS = 50;
const errorBucket = (items) => ({
    count: items.length,
    samples: items.slice(0, MAX_LISTED_ERRORS),
    truncated: Math.max(0, items.length - MAX_LISTED_ERRORS)
});
class StockController {
    static async dashboardSync(req, res, next) {
        try {
            const allowed = req.checkpointCodes ?? [];
            const circleCode = req.user.circleCode;
            const dcCode = req.query.dcCode;
            const storeCode = req.query.storeCode;
            const now = new Date();
            const currentYear = now.getFullYear();
            const currentMonth = now.getMonth() + 1; // 1-indexed
            const year = Number(req.query.year) || currentYear;
            const month = Number(req.query.month) || currentMonth;
            // Cutoff: end of today when viewing the current month, otherwise last day of the requested month
            const isCurrentPeriod = year === currentYear && month === currentMonth;
            const cutoff = isCurrentPeriod
                ? new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999)
                : new Date(year, month, 0, 23, 59, 59, 999); // day 0 of next month = last day of this month
            const yearStart = new Date(year, 0, 1);
            const scopeFilter = {
                status: 'DELIVERED',
                OR: [{ source: (0, access_util_1.checkpointInCircle)(circleCode) }, { target: (0, access_util_1.checkpointInCircle)(circleCode) }],
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
                prisma_1.default.distribution.aggregate({
                    _sum: { amount: true },
                    where: { ...scopeFilter, target: { type: 'DC' } }
                }),
                // 2. Cards distributed TO STORE checkpoints up to cutoff
                prisma_1.default.distribution.aggregate({
                    _sum: { amount: true },
                    where: { ...scopeFilter, target: { type: 'STORE' } }
                }),
                // Shared checkpoint fetch
                prisma_1.default.checkpoint.findMany({
                    where: (0, access_util_1.checkpointInCircle)(circleCode)
                }),
                // Latest stock snapshot per checkpoint up to cutoff.
                // Queried flat (not as a nested `include`) — a nested include would batch-load
                // via `WHERE checkpointCode IN (<every checkpoint id just fetched>)`, which can
                // exceed SQL Server's ~2100 parameter limit for large circles (e.g. HQ).
                prisma_1.default.cardStock.findMany({
                    where: { checkpoint: (0, access_util_1.checkpointInCircle)(circleCode), createdAt: { lte: cutoff } },
                    orderBy: { createdAt: 'desc' },
                    distinct: ['checkpointCode']
                }),
                // Base initial stock: active cards created up to cutoff
                prisma_1.default.card.count({
                    where: {
                        checkpoint: (0, access_util_1.checkpointInCircle)(circleCode),
                        status: { in: ['VERIFIED', 'SOLD', 'DELIVERY', 'OPNAME'] },
                        createdAt: { lte: cutoff }
                    }
                }),
                // BROKEN/LOST candidates — need to check if opname-traced
                prisma_1.default.card.findMany({
                    where: {
                        checkpoint: (0, access_util_1.checkpointInCircle)(circleCode),
                        status: { in: ['BROKEN', 'LOST'] },
                        createdAt: { lte: cutoff }
                    },
                    select: { id: true }
                }),
                // Top 10 users by total sales (merges) up to cutoff
                prisma_1.default.merge.groupBy({
                    by: ['userCode'],
                    where: { checkpoint: (0, access_util_1.checkpointInCircle)(circleCode), createdAt: { lte: cutoff } },
                    _count: { userCode: true },
                    orderBy: { _count: { userCode: 'desc' } },
                    take: 10
                }),
                // Monthly DC distributions for selected year up to cutoff
                prisma_1.default.distribution.findMany({
                    where: dcMonthlyWhere,
                    select: { amount: true, createdAt: true }
                }),
                // Monthly STORE distributions for selected year up to cutoff
                prisma_1.default.distribution.findMany({
                    where: storeMonthlyWhere,
                    select: { amount: true, createdAt: true }
                }),
                // Cards uploaded to a checkpoint but not yet validated. These are held
                // physically but carry no CardStock entry — CardStock is only credited on
                // UNVERIFIED -> VERIFIED (see validateCard) — so they are reported separately
                // as `pendingStock` rather than folded into `currentStock`.
                // Grouped via a relation filter, not an `IN` list, to stay under SQL Server's
                // ~2100 parameter limit for large circles.
                prisma_1.default.card.groupBy({
                    by: ['checkpointCode'],
                    where: {
                        checkpoint: (0, access_util_1.checkpointInCircle)(circleCode),
                        status: 'UNVERIFIED',
                        createdAt: { lte: cutoff }
                    },
                    _count: { _all: true }
                })
            ]);
            // Cards that are BROKEN/LOST but discovered via opname still count toward initial stock.
            const brokenLostIds = brokenLostCards.map(c => c.id);
            const [opnamedBrokenLostCount, topSaleByCheckpoint] = await Promise.all([
                brokenLostIds.length > 0
                    ? prisma_1.default.opnameUpdate.groupBy({
                        by: ['itemID'],
                        where: { itemID: { in: brokenLostIds }, createdAt: { lte: cutoff } }
                    }).then(groups => groups.length)
                    : Promise.resolve(0),
                // Top 10 STORE checkpoints by total sales (merges) up to cutoff
                prisma_1.default.merge.groupBy({
                    by: ['checkpointCode'],
                    where: { checkpoint: { type: 'STORE', ...(0, access_util_1.checkpointInCircle)(circleCode) }, createdAt: { lte: cutoff } },
                    _count: { checkpointCode: true },
                    orderBy: { _count: { checkpointCode: 'desc' } },
                    take: 10
                })
            ]);
            // Enrich top-selling users with their name
            const topUserCodes = topSaleByUser.map(r => r.userCode);
            const topUserDetails = topUserCodes.length > 0
                ? await prisma_1.default.user.findMany({
                    where: { code: { in: topUserCodes } },
                    select: { code: true, name: true }
                })
                : [];
            const userDetailMap = Object.fromEntries(topUserDetails.map(u => [u.code, u]));
            const initialStock = baseInitialCount + opnamedBrokenLostCount;
            const stockByCheckpoint = Object.fromEntries(latestStocks.map(s => [s.checkpointCode, s.amount]));
            // Final stock: sum of latest CardStock snapshot per checkpoint up to cutoff
            const finalStock = allCheckpoints.reduce((sum, c) => sum + (stockByCheckpoint[c.code] ?? 0), 0);
            const pendingByCheckpoint = Object.fromEntries(pendingRows.map(r => [r.checkpointCode, r._count._all]));
            const withStock = (c) => ({
                ...c,
                currentStock: stockByCheckpoint[c.code] ?? 0,
                pendingStock: pendingByCheckpoint[c.code] ?? 0
            });
            const storeStocks = allCheckpoints.filter(c => c.type === 'STORE').map(withStock);
            const dcStocks = allCheckpoints.filter(c => c.type === 'DC').map(withStock);
            // Ranked by highest stock. Sorting ascending here would only ever surface the
            // checkpoints that have no CardStock snapshot yet (they fall back to 0), which
            // vastly outnumber the ones actually holding cards.
            // Response key kept as `topLeastStoreStock` for frontend compatibility.
            // Tie-broken by pendingStock so a list of all-zero validated stock (every DC today)
            // still ranks by what is actually sitting at the checkpoint awaiting validation.
            const byStockThenPending = (a, b) => b.currentStock - a.currentStock || b.pendingStock - a.pendingStock;
            const topLeastStoreStock = [...storeStocks].sort(byStockThenPending).slice(0, 10);
            const topMostDCStock = [...dcStocks].sort(byStockThenPending).slice(0, 10);
            // Circle-wide totals across every checkpoint of the type, not just the top 10
            const totalStoreStock = storeStocks.reduce((sum, c) => sum + c.currentStock, 0);
            const totalDCStock = dcStocks.reduce((sum, c) => sum + c.currentStock, 0);
            const totalStorePending = storeStocks.reduce((sum, c) => sum + c.pendingStock, 0);
            const totalDCPending = dcStocks.reduce((sum, c) => sum + c.pendingStock, 0);
            const checkpointMap = Object.fromEntries(allCheckpoints.map(c => [c.code, c]));
            const topHighestSaleByCheckpoint = topSaleByCheckpoint.map(row => ({
                checkpoint: checkpointMap[row.checkpointCode],
                totalSales: row._count.checkpointCode
            }));
            const topHighestSaleByUser = topSaleByUser.map(row => ({
                user: userDetailMap[row.userCode] ?? { code: row.userCode, name: null },
                totalSales: row._count.userCode
            }));
            // 12-element monthly arrays — months after cutoff will be 0
            const buildMonthlyTotals = (rows) => {
                const months = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, amount: 0 }));
                for (const row of rows) {
                    months[new Date(row.createdAt).getMonth()].amount += row.amount ?? 0;
                }
                return months;
            };
            const distributedToDCByMonth = buildMonthlyTotals(dcMonthlyRows);
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
                    totalStoreStock,
                    totalDCStock,
                    totalStorePending,
                    totalDCPending,
                    topHighestSaleByCheckpoint,
                    topHighestSaleByUser
                }
            });
        }
        catch (error) {
            next(error);
        }
    }
    static async getDCDistributionChart(req, res, next) {
        try {
            const allowed = req.checkpointCodes ?? [];
            const circleCode = req.user.circleCode;
            const checkpointCode = req.query.checkpointCode;
            const now = new Date();
            const currentYear = now.getFullYear();
            const year = Number(req.query.year) || currentYear;
            const cutoff = year === currentYear
                ? new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999)
                : new Date(year, 11, 31, 23, 59, 59, 999);
            const yearStart = new Date(year, 0, 1);
            if (checkpointCode && !allowed.includes(checkpointCode)) {
                const err = new Error('Checkpoint not found');
                err.status = 404;
                throw err;
            }
            const [dcCheckpoints, rows] = await Promise.all([
                prisma_1.default.checkpoint.findMany({
                    where: { ...(0, access_util_1.checkpointInCircle)(circleCode), type: 'DC' },
                    select: { code: true, name: true },
                    orderBy: { name: 'asc' }
                }),
                prisma_1.default.distribution.findMany({
                    where: {
                        status: 'DELIVERED',
                        OR: [{ source: (0, access_util_1.checkpointInCircle)(circleCode) }, { target: (0, access_util_1.checkpointInCircle)(circleCode) }],
                        target: { type: 'DC', ...(checkpointCode && { code: checkpointCode }) },
                        createdAt: { gte: yearStart, lte: cutoff }
                    },
                    select: { amount: true, createdAt: true }
                })
            ]);
            const chart = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, amount: 0 }));
            for (const row of rows) {
                chart[new Date(row.createdAt).getMonth()].amount += row.amount ?? 0;
            }
            res.status(200).json({
                message: 'DC distribution chart retrieved successfully',
                data: { year, cutoff, checkpoints: dcCheckpoints, chart }
            });
        }
        catch (error) {
            next(error);
        }
    }
    static async getStoreDistributionChart(req, res, next) {
        try {
            const allowed = req.checkpointCodes ?? [];
            const circleCode = req.user.circleCode;
            const checkpointCode = req.query.checkpointCode;
            const now = new Date();
            const currentYear = now.getFullYear();
            const year = Number(req.query.year) || currentYear;
            const cutoff = year === currentYear
                ? new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999)
                : new Date(year, 11, 31, 23, 59, 59, 999);
            const yearStart = new Date(year, 0, 1);
            if (checkpointCode && !allowed.includes(checkpointCode)) {
                const err = new Error('Checkpoint not found');
                err.status = 404;
                throw err;
            }
            const [storeCheckpoints, rows] = await Promise.all([
                prisma_1.default.checkpoint.findMany({
                    where: { ...(0, access_util_1.checkpointInCircle)(circleCode), type: 'STORE' },
                    select: { code: true, name: true },
                    orderBy: { name: 'asc' }
                }),
                prisma_1.default.distribution.findMany({
                    where: {
                        status: 'DELIVERED',
                        OR: [{ source: (0, access_util_1.checkpointInCircle)(circleCode) }, { target: (0, access_util_1.checkpointInCircle)(circleCode) }],
                        target: { type: 'STORE', ...(checkpointCode && { code: checkpointCode }) },
                        createdAt: { gte: yearStart, lte: cutoff }
                    },
                    select: { amount: true, createdAt: true }
                })
            ]);
            const chart = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, amount: 0 }));
            for (const row of rows) {
                chart[new Date(row.createdAt).getMonth()].amount += row.amount ?? 0;
            }
            res.status(200).json({
                message: 'Store distribution chart retrieved successfully',
                data: { year, cutoff, checkpoints: storeCheckpoints, chart }
            });
        }
        catch (error) {
            next(error);
        }
    }
    static async getBatch(req, res, next) {
        try {
            const { id } = req.params;
            const allowed = req.checkpointCodes ?? [];
            const batch = await prisma_1.default.uploadBatch.findUnique({
                where: { id: Number(id) },
                include: {
                    cards: { take: 50, orderBy: { createdAt: 'desc' } },
                    numbers: { take: 50, orderBy: { createdAt: 'desc' } },
                    progress: { take: 1, orderBy: { createdAt: 'desc' } }
                }
            });
            if (!batch || (batch.cards.length > 0 && !batch.cards.some(c => allowed.includes(c.checkpointCode)))) {
                const err = new Error('Batch not found');
                err.status = 404;
                throw err;
            }
            res.status(200).json({
                message: 'Batch retrieved successfully',
                data: { batch }
            });
        }
        catch (error) {
            next(error);
        }
    }
    static async getBatches(req, res, next) {
        try {
            const { page = 1, limit = 10, status, search } = req.query;
            const circleCode = req.user.circleCode;
            const allowedStatus = ['ONGOING', 'COMPLETED'];
            if (status && !allowedStatus.includes(status)) {
                const err = new Error('Invalid status');
                err.status = 400;
                throw err;
            }
            const where = {
                cards: { some: { checkpoint: (0, access_util_1.checkpointInCircle)(circleCode) } }
            };
            if (status) {
                where.status = status;
            }
            if (search) {
                where.OR = [
                    { code: { contains: search } },
                    { name: { contains: search } }
                ];
            }
            const batches = await prisma_1.default.uploadBatch.findMany({
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
                prisma_1.default.uploadBatch.count({ where }),
                prisma_1.default.card.count({ where: { checkpoint: (0, access_util_1.checkpointInCircle)(circleCode) } }),
                prisma_1.default.card.count({ where: { checkpoint: (0, access_util_1.checkpointInCircle)(circleCode), status: 'VERIFIED' } }),
                prisma_1.default.card.count({ where: { checkpoint: (0, access_util_1.checkpointInCircle)(circleCode), status: 'UNVERIFIED' } })
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
        }
        catch (error) {
            next(error);
        }
    }
    static async completeBatch(req, res, next) {
        try {
            const { id } = req.params;
            const { note } = req.body ?? {};
            const allowed = req.checkpointCodes ?? [];
            const batch = await prisma_1.default.$transaction(async (tx) => {
                const currentBatch = await tx.uploadBatch.findUnique({
                    where: { id: Number(id) },
                    include: { cards: { select: { checkpointCode: true } } }
                });
                if (!currentBatch || (currentBatch.cards.length > 0 && !currentBatch.cards.some(c => allowed.includes(c.checkpointCode)))) {
                    const err = new Error('Batch not found');
                    err.status = 404;
                    throw err;
                }
                if (currentBatch.status === 'COMPLETED') {
                    const err = new Error('Batch is already completed');
                    err.status = 400;
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
            });
            res.status(200).json({
                message: 'Batch updated successfully',
                data: { batch }
            });
        }
        catch (error) {
            next(error);
        }
    }
    static async deleteBatch(req, res, next) {
        try {
            const { id } = req.params;
            const allowed = req.checkpointCodes ?? [];
            const batch = await prisma_1.default.uploadBatch.findUnique({
                where: { id: Number(id) },
                include: {
                    cards: {
                        select: { key: true, id: true, status: true, checkpointCode: true }
                    }
                }
            });
            if (!batch || !batch.cards.some(c => allowed.includes(c.checkpointCode))) {
                const err = new Error('Batch not found');
                err.status = 404;
                throw err;
            }
            if (batch.status === 'COMPLETED') {
                const err = new Error('Cannot delete a completed batch');
                err.status = 400;
                throw err;
            }
            const allowedStatuses = ['VERIFIED', 'UNVERIFIED', 'BROKEN', 'LOST'];
            const invalidCards = batch.cards.filter(card => !allowedStatuses.includes(card.status));
            if (invalidCards.length > 0) {
                const invalidStatusList = [...new Set(invalidCards.map(c => c.status))].join(', ');
                const err = new Error(`Cannot delete batch: ${invalidCards.length} card(s) have status (${invalidStatusList}) that cannot be deleted`);
                err.status = 400;
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
            }, {});
            await prisma_1.default.$transaction(async (tx) => {
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
        }
        catch (error) {
            next(error);
        }
    }
    static async getCards(req, res, next) {
        try {
            const { page = 1, limit = 10, checkpointCode, status, search, uploadAt, batch, validatedAt } = req.query;
            const circleCode = req.user.circleCode;
            const where = {
                // Scope to checkpoints in the user's circle; intersect with any requested checkpointCode
                checkpoint: (0, access_util_1.checkpointInCircle)(circleCode, checkpointCode)
            };
            if (status)
                where.status = status;
            if (search) {
                where.OR = [
                    { key: { contains: search } },
                    { name: { contains: search } }
                ];
            }
            // validatedAt filter (related via Card -> Merge)
            if (validatedAt) {
                where.validatedAt = {
                    gte: new Date(`${validatedAt}T00:00:00.000Z`),
                    lt: new Date(`${validatedAt}T23:59:59.999Z`)
                };
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
                        code: { contains: batch }
                    })
                };
            }
            const [cards, total] = await Promise.all([
                prisma_1.default.card.findMany({
                    where,
                    skip: (Number(page) - 1) * Number(limit),
                    take: Number(limit),
                    include: {
                        checkpoint: true,
                        uploadBatch: true
                    },
                    orderBy: { createdAt: 'desc' }
                }),
                prisma_1.default.card.count({ where })
            ]);
            const [totalUpload, totalSold, totalAvailable] = await Promise.all([
                prisma_1.default.card.count({ where: { checkpoint: (0, access_util_1.checkpointInCircle)(circleCode) } }),
                prisma_1.default.card.count({ where: { checkpoint: (0, access_util_1.checkpointInCircle)(circleCode), status: "SOLD" } }),
                prisma_1.default.card.count({ where: { checkpoint: (0, access_util_1.checkpointInCircle)(circleCode), status: "VERIFIED" } })
            ]);
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
        }
        catch (error) {
            next(error);
        }
    }
    static async getCard(req, res, next) {
        try {
            const { key } = req.params;
            const allowed = req.checkpointCodes ?? [];
            const card = await prisma_1.default.card.findUnique({
                where: { key: key },
                include: {
                    checkpoint: true,
                    movements: { orderBy: { createdAt: 'desc' } }
                }
            });
            if (!card || !(0, access_util_1.hasCheckpointAccess)(card.checkpointCode, allowed)) {
                const err = new Error('Card not found');
                err.status = 404;
                throw err;
            }
            res.status(200).json({
                message: 'Card retrieved successfully',
                data: { card }
            });
        }
        catch (error) {
            next(error);
        }
    }
    static async deleteCard(req, res, next) {
        try {
            const key = String(req.params.key);
            const allowed = req.checkpointCodes ?? [];
            const existing = await prisma_1.default.card.findUnique({ where: { key } });
            if (!existing || !(0, access_util_1.hasCheckpointAccess)(existing.checkpointCode, allowed)) {
                const err = new Error('Card not found');
                err.status = 404;
                throw err;
            }
            if (existing.status === 'SOLD' || existing.status === 'DELIVERY' || existing.status === 'OPNAME') {
                const err = new Error(`Cannot delete a ${existing.status.toLowerCase()} card`);
                err.status = 400;
                throw err;
            }
            await prisma_1.default.$transaction(async (tx) => {
                await tx.cardMovement.deleteMany({ where: { cardID: existing.id } });
                await tx.merge.deleteMany({ where: { cardKey: existing.key } });
                await tx.distributionItem.deleteMany({ where: { itemKey: existing.key } });
                await tx.card.delete({ where: { id: existing.id } });
            });
            res.status(200).json({
                message: 'Card deleted successfully'
            });
        }
        catch (error) {
            next(error);
        }
    }
    static async uploadExcel(req, res, next) {
        try {
            const file = req.file;
            if (!req.user) {
                throw new Error('User not found');
            }
            if (!file) {
                const err = new Error('No file uploaded');
                err.status = 400;
                throw err;
            }
            // Parse Excel outside the transaction — CPU-bound work should not hold a DB connection
            const workbook = xlsx.read(file.buffer, { type: 'buffer' });
            if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
                const err = new Error('Excel file has no sheets');
                err.status = 422;
                throw err;
            }
            const firstWorksheet = workbook.Sheets[workbook.SheetNames[0]];
            if (!firstWorksheet) {
                const err = new Error('Worksheet not found');
                err.status = 422;
                throw err;
            }
            const allowedSheets = ['ICCID', 'MSISDN'];
            const parsedSheets = [];
            for (const sheet of workbook.SheetNames) {
                const sheetData = workbook.Sheets[sheet];
                if (!sheetData || !allowedSheets.includes(sheet))
                    continue;
                parsedSheets.push({ sheet, rows: sheetRows(sheetData) });
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
                const seen = new Set();
                const data = rows
                    .flatMap((row) => {
                    const key = normalizeKeyCell(row.KEY || row.key).key;
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
                    .filter((item) => {
                    if (!item.key || item.key === 'undefined' || seen.has(item.key))
                        return false;
                    seen.add(item.key);
                    return true;
                });
                return { sheet, data };
            });
            const CHUNK_SIZE = 500;
            const chunk = (arr, size) => {
                const chunks = [];
                for (let i = 0; i < arr.length; i += size)
                    chunks.push(arr.slice(i, i + size));
                return chunks;
            };
            const { totalCreated, parsedTotal } = await prisma_1.default.$transaction(async (tx) => {
                let batch;
                if (batchID) {
                    const existing = await tx.uploadBatch.findUnique({ where: { id: Number(batchID) } });
                    if (!existing) {
                        const err = new Error(`Batch ${batchID} not found`);
                        err.status = 404;
                        throw err;
                    }
                    if (existing.status === 'COMPLETED') {
                        const err = new Error(`Batch ${batchID} is already completed`);
                        err.status = 409;
                        throw err;
                    }
                    batch = existing;
                }
                else {
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
                const result = await Promise.all(jsonData.map(async ({ sheet, data }) => {
                    const keys = data.map((r) => r.key);
                    if (sheet === 'ICCID') {
                        const existingSet = new Set();
                        for (const keyChunk of chunk(keys, CHUNK_SIZE)) {
                            const existing = await tx.card.findMany({ where: { key: { in: keyChunk } }, select: { key: true } });
                            existing.forEach(c => existingSet.add(c.key));
                        }
                        const newRows = data.filter((r) => !existingSet.has(r.key));
                        let count = 0;
                        for (const rowChunk of chunk(newRows, CHUNK_SIZE)) {
                            const created = await tx.card.createMany({ data: rowChunk });
                            count += created.count;
                        }
                        return { count };
                    }
                    else {
                        const existingSet = new Set();
                        for (const keyChunk of chunk(keys, CHUNK_SIZE)) {
                            const existing = await tx.number.findMany({ where: { key: { in: keyChunk } }, select: { key: true } });
                            existing.forEach(n => existingSet.add(n.key));
                        }
                        const newRows = data.filter((r) => !existingSet.has(r.key));
                        let count = 0;
                        for (const rowChunk of chunk(newRows, CHUNK_SIZE)) {
                            const created = await tx.number.createMany({ data: rowChunk });
                            count += created.count;
                        }
                        return { count };
                    }
                }));
                const totalCreated = result.reduce((sum, r) => sum + r.count, 0);
                if (batchID) {
                    const newCardsCount = result[jsonData.findIndex(s => s.sheet === 'ICCID')]?.count ?? 0;
                    await tx.uploadBatch.update({
                        where: { id: batch.id },
                        data: { total: { increment: newCardsCount } }
                    });
                }
                else if (totalCreated === 0) {
                    await tx.uploadBatch.delete({ where: { id: batch.id } });
                }
                return { totalCreated, parsedTotal };
            }, {
                timeout: Number(process.env.UPLOAD_TX_TIMEOUT_MS) || 120000,
                maxWait: Number(process.env.UPLOAD_TX_MAXWAIT_MS) || 10000
            });
            res.status(200).json({
                message: 'Upload completed successfully',
                data: { total: parsedTotal, created: totalCreated, skipped: skippedCardRows }
            });
        }
        catch (error) {
            next(error);
        }
    }
    static async uploadSoldExcel(req, res, next) {
        try {
            const file = req.file;
            if (!file) {
                const err = new Error('No file uploaded');
                err.status = 400;
                throw err;
            }
            const workbook = xlsx.read(file.buffer, { type: 'buffer' });
            const sheet = workbook.Sheets[workbook.SheetNames[0]];
            if (!sheet) {
                const err = new Error('Excel file has no sheets');
                err.status = 422;
                throw err;
            }
            const rows = sheetRows(sheet);
            const parsed = [];
            const unreadableIccid = [];
            const duplicateInFile = [];
            const seen = new Map();
            for (const [index, r] of rows.entries()) {
                // +2: one for the header row, one because spreadsheets count from 1.
                const row = index + 2;
                const iccidCell = normalizeKeyCell(r.ICCID ?? r.iccid);
                const msisdnCell = normalizeKeyCell(r.MSISDN ?? r.msisdn);
                const storeCode = String(r.STORE_CODE ?? r.store_code ?? '').trim();
                const trn = String(r.TRN ?? r.trn ?? '').trim();
                if (iccidCell.unreadable) {
                    unreadableIccid.push({ row, iccid: iccidCell.key, storeCode,
                        detail: 'Excel saved this ICCID as a number, so its digits are already lost' });
                    continue;
                }
                const iccid = iccidCell.key;
                if (!iccid)
                    continue;
                const firstRow = seen.get(iccid);
                if (firstRow) {
                    duplicateInFile.push({ row, iccid, storeCode, detail: `same ICCID already on row ${firstRow}` });
                    continue;
                }
                seen.set(iccid, row);
                parsed.push({ row, iccid, msisdn: msisdnCell.key, storeCode, trn: trn || null });
            }
            if (parsed.length === 0 && unreadableIccid.length === 0) {
                const err = new Error('No ICCID values found in the file');
                err.status = 422;
                throw err;
            }
            if (!req.user) {
                const err = new Error('User not found');
                err.status = 401;
                throw err;
            }
            const userCode = req.user.code;
            const allowed = req.checkpointCodes ?? [];
            const iccids = parsed.map(r => r.iccid);
            const msisdns = [...new Set(parsed.map(r => r.msisdn).filter(Boolean))];
            // Merges are looked up by both keys: cardKey decides verify-vs-create, numberKey
            // catches an MSISDN already bound to a different card (Merge.numberKey is @unique).
            const [merges, mergesByNumber, cards, numbers] = await Promise.all([
                fetchChunked(iccids, batch => prisma_1.default.merge.findMany({
                    where: { cardKey: { in: batch } },
                    select: { cardKey: true, numberKey: true, checkpointCode: true, soldAt: true, verifiedAt: true }
                })),
                fetchChunked(msisdns, batch => prisma_1.default.merge.findMany({
                    where: { numberKey: { in: batch } },
                    select: { numberKey: true, cardKey: true }
                })),
                fetchChunked(iccids, batch => prisma_1.default.card.findMany({
                    where: { key: { in: batch } },
                    select: { id: true, key: true, status: true, validatedAt: true, checkpointCode: true }
                })),
                fetchChunked(msisdns, batch => prisma_1.default.number.findMany({
                    where: { key: { in: batch } },
                    select: { key: true, status: true }
                }))
            ]);
            const mergeMap = new Map(merges.map(m => [m.cardKey, m]));
            const mergeNumberMap = new Map(mergesByNumber.map(m => [m.numberKey, m]));
            const cardMap = new Map(cards.map(c => [c.key, c]));
            const numberMap = new Map(numbers.map(n => [n.key, n]));
            // A row may leave MSISDN blank, in which case the merge's own numberKey was never
            // in the fetch above — without this the verify path reports a bogus "number not SOLD".
            const unfetchedNumberKeys = [...new Set(merges.map(m => m.numberKey).filter(k => !numberMap.has(k)))];
            if (unfetchedNumberKeys.length > 0) {
                const extra = await fetchChunked(unfetchedNumberKeys, batch => prisma_1.default.number.findMany({
                    where: { key: { in: batch } },
                    select: { key: true, status: true }
                }));
                extra.forEach(n => numberMap.set(n.key, n));
            }
            // Verify path (merge already exists)
            const storeNotAccessible = [];
            const mismatched = [];
            const checkpointMismatch = [];
            const noSoldAt = [];
            const notSoldStatus = [];
            const numberNotSold = [];
            const neverValidated = [];
            // Create path (no merge yet)
            const cardNotFound = [];
            const cardNotVerified = [];
            const cardCheckpointMismatch = [];
            const storeCodeMissing = [];
            const msisdnMissing = [];
            const numberAlreadySold = [];
            const numberBoundToOtherCard = [];
            const duplicateMsisdn = [];
            const toCreate = [];
            const toVerify = [];
            const msisdnSeen = new Map();
            for (const row of parsed) {
                const merge = mergeMap.get(row.iccid);
                const card = cardMap.get(row.iccid);
                // STORE_CODE, when present, must be inside the caller's accessible checkpoints
                const issue = { row: row.row, iccid: row.iccid, msisdn: row.msisdn, storeCode: row.storeCode };
                if (row.storeCode && !(0, access_util_1.hasCheckpointAccess)(row.storeCode, allowed)) {
                    storeNotAccessible.push({ ...issue, detail: `store ${row.storeCode} is not a checkpoint you can access` });
                    continue;
                }
                if (merge) {
                    // ---- Verify path: unchanged reconciliation rules ----
                    if (row.msisdn && merge.numberKey !== row.msisdn) {
                        mismatched.push({ ...issue, detail: `this ICCID is merged with ${merge.numberKey}, not ${row.msisdn}` });
                        continue;
                    }
                    if (row.storeCode && merge.checkpointCode !== row.storeCode) {
                        checkpointMismatch.push({ ...issue, detail: `the recorded sale was at ${merge.checkpointCode ?? 'unknown'}, not ${row.storeCode}` });
                        continue;
                    }
                    if (!merge.soldAt) {
                        noSoldAt.push({ ...issue, detail: 'the merge record has no sale date' });
                        continue;
                    }
                    if (!card || card.status !== 'SOLD') {
                        notSoldStatus.push({ ...issue, detail: `card status is ${card?.status ?? 'unknown'}, expected SOLD` });
                        continue;
                    }
                    const number = numberMap.get(merge.numberKey);
                    if (!number || number.status !== 'SOLD') {
                        numberNotSold.push({ ...issue, detail: `MSISDN ${merge.numberKey} status is ${number?.status ?? 'not found'}, expected SOLD` });
                        continue;
                    }
                    if (!card.validatedAt) {
                        neverValidated.push({ ...issue, detail: 'card was never validated into stock' });
                        continue;
                    }
                    toVerify.push(row.iccid);
                    continue;
                }
                // ---- Create path: the sale has not been recorded yet ----
                // Cards are never auto-created: the physical card must already be in stock.
                if (!card) {
                    cardNotFound.push({ ...issue, detail: 'this ICCID does not exist in the system' });
                    continue;
                }
                if (card.status !== 'VERIFIED') {
                    cardNotVerified.push({ ...issue, detail: `card status is ${card.status}; it must be VERIFIED before it can be sold` });
                    continue;
                }
                if (!card.validatedAt) {
                    neverValidated.push({ ...issue, detail: 'card was never validated into stock' });
                    continue;
                }
                if (!row.storeCode) {
                    storeCodeMissing.push({ ...issue, detail: 'STORE_CODE is empty' });
                    continue;
                }
                if (card.checkpointCode !== row.storeCode) {
                    cardCheckpointMismatch.push({ ...issue, detail: `card is currently held at ${card.checkpointCode}, not ${row.storeCode}` });
                    continue;
                }
                if (!row.msisdn) {
                    msisdnMissing.push({ ...issue, detail: 'MSISDN is empty' });
                    continue;
                }
                const firstUse = msisdnSeen.get(row.msisdn);
                if (firstUse) {
                    duplicateMsisdn.push({ ...issue, detail: `MSISDN ${row.msisdn} is already used by ICCID ${firstUse}` });
                    continue;
                }
                const boundMerge = mergeNumberMap.get(row.msisdn);
                if (boundMerge) {
                    numberBoundToOtherCard.push({ ...issue, detail: `MSISDN ${row.msisdn} is already merged with ${boundMerge.cardKey}` });
                    continue;
                }
                // Numbers, unlike cards, are auto-created when absent.
                const number = numberMap.get(row.msisdn);
                if (number && number.status === 'SOLD') {
                    numberAlreadySold.push({ ...issue, detail: `MSISDN ${row.msisdn} is already marked SOLD` });
                    continue;
                }
                msisdnSeen.set(row.msisdn, row.iccid);
                toCreate.push({ ...row, cardID: card.id });
            }
            // Stock is drawn down once per checkpoint rather than once per card.
            const perCheckpoint = new Map();
            for (const row of toCreate) {
                perCheckpoint.set(row.storeCode, (perCheckpoint.get(row.storeCode) ?? 0) + 1);
            }
            const insufficientStock = [];
            const stockPlan = [];
            // Anchor each stock shortfall to the first row for that store, so the message
            // still points somewhere findable in the sheet.
            const firstRowForStore = new Map();
            for (const r of toCreate)
                if (!firstRowForStore.has(r.storeCode))
                    firstRowForStore.set(r.storeCode, r);
            if (perCheckpoint.size > 0) {
                const snapshots = await Promise.all([...perCheckpoint.keys()].map(code => prisma_1.default.cardStock.findFirst({ where: { checkpointCode: code }, orderBy: { createdAt: 'desc' } })
                    .then(stock => ({ code, amount: Number(stock?.amount ?? 0) }))));
                for (const { code, amount } of snapshots) {
                    const needed = perCheckpoint.get(code);
                    if (amount < needed) {
                        const anchor = firstRowForStore.get(code);
                        insufficientStock.push({
                            row: anchor?.row ?? 0,
                            iccid: anchor?.iccid ?? '',
                            storeCode: code,
                            detail: `store ${code} has ${amount} card(s) in stock but this file sells ${needed}`
                        });
                    }
                    else {
                        stockPlan.push({ checkpointCode: code, nextAmount: amount - needed });
                    }
                }
            }
            // Each bucket states the problem and the fix, so the person who uploaded the file
            // can correct it and retry without needing anyone to interpret the response.
            const buckets = [
                { code: 'unreadableIccid', label: 'ICCID was saved as a number by Excel',
                    action: 'Format the ICCID column as Text, re-enter those ICCIDs, and export again.',
                    items: unreadableIccid },
                { code: 'duplicateIccid', label: 'The same ICCID appears more than once',
                    action: 'Delete the duplicate rows, keeping one row per ICCID.',
                    items: duplicateInFile },
                { code: 'cardNotFound', label: 'ICCID is not in the system',
                    action: 'Check the ICCID for typos, or upload its stock batch first.',
                    items: cardNotFound },
                { code: 'storeNotAccessible', label: 'STORE_CODE is not a store you can access',
                    action: 'Correct STORE_CODE to a store in your circle.',
                    items: storeNotAccessible },
                { code: 'storeCodeMissing', label: 'STORE_CODE is empty',
                    action: 'Fill in the store where the card was sold.',
                    items: storeCodeMissing },
                { code: 'msisdnMissing', label: 'MSISDN is empty',
                    action: 'Fill in the MSISDN that was sold with this ICCID.',
                    items: msisdnMissing },
                { code: 'cardNotVerified', label: 'Card has not been validated into stock',
                    action: 'Validate the card at its checkpoint, then upload again.',
                    items: cardNotVerified },
                { code: 'neverValidated', label: 'Card was never physically validated',
                    action: 'Validate the card at its checkpoint, then upload again.',
                    items: neverValidated },
                { code: 'cardCheckpointMismatch', label: 'Card is still held at a different location',
                    action: 'Distribute or transfer the card to the store in STORE_CODE, or correct STORE_CODE to where the card actually is.',
                    items: cardCheckpointMismatch },
                { code: 'duplicateMsisdn', label: 'The same MSISDN is used on more than one row',
                    action: 'Each MSISDN can be sold once — remove or correct the duplicate.',
                    items: duplicateMsisdn },
                { code: 'numberBoundToOtherCard', label: 'MSISDN is already merged with another ICCID',
                    action: 'Check which ICCID this MSISDN belongs to and correct the row.',
                    items: numberBoundToOtherCard },
                { code: 'numberAlreadySold', label: 'MSISDN is already sold',
                    action: 'This number was sold previously — remove the row or correct the MSISDN.',
                    items: numberAlreadySold },
                { code: 'insufficientStock', label: 'Not enough stock at the store',
                    action: 'The store does not hold enough cards to cover these sales — check the stock figures.',
                    items: insufficientStock },
                { code: 'msisdnMismatch', label: 'MSISDN does not match the recorded sale',
                    action: 'Correct the MSISDN to the one recorded against this ICCID.',
                    items: mismatched },
                { code: 'storeMismatch', label: 'STORE_CODE does not match the recorded sale',
                    action: 'Correct STORE_CODE to the store where the sale was recorded.',
                    items: checkpointMismatch },
                { code: 'soldAtMissing', label: 'The recorded sale has no date',
                    action: 'Contact support — this sale record is incomplete.',
                    items: noSoldAt },
                { code: 'cardNotSold', label: 'Card status is not SOLD',
                    action: 'Contact support — the sale record and the card disagree.',
                    items: notSoldStatus },
                { code: 'numberNotSold', label: 'Number status is not SOLD',
                    action: 'Contact support — the sale record and the number disagree.',
                    items: numberNotSold }
            ];
            const failed = buckets.filter(b => b.items.length > 0);
            // All-or-nothing: one bad row rejects the file and nothing is written.
            if (failed.length > 0) {
                const failedRows = failed.reduce((sum, b) => sum + b.items.length, 0);
                const readyRows = parsed.length - failedRows + duplicateInFile.length;
                const biggest = failed.reduce((a, b) => (b.items.length > a.items.length ? b : a));
                // The message is written to stand on its own, so an existing client that only
                // renders `message` still shows the user what to fix and where.
                const EXAMPLES_PER_ISSUE = 3;
                const n = (v) => v.toLocaleString('en-US');
                const sections = failed.map((b, i) => {
                    const examples = b.items.slice(0, EXAMPLES_PER_ISSUE).map(it => {
                        const where = it.row > 0 ? `row ${it.row}` : 'file';
                        const what = it.iccid ? ` (ICCID ${it.iccid})` : '';
                        return `     - ${where}${what}: ${it.detail ?? b.label}`;
                    });
                    const rest = b.items.length - examples.length;
                    if (rest > 0)
                        examples.push(`     - ...and ${n(rest)} more row(s) with this problem`);
                    return `${i + 1}. ${b.label} - ${n(b.items.length)} row(s)\n` +
                        `   How to fix: ${b.action}\n` +
                        `   Examples:\n${examples.join('\n')}`;
                });
                const err = new Error(`Upload rejected. ${n(failedRows)} of ${n(rows.length)} row(s) could not be processed, ` +
                    `so nothing was saved and no cards were changed.\n` +
                    (readyRows > 0
                        ? `${n(readyRows)} row(s) are already correct and will go through once the problems below are fixed.\n`
                        : '') +
                    `\nProblems found:\n\n${sections.join('\n\n')}\n\n` +
                    `Fix these rows in the Excel file and upload it again. ` +
                    `The whole file is processed together, so every problem must be resolved before any sale is recorded.`);
                err.status = 422;
                err.details = {
                    totalRows: rows.length,
                    checkedRows: parsed.length,
                    failedRows,
                    readyRows: Math.max(0, readyRows),
                    errors: Object.fromEntries(failed.map(b => [b.code, { label: b.label, action: b.action, ...errorBucket(b.items) }]))
                };
                throw err;
            }
            const newNumbers = toCreate.filter(r => !numberMap.has(r.msisdn));
            const result = await prisma_1.default.$transaction(async (tx) => {
                const soldAt = new Date();
                let batchCode = null;
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
                                    batchCode: batchCode,
                                    remark: 'AUTO_CREATED_FROM_SOLD_UPLOAD'
                                }))
                            });
                        }
                    }
                    const createMsisdns = toCreate.map(r => r.msisdn);
                    const createIccids = toCreate.map(r => r.iccid);
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
                                sourceCode: r.storeCode,
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
                                userCode,
                                TRN: r.trn,
                                soldAt,
                                verifiedAt: soldAt
                            }))
                        });
                    }
                }
                let verified = 0;
                const pending = toVerify.filter(k => mergeMap.get(k).verifiedAt === null);
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
        }
        catch (error) {
            next(error);
        }
    }
    static async downloadExcel(req, res, next) {
        try {
        }
        catch (error) {
            next(error);
        }
    }
    static async validateCard(req, res, next) {
        try {
            const { key } = req.params;
            const { status } = req.body;
            const rawStatus = Array.isArray(status) ? status[0] : status;
            const card = await prisma_1.default.$transaction(async (tx) => {
                if (!req.user) {
                    throw new Error('User not found');
                }
                const validTargetStatuses = ['VERIFIED', 'BROKEN'];
                if (!rawStatus || !validTargetStatuses.includes(rawStatus)) {
                    const err = new Error("Status must be 'VERIFIED' or 'BROKEN'");
                    err.status = 400;
                    throw err;
                }
                const nextStatus = rawStatus;
                let updateData = {
                    status: nextStatus
                };
                const card = await tx.card.findUnique({
                    where: { key: key },
                    include: { uploadBatch: true }
                });
                if (!card) {
                    const err = new Error('Card not found');
                    err.status = 404;
                    throw err;
                }
                const allowed = req.checkpointCodes ?? [];
                if (!(0, access_util_1.hasCheckpointAccess)(card.checkpointCode, allowed)) {
                    const err = new Error('Card not found');
                    err.status = 404;
                    throw err;
                }
                if (!card.uploadBatch) {
                    const err = new Error('Card upload batch not found');
                    err.status = 404;
                    throw err;
                }
                if (card.uploadBatch.status === "COMPLETED") {
                    const err = new Error('Card upload batch is already completed');
                    err.status = 409;
                    throw err;
                }
                if (card.status === 'OPNAME') {
                    const err = new Error('Card is currently in an opname session and cannot be modified');
                    err.status = 409;
                    throw err;
                }
                if (card.status === 'DELIVERY') {
                    const err = new Error('Card is currently in delivery and cannot be modified');
                    err.status = 409;
                    throw err;
                }
                if (card.status === 'SOLD') {
                    const err = new Error('Card has already been sold');
                    err.status = 409;
                    throw err;
                }
                if (card.status !== 'UNVERIFIED') {
                    const err = new Error(`Card has already been validated`);
                    err.status = 409;
                    throw err;
                }
                if (card.status === "UNVERIFIED") {
                    updateData.validatedAt = new Date();
                }
                const updatedCard = await tx.card.update({
                    where: { key: key },
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
                        });
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
                        ]);
                    }
                }
                else if (card.status === "VERIFIED") {
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
                        ]);
                    }
                }
                else {
                    const err = new Error('Invalid card status transition');
                    err.status = 400;
                    throw err;
                }
                return updatedCard;
            });
            res.status(200).json({
                message: 'Card validated successfully',
                data: { card }
            });
        }
        catch (error) {
            next(error);
        }
    }
    static async bulkMergeSim(req, res, next) {
        try {
            const { sims, checkpointCode, type, trn } = req.body;
            if (!req.user)
                throw new Error('User not found');
            if (!Array.isArray(sims) || sims.length === 0) {
                const err = new Error('sims must be a non-empty array');
                err.status = 400;
                throw err;
            }
            if (!type) {
                const err = new Error('Type is required');
                err.status = 400;
                throw err;
            }
            if (type === 'SIMCARD' && sims.some((s) => !s.cardKey)) {
                const err = new Error('ICCID is required for SIMCARD type');
                err.status = 400;
                throw err;
            }
            if (!checkpointCode) {
                const err = new Error('Checkpoint code is required');
                err.status = 400;
                throw err;
            }
            if (!trn) {
                const err = new Error('TRN is required');
                err.status = 400;
                throw err;
            }
            const allowed = req.checkpointCodes ?? [];
            if (!(0, access_util_1.hasCheckpointAccess)(checkpointCode, allowed)) {
                const err = new Error('Checkpoint not found');
                err.status = 404;
                throw err;
            }
            const results = await prisma_1.default.$transaction(async (tx) => {
                const checkpoint = await tx.checkpoint.findUnique({ where: { code: checkpointCode } });
                if (!checkpoint) {
                    const err = new Error(`Checkpoint not found: ${checkpointCode}`);
                    err.status = 404;
                    throw err;
                }
                const merged = [];
                for (const { cardKey, numberKey } of sims) {
                    if (type === 'SIMCARD' || type === 'ESIM') {
                        const number = await tx.number.findUnique({ where: { key: numberKey, status: 'VERIFIED' } });
                        if (!number) {
                            const err = new Error(`Number not found or not verified: ${numberKey}`);
                            err.status = 404;
                            throw err;
                        }
                        if (number.checkpointCode !== null && number.checkpointCode !== checkpointCode) {
                            const err = new Error(`Number ${numberKey} belongs to a different checkpoint`);
                            err.status = 409;
                            throw err;
                        }
                        await tx.number.update({ where: { key: numberKey }, data: { status: 'SOLD' } });
                    }
                    let esimCode = '';
                    if (type === 'ESIM') {
                        esimCode = 'ESIM-' + (Date.now().toString(36) + Math.random().toString(36).slice(2, 6)).toUpperCase();
                    }
                    else if (type === 'CPP') {
                        esimCode = 'CPP-' + (Date.now().toString(36) + Math.random().toString(36).slice(2, 6)).toUpperCase();
                    }
                    else if (type === 'MIGRATION') {
                        esimCode = 'MGR-' + (Date.now().toString(36) + Math.random().toString(36).slice(2, 6)).toUpperCase();
                    }
                    else {
                        esimCode = cardKey;
                    }
                    if (type === 'SIMCARD') {
                        const card = await tx.card.findUnique({ where: { key: cardKey, status: 'VERIFIED' } });
                        if (!card) {
                            const err = new Error(`Card not found or not verified: ${cardKey}`);
                            err.status = 404;
                            throw err;
                        }
                        if (checkpoint.code !== card.checkpointCode) {
                            const err = new Error(`Card ${cardKey} is not at checkpoint ${checkpointCode}`);
                            err.status = 409;
                            throw err;
                        }
                        await tx.card.update({ where: { key: cardKey }, data: { status: 'SOLD' } });
                        const stock = await tx.cardStock.findFirst({
                            where: { checkpointCode: card.checkpointCode },
                            orderBy: { createdAt: 'desc' }
                        });
                        if (!stock || Number(stock.amount) <= 0) {
                            const err = new Error(`No stock available at checkpoint ${checkpointCode}`);
                            err.status = 409;
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
                                    userCode: req.user.code,
                                    sourceCode: card.checkpointCode,
                                    targetCode: null
                                }
                            })
                        ]);
                        merged.push(await tx.merge.create({
                            data: { cardKey, numberKey, checkpointCode, userCode: req.user.code, TRN: trn, soldAt: new Date() }
                        }));
                    }
                    else {
                        merged.push(await tx.mergeAdditional.create({
                            data: { cardKey: esimCode, numberKey, checkpointCode, userCode: req.user.code, TRN: trn, type, soldAt: new Date() }
                        }));
                    }
                }
                return merged;
            });
            res.status(200).json({
                message: 'Sims successfully merged',
                data: { merges: results }
            });
        }
        catch (error) {
            next(error);
        }
    }
    static async mergeSim(req, res, next) {
        try {
            const { cardKey, numberKey, checkpointCode, type, trn } = req.body;
            if (!req.user)
                throw new Error('User not found');
            if (!type) {
                const err = new Error('Type is required');
                err.status = 400;
                throw err;
            }
            if (type === 'SIMCARD' && !cardKey) {
                const err = new Error('ICCID is required for SIMCARD type');
                err.status = 400;
                throw err;
            }
            if (!checkpointCode) {
                const err = new Error('Checkpoint code is required');
                err.status = 400;
                throw err;
            }
            if (!trn) {
                const err = new Error('TRN is required');
                err.status = 400;
                throw err;
            }
            const allowed = req.checkpointCodes ?? [];
            if (!(0, access_util_1.hasCheckpointAccess)(checkpointCode, allowed)) {
                const err = new Error('Checkpoint not found');
                err.status = 404;
                throw err;
            }
            const sim = await prisma_1.default.$transaction(async (tx) => {
                const checkpoint = await tx.checkpoint.findUnique({ where: { code: checkpointCode } });
                if (!checkpoint) {
                    const err = new Error('Checkpoint not found');
                    err.status = 404;
                    throw err;
                }
                if (type === "SIMCARD" || type === "ESIM") {
                    const number = await tx.number.findUnique({ where: { key: numberKey, status: "VERIFIED" } });
                    if (!number) {
                        const err = new Error('Number not found or not verified');
                        err.status = 404;
                        throw err;
                    }
                    if (number.checkpointCode !== null && number.checkpointCode !== checkpointCode) {
                        const err = new Error('Number belongs to a different checkpoint');
                        err.status = 409;
                        throw err;
                    }
                    await tx.number.update({ where: { key: numberKey }, data: { status: 'SOLD' } });
                }
                if (type === "SIMCARD") {
                    const card = await tx.card.findUnique({ where: { key: cardKey, status: "VERIFIED" } });
                    if (!card) {
                        const err = new Error('Card not found or not verified');
                        err.status = 404;
                        throw err;
                    }
                    if (checkpoint.code !== card.checkpointCode) {
                        const err = new Error('Card is not at the specified checkpoint');
                        err.status = 409;
                        throw err;
                    }
                    await tx.card.update({ where: { key: cardKey }, data: { status: 'SOLD' } });
                    const stock = await tx.cardStock.findFirst({
                        where: { checkpointCode: card.checkpointCode },
                        orderBy: { createdAt: 'desc' }
                    });
                    if (!stock || Number(stock.amount) <= 0) {
                        const err = new Error('No stock available at this checkpoint');
                        err.status = 409;
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
                                userCode: req.user.code,
                                sourceCode: card.checkpointCode,
                                targetCode: null
                            }
                        })
                    ]);
                }
                let esimCode = "";
                if (type === "ESIM") {
                    esimCode = "ESIM-" + (Date.now().toString(36) + Math.random().toString(36).slice(2, 6)).toUpperCase();
                }
                else if (type === "CPP") {
                    esimCode = "CPP-" + (Date.now().toString(36) + Math.random().toString(36).slice(2, 6)).toUpperCase();
                }
                else if (type === "MIGRATION") {
                    esimCode = "MGR-" + (Date.now().toString(36) + Math.random().toString(36).slice(2, 6)).toUpperCase();
                }
                else {
                    esimCode = cardKey;
                }
                let sim;
                if (type === "SIMCARD") {
                    sim = await tx.merge.create({
                        data: {
                            cardKey,
                            numberKey,
                            checkpointCode,
                            userCode: req.user.code,
                            TRN: trn,
                            soldAt: new Date()
                        }
                    });
                }
                else {
                    sim = await tx.mergeAdditional.create({
                        data: {
                            cardKey: esimCode,
                            numberKey,
                            checkpointCode,
                            userCode: req.user.code,
                            TRN: trn,
                            type,
                            soldAt: new Date()
                        }
                    });
                }
                return sim;
            });
            res.status(200).json({
                message: 'Sim successfully merged',
                data: { sim }
            });
        }
        catch (error) {
            next(error);
        }
    }
    // ============================================================================
    // NUMBER CRUD OPERATIONS
    // ============================================================================
    static async createNumber(req, res, next) {
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
        }
        catch (error) {
            next(error);
        }
    }
    static async getNumbers(req, res, next) {
        try {
            const { page = 1, limit = 10, checkpointCode, status, search, remark, sort } = req.query;
            const circleCode = req.user.circleCode;
            // Numbers with no checkpoint are globally visible (available stock);
            // numbers with a checkpoint are restricted to the user's circle.
            const where = {
                AND: [
                    { OR: [{ checkpoint: (0, access_util_1.checkpointInCircle)(circleCode, checkpointCode) }, { checkpointCode: null }] }
                ]
            };
            if (status)
                where.status = status;
            if (search) {
                where.OR = [
                    { key: { contains: search } },
                    { name: { contains: search } }
                ];
            }
            if (remark) {
                where.remark = {
                    contains: remark
                };
            }
            if (sort && sort !== "ASC" && sort !== "DESC") {
                const err = new Error("sort must be 'ASC' or 'DESC'");
                err.status = 400;
                throw err;
            }
            const [numbers, total] = await Promise.all([
                prisma_1.default.number.findMany({
                    where,
                    skip: (Number(page) - 1) * Number(limit),
                    take: Number(limit),
                    include: {
                        checkpoint: true,
                        merge: true
                    },
                    orderBy: { createdAt: sort === 'ASC' ? 'asc' : 'desc' }
                }),
                prisma_1.default.number.count({ where })
            ]);
            const numberAmountWhere = {
                OR: [
                    { checkpoint: (0, access_util_1.checkpointInCircle)(circleCode, checkpointCode) },
                    { checkpointCode: null }
                ]
            };
            const mergeAmountWhere = { checkpoint: (0, access_util_1.checkpointInCircle)(circleCode) };
            const [totalUpload, totalAvailable, totalMerge, monthlyMerge, dailyMerge] = await Promise.all([
                prisma_1.default.number.count({ where: numberAmountWhere }),
                prisma_1.default.number.count({ where: { ...numberAmountWhere, status: "VERIFIED" } }),
                prisma_1.default.merge.count({ where: mergeAmountWhere }),
                prisma_1.default.merge.count({
                    where: {
                        ...mergeAmountWhere,
                        createdAt: { gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1) }
                    }
                }),
                prisma_1.default.merge.count({
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
        }
        catch (error) {
            next(error);
        }
    }
    static async getNumber(req, res, next) {
        try {
            const { key } = req.params;
            const allowed = req.checkpointCodes ?? [];
            const number = await prisma_1.default.number.findUnique({
                where: { key: key },
                include: {
                    checkpoint: true,
                    movements: {
                        include: { number: true },
                        orderBy: { createdAt: 'desc' }
                    }
                }
            });
            // allowNull=true: a number with no checkpoint is accessible to everyone
            if (!number || !(0, access_util_1.hasCheckpointAccess)(number.checkpointCode, allowed, true)) {
                const err = new Error('Number not found');
                err.status = 404;
                throw err;
            }
            res.status(200).json({
                message: 'Number retrieved successfully',
                data: { number }
            });
        }
        catch (error) {
            next(error);
        }
    }
    static async updateNumber(req, res, next) {
        try {
            const { key } = req.params;
            const { name, status, remark } = req.body;
            const allowed = req.checkpointCodes ?? [];
            const existing = await prisma_1.default.number.findUnique({ where: { key: key } });
            if (!existing || !(0, access_util_1.hasCheckpointAccess)(existing.checkpointCode, allowed, true)) {
                const err = new Error('Number not found');
                err.status = 404;
                throw err;
            }
            const number = await prisma_1.default.number.update({
                where: { key: key },
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
        }
        catch (error) {
            next(error);
        }
    }
    static async deleteNumber(req, res, next) {
        try {
            const { key } = req.params;
            const allowed = req.checkpointCodes ?? [];
            const existing = await prisma_1.default.number.findUnique({ where: { key: key } });
            if (!existing || !(0, access_util_1.hasCheckpointAccess)(existing.checkpointCode, allowed, true)) {
                const err = new Error('Number not found');
                err.status = 404;
                throw err;
            }
            await prisma_1.default.number.delete({
                where: { key: key }
            });
            res.status(200).json({
                message: 'Number deleted successfully'
            });
        }
        catch (error) {
            next(error);
        }
    }
    static async getMerges(req, res, next) {
        try {
            const { page = 1, limit = 10, checkpointCode, startSoldAt, endSoldAt, cardRemark, search, type } = req.query;
            const circleCode = req.user.circleCode;
            let where = {
                checkpoint: (0, access_util_1.checkpointInCircle)(circleCode, checkpointCode)
            };
            if (startSoldAt) {
                where.createdAt = {
                    gte: new Date(new Date(startSoldAt).setHours(0, 0, 0, 0))
                };
            }
            if (endSoldAt) {
                where.createdAt = {
                    ...where.createdAt,
                    lte: new Date(new Date(endSoldAt).setHours(23, 59, 59, 999))
                };
            }
            const isSimcardQuery = type === "SIMCARD" || !type;
            if (cardRemark && isSimcardQuery) {
                where.number = { remark: cardRemark };
            }
            if (search) {
                if (isSimcardQuery) {
                    where.number = { ...where.number, key: { contains: search } };
                }
                else {
                    where.cardKey = { contains: search };
                }
            }
            let merges;
            if (isSimcardQuery) {
                merges = await prisma_1.default.merge.findMany({
                    skip: (Number(page) - 1) * Number(limit),
                    take: Number(limit),
                    orderBy: { createdAt: 'desc' },
                    where,
                    include: { number: true }
                });
            }
            else {
                merges = await prisma_1.default.mergeAdditional.findMany({
                    skip: (Number(page) - 1) * Number(limit),
                    take: Number(limit),
                    orderBy: { createdAt: 'desc' },
                    where
                });
            }
            const baseCountWhere = { checkpoint: (0, access_util_1.checkpointInCircle)(circleCode) };
            const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
            const dayStart = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());
            const [total, monthly, daily] = isSimcardQuery
                ? await Promise.all([
                    prisma_1.default.merge.count({ where: baseCountWhere }),
                    prisma_1.default.merge.count({ where: { ...baseCountWhere, createdAt: { gte: monthStart } } }),
                    prisma_1.default.merge.count({ where: { ...baseCountWhere, createdAt: { gte: dayStart } } })
                ])
                : await Promise.all([
                    prisma_1.default.mergeAdditional.count({ where: baseCountWhere }),
                    prisma_1.default.mergeAdditional.count({ where: { ...baseCountWhere, createdAt: { gte: monthStart } } }),
                    prisma_1.default.mergeAdditional.count({ where: { ...baseCountWhere, createdAt: { gte: dayStart } } })
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
        }
        catch (error) {
            next(error);
        }
    }
}
exports.default = StockController;
