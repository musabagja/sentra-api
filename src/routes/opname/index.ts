import express from 'express';
import OpnameController from '../../controllers/opname.controller';
import upload, { generateImageURLs } from '../../utils/multer.config';

const router = express.Router();

// ============================================================================
// OPNAME ROUTES
// ============================================================================

// POST /api/opname - Create a new opname
router.post('/', OpnameController.createOpname);

// GET /api/opname - Get all opnames with pagination and filtering
router.get('/', OpnameController.getOpnames);

// GET /api/opname/:id - Get a specific opname by ID
router.get('/:id', OpnameController.getOpname);

// PUT /api/opname/:id - Update a specific opname
router.put('/:id', OpnameController.updateOpname);

// PATCH /api/opname/:id - Update a specific opname progress
router.patch('/:id', OpnameController.updateOpnameProgress);

router.patch('/:id/close', upload('image').fields([
  { name: 'signFile', maxCount: 1 },
  { name: 'picSignFile', maxCount: 1 },
  { name: 'documentationFile', maxCount: 2 }
]), generateImageURLs, OpnameController.closeOpname);

// DELETE /api/opname/:id - Delete a specific opname
router.delete('/:id', OpnameController.deleteOpname);

export default router;
