import type { NextFunction, Request, Response } from "express";
import JWT from "../utils/jwt.util";
import prisma from "../../lib/prisma";

const isProduction = process.env.NODE_ENV === "production";

class Auth {
  static async authenticate(req: Request, res: Response, next: NextFunction) {
    try {
      const token = isProduction
        ? req.signedCookies["access_token"]
        : req.cookies["access_token"];

      if (!token) {
        const err = new Error('Unauthorized');
        (err as any).status = 401;
        throw err;
      }

      let decoded: { code: string; session?: string };
      try {
        decoded = JWT.verify(token) as { code: string; session?: string };
      } catch {
        const err = new Error('Unauthorized');
        (err as any).status = 401;
        throw err;
      }

      // Reject tokens whose session was invalidated by sign-out
      if (decoded.session) {
        const session = await prisma.session.findFirst({ where: { id: decoded.session } });
        if (!session) {
          const err = new Error('Unauthorized');
          (err as any).status = 401;
          throw err;
        }
      }

      const user = await prisma.user.findFirst({
        where: {
          code: decoded.code,
          status: 'ACTIVE'
        }
      });

      if (!user) {
        const err = new Error('Unauthorized');
        (err as any).status = 401;
        throw err;
      }

      req.user = user;
      next();
    } catch (error) {
      next(error);
    }
  }
}

export default Auth;
