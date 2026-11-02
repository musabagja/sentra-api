import type { Request, Response, NextFunction } from 'express';
import prisma from '../../lib/prisma';
import { resolveStoredFileUrl, uploadFile } from '../utils/minio.util';
import {
  ProdisError,
  employeeHasStore,
  employeeStoreWhere,
  isoWib,
  prodisOk,
  prodisPaging,
  resolveEmployee,
  resolveStore,
  storeRef,
  validationFailed
} from '../utils/prodis.util';

const LOCK_TTL_MS = 12 * 60 * 60 * 1000;
const ICCID_PATTERN = /^\d{19,20}$/;
const CONDITIONS = ['GOOD', 'DAMAGED', 'UNCHECKED'];
const SOURCES = ['AI', 'MANUAL', 'BARCODE'];

const pad4 = (value: number) => String(value).padStart(4, '0');

const effectiveLock = (lock: { status: string; lockedByCode: string | null; lockedAt: Date | null; expiresAt: Date | null } | null) => {
  if (!lock || lock.status !== 'IN_PROGRESS') return { status: 'IDLE', lockedByCode: null, lockedAt: null, expiresAt: null };
  if (lock.expiresAt && lock.expiresAt.getTime() <= Date.now()) {
    return { status: 'IDLE', lockedByCode: null, lockedAt: null, expiresAt: null };
  }
  return { status: 'IN_PROGRESS', lockedByCode: lock.lockedByCode, lockedAt: lock.lockedAt, expiresAt: lock.expiresAt };
};

const lockView = async (lock: { status: string; lockedByCode: string | null; lockedAt: Date | null; expiresAt: Date | null } | null) => {
  const effective = effectiveLock(lock);
  let lockedBy: { nrk: string; name: string } | null = null;
  if (effective.status === 'IN_PROGRESS' && effective.lockedByCode) {
    const user = await prisma.user.findUnique({ where: { code: effective.lockedByCode }, select: { code: true, name: true } });
    lockedBy = user ? { nrk: user.code, name: user.name } : { nrk: effective.lockedByCode, name: effective.lockedByCode };
  }
  return {
    status: effective.status,
    lockedBy,
    lockedAt: isoWib(effective.lockedAt),
    expiresAt: isoWib(effective.expiresAt)
  };
};

const requireOwnedLock = async (checkpointCode: string, employeeCode: string) => {
  const lock = await prisma.storeOpnameLock.findUnique({ where: { checkpointCode } });
  const effective = effectiveLock(lock);
  if (effective.status !== 'IN_PROGRESS' || effective.lockedByCode !== employeeCode) {
    throw new ProdisError(409, 'OPNAME_LOCK_NOT_OWNED', 'Stock opname lock is not owned by this employee');
  }
  return lock!;
};

const storeScopeCheck = async (employee: { code: string; name: string; circleCode: string }, checkpointCode: string) => {
  if (!(await employeeHasStore(employee, checkpointCode))) {
    throw new ProdisError(404, 'STORE_NOT_FOUND', 'Store not found');
  }
};

class ProdisOpnameController {
  static async list(req: Request, res: Response, next: NextFunction) {
    try {
      const employee = await resolveEmployee(req.query.nrk);
      const paging = prodisPaging(req.query);
      const store = req.query.storeId ? await resolveStore(req.query.storeId) : null;

      const where: any = { userCode: employee.code, status: 'COMPLETED' };
      if (store) where.checkpointCode = store.code;

      const [rows, total] = await Promise.all([
        prisma.opname.findMany({
          where,
          skip: paging.skip,
          take: paging.limit,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          include: {
            checkpoint: { select: { id: true, code: true, name: true } },
            submittance: { select: { createdAt: true } }
          }
        }),
        prisma.opname.count({ where })
      ]);

      const updateCounts = rows.length
        ? await prisma.opnameUpdate.groupBy({
            by: ['opnameID', 'status'],
            where: { opnameID: { in: rows.map((row) => row.id) } },
            _count: { status: true }
          })
        : [];
      const counts = new Map<number, { good: number; damaged: number }>();
      for (const row of updateCounts) {
        const entry = counts.get(row.opnameID) ?? { good: 0, damaged: 0 };
        if (row.status === 'OK') entry.good = row._count.status;
        if (row.status === 'BROKEN') entry.damaged = row._count.status;
        counts.set(row.opnameID, entry);
      }

      prodisOk(
        res,
        rows.map((opname) => {
          const entry = counts.get(opname.id) ?? { good: 0, damaged: 0 };
          return {
            id: String(opname.id),
            documentNo: opname.batch,
            store: opname.checkpoint ? storeRef(opname.checkpoint) : null,
            submittedAt: isoWib(opname.submittance?.createdAt ?? opname.createdAt),
            status: 'SUBMITTED',
            summary: {
              good: entry.good,
              damaged: entry.damaged,
              unchecked: Math.max(0, opname.amount - entry.good - entry.damaged),
              total: opname.amount
            }
          };
        }),
        { meta: paging.meta(total) }
      );
    } catch (error) {
      next(error);
    }
  }

  static async stores(req: Request, res: Response, next: NextFunction) {
    try {
      const employee = await resolveEmployee(req.query.nrk);
      const paging = prodisPaging(req.query);
      const search = req.query.search ? String(req.query.search) : '';
      const scope = await employeeStoreWhere(employee);

      const where: any = {
        ...scope,
        type: { in: ['STORE', 'DC'] },
        ...(search ? { OR: [{ name: { contains: search } }, { code: { contains: search } }] } : {})
      } as any;

      const [rows, total] = await Promise.all([
        prisma.checkpoint.findMany({
          where,
          skip: paging.skip,
          take: paging.limit,
          orderBy: { name: 'asc' },
          select: { id: true, code: true, name: true }
        }),
        prisma.checkpoint.count({ where })
      ]);

      const codes = rows.map((row) => row.code);
      const [cardCounts, locks] = await Promise.all([
        prisma.card.groupBy({
          by: ['checkpointCode'],
          where: { checkpointCode: { in: codes }, status: 'VERIFIED' },
          _count: { _all: true }
        }),
        prisma.storeOpnameLock.findMany({ where: { checkpointCode: { in: codes } } })
      ]);

      const countByCode = new Map(cardCounts.map((row) => [row.checkpointCode, row._count._all]));
      const lockByCode = new Map(locks.map((lock) => [lock.checkpointCode, lock]));
      const views = await Promise.all(rows.map((row) => lockView(lockByCode.get(row.code) ?? null)));

      prodisOk(
        res,
        rows.map((row, index) => ({
          ...storeRef(row),
          address: null,
          cardCount: countByCode.get(row.code) ?? 0,
          opname: views[index]
        })),
        { meta: paging.meta(total) }
      );
    } catch (error) {
      next(error);
    }
  }

  static async updateStoreStatus(req: Request, res: Response, next: NextFunction) {
    try {
      const { nrk, status } = req.body ?? {};
      const employee = await resolveEmployee(nrk);
      const store = await resolveStore(req.params.storeId);
      await storeScopeCheck(employee, store.code);

      const desired = String(status ?? '').toUpperCase();
      if (desired !== 'IN_PROGRESS' && desired !== 'IDLE') {
        throw validationFailed([{ field: 'status', code: 'INVALID_VALUE', message: 'status must be IN_PROGRESS or IDLE' }]);
      }

      await prisma.storeOpnameLock.upsert({
        where: { checkpointCode: store.code },
        update: {},
        create: { checkpointCode: store.code, status: 'IDLE' }
      });

      const now = new Date();
      if (desired === 'IN_PROGRESS') {
        const applied = await prisma.storeOpnameLock.updateMany({
          where: {
            checkpointCode: store.code,
            OR: [
              { status: 'IDLE' },
              { expiresAt: null },
              { expiresAt: { lt: now } },
              { lockedByCode: employee.code }
            ]
          },
          data: {
            status: 'IN_PROGRESS',
            lockedByCode: employee.code,
            lockedAt: now,
            expiresAt: new Date(now.getTime() + LOCK_TTL_MS)
          }
        });
        if (applied.count === 0) {
          const lock = await prisma.storeOpnameLock.findUnique({ where: { checkpointCode: store.code } });
          throw new ProdisError(409, 'STORE_OPNAME_IN_PROGRESS', 'Store is currently being stock opnamed by another employee', {
            data: { store: storeRef(store), opname: await lockView(lock) }
          });
        }
      } else {
        const released = await prisma.storeOpnameLock.updateMany({
          where: { checkpointCode: store.code, status: 'IN_PROGRESS', lockedByCode: employee.code },
          data: { status: 'IDLE', lockedByCode: null, lockedAt: null, expiresAt: null }
        });
        if (released.count === 0) {
          throw new ProdisError(409, 'OPNAME_LOCK_NOT_OWNED', 'Stock opname lock is not owned by this employee');
        }
      }

      const lock = await prisma.storeOpnameLock.findUnique({ where: { checkpointCode: store.code } });
      prodisOk(res, { store: storeRef(store), opname: await lockView(lock) }, { message: 'Store opname status updated' });
    } catch (error) {
      next(error);
    }
  }

  static async storeCards(req: Request, res: Response, next: NextFunction) {
    try {
      const employee = await resolveEmployee(req.query.nrk);
      const store = await resolveStore(req.params.storeId);
      await storeScopeCheck(employee, store.code);
      await requireOwnedLock(store.code, employee.code);

      const cards = await prisma.card.findMany({
        where: { checkpointCode: store.code, status: 'VERIFIED' },
        select: { key: true },
        orderBy: { key: 'asc' }
      });

      prodisOk(res, {
        store: { ...storeRef(store), address: null },
        total: cards.length,
        iccids: cards.map((card) => card.key),
        syncedAt: isoWib(new Date())
      });
    } catch (error) {
      next(error);
    }
  }

  static async validateIccids(req: Request, res: Response, next: NextFunction) {
    try {
      const { nrk, storeId: storeRefValue, iccids } = req.body ?? {};
      const employee = await resolveEmployee(nrk);
      const store = await resolveStore(storeRefValue);
      await storeScopeCheck(employee, store.code);

      if (!Array.isArray(iccids) || iccids.length < 1 || iccids.length > 100 || iccids.some((value) => typeof value !== 'string')) {
        throw validationFailed([{ field: 'iccids', code: 'INVALID_VALUE', message: 'iccids must be an array of 1-100 strings' }]);
      }
      const values = (iccids as string[]).map((value) => value.trim());
      if (new Set(values).size !== values.length) {
        throw validationFailed([{ field: 'iccids', code: 'DUPLICATE', message: 'iccids must be unique' }]);
      }

      const valid = values.filter((value) => ICCID_PATTERN.test(value));
      const cards = valid.length
        ? await prisma.card.findMany({
            where: { key: { in: valid }, checkpointCode: store.code, status: 'VERIFIED' },
            select: { key: true }
          })
        : [];
      const foundKeys = new Set(cards.map((card) => card.key));

      const items = values.map((iccid) => {
        if (!ICCID_PATTERN.test(iccid)) {
          return { iccid, status: 'INVALID_FORMAT', condition: null, reason: 'ICCID must be 19-20 digits' };
        }
        if (!foundKeys.has(iccid)) {
          return { iccid, status: 'NOT_IN_STORE', condition: null, reason: `Card is not registered in store ${store.code} stock` };
        }
        return { iccid, status: 'FOUND', condition: 'GOOD', reason: null };
      });

      const found = items.filter((item) => item.status === 'FOUND').length;
      prodisOk(res, { items }, { message: `${found} of ${values.length} cards found in store` });
    } catch (error) {
      next(error);
    }
  }

  static async submit(req: Request, res: Response, next: NextFunction) {
    try {
      const {
        nrk,
        storeId: storeRefValue,
        startedAt,
        items: rawItems,
        note,
        witnessName
      } = req.body ?? {};

      const files = ((req as any).files ?? {}) as Record<string, Express.Multer.File[]>;
      const fileFor = (field: string) => files[field]?.[0];
      const executorSignatureFile = fileFor('executorSignature');
      const witnessSignatureFile = fileFor('witnessSignature');
      const photoCardsFile = fileFor('photoCards');
      const photoDisplayFile = fileFor('photoDisplay');

      const employee = await resolveEmployee(nrk);
      const store = await resolveStore(storeRefValue);
      await storeScopeCheck(employee, store.code);

      const errors: { field: string; code: string; message: string }[] = [];
      if (typeof witnessName !== 'string' || !witnessName.trim()) {
        errors.push({ field: 'witnessName', code: 'REQUIRED', message: 'witnessName is required' });
      }
      if (typeof note === 'string' && note.length > 500) {
        errors.push({ field: 'note', code: 'TOO_LONG', message: 'note must be at most 500 characters' });
      }
      if (typeof startedAt !== 'string' || Number.isNaN(new Date(startedAt).getTime())) {
        errors.push({ field: 'startedAt', code: 'INVALID_FORMAT', message: 'startedAt must be an ISO 8601 date' });
      }
      for (const [field, file] of [
        ['executorSignature', executorSignatureFile],
        ['witnessSignature', witnessSignatureFile],
        ['photoCards', photoCardsFile],
        ['photoDisplay', photoDisplayFile]
      ] as const) {
        if (!file || !file.buffer?.length) errors.push({ field, code: 'REQUIRED', message: `${field} is required` });
      }
      if (errors.length > 0) throw validationFailed(errors);

      const storeAttachment = async (file: Express.Multer.File, field: string) => {
        try {
          const stored = await uploadFile(file, { prefix: field });
          return stored.fileName;
        } catch {
          throw new ProdisError(503, 'SERVICE_UNAVAILABLE', `Failed to store ${field}`);
        }
      };
      const executorSignatureName = await storeAttachment(executorSignatureFile!, 'executorSignature');
      const witnessSignatureName = await storeAttachment(witnessSignatureFile!, 'witnessSignature');
      const photoCardsName = await storeAttachment(photoCardsFile!, 'photoCards');
      const photoDisplayName = await storeAttachment(photoDisplayFile!, 'photoDisplay');

      let parsed: any[] = [];
      try {
        parsed = typeof rawItems === 'string' ? JSON.parse(rawItems) : rawItems;
      } catch {
        throw validationFailed([{ field: 'items', code: 'INVALID_FORMAT', message: 'items must be a JSON array' }]);
      }
      if (!Array.isArray(parsed) || parsed.length === 0) {
        throw validationFailed([{ field: 'items', code: 'REQUIRED', message: 'items must contain at least 1 card' }]);
      }

      const itemErrors: { field: string; code: string; message: string }[] = [];
      const seen = new Set<string>();
      parsed.forEach((item, index) => {
        const iccid = typeof item?.iccid === 'string' ? item.iccid.trim() : '';
        const condition = String(item?.condition ?? '').toUpperCase();
        const source = String(item?.source ?? '').toUpperCase();
        if (!ICCID_PATTERN.test(iccid)) {
          itemErrors.push({ field: `items[${index}].iccid`, code: 'INVALID_FORMAT', message: 'ICCID must be 19-20 digits' });
        } else if (seen.has(iccid)) {
          itemErrors.push({ field: `items[${index}].iccid`, code: 'DUPLICATE', message: `${iccid} appears more than once` });
        }
        seen.add(iccid);
        if (!CONDITIONS.includes(condition) || condition === 'UNCHECKED') {
          itemErrors.push({ field: `items[${index}].condition`, code: 'INVALID_VALUE', message: 'condition must be GOOD or DAMAGED' });
        }
        if (source && !SOURCES.includes(source)) {
          itemErrors.push({ field: `items[${index}].source`, code: 'INVALID_VALUE', message: 'source must be AI, MANUAL or BARCODE' });
        }
      });
      if (itemErrors.length > 0) throw validationFailed(itemErrors);

      const storeCards = await prisma.card.findMany({
        where: { checkpointCode: store.code, status: 'VERIFIED' },
        select: { id: true, key: true }
      });
      const cardByKey = new Map(storeCards.map((card) => [card.key, card]));
      const notInStore = parsed.filter((item) => !cardByKey.has(String(item.iccid).trim()));
      if (notInStore.length > 0) {
        throw new ProdisError(422, 'ICCID_NOT_IN_STORE', 'Some cards are not registered in this store', {
          errors: notInStore.map((item) => ({
            field: `items[${parsed.indexOf(item)}].iccid`,
            code: 'NOT_IN_STORE',
            message: `${String(item.iccid).trim()} is not registered in store ${store.id}`
          }))
        });
      }

      await requireOwnedLock(store.code, employee.code);

      const good = parsed.filter((item) => String(item.condition).toUpperCase() === 'GOOD').length;
      const damaged = parsed.length - good;
      const unchecked = Math.max(0, storeCards.length - parsed.length);
      const now = new Date();

      const opname = await prisma.$transaction(async (tx) => {
        const wibNow = new Date(now.getTime() + 7 * 60 * 60 * 1000);
        const year = wibNow.getUTCFullYear();
        const month = String(wibNow.getUTCMonth() + 1).padStart(2, '0');
        const prefix = `BA-SO/${store.code}/${year}/${month}/`;
        const sequence = await tx.opname.count({ where: { checkpointCode: store.code, batch: { startsWith: prefix } } });
        const documentNo = `${prefix}${pad4(sequence + 1)}`;

        const created = await tx.opname.create({
          data: {
            amount: storeCards.length,
            progress: parsed.length,
            batch: documentNo,
            status: 'COMPLETED',
            type: 'ICCID',
            checkpointCode: store.code,
            userCode: employee.code,
            startedAt: new Date(startedAt)
          }
        });

        for (const item of parsed) {
          const card = cardByKey.get(String(item.iccid).trim())!;
          const condition = String(item.condition).toUpperCase();
          await tx.opnameUpdate.create({
            data: {
              itemID: card.id,
              status: condition === 'GOOD' ? 'OK' : 'BROKEN',
              opnameID: created.id,
              userCode: employee.code,
              source: item.source ? String(item.source).toUpperCase() : null
            }
          });
          await tx.card.update({
            where: { id: card.id },
            data: { status: condition === 'GOOD' ? 'VERIFIED' : 'BROKEN' }
          });
        }

        if (damaged > 0) {
          const stock = await tx.cardStock.findFirst({
            where: { checkpointCode: store.code },
            orderBy: { createdAt: 'desc' }
          });
          await tx.cardStock.create({
            data: { checkpointCode: store.code, amount: Math.max(0, (stock?.amount ?? storeCards.length) - damaged) }
          });
        }

        await tx.opnameSubmittance.create({
          data: {
            opnameID: created.id,
            userCode: employee.code,
            signURL: executorSignatureName,
            picSignURL: witnessSignatureName,
            picName: witnessName,
            documentationURL: photoCardsName,
            note: typeof note === 'string' && note.trim() ? note.trim() : null,
            documentations: {
              createMany: {
                data: [{ url: photoCardsName }, { url: photoDisplayName }]
              }
            }
          }
        });

        await tx.storeOpnameLock.update({
          where: { checkpointCode: store.code },
          data: { status: 'IDLE', lockedByCode: null, lockedAt: null, expiresAt: null }
        });

        return created;
      });

      prodisOk(
        res,
        {
          id: String(opname.id),
          documentNo: opname.batch,
          store: storeRef(store),
          submittedAt: isoWib(opname.createdAt),
          status: 'SUBMITTED',
          summary: { good, damaged, unchecked, total: storeCards.length }
        },
        { status: 201, message: 'Stock opname submitted successfully' }
      );
    } catch (error) {
      next(error);
    }
  }

  static async detail(req: Request, res: Response, next: NextFunction) {
    try {
      const employee = await resolveEmployee(req.query.nrk);
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id < 1) throw new ProdisError(404, 'NOT_FOUND', 'Data not found');

      const opname = await prisma.opname.findFirst({
        where: { id, userCode: employee.code },
        include: {
          checkpoint: { select: { id: true, code: true, name: true } },
          user: { select: { code: true, name: true } },
          submittance: { include: { documentations: true } },
          updates: { select: { itemID: true, status: true, source: true } }
        }
      });
      if (!opname) throw new ProdisError(404, 'NOT_FOUND', 'Data not found');

      const updatedIds = opname.updates.map((update) => update.itemID);
      const [updatedCards, remainingCards] = await Promise.all([
        updatedIds.length
          ? prisma.card.findMany({ where: { id: { in: updatedIds } }, select: { id: true, key: true } })
          : [],
        opname.checkpointCode
          ? prisma.card.findMany({
              where: { checkpointCode: opname.checkpointCode, status: 'VERIFIED', id: { notIn: updatedIds.length ? updatedIds : [-1] } },
              select: { id: true, key: true }
            })
          : []
      ]);
      const keyByItem = new Map(updatedCards.map((card) => [card.id, card.key]));

      const items = [
        ...opname.updates.map((update) => ({
          iccid: keyByItem.get(update.itemID) ?? String(update.itemID),
          condition: update.status === 'OK' ? 'GOOD' : 'DAMAGED',
          source: update.source
        })),
        ...remainingCards.map((card) => ({ iccid: card.key, condition: 'UNCHECKED', source: null }))
      ].sort((a, b) => a.iccid.localeCompare(b.iccid));

      const good = opname.updates.filter((update) => update.status === 'OK').length;
      const damaged = opname.updates.filter((update) => update.status === 'BROKEN').length;
      const documents = [...(opname.submittance?.documentations ?? [])].sort((a, b) => a.id - b.id);

      const storedAttachments = {
        executorSignature: opname.submittance?.signURL ?? null,
        witnessSignature: opname.submittance?.picSignURL ?? null,
        photoCards: documents[0]?.url ?? opname.submittance?.documentationURL ?? null,
        photoDisplay: documents[1]?.url ?? null
      };

      const [executorSignatureUrl, witnessSignatureUrl, photoCardsUrl, photoDisplayUrl] = await Promise.all([
        resolveStoredFileUrl(storedAttachments.executorSignature),
        resolveStoredFileUrl(storedAttachments.witnessSignature),
        resolveStoredFileUrl(storedAttachments.photoCards),
        resolveStoredFileUrl(storedAttachments.photoDisplay)
      ]);

      prodisOk(res, {
        id: String(opname.id),
        documentNo: opname.batch,
        store: opname.checkpoint ? storeRef(opname.checkpoint) : null,
        executor: { nrk: opname.user.code, name: opname.user.name },
        witnessName: opname.submittance?.picName ?? null,
        startedAt: isoWib(opname.startedAt ?? opname.createdAt),
        submittedAt: isoWib(opname.submittance?.createdAt ?? opname.createdAt),
        status: 'SUBMITTED',
        note: opname.submittance?.note ?? null,
        summary: { good, damaged, unchecked: Math.max(0, opname.amount - good - damaged), total: opname.amount },
        items,
        attachments: {
          executorSignatureUrl,
          witnessSignatureUrl,
          photoCardsUrl,
          photoDisplayUrl
        },
        attachmentFiles: storedAttachments
      });
    } catch (error) {
      next(error);
    }
  }
}

export default ProdisOpnameController;
