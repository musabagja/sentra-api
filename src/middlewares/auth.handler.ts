import type { NextFunction, Request, Response } from "express";
import JWT from "../utils/jwt.util";
import prisma from "../../lib/prisma";
import { USER_STATUS } from "../utils/access.util";

const isProduction = process.env.NODE_ENV === "production";

class Auth {
  static async authenticate(req: Request, res: Response, next: NextFunction) {
    try {
      const cookieToken = isProduction
        ? req.signedCookies["access_token"]
        : req.cookies["access_token"];
      const bearerToken = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "")?.[1];
      const token = cookieToken ?? bearerToken;

      if (!token) {
        const err = new Error('Unauthorized');
        (err as any).status = 401;
        throw err;
      }

      let decoded: { code?: unknown; session?: unknown; aud?: unknown };
      try {
        decoded = JWT.verify(token) as { code?: unknown; session?: unknown; aud?: unknown };
      } catch {
        const err = new Error('Unauthorized');
        (err as any).status = 401;
        throw err;
      }

      // Only access tokens from sign-in / refresh are accepted: they always carry both `code` and
      // `session` and no audience. This rejects refresh tokens (no code, which would otherwise make
      // findFirst match an arbitrary user) and PJP tokens (aud "pjp", no session).
      if (typeof decoded.code !== 'string' || typeof decoded.session !== 'string' || decoded.aud !== undefined) {
        const err = new Error('Unauthorized');
        (err as any).status = 401;
        throw err;
      }

      // Reject tokens whose session was invalidated by sign-out
      const session = await prisma.session.findFirst({ where: { id: decoded.session } });
      if (!session) {
        const err = new Error('Unauthorized');
        (err as any).status = 401;
        throw err;
      }

      const user = await prisma.user.findFirst({
        where: { code: decoded.code }
      });

      if (!user) {
        const err = new Error('Unauthorized');
        (err as any).status = 401;
        throw err;
      }

      // A frozen user is signed out on their very next request; the client reads
      // `code` to clear its state and return to the login page
      if (user.status === USER_STATUS.FROZEN) {
        const err = new Error('This account is frozen.');
        (err as any).status = 401;
        (err as any).code = 'ACCOUNT_FROZEN';
        throw err;
      }

      if (user.status !== USER_STATUS.ACTIVE) {
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
