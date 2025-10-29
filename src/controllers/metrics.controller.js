import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function startOfDay(d) {
  const t = new Date(d)
  t.setHours(0,0,0,0)
  return t
}

export async function getUploadsMetrics(req, res) {
  try {
    const now = new Date()
    const todayStart = startOfDay(now)
    const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000)
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
    const threeSixtyFiveDaysAgo = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000)

    const [todayCount, last3dCount, last7dCount, last30dCount, last365dCount, totalCount] = await Promise.all([
      prisma.asset.count({ where: { createdAt: { gte: todayStart } } }),
      prisma.asset.count({ where: { createdAt: { gte: threeDaysAgo } } }),
      prisma.asset.count({ where: { createdAt: { gte: sevenDaysAgo } } }),
      prisma.asset.count({ where: { createdAt: { gte: thirtyDaysAgo } } }),
      prisma.asset.count({ where: { createdAt: { gte: threeSixtyFiveDaysAgo } } }),
      prisma.asset.count(),
    ])

    const data = {
        today: todayCount,
        last3d: last3dCount,
        lastWeek: last7dCount,
        month: last30dCount,
        lastYear: last365dCount,
        all: totalCount,
    }

    console.log('getUploadsMetrics data', data)

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
