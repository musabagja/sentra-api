"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const getSecret = () => {
    const secret = process.env.JWT_SECRET;
    if (!secret)
        throw new Error('JWT_SECRET environment variable is not set');
    return secret;
};
class JWT {
    static sign(payload, signOptions) {
        return jsonwebtoken_1.default.sign(payload, getSecret(), signOptions);
    }
    static verify(token) {
        return jsonwebtoken_1.default.verify(token, getSecret());
    }
}
exports.default = JWT;
