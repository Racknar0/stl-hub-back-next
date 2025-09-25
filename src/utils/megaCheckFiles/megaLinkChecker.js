// utils/megaCheckFiles/megaLinkChecker.js
// Chequeo de links de MEGA con caché en memoria, backoff y LOGS opcionales.
// Node 18+ (fetch nativo). Sin TypeScript.

// =======================
//  Config de logging
// =======================
const DEFAULT_DEBUG = String(process.env.MEGA_CHECK_DEBUG || '').trim() === '1';
const dbg = (log, ...args) => { if (log) console.log(...args); };

// =======================
//  Caché en memoria
// =======================
const linkCache = new Map();
/*
  Estructura cache:
  linkCache.set(link, {
    alive: true|false,
    checkedAt: Date,
    failCount: number,
    cooldownUntil: Date|null,
  })
*/

// =======================
//  Frases que indican link caído
// =======================
const PHRASES_DEAD = [
  /no longer available/i,
  /the file you are trying to download is no longer available/i,
  /has been removed/i,
  /file not available/i,
  /not available/i,
  /invalid url/i,
  /the link you are trying to access does not exist/i,
  // español
  /el archivo que intentas descargar ya no est[aá] disponible/i,
  /ha sido eliminado/i,
  /enlace inv[aá]lido/i,
  /no est[aá] disponible/i,
];

// =======================
//  Utils de parsing
// =======================
function normalizeLink(raw, log) {
  dbg(log, '[MEGA CHECK] normalizeLink() IN:', raw);
  let out = String(raw || '').trim();
  if (out && !out.startsWith('http')) out = 'https://' + out.replace(/^\/+/, '');
  dbg(log, '[MEGA CHECK] normalizeLink() OUT:', out);
  return out;
}
function hasHashKey(url, log) {
  dbg(log, '[MEGA CHECK] hasHashKey() IN:', url);
  const ok = /#/.test(String(url || ''));
  dbg(log, '[MEGA CHECK] hasHashKey() OUT:', ok);
  return ok;
}
function isMegaFile(url, log) {
  dbg(log, '[MEGA CHECK] isMegaFile() IN:', url);
  const ok = /mega\.nz\/file\//i.test(String(url || ''));
  dbg(log, '[MEGA CHECK] isMegaFile() OUT:', ok);
  return ok;
}
function isMegaFolder(url, log) {
  dbg(log, '[MEGA CHECK] isMegaFolder() IN:', url);
  const ok = /mega\.nz\/folder\//i.test(String(url || ''));
  dbg(log, '[MEGA CHECK] isMegaFolder() OUT:', ok);
  return ok;
}

function looksDeadHtml(html, log) {
  dbg(log, '[MEGA CHECK] looksDeadHtml() IN len:', html ? html.length : 0);
  if (!html) {
    dbg(log, '[MEGA CHECK] looksDeadHtml() OUT -> false (sin html)');
    return { dead: false, tag: null };
  }
  for (const re of PHRASES_DEAD) {
    if (re.test(html)) {
      dbg(log, '[MEGA CHECK] looksDeadHtml() MATCH ->', String(re));
      return { dead: true, tag: String(re) };
    }
  }
  dbg(log, '[MEGA CHECK] looksDeadHtml() NO MATCH -> false');
  return { dead: false, tag: null };
}

// Lee como mucho N bytes del body para no gastar memoria
async function readTextLimited(response, maxBytes = 64 * 1024, log = DEFAULT_DEBUG) {
  dbg(log, '[MEGA CHECK] readTextLimited() IN maxBytes=', maxBytes);
  try {
    const reader = response.body?.getReader ? response.body.getReader() : null;
    if (!reader) {
      dbg(log, '[MEGA CHECK] readTextLimited() no reader -> response.text()');
      const txt = await response.text();
      dbg(log, '[MEGA CHECK] readTextLimited() OUT len=', txt.length);
      return txt;
    }
    let received = 0;
    const chunks = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        const add = Math.min(value.length, Math.max(0, maxBytes - received));
        if (add > 0) chunks.push(Buffer.from(value.slice(0, add)));
        received += add;
        if (received >= maxBytes) break;
      }
    }
    try { reader.releaseLock && reader.releaseLock(); } catch {}
    const out = Buffer.concat(chunks).toString('utf8');
    dbg(log, '[MEGA CHECK] readTextLimited() OUT len=', out.length);
    return out;
  } catch (e) {
    dbg(log, '[MEGA CHECK] readTextLimited() ERROR:', e?.message || e);
    try {
      const fallback = await response.text();
      dbg(log, '[MEGA CHECK] readTextLimited() OUT fallback len=', fallback.length);
      return fallback;
    } catch {
      dbg(log, '[MEGA CHECK] readTextLimited() OUT -> ""');
      return '';
    }
  }
}

async function fetchWithTimeout(url, { timeoutMs = 4000, headers = {} } = {}, log = DEFAULT_DEBUG) {
  dbg(log, '[MEGA CHECK] fetchWithTimeout() IN:', { url, timeoutMs, headers });
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      redirect: 'follow',
      headers,
      signal: controller.signal,
    });
    dbg(log, '[MEGA CHECK] fetchWithTimeout() OUT status:', resp.status);
    return resp;
  } catch (e) {
    dbg(log, '[MEGA CHECK] fetchWithTimeout() ERROR:', e?.message || e);
    throw e;
  } finally {
    clearTimeout(t);
  }
}

function useCache(link, ttlMs, log) {
  dbg(log, '[MEGA CHECK] useCache() IN ttlMs=', ttlMs);
  const entry = linkCache.get(link);
  dbg(log, '[MEGA CHECK] useCache() entry=', entry);
  if (!entry) {
    dbg(log, '[MEGA CHECK] useCache() OUT -> null');
    return null;
  }
  const now = Date.now();
  const fresh = now - entry.checkedAt.getTime() < ttlMs;
  const inCooldown = entry.cooldownUntil && now < entry.cooldownUntil.getTime();
  dbg(log, '[MEGA CHECK] useCache() fresh=', fresh, 'inCooldown=', inCooldown);
  if (fresh || inCooldown) {
    dbg(log, '[MEGA CHECK] useCache() OUT ->', entry.alive);
    return entry.alive;
  }
  dbg(log, '[MEGA CHECK] useCache() OUT -> null (stale)');
  return null;
}

function setCache(link, alive, prev, now, { bumpFail = false } = {}, log) {
  dbg(log, '[MEGA CHECK] setCache() IN', { link, alive, bumpFail, prev });
  const failCount = bumpFail ? (prev?.failCount ?? 0) + 1 : 0;
  const cooldownUntil = bumpFail
    ? new Date(now + Math.min(failCount * 10 * 60 * 1000, 6 * 60 * 60 * 1000))
    : null;
  const value = {
    alive,
    checkedAt: new Date(now),
    failCount,
    cooldownUntil,
  };
  linkCache.set(link, value);
  dbg(log, '[MEGA CHECK] setCache() OUT value:', JSON.stringify(value, null, 2));
}

// Intento de import megajs (dinámico)
async function tryImportMega(log) {
  dbg(log, '[MEGA CHECK] tryImportMega()');
  try {
    const mod = await import('megajs');
    const MegaFile = mod.File || mod.file || mod?.default?.File;
    const MegaStorage = mod.Storage || mod.storage || mod?.default?.Storage;
    if (!MegaFile || !MegaStorage) {
      dbg(log, '[MEGA CHECK] tryImportMega() -> módulo sin File/Storage');
      return null;
    }
    dbg(log, '[MEGA CHECK] tryImportMega() OK');
    return { MegaFile, MegaStorage };
  } catch (e) {
    dbg(log, '[MEGA CHECK] tryImportMega() NOT AVAILABLE:', e?.message || e);
    return null;
  }
}

// =======================
//  API pública
// =======================
export async function checkMegaLinkAlive(
  link,
  {
    force = true,
    ttlMs = 30 * 60 * 1000,
    log = DEFAULT_DEBUG, // <— puedes controlar logs por llamada
  } = {}
) {
  dbg(log, '────────────────────────────────────────────────────────');
  dbg(log, '[MEGA CHECK] checkMegaLinkAlive() IN', { link, force, ttlMs, log });

  try {
    if (!link || typeof link !== 'string') {
      dbg(log, '[MEGA CHECK] link inválido -> false');
      return false;
    }

    const normalized = normalizeLink(link, log);
    const hasKey = hasHashKey(normalized, log);
    const fileLike = isMegaFile(normalized, log);
    const folderLike = isMegaFolder(normalized, log);
    dbg(log, '[MEGA CHECK] props:', { hasKey, fileLike, folderLike });

    if (!hasKey) {
      dbg(log, '[MEGA CHECK] SIN #KEY -> false');
      return false;
    }

    if (!force) {
      const cached = useCache(normalized, ttlMs, log);
      if (cached != null) return cached;
    } else {
      dbg(log, '[MEGA CHECK] FORCE=TRUE -> ignorando caché');
    }

    const now = Date.now();
    const cached = linkCache.get(normalized);
    dbg(log, '[MEGA CHECK] cached before:', cached);

    // 1) megajs primero
    try {
      const mega = await tryImportMega(log);
      if (mega) {
        const { MegaFile, MegaStorage } = mega;

        if (fileLike) {
          dbg(log, '[MEGA CHECK] megajs File.fromURL().loadAttributes()');
          const file = MegaFile.fromURL(normalized);
          await file.loadAttributes();
          dbg(log, '[MEGA CHECK] megajs FILE OK -> true');
          setCache(normalized, true, cached, now, {}, log);
          dbg(log, '[MEGA CHECK] OUT -> true');
          return true;
        }

        if (folderLike) {
          dbg(log, '[MEGA CHECK] megajs Storage.fromURL() (folder)');
          const storage = await MegaStorage.fromURL(normalized);
          const nodeCount = Object.keys(storage?.files || {}).length;
          dbg(log, '[MEGA CHECK] megajs FOLDER OK nodes=', nodeCount, '-> true');
          setCache(normalized, true, cached, now, {}, log);
          dbg(log, '[MEGA CHECK] OUT -> true');
          return true;
        }

        dbg(log, '[MEGA CHECK] patrón desconocido -> intento como FILE (fallback)');
        const file = MegaFile.fromURL(normalized);
        await file.loadAttributes();
        dbg(log, '[MEGA CHECK] megajs FILE OK (fallback) -> true');
        setCache(normalized, true, cached, now, {}, log);
        dbg(log, '[MEGA CHECK] OUT -> true');
        return true;
      } else {
        dbg(log, '[MEGA CHECK] megajs NO disponible -> salto a fallback HTML');
      }
    } catch (err) {
      const msg = String(err?.code || err?.message || err || '').toUpperCase();
      dbg(log, '[MEGA CHECK] megajs ERROR ->', msg);
      if (/ENOENT/.test(msg) || /EKEY/.test(msg) || /EACCESS/.test(msg) || /WRONG PASSWORD/.test(msg)) {
        dbg(log, '[MEGA CHECK] marcando DEAD por error megajs concluyente');
        setCache(normalized, false, cached, now, { bumpFail: true }, log);
        dbg(log, '[MEGA CHECK] OUT -> false');
        return false;
      }
      dbg(log, '[MEGA CHECK] error no concluyente, sigo con fallback HTML…');
    }

    // 2) Fallback HTML
    try {
      dbg(log, '[MEGA CHECK] HTML fetch…');
      const resp = await fetchWithTimeout(
        normalized,
        {
          timeoutMs: 8000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (MegaLinkChecker/1.5)',
            'Accept-Language': 'en-US,en;q=0.7,es;q=0.5',
            'Cache-Control': 'no-cache',
            'Sec-Fetch-Mode': 'navigate',
          },
        },
        log
      );

      const ctype = resp.headers.get('content-type');
      const clen  = resp.headers.get('content-length');
      dbg(log, '[MEGA CHECK] HTTP status=', resp.status, 'ctype=', ctype, 'len=', clen);

      if (resp.status >= 400) {
        dbg(log, '[MEGA CHECK] HTTP >=400 -> false');
        setCache(normalized, false, cached, now, { bumpFail: true }, log);
        dbg(log, '[MEGA CHECK] OUT -> false');
        return false;
      }

      const html = await readTextLimited(resp, 200 * 1024, log);
      const sample = (html || '').slice(0, 600).replace(/\s+/g, ' ');
      dbg(log, '[MEGA CHECK] HTML sample(600)=', sample);
      const { dead, tag } = looksDeadHtml(html, log);
      dbg(log, '[MEGA CHECK] dead=', dead, 'tag=', tag);

      setCache(normalized, !dead, cached, now, { bumpFail: dead }, log);
      dbg(log, '[MEGA CHECK] OUT ->', !dead);
      return !dead;

    } catch (err) {
      dbg(log, '[MEGA CHECK] fallback HTML ERROR (timeout/red):', err?.message || err);
      setCache(normalized, cached?.alive ?? true, cached, now, { bumpFail: true }, log);
      const out = cached?.alive ?? true;
      dbg(log, '[MEGA CHECK] OUT (fallback error) ->', out);
      return out;
    }

  } catch (fatal) {
    dbg(log, '[MEGA CHECK] FATAL ERROR:', fatal?.message || fatal);
    return false;
  }
}

// Helpers de depuración / tests
export function getLinkCacheSnapshot(log = DEFAULT_DEBUG) {
  dbg(log, '[MEGA CHECK] getLinkCacheSnapshot()');
  const out = {};
  for (const [k, v] of linkCache.entries()) {
    out[k] = {
      alive: v.alive,
      checkedAt: v.checkedAt,
      failCount: v.failCount,
      cooldownUntil: v.cooldownUntil,
    };
  }
  dbg(log, '[MEGA CHECK] getLinkCacheSnapshot() OUT keys=', Object.keys(out).length);
  return out;
}
export function clearLinkCache(log = DEFAULT_DEBUG) {
  dbg(log, '[MEGA CHECK] clearLinkCache()');
  linkCache.clear();
  dbg(log, '[MEGA CHECK] clearLinkCache() OUT size=', linkCache.size);
}
