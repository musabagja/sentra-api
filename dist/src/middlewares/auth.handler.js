import JWT from "../utils/jwt.util";
import prisma from "../../lib/prisma";
class Auth {
    static async authenticate(req, res, next) {
        try {
            const token = req.signedCookies["access_token"];
            if (!token) {
                throw new Error('Unauthorized');
            }
            const decoded = JWT.verify(token);
            const user = await prisma.user.findFirst({
                where: {
                    code: decoded.code
                }
            });
            if (!user) {
                throw new Error('Unauthorized');
            }
            req.user = user;
            next();
        }
        catch (error) {
            console.log(error);
            next(error);
        }
    }
}
export default Auth;
