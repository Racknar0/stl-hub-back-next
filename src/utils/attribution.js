const MAX_TEXT = 191;
const MAX_URL = 512;
const TRACK_ANON_COOKIE = 'mkt_anon_id';
const TRACK_SESSION_COOKIE = 'mkt_session_id';
const TRACK_ATTR_FIRST_COOKIE = 'mkt_attr_first';
const TRACK_ATTR_LAST_COOKIE = 'mkt_attr_last';

const safeText = (value, max = MAX_TEXT) => {
  const v = String(value || '').trim();
  if (!v) return null;
  return v.slice(0, max);
};

const safeUrl = (value) => safeText(value, MAX_URL);

const parseIntId = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.trunc(n);
};

export const toSlug = (value) => {
  const raw = String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();

  return raw
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
};

export const extractTrackingFromBody = (body = {}) => {
  const source =
    body?.tracking && typeof body.tracking === 'object'
      ? body.tracking
      : body;

  const tracking = {
    marketingCampaignId: parseIntId(source?.marketingCampaignId || source?.campaignId),
    utmSource: safeText(source?.utmSource || source?.utm_source),
    utmMedium: safeText(source?.utmMedium || source?.utm_medium),
    utmCampaign: safeText(source?.utmCampaign || source?.utm_campaign || source?.campaignSlug),
    utmContent: safeText(source?.utmContent || source?.utm_content),
    utmTerm: safeText(source?.utmTerm || source?.utm_term),
    clickGclid: safeText(source?.clickGclid || source?.gclid),
    clickFbclid: safeText(source?.clickFbclid || source?.fbclid),
    clickTtclid: safeText(source?.clickTtclid || source?.ttclid),
    clickMsclkid: safeText(source?.clickMsclkid || source?.msclkid),
    landingUrl: safeUrl(source?.landingUrl || source?.utmLandingUrl),
    referrer: safeUrl(source?.referrer || source?.utmReferrer),
  };

  const hasData = Object.entries(tracking).some(([k, v]) => {
    if (k === 'marketingCampaignId') return Number.isFinite(v) && v > 0;
    return !!v;
  });

  return hasData ? tracking : null;
};

export const resolveMarketingCampaignId = async (prismaLike, tracking) => {
  if (!tracking) return null;

  const directId = parseIntId(tracking.marketingCampaignId);
  if (directId) {
    const exists = await prismaLike.marketingCampaign.findUnique({
      where: { id: directId },
      select: { id: true },
    });
    if (exists?.id) return exists.id;
  }

  const campaignRaw = safeText(tracking.utmCampaign || tracking.campaignSlug);
  if (!campaignRaw) return null;

  const campaignSlug = toSlug(campaignRaw);
  const bySlug = await prismaLike.marketingCampaign.findUnique({
    where: { slug: campaignSlug },
    select: { id: true },
  });

  return bySlug?.id || null;
};

export const pickTrackingForDb = (tracking) => {
  if (!tracking) return {};
  return {
    utmSource: tracking.utmSource || null,
    utmMedium: tracking.utmMedium || null,
    utmCampaign: tracking.utmCampaign ? toSlug(tracking.utmCampaign) : null,
    utmContent: tracking.utmContent || null,
    utmTerm: tracking.utmTerm || null,
    clickGclid: tracking.clickGclid || null,
    clickFbclid: tracking.clickFbclid || null,
    clickTtclid: tracking.clickTtclid || null,
    clickMsclkid: tracking.clickMsclkid || null,
    utmLandingUrl: tracking.landingUrl || null,
    utmReferrer: tracking.referrer || null,
  };
};

const parseCookieHeader = (cookieHeader) => {
  const source = String(cookieHeader || '').trim();
  if (!source) return {};

  return source.split(';').reduce((acc, part) => {
    const i = part.indexOf('=');
    if (i <= 0) return acc;
    const key = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (key) acc[key] = value;
    return acc;
  }, {});
};

const decodeTrackingCookie = (raw) => {
  const value = String(raw || '').trim();
  if (!value) return null;
  try {
    const decoded = decodeURIComponent(value);
    const parsed = JSON.parse(decoded);
    return extractTrackingFromBody(parsed);
  } catch {
    return null;
  }
};

const getTrackingFromCookies = (req, prefer = 'first') => {
  const cookies = parseCookieHeader(req?.headers?.cookie || '');
  const first = decodeTrackingCookie(cookies[TRACK_ATTR_FIRST_COOKIE]);
  const last = decodeTrackingCookie(cookies[TRACK_ATTR_LAST_COOKIE]);

  return prefer === 'last' ? (last || first) : (first || last);
};

export const extractTrackingFromRequest = (req, prefer = 'first') => {
  const fromCookies = getTrackingFromCookies(req, prefer);
  if (fromCookies) return fromCookies;
  return extractTrackingFromBody(req?.body || {});
};

export const extractVisitIdentityFromRequest = (req) => {
  const cookies = parseCookieHeader(req?.headers?.cookie || '');
  const anonId = safeText(cookies[TRACK_ANON_COOKIE], 120);
  const sessionId = safeText(cookies[TRACK_SESSION_COOKIE], 120);
  return { anonId, sessionId };
};
