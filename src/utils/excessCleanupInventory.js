import path from 'node:path';
import { cleanupError } from '../services/accountExcessCleanup.js';

const badPath = value => /[\x00-\x1f\x7f]/.test(value) || value.split('/').some(part => part === '.' || part === '..');
const inside = (base, value) => base === '/' || value === base || value.startsWith(`${base}/`);

function normalizedBase(baseFolder) {
  const base = String(baseFolder || '/').replaceAll('\\', '/');
  if (!base.startsWith('/') || badPath(base) || /[*?\[\]]/.test(base)) {
    throw cleanupError('La carpeta base de MEGA no es válida. Revisa la configuración de esta cuenta.');
  }
  return path.posix.normalize(base).replace(/\/$/, '') || '/';
}

function scopedPath(base, value, { heading = false } = {}) {
  if (heading && base === '/' && value === '') return '/';
  if (!value || badPath(value)) throw cleanupError('MEGA devolvió una ruta de archivo no válida. No se ha preparado ninguna eliminación.');
  let result;
  if (value.startsWith('/')) result = path.posix.normalize(value);
  // `ls -lR /STLHUB` can print `STLHUB/folder:` (root-relative headings).
  else if (heading && base !== '/' && (value === base.slice(1) || value.startsWith(`${base.slice(1)}/`))) result = path.posix.normalize(`/${value}`);
  else if (heading && base !== '/') throw cleanupError('La carpeta del listado de MEGA no coincide con la carpeta base de esta cuenta.');
  else result = path.posix.join(base, value);
  if (!inside(base, result)) throw cleanupError('El inventario contiene una ruta fuera de la carpeta de esta cuenta. Revisa su carpeta base.');
  return result;
}

export function expectedAssetPath(baseFolder, asset) {
  const base = normalizedBase(baseFolder);
  const slug = String(asset.slug || '');
  const archive = String(asset.archiveName || '').replaceAll('\\', '/');
  if (!slug || badPath(slug) || slug.includes('/') || !archive || badPath(archive)) return null;
  return path.posix.join(base, slug, path.posix.basename(archive));
}

// `find -l` prints "path <H:...> (size, ...)" without revision metadata.
// Use `ls -lR --show-handles --time-format=ISO6081_WITH_TIME` instead:
// folder headings + FLAGS VERS SIZE DATE HANDLE NAME. SIZE is exact bytes.
export function parseCleanupEntries(output, baseFolder) {
  const base = baseFolder === undefined ? null : normalizedBase(baseFolder);
  let folder = base;
  const entries = [];
  const paths = new Set();
  const handles = new Set();
  for (const raw of String(output).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').split(/\r?\n/)) {
    if (!raw.trim()) continue;
    if (/^\s*FLAGS\s+VERS\s+SIZE\s+DATE\s+HANDLE\s+NAME\s*$/.test(raw)) continue;
    const line = raw.trimStart();
    const match = line.match(/^([-dribx][a-z-]{3})\s+(\d+|>999|-)\s+(\d+|-)\s+(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2})?)\s+(H:[A-Za-z0-9_-]{8}) (.+)$/i);
    if (!match) {
      if (base && line.endsWith(':') && !/^[-dribx][a-z-]{3}\s/i.test(line)) {
        folder = scopedPath(base, line.slice(0, -1), { heading: true });
        continue;
      }
      throw cleanupError('No se pudo leer el listado de archivos de MEGA. El formato recibido no es compatible; no se ha preparado ninguna eliminación.');
    }
    if (match[1][0] !== '-') continue;
    const bytes = Number(match[3]);
    if (!/^\d+$/.test(match[3]) || !Number.isSafeInteger(bytes) || bytes < 0 || match[2] === '-') {
      throw cleanupError('MEGA devolvió un tamaño o una revisión de archivo no válida.');
    }
    const name = match[6];
    if (badPath(name)) throw cleanupError('MEGA devolvió una ruta de archivo no válida. No se ha preparado ninguna eliminación.');
    const filePath = base ? scopedPath(base, name.startsWith('/') ? name : path.posix.join(folder, name)) : name;
    if (badPath(filePath) || paths.has(filePath) || handles.has(match[5])) {
      throw cleanupError('El listado de MEGA contiene archivos duplicados o rutas ambiguas. Revisa esta cuenta antes de depurar.');
    }
    paths.add(filePath);
    handles.add(match[5]);
    entries.push({ sizeMB: bytes / 1048576, versions: match[2], modifiedAt: match[4], handle: match[5], path: filePath });
  }
  return entries;
}

function candidatePaths(base, asset, accountId) {
  const candidates = new Set();
  const archive = String(asset.archiveName || '').replaceAll('\\', '/');
  if (!archive || badPath(archive) || archive.startsWith('/')) return candidates;
  const filename = path.posix.basename(archive);
  if (archive.includes('/')) candidates.add(scopedPath(base, archive));
  const legacy = expectedAssetPath(base, asset);
  if (legacy) candidates.add(legacy);
  for (const replica of asset.replicas || []) {
    if (replica.accountId !== accountId || !replica.remotePath) continue;
    const replicaFolder = String(replica.remotePath).replaceAll('\\', '/');
    candidates.add(scopedPath(base, path.posix.join(scopedPath(base, replicaFolder), filename)));
  }
  return candidates;
}

export function inspectCleanupInventory(output, baseFolder, assets, accountId) {
  const base = normalizedBase(baseFolder);
  const expected = new Map();
  const expectedFolders = new Map();
  const protectedIds = new Set(assets.filter(asset => asset.cleanupProtected).map(asset => asset.id));
  for (const asset of assets) {
    for (const filePath of candidatePaths(base, asset, accountId)) {
      if (expected.has(filePath) && expected.get(filePath) !== asset.id) throw cleanupError('Dos modelos del catálogo apuntan al mismo archivo de MEGA. Revisa sus rutas antes de depurar.');
      expected.set(filePath, asset.id);
      const folder = path.posix.dirname(filePath);
      if (expectedFolders.has(folder) && expectedFolders.get(folder) !== asset.id) throw cleanupError('Dos modelos del catálogo comparten una carpeta de MEGA. No se puede determinar qué archivos pertenecen a cada uno; revisa sus rutas antes de depurar.');
      expectedFolders.set(folder, asset.id);
    }
  }
  const files = new Map();
  const unmatchedFiles = [];
  const protectedFiles = [];
  for (const entry of parseCleanupEntries(output, base)) {
    // Restore operations and original uploads can use another archive name or
    // extension. The model's own folder is authoritative when only one model
    // owns it; never guess from a basename or a folder higher in the tree.
    const assetId = expected.get(entry.path) ?? expectedFolders.get(path.posix.dirname(entry.path));
    const file = { ...entry, relativePath: path.posix.relative(base, entry.path), missing: false };
    if (assetId === undefined) {
      unmatchedFiles.push(file);
      continue;
    }
    if (protectedIds.has(assetId)) {
      protectedFiles.push({ ...file, assetId });
      continue;
    }
    const previous = files.get(assetId);
    if (!previous) {
      files.set(assetId, file);
      continue;
    }
    const entries = [...(previous.entries || [previous]), file];
    const folders = [...new Set(entries.map(item => path.posix.dirname(item.path)))];
    let folder = folders[0];
    for (const candidate of folders) while (!inside(folder, candidate)) folder = path.posix.dirname(folder);
    files.set(assetId, {
      sizeMB: entries.reduce((sum, item) => sum + item.sizeMB, 0),
      // This common ancestor is for display only. Deletion always uses each
      // explicit file handle from entries, never the bundle's folder path.
      entries, path: folder, relativePath: folders.length === 1 ? path.posix.relative(base, folder) : undefined, missing: false,
    });
  }
  return { files, unmatchedFiles, protectedFiles };
}

export function parseCleanupInventory(output, baseFolder, assets, accountId) {
  return inspectCleanupInventory(output, baseFolder, assets, accountId).files;
}
