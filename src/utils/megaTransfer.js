import { spawn } from 'child_process';

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
  // Common MEGAcmd progress includes percentages like " 12%".
  const m = txt.match(/\b(\d{1,3})%\b/);
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
