import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

export const createBrokenReport = async (req, res) => {
  try {
  const assetId = Number.parseInt(req.params.id, 10)
  const note = String(req.body?.note || '').slice(0, 1000)
  if (!Number.isInteger(assetId) || assetId <= 0) return res.status(400).json({ ok: false, error: 'INVALID_ASSET' })

    // TODO: validar captchaToken cuando se integre
    const ip = req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim() || req.socket?.remoteAddress || ''
    const ua = req.headers['user-agent'] || ''

    const created = await prisma.brokenReport.create({
      data: { assetId, note, status: 'NEW', ip, ua },
      select: { id: true, assetId: true, status: true, createdAt: true },
    })

    return res.status(201).json({ ok: true, data: created })
  } catch (e) {
    console.error('createBrokenReport error', e)
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' })
  }
}

export const listBrokenReports = async (_req, res) => {
  try {
    const data = await prisma.brokenReport.findMany({
      orderBy: { createdAt: 'desc' },
      select: { id: true, assetId: true, note: true, status: true, createdAt: true, ip: true, ua: true },
    })
    return res.json({ ok: true, data })
  } catch (e) {
    console.error('listBrokenReports error', e)
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' })
  }
}

export const updateBrokenReportStatus = async (req, res) => {
  try {
  const id = Number.parseInt(req.params.id, 10)
    const status = String(req.body?.status || '').trim().toUpperCase()
    const allowed = ['NEW','IN_PROGRESS','RESOLVED','REJECTED']
    if (!id || !allowed.includes(status)) return res.status(400).json({ ok: false, error: 'INVALID_INPUT' })

    const updated = await prisma.brokenReport.update({
      where: { id },
      data: { status },
      select: { id: true, status: true },
    })
    return res.json({ ok: true, data: updated })
  } catch (e) {
    if (e?.code === 'P2025') return res.status(404).json({ ok: false, error: 'NOT_FOUND' })
    console.error('updateBrokenReportStatus error', e)
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' })
  }
}

export const deleteBrokenReport = async (req, res) => {
  try {
  const id = Number.parseInt(req.params.id, 10)
  await prisma.brokenReport.delete({ where: { id } })
    return res.json({ ok: true })
  } catch (e) {
    if (e?.code === 'P2025') return res.status(404).json({ ok: false, error: 'NOT_FOUND' })
    console.error('deleteBrokenReport error', e)
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' })
  }
}
