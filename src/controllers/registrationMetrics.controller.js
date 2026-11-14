const DAY_MS = 86400000;
const BOGOTA_OFFSET_MS = 5 * 3600000;

export const REGISTRATION_SOURCES = Object.freeze([
  ['google', 'Google'], ['pinterest', 'Pinterest'], ['tiktok', 'TikTok'],
  ['facebook', 'Facebook'], ['instagram', 'Instagram'], ['meta', 'Meta'], ['bing', 'Bing'],
  ['youtube', 'YouTube'], ['telegram', 'Telegram'], ['other', 'Otro'],
  ['direct', 'Directo'], ['unknown', 'Sin identificar'],
]);

const aliases = [
  ['google', /^(?:google|googleads|adwords)(?:$|[\s_.:/-])/],
  ['pinterest', /^(?:pinterest|pin)(?:$|[\s_.:/-])/],
  ['tiktok', /^(?:tiktok|tik-tok|tt)(?:$|[\s_.:/-])/],
  ['facebook', /^(?:facebook|fb)(?:$|[\s_.:/-])/],
  ['instagram', /^(?:instagram|insta|ig)(?:$|[\s_.:/-])/],
  ['bing', /^(?:bing|microsoftads|microsoft-ads)(?:$|[\s_.:/-])/],
  ['youtube', /^(?:youtube|youtu\.be|yt)(?:$|[\s_.:/-])/],
  ['telegram', /^(?:telegram|t\.me|tg)(?:$|[\s_.:/-])/],
];
const clean = value => String(value ?? '').trim().toLowerCase();
const isEmpty = value => !value || ['null', 'undefined', '(not set)', 'not set', '(none)', 'none', 'unknown'].includes(value);
const isDirect = value => ['direct', '(direct)', 'directo'].includes(value);

function referrerSource(value) {
  if (isDirect(value)) return 'direct';
  let host;
  try {
    const url = new URL(value.includes('://') ? value : `https://${value}`);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    host = url.hostname.toLowerCase().replace(/^www\./, '');
  } catch { return null; }
  if (!host.includes('.')) return null;
  const belongsTo = domain => host === domain || host.endsWith(`.${domain}`);
  if (belongsTo('stlgratis.com') || belongsTo('stl-hub.com') || host === 'localhost') return null;
  if (/^(?:[a-z0-9-]+\.)?google\.(?:com|[a-z]{2}|com\.[a-z]{2}|co\.[a-z]{2})$/.test(host)) return 'google';
  if (/^(?:[a-z0-9-]+\.)?pinterest\.(?:com|[a-z]{2}|com\.[a-z]{2}|co\.[a-z]{2})$/.test(host) || belongsTo('pin.it')) return 'pinterest';
  for (const [domain, source] of [
    ['tiktok.com', 'tiktok'], ['facebook.com', 'facebook'], ['fb.com', 'facebook'],
    ['instagram.com', 'instagram'], ['bing.com', 'bing'], ['youtube.com', 'youtube'],
    ['youtu.be', 'youtube'], ['telegram.org', 'telegram'], ['t.me', 'telegram'],
  ]) if (belongsTo(domain)) return source;
  return 'other';
}

/** Acquisition fields persisted on the user at registration, never current visits. */
export function classifyRegistrationSource(row) {
  const source = clean(row.utmSource);
  if (!isEmpty(source)) {
    if (isDirect(source)) return 'direct';
    for (const [key, pattern] of aliases) if (pattern.test(source)) return key;
    const domain = source.includes('.') ? referrerSource(source) : null;
    return domain || 'other';
  }
  const referrer = clean(row.utmReferrer);
  if (!isEmpty(referrer)) {
    const classified = referrerSource(referrer);
    if (classified) return classified;
  }
  // fbclid is shared by Meta properties; it cannot identify Facebook vs Instagram.
  for (const [field, key] of [['clickGclid', 'google'], ['clickTtclid', 'tiktok'], ['clickMsclkid', 'bing'], ['clickFbclid', 'meta']]) {
    if (!isEmpty(clean(row[field])) || row[`has${field[0].toUpperCase()}${field.slice(1)}`] === true || Number(row[`has${field[0].toUpperCase()}${field.slice(1)}`]) === 1) return key;
  }
  if (isDirect(clean(row.utmMedium))) return 'direct';
  return 'unknown';
}

const emptyChannels = () => Object.fromEntries(REGISTRATION_SOURCES.map(([key]) => [key, 0]));
const dayInBogota = date => new Date(date.getTime() - BOGOTA_OFFSET_MS).toISOString().slice(0, 10);
function legacyBucket(hour, granularity) {
  if (granularity === 'hour') return hour.slice(0, 16);
  const day = hour.slice(0, 10);
  if (granularity === 'day') return day;
  if (granularity === 'month') return `${day.slice(0, 7)}-01`;
  const monday = new Date(`${day}T00:00:00Z`);
  monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
  return monday.toISOString().slice(0, 10);
}

export function buildRegistrationSeries(rows, fromDate, toDate, granularity) {
  const sourceDays = new Map();
  const start = new Date(`${dayInBogota(fromDate)}T00:00:00Z`);
  const end = new Date(`${dayInBogota(toDate)}T00:00:00Z`);
  for (let current = start.getTime(); current <= end.getTime(); current += DAY_MS) {
    const date = new Date(current).toISOString().slice(0, 10);
    sourceDays.set(date, { date, channels: emptyChannels(), total: 0 });
  }
  const legacy = new Map();
  const totals = emptyChannels();
  for (const row of rows || []) {
    const hour = String(row.registrationHour || '');
    const date = hour.slice(0, 10);
    const count = Number(row.cnt || 0);
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:00:00$/.test(hour) || !Number.isSafeInteger(count) || count < 0 || !sourceDays.has(date)) throw new Error('Invalid registration aggregate');
    const key = classifyRegistrationSource(row);
    const daily = sourceDays.get(date);
    daily.channels[key] += count;
    daily.total += count;
    totals[key] += count;
    const bucket = legacyBucket(hour, granularity);
    legacy.set(bucket, (legacy.get(bucket) || 0) + count);
  }
  return {
    series: [...legacy].sort(([a], [b]) => a.localeCompare(b)).map(([date, count]) => ({ date, count })),
    sourceSeries: [...sourceDays.values()],
    sourceTotals: REGISTRATION_SOURCES.map(([source, label]) => ({ source, label, total: totals[source] })),
    total: Object.values(totals).reduce((sum, count) => sum + count, 0),
    timezone: 'America/Bogota',
  };
}

export function createRegistrationTimeseriesHandler(prisma, { now = () => new Date() } = {}) {
  return async (req, res) => {
    try {
      const current = now();
      const fromRaw = String(req.query.from || '').trim();
      const toRaw = String(req.query.to || '').trim();
      // Preserve the existing endpoint's boundaries and range expansion exactly.
      const toDate = toRaw ? new Date(`${toRaw}T23:59:59`) : current;
      const fromDate = fromRaw ? new Date(`${fromRaw}T00:00:00`) : new Date(current.getTime() - 30 * DAY_MS);
      if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime()) || fromDate > toDate) return res.status(400).json({ error: 'invalid-dates' });
      const diffDays = (toDate - fromDate) / DAY_MS;
      const granularity = diffDays <= 1 ? 'hour' : diffDays <= 20 ? 'day' : diffDays <= 100 ? 'week' : 'month';
      if (granularity === 'week') {
        const day = fromDate.getDay();
        fromDate.setDate(fromDate.getDate() - day + (day === 0 ? -6 : 1));
        fromDate.setHours(0, 0, 0, 0);
      } else if (granularity === 'month') {
        fromDate.setDate(1);
        fromDate.setHours(0, 0, 0, 0);
      }
      // One snapshot for total and attribution so every registration is counted once.
      // Click identifiers are grouped as booleans, not returned or exposed in the API.
      const rows = await prisma.$queryRawUnsafe(`
        SELECT DATE_FORMAT(DATE_SUB(createdAt, INTERVAL 5 HOUR), '%Y-%m-%d %H:00:00') AS registrationHour,
               utmSource, utmMedium, utmReferrer,
               (clickGclid IS NOT NULL AND TRIM(clickGclid) <> '') AS hasClickGclid,
               (clickFbclid IS NOT NULL AND TRIM(clickFbclid) <> '') AS hasClickFbclid,
               (clickTtclid IS NOT NULL AND TRIM(clickTtclid) <> '') AS hasClickTtclid,
               (clickMsclkid IS NOT NULL AND TRIM(clickMsclkid) <> '') AS hasClickMsclkid,
               COUNT(*) AS cnt
        FROM user
        WHERE createdAt >= ? AND createdAt <= ?
        GROUP BY registrationHour, utmSource, utmMedium, utmReferrer,
                 hasClickGclid, hasClickFbclid, hasClickTtclid, hasClickMsclkid
        ORDER BY registrationHour ASC
      `, fromDate, toDate);
      return res.json({ from: fromDate.toISOString().slice(0, 10), to: toDate.toISOString().slice(0, 10), granularity,
        ...buildRegistrationSeries(rows, fromDate, toDate, granularity) });
    } catch (error) {
      console.error('getRegistrationTimeseries error', error);
      return res.status(500).json({ error: 'internal' });
    }
  };
}
