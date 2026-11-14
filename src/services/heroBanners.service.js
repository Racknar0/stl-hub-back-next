import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { PrismaClient } from '@prisma/client';

export const HERO_SETTING_PREFIX = 'HOME_HERO_BANNERS:';
export const HERO_SLOTS = Object.freeze(['esDesktop', 'enDesktop', 'esMobile', 'enMobile']);
export const HERO_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const HERO_MAX_INPUT_PIXELS = 40_000_000;
export const HERO_COOKIE = 'stl_hero_last';
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class HeroBannerError extends Error {
  constructor(message, code = 'INVALID_HERO_BANNER', status = 400, fields) {
    super(message); this.name = 'HeroBannerError'; this.code = code; this.status = status;
    if (fields) this.fields = fields;
  }
}

export function requireHeroId(id) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new HeroBannerError('Identificador de banner inválido.', 'INVALID_ID');
  return id;
}

export function parseHeroBoolean(value, fallback) {
  if (value === undefined) return fallback;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new HeroBannerError('El estado debe ser verdadero o falso.', 'INVALID_STATE');
}

function text(value, label, maxLength, required = false) {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || value.trim().length > maxLength || (required && !value.trim())) {
    throw new HeroBannerError(`${label}: usa ${required ? 'entre 1 y ' : 'hasta '}${maxLength} caracteres.`, 'INVALID_TEXT');
  }
  return value.trim();
}

export function normalizeHeroFiles(files) {
  const normalized = {};
  for (const slot of HERO_SLOTS) {
    const values = Array.isArray(files?.[slot]) ? files[slot] : files?.[slot] ? [files[slot]] : [];
    if (values.length === 1) normalized[slot] = values[0];
    else if (values.length > 1) throw new HeroBannerError(`Solo se permite un archivo en ${slot}.`, 'DUPLICATE_COMPONENT', 400, [slot]);
  }
  const missing = HERO_SLOTS.filter(slot => !normalized[slot]);
  if (missing.length) throw new HeroBannerError('La variante necesita sus cuatro imágenes: español e inglés, escritorio y móvil.', 'MISSING_COMPONENTS', 400, missing);
  if (Object.keys(files || {}).some(slot => !HERO_SLOTS.includes(slot))) throw new HeroBannerError('Se recibió un componente de imagen desconocido.', 'UNKNOWN_COMPONENT');
  return normalized;
}

function slotLimits(slot) {
  if (!HERO_SLOTS.includes(slot)) throw new HeroBannerError('Componente de imagen desconocido.', 'UNKNOWN_COMPONENT');
  return slot.endsWith('Desktop')
    ? { ratio: 8 / 3, minWidth: 1024, minHeight: 384, width: 1920, height: 720, targetBytes: 300 * 1024 }
    : { ratio: 4 / 5, minWidth: 600, minHeight: 750, width: 960, height: 1200, targetBytes: 200 * 1024 };
}

export async function optimizeHeroImage(file, slot, { maxInputPixels = HERO_MAX_INPUT_PIXELS } = {}) {
  const limits = slotLimits(slot);
  let buffer = Buffer.isBuffer(file) ? file : file?.buffer;
  if (!buffer && file?.path) {
    const stat = await fs.stat(file.path);
    if (!stat.isFile() || stat.size > HERO_MAX_FILE_BYTES) throw new HeroBannerError('Cada imagen debe pesar como máximo 10 MB.', 'FILE_TOO_LARGE', 413, [slot]);
    buffer = await fs.readFile(file.path);
  }
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new HeroBannerError(`El archivo de ${slot} está vacío.`, 'EMPTY_IMAGE', 400, [slot]);
  if (buffer.length > HERO_MAX_FILE_BYTES) throw new HeroBannerError('Cada imagen debe pesar como máximo 10 MB.', 'FILE_TOO_LARGE', 413, [slot]);
  try {
    const metadata = await sharp(buffer, { limitInputPixels: maxInputPixels, failOn: 'error' }).metadata();
    const supported = ['jpeg', 'png', 'webp'].includes(metadata.format) || (metadata.format === 'heif' && metadata.compression === 'av1');
    if (!supported || (metadata.pages || 1) > 1) throw new HeroBannerError('Usa imágenes estáticas PNG, JPEG, WebP o AVIF.', 'UNSUPPORTED_IMAGE', 400, [slot]);
    const swap = [5, 6, 7, 8].includes(metadata.orientation);
    const width = swap ? metadata.height : metadata.width;
    const height = swap ? metadata.width : metadata.height;
    if (!width || !height || width * height > maxInputPixels) throw new HeroBannerError('La imagen supera el límite de píxeles.', 'PIXEL_LIMIT', 400, [slot]);
    if (width < limits.minWidth || height < limits.minHeight) throw new HeroBannerError(`${slot}: resolución mínima ${limits.minWidth} × ${limits.minHeight} px.`, 'IMAGE_TOO_SMALL', 400, [slot]);
    if (Math.abs(width / height / limits.ratio - 1) > 0.03) throw new HeroBannerError(`${slot}: la proporción debe ser ${slot.endsWith('Desktop') ? '8:3 para escritorio' : '4:5 para móvil'} (tolerancia 3 %).`, 'INVALID_ASPECT_RATIO', 400, [slot]);
    let result;
    // Quality has a floor: text legibility takes precedence over a rigid byte cap.
    for (const quality of [84, 82, 80, 78]) {
      const encoded = await sharp(buffer, { limitInputPixels: maxInputPixels, failOn: 'error' }).rotate()
        .resize(limits.width, limits.height, { fit: 'inside', withoutEnlargement: true })
        .flatten({ background: '#050408' }).webp({ quality, effort: 5 }).toBuffer({ resolveWithObject: true });
      result = { buffer: encoded.data, width: encoded.info.width, height: encoded.info.height, bytes: encoded.data.length, quality };
      if (result.bytes <= limits.targetBytes) break;
    }
    return result;
  } catch (error) {
    if (error instanceof HeroBannerError) throw error;
    if (/pixel limit|exceeds pixel/i.test(error.message || '')) throw new HeroBannerError('La imagen supera el límite de 40 megapíxeles.', 'PIXEL_LIMIT', 400, [slot]);
    throw new HeroBannerError(`No se pudo leer la imagen de ${slot}. Comprueba que el archivo no esté dañado.`, 'INVALID_IMAGE', 400, [slot]);
  }
}

export function isCompleteHeroVariant(variant) {
  if (!variant || !ID_PATTERN.test(variant.id || '')) return false;
  return HERO_SLOTS.every(slot => {
    const image = variant.images?.[slot];
    const expected = new RegExp(`^/uploads/hero-banners/${variant.id}/${slot}-[a-f0-9]{24}\\.webp$`);
    if (!image || !expected.test(image.url || '') || !Number.isInteger(image.width) || !Number.isInteger(image.height) || !Number.isInteger(image.bytes) || image.bytes <= 0) return false;
    const limits = slotLimits(slot);
    return image.width >= limits.minWidth && image.height >= limits.minHeight && Math.abs(image.width / image.height / limits.ratio - 1) <= 0.03;
  });
}

export function heroVariantFromCookie(header = '') {
  for (const entry of String(header).split(';')) {
    const [name, ...parts] = entry.trim().split('=');
    if (name === HERO_COOKIE && ID_PATTERN.test(parts.join('='))) return parts.join('=');
  }
  return null;
}

export function chooseHeroVariant(variants, seed, previousId = null) {
  if (!/^[a-f0-9]{32}$/.test(seed || '')) throw new HeroBannerError('Semilla inválida.', 'INVALID_SEED');
  const eligible = variants.filter(v => v.active && !v.archived && isCompleteHeroVariant(v)).sort((a, b) => a.id.localeCompare(b.id));
  if (!eligible.length) return null;
  const candidates = eligible.length > 1 ? eligible.filter(v => v.id !== previousId) : eligible;
  const index = createHash('sha256').update(seed).digest().readUInt32BE(0) % candidates.length;
  return candidates[index];
}

export const newHeroSeed = () => randomBytes(16).toString('hex');

export function createHeroBannersService({ prisma, uploadsRoot = path.resolve('uploads'), optimizeImage = optimizeHeroImage, clock = () => new Date(), idGenerator = randomUUID, publicCacheMs = 5000 }) {
  const heroRoot = path.resolve(uploadsRoot, 'hero-banners');
  let tail = Promise.resolve();
  let publicCache = { until: 0, variants: [] };
  let publicLoading;
  let revision = 0;
  const invalidate = () => { revision++; publicCache.until = 0; };
  const serial = operation => { const current = tail.then(operation); tail = current.catch(() => {}); return current; };
  const directory = id => {
    requireHeroId(id);
    const target = path.resolve(heroRoot, id);
    if (path.dirname(target) !== heroRoot) throw new HeroBannerError('Ruta de banner inválida.', 'INVALID_PATH');
    return target;
  };
  const decode = row => {
    if (!row) return null;
    try {
      const data = JSON.parse(row.value);
      return data.version === 1 && row.key === `${HERO_SETTING_PREFIX}${data.id}` && ID_PATTERN.test(data.id || '') ? data : null;
    } catch { return null; }
  };
  const adminList = async () => {
    const rows = await prisma.systemSetting.findMany({ where: { key: { startsWith: HERO_SETTING_PREFIX } } });
    return rows.map(decode).filter(Boolean).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  };
  const publicList = async () => {
    if (Date.now() < publicCache.until) return publicCache.variants;
    if (publicLoading) return publicLoading;
    const startedAtRevision = revision;
    publicLoading = (async () => {
      const candidates = (await adminList()).filter(v => v.active && !v.archived && isCompleteHeroVariant(v));
      const ready = await Promise.all(candidates.map(async variant => {
        const files = await Promise.all(HERO_SLOTS.map(async slot => {
          const info = await fs.stat(path.join(directory(variant.id), path.basename(variant.images[slot].url))).catch(() => null);
          return info?.isFile() && info.size === variant.images[slot].bytes;
        }));
        return files.every(Boolean) ? variant : null;
      }));
      const variants = ready.filter(Boolean).map(v => ({ id: v.id, name: v.name, active: true, altEs: v.altEs, altEn: v.altEn, images: v.images }));
      if (revision === startedAtRevision) publicCache = { until: Date.now() + publicCacheMs, variants };
      return variants;
    })();
    try { return await publicLoading; } finally { publicLoading = null; }
  };

  async function create(data, files, { seedKey } = {}) {
    return serial(async () => {
      const name = text(data?.name, 'Nombre', 120, true);
      const active = parseHeroBoolean(data?.active, true);
      const altEs = text(data?.altEs, 'Texto alternativo español', 240) || `Proyectos de impresión 3D: ${name}`;
      const altEn = text(data?.altEn, 'Texto alternativo inglés', 240) || `3D printing projects: ${name}`;
      if (seedKey !== undefined) {
        seedKey = text(seedKey, 'Clave de importación', 120, true);
        const existing = (await adminList()).find(v => v.seedKey === seedKey);
        if (existing) return { variant: existing, reused: true };
      }
      const inputs = normalizeHeroFiles(files);
      const optimized = {};
      for (const slot of HERO_SLOTS) optimized[slot] = await optimizeImage(inputs[slot], slot);
      const id = requireHeroId(idGenerator());
      await fs.mkdir(heroRoot, { recursive: true });
      const target = directory(id);
      let created = false;
      try {
        await fs.mkdir(target); created = true;
        const images = {};
        for (const slot of HERO_SLOTS) {
          const image = optimized[slot];
          const hash = createHash('sha256').update(image.buffer).digest('hex').slice(0, 24);
          const filename = `${slot}-${hash}.webp`;
          await fs.writeFile(path.join(target, filename), image.buffer, { flag: 'wx' });
          images[slot] = { url: `/uploads/hero-banners/${id}/${filename}`, width: image.width, height: image.height, bytes: image.bytes };
        }
        const timestamp = clock().toISOString();
        const variant = { version: 1, id, name, altEs, altEn, active, archived: false, images, createdAt: timestamp, updatedAt: timestamp, ...(seedKey ? { seedKey } : {}) };
        if (!isCompleteHeroVariant(variant)) throw new HeroBannerError('No se pudo completar el conjunto de cuatro imágenes.', 'INCOMPLETE_VARIANT');
        await prisma.systemSetting.create({ data: { key: `${HERO_SETTING_PREFIX}${id}`, value: JSON.stringify(variant), description: 'Variante completa del banner de inicio ES/EN y escritorio/móvil' } });
        invalidate();
        return { variant, reused: false };
      } catch (error) {
        // target is a freshly created UUID directory checked against the owned root.
        if (created) await fs.rm(directory(id), { recursive: true, force: true }).catch(() => {});
        throw error;
      }
    });
  }

  async function update(id, data = {}) {
    requireHeroId(id);
    return serial(async () => {
      const key = `${HERO_SETTING_PREFIX}${id}`;
      const row = await prisma.systemSetting.findUnique({ where: { key } });
      const variant = decode(row);
      if (!variant) throw new HeroBannerError('No se encontró el banner.', 'NOT_FOUND', 404);
      const next = { ...variant };
      if (data.name !== undefined) next.name = text(data.name, 'Nombre', 120, true);
      for (const prop of ['altEs', 'altEn']) if (data[prop] !== undefined) next[prop] = text(data[prop], 'Texto alternativo', 240);
      if (data.active !== undefined) next.active = parseHeroBoolean(data.active);
      if (data.archived !== undefined) next.archived = parseHeroBoolean(data.archived);
      if (next.archived) next.active = false;
      if (next.active) {
        if (!isCompleteHeroVariant(next)) throw new HeroBannerError('No se puede activar una variante sin sus cuatro componentes válidos.', 'INCOMPLETE_VARIANT');
        for (const slot of HERO_SLOTS) {
          const filename = path.basename(next.images[slot].url);
          const info = await fs.stat(path.join(directory(id), filename)).catch(() => null);
          if (!info?.isFile() || info.size !== next.images[slot].bytes) throw new HeroBannerError('Falta una imagen guardada; no se puede activar la variante.', 'MISSING_STORED_IMAGE', 400, [slot]);
        }
      }
      next.updatedAt = clock().toISOString();
      const result = await prisma.systemSetting.updateMany({ where: { key, value: row.value }, data: { value: JSON.stringify(next) } });
      if (result.count !== 1) throw new HeroBannerError('El banner cambió en otra sesión. Actualiza la lista e inténtalo de nuevo.', 'CONCURRENT_UPDATE', 409);
      invalidate();
      return next;
    });
  }

  return { listAdmin: adminList, listPublic: publicList, create, update, archive: id => update(id, { archived: true, active: false }) };
}

let singleton;
export function getHeroBannersService() {
  if (!singleton) singleton = createHeroBannersService({ prisma: new PrismaClient() });
  return singleton;
}
