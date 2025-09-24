// Cola serial para operaciones MEGAcmd
import { spawn } from 'child_process';
let chain = Promise.resolve();
let active = 0;
const listeners = new Set();
let pendingLogoutTimer = null;

export function withMegaLock(fn, label = 'MEGA') {
  const run = async () => {
    active++; emit();
    console.log(`[MEGA-LOCK] ACQUIRE (${active}) -> ${label}`);
    try {
      const res = await fn();
      return res;
    } finally {
      active = Math.max(0, active - 1);
      console.log(`[MEGA-LOCK] RELEASE (${active}) <- ${label}`);
      emit();
      // Programar mega-logout forzado si la cola queda vacía (seguridad de sesión)
      if (active === 0) {
        if (pendingLogoutTimer) { clearTimeout(pendingLogoutTimer); pendingLogoutTimer = null; }
        pendingLogoutTimer = setTimeout(() => {
          if (active === 0) {
            try {
              const child = spawn('mega-logout', [], { shell: true });
              child.stdout.on('data', d => console.log('[MEGA-AUTO-LOGOUT]', d.toString().trim()));
              child.stderr.on('data', d => console.log('[MEGA-AUTO-LOGOUT]', d.toString().trim()));
            } catch (e) { console.warn('[MEGA-AUTO-LOGOUT] warn:', e.message); }
          }
        }, 2000);
      }
    }
  };
  const next = chain.then(run, run);
  chain = next.catch(() => {}); // no romper cadena
  return next;
}

function emit() { for (const l of listeners) { try { l({ active }); } catch {} } }

export function onMegaQueue(cb) { listeners.add(cb); return () => listeners.delete(cb); }

export function megaQueueStatus() { return { active }; }
