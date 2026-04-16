import express from 'express'
import { getUploadsMetrics, getConnectionsToday, getVpsMemoryMetrics } from '../../controllers/metrics.controller.js'
import { getUsersCount } from '../../controllers/metrics.controller.js'
import { getDownloadMetrics } from '../../controllers/metrics.controller.js'
import { getRegistrationMetrics } from '../../controllers/metrics.controller.js'
import { getTopDownloads } from '../../controllers/metrics.controller.js'
import { getTaxonomyCounts } from '../../controllers/metrics.controller.js'
import { recordSearchEvent, recordSearchClick, getSearchInsights } from '../../controllers/metrics.controller.js'
import { recordCampaignVisit } from '../../controllers/metrics.controller.js'

const router = express.Router()

router.get('/uploads', getUploadsMetrics)
router.get('/vps-memory', getVpsMemoryMetrics)
router.get('/connections-today', getConnectionsToday)
router.get('/users', getUsersCount)
router.get('/downloads', getDownloadMetrics)
router.get('/registrations', getRegistrationMetrics)
router.get('/top-downloads', getTopDownloads)
router.get('/taxonomy-counts', getTaxonomyCounts)

// Tracking de buscador (público)
router.post('/search', recordSearchEvent)
router.post('/search/:id/click', recordSearchClick)
router.get('/search-insights', getSearchInsights)
router.post('/campaign-visit', recordCampaignVisit)

export default router
