import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { log, isVerbose } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROXY_FILE = path.join(__dirname, 'proxies.txt');

function runCmd(cmd, args = [], { quiet = false, timeoutMs = 0 } = {}) {
  const verbose = typeof isVerbose === 'function' && isVerbose();
  if (!quiet && verbose) {
    log.verbose(`[MEGA-PROXY] cmd ${cmd} ${(args || []).join(' ')}`);
  }

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { shell: true });
    let out = '';
    let err = '';
    let settled = false;
    let timer = null;

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { child.kill('SIGKILL'); } catch {}
        reject(new Error(`${cmd} timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    }

    child.stdout.on('data', d => { out += d.toString(); });
    child.stderr.on('data', d => { err += d.toString(); });

    child.on('close', code => {
      if (timer) clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code === 0) return resolve({ out, err });
      reject(new Error(err || out || `${cmd} exited ${code}`));
    });

    child.on('error', e => {
      if (timer) clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(e);
      }
    });
  });
}

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

function pickRandomProxy(lines) {
  if (!lines || lines.length === 0) return null;
  const raw = lines[Math.floor(Math.random() * lines.length)];
  return parseProxyLine(raw);
}

export async function applyRandomMegaProxy({ proxyFile, ctx } = {}) {
  const lines = readProxyLines(proxyFile);
  const picked = pickRandomProxy(lines);
  if (!picked) {
    log.warn(`[MEGA-PROXY] Sin proxies válidos. Se usará IP directa.${ctx ? ` ${ctx}` : ''}`);
    return { enabled: false };
  }

  try {
    // Flags separados: más robusto (mismo patrón que en autoBackupAssetsToMain)
    await runCmd('mega-proxy', [picked.proxyUrl, `--username=${picked.username}`, `--password=${picked.password}`], { quiet: true, timeoutMs: 15000 });
    log.info(`[MEGA-PROXY] Aplicado ${picked.proxyUrl}${ctx ? ` ${ctx}` : ''}`);
    return { enabled: true, proxyUrl: picked.proxyUrl };
  } catch (e) {
    log.warn(`[MEGA-PROXY] Falló al aplicar proxy: ${e.message}${ctx ? ` ${ctx}` : ''}`);
    // Intentar dejar la sesión sin proxy si falló
    try { await runCmd('mega-proxy', ['--none'], { quiet: true, timeoutMs: 8000 }); } catch {}
    return { enabled: false, error: e.message };
  }
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
