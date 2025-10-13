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
