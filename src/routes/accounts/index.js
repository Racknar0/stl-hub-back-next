import { Router } from 'express';
import { createAccount, testAccount, listAccounts, updateAccount, getAccountDetail, logoutAccount, listAccountAssets, addBackupToMain, removeBackupFromMain, listBackupCandidates } from '../../controllers/account.controller.js';
import { requireAuth, requireAdmin } from '../../middlewares/auth.js';

const router = Router();

router.use(requireAuth, requireAdmin);

router.get('/', listAccounts);
router.get('/:id', getAccountDetail);
router.get('/:id/assets', listAccountAssets);
router.post('/', createAccount);
router.patch('/:id', updateAccount);
router.post('/:id/test', testAccount);
router.post('/:id/backups', addBackupToMain); // body: { backupAccountId }
router.delete('/:id/backups/:backupId', removeBackupFromMain);
router.get('/:id/backup-candidates', listBackupCandidates);
router.post('/logout', logoutAccount);

export default router;
