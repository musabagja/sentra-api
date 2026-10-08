import express from 'express';
import CheckpointController from '../../controllers/checkpoint.controller';
import ExportController from '../../controllers/export.controller';
import Permissions from '../../middlewares/permission.handler';
import { CHECKPOINT_MANAGE_ACCESS, DOWNLOAD_ACCESS } from '../../utils/access.util';

const router = express.Router();

// ============================================================================
// CHECKPOINT ROUTES
// ============================================================================

// POST /api/checkpoint - Create a new checkpoint linked to the given circles
router.post('/', Permissions.require(CHECKPOINT_MANAGE_ACCESS), CheckpointController.createCheckpoint);

// GET /api/checkpoint/code-check?code=… - Is this code free? (must stay before /:id)
router.get('/code-check', Permissions.require(CHECKPOINT_MANAGE_ACCESS), CheckpointController.checkCode);

// GET /api/checkpoint/code-suggestion?type=… - An unused code for the type (must stay before /:id)
router.get('/code-suggestion', Permissions.require(CHECKPOINT_MANAGE_ACCESS), CheckpointController.suggestCode);

// GET /api/checkpoint/options - light list for filter dropdowns (must stay before /:id)
router.get('/options', CheckpointController.getOptions);

// GET /api/checkpoint/export - Excel of the checkpoints (must stay before /:id)
router.get('/export', Permissions.require(DOWNLOAD_ACCESS.CHECKPOINT), ExportController.checkpoints);

// GET /api/checkpoint - Get all checkpoints with pagination and filtering
router.get('/', CheckpointController.getCheckpoints);

// GET /api/checkpoint/:id - Get a specific checkpoint by ID
router.get('/:id', CheckpointController.getCheckpoint);

// PUT /api/checkpoint/:id - Update a specific checkpoint
router.put('/:id', Permissions.require(CHECKPOINT_MANAGE_ACCESS), CheckpointController.updateCheckpoint);

// DELETE /api/checkpoint/:id - Delete a specific checkpoint
router.delete('/:id', Permissions.require(CHECKPOINT_MANAGE_ACCESS), CheckpointController.deleteCheckpoint);

export default router;
