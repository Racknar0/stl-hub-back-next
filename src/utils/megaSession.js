/**
 * megaSession.js — Módulo centralizado de login/logout/métricas MEGA.
 *
 * TODAS las operaciones de login/logout deben pasar por este módulo.
 * Esto garantiza que las siguientes protecciones se aplican SIEMPRE:
 *
 *  1. Logout preventivo antes de login (limpia sesiones pegadas)
 *  2. Login via session cache (ticket → password fallback automático)
 *  3. Rotación de proxies si falla el login
 *  4. Reset del servidor mega-cmd si se queda colgado
 *  5. Refresh de storage post-login (opcional)
 *  6. --keep-session en logout (nunca destruye sesiones)
 *  7. Respeta subidas activas (no resetea mega-cmd si hay uploads)
 *
 * Uso típico (dentro de withMegaLock):
 *
 *   await megaLoginFull(prisma, accountId, payload, 'mi-contexto');
 *   // ... operaciones MEGA ...
 *   await megaLogoutSafe('mi-contexto');
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { runCmd } from './megaCmd.js';
import { parseStorageFromDfText } from './megaDfParser.js';
import { loginWithSessionCache } from './megaSessionHelper.js';
import { getStickyProxyForAccount, applyMegaProxy } from './megaProxy.js';
import { log } from './logger.js';

// ─── Configuración ───────────────────────────────────────────────
const DEFAULT_LOGIN_TIMEOUT_MS  = Number(process.env.MEGA_LOGIN_TIMEOUT_MS)  || 60_000;
const DEFAULT_LOGOUT_TIMEOUT_MS = Number(process.env.MEGA_LOGOUT_TIMEOUT_MS) || 15_000;
const DEFAULT_FREE_QUOTA_MB     = Number(process.env.MEGA_FREE_QUOTA_MB)     || 20_480;
const RESET_WAIT_MS             = 5_000; // Espera después de matar mega-cmd-server

// ─── Helpers internos ────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Verifica si hay subidas activas (archivo lock de uploads).
 * Si hay subidas, NO debemos resetear mega-cmd ni hacer logout agresivo.
 */
function uploadsAreActive() {
  try { return fs.existsSync(path.resolve('uploads', 'uploads-active.lock')); } catch { return false; }
}

// ─── megaLogoutSafe ──────────────────────────────────────────────
/**
 * Logout MEGA seguro.
 *
 * - Siempre usa --keep-session (preserva la sesión en el servidor MEGA)
 * - Best-effort: NUNCA lanza errores
 * - Timeout configurable
 *
 * @param {string} ctx — Contexto para logs
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=15000] — Timeout del logout
 */
export async function megaLogoutSafe(ctx = '', opts = {}) {
  const { timeoutMs = DEFAULT_LOGOUT_TIMEOUT_MS } = opts;
  try {
    await runCmd('mega-logout', ['--keep-session'], { quiet: true, timeoutMs });
    log.info(`[MEGA-SESSION][LOGOUT][OK] ${ctx}`);
  } catch (e) {
    log.warn(`[MEGA-SESSION][LOGOUT][WARN] ${ctx} ${String(e.message || e).slice(0, 200)}`);
  }
}

// ─── resetMegaServerIfSafe ───────────────────────────────────────
/**
 * Reset de emergencia del servidor mega-cmd.
 *
 * Flujo: mega-quit → pkill -9 mega-cmd-server → esperar → mega-version (reinicia)
 *
 * NO ejecuta si hay subidas activas (respeta uploads-active.lock).
 *
 * @param {string} ctx — Contexto para logs
 * @returns {Promise<boolean>} true si se reseteo, false si se omitió
 */
export async function resetMegaServerIfSafe(ctx = '') {
  if (uploadsAreActive()) {
    log.warn(`[MEGA-SESSION][RESET][SKIP] Subidas activas, no resetear. ${ctx}`);
    return false;
  }
  log.warn(`[MEGA-SESSION][RESET] Reinicio de emergencia del servidor MEGA... ${ctx}`);
  try {
    try { await runCmd('mega-quit', [], { quiet: true, timeoutMs: 5000 }); } catch {}
    try { execSync('pkill -9 -f mega-cmd-server'); } catch {}
    await sleep(RESET_WAIT_MS);
    // Al ejecutar cualquier comando, el server arranca solo
    try { await runCmd('mega-version', [], { quiet: true, timeoutMs: 10000 }); } catch {}
    log.info(`[MEGA-SESSION][RESET][OK] Servidor reiniciado. ${ctx}`);
    return true;
  } catch (e) {
    log.error(`[MEGA-SESSION][RESET][FAIL] ${e.message} ${ctx}`);
    return false;
  }
}

// ─── refreshStorageMetrics ───────────────────────────────────────
/**
 * Refrescar métricas de storage de una cuenta MEGA.
 *
 * Ejecuta mega-df -h → parsea con parseStorageFromDfText → actualiza en DB.
 * Debe llamarse DENTRO de una sesión activa (post-login).
 *
 * Si mega-df -h falla, intenta mega-df sin -h como fallback.
 *
 * @param {object} prisma — PrismaClient
 * @param {number} accountId — ID de la cuenta MEGA
 * @param {string} [ctx] — Contexto para logs
 * @returns {Promise<{storageUsedMB: number, storageTotalMB: number}|null>}
 */
export async function refreshStorageMetrics(prisma, accountId, ctx = '') {
  const id = Number(accountId);
  if (!Number.isFinite(id) || id <= 0) return null;

  let storageUsedMB = 0;
  let storageTotalMB = 0;

  // Intento 1: mega-df -h
  try {
    const { out } = await runCmd('mega-df', ['-h'], { quiet: true, timeoutMs: 15_000 });
    const parsed = parseStorageFromDfText(out);
    storageUsedMB = parsed.storageUsedMB;
    storageTotalMB = parsed.storageTotalMB;
  } catch (e) {
    log.warn(`[MEGA-SESSION][STORAGE] mega-df -h warn accId=${id}: ${String(e.message).slice(0, 200)} ${ctx}`);
  }

  // Intento 2: mega-df sin -h
  if (!storageTotalMB) {
    try {
      const { out } = await runCmd('mega-df', [], { quiet: true, timeoutMs: 15_000 });
      const parsed = parseStorageFromDfText(out);
      storageUsedMB = parsed.storageUsedMB;
      storageTotalMB = parsed.storageTotalMB;
    } catch (e) {
      log.warn(`[MEGA-SESSION][STORAGE] mega-df fallback warn accId=${id}: ${String(e.message).slice(0, 200)} ${ctx}`);
    }
  }

  // Defaults
  if (!storageTotalMB || storageTotalMB <= 0) storageTotalMB = DEFAULT_FREE_QUOTA_MB;
  if (storageUsedMB > storageTotalMB) storageTotalMB = storageUsedMB;
  if (!storageUsedMB && !storageTotalMB) return null;

  try {
    const updated = await prisma.megaAccount.update({
      where: { id },
      data: {
        storageUsedMB,
        storageTotalMB,
        lastCheckAt: new Date(),
      },
      select: { id: true, storageUsedMB: true, storageTotalMB: true },
    });
    log.info(`[MEGA-SESSION][STORAGE][OK] accId=${id} used=${updated.storageUsedMB}MB total=${updated.storageTotalMB}MB ${ctx}`);
    return updated;
  } catch (e) {
    log.warn(`[MEGA-SESSION][STORAGE][DB-WARN] accId=${id} ${e.message} ${ctx}`);
    return null;
  }
}

// ─── megaLoginFull ───────────────────────────────────────────────
/**
 * Login MEGA completo con TODAS las protecciones.
 *
 * Flujo:
 *   1. Aplicar proxy del bloque de la cuenta (si no skipProxySetup)
 *   2. Logout preventivo (limpia sesión pegada)
 *   3. Login via loginWithSessionCache (ticket → password)
 *      ├─ OK → refresh storage (opcional) → return
 *      └─ FAIL →
 *          4. Rotar proxy (siguiente del bloque)
 *          5. Reintentar login
 *          6. Tras N fallos → resetear mega-cmd-server (si no hay uploads)
 *          7. Reintentar login con nuevo proxy
 *          └─ FAIL final → throw
 *
 * IMPORTANTE: Esta función NO adquiere withMegaLock. El caller debe
 * manejar el lock según su contexto (batch, cron, dashboard, etc.)
 *
 * @param {object} prisma — PrismaClient
 * @param {number} accountId — ID de la cuenta MEGA en DB
 * @param {object} payload — Credenciales desencriptadas { type, session, username, password }
 * @param {string} [ctx] — Contexto para logs
 * @param {object} [opts] — Opciones
 * @param {number}  [opts.timeoutMs=60000]          — Timeout por intento de login
 * @param {number}  [opts.maxProxyRetries=10]        — Máx reintentos con rotación de proxy (0 = sin rotación)
 * @param {boolean} [opts.skipStorageRefresh=false]   — Si true, no refresca storage después del login
 * @param {boolean} [opts.skipResetServer=false]      — Si true, nunca resetea mega-cmd-server
 * @param {boolean} [opts.skipProxySetup=false]       — Si true, el caller ya configuró el proxy
 * @returns {Promise<{ success: boolean, method: 'session'|'password' }>}
 */
export async function megaLoginFull(prisma, accountId, payload, ctx = '', opts = {}) {
  const {
    timeoutMs = DEFAULT_LOGIN_TIMEOUT_MS,
    maxProxyRetries = 10,
    skipStorageRefresh = false,
    skipResetServer = false,
    skipProxySetup = false,
  } = opts;

  const accId = Number(accountId);
  let lastErr = null;
  let didReset = false;

  for (let attempt = 0; attempt <= maxProxyRetries; attempt++) {
    try {
      // ── Step 1: Configurar proxy ──
      if (!skipProxySetup) {
        try {
          const proxy = getStickyProxyForAccount({ id: accId }, attempt);
          if (proxy) {
            const r = await applyMegaProxy(proxy, { ctx, timeoutMs: 15_000, clearOnFail: false });
            if (r?.enabled) {
              log.info(`[MEGA-SESSION][PROXY][OK] ${proxy.proxyUrl} accId=${accId} attempt=${attempt} ${ctx}`);
            }
          }
        } catch (proxyErr) {
          log.warn(`[MEGA-SESSION][PROXY][WARN] accId=${accId} attempt=${attempt}: ${String(proxyErr.message).slice(0, 160)} ${ctx}`);
          // Si no hay proxies en el primer intento, no tiene sentido continuar
          if (attempt === 0) {
            log.error(`[MEGA-SESSION][PROXY][FAIL] Sin proxy válido para accId=${accId}. ${ctx}`);
          }
        }
      }

      // ── Step 2: Logout preventivo ──
      await megaLogoutSafe(`preventive accId=${accId} attempt=${attempt} ${ctx}`);

      // ── Step 3: Login con session cache ──
      const result = await loginWithSessionCache(prisma, runCmd, accId, payload, ctx, timeoutMs);
      log.info(`[MEGA-SESSION][LOGIN][OK] accId=${accId} method=${result.method} attempt=${attempt} ${ctx}`);

      // ── Step 4: Refresh storage (best-effort) ──
      if (!skipStorageRefresh) {
        try { await refreshStorageMetrics(prisma, accId, ctx); } catch {}
      }

      return result;
    } catch (e) {
      lastErr = e;
      const msg = String(e.message || e).slice(0, 200);
      log.warn(`[MEGA-SESSION][LOGIN][FAIL] accId=${accId} attempt=${attempt + 1}/${maxProxyRetries + 1}: ${msg} ${ctx}`);

      // ── Step 5: Reset mega-cmd si se cuelga (una sola vez) ──
      if (!skipResetServer && !didReset && attempt >= 2) {
        didReset = true;
        const wasReset = await resetMegaServerIfSafe(`login-recovery accId=${accId} ${ctx}`);
        if (wasReset) await sleep(2000);
      }

      // Backoff progresivo antes del siguiente intento
      if (attempt < maxProxyRetries) {
        await sleep(Math.min(1500 * (attempt + 1), 8000));
      }
    }
  }

  throw lastErr || new Error(`[MEGA-SESSION] Login fallido tras ${maxProxyRetries + 1} intentos accId=${accId} ${ctx}`);
}
