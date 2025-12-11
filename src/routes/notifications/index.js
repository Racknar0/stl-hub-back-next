import { Router } from 'express'
import { requireAuth, requireAdmin } from '../../../src/middlewares/auth.js'
import { listNotifications, getNotification, createNotification, updateNotification, deleteNotification, markAllNotificationsRead, clearAutomationNotifications } from '../../controllers/notification.controller.js'

const router = Router()

router.use(requireAuth, requireAdmin)
router.get('/', listNotifications)
router.get('/:id', getNotification)
router.post('/', createNotification)
router.put('/:id', updateNotification)
router.delete('/:id', deleteNotification)
router.post('/mark-all-read', markAllNotificationsRead)
router.post('/clear-automation', clearAutomationNotifications)

export default router
