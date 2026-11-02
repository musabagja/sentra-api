import type { NextFunction, Request, Response } from "express";
import * as xlsx from 'xlsx';
import { buildDistributionWhere } from '../utils/list-filters.util';
import prisma from "../../lib/prisma";
import { Prisma } from '../../generated/prisma/client';
import { hasCheckpointAccess, resolveCheckpointFilter, checkpointInCircle, circleScope } from "../utils/access.util";
import { chunkArray, fetchChunked, normalizeKeyCell } from '../utils/upload.util';
import { wibStartOfDay, wibToday } from '../utils/wib.util';

// A batch of thousands of cards touches many rows: the default 5s transaction limit is not enough.
const TX_OPTIONS = { timeout: Number(process.env.UPLOAD_TX_TIMEOUT_MS) || 120000, maxWait: 10000 };

// Batch codes: DV-<n> for a scanned send, DX-<n> for a send from an Excel file (each with its own sequence)
type BatchPrefix = 'DV' | 'DX';

const MAX_UPLOAD_ROWS = 100000;
// "Tandai Terkirim": schedules per request (a page of the list) and the length of the note
const MAX_MANUAL_HANDOVER = 100;
const MAX_MANUAL_NOTE = 500;
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

// How long a send waits for another send that is numbering its batch (it holds the lock until it commits)
const BATCH_LOCK_TIMEOUT_MS = 60000;

/** The next batch number: from the highest existing <prefix>-<n>, ignoring any batch that is not one.
 *  Reading only the newest row breaks as soon as it was written by something else (a backfill, say):
 *  parseInt returns NaN and every later distribution inherits it as DV-NaN. */
const nextBatchCode = async (tx: Prisma.TransactionClient, prefix: BatchPrefix) => {
  // Two sends at the same moment would read the same highest number and get the same code. A
  // transaction-scoped application lock makes them take turns: the next send waits here until the
  // first one commits, then reads the number it wrote. (A unique index cannot do this job: the
  // backfill batches legitimately repeat one code over many rows of the same source.)
  const [lock] = await tx.$queryRawUnsafe<{ result: number }[]>(
    `DECLARE @r int; EXEC @r = sp_getapplock @Resource = N'distribution-batch-${prefix}', @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = ${BATCH_LOCK_TIMEOUT_MS}; SELECT @r AS result;`
  );
  if (!lock || lock.result < 0) {
    throw httpError(409, 'Sistem sedang membuat batch pengiriman lain. Coba kirim lagi sebentar lagi.');
  }

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

const MAX_SAMPLE_ICCIDS = 50;
// Rows listed in the check table; problems first, so a huge file still shows what must be fixed
const MAX_PREVIEW_ROWS = 5000;

type RowRead = {
  row: number;
  iccid: string;
  targetText: string;
  dateText: string;
  targetCode: string | null; // the checkpoint's own code, when known
  sendDate: Date | null;
  problem: boolean; // this row already has a problem
};

type SendableCard = { key: string; checkpointCode: string };
type SendGroup = { targetCode: string; sendDate: Date; lines: RowRead[] };

/** The report of the rows that were not sent, grouped by problem; null when every row was sent */
const buildFailures = (
  problems: Partial<Record<UploadProblem, ProblemRow[]>>,
  totalRows: number,
  sentRows: number
) => {
  const failed = (Object.keys(problems) as UploadProblem[]).filter((code) => (problems[code]?.length ?? 0) > 0);
  if (failed.length === 0) return null;
  return {
    totalRows,
    sentRows,
    failedRows: failed.reduce((sum, code) => sum + problems[code]!.length, 0),
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
};

/**
 * Reads the uploaded Kirim via Excel file and checks every row, without writing anything: the rows,
 * their targets and dates, the cards, and the batches (rows with the same target and date). Used by the
 * preview and by the upload so the two always agree. Rows of a batch that has a problem row are
 * reported; a batch is made of the valid cards of its target and date.
 */
const analyseExcelSend = async (req: Request) => {
  const file = (req as any).file;
  if (!req.user) throw httpError(401, 'User tidak ditemukan');
  if (!file) throw httpError(400, 'Belum ada file yang diunggah');

  // Read the file outside any transaction: parsing is CPU work and must not hold a DB connection
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

    const line: RowRead = { row, iccid: key, targetText, dateText, targetCode: null, sendDate: null, problem: false };
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

  const cardOf = new Map<number, SendableCard>(); // row -> card to send
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

  // 4. Batches: rows with the same target and date. The cards with a problem are skipped (and
  // reported); the batch is still created with the cards that are fine.
  const byKey = new Map<string, SendGroup>();
  for (const line of lines) {
    if (!line.targetCode || !line.sendDate) continue; // no batch to belong to
    const key = `${line.targetCode.toUpperCase()}|${dayKey(line.sendDate)}`;
    const group = byKey.get(key) ?? { targetCode: line.targetCode, sendDate: line.sendDate, lines: [] };
    group.lines.push(line);
    byKey.set(key, group);
  }
  const groups = [...byKey.values()];

  return { lines, groups, problems, add, targetByCode, cardOf };
};


type DeliverableDistribution = {
  id: number;
  sourceCode: string;
  targetCode: string;
  items: { itemKey: string; card: { id: number } }[];
};

/**
 * Serah terima of one distribution, inside the caller's transaction: the cards (still in DELIVERY at
 * the source) move to the target as VERIFIED, a TRANSFER movement is written for each, both stocks get
 * a new snapshot, and the distribution becomes DELIVERED with its submittance. Shared by the serah
 * terima on site and by "Tandai Terkirim" (admin), so the two can never move stock differently.
 */
const deliverDistribution = async (
  tx: Prisma.TransactionClient,
  distribution: DeliverableDistribution,
  userCode: string,
  submittanceData: Omit<Prisma.DistributionSubmittanceUncheckedCreateInput, 'distributionID' | 'userCode'>,
  completedAt: Date = new Date()
) => {
  const itemKeys = distribution.items.map((item) => item.itemKey);

  // Validate before writing — if cards are gone the transaction rolls back cleanly
  let holdCount = 0;
  for (const keys of chunkArray(itemKeys)) {
    holdCount += await tx.card.count({
      where: { key: { in: keys }, checkpointCode: distribution.sourceCode, status: 'DELIVERY' }
    });
  }
  // Newest snapshot; the id breaks ties when several deliveries in one transaction share a timestamp
  const [sourceStock, targetStock] = await Promise.all([
    tx.cardStock.findFirst({
      where: { checkpointCode: distribution.sourceCode },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]
    }),
    tx.cardStock.findFirst({
      where: { checkpointCode: distribution.targetCode },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]
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
    data: { ...submittanceData, distributionID: distribution.id, userCode }
  });

  await tx.distribution.update({
    where: { id: distribution.id },
    data: { status: 'DELIVERED', completedAt }
  });

  for (const keys of chunkArray(itemKeys)) {
    await tx.card.updateMany({
      where: { key: { in: keys } },
      data: { checkpointCode: distribution.targetCode, status: 'VERIFIED' }
    });
  }
  for (const chunk of chunkArray(distribution.items, 300)) {
    await tx.cardMovement.createMany({
      data: chunk.map((item) => ({
        cardID: item.card.id,
        type: 'TRANSFER',
        userCode,
        sourceCode: distribution.sourceCode,
        targetCode: distribution.targetCode
      }))
    });
  }

  await tx.cardStock.create({
    data: { checkpointCode: distribution.sourceCode, amount: Math.max(0, sourceStock.amount - itemKeys.length) }
  });
  await tx.cardStock.create({
    data: { checkpointCode: distribution.targetCode, amount: (targetStock?.amount ?? 0) + itemKeys.length }
  });

  return submittance;
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
   * Kirim via Excel, step 1 ("Periksa file"): reads and checks the file exactly as the upload does and
   * answers with the batches that would be created and the rows that would not. Writes nothing.
   */
  static async previewDistributionExcel(req: Request, res: Response, next: NextFunction) {
    try {
      const analysis = await analyseExcelSend(req);
      const n = analysis.lines.length;

      const batches = analysis.groups
        .map((group) => {
          const bySource = new Map<string, number>();
          const iccids: string[] = [];
          for (const l of group.lines) {
            const card = l.problem ? undefined : analysis.cardOf.get(l.row);
            if (!card) continue;
            bySource.set(card.checkpointCode, (bySource.get(card.checkpointCode) ?? 0) + 1);
            iccids.push(card.key);
          }
          return {
            key: `${group.targetCode.toUpperCase()}|${dayKey(group.sendDate)}`,
            targetCode: group.targetCode,
            targetName: analysis.targetByCode.get(group.targetCode.toUpperCase())?.name ?? group.targetCode,
            scheduledAt: group.sendDate,
            status: 'ready' as const,
            total: iccids.length,
            problemRows: group.lines.filter((l) => l.problem).length,
            sources: [...bySource].map(([sourceCode, amount]) => ({ sourceCode, amount })),
            sampleIccids: iccids.slice(0, MAX_SAMPLE_ICCIDS),
            moreIccids: Math.max(0, iccids.length - MAX_SAMPLE_ICCIDS)
          };
        })
        // A group with no valid card makes no batch
        .filter((b) => b.total > 0)
        .sort((x, y) => x.targetCode.localeCompare(y.targetCode) || x.scheduledAt.getTime() - y.scheduledAt.getTime());

      const readyRows = batches.filter((b) => b.status === 'ready').reduce((sum, b) => sum + b.total, 0);
      const failures = buildFailures(analysis.problems, n, readyRows);

      // One entry per Excel row for the table: bad rows (with their reason) first, then the ready
      // ones, each in file order
      const reasonOf = new Map<number, { code: UploadProblem; detail?: string }>();
      for (const code of Object.keys(analysis.problems) as UploadProblem[]) {
        for (const item of analysis.problems[code] ?? []) {
          if (!reasonOf.has(item.row)) reasonOf.set(item.row, { code, ...(item.detail ? { detail: item.detail } : {}) });
        }
      }
            const allRows = analysis.lines
        .map((l) => {
          const reason = reasonOf.get(l.row);
          const status = reason ? ('problem' as const) : ('ready' as const);
          return {
            row: l.row,
            iccid: l.iccid,
            target: l.targetText,
            date: l.dateText,
            batch: l.targetCode && l.sendDate ? `${l.targetCode.toUpperCase()}|${dayKey(l.sendDate)}` : null,
            status,
            ...(reason
              ? {
                  problem: {
                    code: reason.code,
                    label: UPLOAD_PROBLEMS[reason.code].label,
                    action: UPLOAD_PROBLEMS[reason.code].action,
                    ...(reason.detail ? { detail: reason.detail } : {})
                  }
                }
              : {})
          };
        })
        .sort((a, b) => Number(a.status === 'ready') - Number(b.status === 'ready') || a.row - b.row);

      res.status(200).json({
        message:
          batches.some((b) => b.status === 'ready')
            ? `${batches.filter((b) => b.status === 'ready').length} batch siap dibuat.`
            : 'Belum ada batch yang bisa dibuat.',
        data: {
          totalRows: n,
          readyRows,
          problemRows: failures?.failedRows ?? 0,
          batches,
          failures,
          rows: allRows.slice(0, MAX_PREVIEW_ROWS),
          rowsTruncated: Math.max(0, allRows.length - MAX_PREVIEW_ROWS)
        }
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Kirim via Excel, step 2 ("Buat batch"): one file creates several batches. Columns (first sheet): ICCID,
   * TARGET (checkpoint code) and TANGGAL_KIRIM. Rows with the same target and date make one batch (DX-<n>),
   * created like a scanned send (cards in DELIVERY, the receiver still does serah terima), without scanning.
   *
   * Rows with a problem (not
   * registered, sold, broken, lost, an unknown target, a bad date, ...) are reported with their row
   * number so the person can fix just those rows and upload them again. The batch is still created
   * with the valid cards of its target and date.
   */
  static async uploadDistributionExcel(req: Request, res: Response, next: NextFunction) {
    try {
      const analysis = await analyseExcelSend(req);
      const { lines, groups, problems, targetByCode, cardOf, add } = analysis;
      const n = (v: number) => v.toLocaleString('id-ID');

      const created: {
        batch: string;
        targetCode: string;
        targetName: string;
        scheduledAt: Date;
        total: number;
        distributions: { id: number; sourceCode: string; amount: number }[];
      }[] = [];

      for (const group of groups) {
        // Cards with a problem are skipped (already reported); the batch is made of the others
        const cards = group.lines.filter((l) => !l.problem).map((l) => cardOf.get(l.row)!).filter(Boolean);
        if (cards.length === 0) continue;
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
          for (const l of group.lines.filter((x) => !x.problem)) add('groupFailed', l, `batch ${group.targetCode} • ${dayKey(group.sendDate)} gagal dibuat`);
        }
      }

      const sentRows = created.reduce((sum, c) => sum + c.total, 0);
      const failures = buildFailures(problems, lines.length, sentRows);

      if (created.length === 0) {
        throw httpError(
          422,
          `Tidak ada batch yang dibuat. ${n(failures?.failedRows ?? 0)} dari ${n(lines.length)} baris bermasalah atau tertahan. ` +
            'Perbaiki baris-baris tersebut di file Excel, lalu unggah lagi.',
          failures ?? { totalRows: lines.length, sentRows: 0, failedRows: 0, errors: {} }
        );
      }

      res.status(201).json({
        message:
          `${n(created.length)} batch dibuat (${n(sentRows)} ICCID).` +
          (failures ? ` ${n(failures.failedRows)} baris belum dikirim, lihat laporan.` : ''),
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
            // "Ditandai Admin" marker of the list (Tandai Terkirim): who, when, which handover day
            submittance: { select: { isManual: true, handoverAt: true, note: true, createdAt: true, user: { select: { name: true } } } },
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
          submittance: { include: { user: { select: { name: true } } } },
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

        const submittance = await deliverDistribution(tx, distribution, user.code, {
          longitude: longitude ? Number(longitude) : null,
          latitude: latitude ? Number(latitude) : null,
          signURL: signURL || null,
          imageURL: imageURL || null,
          storeURL: storeURL || null,
          recipientURL: recipientURL || null,
          note: note || null,
          recipientName: recipientName || null
        });

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

  /**
   * "Tandai Terkirim" (admin, access SA02): records several Terjadwal schedules as delivered at once,
   * for goods that reached the destination without a serah terima in the app. Every schedule goes
   * through the same delivery as a serah terima (cards and stock move to the target); the submittance
   * says it was marked by an admin, on which handover day and why. All or nothing: if one schedule
   * can't be marked, none is. Sending the same request again after it succeeded answers 200, so a
   * "Coba lagi" after a lost answer does not fail.
   */
  static async submitManualDistributions(req: Request, res: Response, next: NextFunction) {
    try {
      const { ids, handoverAt, note } = req.body ?? {};
      const allowed = req.checkpointCodes ?? [];

      const distributionIds: number[] = Array.isArray(ids)
        ? [...new Set(ids.map((id: unknown) => Number(id)))].filter((id) => Number.isInteger(id) && id > 0)
        : [];
      if (distributionIds.length === 0 || distributionIds.length !== (Array.isArray(ids) ? new Set(ids.map(String)).size : 0)) {
        throw httpError(422, 'Pilih jadwal yang akan ditandai terkirim.');
      }
      if (distributionIds.length > MAX_MANUAL_HANDOVER) {
        throw httpError(422, `Maksimal ${MAX_MANUAL_HANDOVER} jadwal sekaligus.`);
      }
      const noteText = typeof note === 'string' ? note.trim() : '';
      if (!noteText) throw httpError(422, 'Catatan wajib diisi.');
      if (noteText.length > MAX_MANUAL_NOTE) throw httpError(422, `Catatan maksimal ${MAX_MANUAL_NOTE} karakter.`);
      if (typeof handoverAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(handoverAt)) {
        throw httpError(422, 'Tanggal serah terima wajib diisi.');
      }
      let handoverDay: Date;
      try {
        handoverDay = wibStartOfDay(handoverAt);
      } catch {
        throw httpError(422, 'Tanggal serah terima tidak valid.');
      }

      const result = await prisma.$transaction(async (tx) => {
        const distributions = await tx.distribution.findMany({
          where: { id: { in: distributionIds } },
          include: { items: { include: { card: { select: { id: true } } } }, submittance: { select: { isManual: true } } }
        });
        const inScope = distributions.filter((d) => hasCheckpointAccess(d.sourceCode, allowed));
        if (inScope.length !== distributionIds.length) {
          throw httpError(404, 'Sebagian jadwal tidak ditemukan. Muat ulang halaman, lalu pilih lagi.');
        }

        // Already done by an earlier attempt of this same request: answer as if it succeeded now
        if (inScope.every((d) => d.status === 'DELIVERED' && d.submittance?.isManual)) {
          return { marked: 0, alreadyDone: true };
        }

        const notScheduled = inScope.filter((d) => d.status !== 'SCHEDULED');
        if (notScheduled.length > 0) {
          throw httpError(
            409,
            `${notScheduled.length} jadwal tidak lagi berstatus Terjadwal (${notScheduled
              .slice(0, 5)
              .map((d) => d.batch ?? `#${d.id}`)
              .join(', ')}${notScheduled.length > 5 ? ', ...' : ''}). Muat ulang halaman, lalu pilih lagi.`
          );
        }

        // The handover can't be before the latest send date of the chosen schedules, nor in the future
        const earliest = inScope.reduce(
          (max, d) => (d.scheduledAt && wibStartOfDay(d.scheduledAt) > max ? wibStartOfDay(d.scheduledAt) : max),
          new Date(0)
        );
        if (handoverDay < earliest) {
          throw httpError(422, 'Tanggal serah terima tidak boleh sebelum tanggal kirim jadwal yang dipilih.');
        }
        if (handoverDay > wibToday()) {
          throw httpError(422, 'Tanggal serah terima tidak boleh melewati hari ini.');
        }

        for (const distribution of inScope) {
          await deliverDistribution(
            tx,
            distribution,
            req.user!.code,
            { isManual: true, handoverAt: handoverDay, note: noteText },
            handoverDay
          );
        }
        return { marked: inScope.length, alreadyDone: false };
      }, TX_OPTIONS);

      res.status(200).json({
        message: result.alreadyDone
          ? 'Jadwal sudah ditandai terkirim.'
          : `${result.marked} jadwal ditandai terkirim.`,
        data: result
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