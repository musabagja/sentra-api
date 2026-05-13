import type { Request, Response, NextFunction } from 'express';

const errorHandler = (error: Error & { status?: number }, req: Request, res: Response, next: NextFunction) => {
  const status = error.status || 500;
  res.status(status).json({
    message: error.message || 'Internal server error',
  });
};

export default errorHandler;
