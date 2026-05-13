import express from 'express';

import userRouter from './user';
import stockRouter from './stock';
import opnameRouter from './opname';
import distributionRouter from './distribution';
import checkpointRouter from './checkpoint';
import errorHandler from '../middlewares/error.handler';
import Auth from '../middlewares/auth.handler';
import CheckpointAccess from '../middlewares/checkpoint-access.handler';

const router = express.Router();

// ============================================================================
// API ROUTES
// ============================================================================

// User authentication routes (no auth required)
router.use('/user', userRouter);

// All routes below require authentication + checkpoint scope resolution
router.use(Auth.authenticate);
router.use(CheckpointAccess.load);

// Stock management routes (cards and numbers)
router.use('/stock', stockRouter);

// Opname (stock-taking) routes
router.use('/opname', opnameRouter);

// Distribution routes
router.use('/distribution', distributionRouter);

// Checkpoint routes
router.use('/checkpoint', checkpointRouter);

// ============================================================================
// HEALTH CHECK
// ============================================================================

router.get("/", (req: any, res: any) => {
  return res.status(200).send({
    message: "Sentra API is running!!",
    version: "1.0.0",
    endpoints: {
      user: "/api/user",
      stock: "/api/stock",
      opname: "/api/opname",
      distribution: "/api/distribution",
      checkpoint: "/api/checkpoint"
    }
  });
});

export default router;
