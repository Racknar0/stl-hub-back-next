import express from 'express'
import { getUploadsMetrics } from '../../controllers/metrics.controller.js'

const router = express.Router()

router.get('/uploads', getUploadsMetrics)

export default router
