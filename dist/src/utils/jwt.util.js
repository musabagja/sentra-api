import jwt, {} from 'jsonwebtoken';
class JWT {
    static sign(payload, signOptions) {
        return jwt.sign(payload, process.env.JWT_SECRET || 'secret', signOptions);
    }
    static verify(token) {
        return jwt.verify(token, process.env.JWT_SECRET || 'secret');
    }
}
export default JWT;
