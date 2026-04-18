import express from 'express';
import CheckpointController from '../../controllers/checkpoint.controller';

const router = express.Router();

// ============================================================================
// CHECKPOINT ROUTES
// ============================================================================

// POST /api/checkpoint - Create a new checkpoint
router.post('/', CheckpointController.createCheckpoint);

// GET /api/checkpoint - Get all checkpoints with pagination and filtering
router.get('/', CheckpointController.getCheckpoints);

// GET /api/checkpoint/:id - Get a specific checkpoint by ID
router.get('/:id', CheckpointController.getCheckpoint);

// PUT /api/checkpoint/:id - Update a specific checkpoint
router.put('/:id', CheckpointController.updateCheckpoint);

// DELETE /api/checkpoint/:id - Delete a specific checkpoint
router.delete('/:id', CheckpointController.deleteCheckpoint);

export default router;
