"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const distribution_controller_1 = __importDefault(require("../../controllers/distribution.controller"));
const multer_config_1 = __importStar(require("../../utils/multer.config"));
const router = express_1.default.Router();
// ============================================================================
// DISTRIBUTION ROUTES
// ============================================================================
// POST /api/distribution - Create a new distribution
router.post('/', distribution_controller_1.default.createDistribution);
// GET /api/distribution - Get all distributions with pagination and filtering
router.get('/', distribution_controller_1.default.getDistributions);
// GET /api/distribution/:id - Get a specific distribution by ID
router.get('/:id', distribution_controller_1.default.getDistribution);
// PUT /api/distribution/:id - Update a specific distribution
router.put('/:id', distribution_controller_1.default.updateDistribution);
router.put('/cancel/:id', distribution_controller_1.default.cancelDistribution);
router.put('/submit/:id', (0, multer_config_1.default)('image').fields([
    { name: 'signFile', maxCount: 1 },
    { name: 'imageFile', maxCount: 1 },
    { name: 'storeFile', maxCount: 1 },
    { name: 'recipientFile', maxCount: 1 }
]), multer_config_1.generateImageURLs, distribution_controller_1.default.submitDistribution);
// DELETE /api/distribution/:id - Delete a specific distribution
router.delete('/:id', distribution_controller_1.default.deleteDistribution);
exports.default = router;
