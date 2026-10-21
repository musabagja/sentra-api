import type { Request, Response, NextFunction } from 'express';
import prisma from '../../lib/prisma';
import { Prisma } from '../../generated/prisma/client';
import { wibStartOfDay, wibEndOfDay } from '../utils/wib.util';
import {
  INVENTORY_TYPES,
  RECIPIENT_TYPES,
  httpError,
  stockStatus,
  signedQty,
  fromToLabel,
  parseWibDateTime,
  parseItemsField,
  cleanQty,
  cleanMinimumStock,
  nextInventoryCode,
  recomputeItemStock
} from '../utils/inventory.util';

/**
 * Inventaris (fitur Visibility): barang non SIM card — daftar barang, catat/lihat/ubah/hapus
 * barang masuk & barang keluar, dan serah terima barang keluar (V02).
 *
 * Stock rules (T-14a1 / T-21b): a barang masuk edit/delete may not push an item's stock below
 * zero or below its minimum stock; a barang keluar may never take more than the available stock.
 * Every mutation replays the item's movements so `stock` and each row's "sisa stok saat itu"
 * stay consistent (see recomputeItemStock).
 */

const MAX_LIMIT = 1000;

const itemSelect = {
  id: true,
  name: true,
  category: true,
  minimumStock: true,
  stock: true,
  updatedAt: true
} satisfies Prisma.InventoryItemSelect;

const transactionSelect = {
  id: true,
  code: true,
  type: true,
  date: true,
  note: true,
  receivedFrom: true,
  recipientType: true,
  recipientName: true,
  proofURL: true,
  handoverPhotoURL: true,
  handoverSignURL: true,
  handoverLat: true,
  handoverLng: true,
  handedOverAt: true,
  createdAt: true,
  user: { select: { code: true, name: true } }
} satisfies Prisma.InventoryTransactionSelect;

const withKeterangan = (item: { stock: number; minimumStock: number }) => ({
  ...item,
  keterangan: stockStatus(item.stock, item.minimumStock)
});

const itemsSummary = (items: { qty: number }[]) => ({
  itemsCount: items.length,
  totalQty: items.reduce((sum, row) => sum + row.qty, 0)
});

const handoverStatus = (handedOverAt: Date | null) => (handedOverAt ? 'DONE' : 'PENDING');

const paging = (page: unknown, limit: unknown) => {
  const p = Math.max(Number(page) || 1, 1);
  const take = Math.min(Math.max(Number(limit) || 10, 1), MAX_LIMIT);
  return { p, take, skip: (p - 1) * take };
};

const dateRange = (startDate: unknown, endDate: unknown) => {
  const range: { gte?: Date; lte?: Date } = {};
  if (startDate) range.gte = wibStartOfDay(String(startDate));
  if (endDate) range.lte = wibEndOfDay(String(endDate));
  return Object.keys(range).length ? range : undefined;
};

/** One form line of "Barang yang masuk": an existing item (itemID) or a new one (name) */
const cleanInLine = (raw: any) => {
  const qty = cleanQty(raw?.qty);
  const itemID = raw?.itemID !== undefined && raw?.itemID !== null ? Number(raw.itemID) : null;
  const name = typeof raw?.name === 'string' ? raw.name.trim().replace(/\s+/g, ' ') : '';
  if (itemID) {
    if (!Number.isInteger(itemID)) throw httpError(400, 'Barang tidak valid');
    return { itemID, qty };
  }
  if (!name) throw httpError(400, 'Pilih barang dari daftar atau ketik nama barang baru');
  return {
    itemID: null,
    qty,
    name,
    category: typeof raw?.category === 'string' ? raw.category.trim() : null,
    minimumStock: raw?.minimumStock !== undefined ? cleanMinimumStock(raw.minimumStock) : 1
  };
};

/** One form line of "Barang yang keluar": only existing items (T-21) */
const cleanOutLine = (raw: any) => {
  const qty = cleanQty(raw?.qty);
  const itemID = Number(raw?.itemID);
  if (!Number.isInteger(itemID) || itemID < 1) throw httpError(400, 'Pilih barang dari daftar barang');
  return { itemID, qty };
};

/** Rows of the same item in one form are one movement: merge their quantities.
 *  New items have no itemID yet, so they merge by name. */
const mergeLines = <T extends { itemID: number | null; qty: number; name?: string | null }>(lines: T[]): T[] => {
  const merged = new Map<string, T>();
  for (const line of lines) {
    const key = line.itemID ? `id:${line.itemID}` : `name:${(line.name ?? '').toLowerCase()}`;
    const existing = merged.get(key);
    if (existing) existing.qty += line.qty;
    else merged.set(key, { ...line });
  }
  return [...merged.values()];
};

const validateCleanLines = (raw: unknown, clean: (raw: any) => any) =>
  mergeLines(parseItemsField(raw).map(clean));

/**
 * Stock a barang masuk edit/delete would leave behind (T-14a1): a decreased line may not push
 * the item below zero ("stok akan jadi minus") nor below its minimum stock ("di bawah minimum").
 * Lines the operation does not decrease never block (an item already below its minimum must not
 * freeze unrelated edits). `minQty` is the smallest quantity this record may keep so both rules hold.
 */
const blockedInLines = (
  entries: { item: { id: number; name: string; stock: number; minimumStock: number }; qty: number; change: number }[]
) =>
  entries
    .map(({ item, qty, change }) => {
      const newStock = item.stock + change;
      const reason = newStock < 0 ? 'MINUS' : newStock < item.minimumStock ? 'BELOW_MINIMUM' : null;
      return {
        itemID: item.id,
        name: item.name,
        stock: item.stock,
        minimumStock: item.minimumStock,
        change,
        newStock,
        minQty: Math.max(1, qty - item.stock + item.minimumStock),
        reason
      };
    })
    .filter((entry) => entry.change < 0 && entry.reason !== null);

const respondBlocked = (res: Response, message: string, items: unknown[]) =>
  res.status(409).json({ message, data: { items } });

const isMobileUA = (req: Request) => /Android|iPhone|iPad|iPod|Mobile/i.test(req.headers['user-agent'] ?? '');

class InventoryController {
  // ------------------------------------------------------------- Daftar Barang

  static async getItems(req: Request, res: Response, next: NextFunction) {
    try {
      const { search, category } = req.query;
      const { p, take, skip } = paging(req.query.page, req.query.limit);

      const where: Prisma.InventoryItemWhereInput = {};
      if (search) where.name = { contains: String(search) };
      if (category) where.category = String(category);

      const [items, total] = await Promise.all([
        prisma.inventoryItem.findMany({ where, select: itemSelect, skip, take, orderBy: [{ name: 'asc' }, { id: 'asc' }] }),
        prisma.inventoryItem.count({ where })
      ]);

      res.status(200).json({
        message: 'Daftar barang retrieved successfully',
        data: { items: items.map(withKeterangan) },
        pagination: { page: p, limit: take, total, pages: Math.ceil(total / take) }
      });
    } catch (error) {
      next(error);
    }
  }

  /** Detail barang (T-02): stok + minimum stok + riwayat masuk/keluar khusus barang ini */
  static async getItem(req: Request, res: Response, next: NextFunction) {
    try {
      const itemID = Number(req.params.id);
      const [item, movements] = await Promise.all([
        prisma.inventoryItem.findUnique({ where: { id: itemID }, select: itemSelect }),
        prisma.inventoryTransactionItem.findMany({
          where: { itemID },
          select: {
            qty: true,
            stockAfter: true,
            transaction: { select: transactionSelect }
          },
          orderBy: [{ transaction: { date: 'desc' } }, { transaction: { id: 'desc' } }]
        })
      ]);
      if (!item) throw httpError(404, 'Barang tidak ditemukan');

      res.status(200).json({
        message: 'Barang retrieved successfully',
        data: {
          item: withKeterangan(item),
          history: movements.map(({ qty, stockAfter, transaction: t }) => ({
            transactionID: t.id,
            code: t.code,
            date: t.date,
            type: t.type,
            qty: signedQty(t.type, qty),
            fromTo: fromToLabel(t),
            stockAfter,
            handoverStatus: t.type === 'IN' ? null : handoverStatus(t.handedOverAt)
          }))
        }
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Minimum Stock Update Lock: the update is applied with an optimistic guard against the row
   * version read in the same transaction. A barang masuk/keluar transaction that is in flight
   * changes the row first, so the update is rejected ("ditolak") instead of landing mid-transaction;
   * once the transaction has finished the update goes through again.
   */
  static async updateMinimumStock(req: Request, res: Response, next: NextFunction) {
    try {
      const itemID = Number(req.params.id);
      const minimumStock = cleanMinimumStock(req.body.minimumStock);

      const item = await prisma.$transaction(async (tx) => {
        const current = await tx.inventoryItem.findUnique({ where: { id: itemID } });
        if (!current) throw httpError(404, 'Barang tidak ditemukan');

        const applied = await tx.inventoryItem.updateMany({
          where: { id: itemID, updatedAt: current.updatedAt },
          data: { minimumStock }
        });
        if (applied.count === 0) {
          throw httpError(
            409,
            'Minimum stok sedang dikunci karena ada transaksi barang masuk/keluar yang sedang berlangsung. Coba lagi.'
          );
        }
        return tx.inventoryItem.findUniqueOrThrow({ where: { id: itemID }, select: itemSelect });
      });

      res.status(200).json({ message: 'Minimum stok diperbarui', data: { item: withKeterangan(item) } });
    } catch (error) {
      next(error);
    }
  }

  /** Kategori unik untuk filter "Kategori: Semua" (T-01) */
  static async getCategories(req: Request, res: Response, next: NextFunction) {
    try {
      const rows = await prisma.inventoryItem.findMany({
        where: { category: { not: null } },
        distinct: ['category'],
        select: { category: true },
        orderBy: { category: 'asc' }
      });
      res.status(200).json({
        message: 'Kategori retrieved successfully',
        data: { categories: rows.map((row) => row.category).filter((category): category is string => !!category) }
      });
    } catch (error) {
      next(error);
    }
  }

  // ------------------------------------------------------------- Barang Masuk

  /** T-11: catat barang masuk (multi barang, boleh barang baru) */
  static async createGoodsIn(req: Request, res: Response, next: NextFunction) {
    try {
      const { receivedFrom, note, proofURL } = req.body ?? {};
      const date = parseWibDateTime(req.body?.date, 'Tanggal diterima');
      const from = typeof receivedFrom === 'string' ? receivedFrom.trim().replace(/\s+/g, ' ') : '';
      if (!from) throw httpError(400, 'Diterima dari wajib diisi');
      if (!proofURL) throw httpError(400, 'Bukti barang masuk wajib diunggah');

      const lines = validateCleanLines(req.body?.items, cleanInLine);

      const transaction = await prisma.$transaction(async (tx) => {
        const code = await nextInventoryCode(tx, 'IN', date);
        const created = await tx.inventoryTransaction.create({
          data: {
            code,
            type: 'IN',
            date,
            note: typeof note === 'string' && note.trim() ? note.trim() : null,
            receivedFrom: from,
            proofURL,
            userCode: req.user!.code
          }
        });

        const itemIDs = new Set<number>();
        for (const line of lines) {
          const item = line.itemID
            ? await tx.inventoryItem.findUnique({ where: { id: line.itemID } })
            : await findOrCreateItem(tx, line);
          if (!item) throw httpError(400, `Barang tidak ditemukan: ${line.itemID}`);

          await tx.inventoryTransactionItem.create({
            data: { transactionID: created.id, itemID: item.id, qty: line.qty, stockAfter: item.stock }
          });
          itemIDs.add(item.id);
        }
        for (const itemID of itemIDs) await recomputeItemStock(tx, itemID);
        return created.id;
      });

      res.status(201).json({
        message: 'Barang masuk tersimpan',
        data: { transaction: await loadTransaction(transaction) }
      });
    } catch (error) {
      next(error);
    }
  }

  /** T-10: riwayat barang masuk (search ID/pengirim + rentang tanggal) */
  static async getGoodsIn(req: Request, res: Response, next: NextFunction) {
    try {
      const { search, startDate, endDate } = req.query;
      const { p, take, skip } = paging(req.query.page, req.query.limit);

      const where: Prisma.InventoryTransactionWhereInput = { type: 'IN' };
      if (search) {
        where.OR = [{ code: { contains: String(search) } }, { receivedFrom: { contains: String(search) } }];
      }
      const range = dateRange(startDate, endDate);
      if (range) where.date = range;

      const [rows, total] = await Promise.all([
        prisma.inventoryTransaction.findMany({
          where,
          select: { ...transactionSelect, items: { select: { qty: true } } },
          skip,
          take,
          orderBy: [{ date: 'desc' }, { id: 'desc' }]
        }),
        prisma.inventoryTransaction.count({ where })
      ]);

      res.status(200).json({
        message: 'Barang masuk retrieved successfully',
        data: {
          transactions: rows.map(({ items, ...transaction }) => ({ ...transaction, ...itemsSummary(items) }))
        },
        pagination: { page: p, limit: take, total, pages: Math.ceil(total / take) }
      });
    } catch (error) {
      next(error);
    }
  }

  /** T-14: detail barang masuk (identitas + daftar barang + bukti) */
  static async getGoodsInDetail(req: Request, res: Response, next: NextFunction) {
    try {
      const transaction = await requireTransaction(Number(req.params.id), 'IN');
      res.status(200).json({
        message: 'Barang masuk retrieved successfully',
        data: { transaction: await loadTransaction(transaction.id) }
      });
    } catch (error) {
      next(error);
    }
  }

  /** T-14b: ubah barang masuk — header boleh berubah, pada daftar barang hanya jumlah yang bisa diubah */
  static async updateGoodsIn(req: Request, res: Response, next: NextFunction) {
    try {
      const transaction = await requireTransaction(Number(req.params.id), 'IN');
      const { receivedFrom, note, proofURL } = req.body ?? {};
      const date = req.body?.date !== undefined ? parseWibDateTime(req.body.date, 'Tanggal diterima') : transaction.date;

      const lines = validateCleanLines(req.body?.items, cleanInLine);
      const current = new Map(transaction.items.map((row) => [row.itemID, row]));
      if (lines.length !== current.size || lines.some((line) => !current.has(line.itemID))) {
        throw httpError(400, 'Pada ubah barang masuk, hanya jumlah tiap barang yang dapat diubah');
      }

      const entries = [] as { item: any; qty: number; change: number }[];
      for (const line of lines) {
        const row = current.get(line.itemID)!;
        const item = await prisma.inventoryItem.findUnique({ where: { id: line.itemID } });
        if (!item) throw httpError(400, `Barang tidak ditemukan: ${line.itemID}`);
        entries.push({ item, qty: row.qty, change: line.qty - row.qty });
      }
      const blocked = blockedInLines(entries);
      if (blocked.length > 0) {
        return respondBlocked(
          res,
          'Tidak bisa disimpan: perubahan membuat stok akan jadi minus atau di bawah minimum.',
          blocked
        );
      }

      await prisma.$transaction(async (tx) => {
        await tx.inventoryTransaction.update({
          where: { id: transaction.id },
          data: {
            date,
            note: note !== undefined ? (typeof note === 'string' && note.trim() ? note.trim() : null) : transaction.note,
            receivedFrom:
              receivedFrom !== undefined
                ? String(receivedFrom).trim().replace(/\s+/g, ' ') || transaction.receivedFrom
                : transaction.receivedFrom,
            ...(proofURL ? { proofURL } : {})
          }
        });
        for (const line of lines) {
          await tx.inventoryTransactionItem.updateMany({
            where: { transactionID: transaction.id, itemID: line.itemID },
            data: { qty: line.qty }
          });
        }
        for (const itemID of current.keys()) await recomputeItemStock(tx, itemID);
      });

      res.status(200).json({
        message: `Perubahan ${transaction.code} tersimpan`,
        data: { transaction: await loadTransaction(transaction.id) }
      });
    } catch (error) {
      next(error);
    }
  }

  /** T-14a: hapus barang masuk — stok dikurangi kembali, ditolak jika stok jadi minus / di bawah minimum */
  static async deleteGoodsIn(req: Request, res: Response, next: NextFunction) {
    try {
      const transaction = await requireTransaction(Number(req.params.id), 'IN');

      const entries = [] as { item: any; qty: number; change: number }[];
      for (const row of transaction.items) {
        const item = await prisma.inventoryItem.findUnique({ where: { id: row.itemID } });
        if (item) entries.push({ item, qty: row.qty, change: -row.qty });
      }
      const blocked = blockedInLines(entries);
      if (blocked.length > 0) {
        return respondBlocked(
          res,
          'Tidak bisa dihapus: sebagian barang dari catatan ini membuat stok akan jadi minus atau di bawah minimum kalau dihapus.',
          blocked
        );
      }

      await prisma.$transaction(async (tx) => {
        await tx.inventoryTransactionItem.deleteMany({ where: { transactionID: transaction.id } });
        await tx.inventoryTransaction.delete({ where: { id: transaction.id } });
        for (const row of transaction.items) await recomputeItemStock(tx, row.itemID);
      });

      res.status(200).json({
        message: `${transaction.code} dihapus. Stok ${transaction.items.length} barang dikembalikan.`,
        data: { transaction: { id: transaction.id, code: transaction.code } }
      });
    } catch (error) {
      next(error);
    }
  }

  // ------------------------------------------------------------- Barang Keluar

  /** T-21: catat barang keluar — penerima Toko ATAU PIC, stok langsung berkurang, status "Belum serah terima" */
  static async createGoodsOut(req: Request, res: Response, next: NextFunction) {
    try {
      const { note, recipientType, recipientName } = req.body ?? {};
      const date = parseWibDateTime(req.body?.date, 'Tanggal keluar');
      const type = String(recipientType ?? '').toUpperCase();
      if (!RECIPIENT_TYPES.includes(type as any)) throw httpError(400, 'Penerima harus Toko atau PIC');
      const name = typeof recipientName === 'string' ? recipientName.trim().replace(/\s+/g, ' ') : '';
      if (!name) throw httpError(400, type === 'PIC' ? 'Nama PIC penerima wajib diisi' : 'Toko penerima wajib dipilih');

      const lines = validateCleanLines(req.body?.items, cleanOutLine);
      const items = await prisma.inventoryItem.findMany({ where: { id: { in: lines.map((l) => l.itemID) } } });
      const byId = new Map(items.map((item) => [item.id, item]));

      const over = lines
        .map((line) => {
          const item = byId.get(line.itemID);
          if (!item) throw httpError(400, `Barang tidak ditemukan: ${line.itemID}`);
          return { itemID: item.id, name: item.name, stock: item.stock, qty: line.qty, maxQty: item.stock };
        })
        .filter((entry) => entry.qty > entry.stock);
      if (over.length > 0) return respondBlocked(res, 'Ada jumlah yang melebihi stok', over);

      const transaction = await prisma.$transaction(async (tx) => {
        const code = await nextInventoryCode(tx, 'OUT', date);
        const created = await tx.inventoryTransaction.create({
          data: {
            code,
            type: 'OUT',
            date,
            note: typeof note === 'string' && note.trim() ? note.trim() : null,
            recipientType: type,
            recipientName: name,
            userCode: req.user!.code
          }
        });
        for (const line of lines) {
          await tx.inventoryTransactionItem.create({
            data: { transactionID: created.id, itemID: line.itemID, qty: line.qty, stockAfter: 0 }
          });
        }
        for (const line of lines) await recomputeItemStock(tx, line.itemID);
        return created.id;
      });

      res.status(201).json({
        message: 'Barang keluar tersimpan',
        data: { transaction: await loadTransaction(transaction) }
      });
    } catch (error) {
      next(error);
    }
  }

  /** T-20: riwayat barang keluar + jumlah "belum serah terima" untuk badge tab */
  static async getGoodsOut(req: Request, res: Response, next: NextFunction) {
    try {
      const { search, startDate, endDate, handover } = req.query;
      const { p, take, skip } = paging(req.query.page, req.query.limit);

      const where: Prisma.InventoryTransactionWhereInput = { type: 'OUT' };
      if (search) {
        where.OR = [{ code: { contains: String(search) } }, { recipientName: { contains: String(search) } }];
      }
      const range = dateRange(startDate, endDate);
      if (range) where.date = range;
      if (handover === 'pending') where.handedOverAt = null;
      if (handover === 'done') where.handedOverAt = { not: null };

      const [rows, total, pendingHandoverCount] = await Promise.all([
        prisma.inventoryTransaction.findMany({
          where,
          select: { ...transactionSelect, items: { select: { qty: true } } },
          skip,
          take,
          orderBy: [{ date: 'desc' }, { id: 'desc' }]
        }),
        prisma.inventoryTransaction.count({ where }),
        prisma.inventoryTransaction.count({ where: { type: 'OUT', handedOverAt: null } })
      ]);

      res.status(200).json({
        message: 'Barang keluar retrieved successfully',
        data: {
          transactions: rows.map(({ items, ...transaction }) => ({
            ...transaction,
            ...itemsSummary(items),
            handoverStatus: handoverStatus(transaction.handedOverAt)
          })),
          pendingHandoverCount
        },
        pagination: { page: p, limit: take, total, pages: Math.ceil(total / take) }
      });
    } catch (error) {
      next(error);
    }
  }

  /** F01: detail barang keluar (+ bukti serah terima bila sudah) */
  static async getGoodsOutDetail(req: Request, res: Response, next: NextFunction) {
    try {
      const transaction = await requireTransaction(Number(req.params.id), 'OUT');
      res.status(200).json({
        message: 'Barang keluar retrieved successfully',
        data: { transaction: await loadTransaction(transaction.id) }
      });
    } catch (error) {
      next(error);
    }
  }

  /** F01 (T-26): ubah barang keluar — hanya yang BELUM serah terima; barang & jumlah boleh berubah */
  static async updateGoodsOut(req: Request, res: Response, next: NextFunction) {
    try {
      const transaction = await requireTransaction(Number(req.params.id), 'OUT');
      if (transaction.handedOverAt) {
        throw httpError(409, 'Barang keluar sudah diserahterimakan, tidak dapat diubah atau dihapus.');
      }

      const { note, recipientType, recipientName } = req.body ?? {};
      const date = req.body?.date !== undefined ? parseWibDateTime(req.body.date, 'Tanggal keluar') : transaction.date;
      let type = transaction.recipientType;
      let name = transaction.recipientName;
      if (recipientType !== undefined) {
        type = String(recipientType).toUpperCase();
        if (!RECIPIENT_TYPES.includes(type as any)) throw httpError(400, 'Penerima harus Toko atau PIC');
      }
      if (recipientName !== undefined) {
        name = String(recipientName).trim().replace(/\s+/g, ' ');
        if (!name) throw httpError(400, type === 'PIC' ? 'Nama PIC penerima wajib diisi' : 'Toko penerima wajib dipilih');
      }

      const lines = validateCleanLines(req.body?.items, cleanOutLine);
      const previous = new Map(transaction.items.map((row) => [row.itemID, row.qty]));
      const items = await prisma.inventoryItem.findMany({ where: { id: { in: lines.map((l) => l.itemID) } } });
      const byId = new Map(items.map((item) => [item.id, item]));

      // This record's own quantity comes back first: a line may spend stock + what it held
      const over = lines
        .map((line) => {
          const item = byId.get(line.itemID);
          if (!item) throw httpError(400, `Barang tidak ditemukan: ${line.itemID}`);
          const available = item.stock + (previous.get(line.itemID) ?? 0);
          return { itemID: item.id, name: item.name, stock: item.stock, qty: line.qty, maxQty: available };
        })
        .filter((entry) => entry.qty > entry.maxQty);
      if (over.length > 0) return respondBlocked(res, 'Ada jumlah yang melebihi stok', over);

      await prisma.$transaction(async (tx) => {
        await tx.inventoryTransaction.update({
          where: { id: transaction.id },
          data: {
            date,
            note: note !== undefined ? (typeof note === 'string' && note.trim() ? note.trim() : null) : transaction.note,
            recipientType: type,
            recipientName: name
          }
        });
        await tx.inventoryTransactionItem.deleteMany({ where: { transactionID: transaction.id } });
        for (const line of lines) {
          await tx.inventoryTransactionItem.create({
            data: { transactionID: transaction.id, itemID: line.itemID, qty: line.qty, stockAfter: 0 }
          });
        }
        const itemIDs = new Set([...previous.keys(), ...lines.map((l) => l.itemID)]);
        for (const itemID of itemIDs) await recomputeItemStock(tx, itemID);
      });

      res.status(200).json({
        message: `Perubahan ${transaction.code} tersimpan`,
        data: { transaction: await loadTransaction(transaction.id) }
      });
    } catch (error) {
      next(error);
    }
  }

  /** F01 (T-27): hapus barang keluar — hanya yang BELUM serah terima, stok dikembalikan */
  static async deleteGoodsOut(req: Request, res: Response, next: NextFunction) {
    try {
      const transaction = await requireTransaction(Number(req.params.id), 'OUT');
      if (transaction.handedOverAt) {
        throw httpError(409, 'Barang keluar sudah diserahterimakan, tidak dapat diubah atau dihapus.');
      }

      await prisma.$transaction(async (tx) => {
        await tx.inventoryTransactionItem.deleteMany({ where: { transactionID: transaction.id } });
        await tx.inventoryTransaction.delete({ where: { id: transaction.id } });
        for (const row of transaction.items) await recomputeItemStock(tx, row.itemID);
      });

      res.status(200).json({
        message: `${transaction.code} dihapus. Stok ${transaction.items.length} barang dikembalikan.`,
        data: { transaction: { id: transaction.id, code: transaction.code } }
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * F02 (serah terima): foto penerima bersama barang (bertimestamp) + tanda tangan penerima.
   * Hanya pencatat (H-01b) dan hanya dari browser HP; setelah disimpan barang keluar terkunci.
   */
  static async handoverGoodsOut(req: Request, res: Response, next: NextFunction) {
    try {
      const transaction = await requireTransaction(Number(req.params.id), 'OUT');
      if (transaction.handedOverAt) {
        throw httpError(409, 'Barang keluar sudah diserahterimakan, tidak dapat diubah atau dihapus.');
      }
      if (transaction.userCode !== req.user!.code) {
        throw httpError(403, 'Hanya pencatat yang bisa melakukan serah terima.');
      }
      if (!isMobileUA(req)) {
        throw httpError(403, 'Form serah terima hanya bisa diisi dari browser HP. Buka web PRODIS di browser HP.');
      }

      const { photoURL, signURL, latitude, longitude } = req.body ?? {};
      if (!photoURL || !signURL) {
        throw httpError(400, 'Foto penerima bersama barangnya dan tanda tangan penerima wajib diunggah');
      }

      const lat = latitude !== undefined && latitude !== '' ? Number(latitude) : null;
      const lng = longitude !== undefined && longitude !== '' ? Number(longitude) : null;
      if ((lat !== null && !Number.isFinite(lat)) || (lng !== null && !Number.isFinite(lng))) {
        throw httpError(400, 'Lokasi tidak valid');
      }

      await prisma.inventoryTransaction.update({
        where: { id: transaction.id },
        data: {
          handoverPhotoURL: photoURL,
          handoverSignURL: signURL,
          handoverLat: lat,
          handoverLng: lng,
          handedOverAt: new Date()
        }
      });

      res.status(200).json({
        message: `Serah terima ${transaction.code} tersimpan.`,
        data: { transaction: await loadTransaction(transaction.id) }
      });
    } catch (error) {
      next(error);
    }
  }
}

// ---------------------------------------------------------------------- helpers

const findOrCreateItem = async (tx: Prisma.TransactionClient, line: { name: string; category: string | null; minimumStock: number }) => {
  const existing = await tx.inventoryItem.findFirst({ where: { name: line.name } });
  if (existing) return existing;
  return tx.inventoryItem.create({
    data: { name: line.name, category: line.category, minimumStock: line.minimumStock, stock: 0 }
  });
};

const requireTransaction = async (id: number, type: (typeof INVENTORY_TYPES)[number]) => {
  const transaction = await prisma.inventoryTransaction.findUnique({
    where: { id },
    select: { id: true, code: true, type: true, date: true, note: true, receivedFrom: true, recipientType: true, recipientName: true, proofURL: true, handedOverAt: true, userCode: true, items: { select: { itemID: true, qty: true } } }
  });
  if (!transaction || transaction.type !== type) throw httpError(404, 'Catatan tidak ditemukan');
  return transaction;
};

const loadTransaction = async (id: number) => {
  const transaction = await prisma.inventoryTransaction.findUniqueOrThrow({
    where: { id },
    select: { ...transactionSelect, items: { select: { qty: true, stockAfter: true, item: { select: itemSelect } } } }
  });
  return {
    ...transaction,
    ...itemsSummary(transaction.items),
    handoverStatus: transaction.type === 'IN' ? null : handoverStatus(transaction.handedOverAt),
    items: transaction.items.map(({ qty, stockAfter, item }) => ({ ...item, qty, stockAfter }))
  };
};

export default InventoryController;
