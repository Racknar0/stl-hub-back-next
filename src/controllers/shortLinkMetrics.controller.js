import { PrismaClient } from '@prisma/client';

const DAY_MS = 86400000;
const prisma = new PrismaClient();

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * GET /api/metrics/short-links/timeseries?from=YYYY-MM-DD&to=YYYY-MM-DD (admin)
 * Clics de personas en los enlaces cortos por día (UTC, como la gráfica de tiradas), con el desglose por red.
 */
export function createShortLinkClicksTimeseriesHandler(database) {
  return async function getShortLinkClicksTimeseries(req, res) {
    const now = new Date();
    const to = String(req.query.to || now.toISOString().slice(0, 10));
    const from = String(req.query.from || new Date(now.getTime() - 14 * DAY_MS).toISOString().slice(0, 10));
    if (!validDate(from) || !validDate(to)) return res.status(400).json({ error: 'invalid-dates' });
    const start = Date.parse(`${from}T00:00:00Z`);
    const end = Date.parse(`${to}T00:00:00Z`);
    const days = (end - start) / DAY_MS + 1;
    if (days < 1 || days > 3660) return res.status(400).json({ error: 'invalid-range' });
    try {
      const rows = await database.shortLinkClick.findMany({
        where: { createdAt: { gte: new Date(start), lt: new Date(end + DAY_MS) } },
        select: { createdAt: true, source: true },
      });
      const byDay = new Map();
      for (const row of rows) {
        const date = row.createdAt.toISOString().slice(0, 10);
        const day = byDay.get(date) || { clicks: 0, bySource: {} };
        day.clicks += 1;
        day.bySource[row.source] = (day.bySource[row.source] || 0) + 1;
        byDay.set(date, day);
      }
      const series = [];
      for (let time = start; time <= end; time += DAY_MS) {
        const date = new Date(time).toISOString().slice(0, 10);
        const day = byDay.get(date);
        series.push({ date, clicks: day?.clicks || 0, bySource: day?.bySource || {} });
      }
      return res.json({ from, to, granularity: 'day', timezone: 'UTC', series });
    } catch (error) {
      console.error('getShortLinkClicksTimeseries error', error);
      return res.status(500).json({ error: 'internal' });
    }
  };
}

export const getShortLinkClicksTimeseries = createShortLinkClicksTimeseriesHandler(prisma);
