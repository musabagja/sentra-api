"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const user_1 = __importDefault(require("./user"));
const stock_1 = __importDefault(require("./stock"));
const opname_1 = __importDefault(require("./opname"));
const distribution_1 = __importDefault(require("./distribution"));
const checkpoint_1 = __importDefault(require("./checkpoint"));
const auth_handler_1 = __importDefault(require("../middlewares/auth.handler"));
const checkpoint_access_handler_1 = __importDefault(require("../middlewares/checkpoint-access.handler"));
const router = express_1.default.Router();
// ============================================================================
// API ROUTES
// ============================================================================
// User authentication routes (no auth required)
router.use('/user', user_1.default);
// Health check — must be before auth middleware
router.get("/", (req, res) => {
    return res.status(200).send({
        message: "Sentra API is running!!",
        version: "1.0.0",
        endpoints: {
            user: "/api/user",
            stock: "/api/stock",
            opname: "/api/opname",
            distribution: "/api/distribution",
            checkpoint: "/api/checkpoint"
        }
    });
});
// All routes below require authentication + checkpoint scope resolution
router.use(auth_handler_1.default.authenticate);
router.use(checkpoint_access_handler_1.default.load);
// Stock management routes (cards and numbers)
router.use('/stock', stock_1.default);
// Opname (stock-taking) routes
router.use('/opname', opname_1.default);
// Distribution routes
router.use('/distribution', distribution_1.default);
// Checkpoint routes
router.use('/checkpoint', checkpoint_1.default);
exports.default = router;
