import { Router } from 'express'
import { requireAuth, requireAdmin } from '../../middlewares/auth.js'
import { listBrokenReports, updateBrokenReportStatus, deleteBrokenReport, deleteBrokenReportsByAsset } from '../../controllers/brokenReport.controller.js'

const router = Router()

// Todas requieren admin
router.use(requireAuth, requireAdmin)

router.get('/broken', listBrokenReports)
router.patch('/broken/:id', updateBrokenReportStatus)
router.delete('/broken/:id', deleteBrokenReport)
// Eliminar todos los reportes asociados a un asset (por assetId)
router.delete('/broken/asset/:assetId', deleteBrokenReportsByAsset)

export default router
