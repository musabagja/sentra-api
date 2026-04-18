import type { NextFunction, Request, Response } from "express";
import prisma from "../../lib/prisma";

class DistributionController {
  // ============================================================================
  // DISTRIBUTION CRUD OPERATIONS
  // ============================================================================

  static async createDistribution(req: Request, res: Response, next: NextFunction) {
    try {
      const { sourceCode, targetCode, cardKeys } = req.body;

      const user = req.user

      if (!user) {
        throw new Error('User not found');
      }

      if (!Array.isArray(cardKeys)) {
        throw new Error('Cards must be an array');
      }

      console.log(cardKeys)

      const cards = await prisma.card.findMany({
        where: {
          key: {
            in: cardKeys
          },
          status: "VERIFIED"
        }
      });

      if (cards.length === 0) {
        throw new Error('No verified cards found');
      }

      const missingKeys = cardKeys.filter(key => !cards.some(card => card.key === key));

      await prisma.card.updateMany({
        where: {
          key: {
            in: cardKeys
          },
          status: "VERIFIED"
        },
        data: {
          status: "HOLD"
        },
      });

      const lastDistribution = await prisma.distribution.findFirst({
        orderBy: {
          id: 'desc'
        }
      });

      const nextId = lastDistribution ? lastDistribution.id + 1 : 1;
      const nextBatch = `DV-${nextId.toString().padStart(6, '0')}`;

      const distribution = await prisma.distribution.create({
        data: {
          sourceCode,
          targetCode,
          batch: nextBatch,
          amount: BigInt(cards.length),
          status: "SCHEDULED",
          userCode: user.code
        },
        include: {
          items: {
            include: {
              card: true
            }
          }
        }
      });

      await prisma.distributionItem.createMany({
        data: cards.map(card => ({
          distributionId: distribution.id,
          cardId: card.id,
          itemKey: card.key,
          distributionID: distribution.id
        }))
      })

      res.status(201).json({
        message: 'Distribution created successfully',
        data: {
          distribution,
          cards,
          missingKeys
        },
      });
    } catch (error) {
      next(error);
    }
  }

  static async getDistributions(req: Request, res: Response, next: NextFunction) {
    try {
      const { page = 1, limit = 10, status, sourceCode, targetCode } = req.query;

      const where: any = {};
      if (status) where.status = status;
      if (sourceCode) where.sourceCode = sourceCode;
      if (targetCode) where.targetCode = targetCode;

      const [distributions, total] = await Promise.all([
        prisma.distribution.findMany({
          where,
          skip: (Number(page) - 1) * Number(limit),
          take: Number(limit),
          include: {
            items: {
              include: {
                card: true
              },
              take: 5
            },
            _count: {
              select: {
                items: true
              }
            }
          },
          orderBy: { createdAt: 'desc' }
        }),
        prisma.distribution.count({ where })
      ]);

      res.status(200).json({
        message: 'Distributions retrieved successfully',
        data: distributions,
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

  static async getDistribution(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;

      const distribution = await prisma.distribution.findUnique({
        where: { id: Number(id) },
        include: {
          items: {
            include: {
              card: true
            }
          }
        }
      });

      if (!distribution) {
        throw new Error('Distribution not found');
      }

      res.status(200).json({
        message: 'Distribution retrieved successfully',
        data: distribution
      });
    } catch (error) {
      next(error);
    }
  }

  static async updateDistribution(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const { status } = req.body;

      const distribution = await prisma.distribution.update({
        where: { id: Number(id) },
        data: {
          ...(status && { status })
        },
        include: {
          items: {
            include: {
              card: true
            }
          }
        }
      });

      res.status(200).json({
        message: 'Distribution updated successfully',
        data: distribution
      });
    } catch (error) {
      next(error);
    }
  }

  static async deleteDistribution(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;

      await prisma.distribution.delete({
        where: { id: Number(id) }
      });

      res.status(200).json({
        message: 'Distribution deleted successfully'
      });
    } catch (error) {
      next(error);
    }
  }
}

export default DistributionController;