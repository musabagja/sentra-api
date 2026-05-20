"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const prisma_1 = __importDefault(require("../../lib/prisma"));
const access_util_1 = require("../utils/access.util");
class OpnameController {
    static async updateOpnameProgress(req, res, next) {
        try {
            const { id } = req.params;
            const { status, cardKey } = req.body;
            const allowed = req.checkpointCodes ?? [];
            const updatedOpname = await prisma_1.default.$transaction(async (tx) => {
                const [opname, card] = await Promise.all([
                    tx.opname.findUnique({ where: { id: Number(id) } }),
                    tx.card.findUnique({ where: { key: cardKey } })
                ]);
                if (!opname || !(0, access_util_1.hasCheckpointAccess)(opname.checkpointCode, allowed)) {
                    const err = new Error('Opname not found');
                    err.status = 404;
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
                const [opnameProgresses, cardStock] = await Promise.all([
                    tx.opnameUpdate.findMany({
                        where: {
                            opnameID: Number(id)
                        }
                    }),
                    tx.cardStock.findFirst({
                        where: { checkpointCode: card.checkpointCode },
                        orderBy: { createdAt: 'desc' }
                    })
                ]);
                if (!cardStock) {
                    throw new Error('Card stock not found');
                }
                if (cardStock.amount <= 0) {
                    throw new Error('Card stock amount is zero');
                }
                const totalProgress = [...new Set(opnameProgresses.map(update => update.itemID))];
                await tx.opnameUpdate.create({
                    data: {
                        itemID: card.id,
                        status: status === "VERIFIED" ? "OK" : status,
                        opnameID: Number(id),
                        userCode: req.user.code
                    }
                });
                if (card.status === "VERIFIED") {
                    if (status !== "VERIFIED") {
                        await tx.cardStock.create({
                            data: {
                                amount: cardStock?.amount - 1,
                                checkpointCode: card.checkpointCode
                            }
                        });
                    }
                }
                else {
                    if (status === "VERIFIED") {
                        await tx.cardStock.create({
                            data: {
                                amount: cardStock?.amount + 1,
                                checkpointCode: card.checkpointCode
                            }
                        });
                    }
                }
                return await tx.opname.update({
                    where: { id: Number(id) },
                    data: { progress: totalProgress.length }
                });
            });
            res.status(200).json({
                message: 'Opname progress updated successfully',
                data: {
                    opname: updatedOpname
                }
            });
        }
        catch (error) {
            next(error);
        }
    }
    // ============================================================================
    // OPNAME CRUD OPERATIONS
    // ============================================================================
    static async createOpname(req, res, next) {
        try {
            const { checkpointCode } = req.body;
            const allowed = req.checkpointCodes ?? [];
            if (!(0, access_util_1.hasCheckpointAccess)(checkpointCode, allowed)) {
                const err = new Error('Checkpoint not found');
                err.status = 404;
                throw err;
            }
            const opname = await prisma_1.default.$transaction(async (tx) => {
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
                const batch = lastOpname && lastOpname.batch ? (Number(lastOpname.batch.split('/')[2]) + 1).toString() : `OP/${checkpointCode}/1`;
                const opname = await tx.opname.create({
                    data: {
                        amount,
                        progress: 0,
                        batch,
                        type: "ICCID",
                        checkpointCode,
                        status: "ONGOING",
                        userCode: req.user.code
                    },
                    include: {
                        updates: true
                    }
                });
                return opname;
            });
            res.status(201).json({
                message: 'Opname created successfully',
                data: {
                    opname
                }
            });
        }
        catch (error) {
            next(error);
        }
    }
    static async closeOpname(req, res, next) {
        try {
            const { id } = req.params;
            const allowed = req.checkpointCodes ?? [];
            const existing = await prisma_1.default.opname.findUnique({ where: { id: Number(id) } });
            if (!existing || !(0, access_util_1.hasCheckpointAccess)(existing.checkpointCode, allowed)) {
                const err = new Error('Opname not found');
                err.status = 404;
                throw err;
            }
            const opname = await prisma_1.default.opname.update({
                where: {
                    id: Number(id)
                },
                data: {
                    status: "COMPLETED"
                }
            });
            res.status(200).json({
                message: 'Opname closed successfully',
                data: {
                    opname
                }
            });
        }
        catch (error) {
            next(error);
        }
    }
    static async getOpnames(req, res, next) {
        try {
            const { page = 1, limit = 10, checkpointCode, type } = req.query;
            const allowed = req.checkpointCodes ?? [];
            const where = {
                checkpointCode: { in: (0, access_util_1.resolveCheckpointFilter)(checkpointCode, allowed) }
            };
            if (type)
                where.type = type;
            const [opnames, total] = await Promise.all([
                prisma_1.default.opname.findMany({
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
                prisma_1.default.opname.count({ where })
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
        }
        catch (error) {
            next(error);
        }
    }
    static async getOpname(req, res, next) {
        try {
            const { id } = req.params;
            const allowed = req.checkpointCodes ?? [];
            const opname = await prisma_1.default.opname.findUnique({
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
            if (!opname || !(0, access_util_1.hasCheckpointAccess)(opname.checkpointCode, allowed)) {
                const err = new Error('Opname not found');
                err.status = 404;
                throw err;
            }
            res.status(200).json({
                message: 'Opname retrieved successfully',
                data: {
                    opname
                }
            });
        }
        catch (error) {
            next(error);
        }
    }
    static async updateOpname(req, res, next) {
        try {
            const { id } = req.params;
            const { status } = req.body;
            const allowed = req.checkpointCodes ?? [];
            const existing = await prisma_1.default.opname.findUnique({ where: { id: Number(id) } });
            if (!existing || !(0, access_util_1.hasCheckpointAccess)(existing.checkpointCode, allowed)) {
                const err = new Error('Opname not found');
                err.status = 404;
                throw err;
            }
            const opname = await prisma_1.default.opname.update({
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
        }
        catch (error) {
            next(error);
        }
    }
    static async deleteOpname(req, res, next) {
        try {
            const { id } = req.params;
            const allowed = req.checkpointCodes ?? [];
            const existing = await prisma_1.default.opname.findUnique({ where: { id: Number(id) } });
            if (!existing || !(0, access_util_1.hasCheckpointAccess)(existing.checkpointCode, allowed)) {
                const err = new Error('Opname not found');
                err.status = 404;
                throw err;
            }
            await prisma_1.default.opname.delete({
                where: { id: Number(id) }
            });
            res.status(200).json({
                message: 'Opname deleted successfully'
            });
        }
        catch (error) {
            next(error);
        }
    }
}
exports.default = OpnameController;
