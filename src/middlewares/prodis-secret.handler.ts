import type { NextFunction, Request, Response } from "express";

class ProdisSecret {
  static authenticate(req: Request, res: Response, next: NextFunction) {
    const secret = process.env.PJP_API_SECRET_KEY;

    if (!secret) {
      return res.status(503).json({
        status: 503,
        code: "SERVICE_UNAVAILABLE",
        message: "Service temporarily unavailable",
        data: null,
        meta: null,
        errors: null
      });
    }

    const header = req.headers.authorization;
    const provided = Array.isArray(header) ? header[0] : header;

    if (!provided || provided !== secret) {
      return res.status(401).json({
        status: 401,
        code: "UNAUTHORIZED",
        message: "Invalid authorization key",
        data: null,
        meta: null,
        errors: null
      });
    }

    return next();
  }
}

export default ProdisSecret;
