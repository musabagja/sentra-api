import type { Request, Response, NextFunction } from 'express';

const CLIENT_ERROR_CODES = [
  'ACCOUNT_FROZEN',
  'ACCOUNT_INACTIVE',
  'USER_NOT_FOUND',
  'INVALID_PASSWORD',
  // Changing your own password
  'CURRENT_PASSWORD_REQUIRED',
  'WRONG_CURRENT_PASSWORD',
  'PASSWORD_TOO_SHORT',
  'PASSWORD_TOO_LONG',
  'PASSWORD_UNCHANGED'
];

const errorHandler = (
  error: Error & { status?: number; details?: unknown; code?: unknown },
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const status = error.status || 500;
  res.status(status).json({
    message: error.message || 'Internal server error',
    // Machine-readable reason the client can act on. Whitelisted so driver and
    // system error codes (ECONNRESET, EREQUEST, ...) never leak.
    ...(typeof error.code === 'string' && CLIENT_ERROR_CODES.includes(error.code) && { code: error.code }),
    // Present only on errors that carry a structured breakdown (e.g. bulk upload validation).
    ...(error.details !== undefined && { details: error.details })
  });
};

export default errorHandler;
