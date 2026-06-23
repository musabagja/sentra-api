import type { Request } from 'express';

interface User {
  id: number;
  code: string;
  name: string;
  phone: string | null;
  password: string | null;
  imageURL: string | null;
  status: string;
  circleCode: string;
  createdAt: Date;
  updatedAt: Date;
}

declare global {
  namespace Express {
    interface Request {
      user?: User;
      /** Checkpoint codes the authenticated user may access, loaded by CheckpointAccess.load */
      checkpointCodes?: string[];
    }
  }
}
