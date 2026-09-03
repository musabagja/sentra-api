import type { Request, Response, NextFunction } from 'express';

const errorHandler = (
  error: Error & { status?: number; details?: unknown },
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const status = error.status || 500;
  res.status(status).json({
    message: error.message || 'Internal server error',
    // Present only on errors that carry a structured breakdown (e.g. bulk upload validation).
    ...(error.details !== undefined && { details: error.details })
  });
};

export default errorHandler;
