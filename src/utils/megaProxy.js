import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { log, isVerbose } from './logger.js';
import { runCmd } from './megaCmd.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROXY_FILE = path.join(__dirname, 'proxies.txt');

let LAST_APPLIED = null; // { proxyUrl, username, password, raw }

function readProxyLines(proxyFile = DEFAULT_PROXY_FILE) {
  try {
    if (!fs.existsSync(proxyFile)) return [];
    const content = fs.readFileSync(proxyFile, 'utf-8');
    return content
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'));
  } catch (e) {
    log.warn(`[MEGA-PROXY] Error leyendo proxies: ${e.message}`);
    return [];
  }
}

function parseProxyLine(raw) {
  // Formato esperado: IP:PORT:USER:PASS (Webshare)
  const parts = String(raw || '').trim().split(':');
  if (parts.length !== 4) return null;
  const [ip, port, user, pass] = parts;
  if (!ip || !port) return null;
  return {
    proxyUrl: `http://${ip}:${port}`,
    username: user,
    password: pass,
    raw,
  };
}

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function listMegaProxies({ proxyFile, shuffle = true } = {}) {
  const lines = readProxyLines(proxyFile);
  const parsed = lines.map(parseProxyLine).filter(Boolean);
  return shuffle ? shuffleInPlace(parsed) : parsed;
}

export function getAppliedMegaProxy() {
  return LAST_APPLIED ? { ...LAST_APPLIED, password: '<hidden>' } : null;
}

export async function applyMegaProxy(picked, { ctx, timeoutMs = 15000, clearOnFail = true } = {}) {
  if (!picked || !picked.proxyUrl) throw new Error('Proxy inválido');
  try {
    await runCmd(
      'mega-proxy',
      [picked.proxyUrl, `--username=${picked.username}`, `--password=${picked.password}`],
      { quiet: true, timeoutMs }
    );
    LAST_APPLIED = picked;
    log.info(`[MEGA-PROXY] Aplicado ${picked.proxyUrl}${ctx ? ` ${ctx}` : ''}`);
    return { enabled: true, proxyUrl: picked.proxyUrl, raw: picked.raw };
  } catch (e) {
    log.warn(`[MEGA-PROXY] Falló al aplicar proxy: ${e.message}${ctx ? ` ${ctx}` : ''}`);
    if (clearOnFail) {
      try { await runCmd('mega-proxy', ['--none'], { quiet: true, timeoutMs: 8000 }); } catch {}
    }
    return { enabled: false, error: e.message };
  }
}

function pickRandomProxy(lines) {
  if (!lines || lines.length === 0) return null;
  const raw = lines[Math.floor(Math.random() * lines.length)];
  return parseProxyLine(raw);
}

export async function applyRandomMegaProxy({ proxyFile, ctx } = {}) {
  const lines = readProxyLines(proxyFile);
  const picked = pickRandomProxy(lines);
  if (!picked) {
    log.warn(`[MEGA-PROXY] Sin proxies válidos.${ctx ? ` ${ctx}` : ''}`);
    return { enabled: false };
  }
  return applyMegaProxy(picked, { ctx, timeoutMs: 15000, clearOnFail: true });
}

async function uploadsAreActiveNow() {
  try {
    const mod = await import('./uploadsActiveFlag.js');
    if (typeof mod?.isUploadsActive === 'function') return Boolean(mod.isUploadsActive());
    return false;
  } catch {
    return false;
  }
}

export async function clearMegaProxyIfSafe({ ctx } = {}) {
  try {
    const active = await uploadsAreActiveNow();
    if (active) {
      log.warn(`[MEGA-PROXY] clear SKIP: uploads activos.${ctx ? ` ${ctx}` : ''}`);
      return { skipped: true };
    }
  } catch {}

  try {
    await runCmd('mega-proxy', ['--none'], { quiet: true, timeoutMs: 8000 });
    return { ok: true };
  } catch (e) {
    // No es crítico
    log.warn(`[MEGA-PROXY] clear warn: ${e.message}${ctx ? ` ${ctx}` : ''}`);
    return { ok: false, error: e.message };
  }
}

let CACHED_PROXIES = null;

/**
 * Retorna el proxy correspondiente a un intento dado para una cuenta específica,
 * basándose en el mapeo "sticky proxy" (bloques asignados por id de cuenta).
 *
 * @param {object} account Objeto de cuenta que contenga la propiedad `id`.
 * @param {number} attempt Número de intento o rotación (0 para el primero).
 * @returns {object|null} El proxy asignado ({ proxyUrl, username, password, raw }) o null si no hay disponibles.
 */
export function getStickyProxyForAccount(account, attempt = 0) {
  if (!CACHED_PROXIES) {
    CACHED_PROXIES = listMegaProxies({ shuffle: false });
  }
  if (!CACHED_PROXIES.length) return null;
  const accId = account?.id ? Number(account.id) : 0;
  const startIdx = accId ? (accId % CACHED_PROXIES.length) : 0;
  return CACHED_PROXIES[(startIdx + attempt) % CACHED_PROXIES.length];
}
