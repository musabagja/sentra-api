import express from 'express';

import userRouter from './user';
import stockRouter from './stock';
import opnameRouter from './opname';
import distributionRouter from './distribution';
import checkpointRouter from './checkpoint';
import circleRouter from './circle';
import accessRouter from './access';
import usersRouter from './users';
import errorHandler from '../middlewares/error.handler';
import Auth from '../middlewares/auth.handler';
import CheckpointAccess from '../middlewares/checkpoint-access.handler';

const router = express.Router();

// ============================================================================
// API ROUTES
// ============================================================================

// User authentication routes (no auth required)
router.use('/user', userRouter);

// Health check — must be before auth middleware
router.get("/", (req: any, res: any) => {
  return res.status(200).send({
    message: "Sentra API is running!!",
    version: "1.0.0",
    endpoints: {
      user: "/api/user",
      stock: "/api/stock",
      opname: "/api/opname",
      distribution: "/api/distribution",
      checkpoint: "/api/checkpoint",
      circle: "/api/circle",
      access: "/api/access",
      users: "/api/users"
    }
  });
});

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

// Circle routes
router.use('/circle', circleRouter);

// Access granting routes
router.use('/access', accessRouter);

// User management routes (User menu)
router.use('/users', usersRouter);

export default router;
