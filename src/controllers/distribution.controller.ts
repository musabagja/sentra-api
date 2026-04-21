import type { NextFunction, Request, Response } from "express";
import prisma from "../../lib/prisma";

class DistributionController {
  // ============================================================================
  // DISTRIBUTION CRUD OPERATIONS
  // ============================================================================

  static async createDistribution(req: Request, res: Response, next: NextFunction) {
    try {
      const { targetCode, scheduledAt, cardKeys } = req.body;

      const [distributions, cards, missingKeys] = await prisma.$transaction<[any[], any[], string[]]>(async (tx) => {

        const user = req.user

        if (!user) {
          throw new Error('User not found');
        }

        if (!Array.isArray(cardKeys)) {
          throw new Error('Cards must be an array');
        }

        const targetCheckpoint = await tx.checkpoint.findUnique({
          where: {
            code: targetCode
          }
        });

        if (!targetCheckpoint) {
          throw new Error('Target checkpoint not found');
        }

        const foundCards = await tx.card.findMany({
          where: {
            key: {
              in: cardKeys
            },
            status: "VERIFIED"
          }
        });

        if (foundCards.length === 0) {
          throw new Error('No verified cards found');
        }

        const missingKeys = cardKeys.filter(key => !foundCards.some(card => card.key === key));

        const distinctSourceCodes = [...new Set(foundCards.map((card) => card.checkpointCode))];

        if (targetCode && distinctSourceCodes.includes(targetCode)) {
          const rejectedKeys = foundCards.filter(card => card.checkpointCode === targetCode).map(card => card.key);
          throw new Error(`Cards [${ rejectedKeys.join(", ") }] are already at checkpoint ${ targetCode }. Please deselect them and resubmit.`);
        }

        await tx.card.updateMany({
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

        const lastDistribution = await tx.distribution.findFirst({
          orderBy: {
            id: 'desc'
          }
        });

        const nextId = lastDistribution && lastDistribution.batch ? parseInt(lastDistribution.batch.replace('DV-', '')) + 1 : 1;
        const nextBatch = `DV-${nextId.toString()}`;

        const cardsBySource = foundCards.reduce((acc, card) => {
          const key = card.checkpointCode;
          if (!acc[key]) acc[key] = [];
          acc[key].push(card);
          return acc;
        }, {} as Record<string, typeof foundCards>);

        const distributions = await Promise.all(Object.entries(cardsBySource).map(([sourceCode, groupedCards]) => tx.distribution.create({
          data: {
            sourceCode,
            targetCode,
            batch: nextBatch,
            amount: groupedCards.length,
            status: "SCHEDULED",
            scheduledAt: new Date(scheduledAt),
            userCode: user.code,
            items: {
              create: groupedCards.map(card => ({
                itemKey: card.key
              }))
            }
          },
          include: {
            items: true
          }
        })));

        return [distributions, foundCards, missingKeys];
      })

      res.status(201).json({
        message: 'Distribution created successfully',
        data: {
          distributions,
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

      const updatedDistribution = await prisma.$transaction(async (tx) => {
        const user = req.user;
        if (!user) {
          throw new Error('User not found');
        }

        if (!status) {
          throw new Error('Status is required');
        }

        const allowedStatuses = ["SCHEDULED", "HOLD", "DELIVERED"];
        if (!allowedStatuses.includes(status)) {
          throw new Error('Invalid distribution status');
        }

        const distribution = await tx.distribution.findUnique({
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

        if (distribution.status === "DELIVERED") {
          throw new Error('Distribution is final and cannot be updated');
        }

        if (distribution.items.length === 0) {
          throw new Error('Distribution has no items');
        }

        const itemKeys = distribution.items.map(item => item.itemKey);

        if (status === "DELIVERED") {
          const [sourceStock, targetStock] = await Promise.all([
            tx.cardStock.findFirst({
              where: {
                checkpointCode: distribution.sourceCode
              },
              orderBy: {
                createdAt: 'desc'
              }
            }),
            tx.cardStock.findFirst({
              where: {
                checkpointCode: distribution.targetCode
              },
              orderBy: {
                createdAt: 'desc'
              }
            })
          ]);

          if (!sourceStock || Number(sourceStock.amount) < itemKeys.length) {
            throw new Error('Insufficient source stock');
          }

          await Promise.all([
            tx.card.updateMany({
              where: {
                key: {
                  in: itemKeys
                }
              },
              data: {
                checkpointCode: distribution.targetCode,
                status: "VERIFIED"
              }
            }),
            tx.cardStock.create({
              data: {
                checkpointCode: distribution.sourceCode,
                amount: Number(sourceStock.amount) - itemKeys.length
              }
            }),
            tx.cardStock.create({
              data: {
                checkpointCode: distribution.targetCode,
                amount: Number(targetStock?.amount || 0) + itemKeys.length
              }
            }),
            tx.cardMovement.createMany({
              data: distribution.items.map(item => ({
                cardID: item.card.id,
                type: "TRANSFER",
                userCode: user.code,
                sourceCode: distribution.sourceCode,
                targetCode: distribution.targetCode
              }))
            })
          ]);
        } else {
          await tx.card.updateMany({
            where: {
              key: {
                in: itemKeys
              }
            },
            data: {
              status: "HOLD"
            }
          });
        }

        return tx.distribution.update({
          where: { id: Number(id) },
          data: {
            status,
            ...(status === "DELIVERED" && { completedAt: new Date() })
          },
          include: {
            items: {
              include: {
                card: true
              }
            }
          }
        });
      });

      res.status(200).json({
        message: 'Distribution updated successfully',
        data: updatedDistribution
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