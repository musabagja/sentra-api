import prisma from '../../lib/prisma';
class CheckpointController {
    static async createCheckpoint(req, res, next) {
        try {
            const { code, type, name } = req.body;
            const checkpoint = await prisma.checkpoint.create({
                data: {
                    code,
                    type,
                    name
                }
            });
            res.status(201).json({
                message: 'Checkpoint created successfully',
                data: checkpoint
            });
        }
        catch (error) {
            next(error);
        }
    }
    static async getCheckpoints(req, res, next) {
        try {
            const { page = 1, limit = 10, type } = req.query;
            const where = type ? { type: type } : {};
            const [checkpoints, total] = await Promise.all([
                prisma.checkpoint.findMany({
                    where,
                    skip: (Number(page) - 1) * Number(limit),
                    take: Number(limit),
                    include: {
                        _count: {
                            select: {
                                cards: true,
                                numbers: true
                            }
                        }
                    },
                    orderBy: { createdAt: 'desc' }
                }),
                prisma.checkpoint.count({ where })
            ]);
            res.status(200).json({
                message: 'Checkpoints retrieved successfully',
                data: checkpoints,
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
            const checkpoint = await prisma.checkpoint.findUnique({
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
                    numbers: {
                        include: {
                            movements: {
                                orderBy: { createdAt: 'desc' },
                                take: 5
                            }
                        }
                    },
                    _count: {
                        select: {
                            cards: true,
                            numbers: true
                        }
                    }
                }
            });
            if (!checkpoint) {
                throw new Error('Checkpoint not found');
            }
            res.status(200).json({
                message: 'Checkpoint retrieved successfully',
                data: checkpoint
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
            const checkpoint = await prisma.checkpoint.update({
                where: { id: Number(id) },
                data: {
                    ...(code && { code }),
                    ...(type && { type }),
                    ...(name && { name })
                }
            });
            res.status(200).json({
                message: 'Checkpoint updated successfully',
                data: checkpoint
            });
        }
        catch (error) {
            next(error);
        }
    }
    static async deleteCheckpoint(req, res, next) {
        try {
            const { id } = req.params;
            await prisma.checkpoint.delete({
                where: { id: Number(id) }
            });
            res.status(200).json({
                message: 'Checkpoint deleted successfully'
            });
        }
        catch (error) {
            next(error);
        }
    }
}
export default CheckpointController;
