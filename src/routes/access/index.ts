import express from 'express';
import AccessController from '../../controllers/access.controller';
import Permissions from '../../middlewares/permission.handler';
import { CHECKPOINT_MANAGE_ACCESS } from '../../utils/access.util';

const router = express.Router();

// ============================================================================
// ACCESS ROUTES (granting accesses to users in the caller's circle)
// ============================================================================

router.use(Permissions.require(CHECKPOINT_MANAGE_ACCESS));

// GET /api/access - Get all access rows
router.get('/', AccessController.getAccesses);

// GET /api/access/users - Get users in the caller's circle with their accesses
router.get('/users', AccessController.getUsers);

// PUT /api/access/users/:userCode - Replace a user's accesses
router.put('/users/:userCode', AccessController.updateUserAccesses);

export default router;
