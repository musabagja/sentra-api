"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const prisma_1 = __importDefault(require("../../lib/prisma"));
class CheckpointAccess {
    /**
     * Loads the checkpoint codes the authenticated user is allowed to access
     * (derived from their circle's CheckpointCircle assignments) and attaches
     * them to req.checkpointCodes. Must run after Auth.authenticate.
     */
    static async load(req, res, next) {
        try {
            const checkpointCircles = await prisma_1.default.checkpointCircle.findMany({
                where: { circleCode: req.user.circleCode },
                select: { checkpointCode: true }
            });
            req.checkpointCodes = checkpointCircles.map(cc => cc.checkpointCode);
            next();
        }
        catch (error) {
            next(error);
        }
    }
}
exports.default = CheckpointAccess;
