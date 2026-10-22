import express from 'express';
import DistributionController from '../../controllers/distribution.controller';
import ExportController from '../../controllers/export.controller';
import Permissions from '../../middlewares/permission.handler';
import { ALL_CIRCLES_ACCESS, DISTRIBUTION_ACCESS, DOWNLOAD_ACCESS, MANUAL_HANDOVER_ACCESS } from '../../utils/access.util';
import upload, { generateImageURLs } from '../../utils/multer.config';
const router = express.Router();

// ============================================================================
// DISTRIBUTION ROUTES
// ============================================================================

// POST /api/distribution - Create a new distribution
router.post('/', DistributionController.createDistribution);

// POST /api/distribution/upload/xlsx - Kirim via Excel: one file (ICCID, TARGET, TANGGAL_KIRIM) makes several batches.
// Needs the access SB04, or the super-admin access SA01.
// POST /api/distribution/upload/xlsx/preview - check the file first: the batches that would be created
// and the rows that would not. Writes nothing. (Must stay before the upload route.)
router.post(
  '/upload/xlsx/preview',
  Permissions.requireAny(DISTRIBUTION_ACCESS.SEND_EXCEL, ALL_CIRCLES_ACCESS),
  upload('xlsx').single('source'),
  DistributionController.previewDistributionExcel
);

router.post(
  '/upload/xlsx',
  Permissions.requireAny(DISTRIBUTION_ACCESS.SEND_EXCEL, ALL_CIRCLES_ACCESS),
  upload('xlsx').single('source'),
  DistributionController.uploadDistributionExcel
);

// GET /api/distribution/export - Excel of the distributions (must stay before /:id)
router.get('/export', Permissions.require(DOWNLOAD_ACCESS.STOCK), ExportController.distributions);

// GET /api/distribution - Get all distributions with pagination and filtering
router.get('/', DistributionController.getDistributions);

// GET /api/distribution/:id/items - The cards of a distribution, paged and searchable
router.get('/:id/items', DistributionController.getDistributionItems);

// GET /api/distribution/:id - Get a specific distribution by ID
router.get('/:id', DistributionController.getDistribution);

// PUT /api/distribution/submit-manual - "Tandai Terkirim": an admin (SA02) records several Terjadwal schedules
// as delivered at once ({ids, handoverAt: 'YYYY-MM-DD', note}). Must stay before /:id.
router.put('/submit-manual', Permissions.require(MANUAL_HANDOVER_ACCESS), DistributionController.submitManualDistributions);

// PUT /api/distribution/:id - Update a specific distribution
router.put('/:id', DistributionController.updateDistribution);

router.put('/cancel/:id', DistributionController.cancelDistribution);

router.put('/submit/:id', upload('image').fields([
  { name: 'signFile', maxCount: 1 },
  { name: 'imageFile', maxCount: 1 },
  { name: 'storeFile', maxCount: 1 },
  { name: 'recipientFile', maxCount: 1 }
]), generateImageURLs, DistributionController.submitDistribution);

// DELETE /api/distribution/:id - Delete a specific distribution
router.delete('/:id', DistributionController.deleteDistribution);

export default router;
