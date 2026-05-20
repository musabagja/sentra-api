"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const user_controller_1 = __importDefault(require("../../controllers/user.controller"));
const router = express_1.default.Router();
// ============================================================================
// AUTHENTICATION ROUTES
// ============================================================================
// POST /api/user/auth/sign-in - User sign-in
router.post('/auth/sign-in', user_controller_1.default.signIn);
// POST /api/user/auth/refresh-token - Refresh access token
router.post('/auth/refresh-token', user_controller_1.default.refreshToken);
// POST /api/user/auth/sign-out - User sign-out
router.post('/auth/sign-out', user_controller_1.default.signOut);
// GET /api/user - Health check for user routes
router.get('/', (req, res) => {
    res.status(200).json({
        message: "User routes are working"
    });
});
exports.default = router;
