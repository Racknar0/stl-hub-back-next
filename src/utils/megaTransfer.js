import { spawn } from 'child_process';
import { getStickyProxyForAccount, applyMegaProxy } from './megaProxy.js';
import { runCmd } from './megaCmd.js';
import { log } from './logger.js';

function isWindows() {
  return process.platform === 'win32';
}

export function isMegaStallError(err) {
  return !!(err && (err.code === 'MEGA_STALL' || String(err.message || '').includes('MEGA_STALL')));
}

export async function killProcessTreeBestEffort(child, label = 'MEGA') {
  try {
    if (!child || !child.pid) return;
    const pid = child.pid;

    // Try graceful kill first
    try { child.kill(); } catch {}

    if (isWindows()) {
      await new Promise((resolve) => {
        try {
          const tk = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { shell: true, windowsHide: true });
          tk.on('close', () => resolve());
          tk.on('error', () => resolve());
        } catch {
          resolve();
        }
      });
      return;
    }

    // Best-effort on *nix
    try { process.kill(-pid, 'SIGKILL'); } catch {}
    try { process.kill(pid, 'SIGKILL'); } catch {}
  } catch (e) {
    // never throw from best-effort kill
    try { console.warn(`[${label}][KILL] warn: ${e.message}`); } catch {}
  }
}

function extractProgressSignals(s) {
  const txt = String(s || '');
  // MEGAcmd progress outputs e.g., " 12.34%", "12%", "Transferring 12 %"
  const m = txt.match(/(?:\b|\s|^)(\d{1,3}(?:\.\d+)?)\s*%/);
  const pct = m ? Math.min(100, Math.max(0, Number(m[1]))) : null;
  return { pct };
}

export function megaCmdWithProgressAndStall({
  cmd,
  args = [],
  label = 'MEGA',
  stallTimeoutMs = 5 * 60 * 1000,
  heartbeatMs = 30000,
  shell = true,
  cwd,
  onLine,
  onProgress,
  onHeartbeat,
}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { shell, cwd, windowsHide: true });

    let out = '';
    let err = '';
    let lastProgressAt = Date.now();
    let lastPct = null;
    let finished = false;

    const finish = async (error, code = 0) => {
      if (finished) return;
      finished = true;
      try { clearInterval(timer); } catch {}
      try { clearTimeout(stallTimer); } catch {}

      if (error) {
        error.exitCode = code;
        error.out = out;
        error.err = err;
        return reject(error);
      }
      return resolve({ out, err, code });
    };

    const bumpProgress = (chunk, stream = 'out') => {
      // Cualquier salida cuenta como "actividad" para evitar stalls falsos
      lastProgressAt = Date.now();

      const { pct } = extractProgressSignals(chunk);
      if (pct != null && pct !== lastPct) {
        lastPct = pct;
        try {
          if (typeof onProgress === 'function') onProgress({ pct, stream, chunk: String(chunk || '') });
        } catch {}
      }
    };

    let buf = '';
    const onChunk = (chunk, isErr = false) => {
      const s = chunk.toString();
      if (isErr) err += s; else out += s;
      // keep bounded
      if (out.length > 64 * 1024) out = out.slice(-64 * 1024);
      if (err.length > 64 * 1024) err = err.slice(-64 * 1024);

      bumpProgress(s, isErr ? 'err' : 'out');

      if (typeof onLine === 'function') {
        buf += s;
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).replace(/\r$/, '');
          buf = buf.slice(idx + 1);
          try { onLine(line); } catch {}
        }
      }
    };

    if (child.stdout) child.stdout.on('data', (d) => onChunk(d, false));
    if (child.stderr) child.stderr.on('data', (d) => onChunk(d, true));

    child.on('error', (e) => finish(e, -1));
    child.on('close', (code) => {
      // flush remainder as a line
      if (typeof onLine === 'function') {
        const rem = String(buf || '').trim();
        if (rem) {
          try { onLine(rem); } catch {}
        }
      }
      if (code === 0) return finish(null, 0);
      return finish(new Error(`${label} cmd ${cmd} exited ${code}`), code);
    });

    // Stall watchdog: if no progress updates for stallTimeoutMs, abort.
    const timer = setInterval(() => {
      try {
        if (typeof onHeartbeat === 'function') {
          const idleMs = Date.now() - lastProgressAt;
          onHeartbeat({ idleMs, lastPct });
        }
      } catch {}
    }, Math.max(5000, Number(heartbeatMs) || 30000));

    const stallTimer = setInterval(async () => {
      const idle = Date.now() - lastProgressAt;
      if (idle >= stallTimeoutMs) {
        const e = new Error(`[${label}] MEGA_STALL after ${Math.round(idle / 1000)}s cmd=${cmd}`);
        e.code = 'MEGA_STALL';
        try { await killProcessTreeBestEffort(child, label); } catch {}
        return finish(e, -1);
      }
    }, 5_000);
  });
}

const MEGA_TRANSFER_STALL_TIMEOUT_MS = Number(process.env.MEGA_TRANSFER_STALL_TIMEOUT_MS || (5 * 60 * 1000));
const MEGA_TRANSFER_STALL_MAX_RETRIES = Number(process.env.MEGA_TRANSFER_STALL_MAX_RETRIES || 2);
const MEGA_TRANSFER_STALL_BACKOFF_MS = Number(process.env.MEGA_TRANSFER_STALL_BACKOFF_MS || 30000);

export async function applyProxyByIndexOrThrow(account, idx, ctx){
  const p = getStickyProxyForAccount(account, idx);
  if (!p) throw new Error(`[TRANSFER][PROXY] Sin proxies válidos (no se permite IP directa)${ctx ? ` ${ctx}` : ''}`);
  const r = await applyMegaProxy(p, { ctx: ctx || 'transfer', timeoutMs: 15000, clearOnFail: false });
  if (!r?.enabled) throw new Error(`[TRANSFER][PROXY] apply failed proxy=${p?.proxyUrl || '--'} err=${String(r?.error || '').slice(0,160)}`);
  log.info(`[TRANSFER][PROXY][OK] ${p.proxyUrl}${ctx ? ` ${ctx}` : ''}`);
  return p;
}

export async function megaGetWithStallRetry({ remoteFile, destLocal, ctx, account, getProxyIndex, setProxyIndex, relogin }){
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      log.info(`[TRANSFER][DL][START] attempt=${attempt} proxyIdx=${getProxyIndex()} remote=${remoteFile} -> ${destLocal} ${ctx}`);
      await megaCmdWithProgressAndStall({
        cmd: 'mega-get',
        args: [remoteFile, destLocal],
        label: 'TRANSFER-DL',
        stallTimeoutMs: MEGA_TRANSFER_STALL_TIMEOUT_MS,
        heartbeatMs: 30000,
        onProgress: ({ pct }) => {
          log.info(`[TRANSFER][DL][PROGRESS] ${pct}% ${ctx}`);
        },
        onHeartbeat: ({ idleMs, lastPct }) => {
          log.info(`[TRANSFER][DL][HB] idle=${Math.round(idleMs / 1000)}s pct=${lastPct ?? '--'} ${ctx}`);
        },
      });
      log.info(`[TRANSFER][DL][DONE] remote=${remoteFile} ${ctx}`);
      return;
    } catch (e) {
      if (!isMegaStallError(e) || attempt > MEGA_TRANSFER_STALL_MAX_RETRIES) throw e;
      log.warn(`[TRANSFER][STALL][DL] sin progreso, rotate proxy + relogin (attempt=${attempt}/${MEGA_TRANSFER_STALL_MAX_RETRIES}) ${ctx}`);
      setProxyIndex(getProxyIndex() + 1);
      await applyProxyByIndexOrThrow(account, getProxyIndex(), ctx);
      await relogin();
      await new Promise(r => setTimeout(r, MEGA_TRANSFER_STALL_BACKOFF_MS));
    }
  }
}

export async function megaPutWithStallRetry({ localPath, remoteFolderOrFile, ctx, account, getProxyIndex, setProxyIndex, relogin, useProxy = true }){
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      log.info(`[TRANSFER][UP][START] attempt=${attempt} proxyIdx=${useProxy ? getProxyIndex() : 'NONE'} local=${localPath} -> remote=${remoteFolderOrFile} ${ctx}`);
      await megaCmdWithProgressAndStall({
        cmd: 'mega-put',
        args: [localPath, remoteFolderOrFile],
        label: 'TRANSFER-UP',
        stallTimeoutMs: MEGA_TRANSFER_STALL_TIMEOUT_MS,
        heartbeatMs: 30000,
        onProgress: ({ pct }) => {
          log.info(`[TRANSFER][UP][PROGRESS] ${pct}% ${ctx}`);
        },
        onHeartbeat: ({ idleMs, lastPct }) => {
          log.info(`[TRANSFER][UP][HB] idle=${Math.round(idleMs / 1000)}s pct=${lastPct ?? '--'} ${ctx}`);
        },
      });
      log.info(`[TRANSFER][UP][DONE] remote=${remoteFolderOrFile} ${ctx}`);
      return;
    } catch (e) {
      if (!isMegaStallError(e) || attempt > MEGA_TRANSFER_STALL_MAX_RETRIES) throw e;
      log.warn(`[TRANSFER][STALL][UP] sin progreso, rotate proxy + relogin (attempt=${attempt}/${MEGA_TRANSFER_STALL_MAX_RETRIES}) ${ctx}`);
      if (useProxy) {
        setProxyIndex(getProxyIndex() + 1);
        await applyProxyByIndexOrThrow(account, getProxyIndex(), ctx);
      } else {
        await runCmd('mega-proxy', ['--none'], { quiet: true });
      }
      await relogin();
      await new Promise(r => setTimeout(r, MEGA_TRANSFER_STALL_BACKOFF_MS));
    }
  }
}
