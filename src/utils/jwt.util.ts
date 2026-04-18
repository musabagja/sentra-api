import jwt, { type SignOptions } from 'jsonwebtoken';

class JWT {
  static sign(payload: object, signOptions: SignOptions): string {
    return jwt.sign(payload, process.env.JWT_SECRET || 'secret', signOptions);
  }

  static verify(token: string): any {
    return jwt.verify(token, process.env.JWT_SECRET || 'secret');
  }
}

export default JWT