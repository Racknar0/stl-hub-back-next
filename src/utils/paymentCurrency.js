const TARGET_CURRENCY = 'COP';
const FRANKFURTER_API_BASE = String(process.env.FRANKFURTER_API_BASE || 'https://api.frankfurter.dev').replace(/\/+$/, '');

const fxCache = globalThis.__stlHubFxCache || new Map();
globalThis.__stlHubFxCache = fxCache;

const toUpper = (value) => String(value || '').trim().toUpperCase();

const roundMoney = (value) => {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
};

const toIsoDate = (value) => {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
  return date.toISOString().slice(0, 10);
};

const parseRawResponse = (rawResponse) => {
  if (!rawResponse) return null;
  if (typeof rawResponse === 'object' && !Array.isArray(rawResponse)) return rawResponse;
  if (typeof rawResponse !== 'string') return null;
  try {
    const parsed = JSON.parse(rawResponse);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    return null;
  } catch {
    return null;
  }
};

const getFallbackRateToCop = (currency) => {
  const from = toUpper(currency);
  if (!from) return null;
  if (from === TARGET_CURRENCY) return 1;

  const explicit = Number(process.env[`FX_${from}_TO_COP_FALLBACK`] || 0);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;

  if (from === 'USD') {
    const usdFallback = Number(process.env.FX_USD_TO_COP_FALLBACK || process.env.USD_TO_COP || 4000);
    if (Number.isFinite(usdFallback) && usdFallback > 0) return usdFallback;
  }

  return null;
};

const getFallbackSource = (currency) => {
  const from = toUpper(currency);
  if (from === TARGET_CURRENCY) return 'identity';
  if (process.env[`FX_${from}_TO_COP_FALLBACK`]) return `env:FX_${from}_TO_COP_FALLBACK`;
  if (from === 'USD' && (process.env.FX_USD_TO_COP_FALLBACK || process.env.USD_TO_COP)) {
    return process.env.FX_USD_TO_COP_FALLBACK ? 'env:FX_USD_TO_COP_FALLBACK' : 'env:USD_TO_COP';
  }
  if (from === 'USD') return 'default:USD_TO_COP_4000';
  return 'fallback:none';
};

const getCachedRate = (cacheKey) => {
  const hit = fxCache.get(cacheKey);
  if (!hit) return null;
  if (!hit.expiresAt || hit.expiresAt < Date.now()) {
    fxCache.delete(cacheKey);
    return null;
  }
  return hit;
};

const setCachedRate = (cacheKey, rate, source) => {
  const ttlMs = Math.max(60_000, Number(process.env.FX_CACHE_TTL_MS || 6 * 60 * 60 * 1000) || 6 * 60 * 60 * 1000);
  fxCache.set(cacheKey, {
    rate,
    source,
    expiresAt: Date.now() + ttlMs,
  });
};

const fetchFrankfurterRateToCop = async (currency, paidAt) => {
  const from = toUpper(currency);
  if (!from || from === TARGET_CURRENCY) return { rate: 1, source: 'identity' };

  const dateKey = toIsoDate(paidAt);
  const cacheKey = `${from}->${TARGET_CURRENCY}@${dateKey}`;
  const cached = getCachedRate(cacheKey);
  if (cached) return { rate: cached.rate, source: cached.source };

  const timeoutMs = Math.max(800, Number(process.env.FX_HTTP_TIMEOUT_MS || 2500) || 2500);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const url = `${FRANKFURTER_API_BASE}/v2/rate/${encodeURIComponent(from)}/${TARGET_CURRENCY}?date=${encodeURIComponent(dateKey)}`;
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`fx-http-${response.status}`);
    }

    const payload = await response.json();
    const rate = Number(payload?.rate || 0);
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new Error('fx-invalid-rate');
    }

    const source = `frankfurter:${payload?.date || dateKey}`;
    setCachedRate(cacheKey, rate, source);
    return { rate, source };
  } finally {
    clearTimeout(timer);
  }
};

export const buildCopSnapshot = async ({ amount, currency, paidAt = new Date() } = {}) => {
  const originalAmount = Number(amount || 0);
  const originalCurrency = toUpper(currency) || 'USD';
  if (!Number.isFinite(originalAmount) || originalAmount <= 0) {
    return {
      targetCurrency: TARGET_CURRENCY,
      originalCurrency,
      originalAmount: 0,
      amountCop: 0,
      fxRateToCop: originalCurrency === TARGET_CURRENCY ? 1 : null,
      rateSource: originalCurrency === TARGET_CURRENCY ? 'identity' : 'fallback:none',
      rateDate: toIsoDate(paidAt),
      computedAt: new Date().toISOString(),
    };
  }

  if (originalCurrency === TARGET_CURRENCY) {
    return {
      targetCurrency: TARGET_CURRENCY,
      originalCurrency,
      originalAmount: roundMoney(originalAmount),
      amountCop: roundMoney(originalAmount),
      fxRateToCop: 1,
      rateSource: 'identity',
      rateDate: toIsoDate(paidAt),
      computedAt: new Date().toISOString(),
    };
  }

  let fxRateToCop = null;
  let rateSource = null;

  try {
    const live = await fetchFrankfurterRateToCop(originalCurrency, paidAt);
    fxRateToCop = Number(live?.rate || 0);
    rateSource = String(live?.source || 'frankfurter');
  } catch {
    fxRateToCop = getFallbackRateToCop(originalCurrency);
    rateSource = getFallbackSource(originalCurrency);
  }

  if (!Number.isFinite(fxRateToCop) || fxRateToCop <= 0) {
    fxRateToCop = null;
  }

  const amountCop = fxRateToCop
    ? roundMoney(originalAmount * fxRateToCop)
    : roundMoney(originalAmount);

  return {
    targetCurrency: TARGET_CURRENCY,
    originalCurrency,
    originalAmount: roundMoney(originalAmount),
    amountCop,
    fxRateToCop,
    rateSource,
    rateDate: toIsoDate(paidAt),
    computedAt: new Date().toISOString(),
  };
};

export const appendCopSnapshotToRawResponse = (rawResponse, snapshot) => {
  const parsed = parseRawResponse(rawResponse);
  const base = parsed ? { ...parsed } : { gatewayPayload: rawResponse ?? null };
  if (snapshot && typeof snapshot === 'object') {
    base.stlHubCurrency = snapshot;
  }
  return base;
};

export const getCopSnapshotFromRawResponse = (rawResponse) => {
  const parsed = parseRawResponse(rawResponse);
  if (!parsed) return null;

  const snapshot = parsed?.stlHubCurrency || parsed?.stlhubCurrency || parsed?.currencySnapshot;
  if (!snapshot || typeof snapshot !== 'object') return null;

  const amountCop = Number(snapshot.amountCop || 0);
  const fxRateToCop = Number(snapshot.fxRateToCop || 0);

  return {
    amountCop: Number.isFinite(amountCop) ? amountCop : null,
    fxRateToCop: Number.isFinite(fxRateToCop) && fxRateToCop > 0 ? fxRateToCop : null,
  };
};

export const toCopAmountFromPayment = (payment) => {
  const amount = Number(payment?.amount || 0);
  if (!Number.isFinite(amount) || amount <= 0) return 0;

  const currency = toUpper(payment?.currency) || 'USD';
  if (currency === TARGET_CURRENCY) return roundMoney(amount);

  const snapshot = getCopSnapshotFromRawResponse(payment?.rawResponse);
  if (snapshot?.amountCop != null && Number.isFinite(snapshot.amountCop) && snapshot.amountCop >= 0) {
    return roundMoney(snapshot.amountCop);
  }

  if (snapshot?.fxRateToCop != null && Number.isFinite(snapshot.fxRateToCop)) {
    return roundMoney(amount * snapshot.fxRateToCop);
  }

  const fallbackRate = getFallbackRateToCop(currency);
  if (fallbackRate && Number.isFinite(fallbackRate) && fallbackRate > 0) {
    return roundMoney(amount * fallbackRate);
  }

  return roundMoney(amount);
};

export const sumPaymentsInCop = (payments) => {
  const list = Array.isArray(payments) ? payments : [];
  return roundMoney(list.reduce((acc, payment) => acc + toCopAmountFromPayment(payment), 0));
};
