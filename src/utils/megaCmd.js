/**
 * megaCmd.js — Ejecutor centralizado de comandos MEGAcmd.
 *
 * Combina lo mejor de las 7 implementaciones previas en un único módulo:
 *  - timeout configurable + settled guard (evita resoluciones dobles)
 *  - error handler en child.on('error')
 *  - credential masking (oculta passwords de mega-login en logs)
 *  - auto --keep-session en mega-logout (seguro por defecto)
 *  - auto-accept terms para prompts interactivos de MEGA
 *  - output truncation configurable (evita RangeError por salida enorme)
 *  - killProcessTree cross-platform en timeout
 *
 * Siempre retorna { out, err } con strings.
 */
import { spawn } from 'child_process';
import { log, isVerbose } from './logger.js';
import { killProcessTreeBestEffort } from './megaTransfer.js';

// ─── Configuración por env ───────────────────────────────────────
const MAX_CMD_CAPTURE_BYTES = (Number(process.env.MEGA_MAX_CAPTURE_KB) || 1024) * 1024; // 1 MB por defecto

// Comandos silenciados en logs (a menos que haya error o modo verbose)
const QUIET_MEGA_CMDS = new Set(['mega-login', 'mega-logout']);

// ─── attachAutoAcceptTerms ───────────────────────────────────────
/**
 * Responde automáticamente a los prompts interactivos de MEGAcmd
 * (Aceptar TOS, confirmar sí/no, etc.) para evitar que el proceso se quede colgado.
 */
export function attachAutoAcceptTerms(child, label = 'MEGA') {
  const EOL = '\n';
  const ACCEPT_REGEXES = [
    /Do you accept\s+these\s+terms\??/i,
    /Do you accept.*terms\??/i,
    /Type '\s*yes\s*' to continue/i,
    /Acepta[s]? .*t[ée]rminos\??/i,
    /¿Acepta[s]? los t[ée]rminos\??/i,
  ];
  const PROMPT_YNA = /Please enter \[y\]es\/\[n\]o\/\[a\]ll\/none|\[(y|Y)\]es\s*\/\s*\[(n|N)\]o\s*\/\s*\[(a|A)\]ll/i;
  const PROMPT_YN = /\[(y|Y)\]es\s*\/\s*\[(n|N)\]o/i;
  const PROMPT_ES_SN = /\[(s|S)\]\s*\/\s*\[(n|N)\]/i;

  const maybeAnswer = (s) => {
    try {
      if (ACCEPT_REGEXES.some(r => r.test(s))) child.stdin.write('yes' + EOL);
      else if (PROMPT_YNA.test(s)) child.stdin.write('a' + EOL);
      else if (PROMPT_YN.test(s)) child.stdin.write('y' + EOL);
      else if (PROMPT_ES_SN.test(s)) child.stdin.write('s' + EOL);
    } catch (e) {
      try { log.warn(`[${label}] auto-accept warn: ${e.message}`) } catch {}
    }
  };

  if (!child?.stdout || !child?.stderr) return;
  child.stdout.on('data', d => maybeAnswer(d.toString()));
  child.stderr.on('data', d => maybeAnswer(d.toString()));
}

// ─── runCmd ──────────────────────────────────────────────────────
/**
 * Ejecuta un comando del sistema (pensado para MEGAcmd) con todas las protecciones.
 *
 * @param {string} cmd — Comando a ejecutar (e.g. 'mega-login', 'mega-df')
 * @param {string[]} args — Argumentos del comando
 * @param {object} opts — Opciones
 * @param {number}  [opts.timeoutMs=0] — Timeout en ms (0 = sin timeout)
 * @param {boolean} [opts.quiet=false] — Suprime logs en stdout/stderr
 * @param {number}  [opts.maxBytes] — Máximo de bytes a capturar (default: MAX_CMD_CAPTURE_BYTES)
 * @param {string}  [opts.cwd] — Working directory
 * @param {boolean} [opts.autoAcceptTerms=true] — Si true, responde automáticamente a prompts de MEGA
 * @param {boolean} [opts.autoKeepSession=true] — Si true, inyecta --keep-session en mega-logout
 * @returns {Promise<{out: string, err: string}>}
 */
export function runCmd(cmd, args = [], opts = {}) {
  const {
    timeoutMs = 0,
    quiet = false,
    maxBytes,
    cwd,
    autoAcceptTerms = true,
    autoKeepSession = true,
  } = opts;

  let finalArgs = [...args];

  // Auto-inyectar --keep-session en mega-logout (evita destruir sesiones por error)
  if (autoKeepSession && cmd === 'mega-logout' && !finalArgs.includes('--keep-session') && !finalArgs.includes('--hard-logout')) {
    finalArgs.push('--keep-session');
  }
  // Soporte para --hard-logout: quitamos el pseudo-flag y ejecutamos sin --keep-session
  if (cmd === 'mega-logout' && finalArgs.includes('--hard-logout')) {
    finalArgs = finalArgs.filter(a => a !== '--hard-logout');
  }

  // Logging con masking de credenciales
  const maskArgs = (c, a) => (c && c.toLowerCase().includes('mega-login') ? ['<hidden>'] : a);
  const printable = `${cmd} ${(maskArgs(cmd, finalArgs) || []).join(' ')}`.trim();
  const isQuietCmd = quiet || QUIET_MEGA_CMDS.has(cmd);
  const verbose = typeof isVerbose === 'function' && isVerbose();
  if (!isQuietCmd && verbose) log.verbose(`[MEGA-CMD] exec: ${printable}`);

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, finalArgs, { cwd, shell: true });

    // Auto-aceptar prompts interactivos de MEGA
    if (autoAcceptTerms && (cmd === 'mega-login' || cmd === 'mega-export' || cmd === 'mega-put')) {
      try { attachAutoAcceptTerms(child, cmd.toUpperCase()); } catch {}
    }

    let out = '';
    let err = '';
    const limit = maxBytes || MAX_CMD_CAPTURE_BYTES;
    let truncatedOut = false;
    let truncatedErr = false;
    let settled = false;
    let timer = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };

    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const ok = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    // Timeout con kill del process tree
    const effectiveTimeoutMs = Number(timeoutMs || 0);
    if (effectiveTimeoutMs > 0) {
      timer = setTimeout(() => {
        try { killProcessTreeBestEffort(child, `TIMEOUT ${cmd}`); } catch {}
        fail(new Error(`${cmd} timeout after ${effectiveTimeoutMs}ms`));
      }, effectiveTimeoutMs);
    }

    // Captura con truncation de stdout
    child.stdout.on('data', (d) => {
      if (!truncatedOut) {
        const chunk = d.toString();
        if (out.length + chunk.length <= limit) {
          out += chunk;
        } else {
          const slice = limit - out.length;
          if (slice > 0) out += chunk.slice(0, slice);
          truncatedOut = true;
        }
      }
    });

    // Captura con truncation de stderr
    child.stderr.on('data', (d) => {
      if (!truncatedErr) {
        const chunk = d.toString();
        if (err.length + chunk.length <= limit) {
          err += chunk;
        } else {
          const slice = limit - err.length;
          if (slice > 0) err += chunk.slice(0, slice);
          truncatedErr = true;
        }
      }
    });

    // Error de spawn (e.g. comando no encontrado)
    child.on('error', (e) => {
      fail(new Error(`${cmd} spawn error: ${e.message}`));
    });

    // Proceso terminado
    child.on('close', (code) => {
      if (code === 0) {
        return ok({ out, err });
      }
      // Manejo especial: mega-mkdir ya existe → silenciar
      const msg = (err || out || '').slice(0, 500);
      if (!(cmd === 'mega-mkdir' && /already exists/i.test(msg)) && !isQuietCmd) {
        log.warn(`[MEGA-CMD] fail ${cmd} code=${code} msg=${msg.slice(0, 200)}`);
      }
      fail(new Error(err || out || `${cmd} exited with code ${code}`));
    });
  });
}
