import { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';

const prisma = new PrismaClient();

const SEARCH_EVENTS_MAX = Math.max(1000, Number(process.env.SEARCH_EVENTS_MAX || 200000) || 200000)
const SEARCH_EVENTS_RETENTION_DAYS = Math.max(7, Number(process.env.SEARCH_EVENTS_RETENTION_DAYS || 90) || 90)

const searchCleanupState = globalThis.__searchCleanupState || { lastRunMs: 0, calls: 0 }
globalThis.__searchCleanupState = searchCleanupState

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

export async function getRegistrationMetrics(req, res) {
  try {
    const now = new Date()
    const oneDayAgo = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000)
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
    const threeSixtyFiveDaysAgo = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000)

    const [d1, d7, d30, d365, total] = await Promise.all([
      prisma.user.count({ where: { createdAt: { gte: oneDayAgo } } }),
      prisma.user.count({ where: { createdAt: { gte: sevenDaysAgo } } }),
      prisma.user.count({ where: { createdAt: { gte: thirtyDaysAgo } } }),
      prisma.user.count({ where: { createdAt: { gte: threeSixtyFiveDaysAgo } } }),
      prisma.user.count(),
    ])

    return res.json({ '1d': d1, '1w': d7, '1m': d30, '1y': d365, all: total })
  } catch (e) {
    console.error('getRegistrationMetrics error', e)
    return res.status(500).json({ error: 'internal' })
  }
}

export async function getTopDownloads(req, res) {
  try {
    const now = new Date()
    const oneDayAgo = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000)
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
    const threeSixtyFiveDaysAgo = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000)

    const opts = (gte) => ({
      by: ['assetId', 'assetTitle'],
      where: gte ? { downloadedAt: { gte } } : undefined,
      _count: { id: true },
      orderBy: { _count: { id: 'desc' } },
      take: 30,
    })

    const [d1, d7, d30, d365, all] = await Promise.all([
      prisma.downloadHistory.groupBy(opts(oneDayAgo)),
      prisma.downloadHistory.groupBy(opts(sevenDaysAgo)),
      prisma.downloadHistory.groupBy(opts(thirtyDaysAgo)),
      prisma.downloadHistory.groupBy(opts(threeSixtyFiveDaysAgo)),
      prisma.downloadHistory.groupBy(opts(undefined)),
    ])

  const mapGroup = (arr) => arr.map(r => ({ name: r.assetTitle || `#${r.assetId}`, count: r._count?.id || 0 }))

    return res.json({ '1d': mapGroup(d1), '1w': mapGroup(d7), '1m': mapGroup(d30), '1y': mapGroup(d365), all: mapGroup(all) })
  } catch (e) {
    console.error('getTopDownloads error', e)
    return res.status(500).json({ error: 'internal' })
  }
}

export async function recordSearchEvent(req, res) {
  try {
    const { query, resultCount } = req.body || {}
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
      '1d': mk(1 * 24 * 60 * 60 * 1000),
      '1w': mk(7 * 24 * 60 * 60 * 1000),
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
      ] = await Promise.all([
        prisma.searchEvent.groupBy({
          by: ['queryNormNoAccents'],
          where: whereEvents,
          _count: { id: true },
          _avg: { resultCount: true },
          _sum: { clickCount: true },
          orderBy: { _count: { id: 'desc' } },
          take: 30,
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
      ])

      const zeroMap = new Map((zeroQueries || []).map((z) => [z.queryNormNoAccents, z._count?.id || 0]))

      const topQueriesOut = (topQueries || []).map((r) => ({
        query: r.queryNormNoAccents,
        count: r._count?.id || 0,
        zeroCount: zeroMap.get(r.queryNormNoAccents) || 0,
        avgResults: r._avg?.resultCount != null ? Math.round(Number(r._avg.resultCount) * 10) / 10 : 0,
        clicks: r._sum?.clickCount || 0,
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

      return {
        totals: { searches: totalSearches, clicks: totalClicks },
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

    return res.json(out)
  } catch (e) {
    console.error('getSearchInsights error', e)
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
