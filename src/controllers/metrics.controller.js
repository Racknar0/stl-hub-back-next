import { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';
import { execFileSync } from 'child_process';
import path from 'path';
import crypto from 'crypto';
import { extractTrackingFromBody, extractVisitIdentityFromRequest, pickTrackingForDb, resolveMarketingCampaignId, toSlug } from '../utils/attribution.js';
import { toCopAmountFromPayment } from '../utils/paymentCurrency.js';

const prisma = new PrismaClient();

const SEARCH_EVENTS_MAX = Math.max(1000, Number(process.env.SEARCH_EVENTS_MAX || 200000) || 200000)
const SEARCH_EVENTS_RETENTION_DAYS = Math.max(7, Number(process.env.SEARCH_EVENTS_RETENTION_DAYS || 90) || 90)

const searchCleanupState = globalThis.__searchCleanupState || { lastRunMs: 0, calls: 0 }
globalThis.__searchCleanupState = searchCleanupState

const UTC5_OFFSET_HOURS = 5
const UTC5_OFFSET_MS = UTC5_OFFSET_HOURS * 60 * 60 * 1000

const SITE_VISIT_MIN_INTERVAL_MS = Math.max(5000, Number(process.env.SITE_VISIT_MIN_INTERVAL_MS || 15000) || 15000)
const SITE_VISIT_MAX_PER_IP_PER_MIN = Math.max(30, Number(process.env.SITE_VISIT_MAX_PER_IP_PER_MIN || 240) || 240)
const SITE_VISIT_IP_HASH_SALT = process.env.SITE_VISIT_IP_HASH_SALT || process.env.JWT_SECRET || 'stl-hub-site-visit'
const SITE_VISIT_ALLOWED_HOSTS = new Set([
  'stl-hub.com',
  'www.stl-hub.com',
  'api.stl-hub.com',
  'localhost',
  '127.0.0.1',
  ...String(process.env.SITE_VISIT_ALLOWED_HOSTS || '')
    .split(',')
    .map((h) => String(h || '').trim().toLowerCase())
    .filter(Boolean),
])

const siteVisitGuardState = globalThis.__siteVisitGuardState || {
  dedupe: new Map(),
  ipMinute: new Map(),
  lastCleanupMs: 0,
}
globalThis.__siteVisitGuardState = siteVisitGuardState

function parseUtc5DateBoundary(rawDate, { endOfDay = false } = {}) {
  const value = String(rawDate || '').trim()
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return new Date(NaN)

  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  const hour = endOfDay ? 23 : 0
  const minute = endOfDay ? 59 : 0
  const second = endOfDay ? 59 : 0
  const ms = endOfDay ? 999 : 0

  return new Date(Date.UTC(year, month - 1, day, hour + UTC5_OFFSET_HOURS, minute, second, ms))
}

function formatDateInUtc5(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return ''
  return new Date(date.getTime() - UTC5_OFFSET_MS).toISOString().slice(0, 10)
}

function buildDateRangeUtc5(fromRaw, toRaw, defaultDays = 30) {
  const now = new Date()
  const fromDate = fromRaw
    ? parseUtc5DateBoundary(fromRaw, { endOfDay: false })
    : new Date(now.getTime() - defaultDays * 24 * 60 * 60 * 1000)
  const toDate = toRaw
    ? parseUtc5DateBoundary(toRaw, { endOfDay: true })
    : now
  return { fromDate, toDate }
}

function parseHostname(rawUrl) {
  try {
    return new URL(String(rawUrl || '')).hostname.toLowerCase()
  } catch {
    return null
  }
}

function isAllowedTrackingHost(hostname) {
  const host = String(hostname || '').trim().toLowerCase()
  if (!host) return false
  if (SITE_VISIT_ALLOWED_HOSTS.has(host)) return true
  if (host.endsWith('.stl-hub.com')) return true
  return false
}

function isTrackingOriginAllowed(req) {
  const originHost = parseHostname(req.headers.origin)
  const refererHost = parseHostname(req.headers.referer)

  // Si no hay headers de navegación, no bloqueamos para evitar falsos negativos.
  if (!originHost && !refererHost) return true

  return [originHost, refererHost].filter(Boolean).some(isAllowedTrackingHost)
}

function normalizeIpAddress(rawIp) {
  let ip = String(rawIp || '').trim()
  if (!ip) return ''

  // X-Forwarded-For puede traer múltiples IPs
  if (ip.includes(',')) ip = ip.split(',')[0].trim()

  // IPv4 mapeada en IPv6
  if (ip.startsWith('::ffff:')) ip = ip.slice(7)

  return ip.trim()
}

function extractClientIp(req) {
  return normalizeIpAddress(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '')
}

function hashIpAddress(rawIp) {
  const ip = normalizeIpAddress(rawIp)
  if (!ip) return null
  return crypto.createHash('sha256').update(`${SITE_VISIT_IP_HASH_SALT}|${ip}`).digest('hex').slice(0, 64)
}

function cleanupSiteVisitGuard(nowMs) {
  if (nowMs - siteVisitGuardState.lastCleanupMs < 60 * 1000) return
  siteVisitGuardState.lastCleanupMs = nowMs

  const dedupeTtlMs = Math.max(60 * 1000, SITE_VISIT_MIN_INTERVAL_MS * 6)
  for (const [key, ts] of siteVisitGuardState.dedupe.entries()) {
    if (nowMs - ts > dedupeTtlMs) siteVisitGuardState.dedupe.delete(key)
  }

  const minuteBucket = Math.floor(nowMs / 60000)
  for (const [key, state] of siteVisitGuardState.ipMinute.entries()) {
    if (!state || state.minuteBucket < minuteBucket - 1) {
      siteVisitGuardState.ipMinute.delete(key)
    }
  }

  if (siteVisitGuardState.dedupe.size > 100000) siteVisitGuardState.dedupe.clear()
  if (siteVisitGuardState.ipMinute.size > 20000) siteVisitGuardState.ipMinute.clear()
}

function isIpRateLimited(ipHash, nowMs) {
  const key = String(ipHash || 'unknown')
  const minuteBucket = Math.floor(nowMs / 60000)
  const prev = siteVisitGuardState.ipMinute.get(key)

  if (!prev || prev.minuteBucket !== minuteBucket) {
    siteVisitGuardState.ipMinute.set(key, { minuteBucket, count: 1 })
    return false
  }

  if (prev.count >= SITE_VISIT_MAX_PER_IP_PER_MIN) return true

  prev.count += 1
  siteVisitGuardState.ipMinute.set(key, prev)
  return false
}

function isDuplicateSiteVisit(dedupeKey, nowMs) {
  const prevTs = siteVisitGuardState.dedupe.get(dedupeKey)
  if (prevTs && nowMs - prevTs < SITE_VISIT_MIN_INTERVAL_MS) return true
  siteVisitGuardState.dedupe.set(dedupeKey, nowMs)
  return false
}

function normalizeSearchQuery(input) {
  const original = String(input || '')
  const q = original.trim().toLowerCase().replace(/\s+/g, ' ')
  // opcional quitar acentos: lo guardamos para unificar métricas
  const noAccents = q
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
  return { original: original.trim(), norm: q, normNoAccents: noAccents }
}

function getUserIdFromAuthHeader(req) {
  try {
    const auth = req.headers.authorization || ''
    const bearer = String(auth).startsWith('Bearer ') ? String(auth).slice(7) : null
    if (!bearer) return null
    const secret = process.env.JWT_SECRET || 'dev-secret'
    const payload = jwt.verify(bearer, secret)
    const id = Number(payload?.id)
    return Number.isFinite(id) && id > 0 ? id : null
  } catch {
    // Analytics: si el token es inválido, tratamos como anónimo
    return null
  }
}

async function maybeCleanupSearchEvents() {
  try {
    // Evitar limpiar en cada request
    searchCleanupState.calls += 1
    const now = Date.now()
    if (searchCleanupState.calls % 50 !== 0 && now - searchCleanupState.lastRunMs < 60 * 60 * 1000) return
    searchCleanupState.lastRunMs = now

    const cutoff = new Date(now - SEARCH_EVENTS_RETENTION_DAYS * 24 * 60 * 60 * 1000)
    await prisma.searchEvent.deleteMany({ where: { createdAt: { lt: cutoff } } })

    const total = await prisma.searchEvent.count()
    if (total <= SEARCH_EVENTS_MAX) return

    // Borrar los más antiguos por batches
    const toDelete = await prisma.searchEvent.findMany({
      select: { id: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: SEARCH_EVENTS_MAX,
      take: Math.min(5000, Math.max(1000, total - SEARCH_EVENTS_MAX)),
    })
    const ids = toDelete.map((r) => r.id)
    if (ids.length) await prisma.searchEvent.deleteMany({ where: { id: { in: ids } } })
  } catch (e) {
    console.warn('maybeCleanupSearchEvents warn', e?.message || e)
  }
}

function startOfDay(d) {
  const t = new Date(d)
  t.setHours(0,0,0,0)
  return t
}

const salesProviderLabel = (providerRaw) => {
  const provider = String(providerRaw || '').trim().toUpperCase();
  if (provider === 'PAYPAL') return 'PayPal';
  if (provider === 'MERCADOPAGO') return 'MercadoPago';
  if (provider === 'STRIPE') return 'Stripe';
  return provider || 'Otro';
};

const buildSalesRangeBoundaries = (now = new Date()) => ({
  'hoy': new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000),
  '2d': new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000),
  '3d': new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000),
  '7d': new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
  '15d': new Date(now.getTime() - 15 * 24 * 60 * 60 * 1000),
  '1m': new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
  '1y': new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000),
});

const roundMoney = (value) => {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
};

function readLinuxDiskSnapshot(targetPath) {
  try {
    const out = execFileSync('df', ['-kP', targetPath], { encoding: 'utf8' })
    const lines = String(out || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    if (lines.length < 2) return null

    const dataLine = lines[lines.length - 1]
    const cols = dataLine.split(/\s+/)
    if (cols.length < 6) return null

    const totalBytes = Number(cols[1] || 0) * 1024
    const usedBytes = Number(cols[2] || 0) * 1024
    const availableBytes = Number(cols[3] || 0) * 1024

    if (!Number.isFinite(totalBytes) || totalBytes <= 0) return null
    const safeUsed = Number.isFinite(usedBytes) ? usedBytes : Math.max(0, totalBytes - availableBytes)

    return {
      totalBytes,
      usedBytes: Math.max(0, Math.min(totalBytes, safeUsed || 0)),
      availableBytes: Math.max(0, Math.min(totalBytes, availableBytes || 0)),
    }
  } catch {
    return null
  }
}

export async function getVpsMemoryMetrics(req, res) {
  try {
    const platform = String(process.platform || '').toLowerCase()

    if (platform === 'win32') {
      return res.json({ supported: false, platform })
    }

    const targetPath = String(process.env.VPS_STORAGE_PATH || path.resolve('uploads') || '/').trim() || '/'

    let totalBytes = 0
    let availableBytes = 0
    let usedBytes = 0

    if (platform === 'linux') {
      const linuxSnapshot = readLinuxDiskSnapshot(targetPath) || readLinuxDiskSnapshot('/')
      if (linuxSnapshot) {
        totalBytes = Number(linuxSnapshot.totalBytes || 0)
        availableBytes = Number(linuxSnapshot.availableBytes || 0)
        usedBytes = Number(linuxSnapshot.usedBytes || 0)
      }
    }

    if (!totalBytes || totalBytes <= 0) {
      return res.status(500).json({ supported: false, error: 'storage-unavailable' })
    }

    availableBytes = Math.max(0, Math.min(totalBytes, availableBytes || 0))
    usedBytes = Math.max(0, Math.min(totalBytes, usedBytes || (totalBytes - availableBytes)))
    const usagePct = totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 1000) / 10 : 0

    const os = await import('os')
    const ramTotalBytes = os.totalmem()
    const ramFreeBytes = os.freemem()
    const ramUsedBytes = ramTotalBytes - ramFreeBytes
    const ramUsagePct = ramTotalBytes > 0 ? Math.round((ramUsedBytes / ramTotalBytes) * 1000) / 10 : 0

    return res.json({
      supported: true,
      platform,
      metric: 'storage',
      targetPath,
      totalBytes,
      availableBytes,
      usedBytes,
      usagePct,
      dangerThresholdPct: 90,
      ramTotalBytes,
      ramFreeBytes,
      ramUsedBytes,
      ramUsagePct,
    })
  } catch (e) {
    console.error('getVpsMemoryMetrics error', e)
    return res.status(500).json({ supported: false, error: 'internal' })
  }
}

export async function getUploadsMetrics(req, res) {
  try {
    const now = new Date()
    const todayStart = startOfDay(now)
    const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000)
    const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000)
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
    const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000)
    const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000)
    const threeSixtyFiveDaysAgo = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000)

    const sumBytes = async (gte) => {
      const r = await prisma.asset.aggregate({
        where: gte ? { createdAt: { gte } } : undefined,
        _sum: { fileSizeB: true },
      })
      return r?._sum?.fileSizeB ?? BigInt(0)
    }

    const [
      todayCount,
      last2dCount,
      last3dCount,
      last7dCount,
      last30dCount,
      last60dCount,
      last90dCount,
      last365dCount,
      totalCount,
      todayBytes,
      last2dBytes,
      last3dBytes,
      last7dBytes,
      last30dBytes,
      last60dBytes,
      last90dBytes,
      last365dBytes,
      totalBytes,
    ] = await Promise.all([
      prisma.asset.count({ where: { createdAt: { gte: todayStart } } }),
      prisma.asset.count({ where: { createdAt: { gte: twoDaysAgo } } }),
      prisma.asset.count({ where: { createdAt: { gte: threeDaysAgo } } }),
      prisma.asset.count({ where: { createdAt: { gte: sevenDaysAgo } } }),
      prisma.asset.count({ where: { createdAt: { gte: thirtyDaysAgo } } }),
      prisma.asset.count({ where: { createdAt: { gte: sixtyDaysAgo } } }),
      prisma.asset.count({ where: { createdAt: { gte: ninetyDaysAgo } } }),
      prisma.asset.count({ where: { createdAt: { gte: threeSixtyFiveDaysAgo } } }),
      prisma.asset.count(),
      sumBytes(todayStart),
      sumBytes(twoDaysAgo),
      sumBytes(threeDaysAgo),
      sumBytes(sevenDaysAgo),
      sumBytes(thirtyDaysAgo),
      sumBytes(sixtyDaysAgo),
      sumBytes(ninetyDaysAgo),
      sumBytes(threeSixtyFiveDaysAgo),
      sumBytes(undefined),
    ])

    const bytesToGB = (b) => {
      try {
        const n = typeof b === 'bigint' ? Number(b) : Number(b || 0)
        if (!Number.isFinite(n) || n <= 0) return 0
        return Math.round((n / (1024 ** 3)) * 10) / 10
      } catch {
        return 0
      }
    }

    const data = {
        today: todayCount,
        last2d: last2dCount,
        last3d: last3dCount,
        lastWeek: last7dCount,
        month: last30dCount,
        months2: last60dCount,
        months3: last90dCount,
        lastYear: last365dCount,
        all: totalCount,
        sizeGB: {
          today: bytesToGB(todayBytes),
          last2d: bytesToGB(last2dBytes),
          last3d: bytesToGB(last3dBytes),
          lastWeek: bytesToGB(last7dBytes),
          month: bytesToGB(last30dBytes),
          months2: bytesToGB(last60dBytes),
          months3: bytesToGB(last90dBytes),
          lastYear: bytesToGB(last365dBytes),
          all: bytesToGB(totalBytes),
        },
    }

    // console.log('getUploadsMetrics data', data)

    return res.json(data)
  } catch (e) {
    console.error('getUploadsMetrics error', e)
    return res.status(500).json({ error: 'internal' })
  }
}

export async function getConnectionsToday(req, res) {
  try {
    const now = new Date();
    const todayStart = startOfDay(now);
    const count = await prisma.user.count({ where: { lastLogin: { gte: todayStart } } });
    return res.json({ today: count });
  } catch (e) {
    console.error('getConnectionsToday error', e);
    return res.status(500).json({ error: 'internal' });
  }
}

export async function getUsersCount(req, res) {
  try {
    // Devolver conteo total de usuarios y conteo de usuarios activos
    const [total, active] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { isActive: true } }),
    ]);
    return res.json({ total, active });
  } catch (e) {
    console.error('getUsersCount error', e);
    return res.status(500).json({ error: 'internal' });
  }
}

export async function getDownloadMetrics(req, res) {
  try {
    const now = new Date()
    const oneDayAgo = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000)
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
    const threeSixtyFiveDaysAgo = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000)

    const [d1, d7, d30, d365, total] = await Promise.all([
      prisma.downloadHistory.count({ where: { downloadedAt: { gte: oneDayAgo } } }),
      prisma.downloadHistory.count({ where: { downloadedAt: { gte: sevenDaysAgo } } }),
      prisma.downloadHistory.count({ where: { downloadedAt: { gte: thirtyDaysAgo } } }),
      prisma.downloadHistory.count({ where: { downloadedAt: { gte: threeSixtyFiveDaysAgo } } }),
      prisma.downloadHistory.count(),
    ])

    return res.json({ '1d': d1, '1w': d7, '1m': d30, '1y': d365, all: total })
  } catch (e) {
    console.error('getDownloadMetrics error', e)
    return res.status(500).json({ error: 'internal' })
  }
}

export async function getSalesMetrics(req, res) {
  try {
    const now = new Date();
    const boundaries = buildSalesRangeBoundaries(now);
    const maxItemsPerRange = Math.max(10, Number(process.env.SALES_METRICS_ITEMS_PER_RANGE || 40) || 40);

    const completedPayments = await prisma.payment.findMany({
      where: { status: 'COMPLETED' },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        provider: true,
        amount: true,
        currency: true,
        rawResponse: true,
        createdAt: true,
      },
    });

    const totals = { 'hoy': 0, '2d': 0, '3d': 0, '7d': 0, '15d': 0, '1m': 0, '1y': 0, all: 0 };
    const items = { 'hoy': [], '2d': [], '3d': [], '7d': [], '15d': [], '1m': [], '1y': [], all: [] };

    for (const payment of completedPayments) {
      const paymentDate = payment?.createdAt ? new Date(payment.createdAt) : null;
      if (!paymentDate || Number.isNaN(paymentDate.getTime())) continue;

      const amountCop = toCopAmountFromPayment(payment);
      const row = {
        id: payment.id,
        provider: String(payment.provider || '').toUpperCase(),
        method: salesProviderLabel(payment.provider),
        amountCop,
        amountOriginal: Number(payment.amount || 0),
        currency: String(payment.currency || 'USD').toUpperCase(),
        date: paymentDate.toISOString().slice(0, 10),
        createdAt: paymentDate.toISOString(),
      };

      totals.all += amountCop;
      if (items.all.length < maxItemsPerRange) items.all.push(row);

      if (paymentDate >= boundaries['1d']) {
        totals['1d'] += amountCop;
        if (items['1d'].length < maxItemsPerRange) items['1d'].push(row);
      }
      if (paymentDate >= boundaries['1w']) {
        totals['1w'] += amountCop;
        if (items['1w'].length < maxItemsPerRange) items['1w'].push(row);
      }
      if (paymentDate >= boundaries['1m']) {
        totals['1m'] += amountCop;
        if (items['1m'].length < maxItemsPerRange) items['1m'].push(row);
      }
      if (paymentDate >= boundaries['1y']) {
        totals['1y'] += amountCop;
        if (items['1y'].length < maxItemsPerRange) items['1y'].push(row);
      }
    }

    return res.json({
      currency: 'COP',
      totals: {
        '1d': roundMoney(totals['1d']),
        '1w': roundMoney(totals['1w']),
        '1m': roundMoney(totals['1m']),
        '1y': roundMoney(totals['1y']),
        all: roundMoney(totals.all),
      },
      items,
      totalPayments: completedPayments.length,
    });
  } catch (e) {
    console.error('getSalesMetrics error', e);
    return res.status(500).json({ error: 'internal' });
  }
}

export async function getRegistrationMetrics(req, res) {
  try {
    const now = new Date()
    const oneDayAgo = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000)
    const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000)
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
    const threeSixtyFiveDaysAgo = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000)

    const [d1, d3, d7, d30, d365, total] = await Promise.all([
      prisma.user.count({ where: { createdAt: { gte: oneDayAgo } } }),
      prisma.user.count({ where: { createdAt: { gte: threeDaysAgo } } }),
      prisma.user.count({ where: { createdAt: { gte: sevenDaysAgo } } }),
      prisma.user.count({ where: { createdAt: { gte: thirtyDaysAgo } } }),
      prisma.user.count({ where: { createdAt: { gte: threeSixtyFiveDaysAgo } } }),
      prisma.user.count(),
    ])

    return res.json({ '1d': d1, '3d': d3, '1w': d7, '1m': d30, '1y': d365, all: total })
  } catch (e) {
    console.error('getRegistrationMetrics error', e)
    return res.status(500).json({ error: 'internal' })
  }
}

export async function getTopDownloads(req, res) {
  try {
    const now = new Date()
    const ranges = {
      'hoy': new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000),
      '2d': new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000),
      '3d': new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000),
      '7d': new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
      '15d': new Date(now.getTime() - 15 * 24 * 60 * 60 * 1000),
      '1m': new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
      '1y': new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000),
      'all': undefined,
    }

    const opts = (gte) => ({
      by: ['assetId', 'assetTitle'],
      where: gte ? { downloadedAt: { gte } } : undefined,
      _count: { id: true },
      orderBy: { _count: { id: 'desc' } },
      take: 100,
    })

    const mapGroup = (arr) => arr.map(r => ({ name: r.assetTitle || `#${r.assetId}`, count: r._count?.id || 0 }))

    const promises = Object.entries(ranges).map(async ([key, date]) => {
      const res = await prisma.downloadHistory.groupBy(opts(date))
      return { key, data: mapGroup(res) }
    })
    
    const results = await Promise.all(promises)
    const responseData = {}
    results.forEach(r => { responseData[r.key] = r.data })

    responseData['1d'] = responseData['hoy']
    responseData['1w'] = responseData['7d']

    return res.json(responseData)
  } catch (e) {
    console.error('getTopDownloads error', e)
    return res.status(500).json({ error: 'internal' })
  }
}

export async function recordSearchEvent(req, res) {
  try {
    const { query, resultCount, isAiSearch } = req.body || {}
    const { original, norm, normNoAccents } = normalizeSearchQuery(query)
    if (!norm) return res.status(200).json({ ok: true, ignored: true })

    const userId = getUserIdFromAuthHeader(req)
    const rc = Number(resultCount)
    const safeResultCount = Number.isFinite(rc) && rc >= 0 ? rc : 0

    const created = await prisma.searchEvent.create({
      data: {
        userId: userId || null,
        queryOriginal: original.slice(0, 512),
        queryNorm: norm.slice(0, 191),
        queryNormNoAccents: normNoAccents.slice(0, 191),
        resultCount: safeResultCount,
        isAiSearch: !!isAiSearch,
      },
      select: { id: true },
    })

    void maybeCleanupSearchEvents()
    return res.status(201).json({ ok: true, id: created.id })
  } catch (e) {
    console.error('recordSearchEvent error', e)
    // no romper UX del buscador
    return res.status(200).json({ ok: false })
  }
}

export async function recordCampaignVisit(req, res) {
  try {
    const tracking = extractTrackingFromBody(req.body || {});
    if (!tracking) return res.status(200).json({ ok: true, ignored: true });

    const marketingCampaignId = await resolveMarketingCampaignId(prisma, tracking);
    const trackingDb = pickTrackingForDb(tracking);

    const cookieIdentity = extractVisitIdentityFromRequest(req);
    const anonIdRaw = String(req.body?.anonId || cookieIdentity.anonId || '').trim();
    const sessionIdRaw = String(req.body?.sessionId || cookieIdentity.sessionId || '').trim();
    const pagePathRaw = String(req.body?.pagePath || '').trim();

    const anonId = anonIdRaw ? anonIdRaw.slice(0, 120) : null;
    const sessionId = sessionIdRaw ? sessionIdRaw.slice(0, 120) : null;
    const pagePath = pagePathRaw ? pagePathRaw.slice(0, 255) : null;

    await prisma.marketingVisit.create({
      data: {
        marketingCampaignId,
        anonId,
        sessionId,
        pagePath,
        utmSource: trackingDb.utmSource,
        utmMedium: trackingDb.utmMedium,
        utmCampaign: trackingDb.utmCampaign || (tracking.utmCampaign ? toSlug(tracking.utmCampaign) : null),
        utmContent: trackingDb.utmContent,
        utmTerm: trackingDb.utmTerm,
        clickGclid: trackingDb.clickGclid,
        clickFbclid: trackingDb.clickFbclid,
        clickTtclid: trackingDb.clickTtclid,
        clickMsclkid: trackingDb.clickMsclkid,
        trackingLandingUrl: trackingDb.utmLandingUrl,
        trackingReferrer: trackingDb.utmReferrer,
      },
      select: { id: true },
    });

    return res.status(201).json({ ok: true });
  } catch (e) {
    console.error('recordCampaignVisit error', e);
    // No romper UX ni navegación por tracking
    return res.status(200).json({ ok: false });
  }
}

export async function recordSearchClick(req, res) {
  try {
    const searchEventId = Number(req.params.id)
    const assetId = Number(req.body?.assetId)
    if (!Number.isFinite(searchEventId) || searchEventId <= 0) return res.status(400).json({ ok: false })
    if (!Number.isFinite(assetId) || assetId <= 0) return res.status(400).json({ ok: false })

    let created = false
    try {
      await prisma.searchClick.create({
        data: { searchEventId, assetId },
        select: { id: true },
      })
      created = true
    } catch (e) {
      // Dedupe por (searchEventId, assetId)
      created = false
    }

    if (created) {
      await prisma.searchEvent.update({
        where: { id: searchEventId },
        data: { clickCount: { increment: 1 }, lastClickedAt: new Date() },
      })
    }

    return res.json({ ok: true, created })
  } catch (e) {
    console.error('recordSearchClick error', e)
    return res.status(200).json({ ok: false })
  }
}

export async function getSearchInsights(req, res) {
  try {
    const now = Date.now()
    const mk = (ms) => new Date(now - ms)
    const ranges = {
      'hoy': mk(1 * 24 * 60 * 60 * 1000),
      '2d': mk(2 * 24 * 60 * 60 * 1000),
      '3d': mk(3 * 24 * 60 * 60 * 1000),
      '7d': mk(7 * 24 * 60 * 60 * 1000),
      '15d': mk(15 * 24 * 60 * 60 * 1000),
      '1m': mk(30 * 24 * 60 * 60 * 1000),
      '1y': mk(365 * 24 * 60 * 60 * 1000),
      all: null,
    }

    const buildFor = async (gte) => {
      const whereEvents = gte ? { createdAt: { gte } } : undefined
      const whereClicks = gte ? { createdAt: { gte } } : undefined

      const [
        topQueries,
        zeroQueries,
        totalSearches,
        totalClicks,
        topClicked,
        aiSearches,
      ] = await Promise.all([
        prisma.searchEvent.groupBy({
          by: ['queryNormNoAccents'],
          where: whereEvents,
          _count: { id: true },
          _avg: { resultCount: true },
          _sum: { clickCount: true },
          orderBy: { _count: { id: 'desc' } },
          take: 100,
        }),
        prisma.searchEvent.groupBy({
          by: ['queryNormNoAccents'],
          where: { ...(whereEvents || {}), resultCount: 0 },
          _count: { id: true },
          orderBy: { _count: { id: 'desc' } },
          take: 30,
        }),
        prisma.searchEvent.count({ where: whereEvents }),
        prisma.searchClick.count({ where: whereClicks }),
        prisma.searchClick.groupBy({
          by: ['assetId'],
          where: whereClicks,
          _count: { id: true },
          orderBy: { _count: { id: 'desc' } },
          take: 30,
        }),
        // AI search counts per query
        prisma.searchEvent.groupBy({
          by: ['queryNormNoAccents'],
          where: { ...(whereEvents || {}), isAiSearch: true },
          _count: { id: true },
          orderBy: { _count: { id: 'desc' } },
          take: 60,
        }),
      ])

      const zeroMap = new Map((zeroQueries || []).map((z) => [z.queryNormNoAccents, z._count?.id || 0]))

      const aiMap = new Map((aiSearches || []).map((a) => [a.queryNormNoAccents, a._count?.id || 0]))

      const topQueriesOut = (topQueries || []).map((r) => ({
        query: r.queryNormNoAccents,
        count: r._count?.id || 0,
        zeroCount: zeroMap.get(r.queryNormNoAccents) || 0,
        avgResults: r._avg?.resultCount != null ? Math.round(Number(r._avg.resultCount) * 10) / 10 : 0,
        clicks: r._sum?.clickCount || 0,
        aiCount: aiMap.get(r.queryNormNoAccents) || 0,
      }))

      const zeroQueriesOut = (zeroQueries || []).map((r) => ({
        query: r.queryNormNoAccents,
        count: r._count?.id || 0,
      }))

      const assetIds = (topClicked || []).map((r) => r.assetId)
      const assets = assetIds.length
        ? await prisma.asset.findMany({ where: { id: { in: assetIds } }, select: { id: true, title: true, slug: true } })
        : []
      const assetMap = new Map(assets.map((a) => [a.id, a]))

      const topClickedAssets = (topClicked || []).map((r) => ({
        assetId: r.assetId,
        title: assetMap.get(r.assetId)?.title || `#${r.assetId}`,
        slug: assetMap.get(r.assetId)?.slug || null,
        count: r._count?.id || 0,
      }))

      const totalAiSearches = aiSearches.reduce((sum, a) => sum + (a._count?.id || 0), 0)

      return {
        totals: { searches: totalSearches, clicks: totalClicks, aiSearches: totalAiSearches },
        topQueries: topQueriesOut,
        zeroQueries: zeroQueriesOut,
        topClickedAssets,
      }
    }

    const out = {}
    for (const [k, gte] of Object.entries(ranges)) {
      // eslint-disable-next-line no-await-in-loop
      out[k] = await buildFor(gte)
    }

    out['1d'] = out['hoy']
    out['1w'] = out['7d']

    return res.json(out)
  } catch (e) {
    console.error('getSearchInsights error', e)
    return res.status(500).json({ error: 'internal' })
  }
}

export async function getRecentSearches(req, res) {
  try {
    const limit = Math.min(Math.max(1, Number(req.query?.limit) || 50), 100)

    const rows = await prisma.searchEvent.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        queryOriginal: true,
        resultCount: true,
        isAiSearch: true,
        clickCount: true,
        createdAt: true,
        userId: true,
      },
    })

    // Resolve user emails for rows that have a userId
    const userIds = [...new Set(rows.filter((r) => r.userId).map((r) => r.userId))]
    const users = userIds.length
      ? await prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, email: true, isActive: true },
        })
      : []
    const userMap = new Map(users.map((u) => [u.id, u]))

    const data = rows.map((r) => {
      const user = r.userId ? userMap.get(r.userId) : null
      return {
        id: r.id,
        query: r.queryOriginal,
        resultCount: r.resultCount,
        isAiSearch: r.isAiSearch,
        clickCount: r.clickCount || 0,
        createdAt: r.createdAt,
        userId: r.userId || null,
        userEmail: user?.email || null,
        userActive: user?.isActive ?? null,
      }
    })

    return res.json({ data })
  } catch (e) {
    console.error('getRecentSearches error', e)
    return res.status(500).json({ error: 'internal' })
  }
}

export async function getTopSearchQueries(req, res) {
  try {
    const limit = Math.min(Math.max(1, Number(req.query?.limit) || 300), 500)
    const minCount = Math.max(1, Number(req.query?.minCount) || 2)

    const rows = await prisma.searchEvent.groupBy({
      by: ['queryNormNoAccents'],
      _count: { id: true },
      having: { id: { _count: { gte: minCount } } },
      orderBy: { _count: { id: 'desc' } },
      take: limit,
    })

    const queries = (rows || []).map((r) => ({
      query: r.queryNormNoAccents,
      count: r._count?.id || 0,
    }))

    return res.json({ queries })
  } catch (e) {
    console.error('getTopSearchQueries error', e)
    return res.status(500).json({ error: 'internal' })
  }
}

export async function getTaxonomyCounts(req, res) {
  try {
    const [categoriesRaw, tagsRaw] = await Promise.all([
      prisma.category.findMany({
        orderBy: { name: 'asc' },
        select: {
          id: true,
          name: true,
          _count: { select: { assets: true } },
        },
      }),
      prisma.tag.findMany({
        orderBy: { name: 'asc' },
        select: {
          id: true,
          name: true,
          _count: { select: { assets: true } },
        },
      }),
    ])

    const categories = (categoriesRaw || []).map((c) => ({
      id: c.id,
      name: c.name,
      count: c?._count?.assets ?? 0,
    }))

    const tags = (tagsRaw || []).map((t) => ({
      id: t.id,
      name: t.name,
      count: t?._count?.assets ?? 0,
    }))

    return res.json({ categories, tags })
  } catch (e) {
    console.error('getTaxonomyCounts error', e)
    return res.status(500).json({ error: 'internal' })
  }
}

export async function recordSiteVisit(req, res) {
  try {
    const userAgent = req.headers['user-agent'] || ''
    const botPattern = /bot|googlebot|crawler|spider|robot|crawling|curl|wget|slurp|facebookexternalhit|whatsapp|bingbot|yandex|baiduspider/i

    if (botPattern.test(userAgent)) {
      return res.status(200).json({ ok: true, ignored: true, reason: 'bot_detected' })
    }

    if (!isTrackingOriginAllowed(req)) {
      return res.status(200).json({ ok: true, ignored: true, reason: 'invalid_origin' })
    }

    const pathRaw = String(req.body?.path || '').trim()
    const path = pathRaw.split('?')[0].split('#')[0].substring(0, 255)
    if (!path || !path.startsWith('/')) {
      return res.status(200).json({ ok: true, ignored: true, reason: 'invalid_path' })
    }

    const pathNoLocale = path.replace(/^\/(en|es)(?=\/|$)/i, '') || '/'
    if (pathNoLocale.startsWith('/dashboard') || pathNoLocale.startsWith('/api') || pathNoLocale.startsWith('/_next')) {
      return res.status(200).json({ ok: true, ignored: true, reason: 'excluded_path' })
    }

    const sessionId = String(req.body?.sessionId || '').trim().substring(0, 128) || null
    const visitorId = String(req.body?.visitorId || '').trim().substring(0, 128) || null
    if (!sessionId && !visitorId) {
      return res.status(200).json({ ok: true, ignored: true, reason: 'missing_identity' })
    }

    const ip = extractClientIp(req)
    const ipHash = hashIpAddress(ip)

    const nowMs = Date.now()
    cleanupSiteVisitGuard(nowMs)

    const rateLimitKey = ipHash || sessionId || visitorId || null
    if (isIpRateLimited(rateLimitKey, nowMs)) {
      return res.status(200).json({ ok: true, ignored: true, reason: 'rate_limited' })
    }

    const identityKey = sessionId || visitorId || ipHash || 'anonymous'
    const dedupeKey = `${identityKey}|${path}`
    if (isDuplicateSiteVisit(dedupeKey, nowMs)) {
      return res.status(200).json({ ok: true, ignored: true, reason: 'duplicate_window' })
    }

    await prisma.siteVisit.create({
      data: {
        userAgent: userAgent.substring(0, 500),
        ipHash,
        path,
        sessionId,
        visitorId
      }
    })

    return res.status(201).json({ ok: true })
  } catch (e) {
    console.error('recordSiteVisit error', e)
    return res.status(200).json({ ok: false })
  }
}

export async function getSiteVisitsMetrics(req, res) {
  try {
    const now = new Date()
    
    // Colombia is UTC-5. Get start of today in UTC-5
    const utc5Date = new Date(now.getTime() - 5 * 60 * 60 * 1000)
    utc5Date.setUTCHours(0, 0, 0, 0)
    const todayStartUtc5 = new Date(utc5Date.getTime() + 5 * 60 * 60 * 1000)

    const thirtyMinAgo = new Date(now.getTime() - 30 * 60 * 1000)
    const oneHourAgo = new Date(now.getTime() - 1 * 60 * 60 * 1000)
    const threeHoursAgo = new Date(now.getTime() - 3 * 60 * 60 * 1000)
    const sixHoursAgo = new Date(now.getTime() - 6 * 60 * 60 * 1000)
    const twelveHoursAgo = new Date(now.getTime() - 12 * 60 * 60 * 1000)
    
    const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000)
    const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000)
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
    const fifteenDaysAgo = new Date(now.getTime() - 15 * 24 * 60 * 60 * 1000)
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
    const threeSixtyFiveDaysAgo = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000)

    const getStats = async (gte) => {
      let result;
      if (gte) {
        result = await prisma.$queryRaw`SELECT COUNT(*) as pv, COUNT(DISTINCT sessionId) as sessions, COUNT(DISTINCT visitorId) as visitors FROM sitevisit WHERE createdAt >= ${gte}`;
      } else {
        result = await prisma.$queryRaw`SELECT COUNT(*) as pv, COUNT(DISTINCT sessionId) as sessions, COUNT(DISTINCT visitorId) as visitors FROM sitevisit`;
      }
      const row = result?.[0] || {};
      return {
        pv: Number(row.pv || 0),
        sessions: Number(row.sessions || 0),
        visitors: Number(row.visitors || 0)
      };
    };

    const getDownloads = async (gte) => {
      let result;
      if (gte) {
        result = await prisma.$queryRaw`SELECT COUNT(*) as cnt FROM downloadhistory WHERE downloadedAt >= ${gte}`;
      } else {
        result = await prisma.$queryRaw`SELECT COUNT(*) as cnt FROM downloadhistory`;
      }
      return Number(result?.[0]?.cnt || 0);
    };

    const [
      m30, h1, h3, h6, h12, hoy, d2, d3, d7, d15, m1, y1, all,
      dl30m, dl1h, dl3h, dl6h, dl12h, dlHoy, dl2d, dl3d, dl7d, dl15d, dl1m, dl1y, dlAll
    ] = await Promise.all([
      getStats(thirtyMinAgo),
      getStats(oneHourAgo),
      getStats(threeHoursAgo),
      getStats(sixHoursAgo),
      getStats(twelveHoursAgo),
      getStats(todayStartUtc5),
      getStats(twoDaysAgo),
      getStats(threeDaysAgo),
      getStats(sevenDaysAgo),
      getStats(fifteenDaysAgo),
      getStats(thirtyDaysAgo),
      getStats(threeSixtyFiveDaysAgo),
      getStats(null),
      getDownloads(thirtyMinAgo),
      getDownloads(oneHourAgo),
      getDownloads(threeHoursAgo),
      getDownloads(sixHoursAgo),
      getDownloads(twelveHoursAgo),
      getDownloads(todayStartUtc5),
      getDownloads(twoDaysAgo),
      getDownloads(threeDaysAgo),
      getDownloads(sevenDaysAgo),
      getDownloads(fifteenDaysAgo),
      getDownloads(thirtyDaysAgo),
      getDownloads(threeSixtyFiveDaysAgo),
      getDownloads(null),
    ]);

    const pvMap = { '30m': m30.pv, '1h': h1.pv, '3h': h3.pv, '6h': h6.pv, '12h': h12.pv, 'hoy': hoy.pv, '2d': d2.pv, '3d': d3.pv, '7d': d7.pv, '15d': d15.pv, '1m': m1.pv, '1y': y1.pv, all: all.pv }
    const sessionMap = { '30m': m30.sessions, '1h': h1.sessions, '3h': h3.sessions, '6h': h6.sessions, '12h': h12.sessions, 'hoy': hoy.sessions, '2d': d2.sessions, '3d': d3.sessions, '7d': d7.sessions, '15d': d15.sessions, '1m': m1.sessions, '1y': y1.sessions, all: all.sessions }
    const visitorMap = { '30m': m30.visitors, '1h': h1.visitors, '3h': h3.visitors, '6h': h6.visitors, '12h': h12.visitors, 'hoy': hoy.visitors, '2d': d2.visitors, '3d': d3.visitors, '7d': d7.visitors, '15d': d15.visitors, '1m': m1.visitors, '1y': y1.visitors, all: all.visitors }
    const downloadsMap = { '30m': dl30m, '1h': dl1h, '3h': dl3h, '6h': dl6h, '12h': dl12h, 'hoy': dlHoy, '2d': dl2d, '3d': dl3d, '7d': dl7d, '15d': dl15d, '1m': dl1m, '1y': dl1y, all: dlAll }

    // Backward compatibility aliases for dashboard widgets
    pvMap['1d'] = pvMap['hoy']
    pvMap['1w'] = pvMap['7d']
    
    sessionMap['1d'] = sessionMap['hoy']
    sessionMap['1w'] = sessionMap['7d']

    visitorMap['1d'] = visitorMap['hoy']
    visitorMap['1w'] = visitorMap['7d']

    downloadsMap['1d'] = downloadsMap['hoy']
    downloadsMap['1w'] = downloadsMap['7d']

    return res.json({
      pv: pvMap,
      sessions: sessionMap,
      visitors: visitorMap,
      downloads: downloadsMap,
    })
  } catch (e) {
    console.error('getSiteVisitsMetrics error', e)
    return res.status(500).json({ error: 'internal' })
  }
}

export async function getSiteVisitsTimeseries(req, res) {
  try {
    const fromRaw = String(req.query.from || '').trim()
    const toRaw = String(req.query.to || '').trim()

    const { fromDate: fromDateRaw, toDate } = buildDateRangeUtc5(fromRaw, toRaw, 30)
    let fromDate = new Date(fromDateRaw)

    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
      return res.status(400).json({ error: 'invalid-dates' })
    }

    if (toDate.getTime() < fromDate.getTime()) {
      return res.status(400).json({ error: 'invalid-range' })
    }

    const diffMs = toDate.getTime() - fromDate.getTime()
    const diffDays = diffMs / (24 * 60 * 60 * 1000)

    let granularity, dateExpr, dateFormat
    if (diffDays <= 1) {
      granularity = 'hour'
      dateExpr = "DATE_FORMAT(DATE_SUB(createdAt, INTERVAL 5 HOUR), '%Y-%m-%d %H:00:00')"
      dateFormat = '%Y-%m-%d %H:00'
    } else if (diffDays <= 20) {
      granularity = 'day'
      dateExpr = 'DATE(DATE_SUB(createdAt, INTERVAL 5 HOUR))'
      dateFormat = '%Y-%m-%d'
    } else if (diffDays <= 100) {
      granularity = 'week'
      dateExpr = "DATE(DATE_SUB(DATE_SUB(createdAt, INTERVAL 5 HOUR), INTERVAL WEEKDAY(DATE_SUB(createdAt, INTERVAL 5 HOUR)) DAY))"
      dateFormat = '%Y-%m-%d'
    } else {
      granularity = 'month'
      dateExpr = "DATE_FORMAT(DATE_SUB(createdAt, INTERVAL 5 HOUR), '%Y-%m-01')"
      dateFormat = '%Y-%m-01'
    }

    if (granularity === 'week') {
      const day = fromDate.getDay();
      const diff = fromDate.getDate() - day + (day === 0 ? -6 : 1); // Lunes
      fromDate.setDate(diff);
      fromDate.setHours(0, 0, 0, 0);
    } else if (granularity === 'month') {
      fromDate.setDate(1);
      fromDate.setHours(0, 0, 0, 0);
    }

    const query = `
      SELECT ${dateExpr} as bucket,
             COUNT(*) as pv,
             COUNT(DISTINCT sessionId) as sessions,
             COUNT(DISTINCT visitorId) as visitors
      FROM sitevisit
      WHERE createdAt >= ? AND createdAt <= ?
      GROUP BY bucket
      ORDER BY bucket ASC
    `

    const rows = await prisma.$queryRawUnsafe(query, fromDate, toDate)

    const series = (rows || []).map((r) => ({
      date: r.bucket instanceof Date ? r.bucket.toISOString().slice(0, granularity === 'hour' ? 16 : 10) : String(r.bucket || '').slice(0, granularity === 'hour' ? 16 : 10),
      pv: Number(r.pv || 0),
      sessions: Number(r.sessions || 0),
      visitors: Number(r.visitors || 0),
    }))

    return res.json({
      from: formatDateInUtc5(fromDate),
      to: formatDateInUtc5(toDate),
      granularity,
      series,
    })
  } catch (e) {
    console.error('getSiteVisitsTimeseries error', e)
    return res.status(500).json({ error: 'internal' })
  }
}

export async function getTopPages(req, res) {
  try {
    const fromRaw = String(req.query.from || '').trim()
    const toRaw = String(req.query.to || '').trim()

    const { fromDate, toDate } = buildDateRangeUtc5(fromRaw, toRaw, 30)

    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
      return res.status(400).json({ error: 'invalid-dates' })
    }

    if (toDate.getTime() < fromDate.getTime()) {
      return res.status(400).json({ error: 'invalid-range' })
    }

    const rows = await prisma.$queryRawUnsafe(
      `SELECT path, COUNT(*) as cnt
       FROM sitevisit
       WHERE createdAt >= ? AND createdAt <= ? AND path IS NOT NULL AND path != ''
       GROUP BY path
       ORDER BY cnt DESC
       LIMIT 150`,
      fromDate,
      toDate
    )

    let pages = (rows || []).map((r) => ({
      path: String(r.path || '/'),
      count: Number(r.cnt || 0),
    }))

    // Filter out common non-content routes (ignoring locale prefixes)
    pages = pages.filter(p => {
      const cleanPath = p.path.replace(/^\/(en|es)/i, '')
      const ignored = ['/', '', '/search', '/login', '/register', '/suscripcion', '/account', '/dashboard']
      return !ignored.includes(cleanPath)
    }).slice(0, 50)

    return res.json({
      from: formatDateInUtc5(fromDate),
      to: formatDateInUtc5(toDate),
      pages,
    })
  } catch (e) {
    console.error('getTopPages error', e)
    return res.status(500).json({ error: 'internal' })
  }
}

export async function recordPlanClick(req, res) {
  try {
    const planId = String(req.body?.planId || '').trim().slice(0, 10)
    if (!planId) return res.status(200).json({ ok: true, ignored: true })

    const userId = getUserIdFromAuthHeader(req)

    await prisma.planClickEvent.create({
      data: {
        planId,
        userId: userId || null,
      },
      select: { id: true },
    })

    return res.status(201).json({ ok: true })
  } catch (e) {
    console.error('recordPlanClick error', e)
    return res.status(200).json({ ok: false })
  }
}

export async function getPlanClickTimeseries(req, res) {
  try {
    const now = new Date()
    const fromRaw = String(req.query.from || '').trim()
    const toRaw = String(req.query.to || '').trim()

    const toDate = toRaw ? new Date(`${toRaw}T23:59:59`) : now
    const fromDate = fromRaw ? new Date(`${fromRaw}T00:00:00`) : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)

    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
      return res.status(400).json({ error: 'invalid-dates' })
    }

    const diffMs = toDate.getTime() - fromDate.getTime()
    const diffDays = diffMs / (24 * 60 * 60 * 1000)

    let granularity, dateExpr
    if (diffDays <= 1) {
      granularity = 'hour'
      dateExpr = "DATE_FORMAT(DATE_SUB(createdAt, INTERVAL 5 HOUR), '%Y-%m-%d %H:00:00')"
    } else if (diffDays <= 20) {
      granularity = 'day'
      dateExpr = 'DATE(DATE_SUB(createdAt, INTERVAL 5 HOUR))'
    } else if (diffDays <= 100) {
      granularity = 'week'
      dateExpr = "DATE(DATE_SUB(DATE_SUB(createdAt, INTERVAL 5 HOUR), INTERVAL WEEKDAY(DATE_SUB(createdAt, INTERVAL 5 HOUR)) DAY))"
    } else {
      granularity = 'month'
      dateExpr = "DATE_FORMAT(DATE_SUB(createdAt, INTERVAL 5 HOUR), '%Y-%m-01')"
    }

    if (granularity === 'week') {
      const day = fromDate.getDay();
      const diff = fromDate.getDate() - day + (day === 0 ? -6 : 1); // Lunes
      fromDate.setDate(diff);
      fromDate.setHours(0, 0, 0, 0);
    } else if (granularity === 'month') {
      fromDate.setDate(1);
      fromDate.setHours(0, 0, 0, 0);
    }

    const query = `
      SELECT ${dateExpr} as bucket,
             planId,
             COUNT(*) as cnt
      FROM planclickevent
      WHERE createdAt >= ? AND createdAt <= ?
      GROUP BY bucket, planId
      ORDER BY bucket ASC
    `

    const rows = await prisma.$queryRawUnsafe(query, fromDate, toDate)

    // Build series: one entry per bucket with counts per plan
    const bucketMap = new Map()
    for (const r of (rows || [])) {
      const dateKey = r.bucket instanceof Date
        ? r.bucket.toISOString().slice(0, granularity === 'hour' ? 16 : 10)
        : String(r.bucket || '').slice(0, granularity === 'hour' ? 16 : 10)
      if (!bucketMap.has(dateKey)) {
        bucketMap.set(dateKey, { date: dateKey, '1m': 0, '3m': 0, '6m': 0, '12m': 0, total: 0 })
      }
      const entry = bucketMap.get(dateKey)
      const plan = String(r.planId || '')
      const cnt = Number(r.cnt || 0)
      if (entry[plan] !== undefined) entry[plan] += cnt
      entry.total += cnt
    }

    const series = Array.from(bucketMap.values())

    return res.json({
      from: fromDate.toISOString().slice(0, 10),
      to: toDate.toISOString().slice(0, 10),
      granularity,
      series,
    })
  } catch (e) {
    console.error('getPlanClickTimeseries error', e)
    return res.status(500).json({ error: 'internal' })
  }
}

export async function getRegistrationTimeseries(req, res) {
  try {
    const now = new Date()
    const fromRaw = String(req.query.from || '').trim()
    const toRaw = String(req.query.to || '').trim()

    const toDate = toRaw ? new Date(`${toRaw}T23:59:59`) : now
    const fromDate = fromRaw ? new Date(`${fromRaw}T00:00:00`) : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)

    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
      return res.status(400).json({ error: 'invalid-dates' })
    }

    const diffMs = toDate.getTime() - fromDate.getTime()
    const diffDays = diffMs / (24 * 60 * 60 * 1000)

    let granularity, dateExpr
    if (diffDays <= 1) {
      granularity = 'hour'
      dateExpr = "DATE_FORMAT(DATE_SUB(createdAt, INTERVAL 5 HOUR), '%Y-%m-%d %H:00:00')"
    } else if (diffDays <= 20) {
      granularity = 'day'
      dateExpr = 'DATE(DATE_SUB(createdAt, INTERVAL 5 HOUR))'
    } else if (diffDays <= 100) {
      granularity = 'week'
      dateExpr = "DATE(DATE_SUB(DATE_SUB(createdAt, INTERVAL 5 HOUR), INTERVAL WEEKDAY(DATE_SUB(createdAt, INTERVAL 5 HOUR)) DAY))"
    } else {
      granularity = 'month'
      dateExpr = "DATE_FORMAT(DATE_SUB(createdAt, INTERVAL 5 HOUR), '%Y-%m-01')"
    }

    if (granularity === 'week') {
      const day = fromDate.getDay();
      const diff = fromDate.getDate() - day + (day === 0 ? -6 : 1); // Lunes
      fromDate.setDate(diff);
      fromDate.setHours(0, 0, 0, 0);
    } else if (granularity === 'month') {
      fromDate.setDate(1);
      fromDate.setHours(0, 0, 0, 0);
    }

    const query = `
      SELECT ${dateExpr} as bucket,
             COUNT(*) as cnt
      FROM user
      WHERE createdAt >= ? AND createdAt <= ?
      GROUP BY bucket
      ORDER BY bucket ASC
    `

    const rows = await prisma.$queryRawUnsafe(query, fromDate, toDate)

    const series = (rows || []).map((r) => ({
      date: r.bucket instanceof Date ? r.bucket.toISOString().slice(0, granularity === 'hour' ? 16 : 10) : String(r.bucket || '').slice(0, granularity === 'hour' ? 16 : 10),
      count: Number(r.cnt || 0),
    }))

    return res.json({
      from: fromDate.toISOString().slice(0, 10),
      to: toDate.toISOString().slice(0, 10),
      granularity,
      series,
    })
  } catch (e) {
    console.error('getRegistrationTimeseries error', e)
    return res.status(500).json({ error: 'internal' })
  }
}

export async function getRecentDownloads(req, res) {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 100)

    const downloads = await prisma.downloadHistory.findMany({
      orderBy: { downloadedAt: 'desc' },
      take: limit
    })

    const userIds = [...new Set(downloads.map(d => d.userId).filter(Boolean))]
    const users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, email: true, isActive: true }
    })
    const userMap = {}
    users.forEach(u => { userMap[u.id] = u })

    const assetIds = [...new Set(downloads.map(d => d.assetId).filter(Boolean))]
    const assets = await prisma.asset.findMany({
      where: { id: { in: assetIds } },
      select: { id: true, title: true, slug: true }
    })
    const assetMap = {}
    assets.forEach(a => { assetMap[a.id] = a })

    const formatted = downloads.map(d => {
      const u = userMap[d.userId] || {}
      const a = assetMap[d.assetId] || {}
      return {
        id: d.id,
        downloadedAt: d.downloadedAt,
        assetId: a.id || d.assetId,
        assetTitle: a.title || d.assetTitle || `#${d.assetId}`,
        assetSlug: a.slug || null,
        userId: u.id || d.userId,
        userEmail: u.email || `Usuario #${d.userId || 'Desconocido'}`,
        userActive: u.isActive ?? true
      }
    })

    return res.json({ data: formatted })
  } catch (e) {
    console.error('getRecentDownloads error', e)
    return res.status(500).json({ error: 'internal' })
  }
}

export async function getDownloadsTimeseries(req, res) {
  try {
    const now = new Date()
    const fromRaw = String(req.query.from || '').trim()
    const toRaw = String(req.query.to || '').trim()

    const toDate = toRaw ? new Date(`${toRaw}T23:59:59`) : now
    const fromDate = fromRaw ? new Date(`${fromRaw}T00:00:00`) : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)

    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
      return res.status(400).json({ error: 'invalid-dates' })
    }

    const diffMs = toDate.getTime() - fromDate.getTime()
    const diffDays = diffMs / (24 * 60 * 60 * 1000)

    let granularity, dateExpr
    if (diffDays <= 1) {
      granularity = 'hour'
      dateExpr = "DATE_FORMAT(DATE_SUB(downloadedAt, INTERVAL 5 HOUR), '%Y-%m-%d %H:00:00')"
    } else if (diffDays <= 20) {
      granularity = 'day'
      dateExpr = 'DATE(DATE_SUB(downloadedAt, INTERVAL 5 HOUR))'
    } else if (diffDays <= 100) {
      granularity = 'week'
      dateExpr = "DATE(DATE_SUB(DATE_SUB(downloadedAt, INTERVAL 5 HOUR), INTERVAL WEEKDAY(DATE_SUB(downloadedAt, INTERVAL 5 HOUR)) DAY))"
    } else {
      granularity = 'month'
      dateExpr = "DATE_FORMAT(DATE_SUB(downloadedAt, INTERVAL 5 HOUR), '%Y-%m-01')"
    }

    if (granularity === 'week') {
      const day = fromDate.getDay();
      const diff = fromDate.getDate() - day + (day === 0 ? -6 : 1); // Lunes
      fromDate.setDate(diff);
      fromDate.setHours(0, 0, 0, 0);
    } else if (granularity === 'month') {
      fromDate.setDate(1);
      fromDate.setHours(0, 0, 0, 0);
    }

    const query = `
      SELECT ${dateExpr} as bucket,
             COUNT(*) as cnt
      FROM downloadhistory
      WHERE downloadedAt >= ? AND downloadedAt <= ?
      GROUP BY bucket
      ORDER BY bucket ASC
    `

    const rows = await prisma.$queryRawUnsafe(query, fromDate, toDate)

    const series = (rows || []).map((r) => ({
      date: r.bucket instanceof Date ? r.bucket.toISOString().slice(0, granularity === 'hour' ? 16 : 10) : String(r.bucket || '').slice(0, granularity === 'hour' ? 16 : 10),
      count: Number(r.cnt || 0),
    }))

    return res.json({
      from: fromDate.toISOString().slice(0, 10),
      to: toDate.toISOString().slice(0, 10),
      granularity,
      series,
    })
  } catch (e) {
    console.error('getDownloadsTimeseries error', e)
    return res.status(500).json({ error: 'internal' })
  }
}



