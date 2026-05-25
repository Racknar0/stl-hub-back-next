/**
 * megaDfParser.js — Parser centralizado de salida de mega-df / mega-du.
 *
 * Combina las 4 implementaciones previas en un único módulo, corrigiendo:
 *  - Bug de default 'MB' en validateLastMeAccount.js (corregido a 'B')
 *  - Regex USED STORAGE faltante en validateLastMeAccount.js
 *  - Soporte completo EN + ES para todas las variantes de output de MEGAcmd
 */

// ─── stripAnsi ───────────────────────────────────────────────────
/**
 * Elimina secuencias de escape ANSI (colores, cursor) de un string.
 */
function stripAnsi(s = '') {
  return String(s).replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

// ─── parseSizeToMB ───────────────────────────────────────────────
/**
 * Convierte un string con unidad de tamaño (e.g. "18.11 GB", "1024 KB") a MB.
 * Default unit: 'B' (bytes) si no se detecta unidad.
 *
 * @param {string} str — String con tamaño (e.g. "18.11 GB")
 * @returns {number} Tamaño en MB redondeado
 */
export function parseSizeToMB(str) {
  if (!str) return 0;
  const s = String(str).trim().toUpperCase();
  const m = s.match(/([0-9.,]+)\s*([KMGT]?B)?/);
  if (!m) return 0;
  const num = parseFloat(m[1].replace(',', '.'));
  const unit = m[2] || 'B';
  const factor =
    unit === 'B'  ? 1 / (1024 * 1024) :
    unit === 'KB' ? 1 / 1024 :
    unit === 'MB' ? 1 :
    unit === 'GB' ? 1024 :
    unit === 'TB' ? 1024 * 1024 :
    1 / (1024 * 1024);
  return Math.round(num * factor);
}

// ─── parseStorageFromDfText ──────────────────────────────────────
/**
 * Parsea la salida de `mega-df -h` y extrae storageUsedMB y storageTotalMB.
 * Soporta todos los formatos conocidos de MEGAcmd (EN/ES, antiguo/nuevo).
 *
 * Cadena de regex (prioridad descendente):
 *  1. USED STORAGE: 18.11 GB  90.53% of 20.00 GB  (formato nuevo EN)
 *  2. ALMACENAMIENTO USADO: 18.11 GB  90.53% de 20.00 GB  (formato nuevo ES)
 *  3. USED STORAGE (variante laxa)
 *  4. Account storage: X / Y
 *  5. Storage: X of Y
 *  6. X / Y  (formato genérico slash)
 *  7. Almacenamiento de la cuenta: X de Y
 *  8. Almacenamiento: X de Y
 *  9. Percentage fallback: "90% of 20 GB"
 *
 * También extrae fileCount/folderCount del "Cloud drive:" line si está presente.
 *
 * @param {string} rawText — Salida raw de mega-df
 * @returns {{ storageUsedMB: number, storageTotalMB: number, fileCount: number, folderCount: number }}
 */
export function parseStorageFromDfText(rawText) {
  const txt = stripAnsi(String(rawText || ''));
  let storageUsedMB = 0;
  let storageTotalMB = 0;
  let fileCount = 0;
  let folderCount = 0;

  // 1-2. Formato principal: USED STORAGE / ALMACENAMIENTO USADO
  let m =
    txt.match(/(?:USED\s+STORAGE|ALMACENAMIENTO\s+USADO):\s*([0-9.,]+(?:\s*[KMGT]?B)?)\s+[0-9.,]+%?\s+(?:of|de)\s+([0-9.,]+(?:\s*[KMGT]?B)?)/i) ||
    txt.match(/USED\s+STORAGE:\s*([\d.,]+\s*[KMGT]?B).*?\bof\s*([\d.,]+\s*[KMGT]?B)/i);

  // 3. USED STORAGE variante laxa
  if (!m) {
    m = txt.match(/\bUSED\s+STORAGE\b.*?([\d.,]+\s*[KMGT]?B).*?\bof\s*([\d.,]+\s*[KMGT]?B)/i);
  }

  if (m) {
    storageUsedMB = parseSizeToMB(m[1]);
    storageTotalMB = parseSizeToMB(m[2]);
  }

  // 4-8. Fallback a formatos más antiguos (solo si no se encontró total)
  if (!storageTotalMB) {
    const mf =
      txt.match(/account\s+storage\s*:\s*([^/]+)\/\s*([^\n]+)/i) ||
      txt.match(/storage\s*:\s*([\d.,]+\s*[KMGT]?B)\s*of\s*([\d.,]+\s*[KMGT]?B)/i) ||
      txt.match(/([\d.,]+\s*[KMGT]?B)\s*\/\s*([\d.,]+\s*[KMGT]?B)/i) ||
      txt.match(/almacenamiento\s+de\s+la\s+cuenta\s*:\s*([^\n]+?)\s*de\s*([^\n]+)/i) ||
      txt.match(/almacenamiento\s*:\s*([\d.,]+\s*[KMGT]?B)\s*de\s*([\d.,]+\s*[KMGT]?B)/i);
    if (mf) {
      storageUsedMB = parseSizeToMB(mf[1]);
      storageTotalMB = parseSizeToMB(mf[2]);
    }
  }

  // 9. Percentage fallback: si solo tenemos un porcentaje y total
  if (!storageTotalMB) {
    const p =
      txt.match(/storage[^\n]*?:\s*([\d.,]+)\s*%[^\n]*?(?:of|de)\s*([\d.,]+\s*[KMGT]?B)[^\n]*?(?:used|usado)?/i) ||
      txt.match(/almacenamiento[^\n]*?:\s*([\d.,]+)\s*%[^\n]*?(?:de|of)\s*([\d.,]+\s*[KMGT]?B)[^\n]*?(?:usado|used)?/i);
    if (p) {
      storageTotalMB = parseSizeToMB(p[2]);
      const pct = parseFloat(String(p[1]).replace(',', '.'));
      if (!Number.isNaN(pct) && Number.isFinite(pct) && storageTotalMB > 0) {
        storageUsedMB = Math.round((pct / 100) * storageTotalMB);
      }
    }
  }

  // Cloud drive file/folder count
  const c = txt.match(/Cloud\s+drive:\s*[\d.,]+\s*[KMGT]?B\s+in\s+(\d+)\s+file\(s\)\s+and\s+(\d+)\s+folder\(s\)/i);
  if (c) {
    fileCount = Number(c[1]) || 0;
    folderCount = Number(c[2]) || 0;
  }

  return { storageUsedMB, storageTotalMB, fileCount, folderCount };
}

// ─── pickFirstFileFromLs ──────────────────────────────────────────
/**
 * Selecciona el primer archivo de la salida de mega-ls, priorizando archivos con extensión.
 *
 * @param {string} lsOut — Salida raw de mega-ls
 * @returns {string|null} Nombre del archivo seleccionado o null
 */
export function pickFirstFileFromLs(lsOut) {
  const lines = String(lsOut).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const withExt = lines.filter(l => /\.[A-Za-z0-9]{1,10}$/.test(l));
  return (withExt[0] || lines[0]) || null;
}

