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
class StockController {
    static async dashboardSync(req, res, next) {
        try {
            const allowed = req.checkpointCodes ?? [];
            const scopeFilter = {
                status: 'DELIVERED',
                OR: [{ sourceCode: { in: allowed } }, { targetCode: { in: allowed } }]
            };
            const [dcAggregate, storeAggregate, allCheckpoints, baseInitialCount, brokenLostCards, topSaleByUser] = await Promise.all([
                // 1. Cards distributed TO DC checkpoints
                prisma_1.default.distribution.aggregate({
                    _sum: { amount: true },
                    where: { ...scopeFilter, target: { type: 'DC' } }
                }),
                // 2. Cards distributed TO STORE checkpoints
                prisma_1.default.distribution.aggregate({
                    _sum: { amount: true },
                    where: { ...scopeFilter, target: { type: 'STORE' } }
                }),
                // Shared checkpoint fetch — split into STORE/DC in JS
                prisma_1.default.checkpoint.findMany({
                    where: { code: { in: allowed } },
                    include: { cardStock: { orderBy: { createdAt: 'desc' }, take: 1 } }
                }),
                // 5a. Base initial stock: VERIFIED + SOLD + DELIVERY + OPNAME
                prisma_1.default.card.count({
                    where: { checkpointCode: { in: allowed }, status: { in: ['VERIFIED', 'SOLD', 'DELIVERY', 'OPNAME'] } }
                }),
                // 5b. BROKEN/LOST candidates — need to check if opname-traced
                prisma_1.default.card.findMany({
                    where: { checkpointCode: { in: allowed }, status: { in: ['BROKEN', 'LOST'] } },
                    select: { id: true }
                }),
                // Top 10 users by total sales (merges) within scope
                prisma_1.default.merge.groupBy({
                    by: ['userCode'],
                    where: { checkpointCode: { in: allowed } },
                    _count: { userCode: true },
                    orderBy: { _count: { userCode: 'desc' } },
                    take: 10
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
                    ? prisma_1.default.opnameUpdate.groupBy({
                        by: ['itemID'],
                        where: { itemID: { in: brokenLostIds } }
                    }).then(groups => groups.length)
                    : Promise.resolve(0),
                // Top 10 STORE checkpoints by total sales (merges)
                prisma_1.default.merge.groupBy({
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
                ? await prisma_1.default.user.findMany({
                    where: { code: { in: topUserCodes } },
                    select: { code: true, name: true }
                })
                : [];
            const userDetailMap = Object.fromEntries(topUserDetails.map(u => [u.code, u]));
            const initialStock = baseInitialCount + opnamedBrokenLostCount;
            // 6. Final stock: sum of latest CardStock per checkpoint
            //    (already nets out sales, opname BROKEN/LOST, and adjustments)
            const finalStock = allCheckpoints.reduce((sum, c) => sum + (c.cardStock[0]?.amount ?? 0), 0);
            const withStock = (c) => ({ ...c, currentStock: c.cardStock[0]?.amount ?? 0 });
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
                checkpoint: checkpointMap[row.checkpointCode],
                totalSales: row._count.checkpointCode
            }));
            // Top 10 users ranked by highest sales
            const topHighestSaleByUser = topSaleByUser.map(row => ({
                user: userDetailMap[row.userCode] ?? { code: row.userCode, name: null },
                totalSales: row._count.userCode
            }));
            res.status(200).json({
                message: 'Dashboard synced successfully',
                data: {
                    initialStock,
                    finalStock,
                    distributedToDC: dcAggregate._sum.amount ?? 0,
                    distributedToStore: storeAggregate._sum.amount ?? 0,
                    topLeastStoreStock,
                    topMostDCStock,
                    topHighestSaleByCheckpoint,
                    topHighestSaleByUser
                }
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
            const allowed = req.checkpointCodes ?? [];
            const allowedStatus = ['ONGOING', 'COMPLETED'];
            if (status && !allowedStatus.includes(status)) {
                throw new Error('Invalid status');
            }
            const where = {
                cards: { some: { checkpointCode: { in: allowed } } }
            };
            if (status) {
                where.status = status;
            }
            if (search) {
                where.OR = [
                    { code: { contains: search, mode: 'insensitive' } },
                    { name: { contains: search, mode: 'insensitive' } }
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
                prisma_1.default.card.count({ where: { checkpointCode: { in: allowed } } }),
                prisma_1.default.card.count({ where: { checkpointCode: { in: allowed }, status: 'VERIFIED' } }),
                prisma_1.default.card.count({ where: { checkpointCode: { in: allowed }, status: 'UNVERIFIED' } })
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
            const { note } = req.body;
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
            const allowed = req.checkpointCodes ?? [];
            const where = {
                // Scope to checkpoints in the user's circle; intersect with any requested checkpointCode
                checkpointCode: { in: (0, access_util_1.resolveCheckpointFilter)(checkpointCode, allowed) }
            };
            if (status)
                where.status = status;
            if (search) {
                where.OR = [
                    { key: { contains: search, mode: 'insensitive' } },
                    { name: { contains: search, mode: 'insensitive' } }
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
                        code: { contains: batch, mode: 'insensitive' }
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
                prisma_1.default.card.count({ where: { checkpointCode: { in: allowed } } }),
                prisma_1.default.card.count({ where: { checkpointCode: { in: allowed }, status: "SOLD" } }),
                prisma_1.default.card.count({ where: { checkpointCode: { in: allowed }, status: "VERIFIED" } })
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
            const { id } = req.params;
            const allowed = req.checkpointCodes ?? [];
            const existing = await prisma_1.default.card.findUnique({ where: { id: Number(id) } });
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
                throw new Error('No file uploaded');
            }
            // Parse Excel outside the transaction — CPU-bound work should not hold a DB connection
            const workbook = xlsx.read(file.buffer, { type: 'buffer' });
            if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
                throw new Error('Excel file has no sheets');
            }
            const firstWorksheet = workbook.Sheets[workbook.SheetNames[0]];
            if (!firstWorksheet) {
                throw new Error('Worksheet not found');
            }
            const allowedSheets = ['ICCID', 'MSISDN'];
            const parsedSheets = [];
            for (const sheet of workbook.SheetNames) {
                const sheetData = workbook.Sheets[sheet];
                if (!sheetData || !allowedSheets.includes(sheet))
                    continue;
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
                const seen = new Set();
                const data = rows
                    .flatMap((row) => {
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
                    .filter((item) => {
                    if (!item.key || item.key === 'undefined' || seen.has(item.key))
                        return false;
                    seen.add(item.key);
                    return true;
                });
                return { sheet, data };
            });
            const { totalCreated, parsedTotal } = await prisma_1.default.$transaction(async (tx) => {
                let batch;
                if (batchID) {
                    const existing = await tx.uploadBatch.findUnique({ where: { id: Number(batchID) } });
                    if (!existing)
                        throw new Error(`Batch with id ${batchID} not found`);
                    if (existing.status === 'COMPLETED')
                        throw new Error(`Batch with id ${batchID} is already completed`);
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
                const result = await Promise.all(jsonData.map(({ sheet, data }) => sheet === 'ICCID'
                    ? tx.card.createMany({ data: data, skipDuplicates: true })
                    : tx.number.createMany({ data, skipDuplicates: true })));
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
                    throw new Error("Please provide status, either 'VERIFIED' or 'BROKEN'");
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
                    throw new Error('Card not found');
                }
                const allowed = req.checkpointCodes ?? [];
                if (!(0, access_util_1.hasCheckpointAccess)(card.checkpointCode, allowed)) {
                    const err = new Error('Card not found');
                    err.status = 404;
                    throw err;
                }
                if (!card.uploadBatch) {
                    throw new Error('Card upload batch not found');
                }
                if (card.uploadBatch.status === "COMPLETED") {
                    throw new Error('Card upload batch is already completed');
                }
                if (card.status === 'OPNAME') {
                    throw new Error('Card is currently in an opname session and cannot be modified');
                }
                if (card.status === 'DELIVERY') {
                    throw new Error('Card is currently in delivery and cannot be modified');
                }
                if (card.status === 'SOLD') {
                    throw new Error('Card has already been sold');
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
                        // Use a locked read so concurrent validations on the same checkpoint
                        // don't both read the same amount and lose increments.
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
                    throw new Error('Invalid status');
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
            if (!Array.isArray(sims) || sims.length === 0)
                throw new Error('sims must be a non-empty array');
            if (!type)
                throw new Error('Type is required');
            if (type === 'SIMCARD' && sims.some((s) => !s.cardKey))
                throw new Error('ICCID is required for SIMCARD type');
            if (!checkpointCode)
                throw new Error('Checkpoint code is required');
            if (!trn)
                throw new Error('TRN is required');
            const allowed = req.checkpointCodes ?? [];
            if (!(0, access_util_1.hasCheckpointAccess)(checkpointCode, allowed)) {
                const err = new Error('Checkpoint not found');
                err.status = 404;
                throw err;
            }
            const results = await prisma_1.default.$transaction(async (tx) => {
                const checkpoint = await tx.checkpoint.findUnique({ where: { code: checkpointCode } });
                if (!checkpoint)
                    throw new Error(`Checkpoint not found: ${checkpointCode}`);
                const merged = [];
                for (const { cardKey, numberKey } of sims) {
                    if (type === 'SIMCARD' || type === 'ESIM') {
                        const number = await tx.number.findUnique({ where: { key: numberKey, status: 'VERIFIED' } });
                        if (!number)
                            throw new Error(`Number not found or not verified: ${numberKey}`);
                        if (number.checkpointCode !== null && number.checkpointCode !== checkpointCode) {
                            throw new Error(`Number checkpoint code does not match: ${numberKey}`);
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
                        if (!card)
                            throw new Error(`Card not found or not verified: ${cardKey}`);
                        if (checkpoint.code !== card.checkpointCode) {
                            throw new Error(`Checkpoint code does not match card checkpoint code: ${cardKey}`);
                        }
                        await tx.card.update({ where: { key: cardKey }, data: { status: 'SOLD' } });
                        const stock = await tx.cardStock.findFirst({
                            where: { checkpointCode: card.checkpointCode },
                            orderBy: { createdAt: 'desc' }
                        });
                        if (!stock || Number(stock.amount) <= 0) {
                            throw new Error(`Card unavailable at checkpoint: ${checkpointCode}`);
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
            if (!type)
                throw new Error('Type is required');
            if (type === 'SIMCARD' && !cardKey)
                throw new Error('ICCID is required for SIMCARD type');
            if (!checkpointCode)
                throw new Error('Checkpoint code is required');
            if (!trn)
                throw new Error('TRN is required');
            const allowed = req.checkpointCodes ?? [];
            if (!(0, access_util_1.hasCheckpointAccess)(checkpointCode, allowed)) {
                const err = new Error('Checkpoint not found');
                err.status = 404;
                throw err;
            }
            const sim = await prisma_1.default.$transaction(async (tx) => {
                const checkpoint = await tx.checkpoint.findUnique({ where: { code: checkpointCode } });
                if (!checkpoint)
                    throw new Error('Checkpoint not found');
                if (type === "SIMCARD" || type === "ESIM") {
                    const number = await tx.number.findUnique({ where: { key: numberKey, status: "VERIFIED" } });
                    if (!number) {
                        throw new Error('Number not found');
                    }
                    if (number.checkpointCode !== null && number.checkpointCode !== checkpointCode) {
                        throw new Error('Number checkpoint code does not match checkpoint code');
                    }
                    await tx.number.update({ where: { key: numberKey }, data: { status: 'SOLD' } });
                }
                if (type === "SIMCARD") {
                    const card = await tx.card.findUnique({ where: { key: cardKey, status: "VERIFIED" } });
                    if (!card) {
                        throw new Error('Card not found');
                    }
                    if (checkpoint.code !== card.checkpointCode) {
                        throw new Error('Checkpoint code does not match card checkpoint code');
                    }
                    await tx.card.update({ where: { key: cardKey }, data: { status: 'SOLD' } });
                    const stock = await tx.cardStock.findFirst({
                        where: { checkpointCode: card.checkpointCode },
                        orderBy: { createdAt: 'desc' }
                    });
                    if (!stock || Number(stock.amount) <= 0) {
                        throw new Error('Card unavailable');
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
            const allowed = req.checkpointCodes ?? [];
            const checkpointFilter = (0, access_util_1.resolveCheckpointFilter)(checkpointCode, allowed);
            // Numbers with no checkpoint are globally visible (available stock);
            // numbers with a checkpoint are restricted to the user's circle.
            const where = {
                AND: [
                    { OR: [{ checkpointCode: { in: checkpointFilter } }, { checkpointCode: null }] }
                ]
            };
            if (status)
                where.status = status;
            if (search) {
                where.OR = [
                    { key: { contains: search, mode: 'insensitive' } },
                    { name: { contains: search, mode: 'insensitive' } }
                ];
            }
            if (remark) {
                where.remark = {
                    contains: remark, mode: 'insensitive'
                };
            }
            if (sort) {
                if (sort !== "ASC" && sort !== "DESC") {
                    throw new Error("Sort field can only be filled with 'ASC' or 'DESC'");
                }
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
                    { checkpointCode: { in: checkpointFilter } },
                    { checkpointCode: null }
                ]
            };
            const mergeAmountWhere = { checkpointCode: { in: allowed } };
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
            const allowed = req.checkpointCodes ?? [];
            let where = {
                checkpointCode: { in: (0, access_util_1.resolveCheckpointFilter)(checkpointCode, allowed) }
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
            if (search && isSimcardQuery) {
                where.number = { ...where.number, key: { contains: search } };
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
            const baseCountWhere = { checkpointCode: { in: allowed } };
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
