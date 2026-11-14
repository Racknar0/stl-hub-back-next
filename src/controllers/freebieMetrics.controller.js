import { PrismaClient } from '@prisma/client';

const DAY_MS = 86400000;
const prisma = new PrismaClient();

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function createFreebieRollTimeseriesHandler(database) {
  return async function getFreebieRollTimeseries(req, res) {
    const now = new Date();
    const to = String(req.query.to || now.toISOString().slice(0, 10));
    const from = String(req.query.from || new Date(now.getTime() - 14 * DAY_MS).toISOString().slice(0, 10));
    if (!validDate(from) || !validDate(to)) return res.status(400).json({ error: 'invalid-dates' });
    const start = Date.parse(`${from}T00:00:00Z`);
    const end = Date.parse(`${to}T00:00:00Z`);
    const days = (end - start) / DAY_MS + 1;
    if (days < 1 || days > 3660) return res.status(400).json({ error: 'invalid-range' });
    try {
      const rows = await database.userDailyRolls.groupBy({
        by: ['date'],
        where: { date: { gte: from, lte: to }, rollsUsed: { gt: 0 } },
        _sum: { rollsUsed: true },
        _count: { _all: true },
        orderBy: { date: 'asc' },
      });
      const recorded = new Map(rows.map(row => [row.date, row]));
      const series = [];
      for (let time = start; time <= end; time += DAY_MS) {
        const date = new Date(time).toISOString().slice(0, 10);
        const row = recorded.get(date);
        series.push({ date, rolls: Number(row?._sum?.rollsUsed || 0), participants: Number(row?._count?._all || 0) });
      }
      return res.json({ from, to, granularity: 'day', timezone: 'UTC', series });
    } catch (error) {
      console.error('getFreebieRollTimeseries error', error);
      return res.status(500).json({ error: 'internal' });
    }
  };
}

export const getFreebieRollTimeseries = createFreebieRollTimeseriesHandler(prisma);
