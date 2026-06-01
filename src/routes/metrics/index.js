import express from 'express'
import { getUploadsMetrics, getConnectionsToday, getVpsMemoryMetrics } from '../../controllers/metrics.controller.js'
import { getUsersCount } from '../../controllers/metrics.controller.js'
import { getDownloadMetrics, getDownloadsTimeseries } from '../../controllers/metrics.controller.js'
import { getRegistrationMetrics, getRegistrationTimeseries } from '../../controllers/metrics.controller.js'
import { getTopDownloads } from '../../controllers/metrics.controller.js'
import { getTaxonomyCounts } from '../../controllers/metrics.controller.js'
import { getRecentDownloads } from '../../controllers/metrics.controller.js'
import { recordSearchEvent, recordSearchClick, getSearchInsights, getRecentSearches, getTopSearchQueries, getSiteVisitsMetrics, getSiteVisitsTimeseries, getTopPages, recordPlanClick, getPlanClickTimeseries } from '../../controllers/metrics.controller.js'
import { recordCampaignVisit } from '../../controllers/metrics.controller.js'
import { getSalesMetrics } from '../../controllers/metrics.controller.js'
import { requireAuth, requireAdmin } from '../../middlewares/auth.js'

const router = express.Router()

// Tracking de buscador (público)
router.post('/search', recordSearchEvent)
router.post('/search/:id/click', recordSearchClick)
router.get('/top-search-queries', getTopSearchQueries)
router.post('/campaign-visit', recordCampaignVisit)
router.post('/plan-click', recordPlanClick)

// El resto de endpoints de métricas son administrativos
router.use(requireAuth, requireAdmin)

router.get('/uploads', getUploadsMetrics)
router.get('/vps-memory', getVpsMemoryMetrics)
router.get('/connections-today', getConnectionsToday)
router.get('/users', getUsersCount)
router.get('/downloads', getDownloadMetrics)
router.get('/downloads/timeseries', getDownloadsTimeseries)
router.get('/registrations', getRegistrationMetrics)
router.get('/registrations/timeseries', getRegistrationTimeseries)
router.get('/top-downloads', getTopDownloads)
router.get('/recent-downloads', getRecentDownloads)
router.get('/taxonomy-counts', getTaxonomyCounts)
router.get('/sales', getSalesMetrics)
router.get('/site-visits', getSiteVisitsMetrics)
router.get('/site-visits/timeseries', getSiteVisitsTimeseries)
router.get('/site-visits/top-pages', getTopPages)
router.get('/search-insights', getSearchInsights)
router.get('/recent-searches', getRecentSearches)
router.get('/plan-clicks/timeseries', getPlanClickTimeseries)

export default router
