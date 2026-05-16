import type { Request, Response, NextFunction } from 'express';
import prisma from '../../lib/prisma';
import Bcrypt from '../utils/bcrypt.util';
import JWT from '../utils/jwt.util';

const isProduction = process.env.NODE_ENV === "production";

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const cookieOptions = (maxAge: number) => ({
  httpOnly: true,
  secure: isProduction,
  sameSite: (isProduction ? 'none' : 'lax') as 'none' | 'lax',
  maxAge,
  signed: isProduction
});

// clearCookie must match the security options used when the cookie was set,
// otherwise some browsers (especially with SameSite=None + Secure) ignore the clear.
const clearOptions = {
  httpOnly: true,
  secure: isProduction,
  sameSite: (isProduction ? 'none' : 'lax') as 'none' | 'lax'
};

class UserController {
  static async signIn(req: Request, res: Response, next: NextFunction) {
    try {
      const { code, password } = req.body;

      if (!code || !password) {
        const err = new Error('code and password are required');
        (err as any).status = 400;
        throw err;
      }

      const user = await prisma.user.findUnique({
        where: { code },
        include: {
          permissions: {
            include: { access: true }
          }
        }
      });

      if (!user) {
        const err = new Error('This code is not registered to any user.');
        (err as any).status = 401;
        throw err;
      }

      if (user.status !== 'ACTIVE') {
        const err = new Error('This account is inactive.');
        (err as any).status = 401;
        throw err;
      }

      if (!user.password || !Bcrypt.compare(password, user.password)) {
        const err = new Error('Invalid password.');
        (err as any).status = 401;
        throw err;
      }

      // Atomically rotate sessions: delete all existing, create fresh one
      const session = await prisma.$transaction(async (tx) => {
        await tx.session.deleteMany({ where: { userCode: user.code } });
        return tx.session.create({
          data: {
            userCode: user.code,
            expiresAt: new Date(Date.now() + SESSION_TTL_MS)
          }
        });
      });

      const refreshToken = JWT.sign({ session: session.id }, { expiresIn: '7d' });
      const accessToken = JWT.sign(
        { id: user.id, name: user.name, code: user.code },
        { expiresIn: '15m' }
      );

      res.cookie('access_token', accessToken, cookieOptions(15 * 60 * 1000));
      res.cookie('refresh_token', refreshToken, cookieOptions(SESSION_TTL_MS));

      res.status(200).json({
        message: 'Sign-in successful',
        data: {
          userName: user.name,
          userImageURL: user.imageURL,
          userCode: user.code,
          accesses: user.permissions.map(each => each.access)
        }
      });
    } catch (error) {
      next(error);
    }
  }

  static async refreshToken(req: Request, res: Response, next: NextFunction) {
    try {
      const refreshToken = isProduction
        ? req.signedCookies["refresh_token"]
        : req.cookies["refresh_token"];

      if (!refreshToken) {
        const err = new Error('Session expired, please sign in again.');
        (err as any).status = 401;
        throw err;
      }

      let decoded: { session: string };
      try {
        decoded = JWT.verify(refreshToken) as { session: string };
      } catch {
        res.clearCookie('refresh_token', clearOptions);
        res.clearCookie('access_token', clearOptions);
        const err = new Error('Session expired, please sign in again.');
        (err as any).status = 401;
        throw err;
      }

      const session = await prisma.session.findFirst({
        where: { id: decoded.session }
      });

      if (!session) {
        res.clearCookie('refresh_token', clearOptions);
        res.clearCookie('access_token', clearOptions);
        const err = new Error('Session expired, please sign in again.');
        (err as any).status = 401;
        throw err;
      }

      if (session.expiresAt < new Date()) {
        await prisma.session.delete({ where: { id: session.id } });
        res.clearCookie('refresh_token', clearOptions);
        res.clearCookie('access_token', clearOptions);
        const err = new Error('Session expired, please sign in again.');
        (err as any).status = 401;
        throw err;
      }

      const user = await prisma.user.findUnique({
        where: { code: session.userCode }
      });

      if (!user || user.status !== 'ACTIVE') {
        res.clearCookie('refresh_token', clearOptions);
        res.clearCookie('access_token', clearOptions);
        const err = new Error('Session expired, please sign in again.');
        (err as any).status = 401;
        throw err;
      }

      // Atomically rotate the session
      const newSession = await prisma.$transaction(async (tx) => {
        await tx.session.delete({ where: { id: session.id } });
        return tx.session.create({
          data: {
            userCode: session.userCode,
            expiresAt: new Date(Date.now() + SESSION_TTL_MS)
          }
        });
      });

      const newRefreshToken = JWT.sign({ session: newSession.id }, { expiresIn: '7d' });
      const newAccessToken = JWT.sign(
        { id: user.id, name: user.name, code: user.code },
        { expiresIn: '15m' }
      );

      res.cookie('refresh_token', newRefreshToken, cookieOptions(SESSION_TTL_MS));
      res.cookie('access_token', newAccessToken, cookieOptions(15 * 60 * 1000));

      res.status(200).json({ message: 'Refresh token successful' });
    } catch (error) {
      next(error);
    }
  }

  static async signOut(req: Request, res: Response, next: NextFunction) {
    try {
      const refreshToken = isProduction
        ? req.signedCookies["refresh_token"]
        : req.cookies["refresh_token"];

      if (!refreshToken) {
        const err = new Error('Session already signed out.');
        (err as any).status = 400;
        throw err;
      }

      // Best-effort session deletion: clear cookies regardless of token/session state
      try {
        const decoded = JWT.verify(refreshToken) as { session: string };
        // deleteMany avoids a P2025 crash if the session was already deleted
        // (e.g. signed out on another device)
        await prisma.session.deleteMany({ where: { id: decoded.session } });
      } catch {
        // Token is expired or tampered — nothing to delete, proceed to clear cookies
      }

      res.clearCookie('refresh_token', clearOptions);
      res.clearCookie('access_token', clearOptions);

      res.status(200).json({ message: 'Sign-out successful' });
    } catch (error) {
      next(error);
    }
  }
}

export default UserController;
