import type { NextFunction, Request, Response } from "express";
import * as xlsx from 'xlsx';
import { buildDistributionWhere } from '../utils/list-filters.util';
import prisma from "../../lib/prisma";
import { Prisma } from '../../generated/prisma/client';
import { hasCheckpointAccess, resolveCheckpointFilter, checkpointInCircle, circleScope } from "../utils/access.util";
import { chunkArray, fetchChunked, normalizeKeyCell } from '../utils/upload.util';

// A batch of thousands of cards touches many rows: the default 5s transaction limit is not enough.
const TX_OPTIONS = { timeout: Number(process.env.UPLOAD_TX_TIMEOUT_MS) || 120000, maxWait: 10000 };

// Batch codes: DV-<n> for a scanned send, DX-<n> for a send from an Excel file (each with its own sequence)
type BatchPrefix = 'DV' | 'DX';

const MAX_UPLOAD_ROWS = 100000;
const MAX_ROWS_PER_PROBLEM = 1000;

// What can stop an Excel send. Each problem says what it is and how to fix it (shown to the person
// who uploaded the file); the rows are listed under it.
const UPLOAD_PROBLEMS = {
  unreadableIccid: {
    label: 'ICCID disimpan Excel sebagai angka',
    action: 'Ubah format kolom ICCID menjadi Teks, ketik ulang ICCID tersebut, lalu unggah lagi.'
  },
  emptyIccid: {
    label: 'ICCID kosong pada baris yang terisi',
    action: 'Isi ICCID pada baris ini, atau hapus barisnya.'
  },
  targetMissing: {
    label: 'TARGET kosong',
    action: 'Isi kode tujuan (kode checkpoint, contoh DC02) pada baris ini.'
  },
  targetNotFound: {
    label: 'Kode TARGET tidak dikenal',
    action: 'Periksa kode tujuan di menu Checkpoint, lalu perbaiki barisnya.'
  },
  dateMissing: {
    label: 'TANGGAL_KIRIM kosong',
    action: 'Isi tanggal kirim dengan format YYYY-MM-DD, contoh 2026-10-30.'
  },
  dateInvalid: {
    label: 'TANGGAL_KIRIM tidak valid',
    action: 'Gunakan format YYYY-MM-DD (contoh 2026-10-30) atau DD/MM/YYYY.'
  },
  duplicateIccid: {
    label: 'ICCID yang sama muncul lebih dari sekali',
    action: 'Hapus baris duplikat, sisakan satu baris per ICCID.'
  },
  cardNotFound: {
    label: 'ICCID belum terdaftar di sistem',
    action: 'Periksa kembali ICCID (mungkin salah ketik), atau tambahkan stoknya lebih dulu lewat menu Pengadaan.'
  },
  cardOutOfScope: {
    label: 'Kartu berada di lokasi yang tidak dapat Anda akses',
    action: 'Hapus kartu ini dari file. Hanya kartu di lokasi Anda yang dapat dikirim.'
  },
  cardSold: {
    label: 'Kartu sudah terjual',
    action: 'Hapus kartu ini dari file. Kartu yang sudah terjual tidak dapat dikirim.'
  },
  cardBroken: {
    label: 'Kartu berstatus rusak',
    action: 'Hapus kartu ini dari file. Kartu rusak tidak dapat dikirim.'
  },
  cardLost: {
    label: 'Kartu berstatus hilang',
    action: 'Hapus kartu ini dari file. Kartu hilang tidak dapat dikirim.'
  },
  cardUnverified: {
    label: 'Kartu belum diverifikasi',
    action: 'Verifikasi kartu terlebih dahulu lewat menu Pengadaan, lalu unggah lagi.'
  },
  cardInDelivery: {
    label: 'Kartu sudah ada di batch pengiriman lain',
    action: 'Batalkan batch pengiriman sebelumnya, atau hapus kartu ini dari file.'
  },
  cardInOpname: {
    label: 'Kartu sedang dalam stok opname',
    action: 'Tunggu stok opname selesai, atau hapus kartu ini dari file.'
  },
  cardOtherStatus: {
    label: 'Kartu tidak dalam status yang dapat dikirim',
    action: 'Hanya kartu terverifikasi yang dapat dikirim. Hapus kartu ini dari file.'
  },
  cardAtTarget: {
    label: 'Kartu sudah berada di lokasi tujuan',
    action: 'Hapus kartu ini dari file, atau ganti TARGET.'
  },
  groupHeld: {
    label: 'Baris benar, tetapi batchnya belum dibuat',
    action: 'Batch untuk tujuan dan tanggal ini tidak dibuat karena ada baris lain yang bermasalah. Perbaiki baris yang bermasalah, lalu unggah baris ini lagi bersamanya.'
  },
  groupFailed: {
    label: 'Batch gagal dibuat saat diproses',
    action: 'Kartu berubah status saat diproses. Unggah baris ini sekali lagi.'
  }
} as const;

type UploadProblem = keyof typeof UPLOAD_PROBLEMS;
type ProblemRow = { row: number; iccid: string; target: string; date: string; detail?: string };

/**
 * TANGGAL_KIRIM as the person typed it: YYYY-MM-DD, DD/MM/YYYY (day first), or a real Excel date
 * (a serial number). Returns midnight UTC of that day, like the scanned send does for its date.
 */
const parseSendDate = (raw: unknown, shown: string): Date | null => {
  let year: number;
  let month: number;
  let day: number;

  if (typeof raw === 'number' && raw > 20000 && raw < 80000) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(raw) * 86400000);
    year = d.getUTCFullYear();
    month = d.getUTCMonth() + 1;
    day = d.getUTCDate();
  } else {
    const text = (typeof raw === 'string' && raw.trim() ? raw : shown).trim();
    const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(text);
    const local = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(text);
    if (iso) [year, month, day] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
    else if (local) [year, month, day] = [Number(local[3]), Number(local[2]), Number(local[1])];
    else return null;
  }

  const date = new Date(Date.UTC(year, month - 1, day));
  const real = date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  return real && year >= 2000 && year <= 2100 ? date : null;
};

const dayKey = (date: Date) => date.toISOString().slice(0, 10);

const CARD_STATUS_PROBLEM: Record<string, UploadProblem> = {
  SOLD: 'cardSold',
  BROKEN: 'cardBroken',
  LOST: 'cardLost',
  UNVERIFIED: 'cardUnverified',
  DELIVERY: 'cardInDelivery',
  OPNAME: 'cardInOpname'
};

const httpError = (status: number, message: string, details?: unknown) => {
  const err = new Error(message);
  (err as any).status = status;
  if (details !== undefined) (err as any).details = details;
  return err;
};

/** The next batch number: from the highest existing <prefix>-<n>, ignoring any batch that is not one.
 *  Reading only the newest row breaks as soon as it was written by something else (a backfill, say):
 *  parseInt returns NaN and every later distribution inherits it as DV-NaN. */
const nextBatchCode = async (tx: Prisma.TransactionClient, prefix: BatchPrefix) => {
  const batches = await tx.distribution.findMany({
    where: { batch: { startsWith: `${prefix}-` } },
    select: { batch: true }
  });
  const pattern = new RegExp(`^${prefix}-(\\d+)$`);
  const highest = batches.reduce((max, d) => {
    const match = pattern.exec(d.batch ?? '');
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  return `${prefix}-${highest + 1}`;
};

/**
 * Creates the SCHEDULED distributions of one send: the cards (VERIFIED) go to DELIVERY and one
 * Distribution per source checkpoint is made, all under one batch code. The stock only moves
 * later, when the receiver submits (serah terima). Every `in` list is chunked (SQL Server allows
 * about 2,100 parameters per statement), so a send of any size works.
 */
const createScheduledDistributions = async (
  tx: Prisma.TransactionClient,
  options: {
    cards: { key: string; checkpointCode: string }[];
    targetCode: string;
    scheduledAt: Date;
    userCode: string;
    prefix: BatchPrefix;
    withItems: boolean;
  }
) => {
  const { cards, targetCode, scheduledAt, userCode, prefix, withItems } = options;

  let moved = 0;
  for (const keys of chunkArray(cards.map((c) => c.key))) {
    const result = await tx.card.updateMany({
      where: { key: { in: keys }, status: 'VERIFIED' },
      data: { status: 'DELIVERY' }
    });
    moved += result.count;
  }
  // Someone else took a card between the check and now: undo everything (the transaction rolls back)
  if (moved !== cards.length) {
    throw httpError(409, 'Sebagian kartu berubah status saat diproses. Coba kirim lagi.');
  }

  const batch = await nextBatchCode(tx, prefix);

  const bySource = new Map<string, string[]>();
  for (const card of cards) {
    const group = bySource.get(card.checkpointCode);
    if (group) group.push(card.key);
    else bySource.set(card.checkpointCode, [card.key]);
  }

  const distributions = [];
  for (const [sourceCode, keys] of bySource) {
    const distribution = await tx.distribution.create({
      data: {
        sourceCode,
        targetCode,
        batch,
        amount: keys.length,
        status: 'SCHEDULED',
        scheduledAt,
        userCode
      }
    });
    for (const chunk of chunkArray(keys)) {
      await tx.distributionItem.createMany({
        data: chunk.map((itemKey) => ({ distributionID: distribution.id, itemKey }))
      });
    }
    distributions.push(
      withItems
        ? { ...distribution, items: await tx.distributionItem.findMany({ where: { distributionID: distribution.id } }) }
        : distribution
    );
  }

  return { batch, distributions };
};

class DistributionController {
  // ============================================================================
  // DISTRIBUTION CRUD OPERATIONS
  // ============================================================================

  static async createDistribution(req: Request, res: Response, next: NextFunction) {
    try {
      const { targetCode, scheduledAt, cardKeys } = req.body;

      if (!req.user) throw new Error('User not found');
      if (!targetCode) {
        const err = new Error('targetCode is required');
        (err as any).status = 400;
        throw err;
      }
      if (!Array.isArray(cardKeys)) {
        const err = new Error('cardKeys must be an array');
        (err as any).status = 400;
        throw err;
      }
      if (cardKeys.length === 0) {
        const err = new Error('cardKeys array cannot be empty');
        (err as any).status = 400;
        throw err;
      }
      if (!scheduledAt) {
        const err = new Error('scheduledAt is required');
        (err as any).status = 400;
        throw err;
      }
      if (isNaN(new Date(scheduledAt).getTime())) {
        const err = new Error('scheduledAt is not a valid date');
        (err as any).status = 422;
        throw err;
      }

      const circleCode = circleScope(req);

      const [distributions, cards, missingKeys] = await prisma.$transaction<[any[], any[], string[]]>(async (tx) => {

        const user = req.user!;

        const targetCheckpoint = await tx.checkpoint.findUnique({ where: { code: targetCode } });
        if (!targetCheckpoint) {
          const err = new Error('Target checkpoint not found');
          (err as any).status = 404;
          throw err;
        }

        // Only consider cards that are at checkpoints within the user's circle
        const foundCards = await fetchChunked(cardKeys.map(String), (keys) =>
          tx.card.findMany({
            where: {
              key: { in: keys },
              status: "VERIFIED",
              checkpoint: checkpointInCircle(circleCode)
            }
          })
        );

        if (foundCards.length === 0) {
          const err = new Error('No verified cards found for the given keys');
          (err as any).status = 422;
          throw err;
        }

        const foundKeys = new Set(foundCards.map((card) => card.key));
        const missingKeys = cardKeys.filter((key) => !foundKeys.has(key));

        const rejectedKeys = foundCards.filter((card) => card.checkpointCode === targetCode).map((card) => card.key);
        if (rejectedKeys.length > 0) {
          const shown = rejectedKeys.slice(0, 20).join(", ");
          const more = rejectedKeys.length > 20 ? ` and ${rejectedKeys.length - 20} more` : "";
          const err = new Error(`Cards [${shown}]${more} are already at checkpoint ${targetCode}`);
          (err as any).status = 422;
          throw err;
        }

        const { distributions } = await createScheduledDistributions(tx, {
          cards: foundCards,
          targetCode,
          scheduledAt: new Date(scheduledAt),
          userCode: user.code,
          prefix: 'DV',
          withItems: true
        });

        return [distributions, foundCards, missingKeys];
      }, TX_OPTIONS)

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

  /**
   * Kirim via Excel: one file creates several batches. Columns (first sheet): ICCID, TARGET (checkpoint
   * code) and TANGGAL_KIRIM. Rows with the same target and date make one batch (DX-<n>), created like a
   * scanned send (cards in DELIVERY, the receiver still does serah terima), without scanning each card.
   *
   * A batch is only created when every row of its target and date is valid. Rows with a problem (not
   * registered, sold, broken, lost, an unknown target, a bad date, ...) are reported with their row
   * number, and so are the valid rows whose batch was held back because of them, so the person can
   * fix just those rows and upload them again. The batches that are clean are created right away.
   */
  static async uploadDistributionExcel(req: Request, res: Response, next: NextFunction) {
    try {
      const file = (req as any).file;
      if (!req.user) throw httpError(401, 'User tidak ditemukan');
      if (!file) throw httpError(400, 'Belum ada file yang diunggah');

      // Read the file outside the transaction: parsing is CPU work and must not hold a DB connection
      let shown: unknown[][];
      let raw: unknown[][];
      try {
        const workbook = xlsx.read(file.buffer, { type: 'buffer' });
        const sheet = workbook.Sheets[workbook.SheetNames[0] ?? ''];
        if (!sheet) throw new Error('no sheet');
        // header:1 gives plain rows, so a file with only a header is still seen. raw:false keeps a long
        // ICCID as the text Excel displays; raw:true is read too, only to recognise a real Excel date.
        shown = xlsx.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, defval: '' });
        raw = xlsx.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: '' });
      } catch {
        throw httpError(422, 'File tidak dapat dibaca. Pastikan file berformat .xlsx dan gunakan template.');
      }

      const header = (shown[0] ?? []).map((cell) => String(cell ?? '').trim().toUpperCase());
      const col = { iccid: header.indexOf('ICCID'), target: header.indexOf('TARGET'), date: header.indexOf('TANGGAL_KIRIM') };
      const missingColumns = (Object.entries({ ICCID: col.iccid, TARGET: col.target, TANGGAL_KIRIM: col.date }) as [string, number][])
        .filter(([, index]) => index < 0)
        .map(([name]) => name);
      if (missingColumns.length > 0) {
        throw httpError(422, `Kolom ${missingColumns.join(', ')} tidak ditemukan. Unduh template dan pertahankan nama kolomnya.`);
      }

      const dataRows = shown.slice(1);
      if (dataRows.length > MAX_UPLOAD_ROWS) {
        throw httpError(422, `File berisi lebih dari ${MAX_UPLOAD_ROWS.toLocaleString('id-ID')} baris. Bagi menjadi beberapa file.`);
      }

      const problems: Partial<Record<UploadProblem, ProblemRow[]>> = {};
      const add = (code: UploadProblem, line: RowRead, detail?: string) => {
        (problems[code] ??= []).push({
          row: line.row,
          iccid: line.iccid,
          target: line.targetText,
          date: line.dateText,
          ...(detail ? { detail } : {})
        });
      };

      type RowRead = {
        row: number;
        iccid: string;
        targetText: string;
        dateText: string;
        targetCode: string | null; // the checkpoint's own code, when known
        sendDate: Date | null;
        problem: boolean; // this row already has a problem
      };

      // 1. Read the rows. Row numbers are the ones shown in Excel (the header is row 1).
      const lines: RowRead[] = [];
      const firstRowOf = new Map<string, number>();
      dataRows.forEach((cells, i) => {
        const row = i + 2;
        const cell = (index: number) => String(cells[index] ?? '').trim();
        const { key, unreadable } = normalizeKeyCell(cells[col.iccid]);
        const targetText = cell(col.target);
        const dateText = cell(col.date);
        // A completely blank row is ignored
        if (!key && !unreadable && !targetText && !dateText) return;

        const line: RowRead = {
          row,
          iccid: key,
          targetText,
          dateText,
          targetCode: null,
          sendDate: null,
          problem: false
        };
        lines.push(line);

        if (unreadable) {
          line.problem = true;
          add('unreadableIccid', line, 'Excel menyimpan ICCID ini sebagai angka, sehingga digitnya sudah berubah');
        } else if (!key) {
          line.problem = true;
          add('emptyIccid', line, 'ICCID kosong');
        } else {
          const first = firstRowOf.get(key.toUpperCase());
          if (first !== undefined) {
            line.problem = true;
            add('duplicateIccid', line, `ICCID yang sama sudah ada di baris ${first}`);
          } else firstRowOf.set(key.toUpperCase(), row);
        }

        if (!dateText && !(typeof (raw[i + 1] ?? [])[col.date] === 'number')) {
          line.problem = true;
          add('dateMissing', line, 'tanggal kirim kosong');
        } else {
          line.sendDate = parseSendDate((raw[i + 1] ?? [])[col.date], dateText);
          if (!line.sendDate) {
            line.problem = true;
            add('dateInvalid', line, `tanggal "${dateText}" tidak dikenali`);
          }
        }
      });

      if (lines.length === 0) throw httpError(422, 'Tidak ada ICCID di dalam file');

      // 2. The targets: every distinct code once
      const targetTexts = [...new Set(lines.map((l) => l.targetText.toUpperCase()).filter(Boolean))];
      const foundTargets = await fetchChunked(targetTexts, (codes) =>
        prisma.checkpoint.findMany({ where: { code: { in: codes } }, select: { code: true, name: true, type: true } })
      );
      const targetByCode = new Map(foundTargets.map((t) => [t.code.toUpperCase(), t]));
      for (const line of lines) {
        if (!line.targetText) {
          line.problem = true;
          add('targetMissing', line, 'tujuan kosong');
          continue;
        }
        const target = targetByCode.get(line.targetText.toUpperCase());
        if (!target) {
          line.problem = true;
          add('targetNotFound', line, `tujuan ${line.targetText} tidak ditemukan`);
        } else line.targetCode = target.code;
      }

      // 3. The cards: look every ICCID up (chunked)
      const found = await fetchChunked([...firstRowOf.keys()], (keys) =>
        prisma.card.findMany({
          where: { key: { in: keys } },
          select: { key: true, status: true, checkpointCode: true }
        })
      );
      const cardByKey = new Map(found.map((card) => [card.key.toUpperCase(), card]));
      // Compared ignoring letter case, like the database does
      const myCheckpoints = new Set((req.checkpointCodes ?? []).map((code) => code.toUpperCase()));

      type Sendable = { key: string; checkpointCode: string };
      const cardOf = new Map<number, Sendable>(); // row -> card to send
      for (const line of lines) {
        if (line.problem || !line.iccid) continue;
        const card = cardByKey.get(line.iccid.toUpperCase());
        if (!card) {
          line.problem = true;
          add('cardNotFound', line, 'ICCID ini belum terdaftar di sistem');
        } else if (!myCheckpoints.has(card.checkpointCode.toUpperCase())) {
          // Where it is held is not revealed: it is not the caller's to see
          line.problem = true;
          add('cardOutOfScope', line, 'kartu tidak berada di lokasi Anda');
        } else if (card.status !== 'VERIFIED') {
          line.problem = true;
          add(CARD_STATUS_PROBLEM[card.status] ?? 'cardOtherStatus', line, `status kartu ${card.status}`);
        } else if (line.targetCode && card.checkpointCode.toUpperCase() === line.targetCode.toUpperCase()) {
          line.problem = true;
          add('cardAtTarget', line, `kartu sudah berada di ${card.checkpointCode}`);
        } else {
          cardOf.set(line.row, { key: card.key, checkpointCode: card.checkpointCode });
        }
      }

      // 4. Batches: rows with the same target and date. A group with any problem row is held back.
      type Group = { targetCode: string; sendDate: Date; lines: RowRead[] };
      const groups = new Map<string, Group>();
      for (const line of lines) {
        if (!line.targetCode || !line.sendDate) continue; // no group to belong to
        const key = `${line.targetCode.toUpperCase()}|${dayKey(line.sendDate)}`;
        const group = groups.get(key) ?? { targetCode: line.targetCode, sendDate: line.sendDate, lines: [] };
        group.lines.push(line);
        groups.set(key, group);
      }

      const created: {
        batch: string;
        targetCode: string;
        targetName: string;
        scheduledAt: Date;
        total: number;
        distributions: { id: number; sourceCode: string; amount: number }[];
      }[] = [];

      for (const group of groups.values()) {
        const bad = group.lines.some((l) => l.problem);
        if (bad) {
          // The valid rows of a held-back batch are reported too, so nothing is lost on the way
          for (const l of group.lines) if (!l.problem) add('groupHeld', l, `batch ${group.targetCode} • ${dayKey(group.sendDate)} belum dibuat`);
          continue;
        }
        const cards = group.lines.map((l) => cardOf.get(l.row)!).filter(Boolean);
        try {
          const result = await prisma.$transaction(
            (tx) =>
              createScheduledDistributions(tx, {
                cards,
                targetCode: group.targetCode,
                scheduledAt: group.sendDate,
                userCode: req.user!.code,
                prefix: 'DX',
                withItems: false
              }),
            TX_OPTIONS
          );
          created.push({
            batch: result.batch,
            targetCode: group.targetCode,
            targetName: targetByCode.get(group.targetCode.toUpperCase())?.name ?? group.targetCode,
            scheduledAt: group.sendDate,
            total: cards.length,
            distributions: result.distributions.map((d) => ({ id: d.id, sourceCode: d.sourceCode, amount: d.amount }))
          });
        } catch (error) {
          // A card changed under us: nothing of this batch was written; report its rows and go on
          for (const l of group.lines) add('groupFailed', l, `batch ${group.targetCode} • ${dayKey(group.sendDate)} gagal dibuat`);
        }
      }

      // 5. The report: what was sent, what was not and why
      const failed = (Object.keys(problems) as UploadProblem[]).filter((code) => (problems[code]?.length ?? 0) > 0);
      const sentRows = created.reduce((sum, c) => sum + c.total, 0);
      const failedRows = failed.reduce((sum, code) => sum + problems[code]!.length, 0);
      const n = (v: number) => v.toLocaleString('id-ID');

      const failures =
        failed.length === 0
          ? null
          : {
              totalRows: lines.length,
              sentRows,
              failedRows,
              errors: Object.fromEntries(
                failed.map((code) => [
                  code,
                  {
                    label: UPLOAD_PROBLEMS[code].label,
                    action: UPLOAD_PROBLEMS[code].action,
                    count: problems[code]!.length,
                    items: problems[code]!.slice(0, MAX_ROWS_PER_PROBLEM),
                    truncated: Math.max(0, problems[code]!.length - MAX_ROWS_PER_PROBLEM)
                  }
                ])
              )
            };

      if (created.length === 0) {
        throw httpError(
          422,
          `Tidak ada batch yang dibuat. ${n(failedRows)} dari ${n(lines.length)} baris bermasalah atau tertahan. ` +
            'Perbaiki baris-baris tersebut di file Excel, lalu unggah lagi.',
          failures ?? { totalRows: lines.length, sentRows: 0, failedRows: 0, errors: {} }
        );
      }

      res.status(201).json({
        message:
          `${n(created.length)} batch dibuat (${n(sentRows)} ICCID).` +
          (failures ? ` ${n(failedRows)} baris belum dikirim, lihat laporan.` : ''),
        data: { created, failures, totalRows: lines.length, sentRows }
      });
    } catch (error) {
      next(error);
    }
  }

  static async getDistributions(req: Request, res: Response, next: NextFunction) {
    try {
      const { page = 1, limit = 10 } = req.query;
      const circleCode = circleScope(req);

      // Shared with the Excel export so the file always matches the list
      const where: any = buildDistributionWhere(req.query, circleCode);

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
          // A batch can hold thousands of cards: the detail page asks for ?items=false and pages
          // them through GET /:id/items
          ...(req.query.items === 'false'
            ? { _count: { select: { items: true } } }
            : { items: { include: { card: true } } }),
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

  /** The cards of one distribution, paged and searchable by ICCID */
  static async getDistributionItems(req: Request, res: Response, next: NextFunction) {
    try {
      const id = Number(req.params.id);
      const allowed = req.checkpointCodes ?? [];

      const distribution = await prisma.distribution.findUnique({
        where: { id },
        select: { id: true, sourceCode: true, targetCode: true }
      });
      if (
        !distribution ||
        (!hasCheckpointAccess(distribution.sourceCode, allowed) &&
         !hasCheckpointAccess(distribution.targetCode, allowed))
      ) {
        throw httpError(404, 'Distribusi tidak ditemukan');
      }

      const page = Math.max(1, Number(req.query.page) || 1);
      const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 10));
      const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
      const where: Prisma.DistributionItemWhereInput = {
        distributionID: id,
        ...(search ? { itemKey: { contains: search } } : {})
      };

      const [items, total] = await Promise.all([
        prisma.distributionItem.findMany({
          where,
          include: { card: true },
          orderBy: { id: 'asc' },
          skip: (page - 1) * limit,
          take: limit
        }),
        prisma.distributionItem.count({ where })
      ]);

      res.status(200).json({
        message: 'Distribution items retrieved successfully',
        data: { items },
        pagination: { page, limit, total, pages: Math.ceil(total / limit) }
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
        if (!status) {
          const err = new Error('Status is required');
          (err as any).status = 400;
          throw err;
        }

        const allowedStatuses = ["SCHEDULED", "DELIVERY"];
        if (!allowedStatuses.includes(status)) {
          const err = new Error('Invalid status. Use the submit endpoint to mark as delivered, or the cancel endpoint to cancel');
          (err as any).status = 400;
          throw err;
        }

        const distribution = await tx.distribution.findUnique({
          where: { id: Number(id) },
          include: { items: { select: { itemKey: true } } }
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

        if (distribution.status === 'DELIVERED') {
          const err = new Error('Cannot modify a delivered distribution');
          (err as any).status = 400;
          throw err;
        }

        if (distribution.status === 'CANCELLED') {
          const err = new Error('Cannot modify a cancelled distribution');
          (err as any).status = 400;
          throw err;
        }

        if (distribution.items.length === 0) {
          const err = new Error('Distribution has no items');
          (err as any).status = 422;
          throw err;
        }

        const itemKeys = distribution.items.map(item => item.itemKey);

        for (const keys of chunkArray(itemKeys)) {
          await tx.card.updateMany({
            where: {
              key: { in: keys },
              status: { in: ['VERIFIED', 'DELIVERY'] }
            },
            data: { status: "DELIVERY" }
          });
        }

        // No item list in the answer: a batch can hold thousands of cards
        return tx.distribution.update({
          where: { id: Number(id) },
          data: {
            status,
            ...(scheduledAt !== undefined && { scheduledAt: new Date(scheduledAt) })
          }
        });
      }, TX_OPTIONS);

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
          include: { items: { select: { itemKey: true } } }
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
          const err = new Error('Cannot cancel a delivered distribution');
          (err as any).status = 409;
          throw err;
        }

        if (currentDistribution.status === "CANCELLED") {
          const err = new Error('Distribution is already cancelled');
          (err as any).status = 409;
          throw err;
        }
        
        const updatedDistribution = await tx.distribution.update({
          where: { id: Number(id) },
          data: {
            status: "CANCELLED"
          }
        });
        
        for (const keys of chunkArray(currentDistribution.items.map(item => item.itemKey))) {
          await tx.card.updateMany({
            where: { key: { in: keys }, status: 'DELIVERY' },
            data: { status: "VERIFIED" }
          });
        }

        return updatedDistribution;
      }, TX_OPTIONS)

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
          const err = new Error('Distribution is already delivered');
          (err as any).status = 409;
          throw err;
        }

        const itemKeys = distribution.items.map(item => item.itemKey);

        // Validate before writing — if cards are gone the transaction rolls back cleanly
        let holdCount = 0;
        for (const keys of chunkArray(itemKeys)) {
          holdCount += await tx.card.count({
            where: { key: { in: keys }, checkpointCode: distribution.sourceCode, status: 'DELIVERY' }
          });
        }
        const [sourceStock, targetStock] = await Promise.all([
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
          const err = new Error('Some cards are no longer available for distribution');
          (err as any).status = 409;
          throw err;
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

        for (const keys of chunkArray(itemKeys)) {
          await tx.card.updateMany({
            where: { key: { in: keys } },
            data: { checkpointCode: distribution.targetCode, status: "VERIFIED" }
          });
        }
        for (const chunk of chunkArray(distribution.items, 300)) {
          await tx.cardMovement.createMany({
            data: chunk.map(item => ({
              cardID: item.card.id,
              type: "TRANSFER",
              userCode: user.code,
              sourceCode: distribution.sourceCode,
              targetCode: distribution.targetCode
            }))
          });
        }

        await Promise.all([
          tx.cardStock.create({
            data: {
              checkpointCode: distribution.sourceCode,
              amount: Math.max(0, sourceStock.amount - itemKeys.length)
            }
          }),
          tx.cardStock.create({
            data: {
              checkpointCode: distribution.targetCode,
              amount: (targetStock?.amount ?? 0) + itemKeys.length
            }
          })
        ]);

        return submittance
      }, TX_OPTIONS)


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
        include: { items: { select: { itemKey: true } } }
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
        // Restore DELIVERY cards back to VERIFIED
        if (itemKeys.length > 0) {
          for (const keys of chunkArray(itemKeys)) {
            await tx.card.updateMany({
              where: { key: { in: keys }, status: 'DELIVERY' },
              data: { status: 'VERIFIED' }
            });
          }
          await tx.distributionItem.deleteMany({ where: { distributionID: existing.id } });
        }

        // Remove submittance if it exists (CANCELLED distributions shouldn't have one, but guard anyway)
        await tx.distributionSubmittance.deleteMany({ where: { distributionID: existing.id } });

        await tx.distribution.delete({ where: { id: existing.id } });
      }, TX_OPTIONS);

      res.status(200).json({
        message: 'Distribution deleted successfully'
      });
    } catch (error) {
      next(error);
    }
  }
}

export default DistributionController;