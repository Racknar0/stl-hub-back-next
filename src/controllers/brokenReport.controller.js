import { PrismaClient } from '@prisma/client'
const RECAPTCHA_SECRET_KEY = process.env.RECAPTCHA_SECRET_KEY;

async function validateCaptcha(token, remoteIp) {
  // Use global fetch if available (Node 18+). Otherwise try dynamic import of node-fetch.
  let fetchFn = (typeof fetch !== 'undefined') ? fetch : null;
  if (!fetchFn) {
    try {
      const mod = await import('node-fetch');
      fetchFn = mod.default || mod;
    } catch (err) {
      console.warn('[CAPTCHA] fetch not available and node-fetch could not be imported:', err?.message);
      return false;
    }
  }

  if (!RECAPTCHA_SECRET_KEY) {
    console.warn('[CAPTCHA] RECAPTCHA_SECRET_KEY not set in environment; skipping captcha check in non-production');
    // In production we should fail; in development allow reports to proceed so "reportes" are not blocked when env isn't set
    return process.env.NODE_ENV === 'production' ? false : true;
  }

  const params = new URLSearchParams();
  params.append('secret', RECAPTCHA_SECRET_KEY);
  params.append('response', token);
  if (remoteIp) params.append('remoteip', remoteIp);

  const res = await fetchFn('https://www.google.com/recaptcha/api/siteverify', {
    method: 'POST',
    body: params
  });
  const data = await res.json();
  console.log('[CAPTCHA]', data); // LOG para debug
  return Boolean(data?.success);
}

const prisma = new PrismaClient()

export const createBrokenReport = async (req, res) => {

  try {
    const assetId = Number.parseInt(req.params.id, 10)
    const note = String(req.body?.note || '').slice(0, 1000)
    if (!Number.isInteger(assetId) || assetId <= 0) return res.status(400).json({ ok: false, error: 'INVALID_ASSET' })

    const captchaToken = req.body?.captchaToken;
    const ip = req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim() || req.socket?.remoteAddress || ''
    // If RECAPTCHA_SECRET_KEY is configured, require a token and validate it.
    // If not configured (dev), allow reporting without a token.
    let captchaOk = true;
    if (RECAPTCHA_SECRET_KEY) {
      if (!captchaToken || !(await validateCaptcha(captchaToken, ip))) {
        captchaOk = false;
      }
    }
    if (!captchaOk) {
      return res.status(400).json({ ok: false, error: 'INVALID_CAPTCHA' });
    }
    const ua = req.headers['user-agent'] || ''

    const created = await prisma.brokenReport.create({
      data: { assetId, note, status: 'NEW', ip, ua },
      select: { id: true, assetId: true, status: true, createdAt: true },
    })

    // Notificación de reporte de link caído
    try {
      // Buscar el asset y la cuenta asociada
      const asset = await prisma.asset.findUnique({ where: { id: assetId }, select: { title: true, accountId: true } })
      let account = null
      let accountEmail = '--'
      if (asset?.accountId) {
        account = await prisma.megaAccount.findUnique({ where: { id: asset.accountId }, select: { email: true } })
        accountEmail = account?.email || '--'
      }
      await prisma.notification.create({
        data: {
          title: 'Reporte de link caído',
          body: `Se reportó el asset "${asset?.title || 'Desconocido'}" (assetId=${assetId}) como caído. Cuenta asociada: id=${asset?.accountId || '--'}, email=${accountEmail}. Nota: ${note || '(sin nota)'}`,
          status: 'UNREAD',
          type: 'REPORT',
          typeStatus: 'PENDING'
        }
      })
    } catch(e){ console.warn('[NOTIF][BROKEN] No se pudo crear notificación: '+e.message) }

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

    // Obtener títulos de assets relacionados en una sola consulta para evitar N+1
    const assetIds = Array.from(new Set(data.map((d) => d.assetId).filter(Boolean)))
    let assetMap = {}
    if (assetIds.length > 0) {
      const assets = await prisma.asset.findMany({ where: { id: { in: assetIds } }, select: { id: true, title: true } })
      assetMap = Object.fromEntries(assets.map((a) => [a.id, a.title]))
    }

    const mapped = data.map((d) => ({ ...d, assetTitle: assetMap[d.assetId] || null }))
    return res.json({ ok: true, data: mapped })
  } catch (e) {
    console.error('listBrokenReports error', e)
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' })
  }
}

export const deleteBrokenReportsByAsset = async (req, res) => {
  try {
    const assetId = Number.parseInt(req.params.assetId, 10)
    if (!assetId || assetId <= 0) return res.status(400).json({ ok: false, error: 'INVALID_INPUT' })

    const result = await prisma.brokenReport.deleteMany({ where: { assetId } })
    return res.json({ ok: true, deleted: result.count })
  } catch (e) {
    console.error('deleteBrokenReportsByAsset error', e)
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
