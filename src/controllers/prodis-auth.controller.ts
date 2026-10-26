import type { Request, Response, NextFunction } from 'express';
import JWT from '../utils/jwt.util';
import { prodisOk, resolveEmployee, validationFailed } from '../utils/prodis.util';

class ProdisAuthController {
  static async signIn(req: Request, res: Response, next: NextFunction) {
    try {
      const raw = req.body?.nrk ?? req.body?.code;
      if ((!raw || typeof raw !== 'string') && req.body?.nrk === undefined && req.body?.code === undefined) {
        throw validationFailed([{ field: 'nrk', code: 'REQUIRED', message: 'nrk is required' }]);
      }

      const employee = await resolveEmployee(raw);
      const accessToken = JWT.sign({ code: employee.code, name: employee.name }, { expiresIn: '7d' });

      prodisOk(
        res,
        {
          accessToken,
          tokenType: 'Bearer',
          expiresIn: 7 * 24 * 60 * 60,
          employee: { nrk: employee.code, name: employee.name }
        },
        { message: 'Sign-in successful' }
      );
    } catch (error) {
      next(error);
    }
  }
}

export default ProdisAuthController;
