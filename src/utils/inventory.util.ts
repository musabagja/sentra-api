import type { Prisma } from '../../generated/prisma/client';
import { wibYmd } from './wib.util';

/**
 * Helpers of the Inventaris feature (barang non SIM card): stock classification (T-01),
 * WIB datetime parsing for the "Tanggal diterima / tanggal keluar" fields, race-safe
 * BM-/BK- codes (same application-lock pattern as the distribution batches) and the
 * stock replay that keeps `InventoryItem.stock` and every row's "sisa stok saat itu" honest.
 */

export const INVENTORY_TYPES = ['IN', 'OUT'] as const;
export const RECIPIENT_TYPES = ['STORE', 'PIC'] as const;

export const httpError = (status: number, message: string) => {
  const err = new Error(message);
  (err as any).status = status;
  return err;
};

/**
 * Klasifikasi keterangan barang (T-01):
 * stok = 0 -> "Habis"; 0 < stok <= minimumStock -> "Hampir habis"; stok > minimumStock -> "Aman".
 */
export const stockStatus = (stock: number, minimumStock: number): 'Aman' | 'Hampir habis' | 'Habis' => {
  if (stock <= 0) return 'Habis';
  if (stock <= minimumStock) return 'Hampir habis';
  return 'Aman';
};

/** Jumlah pada riwayat: masuk positif, keluar negatif (T-02) */
export const signedQty = (type: string, qty: number): number => (type === 'IN' ? qty : -qty);

/** "Dari / Untuk" pada riwayat barang (T-02): pengirim, atau "Toko · X" / "PIC · X" */
export const fromToLabel = (t: {
  type: string;
  receivedFrom: string | null;
  recipientType: string | null;
  recipientName: string | null;
}): string | null => {
  if (t.type === 'IN') return t.receivedFrom;
  if (!t.recipientName) return null;
  return `${t.recipientType === 'PIC' ? 'PIC' : 'Toko'} · ${t.recipientName}`;
};

/**
 * Parses the datetime inputs of the Inventaris forms. A bare `YYYY-MM-DDTHH:mm` or
 * `DD-MM-YYYY, HH:mm` is a WIB wall time (the app's business timezone); strings that carry
 * a timezone are taken as they are.
 */
export const parseWibDateTime = (value: unknown, field = 'Tanggal'): Date => {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) throw httpError(400, `${field} wajib diisi`);

  // 2026-10-18T09:20(:ss) — no timezone suffix
  const iso = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(raw);
  if (iso) {
    return wibInstant(Number(iso[1]), Number(iso[2]), Number(iso[3]), Number(iso[4]), Number(iso[5]), Number(iso[6] ?? 0));
  }

  // 18-10-2026, 09:20 (the display format of the screens)
  const dmy = /^(\d{2})-(\d{2})-(\d{4})[,]?\s+(\d{2}):(\d{2})$/.exec(raw);
  if (dmy) {
    return wibInstant(Number(dmy[3]), Number(dmy[2]), Number(dmy[1]), Number(dmy[4]), Number(dmy[5]), 0);
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) throw httpError(400, `${field} tidak valid: ${raw}`);
  return parsed;
};

const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;
const wibInstant = (y: number, m: number, d: number, hh: number, mm: number, ss: number): Date => {
  const date = new Date(Date.UTC(y, m - 1, d, hh, mm, ss));
  return new Date(date.getTime() - WIB_OFFSET_MS);
};

export const cleanQty = (value: unknown, label = 'Jumlah'): number => {
  const qty = Number(value);
  if (!Number.isInteger(qty) || qty < 1) throw httpError(400, `${label} harus bilangan bulat minimal 1`);
  return qty;
};

export const cleanMinimumStock = (value: unknown): number => {
  const minimumStock = Number(value);
  if (!Number.isInteger(minimumStock) || minimumStock < 0) {
    throw httpError(400, 'Minimum stok harus bilangan bulat minimal 0');
  }
  return minimumStock;
};

/**
 * The `items` field of the goods-in / goods-out forms. Multipart forms carry it as a JSON
 * string, JSON bodies as an array.
 */
export const parseItemsField = (value: unknown): any[] => {
  let items = value;
  if (typeof items === 'string') {
    try {
      items = JSON.parse(items);
    } catch {
      throw httpError(400, 'Daftar barang tidak valid');
    }
  }
  if (!Array.isArray(items) || items.length === 0) {
    throw httpError(400, 'Minimal 1 barang harus dicatat');
  }
  return items;
};

/** Barcode-style transaction code: BM-<yyyymmdd>-0001 (masuk) / BK-<yyyymmdd>-0001 (keluar) */
export const codePrefix = (type: string): string => (type === 'IN' ? 'BM' : 'BK');

// How long a save waits for another save that is numbering its code (it holds the lock until it commits)
const CODE_LOCK_TIMEOUT_MS = 60000;

/** The next BM-/BK- code for the transaction date, per type per day. Race-safe: concurrent
 *  saves take turns through a transaction-scoped application lock (same as the distribution batches). */
export const nextInventoryCode = async (tx: Prisma.TransactionClient, type: string, date: Date): Promise<string> => {
  const prefix = codePrefix(type);
  const { year, month, day } = wibYmd(date);
  const dayKey = `${year}${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}`;

  const [lock] = await tx.$queryRawUnsafe<{ result: number }[]>(
    `DECLARE @r int; EXEC @r = sp_getapplock @Resource = N'inventory-${prefix}-${dayKey}', @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = ${CODE_LOCK_TIMEOUT_MS}; SELECT @r AS result;`
  );
  if (!lock || lock.result < 0) {
    throw httpError(409, 'Sistem sedang mencatat transaksi Inventaris lain. Coba simpan lagi sebentar lagi.');
  }

  const head = `${prefix}-${dayKey}-`;
  const transactions = await tx.inventoryTransaction.findMany({
    where: { code: { startsWith: head } },
    select: { code: true }
  });
  const pattern = new RegExp(`^${head}(\\d+)$`);
  const highest = transactions.reduce((max, t) => {
    const match = pattern.exec(t.code);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  return `${head}${String(highest + 1).padStart(4, '0')}`;
};

/**
 * Replays every movement of one item in chronological order: fills each row's
 * "sisa stok saat itu" (stockAfter) and lands the item's stock on the final balance.
 * Called after every create / edit / delete so edited or deleted transactions can never
 * leave stale balances behind.
 */
export const recomputeItemStock = async (tx: Prisma.TransactionClient, itemID: number): Promise<number> => {
  const rows = await tx.inventoryTransactionItem.findMany({
    where: { itemID },
    select: { id: true, qty: true, transaction: { select: { type: true, date: true, id: true } } },
    orderBy: [{ transaction: { date: 'asc' } }, { transaction: { id: 'asc' } }]
  });

  let balance = 0;
  for (const row of rows) {
    balance += row.transaction.type === 'IN' ? row.qty : -row.qty;
    if (row.qty !== undefined) {
      await tx.inventoryTransactionItem.update({ where: { id: row.id }, data: { stockAfter: balance } });
    }
  }
  await tx.inventoryItem.update({ where: { id: itemID }, data: { stock: balance } });
  return balance;
};
