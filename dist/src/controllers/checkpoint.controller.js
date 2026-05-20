"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const prisma_1 = __importDefault(require("../../lib/prisma"));
const access_util_1 = require("../utils/access.util");
class CheckpointController {
    static async createCheckpoint(req, res, next) {
        try {
            const { code, type, name } = req.body;
            const checkpoint = await prisma_1.default.checkpoint.create({
                data: { code, type, name }
            });
            res.status(201).json({
                message: 'Checkpoint created successfully',
                data: { checkpoint }
            });
        }
        catch (error) {
            next(error);
        }
    }
    static async getCheckpoints(req, res, next) {
        try {
            const { page = 1, limit = 10, type, search, startSoldAt, endSoldAt } = req.query;
            const allowed = req.checkpointCodes ?? [];
            const where = {
                // Scope to the checkpoints the user's circle covers
                code: { in: allowed }
            };
            if (type) {
                where.type = type;
            }
            if (search) {
                where.OR = [
                    { code: { contains: search, mode: 'insensitive' } },
                    { name: { contains: search, mode: 'insensitive' } }
                ];
            }
            const includeMerges = !!(startSoldAt || endSoldAt);
            const mergesWhere = {};
            if (startSoldAt) {
                mergesWhere.createdAt = {
                    gte: new Date(new Date(startSoldAt).setHours(0, 0, 0, 0))
                };
            }
            if (endSoldAt) {
                mergesWhere.createdAt = {
                    ...(mergesWhere.createdAt || {}),
                    lte: new Date(new Date(endSoldAt).setHours(23, 59, 59, 999))
                };
            }
            const findManyOptions = {
                where,
                skip: (Number(page) - 1) * Number(limit),
                take: Number(limit),
                include: {
                    _count: {
                        select: {
                            cards: true,
                            merges: includeMerges ? { where: mergesWhere } : true
                        }
                    }
                },
                orderBy: { createdAt: 'desc' }
            };
            const [checkpoints, total] = await Promise.all([
                prisma_1.default.checkpoint.findMany(findManyOptions),
                prisma_1.default.checkpoint.count({ where })
            ]);
            res.status(200).json({
                message: 'Checkpoints retrieved successfully',
                data: { checkpoints },
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
    static async getCheckpoint(req, res, next) {
        try {
            const { id } = req.params;
            const allowed = req.checkpointCodes ?? [];
            const checkpoint = await prisma_1.default.checkpoint.findUnique({
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
                    _count: { select: { cards: true } }
                }
            });
            if (!checkpoint || !(0, access_util_1.hasCheckpointAccess)(checkpoint.code, allowed)) {
                const err = new Error('Checkpoint not found');
                err.status = 404;
                throw err;
            }
            const [totalCard, totalSold, totalVerified] = await Promise.all([
                prisma_1.default.card.count({ where: { checkpointCode: checkpoint.code } }),
                prisma_1.default.card.count({ where: { checkpointCode: checkpoint.code, status: 'SOLD' } }),
                prisma_1.default.card.count({ where: { checkpointCode: checkpoint.code, status: 'VERIFIED' } })
            ]);
            res.status(200).json({
                message: 'Checkpoint retrieved successfully',
                data: {
                    checkpoint,
                    amount: { card: totalCard, sold: totalSold, verified: totalVerified }
                }
            });
        }
        catch (error) {
            next(error);
        }
    }
    static async updateCheckpoint(req, res, next) {
        try {
            const { id } = req.params;
            const { code, type, name } = req.body;
            const allowed = req.checkpointCodes ?? [];
            const existing = await prisma_1.default.checkpoint.findUnique({ where: { id: Number(id) } });
            if (!existing || !(0, access_util_1.hasCheckpointAccess)(existing.code, allowed)) {
                const err = new Error('Checkpoint not found');
                err.status = 404;
                throw err;
            }
            const checkpoint = await prisma_1.default.checkpoint.update({
                where: { id: Number(id) },
                data: {
                    ...(code && { code }),
                    ...(type && { type }),
                    ...(name && { name })
                }
            });
            res.status(200).json({
                message: 'Checkpoint updated successfully',
                data: { checkpoint }
            });
        }
        catch (error) {
            next(error);
        }
    }
    static async deleteCheckpoint(req, res, next) {
        try {
            const { id } = req.params;
            const allowed = req.checkpointCodes ?? [];
            const existing = await prisma_1.default.checkpoint.findUnique({ where: { id: Number(id) } });
            if (!existing || !(0, access_util_1.hasCheckpointAccess)(existing.code, allowed)) {
                const err = new Error('Checkpoint not found');
                err.status = 404;
                throw err;
            }
            await prisma_1.default.checkpoint.delete({ where: { id: Number(id) } });
            res.status(200).json({ message: 'Checkpoint deleted successfully' });
        }
        catch (error) {
            next(error);
        }
    }
}
exports.default = CheckpointController;
