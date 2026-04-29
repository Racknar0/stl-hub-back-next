import express from 'express';
import downloaderRoutes from './downloader.routes.js';
import organizerRoutes from './organizer.routes.js';

const router = express.Router();

router.use('/telegram', downloaderRoutes);
router.use('/organizer', organizerRoutes);

export default router;
