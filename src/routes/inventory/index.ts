import express from 'express';
import InventoryController from '../../controllers/inventory.controller';
import Permissions from '../../middlewares/permission.handler';
import { VISIBILITY_ACCESS } from '../../utils/access.util';
import upload, { generateImageURLs } from '../../utils/multer.config';

const router = express.Router();

// ============================================================================
// INVENTARIS ROUTES (menu Visibility — barang non SIM card)
// ============================================================================

// Semua route butuh akses V01 (V-02b: tanpa akses menu, buka lewat link → 403)
router.use(Permissions.require(VISIBILITY_ACCESS.MENU));

// GET /api/inventory/items - Daftar barang: total stok + keterangan (T-01)
router.get('/items', InventoryController.getItems);

// GET /api/inventory/categories - Kategori untuk filter daftar barang
router.get('/categories', InventoryController.getCategories);

// GET /api/inventory/items/:id - Detail barang + riwayat masuk/keluar (T-02)
router.get('/items/:id', InventoryController.getItem);

// PUT /api/inventory/items/:id/minimum-stock - Ubah minimum stok (T-02, lock saat transaksi)
router.put('/items/:id/minimum-stock', InventoryController.updateMinimumStock);

// POST /api/inventory/goods-in - Catat barang masuk, multi barang + bukti (T-11)
router.post(
  '/goods-in',
  upload('proof').fields([{ name: 'proofFile', maxCount: 1 }]),
  generateImageURLs,
  InventoryController.createGoodsIn
);

// GET /api/inventory/goods-in - Riwayat barang masuk (T-10)
router.get('/goods-in', InventoryController.getGoodsIn);

// GET /api/inventory/goods-in/:id - Detail barang masuk + bukti (T-14)
router.get('/goods-in/:id', InventoryController.getGoodsInDetail);

// PUT /api/inventory/goods-in/:id - Ubah barang masuk: hanya jumlah tiap barang (T-14b)
router.put(
  '/goods-in/:id',
  upload('proof').fields([{ name: 'proofFile', maxCount: 1 }]),
  generateImageURLs,
  InventoryController.updateGoodsIn
);

// DELETE /api/inventory/goods-in/:id - Hapus barang masuk, stok dikembalikan (T-14a)
router.delete('/goods-in/:id', InventoryController.deleteGoodsIn);

// POST /api/inventory/goods-out - Catat barang keluar: penerima Toko/PIC (T-21)
router.post('/goods-out', InventoryController.createGoodsOut);

// GET /api/inventory/goods-out - Riwayat barang keluar + badge belum serah terima (T-20)
router.get('/goods-out', InventoryController.getGoodsOut);

// GET /api/inventory/goods-out/:id - Detail barang keluar (F01)
router.get('/goods-out/:id', InventoryController.getGoodsOutDetail);

// PUT /api/inventory/goods-out/:id - Ubah barang keluar yang belum serah terima (F01/T-26)
router.put('/goods-out/:id', InventoryController.updateGoodsOut);

// DELETE /api/inventory/goods-out/:id - Hapus barang keluar yang belum serah terima (F01/T-27)
router.delete('/goods-out/:id', InventoryController.deleteGoodsOut);

// POST /api/inventory/goods-out/:id/handover - Serah terima: foto + tanda tangan (F02).
// Butuh akses V02 (V-02a: tombol hide tanpa V02) dan hanya dari browser HP.
router.post(
  '/goods-out/:id/handover',
  Permissions.require(VISIBILITY_ACCESS.HANDOVER),
  upload('image').fields([
    { name: 'photoFile', maxCount: 1 },
    { name: 'signFile', maxCount: 1 }
  ]),
  generateImageURLs,
  InventoryController.handoverGoodsOut
);

export default router;
