import express from 'express';
import { 
    listChannels, 
    addChannel, 
    updateChannel,
    deleteChannel, 
    getChannelInfo, 
    scanWithLimit,
    quickScan,
    startDownload, 
    cancelDownload, 
    downloadStatus,
    streamProgress,
    checkAuth,
    logout,
    clearDownloads,
    startAuth,
    provideCode,
    providePassword
} from '../../controllers/telegramDownloader.controller.js';

const router = express.Router();

router.get('/auth/status', checkAuth);
router.post('/auth/logout', logout);
router.post('/clear-downloads', clearDownloads);
router.post('/auth/start', startAuth);
router.post('/auth/code', provideCode);
router.post('/auth/password', providePassword);

router.get('/channels', listChannels);
router.post('/channels', addChannel);
router.patch('/channels/:name', updateChannel);
router.delete('/channels/:name', deleteChannel);
router.get('/info', getChannelInfo);
router.get('/scan', scanWithLimit);
router.get('/quick-scan', quickScan);
router.post('/start', startDownload);
router.post('/cancel', cancelDownload);
router.get('/download-status', downloadStatus);
router.get('/stream', streamProgress);

export default router;
