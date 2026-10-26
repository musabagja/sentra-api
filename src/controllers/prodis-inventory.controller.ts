import type { Request, Response, NextFunction } from 'express';
import prisma from '../../lib/prisma';
import {
  ProdisError,
  cardStatusFromApp,
  cardStatusToApp,
  isoWib,
  numberStatusToApp,
  prodisDay,
  prodisOk,
  prodisPaging,
  resolveEmployee,
  validationFailed,
  wibEndOfDay
} from '../utils/prodis.util';

const ICCID_SELECT = {
  key: true,
  status: true,
  batchCode: true,
  checkpointCode: true,
  createdAt: true,
  validatedAt: true
} as const;

const iccidItem = (card: {
  key: string;
  status: string;
  batchCode: string;
  checkpointCode: string | null;
  createdAt: Date;
  validatedAt: Date | null;
}) => ({
  iccid: card.key,
  status: cardStatusToApp(card.status),
  batch: card.batchCode,
  locationCode: card.checkpointCode,
  uploadedAt: isoWib(card.createdAt),
  verifiedAt: isoWib(card.validatedAt)
});

const MSISDN_SELECT = {
  key: true,
  status: true,
  remark: true,
  batchCode: true,
  createdAt: true,
  merge: { select: { soldAt: true } }
} as const;

const msisdnItem = (row: {
  key: string;
  status: string;
  remark: string | null;
  batchCode: string;
  createdAt: Date;
  merge: { soldAt: Date | null } | null;
}) => ({
  msisdn: row.key,
  status: numberStatusToApp(row.status),
  type: row.remark,
  batch: row.batchCode,
  uploadedAt: isoWib(row.createdAt),
  soldAt: isoWib(row.merge?.soldAt ?? null)
});

class ProdisInventoryController {
  static async access(req: Request, res: Response, next: NextFunction) {
    try {
      const employee = await resolveEmployee(req.query.nrk);
      prodisOk(res, {
        employee: { nrk: employee.code, name: employee.name },
        hasAccess: true,
        menus: [
          { key: 'stockOpname', enabled: true, reason: null },
          { key: 'inventory', enabled: true, reason: null },
          { key: 'sales', enabled: true, reason: null }
        ]
      });
    } catch (error) {
      next(error);
    }
  }

  static async summary(req: Request, res: Response, next: NextFunction) {
    try {
      const [uploaded, sold, available] = await Promise.all([
        prisma.card.count(),
        prisma.card.count({ where: { status: 'SOLD' } }),
        prisma.card.count({ where: { status: 'VERIFIED' } })
      ]);
      prodisOk(res, { uploaded, sold, available });
    } catch (error) {
      next(error);
    }
  }

  static async iccidList(req: Request, res: Response, next: NextFunction) {
    try {
      const { search, batch, verifiedFrom, verifiedTo, status } = req.query;
      const paging = prodisPaging(req.query);

      const where: any = {};
      if (search) where.key = { startsWith: String(search) };
      if (batch) where.batchCode = String(batch);
      if (verifiedFrom || verifiedTo) {
        where.validatedAt = {
          ...(verifiedFrom && { gte: prodisDay(verifiedFrom, 'verifiedFrom') }),
          ...(verifiedTo && { lte: wibEndOfDay(String(verifiedTo)) })
        };
      }
      if (status !== undefined && status !== '') {
        const dbStatus = cardStatusFromApp(String(status));
        if (!dbStatus) {
          throw validationFailed([
            { field: 'status', code: 'INVALID_VALUE', message: 'status must be one of VERIFIED, SOLD, DAMAGED, LOST' }
          ]);
        }
        where.status = dbStatus;
      }

      const [rows, total] = await Promise.all([
        prisma.card.findMany({
          where,
          skip: paging.skip,
          take: paging.limit,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: ICCID_SELECT
        }),
        prisma.card.count({ where })
      ]);

      prodisOk(res, rows.map(iccidItem), { meta: paging.meta(total) });
    } catch (error) {
      next(error);
    }
  }

  static async msisdnList(req: Request, res: Response, next: NextFunction) {
    try {
      const { search, status } = req.query;
      const paging = prodisPaging(req.query);

      const where: any = {};
      if (search) where.key = { startsWith: String(search) };
      if (status !== undefined && status !== '') {
        const value = String(status).toUpperCase();
        if (value !== 'SOLD' && value !== 'AVAILABLE') {
          throw validationFailed([{ field: 'status', code: 'INVALID_VALUE', message: 'status must be one of SOLD, AVAILABLE' }]);
        }
        where.status = value === 'SOLD' ? 'SOLD' : 'VERIFIED';
      }

      const [rows, total] = await Promise.all([
        prisma.number.findMany({
          where,
          skip: paging.skip,
          take: paging.limit,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: MSISDN_SELECT
        }),
        prisma.number.count({ where })
      ]);

      prodisOk(res, rows.map(msisdnItem), { meta: paging.meta(total) });
    } catch (error) {
      next(error);
    }
  }

  static async msisdnLookup(req: Request, res: Response, next: NextFunction) {
    try {
      const raw = req.body?.msisdns;
      if (!Array.isArray(raw) || raw.length < 1 || raw.length > 50 || raw.some((value) => typeof value !== 'string')) {
        throw validationFailed([
          { field: 'msisdns', code: 'INVALID_VALUE', message: 'msisdns must be an array of 1-50 strings' }
        ]);
      }
      const msisdns = [...new Set((raw as string[]).map((value) => value.trim()).filter(Boolean))];

      const numbers = await prisma.number.findMany({ where: { key: { in: msisdns } }, select: MSISDN_SELECT });
      const byKey = new Map(numbers.map((number) => [number.key, number]));

      const found = msisdns.filter((msisdn) => byKey.has(msisdn)).map((msisdn) => msisdnItem(byKey.get(msisdn)!));
      const notFound = msisdns.filter((msisdn) => !byKey.has(msisdn));

      prodisOk(res, { found, notFound }, { message: `${found.length} of ${msisdns.length} numbers found` });
    } catch (error) {
      next(error);
    }
  }

  static async filters(req: Request, res: Response, next: NextFunction) {
    try {
      const batches = await prisma.card.findMany({
        distinct: ['batchCode'],
        select: { batchCode: true },
        orderBy: { batchCode: 'asc' },
        take: 200
      });
      prodisOk(res, {
        batches: batches.map((row) => row.batchCode),
        statuses: ['VERIFIED', 'SOLD', 'DAMAGED', 'LOST']
      });
    } catch (error) {
      next(error);
    }
  }

  static async iccidDetail(req: Request, res: Response, next: NextFunction) {
    try {
      const key = String(req.params.iccid);
      const card = await prisma.card.findUnique({
        where: { key },
        select: { ...ICCID_SELECT, merge: { select: { numberKey: true } } }
      });
      if (!card) throw new ProdisError(404, 'NOT_FOUND', 'Data not found');
      prodisOk(res, { ...iccidItem(card), msisdn: card.merge?.numberKey ?? null });
    } catch (error) {
      next(error);
    }
  }

  static async iccidLookup(req: Request, res: Response, next: NextFunction) {
    try {
      const raw = req.body?.iccids;
      if (!Array.isArray(raw) || raw.length < 1 || raw.length > 50 || raw.some((value) => typeof value !== 'string')) {
        throw validationFailed([
          { field: 'iccids', code: 'INVALID_VALUE', message: 'iccids must be an array of 1-50 strings' }
        ]);
      }
      const iccids = [...new Set((raw as string[]).map((value) => value.trim()).filter(Boolean))];

      const cards = await prisma.card.findMany({ where: { key: { in: iccids } }, select: ICCID_SELECT });
      const byKey = new Map(cards.map((card) => [card.key, card]));

      const found = iccids.filter((iccid) => byKey.has(iccid)).map((iccid) => iccidItem(byKey.get(iccid)!));
      const notFound = iccids.filter((iccid) => !byKey.has(iccid));

      prodisOk(res, { found, notFound }, { message: `${found.length} of ${iccids.length} numbers found` });
    } catch (error) {
      next(error);
    }
  }
}

export default ProdisInventoryController;
