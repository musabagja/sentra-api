import type { NextFunction, Request, Response } from "express";
import prisma from "../../lib/prisma";

class Permissions {
  /**
   * Allows the request through only when the authenticated user holds an
   * active Permission for the given Access code. Must run after Auth.authenticate.
   */
  static require(accessCode: string) {
    return async (req: Request, res: Response, next: NextFunction) => {
      try {
        const permission = await prisma.permission.findFirst({
          where: { userCode: req.user!.code, accessCode, status: true }
        });

        if (!permission) {
          const err = new Error('Forbidden');
          (err as any).status = 403;
          throw err;
        }

        next();
      } catch (error) {
        next(error);
      }
    };
  }
}

export default Permissions;
