import express from 'express';
import {
    listDirectory,
    createFolder,
    deleteFiles,
    moveFiles,
    renameFile,
    previewFile
} from '../../controllers/fileExplorer.controller.js';

const router = express.Router();

router.get('/list', listDirectory);
router.get('/preview', previewFile);
router.post('/create-folder', createFolder);
router.post('/delete', deleteFiles);
router.post('/move', moveFiles);
router.post('/rename', renameFile);

export default router;
