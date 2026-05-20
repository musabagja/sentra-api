"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const bcrypt_1 = __importDefault(require("bcrypt"));
class Bcrypt {
    static hash = (string) => {
        return bcrypt_1.default.hashSync(string, Number(process.env.BCRYPT_SALT_ROUND) || 10);
    };
    static compare = (string, hash) => {
        return bcrypt_1.default.compareSync(string, hash);
    };
}
exports.default = Bcrypt;
