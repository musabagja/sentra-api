import type { Request, Response, NextFunction } from 'express';
import { buildPlaceWhere } from '../utils/list-filters.util';
import prisma from '../../lib/prisma';
import { Prisma } from '../../generated/prisma/client';

import { hasCheckpointAccess, checkpointInCircle } from '../utils/access.util';

const CODE_PREFIX: Record<string, string> = { DC: 'DC', HQ: 'HQ', STORE: 'ST' };

const CHECKPOINT_TYPES = ['DC', 'STORE', 'HQ'];

// 2-12 characters: letters, digits and hyphens; stored uppercase. Existing codes
// are 2-10 characters and a few use hyphens (IMO01-02).
const CODE_PATTERN = /^[A-Z0-9][A-Z0-9-]{1,11}$/;
const CODE_FORMAT_HINT = 'Use 2-12 characters: letters, digits or hyphens';
const MAX_SUGGESTION_STEPS = 500;

const normalizeCheckpointCode = (raw: unknown): string =>
  typeof raw === 'string' ? raw.trim().toUpperCase() : '';

/** The column is case-insensitive (SQL_Latin1_General_CP1_CI_AS), so dc01 finds DC01 */
const isCheckpointCodeTaken = async (code: string): Promise<boolean> =>
  (await prisma.checkpoint.findUnique({ where: { code }, select: { id: true } })) !== null;

/**
 * Next code for a checkpoint type: the type's prefix plus one more than the
 * highest existing numeric suffix (DC10 -> DC11), padded to at least 2 digits,
 * then confirmed unused (it keeps counting up until a free one is found).
 * Codes with the prefix but a non-numeric suffix (e.g. imported store codes)
 * are ignored when picking the number.
 */
const generateCheckpointCode = async (type: string): Promise<string> => {
  const prefix = CODE_PREFIX[type]!;
  const existing = await prisma.checkpoint.findMany({
    where: { code: { startsWith: prefix } },
    select: { code: true }
  });

  const pattern = new RegExp(`^${prefix}(\\d+)$`, 'i');
  let max = 0;
  let width = 2;
  for (const { code } of existing) {
    const match = code.match(pattern);
    if (!match) continue;
    max = Math.max(max, Number(match[1]));
    width = Math.max(width, match[1]!.length);
  }

  for (let step = 1; step <= MAX_SUGGESTION_STEPS; step++) {
    const candidate = `${prefix}${String(max + step).padStart(width, '0')}`;
    if (!(await isCheckpointCodeTaken(candidate))) return candidate;
  }
  throw new Error('Could not find an unused code');
};

const httpError = (status: number, message: string) => {
  const err = new Error(message);
  (err as any).status = status;
  return err;
};

const badRequest = (message: string) => {
  const err = new Error(message);
  (err as any).status = 400;
  return err;
};

/**
 * Validates a list of circle codes: a non-empty string array (a checkpoint with
 * no circle would be visible to no one) whose codes all exist.
 */
const validateCircleCodes = async (circleCodes: unknown) => {
  if (!Array.isArray(circleCodes) || circleCodes.some((c) => typeof c !== 'string')) {
    throw badRequest('circleCodes must be an array of circle codes');
  }

  const linkedCircleCodes: string[] = [...new Set(circleCodes as string[])];
  if (linkedCircleCodes.length === 0) {
    throw badRequest('Select at least one region');
  }

  const circles = await prisma.circle.findMany({
    where: { code: { in: linkedCircleCodes } },
    select: { code: true, name: true }
  });
  const unknown = linkedCircleCodes.filter((c) => !circles.some((circle) => circle.code === c));
  if (unknown.length > 0) {
    throw badRequest(`Unknown region(s): ${unknown.join(', ')}`);
  }

  return { linkedCircleCodes, circles };
};

class CheckpointController {
  /** Live "is this code free?" check while the user types */
  static async checkCode(req: Request, res: Response, next: NextFunction) {
    try {
      const code = normalizeCheckpointCode(req.query.code);
      if (!CODE_PATTERN.test(code)) {
        res.status(200).json({
          message: 'Code checked',
          data: { code, valid: false, available: false, reason: CODE_FORMAT_HINT }
        });
        return;
      }

      const taken = await isCheckpointCodeTaken(code);
      res.status(200).json({
        message: 'Code checked',
        data: { code, valid: true, available: !taken }
      });
    } catch (error) {
      next(error);
    }
  }

  /** An unused code that starts with the type's prefix (ST / DC / HQ) */
  static async suggestCode(req: Request, res: Response, next: NextFunction) {
    try {
      const type = String(req.query.type || '');
      if (!CHECKPOINT_TYPES.includes(type)) {
        throw badRequest(`Invalid type. Must be one of: ${CHECKPOINT_TYPES.join(', ')}`);
      }

      res.status(200).json({
        message: 'Code suggested',
        data: { code: await generateCheckpointCode(type) }
      });
    } catch (error) {
      next(error);
    }
  }

  static async createCheckpoint(req: Request, res: Response, next: NextFunction) {
    try {
      const { type, name, circleCodes = [] } = req.body;

      if (!type || !name) {
        const err = new Error('type and name are required');
        (err as any).status = 400;
        throw err;
      }

      if (!CHECKPOINT_TYPES.includes(type)) {
        const err = new Error(`Invalid type. Must be one of: ${CHECKPOINT_TYPES.join(', ')}`);
        (err as any).status = 400;
        throw err;
      }

      const { linkedCircleCodes, circles } = await validateCircleCodes(circleCodes);

      // A code can be typed by the user; without one it is generated, as before
      const typedCode = req.body.code === undefined || req.body.code === '' ? null : normalizeCheckpointCode(req.body.code);
      if (typedCode !== null) {
        if (!CODE_PATTERN.test(typedCode)) throw badRequest(CODE_FORMAT_HINT);
        if (await isCheckpointCodeTaken(typedCode)) {
          throw httpError(409, `Code ${typedCode} is already used`);
        }
      }

      // A concurrent create can take the same generated code; regenerate and retry
      const MAX_ATTEMPTS = typedCode === null ? 3 : 1;
      let checkpoint;
      for (let attempt = 1; !checkpoint; attempt++) {
        const code = typedCode ?? (await generateCheckpointCode(type));
        try {
          checkpoint = await prisma.$transaction(async (tx) => {
            const created = await tx.checkpoint.create({
              data: { code, type, name: name.trim() }
            });

            await tx.checkpointCircle.createMany({
              data: linkedCircleCodes.map((circleCode) => ({ checkpointCode: code, circleCode }))
            });

            return created;
          });
        } catch (error) {
          const isDuplicate =
            error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
          if (isDuplicate && typedCode !== null) {
            throw httpError(409, `Code ${typedCode} is already used`);
          }
          if (!isDuplicate || attempt >= MAX_ATTEMPTS) throw error;
        }
      }

      res.status(201).json({
        message: 'Checkpoint created successfully',
        data: { checkpoint, circles }
      });
    } catch (error) {
      next(error);
    }
  }

  static async getCheckpoints(req: Request, res: Response, next: NextFunction) {
    try {
      const { page = 1, limit, startSoldAt, endSoldAt, withCircles } = req.query;
      const circleCode = req.user!.circleCode;

      // Scope to the checkpoints the user's circle covers; type / circle / search narrow it.
      // Shared with the Excel export so the file always matches the list.
      const where: Prisma.CheckpointWhereInput = buildPlaceWhere(req.query, circleCode);

      const includeMerges = !!(startSoldAt || endSoldAt);
      const mergesWhere: any = {};
      if (startSoldAt) {
        mergesWhere.createdAt = {
          gte: new Date(new Date(startSoldAt as string).setHours(0, 0, 0, 0))
        };
      }
      if (endSoldAt) {
        mergesWhere.createdAt = {
          ...(mergesWhere.createdAt || {}),
          lte: new Date(new Date(endSoldAt as string).setHours(23, 59, 59, 999))
        };
      }

      const paginated = limit !== undefined;

      // Circle names are only loaded for paginated pages: including the relation
      // for the whole list would expand into an IN list past SQL Server's
      // ~2100-parameter limit
      const includeCircles = withCircles === 'true' && paginated;

      const findManyOptions: any = {
        where,
        ...(paginated && {
          skip: (Number(page) - 1) * Number(limit),
          take: Number(limit),
        }),
        include: {
          _count: {
            select: {
              cards: true,
              merges: includeMerges ? { where: mergesWhere } : true
            }
          },
          ...(includeCircles && {
            checkpointCircles: {
              select: { circle: { select: { code: true, name: true } } }
            }
          })
        },
        orderBy: { id: 'asc' }
      };

      const [checkpoints, total] = await Promise.all([
        prisma.checkpoint.findMany(findManyOptions),
        prisma.checkpoint.count({ where })
      ]);

      res.status(200).json({
        message: 'Checkpoints retrieved successfully',
        data: { checkpoints },
        ...(paginated && {
          pagination: {
            page: Number(page),
            limit: Number(limit),
            total,
            pages: Math.ceil(total / Number(limit))
          }
        })
      });
    } catch (error) {
      next(error);
    }
  }

  // GET /api/checkpoint/options - every checkpoint of the caller's circle as { code, name, type },
  // light enough to fill a filter dropdown (no counts, no relations)
  static async getOptions(req: Request, res: Response, next: NextFunction) {
    try {
      const options = await prisma.checkpoint.findMany({
        where: buildPlaceWhere(req.query, req.user!.circleCode),
        select: { code: true, name: true, type: true },
        orderBy: { name: 'asc' }
      });
      res.status(200).json({ message: 'Checkpoint options retrieved successfully', data: { options } });
    } catch (error) {
      next(error);
    }
  }

  static async getCheckpoint(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const allowed = req.checkpointCodes ?? [];

      const checkpoint = await prisma.checkpoint.findUnique({
        where: { id: Number(id) },
        include: {
          cards: {
            take: 20,
            orderBy: { createdAt: 'desc' }
          },
          cardStock: {
            take: 1,
            orderBy: { createdAt: 'desc' }
          },
          checkpointCircles: {
            select: { circle: { select: { code: true, name: true } } }
          },
          _count: { select: { cards: true } }
        }
      });

      if (!checkpoint || !hasCheckpointAccess(checkpoint.code, allowed)) {
        const err = new Error('Checkpoint not found');
        (err as any).status = 404;
        throw err;
      }

      const [totalCard, totalSold, totalVerified] = await Promise.all([
        prisma.card.count({ where: { checkpointCode: checkpoint.code } }),
        prisma.card.count({ where: { checkpointCode: checkpoint.code, status: 'SOLD' } }),
        prisma.card.count({ where: { checkpointCode: checkpoint.code, status: 'VERIFIED' } })
      ]);

      res.status(200).json({
        message: 'Checkpoint retrieved successfully',
        data: {
          checkpoint,
          amount: { card: totalCard, sold: totalSold, verified: totalVerified }
        }
      });
    } catch (error) {
      next(error);
    }
  }

  static async updateCheckpoint(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      // Type and code are fixed: the code is referenced by cards, movements and sales,
      // and its prefix was generated from the type
      const { name, circleCodes } = req.body;
      const allowed = req.checkpointCodes ?? [];

      const trimmedName = typeof name === 'string' ? name.trim() : undefined;
      if (name !== undefined && !trimmedName) {
        throw badRequest('name cannot be empty');
      }

      const existing = await prisma.checkpoint.findUnique({ where: { id: Number(id) } });
      if (!existing || !hasCheckpointAccess(existing.code, allowed)) {
        const err = new Error('Checkpoint not found');
        (err as any).status = 404;
        throw err;
      }

      const regions = circleCodes !== undefined ? await validateCircleCodes(circleCodes) : null;

      const checkpoint = await prisma.$transaction(async (tx) => {
        const updated = await tx.checkpoint.update({
          where: { id: existing.id },
          data: { ...(trimmedName && { name: trimmedName }) }
        });

        if (regions) {
          await tx.checkpointCircle.deleteMany({
            where: {
              checkpointCode: existing.code,
              circleCode: { notIn: regions.linkedCircleCodes }
            }
          });
          const current = await tx.checkpointCircle.findMany({
            where: { checkpointCode: existing.code },
            select: { circleCode: true }
          });
          const toAdd = regions.linkedCircleCodes.filter(
            (code) => !current.some((link) => link.circleCode === code)
          );
          if (toAdd.length > 0) {
            await tx.checkpointCircle.createMany({
              data: toAdd.map((circleCode) => ({ checkpointCode: existing.code, circleCode }))
            });
          }
        }

        return updated;
      });

      res.status(200).json({
        message: 'Checkpoint updated successfully',
        data: { checkpoint, ...(regions && { circles: regions.circles }) }
      });
    } catch (error) {
      next(error);
    }
  }

  static async deleteCheckpoint(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const allowed = req.checkpointCodes ?? [];

      const existing = await prisma.checkpoint.findUnique({ where: { id: Number(id) } });
      if (!existing || !hasCheckpointAccess(existing.code, allowed)) {
        const err = new Error('Checkpoint not found');
        (err as any).status = 404;
        throw err;
      }

      const code = existing.code;
      const sourceOrTarget = { OR: [{ sourceCode: code }, { targetCode: code }] };
      const [
        cards,
        numbers,
        merges,
        mergeAdditionals,
        opnames,
        distributions,
        cardMovements,
        numberMovements
      ] = await Promise.all([
        prisma.card.count({ where: { checkpointCode: code } }),
        prisma.number.count({ where: { checkpointCode: code } }),
        prisma.merge.count({ where: { checkpointCode: code } }),
        prisma.mergeAdditional.count({ where: { checkpointCode: code } }),
        prisma.opname.count({ where: { checkpointCode: code } }),
        prisma.distribution.count({ where: sourceOrTarget }),
        prisma.cardMovement.count({ where: sourceOrTarget }),
        prisma.numberMovement.count({ where: sourceOrTarget })
      ]);

      if (cards > 0) {
        throw badRequest(`Cannot delete checkpoint: stock must be 0 (currently ${cards})`);
      }

      // These records keep the checkpoint's history, so it can't be removed
      const history = {
        distributions,
        movements: cardMovements + numberMovements,
        sales: merges + mergeAdditionals,
        opname: opnames,
        numbers
      };
      if (Object.values(history).some((count) => count > 0)) {
        const err = new Error('Cannot delete checkpoint: it still has history');
        (err as any).status = 409;
        (err as any).details = history;
        throw err;
      }

      await prisma.$transaction(async (tx) => {
        await tx.cardStock.deleteMany({ where: { checkpointCode: existing.code } });
        await tx.checkpointCircle.deleteMany({ where: { checkpointCode: existing.code } });
        await tx.checkpoint.delete({ where: { id: existing.id } });
      });

      res.status(200).json({ message: 'Checkpoint deleted successfully' });
    } catch (error) {
      next(error);
    }
  }
}

export default CheckpointController;
