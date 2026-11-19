import { getLicenseService, LicenseError } from '../services/licenses.service.js';
import { createRateLimiter } from '../utils/rateLimiter.js';
import { getClientIp } from '../utils/geoip.js';

// Límites por IP de los endpoints públicos
const activateMinute = createRateLimiter({ windowMs: 60 * 1000, max: 10 });
const activateHour = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 50 });
const activateFailures = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 20 }); // seriales inválidos
const validateMinute = createRateLimiter({ windowMs: 60 * 1000, max: 30 });

export const resetLicenseRateLimits = () => {
  [activateMinute, activateHour, activateFailures, validateMinute].forEach(l => l.reset());
};

const tooMany = (res, retryAfterSec) => {
  res.set('Retry-After', String(Math.max(1, retryAfterSec)));
  return res.status(429).json({ error: 'rate_limited', message: 'Demasiados intentos, espera antes de reintentar' });
};

const sendError = (res, err) => {
  if (err instanceof LicenseError) return res.status(err.status).json({ error: err.code, message: err.message });
  console.error('[LICENSES]', err);
  return res.status(500).json({ error: 'internal_error', message: 'Error interno' });
};

// ─── Público ───────────────────────────────────────────────────────
export const activateLicense = async (req, res) => {
  const ip = getClientIp(req) || 'unknown';
  const failures = activateFailures.blocked(ip);
  if (failures.blocked) return tooMany(res, failures.retryAfterSec);
  const m = activateMinute.hit(ip);
  if (!m.allowed) return tooMany(res, m.retryAfterSec);
  const h = activateHour.hit(ip);
  if (!h.allowed) return tooMany(res, h.retryAfterSec);

  try {
    const { product_id, serial, installation_id } = req.body || {};
    res.json(await getLicenseService().activate({ product_id, serial, installation_id }));
  } catch (err) {
    if (err instanceof LicenseError && err.code === 'invalid_serial') activateFailures.hit(ip);
    sendError(res, err);
  }
};

export const validateLicense = async (req, res) => {
  const ip = getClientIp(req) || 'unknown';
  const m = validateMinute.hit(ip);
  if (!m.allowed) return tooMany(res, m.retryAfterSec);
  try {
    const { product_id, installation_id, license } = req.body || {};
    res.json(await getLicenseService().validate({ product_id, installation_id, license }));
  } catch (err) {
    sendError(res, err);
  }
};

// ─── Administración (requireAuth + requireAdmin en la ruta) ───────
const wrap = (fn) => async (req, res) => {
  try {
    res.json(await fn(req));
  } catch (err) {
    sendError(res, err);
  }
};

export const adminListProducts = wrap(() => getLicenseService().listProducts());
export const adminCreateProduct = wrap(req => getLicenseService().createProduct(req.body || {}));
export const adminUpdateProduct = wrap(req => getLicenseService().updateProduct(req.params.id, req.body || {}));
export const adminCreateSerials = wrap(req => getLicenseService().createSerials(req.body || {}));
export const adminListSerials = wrap(req => getLicenseService().listSerials(req.query || {}));
export const adminGetSerial = wrap(req => getLicenseService().getSerial(req.params.id));
export const adminLookupSerial = wrap(req => getLicenseService().lookupSerial(req.body || {}));
export const adminRevokeSerial = wrap(req => getLicenseService().revokeSerial(req.params.id, req.body || {}));
export const adminUnrevokeSerial = wrap(req => getLicenseService().unrevokeSerial(req.params.id));
export const adminResetActivation = wrap(req => getLicenseService().resetActivation(req.params.id));
export const adminPublicKey = wrap(() => getLicenseService().publicKeyInfo());
