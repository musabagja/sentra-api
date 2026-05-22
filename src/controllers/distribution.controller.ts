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
            status: "DELIVERY"
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

      // Base access scope: user sees distributions where they own either end (source or target).
      // Specific filters are AND-appended on top — kept separate so they don't collapse into
      // an OR that returns results matching only one side when both filters are provided.
      const where: any = {
        AND: [
          {
            OR: [
              { sourceCode: { in: allowed } },
              { targetCode: { in: allowed } }
            ]
          }
        ]
      };
      if (status) where.AND.push({ status });
      if (sourceCode) where.AND.push({ sourceCode: sourceCode as string });
      if (targetCode) where.AND.push({ targetCode: targetCode as string });
      if (startDueDate || endDueDate) {
        where.AND.push({
          scheduledAt: {
            ...(startDueDate && { gte: new Date(startDueDate as string) }),
            ...(endDueDate && { lte: new Date(endDueDate as string) })
          }
        });
      }

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

        const allowedStatuses = ["SCHEDULED", "DELIVERY"];
        if (!allowedStatuses.includes(status)) {
          throw new Error('Invalid distribution status. Use the submit endpoint to mark as delivered, or the cancel endpoint to cancel');
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
              status: "DELIVERY"
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

        const itemKeys = distribution.items.map(item => item.itemKey);

        // Validate before writing — if cards are gone the transaction rolls back cleanly
        const [holdCount, sourceStock, targetStock] = await Promise.all([
          tx.card.count({
            where: { key: { in: itemKeys }, checkpointCode: distribution.sourceCode, status: 'DELIVERY' }
          }),
          tx.cardStock.findFirst({
            where: { checkpointCode: distribution.sourceCode },
            orderBy: { createdAt: 'desc' }
          }),
          tx.cardStock.findFirst({
            where: { checkpointCode: distribution.targetCode },
            orderBy: { createdAt: 'desc' }
          })
        ]);

        if (holdCount !== itemKeys.length) {
          throw new Error('Some cards are no longer available for distribution');
        }

        if (!sourceStock) {
          throw new Error('Source checkpoint has no stock record');
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
              amount: sourceStock.amount - itemKeys.length
            }
          }),
          tx.cardStock.create({
            data: {
              checkpointCode: distribution.targetCode,
              amount: (targetStock?.amount ?? 0) + itemKeys.length
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

      const existing = await prisma.distribution.findUnique({
        where: { id: Number(id) },
        include: { items: true }
      });
      if (
        !existing ||
        (!hasCheckpointAccess(existing.sourceCode, allowed) &&
         !hasCheckpointAccess(existing.targetCode, allowed))
      ) {
        const err = new Error('Distribution not found');
        (err as any).status = 404;
        throw err;
      }

      if (existing.status === 'DELIVERED') {
        const err = new Error('Cannot delete a delivered distribution');
        (err as any).status = 400;
        throw err;
      }

      const itemKeys = existing.items.map(i => i.itemKey);

      await prisma.$transaction(async (tx) => {
        // Restore HOLD cards back to VERIFIED
        if (itemKeys.length > 0) {
          await tx.card.updateMany({
            where: { key: { in: itemKeys }, status: 'DELIVERY' },
            data: { status: 'VERIFIED' }
          });
          await tx.distributionItem.deleteMany({ where: { distributionID: existing.id } });
        }

        // Remove submittance if it exists (CANCELLED distributions shouldn't have one, but guard anyway)
        await tx.distributionSubmittance.deleteMany({ where: { distributionID: existing.id } });

        await tx.distribution.delete({ where: { id: existing.id } });
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