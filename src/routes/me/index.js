import { Router } from 'express';
import { requireAuth } from '../../middlewares/auth.js';
import {
  getMyProfile,
  getMyDownloads,
  getMyStats,
  updateMyLanguage,
  getMyUploaderProfiles,
  upsertMyUploaderProfiles,
  getMyFreebieRolls,
  registerFreebieRoll,
  getMyNotifications,
  getMyNotificationsUnreadCount,
  markMyNotificationAsRead,
  markAllMyNotificationsAsRead
} from '../../controllers/me.controller.js';

const router = Router();

router.use(requireAuth);

router.get('/profile', getMyProfile);
router.get('/downloads', getMyDownloads);
router.get('/stats', getMyStats);
router.patch('/language', updateMyLanguage); 

// Perfiles del uploader (persistidos por usuario)
router.get('/uploader-profiles', getMyUploaderProfiles);
router.post('/uploader-profiles', upsertMyUploaderProfiles);

// Minijuego de regalos gratuitos (Daily rolls)
router.get('/freebie-rolls', getMyFreebieRolls);
router.post('/freebie-rolls/roll', registerFreebieRoll);

// Notificaciones del cliente
router.get('/notifications', getMyNotifications);
router.get('/notifications/unread-count', getMyNotificationsUnreadCount);
router.patch('/notifications/:id/read', markMyNotificationAsRead);
router.post('/notifications/read-all', markAllMyNotificationsAsRead);

export default router;
