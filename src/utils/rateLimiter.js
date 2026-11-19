/**
 * rateLimiter.js — Límite de peticiones en memoria por clave (ventana fija).
 * El backend corre en un solo proceso PM2, así que la memoria del proceso basta.
 */
export function createRateLimiter({ windowMs, max, now = () => Date.now() }) {
  const hits = new Map(); // key → { count, resetAt }

  const sweep = setInterval(() => {
    const t = now();
    for (const [key, entry] of hits) if (entry.resetAt <= t) hits.delete(key);
  }, Math.max(windowMs, 60 * 1000));
  sweep.unref?.();

  const current = (key) => {
    const t = now();
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= t) {
      entry = { count: 0, resetAt: t + windowMs };
      hits.set(key, entry);
    }
    return entry;
  };

  return {
    // Cuenta un intento. Devuelve { allowed, retryAfterSec }
    hit(key) {
      const entry = current(key);
      entry.count++;
      return { allowed: entry.count <= max, retryAfterSec: Math.ceil((entry.resetAt - now()) / 1000) };
    },
    // Consulta sin contar
    blocked(key) {
      const entry = current(key);
      return { blocked: entry.count >= max, retryAfterSec: Math.ceil((entry.resetAt - now()) / 1000) };
    },
    reset() { hits.clear(); },
    stop() { clearInterval(sweep); },
  };
}
