import { PrismaClient } from '@prisma/client';
import { toSlug } from '../utils/attribution.js';

const prisma = new PrismaClient();

const safeText = (value, max = 191) => {
  const v = String(value || '').trim();
  if (!v) return null;
  return v.slice(0, max);
};

const safePath = (value) => {
  const raw = String(value || '/').trim();
  if (!raw) return '/';
  return raw.startsWith('/') ? raw.slice(0, 255) : `/${raw.slice(0, 254)}`;
};

const buildTrackingUrl = (campaign) => {
  const frontUrl = String(process.env.FRONT_URL || 'https://stl-hub.com').replace(/\/$/, '');
  const path = safePath(campaign?.landingPath || '/');
  const params = new URLSearchParams();

  if (campaign?.source) params.set('utm_source', campaign.source);
  if (campaign?.medium) params.set('utm_medium', campaign.medium);
  if (campaign?.slug) params.set('utm_campaign', campaign.slug);
  if (campaign?.content) params.set('utm_content', campaign.content);
  if (campaign?.term) params.set('utm_term', campaign.term);

  const q = params.toString();
  return q ? `${frontUrl}${path}?${q}` : `${frontUrl}${path}`;
};

const buildCampaignWhere = (campaign) => {
  return {
    OR: [
      { marketingCampaignId: campaign.id },
      {
        AND: [
          { marketingCampaignId: null },
          { utmCampaign: campaign.slug },
        ],
      },
    ],
  };
};

export const listMarketingCampaigns = async (_req, res) => {
  try {
    const campaigns = await prisma.marketingCampaign.findMany({
      orderBy: { createdAt: 'desc' },
    });

    const items = await Promise.all(
      campaigns.map(async (campaign) => {
        const where = buildCampaignWhere(campaign);

        const [registrations, paymentAgg, latestPayment, visits, uniqueVisitorsRows] = await Promise.all([
          prisma.user.count({ where }),
          prisma.payment.aggregate({
            where: {
              ...where,
              status: 'COMPLETED',
            },
            _count: { id: true },
            _sum: { amount: true },
          }),
          prisma.payment.findFirst({
            where: {
              ...where,
              status: 'COMPLETED',
            },
            orderBy: { createdAt: 'desc' },
            select: { createdAt: true },
          }),
          prisma.marketingVisit.count({ where }),
          prisma.marketingVisit.groupBy({
            by: ['anonId'],
            where: {
              ...where,
              anonId: { not: null },
            },
          }),
        ]);

        return {
          ...campaign,
          trackingUrl: buildTrackingUrl(campaign),
          stats: {
            visits,
            uniqueVisitors: Array.isArray(uniqueVisitorsRows) ? uniqueVisitorsRows.length : 0,
            registrations,
            purchases: paymentAgg?._count?.id || 0,
            revenue: Number(paymentAgg?._sum?.amount || 0),
            lastPurchaseAt: latestPayment?.createdAt || null,
          },
        };
      })
    );

    return res.json({ items });
  } catch (e) {
    console.error('[MARKETING] list campaigns error:', e);
    return res.status(500).json({ message: 'Error listing campaigns' });
  }
};

export const createMarketingCampaign = async (req, res) => {
  try {
    const name = safeText(req.body?.name, 160);
    const source = safeText(req.body?.source);
    const medium = safeText(req.body?.medium);
    const content = safeText(req.body?.content);
    const term = safeText(req.body?.term);
    const notes = safeText(req.body?.notes, 2000);
    const landingPathRaw = safeText(req.body?.landingPath, 255);

    const slugCandidate = safeText(req.body?.slug || req.body?.utmCampaign || name, 160);

    const requiredMissing = [];
    if (!name) requiredMissing.push('name');
    if (!slugCandidate) requiredMissing.push('slug');
    if (!source) requiredMissing.push('source');
    if (!medium) requiredMissing.push('medium');
    if (!content) requiredMissing.push('content');
    if (!term) requiredMissing.push('term');
    if (!landingPathRaw) requiredMissing.push('landingPath');
    if (!notes) requiredMissing.push('notes');

    if (requiredMissing.length) {
      return res.status(400).json({
        message: `Campos obligatorios faltantes: ${requiredMissing.join(', ')}`,
      });
    }

    const slug = toSlug(slugCandidate);
    if (!slug) {
      return res.status(400).json({ message: 'slug invalido' });
    }

    const exists = await prisma.marketingCampaign.findUnique({
      where: { slug },
      select: { id: true },
    });

    if (exists) {
      return res.status(409).json({ message: 'Ya existe una campana con ese slug' });
    }

    const created = await prisma.marketingCampaign.create({
      data: {
        name,
        slug,
        source,
        medium,
        content,
        term,
        landingPath: safePath(landingPathRaw),
        notes,
        isActive: req.body?.isActive === undefined ? true : Boolean(req.body?.isActive),
      },
    });

    return res.status(201).json({
      item: {
        ...created,
        trackingUrl: buildTrackingUrl(created),
        stats: {
          visits: 0,
          uniqueVisitors: 0,
          registrations: 0,
          purchases: 0,
          revenue: 0,
          lastPurchaseAt: null,
        },
      },
    });
  } catch (e) {
    console.error('[MARKETING] create campaign error:', e);
    return res.status(500).json({ message: 'Error creating campaign' });
  }
};

export const updateMarketingCampaign = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ message: 'id invalido' });
    }

    const existing = await prisma.marketingCampaign.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ message: 'Campana no encontrada' });
    }

    const nextSlugRaw = req.body?.slug !== undefined
      ? req.body.slug
      : req.body?.utmCampaign !== undefined
        ? req.body.utmCampaign
        : existing.slug;
    const nextSlug = toSlug(nextSlugRaw);

    if (!nextSlug) {
      return res.status(400).json({ message: 'slug invalido' });
    }

    if (nextSlug !== existing.slug) {
      const slugTaken = await prisma.marketingCampaign.findUnique({ where: { slug: nextSlug }, select: { id: true } });
      if (slugTaken) {
        return res.status(409).json({ message: 'Ya existe una campana con ese slug' });
      }
    }

    const updated = await prisma.marketingCampaign.update({
      where: { id },
      data: {
        name: req.body?.name !== undefined ? safeText(req.body?.name, 160) : existing.name,
        slug: nextSlug,
        source: req.body?.source !== undefined ? safeText(req.body?.source) : existing.source,
        medium: req.body?.medium !== undefined ? safeText(req.body?.medium) : existing.medium,
        content: req.body?.content !== undefined ? safeText(req.body?.content) : existing.content,
        term: req.body?.term !== undefined ? safeText(req.body?.term) : existing.term,
        landingPath: req.body?.landingPath !== undefined ? safePath(req.body?.landingPath) : existing.landingPath,
        notes: req.body?.notes !== undefined ? safeText(req.body?.notes, 2000) : existing.notes,
        isActive: req.body?.isActive !== undefined ? Boolean(req.body?.isActive) : existing.isActive,
      },
    });

    return res.json({ item: { ...updated, trackingUrl: buildTrackingUrl(updated) } });
  } catch (e) {
    console.error('[MARKETING] update campaign error:', e);
    return res.status(500).json({ message: 'Error updating campaign' });
  }
};
