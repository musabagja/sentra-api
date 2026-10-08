import type { Request, Response, NextFunction } from 'express';
import prisma from '../../lib/prisma';
import {
  buildBatchWhere,
  buildCardWhere,
  buildDistributionWhere,
  buildNumberWhere,
  buildPlaceWhere,
  buildSoldRange
} from '../utils/list-filters.util';
import { rankSalesByPlace } from '../utils/sales-ranking.util';
import { assertExportSize, keysetPages, streamXlsx, wib } from '../utils/export.util';
import { checkpointInCircle } from '../utils/access.util';
import type { ExportColumn, ExportSheet } from '../utils/export.util';

// Same Indonesian labels the pages show
const CARD_STATUS: Record<string, string> = {
  VERIFIED: 'Baik', SOLD: 'Terjual', BROKEN: 'Rusak', LOST: 'Hilang',
  DELIVERY: 'Dalam Pengiriman', UNVERIFIED: 'Belum Verifikasi', OPNAME: 'Sedang Stock Opname'
};
const NUMBER_STATUS: Record<string, string> = {
  VERIFIED: 'Tersedia', SOLD: 'Terjual', BROKEN: 'Rusak', LOST: 'Hilang', HOLD: 'Ditahan', UNVERIFIED: 'Belum Verifikasi'
};
const DISTRIBUTION_STATUS: Record<string, string> = {
  SCHEDULED: 'Terjadwal', DELIVERED: 'Terkirim', CANCELLED: 'Dibatalkan'
};
const PLACE_TYPE: Record<string, string> = { STORE: 'Toko', DC: 'DC', HQ: 'HQ' };
const BATCH_STATUS: Record<string, string> = { ONGOING: 'Verifikasi Berlangsung', COMPLETED: 'Verifikasi Selesai' };

const today = () => new Date().toISOString().slice(0, 10);
const label = (map: Record<string, string>, value: string | null | undefined) =>
  value ? map[value] ?? value : '';

/** Numbers the rows across chunks: No 1, 2, 3 ... */
async function* numbered(chunks: AsyncIterable<Record<string, unknown>[]>) {
  let n = 0;
  for await (const chunk of chunks) {
    yield chunk.map(row => ({ no: ++n, ...row }));
  }
}

async function* mapChunks<T>(source: AsyncIterable<T[]>, map: (rows: T[]) => Promise<Record<string, unknown>[]> | Record<string, unknown>[]) {
  for await (const rows of source) yield await map(rows);
}

const NO: ExportColumn = { header: 'No', key: 'no', width: 8 };

export default class ExportController {
  // GET /api/stock/batches/export - Pengadaan: upload batches (+ detail=true: their ICCIDs and MSISDNs)
  static async batches(req: Request, res: Response, next: NextFunction) {
    try {
      const circleCode = req.user!.circleCode;
      const withDetail = req.query.detail === 'true';
      const where = buildBatchWhere(req.query, circleCode);
      assertExportSize(await prisma.uploadBatch.count({ where }));

      // The detail sheets follow the same batches through the relation, never an IN list of codes
      const cardWhere = { checkpoint: checkpointInCircle(circleCode), uploadBatch: where };
      const numberWhere = {
        OR: [{ checkpoint: checkpointInCircle(circleCode) }, { checkpointCode: null }],
        uploadBatch: where
      };
      if (withDetail) {
        assertExportSize(await prisma.card.count({ where: cardWhere }));
        assertExportSize(await prisma.number.count({ where: numberWhere }));
      }

      const pages = keysetPages(
        ({ where, take }) =>
          prisma.uploadBatch.findMany({
            where,
            take,
            orderBy: { id: 'desc' },
            select: {
              id: true, code: true, createdAt: true, status: true, total: true, note: true,
              progress: { take: 1, orderBy: { createdAt: 'desc' }, select: { progress: true } }
            }
          }),
        where,
        500
      );

      const sheets: ExportSheet[] = [{
        name: 'Batch',
        columns: [
          NO,
          { header: 'Nomor Batch', key: 'code', width: 16 },
          { header: 'Tgl Upload', key: 'createdAt', width: 16, type: 'date' },
          { header: 'Total ICCID', key: 'total', width: 14 },
          { header: 'Terverifikasi', key: 'verified', width: 14 },
          { header: 'Belum Diverifikasi', key: 'unverified', width: 20 },
          { header: 'Total MSISDN', key: 'numbers', width: 14 },
          { header: 'Status', key: 'status', width: 24 },
          { header: 'Catatan', key: 'note', width: 40 }
        ],
        rows: numbered(mapChunks(pages, async rows => {
          const codes = rows.map(r => r.code);
          const [unverified, numbers] = await Promise.all([
            prisma.card.groupBy({ by: ['batchCode'], _count: { _all: true }, where: { batchCode: { in: codes }, status: 'UNVERIFIED' } }),
            prisma.number.groupBy({ by: ['batchCode'], _count: { _all: true }, where: { batchCode: { in: codes } } })
          ]);
          const unverifiedBy = new Map(unverified.map(r => [r.batchCode, r._count._all]));
          const numbersBy = new Map(numbers.map(r => [r.batchCode, r._count._all]));
          return rows.map(b => ({
            code: b.code,
            createdAt: wib(b.createdAt),
            total: b.total,
            verified: b.progress[0]?.progress ?? 0,
            unverified: unverifiedBy.get(b.code) ?? 0,
            numbers: numbersBy.get(b.code) ?? 0,
            status: label(BATCH_STATUS, b.status),
            note: b.note ?? ''
          }));
        }))
      }];

      if (withDetail) {
        sheets.push({
          name: 'ICCID',
          columns: [
            NO,
            { header: 'Nomor Batch', key: 'batch', width: 16 },
            { header: 'Nomor ICCID', key: 'iccid', width: 24 },
            { header: 'Kode Tempat', key: 'placeCode', width: 14 },
            { header: 'Nama Tempat', key: 'placeName', width: 34 },
            { header: 'Tgl Upload', key: 'createdAt', width: 16, type: 'date' },
            { header: 'Tgl Verifikasi', key: 'validatedAt', width: 16, type: 'date' },
            { header: 'Status', key: 'status', width: 20 }
          ],
          rows: numbered(mapChunks(
            keysetPages(
              ({ where, take }) =>
                prisma.card.findMany({
                  where,
                  take,
                  orderBy: { id: 'desc' },
                  select: {
                    id: true, key: true, batchCode: true, checkpointCode: true, status: true,
                    createdAt: true, validatedAt: true, checkpoint: { select: { name: true } }
                  }
                }),
              cardWhere
            ),
            rows => rows.map(c => ({
              batch: c.batchCode,
              iccid: c.key,
              placeCode: c.checkpointCode,
              placeName: c.checkpoint?.name ?? '',
              createdAt: wib(c.createdAt),
              validatedAt: wib(c.validatedAt),
              status: label(CARD_STATUS, c.status)
            }))
          ))
        });
        sheets.push({
          name: 'MSISDN',
          columns: [
            NO,
            { header: 'Nomor Batch', key: 'batch', width: 16 },
            { header: 'Nomor MSISDN', key: 'msisdn', width: 18 },
            { header: 'Tipe', key: 'type', width: 32 },
            { header: 'Tgl Upload', key: 'createdAt', width: 16, type: 'date' }
          ],
          rows: numbered(mapChunks(
            keysetPages(
              ({ where, take }) =>
                prisma.number.findMany({
                  where,
                  take,
                  orderBy: { id: 'desc' },
                  select: { id: true, key: true, batchCode: true, remark: true, createdAt: true }
                }),
              numberWhere
            ),
            rows => rows.map(n => ({ batch: n.batchCode, msisdn: n.key, type: n.remark ?? '', createdAt: wib(n.createdAt) }))
          ))
        });
      }

      const only = typeof req.query.batch === 'string' && !req.query.batch.includes(',') ? ` ${req.query.batch}` : '';
      await streamXlsx(res, `Pengadaan${only} ${today()}`, sheets);
    } catch (error) {
      next(error);
    }
  }

  // GET /api/stock/cards/export - Stok Barang, ICCID tab
  static async cards(req: Request, res: Response, next: NextFunction) {
    try {
      const where = buildCardWhere(req.query, req.user!.circleCode);
      assertExportSize(await prisma.card.count({ where }));

      const pages = keysetPages(
        ({ where, take }) =>
          prisma.card.findMany({
            where,
            take,
            orderBy: { id: 'desc' },
            select: {
              id: true, key: true, batchCode: true, checkpointCode: true, status: true, remark: true,
              createdAt: true, validatedAt: true, checkpoint: { select: { name: true } }
            }
          }),
        where
      );

      await streamXlsx(res, `Stok ICCID ${today()}`, [{
        name: 'ICCID',
        columns: [
          NO,
          { header: 'Nomor ICCID', key: 'iccid', width: 24 },
          { header: 'Batch Upload', key: 'batch', width: 16 },
          { header: 'Kode Tempat', key: 'placeCode', width: 14 },
          { header: 'Nama Tempat', key: 'placeName', width: 34 },
          { header: 'Tgl Upload', key: 'uploadedAt', width: 16, type: 'date' },
          { header: 'Tgl Verifikasi', key: 'validatedAt', width: 16, type: 'date' },
          { header: 'Status', key: 'status', width: 20 },
          { header: 'Catatan', key: 'remark', width: 30 }
        ],
        rows: numbered(mapChunks(pages, rows => rows.map(c => ({
          iccid: c.key,
          batch: c.batchCode,
          placeCode: c.checkpointCode,
          placeName: c.checkpoint?.name ?? '',
          uploadedAt: wib(c.createdAt),
          validatedAt: wib(c.validatedAt),
          status: label(CARD_STATUS, c.status),
          remark: c.remark ?? ''
        }))))
      }]);
    } catch (error) {
      next(error);
    }
  }

  // GET /api/stock/numbers/export - Stok Barang, MSISDN tab
  static async numbers(req: Request, res: Response, next: NextFunction) {
    try {
      const where = buildNumberWhere(req.query, req.user!.circleCode);
      assertExportSize(await prisma.number.count({ where }));

      const pages = keysetPages(
        ({ where, take }) =>
          prisma.number.findMany({
            where,
            take,
            orderBy: { id: 'desc' },
            select: {
              id: true, key: true, remark: true, checkpointCode: true, status: true, createdAt: true,
              checkpoint: { select: { name: true } }, merge: { select: { soldAt: true } }
            }
          }),
        where
      );

      await streamXlsx(res, `Stok MSISDN ${today()}`, [{
        name: 'MSISDN',
        columns: [
          NO,
          { header: 'Nomor MSISDN', key: 'msisdn', width: 18 },
          { header: 'Tipe', key: 'type', width: 32 },
          { header: 'Kode Tempat', key: 'placeCode', width: 14 },
          { header: 'Nama Tempat', key: 'placeName', width: 34 },
          { header: 'Tgl Upload', key: 'uploadedAt', width: 16, type: 'date' },
          { header: 'Tgl Terjual', key: 'soldAt', width: 16, type: 'date' },
          { header: 'Status', key: 'status', width: 16 }
        ],
        rows: numbered(mapChunks(pages, rows => rows.map(n => ({
          msisdn: n.key,
          type: n.remark ?? '',
          placeCode: n.checkpointCode ?? '',
          placeName: n.checkpoint?.name ?? '',
          uploadedAt: wib(n.createdAt),
          soldAt: wib(n.merge?.soldAt),
          status: label(NUMBER_STATUS, n.status)
        }))))
      }]);
    } catch (error) {
      next(error);
    }
  }

  // GET /api/distribution/export - Jadwal Distribusi
  static async distributions(req: Request, res: Response, next: NextFunction) {
    try {
      const where = buildDistributionWhere(req.query, req.user!.circleCode);
      assertExportSize(await prisma.distribution.count({ where }));

      const pages = keysetPages(
        ({ where, take }) =>
          prisma.distribution.findMany({
            where,
            take,
            orderBy: { id: 'desc' },
            select: {
              id: true, batch: true, amount: true, status: true, scheduledAt: true, completedAt: true,
              sourceCode: true, targetCode: true,
              source: { select: { code: true, name: true } }, target: { select: { code: true, name: true } }
            }
          }),
        where
      );

      await streamXlsx(res, `Jadwal Distribusi ${today()}`, [{
        name: 'Jadwal Distribusi',
        columns: [
          NO,
          { header: 'Nomor Batch Kirim', key: 'batch', width: 22 },
          { header: 'Kode Asal', key: 'sourceCode', width: 12 },
          { header: 'Nama Asal', key: 'sourceName', width: 32 },
          { header: 'Kode Tujuan', key: 'targetCode', width: 12 },
          { header: 'Nama Tujuan', key: 'targetName', width: 32 },
          { header: 'Tgl Kirim', key: 'scheduledAt', width: 16, type: 'date' },
          { header: 'Total Produk', key: 'amount', width: 14 },
          { header: 'Status', key: 'status', width: 14 },
          { header: 'Tgl Selesai', key: 'completedAt', width: 16, type: 'date' }
        ],
        rows: numbered(mapChunks(pages, rows => rows.map(d => ({
          batch: d.batch ?? '',
          sourceCode: d.sourceCode,
          sourceName: d.source?.name ?? '',
          targetCode: d.targetCode,
          targetName: d.target?.name ?? '',
          scheduledAt: wib(d.scheduledAt),
          amount: d.amount,
          status: label(DISTRIBUTION_STATUS, d.status),
          completedAt: wib(d.completedAt)
        }))))
      }]);
    } catch (error) {
      next(error);
    }
  }

  // GET /api/checkpoint/export - Checkpoint
  static async checkpoints(req: Request, res: Response, next: NextFunction) {
    try {
      const where = buildPlaceWhere(req.query, req.user!.circleCode);
      assertExportSize(await prisma.checkpoint.count({ where }));

      // Circles are loaded per page of codes, never as one IN list over every checkpoint
      const circleNames = async (codes: string[]) => {
        const byCode = new Map<string, string[]>();
        for (let i = 0; i < codes.length; i += 500) {
          const links = await prisma.checkpointCircle.findMany({
            where: { checkpointCode: { in: codes.slice(i, i + 500) } },
            select: { checkpointCode: true, circle: { select: { name: true } } }
          });
          for (const link of links) {
            const list = byCode.get(link.checkpointCode) ?? [];
            list.push(link.circle.name);
            byCode.set(link.checkpointCode, list);
          }
        }
        return byCode;
      };

      const pages = keysetPages(
        ({ where, take }) =>
          prisma.checkpoint.findMany({
            where,
            take,
            orderBy: { id: 'desc' },
            select: { id: true, code: true, name: true, type: true, _count: { select: { cards: true } } }
          }),
        where,
        1000
      );

      await streamXlsx(res, `Checkpoint ${today()}`, [{
        name: 'Checkpoint',
        columns: [
          NO,
          { header: 'Kode', key: 'code', width: 14 },
          { header: 'Nama', key: 'name', width: 38 },
          { header: 'Tipe', key: 'type', width: 10 },
          { header: 'Circle', key: 'circles', width: 36 },
          { header: 'Total Kartu', key: 'cards', width: 14 }
        ],
        rows: numbered(mapChunks(pages, async rows => {
          const circles = await circleNames(rows.map(r => r.code));
          return rows.map(c => ({
            code: c.code,
            name: c.name,
            type: label(PLACE_TYPE, c.type),
            circles: (circles.get(c.code) ?? []).sort().join(', '),
            cards: c._count.cards
          }));
        }))
      }]);
    } catch (error) {
      next(error);
    }
  }

  // GET /api/stock/sales-by-checkpoint/export - Penjualan > Riwayat (+ detail=true: one row per sale)
  static async sales(req: Request, res: Response, next: NextFunction) {
    try {
      const circleCode = req.user!.circleCode;
      const withDetail = req.query.detail === 'true';

      const ranked = await rankSalesByPlace(req.query, circleCode);
      assertExportSize(ranked.length);

      const detailWhere = withDetail
        ? { ...(buildSoldRange(req.query) ? { createdAt: buildSoldRange(req.query) } : {}), checkpoint: buildPlaceWhere(req.query, circleCode) }
        : null;
      if (detailWhere) assertExportSize(await prisma.merge.count({ where: detailWhere }));

      async function* summaryRows(): AsyncGenerator<Record<string, unknown>[]> {
        yield ranked.map((r, i) => ({
          rank: i + 1, code: r.code, name: r.name, type: label(PLACE_TYPE, r.type), sold: r.sold
        }));
      }

      const sheets: ExportSheet[] = [{
        name: 'Ringkasan',
        columns: [
          { header: 'Peringkat', key: 'rank', width: 11 },
          { header: 'Kode', key: 'code', width: 14 },
          { header: 'Nama', key: 'name', width: 38 },
          { header: 'Tipe', key: 'type', width: 10 },
          { header: 'Terjual', key: 'sold', width: 12 }
        ] as ExportColumn[],
        rows: summaryRows()
      }];

      if (detailWhere) {
        const pages = keysetPages(
          ({ where, take }) =>
            prisma.merge.findMany({
              where,
              take,
              orderBy: { id: 'desc' },
              select: {
                id: true, soldAt: true, createdAt: true, checkpointCode: true, numberKey: true, cardKey: true,
                remark: true, verifiedAt: true, checkpoint: { select: { name: true } },
                number: { select: { remark: true } }
              }
            }),
          detailWhere
        );
        sheets.push({
          name: 'Rincian',
          columns: [
            NO,
            { header: 'Tgl Terjual', key: 'soldAt', width: 16, type: 'date' },
            { header: 'Kode Toko', key: 'placeCode', width: 14 },
            { header: 'Nama Toko', key: 'placeName', width: 34 },
            { header: 'Nomor MSISDN', key: 'msisdn', width: 18 },
            { header: 'Nomor ICCID', key: 'iccid', width: 24 },
            { header: 'Kategori', key: 'category', width: 30 },
            { header: 'Catatan', key: 'remark', width: 34 },
            { header: 'Status', key: 'status', width: 20 }
          ] as ExportColumn[],
          rows: numbered(mapChunks(pages, rows => rows.map(m => ({
            soldAt: wib(m.soldAt ?? m.createdAt),
            placeCode: m.checkpointCode ?? '',
            placeName: m.checkpoint?.name ?? '',
            msisdn: m.numberKey,
            iccid: m.cardKey,
            category: m.number?.remark ?? '',
            remark: m.remark ?? '',
            status: m.verifiedAt ? 'TerAktivasi' : 'Menunggu Aktivasi'
          }))))
        });
      }

      await streamXlsx(res, `Penjualan ${today()}`, sheets);
    } catch (error) {
      next(error);
    }
  }
}
