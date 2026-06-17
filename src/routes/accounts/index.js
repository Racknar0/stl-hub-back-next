import { Router } from 'express';
import { createAccount, testAccount, listAccounts, updateAccount, deleteAccount, getAccountDetail, logoutAccount, listAccountAssets, addBackupToMain, removeBackupFromMain, listBackupCandidates, syncMainToBackups, alignmentAudit, alignmentSync, alignmentCleanup, alignmentCleanupUnified, alignmentRestore, alignmentGhostCleanup } from '../../controllers/account.controller.js';
import { syncBackupsToMain } from '../../controllers/restoreFromBackups.controller.js';
import { requireAuth, requireAdmin } from '../../middlewares/auth.js';
import {
  listAccountDirectory,
  createAccountFolder,
  deleteAccountFiles,
  purgeAccountFolder,
  renameAccountFile,
  moveAccountFiles
} from '../../controllers/accountFileExplorer.controller.js';

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
router.post('/:id/alignment-audit', alignmentAudit);
router.post('/:id/alignment-sync', alignmentSync);
router.post('/:id/alignment-cleanup', alignmentCleanup);
router.post('/:id/alignment-cleanup-unified', alignmentCleanupUnified);
router.post('/:id/alignment-restore', alignmentRestore);
router.post('/:id/alignment-ghost-cleanup', alignmentGhostCleanup);
router.post('/logout', logoutAccount);

// Endpoints del Explorador de Archivos en Vivo para Cuentas
router.get('/:id/file-explorer/list', listAccountDirectory);
router.post('/:id/file-explorer/create-folder', createAccountFolder);
router.post('/:id/file-explorer/delete', deleteAccountFiles);
router.post('/:id/file-explorer/purge', purgeAccountFolder);
router.post('/:id/file-explorer/rename', renameAccountFile);
router.post('/:id/file-explorer/move', moveAccountFiles);

export default router;

