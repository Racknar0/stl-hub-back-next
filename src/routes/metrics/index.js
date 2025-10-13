import express from 'express'
import { getUploadsMetrics, getConnectionsToday } from '../../controllers/metrics.controller.js'

const router = express.Router()

router.get('/uploads', getUploadsMetrics)
router.get('/connections-today', getConnectionsToday)

export default router
