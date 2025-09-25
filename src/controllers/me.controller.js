import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export const getMyProfile = async (req, res) => {
  try {
    const userId = Number(req.user?.id);
    if (!userId) return res.status(403).json({ message: 'Forbidden' });

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, createdAt: true }
    });
    if (!user) return res.status(404).json({ message: 'User not found' });

    const lastSub = await prisma.subscription.findFirst({
      where: { userId },
      orderBy: { id: 'desc' },
      select: { id: true, status: true, currentPeriodEnd: true, startedAt: true }
    });

    const now = new Date();
    let status = 'EXPIRED';
    let currentPeriodEnd = null;
    let daysRemaining = 0;

    if (lastSub) {
      currentPeriodEnd = lastSub.currentPeriodEnd;
      const active = lastSub.status === 'ACTIVE' && currentPeriodEnd > now;
      status = active ? 'ACTIVE' : (lastSub.status === 'CANCELED' ? 'CANCELED' : 'EXPIRED');
      if (active) {
        const ms = currentPeriodEnd.getTime() - now.getTime();
        daysRemaining = Math.max(0, Math.ceil(ms / (1000 * 60 * 60 * 24)));
      }
    }

    return res.json({
      email: user.email,
      createdAt: user.createdAt,
      subscription: { status, currentPeriodEnd, daysRemaining }
    });
  } catch (e) {
    console.error('[ME] getMyProfile error:', e);
    return res.status(500).json({ message: 'Error getting profile' });
  }
};

export const getMyDownloads = async (req, res) => {
  try {
    const userId = Number(req.user?.id);
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    // Traer más de 20 para filtrar no disponibles y aún retornar 20
    const history = await prisma.downloadHistory.findMany({
      where: { userId },
      orderBy: { downloadedAt: 'desc' },
      take: 100,
      select: { assetId: true, downloadedAt: true }
    });

    const ids = Array.from(new Set(history.map(h => h.assetId)));
    if (!ids.length) return res.json([]);

    const assets = await prisma.asset.findMany({
      where: { id: { in: ids }, status: 'PUBLISHED' },
      select: { id: true, title: true, slug: true, images: true }
    });
    const assetMap = new Map(assets.map(a => [a.id, a]));

    const items = [];
    for (const h of history) {
      const a = assetMap.get(h.assetId);
      if (!a) continue;
      let thumb = null;
      try {
        const imgs = Array.isArray(a.images) ? a.images : (a.images ? JSON.parse(a.images) : []);
        thumb = imgs && imgs.length ? imgs[0] : null;
      } catch {}
      items.push({ id: a.id, title: a.title, slug: a.slug, image: thumb, downloadedAt: h.downloadedAt });
      if (items.length >= 20) break;
    }

    return res.json(items);
  } catch (e) {
    console.error('[ME] getMyDownloads error:', e);
    return res.status(500).json({ message: 'Error getting downloads' });
  }
};

export const getMyStats = async (req, res) => {
  try {
    const userId = Number(req.user?.id);
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const totalDownloads = await prisma.downloadHistory.count({ where: { userId } });

    // Tomar hasta 1000 entradas para estadísticas razonables
    const rows = await prisma.downloadHistory.findMany({
      where: { userId },
      select: { assetId: true },
      orderBy: { downloadedAt: 'desc' },
      take: 1000,
    });
    const assetIds = Array.from(new Set(rows.map(r => r.assetId)));
    let topCategories = [];
    if (assetIds.length) {
      const assets = await prisma.asset.findMany({
        where: { id: { in: assetIds } },
        select: { id: true, categories: { select: { id: true, name: true, nameEn: true, slug: true, slugEn: true } } }
      });
      const catByAsset = new Map(assets.map(a => [a.id, a.categories]));
      const counter = new Map();
      for (const r of rows) {
        const cats = catByAsset.get(r.assetId) || [];
        for (const c of cats) {
          const key = c.id;
          const prev = counter.get(key) || { count: 0, category: c };
          prev.count += 1;
          counter.set(key, prev);
        }
      }
      topCategories = Array.from(counter.values())
        .sort((a, b) => b.count - a.count)
        .slice(0, 5)
        .map(x => ({ id: x.category.id, name: x.category.name, nameEn: x.category.nameEn, slug: x.category.slug, slugEn: x.category.slugEn, count: x.count }));
    }

    return res.json({ totalDownloads, topCategories });
  } catch (e) {
    console.error('[ME] getMyStats error:', e);
    return res.status(500).json({ message: 'Error getting stats' });
  }
};

// extendMySubscriptionDays removido: ahora la UI abre el modal de planes
