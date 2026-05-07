import express from 'express';
import StockController from '../../controllers/stock.controller';
import upload from '../../utils/multer.config';

const router = express.Router();

// ============================================================================
// CARD ROUTES
// ============================================================================

router.get('/batches', StockController.getBatches);

router.get('/batches/:id', StockController.getBatch);

router.put('/batches/close/:id', StockController.completeBatch);

// GET /api/stock/cards - Get all cards with pagination and filtering
router.get('/cards', StockController.getCards);

// GET /api/stock/cards/:id - Get a specific card by ID
router.get('/cards/:key', StockController.getCard);

// DELETE /api/stock/cards/:id - Delete a specific card
router.delete('/cards/:key', StockController.deleteCard);

// POST /api/stock/cards/validate/:key - Validate a card
router.post('/cards/validate/:key', StockController.validateCard);

// ============================================================================
// NUMBER ROUTES
// ============================================================================

// POST /api/stock/numbers - Create a new number
router.post('/numbers', StockController.createNumber);

// GET /api/stock/numbers - Get all numbers with pagination and filtering
router.get('/numbers', StockController.getNumbers);

// GET /api/stock/numbers/:id - Get a specific number by ID
router.get('/numbers/:id', StockController.getNumber);

// PUT /api/stock/numbers/:id - Update a specific number
router.put('/numbers/:id', StockController.updateNumber);

// DELETE /api/stock/numbers/:id - Delete a specific number
router.delete('/numbers/:id', StockController.deleteNumber);

// POST /api/upload/xlsx - Upload bunch of cards from Excel file
router.post('/upload/xlsx', upload('xlsx').single('source'), StockController.uploadExcel);

// POST /api/stock/merge - Merge card and number
router.post('/merges', StockController.mergeSim);

router.get('/merges', StockController.getMerges);

// GET /api/stock/dashboard - Get dashboard data
router.get('/dashboard', StockController.dashboardSync);

export default router;
