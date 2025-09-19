import { Router } from 'express';
import { createAccount, testAccount, listAccounts, updateAccount, getAccountDetail, logoutAccount, listAccountAssets } from '../../controllers/account.controller.js';

const router = Router();

router.get('/', listAccounts);
router.get('/:id', getAccountDetail);
router.get('/:id/assets', listAccountAssets);
router.post('/', createAccount);
router.patch('/:id', updateAccount);
router.post('/:id/test', testAccount);
router.post('/logout', logoutAccount);

export default router;
