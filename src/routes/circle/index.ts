import express from 'express';
import CircleController from '../../controllers/circle.controller';
import Permissions from '../../middlewares/permission.handler';
import { CHECKPOINT_MANAGE_ACCESS } from '../../utils/access.util';

const router = express.Router();

// ============================================================================
// CIRCLE ROUTES
// ============================================================================

// GET /api/circle - Get all active circles (optional search)
router.get('/', CircleController.getCircles);

// POST /api/circle - Create a new circle
router.post('/', Permissions.require(CHECKPOINT_MANAGE_ACCESS), CircleController.createCircle);

export default router;
