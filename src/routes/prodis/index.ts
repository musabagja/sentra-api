import express from 'express';
import upload from '../../utils/multer.config';
import ProdisSecret from '../../middlewares/prodis-secret.handler';
import { prodisErrorHandler, prodisRateLimit } from '../../utils/prodis.util';
import ProdisAuthController from '../../controllers/prodis-auth.controller';
import ProdisInventoryController from '../../controllers/prodis-inventory.controller';
import ProdisSalesController from '../../controllers/prodis-sales.controller';
import ProdisOpnameController from '../../controllers/prodis-opname.controller';
import ProdisFileController from '../../controllers/prodis-file.controller';

const router = express.Router();

router.use(prodisRateLimit);

router.use(ProdisSecret.authenticate);

router.post('/auth/sign-in', ProdisAuthController.signIn);

router.get('/access', ProdisInventoryController.access);

router.get('/files/url', ProdisFileController.getUrl);

router.get('/inventory/summary', ProdisInventoryController.summary);
router.get('/inventory/filters', ProdisInventoryController.filters);
router.get('/inventory/iccid', ProdisInventoryController.iccidList);
router.post('/inventory/iccid/lookup', ProdisInventoryController.iccidLookup);
router.get('/inventory/iccid/:iccid', ProdisInventoryController.iccidDetail);
router.get('/inventory/msisdn', ProdisInventoryController.msisdnList);
router.post('/inventory/msisdn/lookup', ProdisInventoryController.msisdnLookup);

router.get('/sales/summary', ProdisSalesController.summary);
router.get('/sales/stores/:storeId/cards', ProdisSalesController.storeCards);
router.get('/sales/stores/:storeId/others', ProdisSalesController.storeOthers);
router.post('/sales/lookup', ProdisSalesController.lookup);
router.get('/sales/report', ProdisSalesController.report);
router.get('/sales/:saleId', ProdisSalesController.saleDetail);

router.get('/stock-opname', ProdisOpnameController.list);
router.post('/stock-opname/validate-iccids', ProdisOpnameController.validateIccids);
router.post(
  '/stock-opname',
  upload('image').fields([
    { name: 'executorSignature', maxCount: 1 },
    { name: 'witnessSignature', maxCount: 1 },
    { name: 'photoCards', maxCount: 1 },
    { name: 'photoDisplay', maxCount: 1 }
  ]),
  ProdisOpnameController.submit
);
router.get('/stock-opname/:id', ProdisOpnameController.detail);

router.get('/stores', ProdisOpnameController.stores);
router.get('/stores/:storeId/cards', ProdisOpnameController.storeCards);
router.patch('/stores/:storeId/opname-status', ProdisOpnameController.updateStoreStatus);

router.use(prodisErrorHandler);

export default router;
