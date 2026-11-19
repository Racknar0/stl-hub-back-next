import express from 'express';
import { requireAuth, requireAdmin } from '../../middlewares/auth.js';
import {
  activateLicense, validateLicense,
  adminListProducts, adminCreateProduct, adminUpdateProduct,
  adminCreateSerials, adminListSerials, adminGetSerial, adminLookupSerial,
  adminRevokeSerial, adminUnrevokeSerial, adminResetActivation, adminPublicKey,
} from '../../controllers/licenses.controller.js';

// Público: lo llaman los programas de escritorio (/api/v1/licenses/...)
export const publicLicensesRouter = express.Router();
publicLicensesRouter.post('/activate', activateLicense);
publicLicensesRouter.post('/validate', validateLicense);

// Administración: solo admins del dashboard (/api/admin/licenses/...)
const router = express.Router();
router.use(requireAuth, requireAdmin);
router.get('/public-key', adminPublicKey);
router.get('/products', adminListProducts);
router.post('/products', adminCreateProduct);
router.patch('/products/:id', adminUpdateProduct);
router.get('/serials', adminListSerials);
router.post('/serials', adminCreateSerials);
router.post('/serials/lookup', adminLookupSerial);
router.get('/serials/:id', adminGetSerial);
router.post('/serials/:id/revoke', adminRevokeSerial);
router.post('/serials/:id/unrevoke', adminUnrevokeSerial);
router.post('/serials/:id/reset-activation', adminResetActivation);

export default router;
