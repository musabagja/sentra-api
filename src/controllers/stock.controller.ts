import type { Request, Response, NextFunction } from 'express';
import prisma from '../../lib/prisma';
import * as xlsx from 'xlsx';
import { ItemStatus, UploadBatchStatus } from '../../generated/prisma/enums';

class StockController {

  static async dashboardSync (req: Request, res: Response, next: NextFunction) {
    try {
      const excluded: ItemStatus[] = ["UNVERIFIED", "LOST"]
      const totalStock = await prisma.card.count({
        where: {
          status: {
            notIn: excluded
          }
        }
      });
      const availableStock = await prisma.card.count({
        where: {
          status: "VERIFIED"
        }
      });
      const distributedStock = await prisma.distribution.findMany({
        where: {
          status: 'DELIVERED',
          scheduledAt: {
            gte: new Date(new Date().getFullYear(), 0, 1, 0, 0, 0, 0),
            lte: new Date(new Date().getFullYear(), 11, 31, 23, 59, 59, 999)
          },
          target: {
            type: {
              in: ['DC', 'STORE']
            }
          }
        },
        include: {
          target: true
        }
      });
      const storeDistributedStock = distributedStock.filter(d => d.target.type === 'STORE');
      const warehouseDistributedStock = distributedStock.filter(d => d.target.type === 'DC');
      const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
      let storeMonthlyCount: Record<string, number> = {}
      let warehouseMonthlyCount: Record<string, number> = {}
      for (let each of storeDistributedStock) {
        if (!each.scheduledAt) continue;
        const month = each.scheduledAt.getMonth();
        const monthName = months[month] as string
        if (!storeMonthlyCount[monthName]) {
          storeMonthlyCount[monthName] = 0;
        }
        storeMonthlyCount[monthName] += each.amount;
      }
      for (let each of warehouseDistributedStock) {
        if (!each.scheduledAt) continue;
        const month = each.scheduledAt.getMonth();
        const monthName = months[month] as string
        if (!warehouseMonthlyCount[monthName]) {
          warehouseMonthlyCount[monthName] = 0;
        }
        warehouseMonthlyCount[monthName] += each.amount;
      }

      const checkpoints = await prisma.$queryRaw`
        SELECT c.*, cs."amount" as "stockAmount", cs."createdAt" as "stockCreatedAt"
        FROM "Checkpoint" c
        LEFT JOIN LATERAL (
          SELECT "amount", "createdAt"
          FROM "CardStock"
          WHERE "checkpointCode" = c."code"
          ORDER BY "amount" ASC
          LIMIT 1
        ) cs ON true
        WHERE c."type" = 'STORE'
        ORDER BY cs."amount" ASC
        LIMIT 10
      `

      const warehouseDistributions = await prisma.distribution.findMany({
        where: {
          target: {
            type: "DC"
          }
        },
        include: {
          target: true
        },
        orderBy: {
          amount: 'desc'
        },
        take: 10
      })

      // Please do make sure to Indosat Team that what if some warehouse accepts other from other than HQ, aint them still considered as persebaran?

      res.status(200).json({
        message: 'Dashboard synced successfully',
        data: {
          totalStock,
          availableStock,
          storeMonthlyCount,
          warehouseMonthlyCount,
          checkpoints,
          warehouseDistributions
        }
      });
    } catch (error) {
      next(error);
    }
  }

  static async getBatch(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;

      const batch = await prisma.uploadBatch.findUnique({
        where: { id: Number(id) },
        include: {
          cards: true,
          numbers: true,
          progress: true
        }
      });

      if (!batch) {
        throw new Error('Batch not found');
      }

      res.status(200).json({
        message: 'Batch retrieved successfully',
        data: batch
      });
    } catch (error) {
      next(error);
    }
  }

  static async getBatches(req: Request, res: Response, next: NextFunction) {
    try {
      const { page = 1, limit = 10, status, search } = req.query;

      const allowedStatus = ['ONGOING', 'COMPLETED'];

      if (status && !allowedStatus.includes(status as string)) {
        throw new Error('Invalid status');
      } 

      const where: any = {};
      if (status) {
        where.status = status as UploadBatchStatus;
      }

      if (search) {
        where.OR = [
          {
            code: {
              contains: search as string,
              mode: 'insensitive'
            }
          },
          {
            name: {
              contains: search as string,
              mode: 'insensitive'
            }
          }
        ]
      }

      const batches = await prisma.uploadBatch.findMany({
        take: Number(limit),
        skip: (Number(page) - 1) * Number(limit),
        where,
        orderBy: {
          createdAt: 'desc'
        },
        include: {
          progress: {
            take: 1,
            orderBy: {
              createdAt: 'desc'
            }
          }
        }
      });

      const excluded: ItemStatus[] = ["UNVERIFIED", "LOST"];
      const totalBatch = await prisma.uploadBatch.count();
      const totalCards = await prisma.card.count();
      const totalVerified = await prisma.card.count({
        where: {
          status: {
            notIn: excluded
          }
        }
      });
      const totalUnverified = totalCards - totalVerified;

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
    } catch (error) {
      next(error);
    }
  }

  static async completeBatch(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const { note } = req.body;

      const batch = await prisma.$transaction(async (tx) => {
        const currentBatch = await tx.uploadBatch.findUnique({
          where: {
            id: Number(id)
          }
        });

        if (!currentBatch) {
          throw new Error('Batch not found');
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
      })

      res.status(200).json({
        message: 'Batch updated successfully',
        data: batch
      });
    } catch (error) {
      (error as any).status = 400;
      next(error);
    }
  }

  static async getCards(req: Request, res: Response, next: NextFunction) {
    try {
      const { page = 1, limit = 10, checkpointCode, status, search, uploadAt, batch, validatedAt } = req.query;

      const where: any = {};
      if (checkpointCode) where.checkpointCode = checkpointCode;
      if (status) where.status = status;
      if (search) {
        where.OR = [
          { key: { contains: search as string, mode: 'insensitive' } },
          { name: { contains: search as string, mode: 'insensitive' } }
        ];
      }
      // validatedAt filter (related via Card -> Merge)
      if (validatedAt) {
        where.validatedAt = {
          gte: new Date(`${validatedAt}T00:00:00.000Z`),
          lt: new Date(`${validatedAt}T23:59:59.999Z`)
        }
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
            code: { contains: batch as string, mode: 'insensitive' }
          })
        };
      }

      const [cards, total] = await Promise.all([
        prisma.card.findMany({
          where,
          skip: (Number(page) - 1) * Number(limit),
          take: Number(limit),
          include: {
            checkpoint: true,
            uploadBatch: true
          },
          orderBy: { createdAt: 'desc' }
        }),
        prisma.card.count({ where })
      ]);

      const [totalUpload, totalSold, totalAvailable] = await Promise.all([
        prisma.card.count(),
        prisma.card.count({ where: {
          status: "SOLD"
        } }),
        prisma.card.count({ where: {
          status: "VERIFIED"
        } })
      ])

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
    } catch (error) {
      next(error);
    }
  }

  static async getCard(req: Request, res: Response, next: NextFunction) {
    try {
      const { key } = req.params;

      const card = await prisma.card.findUnique({
        where: { key: key as string },
        include: {
          checkpoint: true,
          movements: {
            orderBy: { createdAt: 'desc' }
          }
        }
      });

      if (!card) {
        throw new Error('Card not found');
      }

      res.status(200).json({
        message: 'Card retrieved successfully',
        data: {card}
      });
    } catch (error) {
      next(error);
    }
  }

  static async deleteCard(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;

      await prisma.card.delete({
        where: { id: Number(id) }
      });

      res.status(200).json({
        message: 'Card deleted successfully'
      });
    } catch (error) {
      next(error);
    }
  }

  static async uploadExcel(req: Request, res: Response, next: NextFunction) {
    try {
      const file = (req as any).file;

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
      
      const sheetName = workbook.SheetNames[0]!;
      const worksheet = workbook.Sheets[sheetName];
      const allowedSheets = ['ICCID', 'MSISDN'];
      let jsonResult: any[] = [];
      
      if (!worksheet) {
        throw new Error('Worksheet not found');
      }

      for (let sheet of workbook.SheetNames) {
        const sheetData = workbook.Sheets[sheet];
        if (!sheetData || !allowedSheets.includes(sheet)) continue;
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

      // Extract number data from the Excel file with batchCode
      const jsonData = jsonResult.map(each => {
        const seen = new Set<string>();
        const data = each.data
          .map((row: any) => ({
            key: String(row.KEY || row.key),
            checkpointCode: (row.CHECKPOINT || row.checkpoint) ? String(row.CHECKPOINT || row.checkpoint) : null,
            remark: row.REMARK || row.remark || '',
            batchCode: batchCode
          }))
          .filter((item: any) => {
            if (!item.key || item.key === 'undefined' || seen.has(item.key)) return false;
            seen.add(item.key);
            return true;
          });
        return { sheet: each.sheet, data };
      });

      const batch = await prisma.uploadBatch.create({
        data: {
          code: batchCode,
          userCode: req.user.code,
          status: "ONGOING",
          total: jsonData.find(each => each.sheet === 'ICCID')?.data.length || 0
        }
      });

      // Bulk create cards and numbers with batchCode
      const result = await Promise.all(
        jsonData.map(each => {
          if (each.sheet === 'ICCID') {
            return prisma.card.createMany({
              data: each.data,
              skipDuplicates: true
            });
          } else {
            return prisma.number.createMany({
              data: each.data,
              skipDuplicates: true
            });
          }
        })
      )

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
    } catch (error) {
      next(error);
    }
  }

  static async downloadExcel(req: Request, res: Response, next: NextFunction) {
    try {
      
    } catch (error) {
      next(error);
    }
  }

  static async validateCard(req: Request, res: Response, next: NextFunction) {
    try {
      const { key } = req.params;
      const { status } = req.body;
      const rawStatus = Array.isArray(status) ? status[0] : status;

      const card = await prisma.$transaction(async (tx) => {
        if (!req.user) {
          throw new Error('User not found');
        }

        if (!rawStatus || rawStatus === "UNVERIFIED") {
          throw new Error ("Please provide status, wether it's VERIFIED or BROKEN");
        }

        if (!(Object.values(ItemStatus) as string[]).includes(rawStatus)) {
          throw new Error('Invalid status');
        }

        const nextStatus = rawStatus as ItemStatus;
        let updateData: any = {
          status: nextStatus
        };

        const card = await tx.card.findFirst({
          where: {
            key: key as string
          },
          include: {
            uploadBatch: true
          }
        });

        if (!card) {
          throw new Error('Card not found');
        }

        if (!card.uploadBatch) {
          throw new Error('Card upload batch not found');
        }

        if (card.uploadBatch.status === "COMPLETED") {
          throw new Error('Card upload batch is already completed');
        }

        if (card.status === "UNVERIFIED") {
          updateData.validatedAt = new Date();
        }
  
        const cards = await tx.card.updateMany({
          where: {
            key: key as string
          },
          data: updateData
        });

        if (cards.count === 0) {
          throw new Error('Card already validated');
        }

        const [stock, lastProgress] = await Promise.all([
          tx.cardStock.findFirst({
            where: {
              checkpointCode: card.checkpointCode
            },
            orderBy: {
              createdAt: 'desc'
            }
          }),
          tx.uploadBatchProgress.findFirst({
            where: {
              batchCode: card.uploadBatch.code
            },
            orderBy: {
              createdAt: 'desc'
            }
          })
        ])

        if (card.status === "UNVERIFIED" || card.status === "BROKEN" || card.status === "LOST") {
          if (card.status === "UNVERIFIED") {
            await tx.uploadBatchProgress.create({
              data: {
                batchCode: card.uploadBatch.code,
                progress: (lastProgress?.progress || 0) + 1
              }
            })
          }
          if (nextStatus === "VERIFIED") {
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
            ])
          }
        } else if (card.status === "VERIFIED") {
          if (nextStatus === "UNVERIFIED" || nextStatus === "BROKEN" || nextStatus === "LOST") {
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
            ])
          }
        } else {
          throw new Error('Invalid status');
        }
      })

      res.status(200).json({
        message: 'Card validated successfully',
        data: card
      });
    } catch (error) {
      next(error);
    }
  }

  static async bulkMergeSim(req: Request, res: Response, next: NextFunction) {
    try {
      
    } catch (error) {
      next(error);
    }
  }

  static async mergeSim(req: Request, res: Response, next: NextFunction) {
    try {
      const { cardKey, numberKey, checkpointCode, type, trn } = req.body;

      const sim = await prisma.$transaction(async (tx) => {
        if (!req.user) {
          throw new Error('User not found');
        }
        if (!type) {
          throw new Error('Type is required');
        }
        if (type === "SIMCARD" && !cardKey) {
          throw new Error('ICCID is required for SIMCARD type');
        }
        if (!checkpointCode) {
          throw new Error('Checkpoint code is required');
        }
        if (!trn) {
          throw new Error('TRN is required');
        }
        if (!req.user) {
          throw new Error('User not found');
        }
        const checkpoint = await tx.checkpoint.findUnique({
          where: {
            code: checkpointCode
          }
        })
        if (!checkpoint) {
          throw new Error('Checkpoint not found');
        }
        let number
        if (type === "SIMCARD" || type === "ESIM") {
          [number] = await Promise.all([
            tx.number.findUnique({
              where: {
                key: numberKey,
                status: "VERIFIED"
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
          if (!number) {
            throw new Error('Number not found');
          }
          if (number.checkpointCode !== null && number.checkpointCode !== checkpointCode) {
            throw new Error('Number checkpoint code does not match checkpoint code');
          }
        }
        if (!checkpoint) {
          throw new Error('Checkpoint not found');
        }
        let card
        if (type === "SIMCARD") {
          [card] = await Promise.all([
            tx.card.findUnique({
              where: {
                key: cardKey,
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
          ])
          if (!card) {
            throw new Error('Card not found');
          }
          if (checkpoint.code !== card?.checkpointCode) {
            throw new Error('Checkpoint code does not match card checkpoint code');
          }
          const stock = await tx.cardStock.findFirst({
            where: {
              checkpointCode: card.checkpointCode
            },
            orderBy: {
              createdAt: 'desc'
            }
          });
          if (!stock || Number(stock.amount) <= 0) {
            throw new Error('Card unavailable');
          }
          await tx.cardStock.create({
            data: {
              checkpointCode: card.checkpointCode,
              amount: Number(stock.amount) - 1  
            }
          })
        }
  
        let esimCode = "";

        if (type === "ESIM") {
          esimCode = "ESIM-" + (Date.now().toString(36) + Math.random().toString(36).slice(2, 6)).toUpperCase();
        } else if (type === "CPP") {
          esimCode = "CPP-" + (Date.now().toString(36) + Math.random().toString(36).slice(2, 6)).toUpperCase();
        } else if (type === "MIGRATION") {
          esimCode = "MGR-" + (Date.now().toString(36) + Math.random().toString(36).slice(2, 6)).toUpperCase();
        } else {
          esimCode = cardKey;
        }
        let sim

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
          })
        } else {
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
          })
        }
        return sim
      });

      res.status(200).json({
        message: 'Sim successfully merged',
        data: sim
      });
    } catch (error) {
      next(error);
    }
  }

  // ============================================================================
  // NUMBER CRUD OPERATIONS
  // ============================================================================

  static async createNumber(req: Request, res: Response, next: NextFunction) {
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
    } catch (error) {
      next(error);
    }
  }

  static async getNumbers(req: Request, res: Response, next: NextFunction) {
    try {
      const { page = 1, limit = 10, checkpointCode, status, search, remark, sort } = req.query;

      const where: any = {};
      if (checkpointCode) where.checkpointCode = checkpointCode;
      if (status) where.status = status;
      if (search) {
        where.OR = [
          { key: { contains: search as string, mode: 'insensitive' } },
          { name: { contains: search as string, mode: 'insensitive' } }
        ];
      }
      if (remark) {
        where.remark = {
          contains: remark as string, mode: 'insensitive'
        }
      }
      if (sort) {
        if (sort !== "ASC"  && sort !== "DESC") {
          throw new Error ("Sort field can only be filled with 'ASC' or 'DESC'")
        }
      }

      const [numbers, total] = await Promise.all([
        prisma.number.findMany({
          where,
          skip: (Number(page) - 1) * Number(limit),
          take: Number(limit),
          include: {
            checkpoint: true,
            merge: true
          },
          orderBy: { createdAt: 'desc' }
        }),
        prisma.number.count({ where })
      ]);

      const [totalUpload, totalAvailable] = await Promise.all([
        prisma.number.count(),
        prisma.number.count({
          where: {
            status: "VERIFIED"
          }
        })
      ])

      const totalMerge = await prisma.merge.count();
      const monthlyMerge = await prisma.merge.count({
        where: {
          createdAt: {
            gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1)
          }
        }
      });
      const dailyMerge = await prisma.merge.count({
        where: {
          createdAt: {
            gte: new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate())
          }
        }
      });

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
    } catch (error) {
      next(error);
    }
  }

  static async getNumber(req: Request, res: Response, next: NextFunction) {
    try {
      const { key } = req.params;

      const number = await prisma.number.findUnique({
        where: { key: key as string },
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
    } catch (error) {
      next(error);
    }
  }

  static async updateNumber(req: Request, res: Response, next: NextFunction) {
    try {
      const { key } = req.params;
      const { name, status, remark } = req.body;

      const number = await prisma.number.update({
        where: { key: key as string },
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
    } catch (error) {
      next(error);
    }
  }

  static async deleteNumber(req: Request, res: Response, next: NextFunction) {
    try {
      const { key } = req.params;

      await prisma.number.delete({
        where: { key: key as string }
      });

      res.status(200).json({
        message: 'Number deleted successfully'
      });
    } catch (error) {
      next(error);
    }
  }

  static async getMerges(req: Request, res: Response, next: NextFunction) {
    try {
      const { page = 1, limit = 10, checkpointCode, startSoldAt, endSoldAt, cardRemark, search, type } = req.query;

      let where: any = {}
      if (checkpointCode) {
        where.checkpointCode = checkpointCode as string
      }
      if (startSoldAt) {
        where.createdAt = {
          gte: new Date(new Date(startSoldAt as string).setHours(0, 0, 0, 0))
        }
      }
      if (endSoldAt) {
        where.createdAt = {
          ...where.createdAt,
          lte: new Date(new Date(endSoldAt as string).setHours(23, 59, 59, 999))
        }
      }
      if (cardRemark) {
        where.number = {
          remark: cardRemark as string
        }
      }
      if (search) {
        where.number = {
          ...where.number,
          key: {
            contains: search as string
          }
        }
      }
      let merges

      if (type === "SIMCARD" || !type) {
        merges = await prisma.merge.findMany({
          skip: (Number(page) - 1) * Number(limit),
          take: Number(limit),
          orderBy: { createdAt: 'desc' },
          where,
          include: {
            number: true
          }
        });
      } else {
        merges = await prisma.mergeAdditional.findMany({
          skip: (Number(page) - 1) * Number(limit),
          take: Number(limit),
          orderBy: { createdAt: 'desc' },
          where
        });
      }
      const total = await prisma.merge.count();
      const monthly = await prisma.merge.count({
        where: { 
          createdAt: {
            gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1)
          }
        }
      });
      const daily = await prisma.merge.count({
        where: {
          createdAt: {
            gte: new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate())
          }
        }
      });

      res.status(200).json({
        message: 'Merges retrieved successfully',
        data: {
          merges,
          amount: {
            total,
            monthly,
            daily
          },
          pagination: {
            page: Number(page),
            limit: Number(limit),
            total,
            pages: Math.ceil(total / Number(limit))
          }
        }
      });
    } catch (error) {
      next(error);
    }
  }
}

export default StockController