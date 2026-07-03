"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const stock_controller_1 = __importDefault(require("../../controllers/stock.controller"));
const multer_config_1 = __importDefault(require("../../utils/multer.config"));
const router = express_1.default.Router();
// ============================================================================
// CARD ROUTES
// ============================================================================
router.get('/batches', stock_controller_1.default.getBatches);
router.get('/batches/:id', stock_controller_1.default.getBatch);
router.put('/batches/close/:id', stock_controller_1.default.completeBatch);
router.delete('/batches/:id', stock_controller_1.default.deleteBatch);
// GET /api/stock/cards - Get all cards with pagination and filtering
router.get('/cards', stock_controller_1.default.getCards);
// GET /api/stock/cards/:id - Get a specific card by ID
router.get('/cards/:key', stock_controller_1.default.getCard);
// DELETE /api/stock/cards/:id - Delete a specific card
router.delete('/cards/:key', stock_controller_1.default.deleteCard);
// POST /api/stock/cards/validate/:key - Validate a card
router.post('/cards/validate/:key', stock_controller_1.default.validateCard);
// ============================================================================
// NUMBER ROUTES
// ============================================================================
// POST /api/stock/numbers - Create a new number
router.post('/numbers', stock_controller_1.default.createNumber);
// GET /api/stock/numbers - Get all numbers with pagination and filtering
router.get('/numbers', stock_controller_1.default.getNumbers);
// GET /api/stock/numbers/:key - Get a specific number by key
router.get('/numbers/:key', stock_controller_1.default.getNumber);
// PUT /api/stock/numbers/:key - Update a specific number
router.put('/numbers/:key', stock_controller_1.default.updateNumber);
// DELETE /api/stock/numbers/:key - Delete a specific number
router.delete('/numbers/:key', stock_controller_1.default.deleteNumber);
// POST /api/upload/xlsx - Upload bunch of cards from Excel file
router.post('/upload/xlsx', (0, multer_config_1.default)('xlsx').single('source'), stock_controller_1.default.uploadExcel);
// POST /api/stock/upload/sold-xlsx - Mark sold cards as verified via Excel
router.post('/upload/sold-xlsx', (0, multer_config_1.default)('xlsx').single('source'), stock_controller_1.default.uploadSoldExcel);
// POST /api/stock/merge - Merge card and number
router.post('/merges', stock_controller_1.default.mergeSim);
router.post('/merges/bulk', stock_controller_1.default.bulkMergeSim);
router.get('/merges', stock_controller_1.default.getMerges);
// GET /api/stock/dashboard - Get dashboard data
router.get('/dashboard', stock_controller_1.default.dashboardSync);
// GET /api/stock/dashboard/dc-distribution - Monthly DC distribution chart
router.get('/dashboard/dc-distribution', stock_controller_1.default.getDCDistributionChart);
// GET /api/stock/dashboard/store-distribution - Monthly store distribution chart
router.get('/dashboard/store-distribution', stock_controller_1.default.getStoreDistributionChart);
exports.default = router;
