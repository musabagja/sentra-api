import jwt, { type SignOptions } from 'jsonwebtoken';

const getSecret = (): string => {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET environment variable is not set');
  return secret;
};

class JWT {
  static sign(payload: object, signOptions: SignOptions): string {
    return jwt.sign(payload, getSecret(), signOptions);
  }

  static verify(token: string): any {
    return jwt.verify(token, getSecret());
  }
}

export default JWT
