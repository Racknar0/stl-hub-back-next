import express from 'express'
import { getUploadsMetrics, getConnectionsToday } from '../../controllers/metrics.controller.js'
import { getUsersCount } from '../../controllers/metrics.controller.js'
import { getDownloadMetrics } from '../../controllers/metrics.controller.js'
import { getRegistrationMetrics } from '../../controllers/metrics.controller.js'

const router = express.Router()

router.get('/uploads', getUploadsMetrics)
router.get('/connections-today', getConnectionsToday)
router.get('/users', getUsersCount)
router.get('/downloads', getDownloadMetrics)
router.get('/registrations', getRegistrationMetrics)

export default router
