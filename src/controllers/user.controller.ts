import type { Request, Response, NextFunction } from 'express';
import prisma from '../../lib/prisma';
import Bcrypt from '../utils/bcrypt.util';
import JWT from '../utils/jwt.util';

const isProduction = process.env.NODE_ENV === "production"

class UserController {
  static async signIn(req: Request, res: Response, next: NextFunction) {
    try {
      const { code, password } = req.body;

      const user = await prisma.user.findFirst({
        where: {
          code
        },
        include: {
          permissions: {
            include: {
              access: true
            }
          }
        }
      });

      if (!user) {
        throw new Error('This code is not registered to any user.')
      }

      if (!Bcrypt.compare(password, user.password as string)) {
        throw new Error('Invalid password.')
      }

      const [session] = await Promise.all([prisma.session.create({
        data: {
          userCode: user.code,
          expiresAt: new Date(Date.now() + (7 * 24 * 60 * 60 * 1000))
        }
      }), prisma.session.deleteMany({
        where: {
          userCode: user.code
        }
      })]);

      const refreshToken = JWT.sign({
        session: session.id
      }, {
        expiresIn: '7d'
      })

      const accessToken = JWT.sign({
        id: user.id,
        name: user.name,
        code: user.code
      }, {
        expiresIn: '15m'
      })

      res.cookie('access_token', accessToken, {
        httpOnly: true,
        secure: isProduction,
        sameSite: isProduction ? 'none' : 'none',
        maxAge: 15 * 60 * 1000,
        signed: isProduction ? true : false
      })

      res.cookie('refresh_token', refreshToken, {
        httpOnly: true,
        secure: isProduction,
        sameSite: isProduction ? 'none' : 'none',
        maxAge: 7 * 24 * 60 * 60 * 1000,
        signed: isProduction ? true : false
      })

      res.status(200).json({
        message: 'Sign-in successful',
        data: {
          userName: user.name,
          userImageURL: user.imageURL,
          userCode: user.code,
          accesses: user.permissions.map(each=> each.access)
        }
      })
    } catch (error) {
      next(error)
    }
  }

  static async refreshToken(req: Request, res: Response, next: NextFunction) { 
    try {
      const refreshToken = isProduction ? req.signedCookies["refresh_token"] : req.cookies["refresh_token"];

      if (!refreshToken) {
        throw new Error('Session expired, please sign in again.')
      }

      const decoded = JWT.verify(refreshToken) as { session: string };

      const session = await prisma.session.findFirst({
        where: {
          id: decoded.session
        }
      })

      if (!session) {
        res.clearCookie('refresh_token');
        throw new Error('Session expired, please sign in again.')
      }

      const user = await prisma.user.findFirst({
        where: {
          code: session.userCode
        }
      });

      if (!user) {
        res.clearCookie('refresh_token');
        throw new Error('Session expired, please sign in again.')
      }

      await prisma.session.delete({
        where: {
          id: session.id
        }
      })

      const newSession = await prisma.session.create({
        data: {
          userCode: session.userCode,
          expiresAt: new Date(Date.now() + (7 * 24 * 60 * 60 * 1000))
        }
      });

      const newRefreshToken = JWT.sign({
        session: newSession.id
      }, {
        expiresIn: '7d'
      })

      const newAccessToken = JWT.sign({
        id: user.id,
        name: user.name,
        code: user.code
      }, {
        expiresIn: '15m'
      })

      res.cookie('refresh_token', newRefreshToken, {
        httpOnly: true,
        secure: isProduction,
        sameSite: isProduction ? 'none' : 'none',
        maxAge: 7 * 24 * 60 * 60 * 1000,
        signed: isProduction ? true : false
      })

      res.cookie('access_token', newAccessToken, {
        httpOnly: true,
        secure: isProduction,
        sameSite: isProduction ? 'none' : 'none',
        maxAge: 15 * 60 * 1000,
        signed: isProduction ? true : false
      })

      res.status(200).json({
        message: 'Refresh token successful'
      })
    } catch (error) {
      next(error)
    }
  }

  static async signOut(req: Request, res: Response, next: NextFunction) {
    try {
      const refreshToken = req.signedCookies.refresh_token;
      
      if (!refreshToken) {
        throw new Error('Session already signed out.')
      }
      const decoded = JWT.verify(refreshToken) as { session: string };
      
      await prisma.session.delete({
        where: {
          id: decoded.session
        }
      })

      res.clearCookie('refresh_token');
      res.clearCookie('access_token');

      res.status(200).json({
        message: 'Sign-out successful'
      })
    } catch (error) {
      next(error)
    }
  }
}

export default UserController