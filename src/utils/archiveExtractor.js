/**
 * archiveExtractor.js — Extracción centralizada de archivos comprimidos.
 *
 * Combina las funciones duplicadas de batchImport.controller.js y batchWorker.js
 * en un único módulo reutilizable.
 *
 *  - run7z: ejecuta 7z con soporte opcional de progreso (onProgress callback)
 *  - runUnrar: ejecuta unrar con soporte opcional de progreso
 *  - extractArchiveWithFallback: intenta 7z, si falla con RAR → fallback a unrar
 *  - isUnsupportedArchiveMethodError: detecta errores de método no soportado
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

// ─── Resolver ruta de 7z según el SO ──────────────────────────────
const SEVEN_ZIP = (() => {
  if (process.platform !== 'win32') return '7z';
  const candidates = [
    'C:\\Program Files\\7-Zip\\7z.exe',
    'C:\\Program Files (x86)\\7-Zip\\7z.exe',
    path.join(process.env.LOCALAPPDATA || '', '7-Zip', '7z.exe'),
  ];
  for (const p of candidates) { if (fs.existsSync(p)) return p; }
  return '7z';
})();

// ─── run7z ────────────────────────────────────────────────────────
/**
 * Ejecuta 7z con los argumentos dados.
 *
 * @param {string[]} args — Argumentos para 7z
 * @param {object} [options]
 * @param {function} [options.onProgress] — Callback opcional: ({ percent, file, line, tool, source }) => void
 * @returns {Promise<string>} stdout
 */
export function run7z(args, options = {}) {
  const onProgress = typeof options?.onProgress === 'function' ? options.onProgress : null;
  return new Promise((resolve, reject) => {
    const child = spawn(SEVEN_ZIP, args, { shell: false });
    let out = '', err = '';
    let stdoutCarry = '';
    let stderrCarry = '';

    const emitProgressFromChunk = (chunkText, source) => {
      if (!onProgress) return;
      const lines = String(chunkText || '').split(/[\r\n]+/).map((l) => String(l || '').trim()).filter(Boolean);
      for (const ln of lines) {
        const pctMatch = ln.match(/(?:^|\s)(\d{1,3})%/);
        const pct = pctMatch ? Math.max(0, Math.min(100, Number(pctMatch[1] || 0))) : null;

        let file = '';
        const fileMatch = ln.match(/(?:extracting|extract)\s+(.+)$/i);
        if (fileMatch) {
          const candidate = String(fileMatch[1] || '').trim();
          if (candidate && !/^archive\s*:/i.test(candidate) && !/^path\s*=\s*/i.test(candidate)) {
            file = candidate;
          }
        }

        if (pct != null || file) {
          try { onProgress({ percent: pct, file, line: ln, tool: '7z', source }); } catch {}
        }
      }
    };

    child.stdout.on('data', d => {
      const txt = d.toString();
      out += txt;
      stdoutCarry += txt;
      const parts = stdoutCarry.split(/[\r\n]+/);
      stdoutCarry = parts.pop() || '';
      emitProgressFromChunk(parts.join('\n'), 'stdout');
    });

    child.stderr.on('data', d => {
      const txt = d.toString();
      err += txt;
      stderrCarry += txt;
      const parts = stderrCarry.split(/[\r\n]+/);
      stderrCarry = parts.pop() || '';
      emitProgressFromChunk(parts.join('\n'), 'stderr');
    });

    child.on('error', (e) => reject(new Error(`Spawn error: ${e.message}`)));
    child.on('close', code => {
      emitProgressFromChunk(stdoutCarry, 'stdout-tail');
      emitProgressFromChunk(stderrCarry, 'stderr-tail');
      if (code === 0) resolve(out);
      else reject(new Error(`7z exited ${code}: ${(err || out).slice(0, 300)}`));
    });
  });
}

// ─── runUnrar ─────────────────────────────────────────────────────
/**
 * Ejecuta unrar con los argumentos dados.
 *
 * @param {string[]} args — Argumentos para unrar
 * @param {object} [options]
 * @param {function} [options.onProgress] — Callback opcional: ({ percent, file, line, tool, source }) => void
 * @returns {Promise<string>} stdout
 */
export function runUnrar(args, options = {}) {
  const onProgress = typeof options?.onProgress === 'function' ? options.onProgress : null;
  return new Promise((resolve, reject) => {
    const child = spawn('unrar', args, { shell: false });
    let out = '', err = '';
    let stdoutCarry = '';
    let stderrCarry = '';

    const emitProgressFromChunk = (chunkText, source) => {
      if (!onProgress) return;
      const lines = String(chunkText || '').split(/[\r\n]+/).map((l) => String(l || '').trim()).filter(Boolean);
      for (const ln of lines) {
        const pctMatch = ln.match(/(?:^|\s)(\d{1,3})%/);
        const pct = pctMatch ? Math.max(0, Math.min(100, Number(pctMatch[1] || 0))) : null;
        const fileMatch = ln.match(/(?:extracting|extract)\s+(.+)$/i);
        const file = fileMatch ? String(fileMatch[1] || '').trim() : '';
        if (pct != null || file) {
          try { onProgress({ percent: pct, file, line: ln, tool: 'unrar', source }); } catch {}
        }
      }
    };

    child.stdout.on('data', d => {
      const txt = d.toString();
      out += txt;
      stdoutCarry += txt;
      const parts = stdoutCarry.split(/[\r\n]+/);
      stdoutCarry = parts.pop() || '';
      emitProgressFromChunk(parts.join('\n'), 'stdout');
    });

    child.stderr.on('data', d => {
      const txt = d.toString();
      err += txt;
      stderrCarry += txt;
      const parts = stderrCarry.split(/[\r\n]+/);
      stderrCarry = parts.pop() || '';
      emitProgressFromChunk(parts.join('\n'), 'stderr');
    });

    child.on('error', (e) => reject(new Error(`Spawn error: ${e.message}`)));
    child.on('close', code => {
      emitProgressFromChunk(stdoutCarry, 'stdout-tail');
      emitProgressFromChunk(stderrCarry, 'stderr-tail');
      if (code === 0) resolve(out);
      else reject(new Error(`unrar exited ${code}: ${(err || out).slice(0, 300)}`));
    });
  });
}

// ─── isUnsupportedArchiveMethodError ──────────────────────────────
/**
 * Detecta si el error indica un método de compresión no soportado.
 */
export function isUnsupportedArchiveMethodError(msg = '') {
  return /unsupported method|no implementado|not implemented/i.test(String(msg || ''));
}

// ─── extractArchiveWithFallback ───────────────────────────────────
/**
 * Extrae un archivo comprimido intentando 7z primero; si es .rar y falla
 * por método no soportado, hace fallback a unrar nativo.
 *
 * @param {string} archivePath — Ruta al archivo comprimido
 * @param {string} extractDir — Directorio de destino
 * @param {object} [options]
 * @param {function} [options.onProgress] — Callback de progreso (solo funciona si se pasan flags -bb1 -bsp1 en 7z)
 * @returns {Promise<{ tool: '7z' | 'unrar' }>}
 */
export async function extractArchiveWithFallback(archivePath, extractDir, options = {}) {
  const args7z = ['x', archivePath, `-o${extractDir}`, '-y', '-aoa'];
  // Si hay callback de progreso, agregar flags para que 7z emita output detallado
  if (options.onProgress) {
    args7z.push('-bb1', '-bsp1');
  }

  try {
    await run7z(args7z, options);
    return { tool: '7z' };
  } catch (e) {
    const firstErr = String(e?.message || e);
    const ext = path.extname(String(archivePath || '')).toLowerCase();
    if (ext !== '.rar' || !isUnsupportedArchiveMethodError(firstErr)) {
      throw e;
    }

    // Fallback para VPS con p7zip sin soporte completo de RAR.
    try {
      await runUnrar(['x', '-o+', '-y', archivePath, `${extractDir}${path.sep}`], options);
      return { tool: 'unrar' };
    } catch (e2) {
      const secondErr = String(e2?.message || e2);
      if (/spawn error:.*unrar/i.test(secondErr)) {
        throw new Error(
          `RAR no soportado por 7z y no existe 'unrar' instalado. Detalle 7z: ${firstErr.slice(0, 180)}`
        );
      }
      throw new Error(`7z: ${firstErr.slice(0, 160)} | unrar: ${secondErr.slice(0, 160)}`);
    }
  }
}
