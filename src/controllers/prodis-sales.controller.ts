import type { Request, Response, NextFunction } from 'express';
import prisma from '../../lib/prisma';
import { streamXlsx, type ExportColumn, type ExportSheet, wib } from '../utils/export.util';
import {
  ProdisError,
  anomalyPreview,
  ddMmYyyy,
  isoWib,
  prodisOk,
  prodisPaging,
  prodisRange,
  resolveStore,
  saleStatus,
  storeRef,
  validationFailed,
  wibMonthStart,
  wibToday
} from '../utils/prodis.util';

const saleItem = (merge: {
  id: number;
  numberKey: string;
  cardKey: string;
  number?: { remark: string | null } | null;
  soldAt: Date | null;
  verifiedAt: Date | null;
  anomalyAt: Date | null;
  anomalyNote: string | null;
}) => ({
  id: String(merge.id),
  msisdn: merge.numberKey,
  iccid: merge.cardKey,
  type: merge.number?.remark ?? null,
  status: saleStatus(merge.verifiedAt),
  soldAt: isoWib(merge.soldAt),
  anomaly: {
    flagged: !!merge.anomalyAt,
    notePreview: anomalyPreview(merge.anomalyNote)
  }
});

class ProdisSalesController {
  static async summary(req: Request, res: Response, next: NextFunction) {
    try {
      const range = prodisRange(req.query.from, req.query.to);
      const search = req.query.search ? String(req.query.search) : '';
      const period = { createdAt: { gte: range.from, lte: range.to } };

      const [cardCounts, otherCounts, cardAnomalies, otherAnomalies, totalThisMonth, totalToday] = await Promise.all([
        prisma.merge.groupBy({ by: ['checkpointCode'], where: period, _count: { _all: true } }),
        prisma.mergeAdditional.groupBy({ by: ['checkpointCode'], where: period, _count: { _all: true } }),
        prisma.merge.groupBy({ by: ['checkpointCode'], where: { ...period, anomalyAt: { not: null } }, _count: { _all: true } }),
        prisma.mergeAdditional.groupBy({ by: ['checkpointCode'], where: { ...period, anomalyAt: { not: null } }, _count: { _all: true } }),
        prisma.merge.count({ where: { createdAt: { gte: wibMonthStart() } } }),
        prisma.merge.count({ where: { createdAt: { gte: wibToday() } } })
      ]);

      const counts = new Map<string, { cardCount: number; otherCount: number; anomalyCount: number }>();
      const bump = (code: string | null, field: 'cardCount' | 'otherCount' | 'anomalyCount', value: number) => {
        if (!code) return;
        const row = counts.get(code) ?? { cardCount: 0, otherCount: 0, anomalyCount: 0 };
        row[field] += value;
        counts.set(code, row);
      };
      for (const row of cardCounts) bump(row.checkpointCode, 'cardCount', row._count._all);
      for (const row of otherCounts) bump(row.checkpointCode, 'otherCount', row._count._all);
      for (const row of cardAnomalies) bump(row.checkpointCode, 'anomalyCount', row._count._all);
      for (const row of otherAnomalies) bump(row.checkpointCode, 'anomalyCount', row._count._all);

      const codes = [...counts.entries()].filter(([, value]) => value.cardCount + value.otherCount > 0).map(([code]) => code);
      const stores = await prisma.checkpoint.findMany({
        where: {
          code: { in: codes },
          type: { in: ['STORE', 'DC'] },
          ...(search ? { OR: [{ name: { contains: search } }, { code: { contains: search } }] } : {})
        },
        select: { id: true, code: true, name: true }
      });

      prodisOk(res, {
        totalThisMonth,
        totalToday,
        period: { from: range.fromStr, to: range.toStr },
        stores: stores
          .map((store) => ({
            ...storeRef(store),
            ...(counts.get(store.code) ?? { cardCount: 0, otherCount: 0, anomalyCount: 0 })
          }))
          .sort((a, b) => a.name.localeCompare(b.name))
      });
    } catch (error) {
      next(error);
    }
  }

  static async storeCards(req: Request, res: Response, next: NextFunction) {
    try {
      const store = await resolveStore(req.params.storeId);
      const range = prodisRange(req.query.from, req.query.to);
      const paging = prodisPaging(req.query);

      const where: any = { checkpointCode: store.code, createdAt: { gte: range.from, lte: range.to } };
      if (req.query.search) where.number = { key: { startsWith: String(req.query.search) } };
      if (String(req.query.anomalyOnly) === 'true') where.anomalyAt = { not: null };

      const [rows, total, anomalyCount] = await Promise.all([
        prisma.merge.findMany({
          where,
          skip: paging.skip,
          take: paging.limit,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          include: { number: { select: { remark: true } } }
        }),
        prisma.merge.count({ where }),
        prisma.merge.count({
          where: { checkpointCode: store.code, createdAt: { gte: range.from, lte: range.to }, anomalyAt: { not: null } }
        })
      ]);

      prodisOk(res, rows.map(saleItem), { meta: { ...paging.meta(total), anomalyCount } });
    } catch (error) {
      next(error);
    }
  }

  static async storeOthers(req: Request, res: Response, next: NextFunction) {
    try {
      const store = await resolveStore(req.params.storeId);
      const range = prodisRange(req.query.from, req.query.to);
      const paging = prodisPaging(req.query);

      const where: any = { checkpointCode: store.code, createdAt: { gte: range.from, lte: range.to } };
      if (req.query.search) {
        const search = String(req.query.search);
        where.OR = [{ type: { contains: search } }, { remark: { contains: search } }];
      }

      const [rows, total] = await Promise.all([
        prisma.mergeAdditional.findMany({
          where,
          skip: paging.skip,
          take: paging.limit,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: { id: true, type: true, remark: true, soldAt: true }
        }),
        prisma.mergeAdditional.count({ where })
      ]);

      prodisOk(
        res,
        rows.map((row) => ({
          id: String(row.id),
          name: row.type ?? row.remark ?? 'Lainnya',
          qty: 1,
          soldAt: isoWib(row.soldAt)
        })),
        { meta: { ...paging.meta(total), totalQty: total } }
      );
    } catch (error) {
      next(error);
    }
  }

  static async saleDetail(req: Request, res: Response, next: NextFunction) {
    try {
      const id = Number(req.params.saleId);
      if (!Number.isInteger(id) || id < 1) throw new ProdisError(404, 'NOT_FOUND', 'Data not found');

      const merge = await prisma.merge.findUnique({
        where: { id },
        include: {
          number: { select: { remark: true } },
          card: { select: { name: true } },
          checkpoint: { select: { id: true, code: true, name: true } }
        }
      });
      if (!merge) throw new ProdisError(404, 'NOT_FOUND', 'Data not found');

      const flaggedBy = merge.anomalyByCode
        ? await prisma.user.findUnique({ where: { code: merge.anomalyByCode }, select: { name: true } })
        : null;
      const status = saleStatus(merge.verifiedAt);

      prodisOk(res, {
        id: String(merge.id),
        msisdn: merge.numberKey,
        iccid: merge.cardKey,
        trn: merge.TRN,
        type: merge.number?.remark ?? null,
        cardKind: merge.card?.name ?? null,
        verification: status,
        status,
        soldAt: isoWib(merge.soldAt),
        store: merge.checkpoint ? storeRef(merge.checkpoint) : null,
        anomaly: {
          flagged: !!merge.anomalyAt,
          note: merge.anomalyNote,
          flaggedAt: isoWib(merge.anomalyAt),
          flaggedBy: flaggedBy?.name ?? merge.anomalyByCode ?? null
        }
      });
    } catch (error) {
      next(error);
    }
  }

  static async lookup(req: Request, res: Response, next: NextFunction) {
    try {
      const { storeId: storeRefValue, from, to, msisdns } = req.body ?? {};
      const store = await resolveStore(storeRefValue);
      const range = prodisRange(from, to);

      if (!Array.isArray(msisdns) || msisdns.length < 1 || msisdns.length > 50 || msisdns.some((value) => typeof value !== 'string')) {
        throw validationFailed([{ field: 'msisdns', code: 'INVALID_VALUE', message: 'msisdns must be an array of 1-50 strings' }]);
      }
      const numbers = [...new Set((msisdns as string[]).map((value) => value.trim()).filter(Boolean))];

      const merges = await prisma.merge.findMany({
        where: { checkpointCode: store.code, createdAt: { gte: range.from, lte: range.to }, numberKey: { in: numbers } },
        include: { number: { select: { remark: true } } }
      });
      const foundKeys = new Set(merges.map((merge) => merge.numberKey));
      const found = merges.map(saleItem);
      const notFound = numbers.filter((number) => !foundKeys.has(number));

      prodisOk(res, { found, notFound }, { message: `${found.length} of ${numbers.length} numbers found` });
    } catch (error) {
      next(error);
    }
  }

  static async report(req: Request, res: Response, next: NextFunction) {
    try {
      const range = prodisRange(req.query.from, req.query.to);
      const store = req.query.storeId ? await resolveStore(req.query.storeId) : null;
      const where: any = { createdAt: { gte: range.from, lte: range.to } };
      if (store) where.checkpointCode = store.code;

      const [cardRows, otherRows] = await Promise.all([
        prisma.merge.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          select: {
            id: true, soldAt: true, createdAt: true, checkpointCode: true, numberKey: true, cardKey: true,
            verifiedAt: true, anomalyNote: true, anomalyAt: true,
            checkpoint: { select: { name: true } },
            number: { select: { remark: true } }
          }
        }),
        prisma.mergeAdditional.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          select: {
            id: true, soldAt: true, createdAt: true, checkpointCode: true, type: true,
            verifiedAt: true, anomalyNote: true, anomalyAt: true,
            checkpoint: { select: { name: true } }
          }
        })
      ]);

      if (cardRows.length + otherRows.length === 0) {
        throw new ProdisError(404, 'NO_DATA', 'No sales data for the selected period');
      }

      const statusLabel = (verifiedAt: Date | null) => saleStatus(verifiedAt);
      const anomalyLabel = (note: string | null, at: Date | null) => (at ? note ?? 'Ditandai anomali' : '');

      const columns: ExportColumn[] = [
        { header: 'Tanggal Terjual', key: 'soldAt', width: 16, type: 'date' },
        { header: 'Kode Toko', key: 'placeCode', width: 14 },
        { header: 'Nama Toko', key: 'placeName', width: 34 },
        { header: 'MSISDN', key: 'msisdn', width: 18 },
        { header: 'ICCID', key: 'iccid', width: 24 },
        { header: 'Tipe', key: 'type', width: 24 },
        { header: 'Status', key: 'status', width: 20 },
        { header: 'Anomali', key: 'anomaly', width: 34 }
      ];

      const sheets: ExportSheet[] = [
        {
          name: 'Nomor Kartu',
          columns,
          rows: (async function* () {
            yield cardRows.map((row) => ({
              soldAt: wib(row.soldAt ?? row.createdAt),
              placeCode: row.checkpointCode ?? '',
              placeName: row.checkpoint?.name ?? '',
              msisdn: row.numberKey,
              iccid: row.cardKey,
              type: row.number?.remark ?? '',
              status: statusLabel(row.verifiedAt),
              anomaly: anomalyLabel(row.anomalyNote, row.anomalyAt)
            }));
          })()
        },
        {
          name: 'Lainnya',
          columns: [
            { header: 'Tanggal Terjual', key: 'soldAt', width: 16, type: 'date' },
            { header: 'Kode Toko', key: 'placeCode', width: 14 },
            { header: 'Nama Toko', key: 'placeName', width: 34 },
            { header: 'Nama Barang', key: 'name', width: 30 },
            { header: 'Jumlah', key: 'qty', width: 10 },
            { header: 'Status', key: 'status', width: 20 },
            { header: 'Anomali', key: 'anomaly', width: 34 }
          ],
          rows: (async function* () {
            yield otherRows.map((row) => ({
              soldAt: wib(row.soldAt ?? row.createdAt),
              placeCode: row.checkpointCode ?? '',
              placeName: row.checkpoint?.name ?? '',
              name: row.type ?? 'Lainnya',
              qty: 1,
              status: statusLabel(row.verifiedAt),
              anomaly: anomalyLabel(row.anomalyNote, row.anomalyAt)
            }));
          })()
        }
      ];

      try {
        await streamXlsx(res, `Laporan_Penjualan_${ddMmYyyy(range.from)}`, sheets);
      } catch {
        if (!res.headersSent) {
          throw new ProdisError(503, 'REPORT_GENERATION_FAILED', 'Report generation failed');
        }
      }
    } catch (error) {
      next(error);
    }
  }
}

export default ProdisSalesController;
