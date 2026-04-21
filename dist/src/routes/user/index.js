import express from 'express';
import UserController from '../../controllers/user.controller';
const router = express.Router();
// ============================================================================
// AUTHENTICATION ROUTES
// ============================================================================
// POST /api/user/auth/sign-in - User sign-in
router.post('/auth/sign-in', UserController.signIn);
// POST /api/user/auth/refresh-token - Refresh access token
router.post('/auth/refresh-token', UserController.refreshToken);
// POST /api/user/auth/sign-out - User sign-out
router.post('/auth/sign-out', UserController.signOut);
// GET /api/user - Health check for user routes
router.get('/', (req, res) => {
    res.status(200).json({
        message: "User routes are working"
    });
});
export default router;
