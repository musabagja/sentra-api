import type { NextFunction, Request, Response } from "express";
import JWT from "../utils/jwt.util";
import prisma from "../../lib/prisma";

class Auth {
  static async authenticate(req: Request, res: Response, next: NextFunction) {
    try {
      const token = req.cookies["access_token"];

      if (!token) {
        throw new Error('Unauthorized')
      }

      const decoded = JWT.verify(token) as { code: string };

      const user = await prisma.user.findFirst({
        where: {
          code: decoded.code
        }
      });

      if (!user) {
        throw new Error('Unauthorized')
      }

      req.user = user;
      next();
    } catch (error) {
      console.log(error)
      next(error)
    }
  }
}

export default Auth;