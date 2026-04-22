import express from 'express';
import DistributionController from '../../controllers/distribution.controller';
import upload, { generateImageURLs } from '../../utils/multer.config';
const router = express.Router();

// ============================================================================
// DISTRIBUTION ROUTES
// ============================================================================

// POST /api/distribution - Create a new distribution
router.post('/', DistributionController.createDistribution);

// GET /api/distribution - Get all distributions with pagination and filtering
router.get('/', DistributionController.getDistributions);

// GET /api/distribution/:id - Get a specific distribution by ID
router.get('/:id', DistributionController.getDistribution);

// PUT /api/distribution/:id - Update a specific distribution
router.put('/:id', DistributionController.updateDistribution);

router.put('/submit/:id', upload('image').fields([
  { name: 'sign', maxCount: 1 },
  { name: 'image', maxCount: 1 },
  { name: 'store', maxCount: 1 },
  { name: 'recipient', maxCount: 1 }
]), generateImageURLs, DistributionController.submitDistribution);

// DELETE /api/distribution/:id - Delete a specific distribution
router.delete('/:id', DistributionController.deleteDistribution);

export default router;
