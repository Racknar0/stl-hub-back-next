import { Router } from 'express'
import { requireAuth, requireAdmin } from '../../middlewares/auth.js'
import { listBrokenReports, updateBrokenReportStatus, deleteBrokenReport } from '../../controllers/brokenReport.controller.js'

const router = Router()

// Todas requieren admin
router.use(requireAuth, requireAdmin)

router.get('/broken', listBrokenReports)
router.patch('/broken/:id', updateBrokenReportStatus)
router.delete('/broken/:id', deleteBrokenReport)

export default router
