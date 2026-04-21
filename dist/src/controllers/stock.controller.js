import prisma from '../../lib/prisma';
import * as xlsx from 'xlsx';
class StockController {
    // ============================================================================
    // CARD CRUD OPERATIONS
    // ============================================================================
    static async createCard(req, res, next) {
        try {
            // const { name, key, checkpointCode, status, remark } = req.body;
            // const card = await prisma.card.create({
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
            //   message: 'Card created successfully',
            //   data: card
            // });
        }
        catch (error) {
            next(error);
        }
    }
    static async getCards(req, res, next) {
        try {
            const { page = 1, limit = 10, checkpointCode, status, search } = req.query;
            const where = {};
            if (checkpointCode)
                where.checkpointCode = checkpointCode;
            if (status)
                where.status = status;
            if (search) {
                where.OR = [
                    { key: { contains: search, mode: 'insensitive' } },
                    { name: { contains: search, mode: 'insensitive' } }
                ];
            }
            const [cards, total] = await Promise.all([
                prisma.card.findMany({
                    where,
                    skip: (Number(page) - 1) * Number(limit),
                    take: Number(limit),
                    include: {
                        checkpoint: true,
                        movements: {
                            orderBy: { createdAt: 'desc' },
                            take: 3
                        }
                    },
                    orderBy: { createdAt: 'desc' }
                }),
                prisma.card.count({ where })
            ]);
            res.status(200).json({
                message: 'Cards retrieved successfully',
                data: cards,
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
            const { id } = req.params;
            const card = await prisma.card.findUnique({
                where: { id: Number(id) },
                include: {
                    checkpoint: true,
                    movements: {
                        include: {
                            card: true
                        },
                        orderBy: { createdAt: 'desc' }
                    }
                }
            });
            if (!card) {
                throw new Error('Card not found');
            }
            res.status(200).json({
                message: 'Card retrieved successfully',
                data: card
            });
        }
        catch (error) {
            next(error);
        }
    }
    static async updateCard(req, res, next) {
        try {
            const { id } = req.params;
            const { name, status, remark } = req.body;
            const card = await prisma.card.update({
                where: { id: Number(id) },
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
                message: 'Card updated successfully',
                data: card
            });
        }
        catch (error) {
            next(error);
        }
    }
    static async deleteCard(req, res, next) {
        try {
            const { id } = req.params;
            await prisma.card.delete({
                where: { id: Number(id) }
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
            // // Parse the XLSX file
            const workbook = xlsx.read(file.buffer, { type: 'buffer' });
            if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
                throw new Error('Excel file has no sheets');
            }
            const sheetName = workbook.SheetNames[0];
            const worksheet = workbook.Sheets[sheetName];
            const allowedSheets = ['ICCID', 'MSISDN'];
            let jsonResult = [];
            if (!worksheet) {
                throw new Error('Worksheet not found');
            }
            for (let sheet of workbook.SheetNames) {
                const sheetData = workbook.Sheets[sheet];
                if (!sheetData || !allowedSheets.includes(sheet))
                    continue;
                jsonResult.push({
                    sheet: sheet,
                    data: xlsx.utils.sheet_to_json(sheetData)
                });
            }
            const lastBatch = await prisma.uploadBatch.findFirst({
                orderBy: {
                    id: 'desc'
                }
            });
            const batchCode = lastBatch ? `UP${lastBatch.id + 1}` : `UP1`;
            const batch = await prisma.uploadBatch.create({
                data: {
                    code: batchCode,
                    userCode: req.user.code
                }
            });
            // Extract number data from the Excel file with batchCode
            const jsonData = jsonResult.map(each => ({
                sheet: each.sheet,
                data: each.data.map((row) => ({
                    key: String(row.KEY || row.key),
                    checkpointCode: (row.CHECKPOINT || row.checkpoint) ? String(row.CHECKPOINT || row.checkpoint) : null,
                    remark: row.REMARK || row.remark || '',
                    batchCode: batch.code
                })).filter((item) => item.key)
            }));
            // Bulk create cards and numbers with batchCode
            const result = await Promise.all(jsonData.map(each => {
                if (each.sheet === 'ICCID') {
                    return prisma.card.createMany({
                        data: each.data,
                        skipDuplicates: true
                    });
                }
                else {
                    return prisma.number.createMany({
                        data: each.data,
                        skipDuplicates: true
                    });
                }
            }));
            const totalCreated = result.reduce((sum, r) => sum + r.count, 0);
            // Delete the batch if no items were created
            if (totalCreated === 0) {
                await prisma.uploadBatch.delete({
                    where: {
                        code: batch.code
                    }
                });
            }
            res.status(200).json({
                message: 'Numbers uploaded successfully',
                data: {
                    total: jsonData.flatMap(each => each.data).length,
                    created: totalCreated
                }
            });
        }
        catch (error) {
            next(error);
        }
    }
    static async validateCard(req, res, next) {
        try {
            const { key } = req.params;
            const card = await prisma.$transaction(async (tx) => {
                if (!req.user) {
                    throw new Error('User not found');
                }
                const card = await tx.card.update({
                    where: {
                        key: key,
                        status: "UNVERIFIED"
                    },
                    data: {
                        status: "VERIFIED"
                    }
                });
                const [stock] = await Promise.all([
                    tx.cardStock.findFirst({
                        where: {
                            checkpointCode: card.checkpointCode
                        },
                        orderBy: {
                            createdAt: 'desc'
                        }
                    }),
                    tx.cardMovement.create({
                        data: {
                            cardID: card.id,
                            type: "INITIAL",
                            userCode: req.user.code,
                            sourceCode: null,
                            targetCode: card.checkpointCode
                        }
                    })
                ]);
                await tx.cardStock.create({
                    data: {
                        checkpointCode: card.checkpointCode,
                        amount: Number(stock?.amount || 0) + 1
                    }
                });
            });
            res.status(200).json({
                message: 'Card validated successfully',
                data: card
            });
        }
        catch (error) {
            next(error);
        }
    }
    static async mergeSim(req, res, next) {
        try {
            const { cardKey, numberKey } = req.body;
            const sim = await prisma.$transaction(async (tx) => {
                if (!req.user) {
                    throw new Error('User not found');
                }
                const [card, number] = await Promise.all([
                    tx.card.findUnique({
                        where: {
                            key: cardKey,
                            status: "VERIFIED"
                        }
                    }),
                    tx.number.findUnique({
                        where: {
                            key: numberKey,
                            status: "VERIFIED"
                        }
                    }),
                    tx.card.update({
                        where: {
                            key: cardKey
                        },
                        data: {
                            status: 'SOLD'
                        }
                    }),
                    tx.number.update({
                        where: {
                            key: numberKey
                        },
                        data: {
                            status: 'SOLD'
                        }
                    })
                ]);
                if (!card) {
                    throw new Error('Card not found');
                }
                if (!number) {
                    throw new Error('Number not found');
                }
                const [sim, stock] = await Promise.all([
                    tx.merge.create({
                        data: {
                            cardKey,
                            numberKey,
                            soldAt: new Date()
                        }
                    }),
                    tx.cardStock.findFirst({
                        where: {
                            checkpointCode: card.checkpointCode
                        },
                        orderBy: {
                            createdAt: 'desc'
                        }
                    })
                ]);
                if (!stock || Number(stock.amount) <= 0) {
                    throw new Error('Card unavailable');
                }
                await Promise.all([
                    tx.cardStock.create({
                        data: {
                            checkpointCode: card.checkpointCode,
                            amount: Number(stock.amount) - 1
                        }
                    }),
                    tx.cardMovement.create({
                        data: {
                            cardID: card.id,
                            type: 'SALE',
                            userCode: req.user.code,
                            sourceCode: card.checkpointCode,
                            targetCode: null
                        }
                    }),
                    tx.numberMovement.create({
                        data: {
                            numberID: number.id,
                            type: 'SALE',
                            userCode: req.user.code,
                            sourceCode: number.checkpointCode,
                            targetCode: null
                        }
                    })
                ]);
                return sim;
            });
            res.status(200).json({
                message: 'Sim successfully merged',
                data: sim
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
            const { page = 1, limit = 10, checkpointCode, status, search } = req.query;
            const where = {};
            if (checkpointCode)
                where.checkpointCode = checkpointCode;
            if (status)
                where.status = status;
            if (search) {
                where.OR = [
                    { key: { contains: search, mode: 'insensitive' } },
                    { name: { contains: search, mode: 'insensitive' } }
                ];
            }
            const [numbers, total] = await Promise.all([
                prisma.number.findMany({
                    where,
                    skip: (Number(page) - 1) * Number(limit),
                    take: Number(limit),
                    include: {
                        checkpoint: true,
                        movements: {
                            orderBy: { createdAt: 'desc' },
                            take: 3
                        }
                    },
                    orderBy: { createdAt: 'desc' }
                }),
                prisma.number.count({ where })
            ]);
            res.status(200).json({
                message: 'Numbers retrieved successfully',
                data: numbers,
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
            const { id } = req.params;
            const number = await prisma.number.findUnique({
                where: { id: Number(id) },
                include: {
                    checkpoint: true,
                    movements: {
                        include: {
                            number: true
                        },
                        orderBy: { createdAt: 'desc' }
                    }
                }
            });
            if (!number) {
                throw new Error('Number not found');
            }
            res.status(200).json({
                message: 'Number retrieved successfully',
                data: number
            });
        }
        catch (error) {
            next(error);
        }
    }
    static async updateNumber(req, res, next) {
        try {
            const { id } = req.params;
            const { name, status, remark } = req.body;
            const number = await prisma.number.update({
                where: { id: Number(id) },
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
                data: number
            });
        }
        catch (error) {
            next(error);
        }
    }
    static async deleteNumber(req, res, next) {
        try {
            const { id } = req.params;
            await prisma.number.delete({
                where: { id: Number(id) }
            });
            res.status(200).json({
                message: 'Number deleted successfully'
            });
        }
        catch (error) {
            next(error);
        }
    }
}
export default StockController;
