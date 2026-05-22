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
const opname_controller_1 = __importDefault(require("../../controllers/opname.controller"));
const multer_config_1 = __importStar(require("../../utils/multer.config"));
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
router.patch('/:id/close', (0, multer_config_1.default)('image').fields([
    { name: 'signFile', maxCount: 1 },
    { name: 'picSignFile', maxCount: 1 },
    { name: 'documentationFile', maxCount: 2 }
]), multer_config_1.generateImageURLs, opname_controller_1.default.closeOpname);
// DELETE /api/opname/:id - Delete a specific opname
router.delete('/:id', opname_controller_1.default.deleteOpname);
exports.default = router;
