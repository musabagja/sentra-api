"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const jwt_util_1 = __importDefault(require("../utils/jwt.util"));
const prisma_1 = __importDefault(require("../../lib/prisma"));
const isProduction = process.env.NODE_ENV === "production";
class Auth {
    static async authenticate(req, res, next) {
        try {
            const token = isProduction
                ? req.signedCookies["access_token"]
                : req.cookies["access_token"];
            if (!token) {
                const err = new Error('Unauthorized');
                err.status = 401;
                throw err;
            }
            let decoded;
            try {
                decoded = jwt_util_1.default.verify(token);
            }
            catch {
                const err = new Error('Unauthorized');
                err.status = 401;
                throw err;
            }
            // Reject tokens whose session was invalidated by sign-out
            if (decoded.session) {
                const session = await prisma_1.default.session.findFirst({ where: { id: decoded.session } });
                if (!session) {
                    const err = new Error('Unauthorized');
                    err.status = 401;
                    throw err;
                }
            }
            const user = await prisma_1.default.user.findFirst({
                where: {
                    code: decoded.code,
                    status: 'ACTIVE'
                }
            });
            if (!user) {
                const err = new Error('Unauthorized');
                err.status = 401;
                throw err;
            }
            req.user = user;
            next();
        }
        catch (error) {
            next(error);
        }
    }
}
exports.default = Auth;
