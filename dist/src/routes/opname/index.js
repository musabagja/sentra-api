"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const opname_controller_1 = __importDefault(require("../../controllers/opname.controller"));
const router = express_1.default.Router();
// ============================================================================
// OPNAME ROUTES
// ============================================================================
// POST /api/opname - Create a new opname
router.post('/', opname_controller_1.default.createOpname);
// GET /api/opname - Get all opnames with pagination and filtering
router.get('/', opname_controller_1.default.getOpnames);
// GET /api/opname/:id - Get a specific opname by ID
router.get('/:id', opname_controller_1.default.getOpname);
// PUT /api/opname/:id - Update a specific opname
router.put('/:id', opname_controller_1.default.updateOpname);
// PATCH /api/opname/:id - Update a specific opname progress
router.patch('/:id', opname_controller_1.default.updateOpnameProgress);
// DELETE /api/opname/:id - Delete a specific opname
router.delete('/:id', opname_controller_1.default.deleteOpname);
exports.default = router;
