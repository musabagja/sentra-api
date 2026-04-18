import type { Request } from 'express';

// User interface matching Prisma User model
interface User {
  id: number;
  code: string;
  name: string;
  phone: string;
  password: string | null;
  imageURL: string | null;
  createdAt: Date;
}

declare global {
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}
