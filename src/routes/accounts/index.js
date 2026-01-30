import { Router } from 'express';
import { createAccount, testAccount, listAccounts, updateAccount, deleteAccount, getAccountDetail, logoutAccount, listAccountAssets, addBackupToMain, removeBackupFromMain, listBackupCandidates, syncMainToBackups } from '../../controllers/account.controller.js';
import { syncBackupsToMain } from '../../controllers/restoreFromBackups.controller.js';
import { requireAuth, requireAdmin } from '../../middlewares/auth.js';

const router = Router();

router.use(requireAuth, requireAdmin);

router.get('/', listAccounts);
router.get('/:id', getAccountDetail);
router.get('/:id/assets', listAccountAssets);
router.post('/', createAccount);
router.patch('/:id', updateAccount);
router.delete('/:id', deleteAccount);
router.post('/:id/test', testAccount);
router.post('/:id/sync-main-backups', syncMainToBackups);
router.post('/:id/restore-from-backups', syncBackupsToMain);
router.post('/:id/backups', addBackupToMain); // body: { backupAccountId }
router.delete('/:id/backups/:backupId', removeBackupFromMain);
router.get('/:id/backup-candidates', listBackupCandidates);
router.post('/logout', logoutAccount);

export default router;
