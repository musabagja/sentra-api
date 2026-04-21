import type { Request, Response, NextFunction } from 'express';

const errorHandler = (error: Error, req: Request, res: Response, next: NextFunction) => {
  console.log(error)
  res.status(500).json({
    message: 'Internal server error',
    error: error.message
  });
};

export default errorHandler;