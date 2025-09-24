import { EventEmitter } from 'events';

// Emite eventos 'log' con { level, messages, timestamp }
class LogBus extends EventEmitter {}
export const logBus = new LogBus();

function buildPayload(level, args) {
  // Quitar prefijo para console.log "normal" (nivel 'log')
  const rawMessages = args.map(a => {
    if (a instanceof Error) return a.stack || a.message;
    if (typeof a === 'object') { try { return JSON.stringify(a); } catch { return String(a); } }
    return String(a);
  });
  // Detectar línea de barra de progreso MEGA y degradarla a verbose
  const cleaned = rawMessages.map(m => {
    if (/MEGA PUT] TRANSFERRING/.test(m) || /\|#+/.test(m)) return '[progreso transferencia]';
    return m;
  });
  const isProgress = rawMessages.some(m => /MEGA PUT] TRANSFERRING/.test(m));
  return {
    level: isProgress ? 'verbose' : level,
    messages: cleaned,
    timestamp: Date.now()
  };
}

// Wrap de console.* sólo una vez
let wrapped = false;
export function installConsoleHook() {
  if (wrapped) return;
  wrapped = true;
  const levels = ['log','info','warn','error'];
  levels.forEach(level => {
    const orig = console[level];
    console[level] = (...args) => {
      try { logBus.emit('log', buildPayload(level, args)); } catch {}
      orig.apply(console, args);
    };
  });
}

// SSE handler
export function logsSSEHandler(req, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders && res.flushHeaders();

  const send = (data) => {
    res.write(`event: log\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const wantVerbose = /^(1|true|yes)$/i.test(String(process.env.VERBOSE_MODE || ''));
  const listener = (payload) => {
    if (payload.level === 'verbose' && !wantVerbose) return; // suprimir verbose si no está habilitado
    try { send(payload); } catch {}
  };
  logBus.on('log', listener);

  // Ping para mantener conexión
  const pingInterval = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15000);

  req.on('close', () => {
    clearInterval(pingInterval);
    logBus.off('log', listener);
    try { res.end(); } catch {}
  });
}
