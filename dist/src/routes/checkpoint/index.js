"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const checkpoint_controller_1 = __importDefault(require("../../controllers/checkpoint.controller"));
const router = express_1.default.Router();
// ============================================================================
// CHECKPOINT ROUTES
// ============================================================================
// POST /api/checkpoint - Create a new checkpoint
router.post('/', checkpoint_controller_1.default.createCheckpoint);
// GET /api/checkpoint - Get all checkpoints with pagination and filtering
router.get('/', checkpoint_controller_1.default.getCheckpoints);
// GET /api/checkpoint/:id - Get a specific checkpoint by ID
router.get('/:id', checkpoint_controller_1.default.getCheckpoint);
// PUT /api/checkpoint/:id - Update a specific checkpoint
router.put('/:id', checkpoint_controller_1.default.updateCheckpoint);
// DELETE /api/checkpoint/:id - Delete a specific checkpoint
router.delete('/:id', checkpoint_controller_1.default.deleteCheckpoint);
exports.default = router;
