import type { NextFunction, Request, Response } from "express";
import prisma from "../../lib/prisma";
import { hasCheckpointAccess, resolveCheckpointFilter } from "../utils/access.util";

class DistributionController {
  // ============================================================================
  // DISTRIBUTION CRUD OPERATIONS
  // ============================================================================

  static async createDistribution(req: Request, res: Response, next: NextFunction) {
    try {
      const { targetCode, scheduledAt, cardKeys } = req.body;

      if (!req.user) throw new Error('User not found');
      if (!Array.isArray(cardKeys)) throw new Error('Cards must be an array');

      const allowed = req.checkpointCodes ?? [];

      const [distributions, cards, missingKeys] = await prisma.$transaction<[any[], any[], string[]]>(async (tx) => {

        const user = req.user!;

        const targetCheckpoint = await tx.checkpoint.findUnique({ where: { code: targetCode } });
        if (!targetCheckpoint) {
          throw new Error('Target checkpoint not found');
        }

        // Only consider cards that are at checkpoints within the user's circle
        const foundCards = await tx.card.findMany({
          where: {
            key: { in: cardKeys },
            status: "VERIFIED",
            checkpointCode: { in: allowed }
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
          if (!key) throw new Error(`Card ${card.key} has no checkpoint assigned and cannot be distributed`);
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
      const { page = 1, limit = 10, status, sourceCode, targetCode, startDueDate, endDueDate } = req.query;
      const allowed = req.checkpointCodes ?? [];

      // A user sees distributions where they own either end (source or target)
      const where: any = {
        AND: [{
          OR: [
            { sourceCode: { in: resolveCheckpointFilter(sourceCode as string | undefined, allowed) } },
            { targetCode: { in: resolveCheckpointFilter(targetCode as string | undefined, allowed) } }
          ]
        }]
      };
      if (status) where.status = status;
      if (startDueDate) where.scheduledAt = { gte: new Date(startDueDate as string) };
      if (endDueDate) where.scheduledAt = { lte: new Date(endDueDate as string) };

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
            },
            source: true,
            target: true
          },
          orderBy: { createdAt: 'desc' }
        }),
        prisma.distribution.count({ where })
      ]);

      res.status(200).json({
        message: 'Distributions retrieved successfully',
        data: { distributions },
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

      const allowed = req.checkpointCodes ?? [];

      const distribution = await prisma.distribution.findUnique({
        where: { id: Number(id) },
        include: {
          items: { include: { card: true } },
          submittance: true,
          source: true,
          target: true
        }
      });

      if (
        !distribution ||
        (!hasCheckpointAccess(distribution.sourceCode, allowed) &&
         !hasCheckpointAccess(distribution.targetCode, allowed))
      ) {
        const err = new Error('Distribution not found');
        (err as any).status = 404;
        throw err;
      }

      res.status(200).json({
        message: 'Distribution retrieved successfully',
        data: { distribution }
      });
    } catch (error) {
      next(error);
    }
  }

  static async updateDistribution(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const { status, scheduledAt } = req.body;
      const allowed = req.checkpointCodes ?? [];

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

        if (
          !distribution ||
          (!hasCheckpointAccess(distribution.sourceCode, allowed) &&
           !hasCheckpointAccess(distribution.targetCode, allowed))
        ) {
          const err = new Error('Distribution not found');
          (err as any).status = 404;
          throw err;
        }

        if (distribution.items.length === 0) {
          throw new Error('Distribution has no items');
        }

        const itemKeys = distribution.items.map(item => item.itemKey);

        if (status === "DELIVERED") {
          throw new Error("Mark as delivered only through submittance");
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
            scheduledAt: scheduledAt ? new Date(scheduledAt) : null
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
        data: { distribution: updatedDistribution }
      });
    } catch (error) {
      next(error);
    }
  }

  static async cancelDistribution(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const allowed = req.checkpointCodes ?? [];

      const distribution = await prisma.$transaction(async (tx) => {
        const currentDistribution = await tx.distribution.findUnique({
          where: { id: Number(id) },
          include: { items: true }
        });

        if (
          !currentDistribution ||
          (!hasCheckpointAccess(currentDistribution.sourceCode, allowed) &&
           !hasCheckpointAccess(currentDistribution.targetCode, allowed))
        ) {
          const err = new Error('Distribution not found');
          (err as any).status = 404;
          throw err;
        }

        if (currentDistribution.status === "DELIVERED") {
          throw new Error('Cannot cancel a delivered distribution');
        }

        if (currentDistribution.status === "CANCELLED") {
          throw new Error('Distribution already cancelled');
        }
        
        const updatedDistribution = await tx.distribution.update({
          where: { id: Number(id) },
          data: {
            status: "CANCELLED"
          }
        });
        
        await tx.card.updateMany({
          where: {
            key: {
              in: currentDistribution.items.map(item => item.itemKey)
            }
          },
          data: {
            status: "VERIFIED"
          }
        });

        return updatedDistribution;
      })

      res.status(200).json({
        message: 'Distribution cancelled successfully',
        data: {distribution}
      });
    } catch (error) {
      next(error);
    }
  }

  static async submitDistribution(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const {
        longitude,    
        latitude,
        signURL,
        imageURL,
        storeURL,
        recipientURL,
        note,
        recipientName
      } = req.body;

      const allowed = req.checkpointCodes ?? [];

      const submittance = await prisma.$transaction(async (tx) => {
        const user = req.user!;

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

        if (!distribution || !hasCheckpointAccess(distribution.sourceCode, allowed)) {
          const err = new Error('Distribution not found');
          (err as any).status = 404;
          throw err;
        }

        if (distribution.status === "DELIVERED") {
          throw new Error('Distribution is already completed');
        }

        const submittance = await tx.distributionSubmittance.create({
          data: {
            distributionID: Number(id),
            userCode: user.code,
            longitude: longitude ? Number(longitude) : null,
            latitude: latitude ? Number(latitude) : null,
            signURL: signURL || null,
            imageURL: imageURL || null,
            storeURL: storeURL || null,
            recipientURL: recipientURL || null,
            note: note || null,
            recipientName: recipientName || null
          }
        });

        await tx.distribution.update({
          where: { id: Number(id) },
          data: {
            status: "DELIVERED",
            completedAt: new Date()
          }
        });

        const itemKeys = distribution.items.map(item => item.itemKey);
  
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

        const holdCount = await tx.card.count({
          where: { key: { in: itemKeys }, checkpointCode: distribution.sourceCode, status: 'HOLD' }
        });
        if (holdCount !== itemKeys.length) {
          throw new Error('Some cards are no longer available for distribution');
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
              amount: Number(sourceStock?.amount ?? 0) - itemKeys.length
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

        return submittance
      })


      res.status(200).json({
        message: 'Distribution submitted successfully',
        data: { submittance }
      });
    } catch (error) {
      next(error);
    }
  }

  static async deleteDistribution(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const allowed = req.checkpointCodes ?? [];

      const existing = await prisma.distribution.findUnique({ where: { id: Number(id) } });
      if (
        !existing ||
        (!hasCheckpointAccess(existing.sourceCode, allowed) &&
         !hasCheckpointAccess(existing.targetCode, allowed))
      ) {
        const err = new Error('Distribution not found');
        (err as any).status = 404;
        throw err;
      }

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