import { Router } from 'express';
import { requireAuth } from '../../middlewares/auth.js';
import { getMyProfile, getMyDownloads, getMyStats, updateMyLanguage, getMyUploaderProfiles, upsertMyUploaderProfiles } from '../../controllers/me.controller.js';

const router = Router();

router.use(requireAuth);

router.get('/profile', getMyProfile);
router.get('/downloads', getMyDownloads);
router.get('/stats', getMyStats);
router.patch('/language', updateMyLanguage); 

// Perfiles del uploader (persistidos por usuario)
router.get('/uploader-profiles', getMyUploaderProfiles);
router.post('/uploader-profiles', upsertMyUploaderProfiles);

export default router;
