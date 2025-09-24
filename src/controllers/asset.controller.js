import { PrismaClient } from '@prisma/client';
import path from 'path';
import fs from 'fs';
import sharp from 'sharp';
import { spawn } from 'child_process';
import { decryptToJson } from '../utils/cryptoUtils.js';
import jwt from 'jsonwebtoken'
import { withMegaLock } from '../utils/megaQueue.js'

const prisma = new PrismaClient();

// Progreso en memoria por assetId (0..100)
const progressMap = new Map();
// Progreso de réplicas: key `${assetId}:${accountId}` -> 0..100
const replicaProgressMap = new Map();

const UPLOADS_DIR = path.resolve('uploads');
const TEMP_DIR = path.join(UPLOADS_DIR, 'tmp');
const IMAGES_DIR = path.join(UPLOADS_DIR, 'images');
const ARCHIVES_DIR = path.join(UPLOADS_DIR, 'archives');

function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }
function safeName(s) { return String(s || '').trim().toLowerCase().replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120); }
function safeFileName(originalName) {
  const ext = path.extname(originalName) || '';
  const base = path.basename(originalName, ext).replace(/[^a-zA-Z0-9-_]+/g, '_').slice(0, 120) || 'file';
  return `${base}${ext}`;
}
// Limpieza de archivos temporales antiguos en uploads/tmp
function cleanTempDir(maxAgeMs = 20 * 60 * 1000) {
  try {
    const now = Date.now()
    if (!fs.existsSync(TEMP_DIR)) return
    const names = fs.readdirSync(TEMP_DIR)
    for (const name of names) {
      const p = path.join(TEMP_DIR, name)
      try {
        const st = fs.statSync(p)
        if (st.isFile()) {
          const age = now - st.mtimeMs
          if (age > maxAgeMs) {
            fs.unlinkSync(p)
          }
        }
      } catch (e) {
        // continuar
      }
    }
  } catch (e) {
    console.warn('[CLEANUP] temp dir cleanup warn:', e.message)
  }
}
function removeEmptyDirsUp(startDir, stopDir) {
  try {
    let dir = path.resolve(startDir)
    const stop = path.resolve(stopDir)
    while (dir.startsWith(stop)) {
      if (!fs.existsSync(dir)) { dir = path.dirname(dir); continue }
      const items = fs.readdirSync(dir)
      if (items.length === 0) {
        fs.rmdirSync(dir)
        if (dir === stop) break
        dir = path.dirname(dir)
      } else {
        break
      }
    }
  } catch (e) {
    console.warn('[CLEANUP] removeEmptyDirsUp warn:', e.message)
  }
}

// helpers para parsear categorías múltiples (por id o slug)
function parseCategoriesPayload(val) {
  // admite: [1,2] o ["anime","cosplay"] o "anime,cosplay"
  if (!val) return []
  let arr = []
  if (Array.isArray(val)) arr = val
  else {
    try { const j = JSON.parse(val); if (Array.isArray(j)) arr = j } catch { arr = String(val).split(',') }
  }
  return arr.map((v) => (typeof v === 'number' ? { id: v } : { slug: safeName(String(v)) })).filter(Boolean)
}

// Nueva: parseo para tags M:N por id o slug
function parseTagsPayload(val) {
  if (!val) return []
  let arr = []
  if (Array.isArray(val)) arr = val
  else {
    try { const j = JSON.parse(val); if (Array.isArray(j)) arr = j } catch { arr = String(val).split(',') }
  }
  return arr.map((v) => (typeof v === 'number' ? { id: v } : { slug: safeName(String(v)) })).filter(Boolean)
}

// Generar slug único (hasta maxTries variantes) evitando crear archivos/directorios basura con slug repetido
async function generateUniqueSlug(base, maxTries = 50) {
  const slugBase = base || 'asset'
  for (let i = 0; i < maxTries; i++) {
    const candidate = i === 0 ? slugBase : `${slugBase}-${i}`
    const exists = await prisma.asset.findUnique({ where: { slug: candidate }, select: { id: true } })
    if (!exists) return candidate
  }
  throw Object.assign(new Error('No unique slug available'), { code: 'SLUG_EXHAUSTED' })
}

// Listar y obtener
export const listAssets = async (req, res) => {
  try {
    const { q = '', pageIndex, pageSize, plan, isPremium } = req.query;
    const hasPagination = pageIndex !== undefined && pageSize !== undefined;

    // Construir filtro dinámico
    const where = {};
    if (q) {
      where.title = { contains: String(q) };
    }
    // plan=free|premium o isPremium=true|false
    const planStr = String(plan || '').toLowerCase();
    if (planStr === 'free') where.isPremium = false;
    else if (planStr === 'premium') where.isPremium = true;

    if (isPremium !== undefined && isPremium !== null && String(isPremium).length) {
      const b = String(isPremium).toLowerCase();
      if (b === 'true') where.isPremium = true;
      if (b === 'false') where.isPremium = false;
    }

    if (hasPagination) {
      const take = Math.max(1, Math.min(1000, Number(pageSize) || 50));
      const page = Math.max(0, Number(pageIndex) || 0);
      const skip = page * take;

      const [items, total] = await Promise.all([
        prisma.asset.findMany({
          where,
          include: {
            account: { select: { alias: true } },
            categories: { select: { id: true, name: true, nameEn: true, slug: true, slugEn: true } },
            tags: { select: { id: true, slug: true, name: true, nameEn: true } },
          },
          orderBy: { id: 'desc' },
          skip,
          take,
        }),
        prisma.asset.count({ where }),
      ]);

      return res.json({ items, total, page, pageSize: take });
    }

    const items = await prisma.asset.findMany({
      where,
      include: {
        account: { select: { alias: true } },
        categories: { select: { id: true, name: true, nameEn: true, slug: true, slugEn: true } },
        tags: { select: { id: true, slug: true, name: true, nameEn: true } },
      },
      orderBy: { id: 'desc' },
      take: 50,
    });
    return res.json(items);
  } catch (e) {
    console.error('[ASSETS] list error:', e);
    return res.status(500).json({ message: 'Error listing assets' });
  }
};

// Obtener un asset específico con relaciones básicas
export const getAsset = async (req, res) => {
  try {
    const id = Number(req.params.id)
    if (!id) return res.status(400).json({ message: 'Invalid id' })
    const asset = await prisma.asset.findUnique({
      where: { id },
      include: {
        account: { select: { id: true, alias: true, type: true } },
        categories: { select: { id: true, name: true, nameEn: true, slug: true, slugEn: true } },
        tags: { select: { id: true, name: true, nameEn: true, slug: true, slugEn: true } },
        replicas: { select: { id: true, accountId: true, status: true } }
      }
    })
    if (!asset) return res.status(404).json({ message: 'Asset not found' })
    return res.json(asset)
  } catch (e) {
    console.error('[ASSETS] getAsset error:', e)
    return res.status(500).json({ message: 'Error getting asset' })
  }
};


export const updateAsset = async (req, res) => {
  try {
    const id = Number(req.params.id)
    const existing = await prisma.asset.findUnique({ where: { id } })
    if (!existing) return res.status(404).json({ message: 'Asset not found' })

    const { title, titleEn, categories, tags, isPremium } = req.body
    const data = {}
    if (title !== undefined) data.title = String(title)
    if (titleEn !== undefined) data.titleEn = String(titleEn)
    if (typeof isPremium !== 'undefined') data.isPremium = Boolean(isPremium)

    const catsParsed = parseCategoriesPayload(categories)
    if (catsParsed.length) {
      data.categories = { set: [], connect: catsParsed }
    }

    const tagsParsed = parseTagsPayload(tags)
    if (tagsParsed.length) {
      data.tags = { set: [], connect: tagsParsed }
    }

    const updated = await prisma.asset.update({ where: { id }, data, include: { categories: true, tags: true } })
    return res.json(updated)
  } catch (e) {
    console.error('[ASSETS] update error:', e)
    return res.status(500).json({ message: 'Error updating asset' })
  }
}

// 1) Subida temporal de archivo principal
export const uploadArchiveTemp = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'archive file is required' });
    // Responder con path temporal y metadata
    return res.json({ tempPath: path.relative(UPLOADS_DIR, req.file.path), size: req.file.size, original: req.file.originalname });
  } catch (e) {
    console.error('[ASSETS] upload archive error:', e);
    return res.status(500).json({ message: 'Error uploading archive' });
  }
};

// 2) Crear asset en DB, mover archivo temporal a definitivo y generar estructura
export const createAsset = async (req, res) => {
  try {
    const { title, titleEn, categories, tags, isPremium, accountId, tempArchivePath, archiveOriginal } = req.body;
    if (!title) return res.status(400).json({ message: 'title required' });
    if (!accountId) return res.status(400).json({ message: 'accountId required' });
    const accId = Number(accountId);
    let slug
    try {
      slug = await generateUniqueSlug(safeName(title));
    } catch (e) {
      if (e.code === 'SLUG_EXHAUSTED') return res.status(409).json({ code: 'SLUG_CONFLICT', message: 'No hay slug disponible', base: safeName(title) })
      throw e
    }

    // carpeta final de archivo: archives/slug (sin categoría legado)
    const finalDir = path.join(ARCHIVES_DIR, slug);
    ensureDir(finalDir);

    let archiveName = null, archiveSizeB = null, megaLink = null;

    if (tempArchivePath) {
      const absTemp = path.join(UPLOADS_DIR, tempArchivePath);
      const fname = archiveOriginal ? safeFileName(archiveOriginal) : path.basename(absTemp);
      const target = path.join(finalDir, fname);
      fs.renameSync(absTemp, target);
      archiveName = path.relative(UPLOADS_DIR, target);
      const sz = fs.statSync(path.resolve(target)).size;
      archiveSizeB = sz;
      megaLink = megaLink;
    }

    const baseData = {
      title,
      titleEn: titleEn ? String(titleEn) : undefined,
      slug,
      isPremium: Boolean(isPremium),
      accountId: accId,
      archiveName,
      archiveSizeB,
      fileSizeB: archiveSizeB ?? null,
      megaLink,
      status: 'DRAFT',
    }

    // Conectar categorías/tags si se enviaron
    const catsParsed = parseCategoriesPayload(categories)
    const tagsParsed = parseTagsPayload(tags)

    try {
      const created = await prisma.asset.create({
        data: {
          ...baseData,
          ...(catsParsed.length ? { categories: { connect: catsParsed } } : {}),
          ...(tagsParsed.length ? { tags: { connect: tagsParsed } } : {}),
        },
      });
      return res.status(201).json(created);
    } catch (e) {
      if (e?.code === 'P2002') {
        return res.status(409).json({ code: 'SLUG_EXISTS', message: 'El slug ya existe', slug });
      }
      throw e
    }
  } catch (e) {
    console.error('[ASSETS] create error:', e);
    if (e?.code === 'SLUG_CONFLICT') return res.status(409).json({ code: 'SLUG_CONFLICT', message: 'No hay slug disponible' })
    return res.status(500).json({ message: 'Error creating asset', error: e.message });
  }
};

// 3) Subida de imágenes SOLO si ya existe el asset (para no orphan)
export const uploadImages = async (req, res) => {
  try {
    const assetId = Number(req.params.assetId);
    const asset = await prisma.asset.findUnique({ where: { id: assetId } });
    if (!asset) return res.status(404).json({ message: 'Asset not found' });

    const replacing = String(req.query?.replace || '').toLowerCase() === 'true'

    const slug = asset.slug;

    // NUEVO: carpeta imágenes: images/slug (sin categoría)
    const baseDir = path.join(IMAGES_DIR, slug);
    const thumbsDir = path.join(baseDir, 'thumbs');
    ensureDir(baseDir); ensureDir(thumbsDir);

    const files = req.files || [];
    const stored = [];

    if (replacing) {
      const prev = Array.isArray(asset.images) ? asset.images : []
      for (const rel of prev) {
        try {
          const abs = path.join(UPLOADS_DIR, rel)
          if (fs.existsSync(abs)) fs.unlinkSync(abs)
          removeEmptyDirsUp(path.dirname(abs), IMAGES_DIR)
        } catch (e) { console.warn('[ASSETS] replace cleanup warn:', e.message) }
      }
      try {
        if (fs.existsSync(thumbsDir)) {
          for (const f of fs.readdirSync(thumbsDir)) {
            try { fs.unlinkSync(path.join(thumbsDir, f)) } catch {}
          }
        }
      } catch {}
    }

    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const outName = `${Date.now()}_${i}.webp`;
      const dest = path.join(baseDir, outName);
      try {
        // Redimensionar a un ancho máximo de 700px manteniendo aspecto y sin ampliar
        await sharp(f.path)
          .rotate()
          .resize({ width: 700, withoutEnlargement: true })
          .webp({ quality: 80, effort: 6 })
          .toFile(dest);
      } finally {
        try { fs.unlinkSync(f.path) } catch {}
      }
      const rel = path.relative(UPLOADS_DIR, dest);
      stored.push(rel);
    }

    const toThumb = stored.slice(0, 2);
    const thumbs = [];
    for (let i = 0; i < toThumb.length; i++) {
      const src = path.join(UPLOADS_DIR, toThumb[i]);
      const out = path.join(thumbsDir, `thumb_${i + 1}.webp`);
      await sharp(src).resize(400, 400, { fit: 'inside' }).webp({ quality: 65, effort: 6 }).toFile(out);
      thumbs.push(path.relative(UPLOADS_DIR, out));
    }

    const imagesJson = Array.isArray(asset.images) ? asset.images : [];
    const newImages = replacing ? stored : imagesJson.concat(stored);

    const updated = await prisma.asset.update({
      where: { id: assetId },
      data: { images: newImages },
    });

    // Limpieza best-effort de temporales
    setTimeout(() => cleanTempDir(), 0)

    return res.json({ images: newImages, thumbs, replaced: replacing });
  } catch (e) {
    console.error('[ASSETS] upload images error:', e);
    return res.status(500).json({ message: 'Error uploading images' });
  }
};

// 4) Encolar subida a MEGA (solo el asset, no imágenes)
export const enqueueUploadToMega = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const asset = await prisma.asset.findUnique({ where: { id } });
    if (!asset) return res.status(404).json({ message: 'Asset not found' });

    const account = await prisma.megaAccount.findUnique({ where: { id: asset.accountId } });
    if (!account) return res.status(400).json({ message: 'Account not found' });

    const archiveAbs = asset.archiveName ? path.join(UPLOADS_DIR, asset.archiveName) : null;
    if (!archiveAbs || !fs.existsSync(archiveAbs)) return res.status(400).json({ message: 'Archive not found on server' });

    // Destino remoto en MEGA: raíz del baseFolder + slug (sin categoría)
    const remoteBase = account.baseFolder || '/';
    const remotePath = path.posix.join(remoteBase.replaceAll('\\', '/'), asset.slug);

    console.log(`[ASSETS] enqueue upload asset id=${id} to MEGA ${remotePath}`);

    const child = spawn('powershell.exe', ['-NoProfile', '-Command', `Write-Host "Uploading to MEGA... ${asset.slug}"; Start-Sleep -s 1; Write-Host "25%"; Start-Sleep -s 1; Write-Host "50%"; Start-Sleep -s 1; Write-Host "75%"; Start-Sleep -s 1; Write-Host "100% done"`], { shell: false });
    child.stdout.on('data', d => console.log(`[MEGA-UP] ${d.toString().trim()}`));
    child.stderr.on('data', d => console.error(`[MEGA-UP-ERR] ${d.toString().trim()}`));
    child.on('close', async (code) => {
      if (code === 0) {
        console.log(`[MEGA-UP] upload finished for asset id=${id}`);
        await prisma.asset.update({ where: { id }, data: { status: 'PUBLISHED' } });
      } else {
        console.error(`[MEGA-UP] upload failed for asset id=${id} code=${code}`);
        await prisma.asset.update({ where: { id }, data: { status: 'FAILED' } });
      }
    });

    await prisma.asset.update({ where: { id }, data: { status: 'PROCESSING' } });
    return res.json({ message: 'Enqueued', status: 'PROCESSING' });
  } catch (e) {
    console.error('[ASSETS] enqueue error:', e);
    return res.status(500).json({ message: 'Error enqueuing upload' });
  }
};

// Flujo unificado: recibe archivo + imágenes, crea asset atómico y encola subida a MEGA
export const createAssetFull = async (req, res) => {
  let cleanupPaths = [];
  try {
    const { title, titleEn, categories, tags, isPremium, accountId } = req.body;
    if (!title) return res.status(400).json({ message: 'title required' });
    if (!accountId) return res.status(400).json({ message: 'accountId required' });
    const accId = Number(accountId);

    const archiveFile = (req.files?.archive || [])[0];
    const imageFiles = (req.files?.images || []);
    if (!archiveFile) return res.status(400).json({ message: 'archive required' });

    let slug
    try {
      slug = await generateUniqueSlug(safeName(title));
    } catch (e) {
      if (e.code === 'SLUG_EXHAUSTED') return res.status(409).json({ code: 'SLUG_CONFLICT', message: 'No hay slug disponible', base: safeName(title) })
      throw e
    }

    // carpetas definitivas
    const archDir = path.join(ARCHIVES_DIR, slug); // archivo: sin carpeta por categoría
    const imgDir = path.join(IMAGES_DIR, slug); // imágenes solo por slug
    const thumbsDir = path.join(imgDir, 'thumbs');
    ensureDir(archDir); ensureDir(imgDir); ensureDir(thumbsDir);

    const targetName = safeFileName(archiveFile.originalname || archiveFile.filename);
    const archiveTarget = path.join(archDir, targetName);
    fs.renameSync(archiveFile.path, archiveTarget);

    const imagesRel = [];
    for (let i = 0; i < imageFiles.length; i++) {
      const f = imageFiles[i];
      const out = path.join(imgDir, `${Date.now()}_${i}.webp`);
      try {
        // Redimensionar a un ancho máximo de 700px manteniendo aspecto y sin ampliar
        await sharp(f.path)
          .rotate()
          .resize({ width: 700, withoutEnlargement: true })
          .webp({ quality: 80, effort: 6 })
          .toFile(out);
      } finally {
        try { fs.unlinkSync(f.path) } catch {}
      }
      imagesRel.push(path.relative(UPLOADS_DIR, out));
    }

    const thumbs = [];
    for (let i = 0; i < Math.min(2, imagesRel.length); i++) {
      const src = path.join(UPLOADS_DIR, imagesRel[i]);
      const out = path.join(thumbsDir, `thumb_${i + 1}.webp`);
      await sharp(src).resize(400, 400, { fit: 'inside' }).webp({ quality: 65, effort: 6 }).toFile(out);
      thumbs.push(path.relative(UPLOADS_DIR, out));
    }

    const baseData = {
      title,
      titleEn: titleEn ? String(titleEn) : undefined,
      slug,
      isPremium: Boolean(isPremium),
      accountId: accId,
      archiveName: path.relative(UPLOADS_DIR, archiveTarget),
      archiveSizeB: fs.statSync(archiveTarget).size,
      fileSizeB: fs.statSync(archiveTarget).size,
      images: imagesRel,
      status: 'PROCESSING',
    }

    const catsParsed = parseCategoriesPayload(categories)
    const tagsParsed = parseTagsPayload(tags)

    let created
    try {
      created = await prisma.asset.create({
        data: {
          ...baseData,
          ...(catsParsed.length ? { categories: { connect: catsParsed } } : {}),
          ...(tagsParsed.length ? { tags: { connect: tagsParsed } } : {}),
        },
      });
    } catch (e) {
      if (e?.code === 'P2002') {
        return res.status(409).json({ code: 'SLUG_EXISTS', message: 'El slug ya existe', slug });
      }
      throw e
    }

    enqueueToMegaReal(created).catch(err => console.error('[MEGA-UP] async error:', err));

    setTimeout(() => cleanTempDir(), 0)
    return res.status(201).json(created);
  } catch (e) {
    console.error('[ASSETS] createFull error:', e);
    try { cleanupPaths.forEach(p => { if (p && fs.existsSync(p)) fs.unlinkSync(p) }) } catch {}
    if (e?.code === 'SLUG_CONFLICT') return res.status(409).json({ code: 'SLUG_CONFLICT', message: 'No hay slug disponible' })
    return res.status(500).json({ message: 'Error creating asset', error: e.message });
  }
};

// Endpoint: progreso de subida a MEGA
export const getAssetProgress = async (req, res) => {
  try {
    const id = Number(req.params.id)
  const asset = await prisma.asset.findUnique({ where: { id }, select: { status: true, accountId: true, account: { select: { backups: { select: { backupAccount: { select: { id: true, alias: true, type: true } } } } } } } })
    if (!asset) return res.status(404).json({ message: 'Not found' })
    const progress = progressMap.get(id) ?? (asset.status === 'PUBLISHED' ? 100 : 0)
    return res.json({ status: asset.status, progress: Math.max(0, Math.min(100, Math.round(progress))) })
  } catch (e) {
    return res.status(500).json({ message: 'Error getting progress' })
  }
}

async function runCmd(cmd, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { shell: true, ...options });
    child.stdout.on('data', d => console.log(`[MEGA] ${d.toString().trim()}`));
    child.stderr.on('data', d => console.error(`[MEGA] ${d.toString().trim()}`));
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)) )
  })
}

// mega-mkdir retorna código 54 cuando la carpeta ya existe; lo tratamos como éxito silencioso.
async function safeMkdir(remotePath) {
  const mkdirCmd = 'mega-mkdir'
  return new Promise((resolve, reject) => {
    const child = spawn(mkdirCmd, ['-p', remotePath], { shell: true })
    let stderrBuf = ''
    child.stdout.on('data', d => console.log(`[MEGA] ${d.toString().trim()}`))
    child.stderr.on('data', d => {
      const s = d.toString(); stderrBuf += s; console.error(`[MEGA] ${s.trim()}`)
    })
    child.on('close', code => {
      if (code === 0) return resolve()
      if (code === 54 || /Folder already exists/i.test(stderrBuf)) {
        console.log(`[MEGA] mkdir exists (code=${code}) -> ok`) ; return resolve()
      }
      return reject(new Error(`${mkdirCmd} exited ${code}`))
    })
  })
}

// Helper: Auto-aceptar términos de MEGA cuando aparece el prompt
function attachAutoAcceptTerms(child, label = 'MEGA') {
  let answered = false
  let sawCopyright = false

  const ACCEPT_REGEXES = [
    /Do you accept\s+these\s+terms\??/i,
    /Do you accept.*terms\??/i,
    /Acepta[s]? .*t[ée]rminos\??/i,
  ]
  const COPYRIGHT_REGEXES = [
    /MEGA respects the copyrights/i,
    /You are strictly prohibited from using the MEGA cloud service/i,
    /copyright/i,
  ]

  const maybeAnswer = (s) => {
    if (answered) return
    if (COPYRIGHT_REGEXES.some(r => r.test(s))) {
      sawCopyright = true
    }
    if (ACCEPT_REGEXES.some(r => r.test(s))) {
      try { child.stdin.write('Yes\r\n'); answered = true; console.log(`[${label}] answered YES to terms`) } catch (err) { console.error(`[${label}] failed writing YES:`, err) }
      return
    }
    if (!answered && sawCopyright && /:\s*$/.test(s)) {
      try { child.stdin.write('Yes\r\n'); answered = true; console.log(`[${label}] answered YES (fallback)`) } catch (err) { console.error(`[${label}] failed writing YES (fallback):`, err) }
    }
  }

  const onData = (buf, isErr = false) => {
    const s = buf.toString()
    ;(isErr ? console.error : console.log)(`[${label}] ${s.trim()}`)
    maybeAnswer(s)
  }

  child.stdout.on('data', (d) => onData(d, false))
  child.stderr.on('data', (d) => onData(d, true))
}

export async function enqueueToMegaReal(asset) {
  const acc = await prisma.megaAccount.findUnique({ where: { id: asset.accountId }, include: { credentials: true } })
  if (!acc) throw new Error('Account not found')
  if (!acc.credentials) throw new Error('No credentials stored')

  const payload = decryptToJson(acc.credentials.encData, acc.credentials.encIv, acc.credentials.encTag)
  const loginCmd = 'mega-login'
  const mkdirCmd = 'mega-mkdir'
  const putCmd = 'mega-put'
  const logoutCmd = 'mega-logout'
  const remoteBase = (acc.baseFolder || '/').replaceAll('\\', '/')
  const remotePath = path.posix.join(remoteBase, asset.slug)
  const localArchive = asset.archiveName ? path.join(UPLOADS_DIR, asset.archiveName) : null
  console.log(`[MEGA-UP] start asset id=${asset.id} to ${remotePath}`)

  const parseProgress = (buf) => {
    const txt = buf.toString()
    let last = null
    const re = /([0-9]{1,3}(?:\.[0-9]+)?)\s*%/g
    let m
    while ((m = re.exec(txt)) !== null) last = m[1]
    if (last !== null) {
      const p = Math.max(0, Math.min(100, parseFloat(last)))
      progressMap.set(asset.id, p)
    }
    if (/upload finished/i.test(txt)) progressMap.set(asset.id, 100)
  }

  try {
    progressMap.set(asset.id, 0)
    await withMegaLock(async () => {
      try { await runCmd(logoutCmd, []) } catch {}
      if (payload?.type === 'session' && payload.session) await runCmd(loginCmd, [payload.session])
      else if (payload?.username && payload?.password) await runCmd(loginCmd, [payload.username, payload.password])
      else throw new Error('Invalid credentials payload')
  // Crear carpeta (ignorar si ya existe)
  await safeMkdir(remotePath)
      if (!localArchive || !fs.existsSync(localArchive)) throw new Error('Local archive not found')
      await new Promise((resolve, reject) => {
        const child = spawn(putCmd, [localArchive, remotePath], { shell: true })
        attachAutoAcceptTerms(child, 'MEGA PUT')
        child.stdout.on('data', d => parseProgress(d))
        child.stderr.on('data', d => parseProgress(d))
        child.on('close', code => code === 0 ? resolve() : reject(new Error(`${putCmd} exited ${code}`)))
      })
      let publicLink = null
      try {
        const remoteFilePath = path.posix.join(remotePath, path.basename(localArchive))
        const out = await new Promise((resolve, reject) => {
          let buffer = ''
          const child = spawn('mega-export', ['-a', remoteFilePath], { shell: true })
          attachAutoAcceptTerms(child, 'MEGA EXPORT')
          child.stdout.on('data', d => buffer += d.toString())
          child.stderr.on('data', d => buffer += d.toString())
          child.on('close', code => code === 0 ? resolve(buffer) : reject(new Error('export failed')))
        })
        const m = String(out).match(/https?:\/\/mega\.nz\/\S+/i)
        if (m) publicLink = m[0]
      } catch (e) { console.warn('[MEGA-UP] export warn:', e.message) }
      function stripArchivesPrefix(absPath) {
        const relFromArchives = path.relative(ARCHIVES_DIR, absPath)
        if (!relFromArchives.startsWith('..')) return relFromArchives
        const relFromUploads = path.relative(UPLOADS_DIR, absPath)
        return relFromUploads.replace(/^archives[\\/]/i, '')
      }
      const nameWithoutPrefix = stripArchivesPrefix(localArchive)
      await prisma.asset.update({ where: { id: asset.id }, data: { status: 'PUBLISHED', archiveName: nameWithoutPrefix, megaLink: publicLink || undefined } })
    }, 'MAIN-UPLOAD')
    console.log(`[MEGA-UP] done asset id=${asset.id}`)
  } catch (e) {
    console.error('[MEGA-UP] error:', e)
    await prisma.asset.update({ where: { id: asset.id }, data: { status: 'FAILED' } })
    throw e
  } finally {
    progressMap.delete(asset.id)
    try { await runCmd(logoutCmd, []) } catch {}
  }

  try { replicateAssetToBackupsSequential(asset.id).catch(err => console.error('[REPLICA] async error:', err)) } catch (e) { console.error('[REPLICA] schedule error:', e.message) }
}

// Secuencial: toma backups relacionados al main account y replica el archivo (archiveName) creando carpeta slug
async function replicateAssetToBackupsSequential(assetId) {
  const asset = await prisma.asset.findUnique({ where: { id: assetId }, include: { account: { include: { backups: { include: { backupAccount: { include: { credentials: true } } } } } }, replicas: true } })
  if (!asset) return
  if (!asset.archiveName) return // nada que replicar
  const archiveAbs = path.join(UPLOADS_DIR, asset.archiveName.startsWith('archives') ? asset.archiveName : path.join('archives', asset.archiveName))
  // Si ya se eliminó tras subida principal no podemos replicar -> abortar
  if (!fs.existsSync(archiveAbs)) {
    console.warn('[REPLICA] local archive missing, skip replicas')
    return
  }
  // Backups definidos para la cuenta principal
  const backupAccounts = (asset.account.backups || []).map(b => b.backupAccount).filter(b => b && b.type === 'backup')
  if (!backupAccounts.length) { console.log(`[REPLICA] asset=${asset.id} sin backups -> no se replica`); return }
  console.log(`[REPLICA] asset=${asset.id} se replicará a ${backupAccounts.length} cuentas backup`)

  // Asegurar filas de replicas PENDING
  for (const b of backupAccounts) {
    try {
      await prisma.assetReplica.upsert({
        where: { assetId_accountId: { assetId: asset.id, accountId: b.id } },
        update: {},
        create: { assetId: asset.id, accountId: b.id }
      })
    } catch (e) { console.warn('[REPLICA] upsert warn:', e.message) }
  }

  for (const b of backupAccounts) {
    let replica
    try { replica = await prisma.assetReplica.findUnique({ where: { assetId_accountId: { assetId: asset.id, accountId: b.id } } }) } catch {}
    if (!replica || replica.status !== 'PENDING') continue
    console.log(`[REPLICA] start asset=${asset.id} -> backupAccount=${b.id}`)
    try {
      await prisma.assetReplica.update({ where: { id: replica.id }, data: { status: 'PROCESSING', startedAt: new Date() } })
      if (!b.credentials) throw new Error('No credentials stored for backup')
      const payload = decryptToJson(b.credentials.encData, b.credentials.encIv, b.credentials.encTag)
      const loginCmd = 'mega-login'
      const mkdirCmd = 'mega-mkdir'
      const putCmd = 'mega-put'
      const exportCmd = 'mega-export'
      const logoutCmd = 'mega-logout'
      const remoteBase = (b.baseFolder || '/').replaceAll('\\', '/')
      const remotePath = path.posix.join(remoteBase, asset.slug)
      let publicLink = null
      await withMegaLock(async () => {
        try { await runCmd(logoutCmd, []) } catch {}
        if (payload?.type === 'session' && payload.session) await runCmd(loginCmd, [payload.session])
        else if (payload?.username && payload?.password) await runCmd(loginCmd, [payload.username, payload.password])
        else throw new Error('Invalid credentials')
  await safeMkdir(remotePath)
        const fileName = path.basename(archiveAbs)
        await new Promise((resolve, reject) => {
          const child = spawn(putCmd, [archiveAbs, remotePath], { shell: true })
          attachAutoAcceptTerms(child, `REPLICA PUT acc=${b.id}`)
          let lastLogged = -1
          const parseProgress = (buf) => {
            const txt = buf.toString()
            let last = null
            const re = /([0-9]{1,3}(?:\.[0-9]+)?)\s*%/g
            let m
            while ((m = re.exec(txt)) !== null) last = m[1]
            if (last !== null) {
              const p = Math.max(0, Math.min(100, parseFloat(last)))
              if (p !== lastLogged) {
                lastLogged = p
                console.log(`[REPLICA] asset=${asset.id} backupAccount=${b.id} progreso ${p}%`)
                replicaProgressMap.set(`${asset.id}:${b.id}`, p)
              }
            }
          }
          child.stdout.on('data', d => parseProgress(d))
          child.stderr.on('data', d => parseProgress(d))
          child.on('close', code => code === 0 ? resolve() : reject(new Error(`${putCmd} exited ${code}`)))
        })
        try {
          const remoteFile = path.posix.join(remotePath, fileName)
          const out = await new Promise((resolve, reject) => {
            let buf = ''
            const child = spawn(exportCmd, ['-a', remoteFile], { shell: true })
            attachAutoAcceptTerms(child, 'REPLICA EXPORT')
            child.stdout.on('data', d => buf += d.toString())
            child.stderr.on('data', d => buf += d.toString())
            child.on('close', code => code === 0 ? resolve(buf) : reject(new Error('export failed')))
          })
          const m = String(out).match(/https?:\/\/mega\.nz\/\S+/i)
          if (m) publicLink = m[0]
        } catch (e) {
          console.warn('[REPLICA] export warn:', e.message)
        }
        try { await runCmd(logoutCmd, []) } catch {}
      }, `REPLICA-${b.id}`)
      replicaProgressMap.set(`${asset.id}:${b.id}`, 100)
      await prisma.assetReplica.update({ where: { id: replica.id }, data: { status: 'COMPLETED', finishedAt: new Date(), megaLink: publicLink || undefined, remotePath } })
      console.log(`[REPLICA] completed asset=${asset.id} backupAccount=${b.id}`)
    } catch (err) {
      console.error('[REPLICA] error backupAccount=' + b.id, err)
      try { await prisma.assetReplica.update({ where: { id: replica.id }, data: { status: 'FAILED', errorMessage: err.message, finishedAt: new Date() } }) } catch {}
      replicaProgressMap.delete(`${asset.id}:${b.id}`)
    }
    // Limpieza de progreso en memoria si ya terminó (COMPLETED o FAILED)
    try { const r = await prisma.assetReplica.findUnique({ where: { id: replica.id }, select: { status: true, accountId: true } }); if (r && (r.status === 'COMPLETED' || r.status === 'FAILED')) replicaProgressMap.delete(`${asset.id}:${r.accountId}`) } catch {}
  }

  // Cuando todas finalizan (o fallan) eliminar archivo local (si existe)
  try {
    const remainProcessing = await prisma.assetReplica.count({ where: { assetId: asset.id, status: { in: ['PENDING', 'PROCESSING'] } } })
    if (remainProcessing === 0 && fs.existsSync(archiveAbs)) {
      try { fs.unlinkSync(archiveAbs) } catch {}
      try { removeEmptyDirsUp(path.dirname(archiveAbs), ARCHIVES_DIR) } catch {}
    }
  } catch {}
  // Limpiar progresos restantes del asset
  for (const key of Array.from(replicaProgressMap.keys())) if (key.startsWith(`${asset.id}:`)) replicaProgressMap.delete(key)
}

// Endpoint para listar réplicas de un asset
export const listAssetReplicas = async (req, res) => {
  try {
    const id = Number(req.params.id)
    const rows = await prisma.assetReplica.findMany({ where: { assetId: id }, include: { account: { select: { id: true, alias: true } } }, orderBy: { id: 'asc' } })
    const enriched = rows.map(r => ({ ...r, progress: replicaProgressMap.get(`${id}:${r.accountId}`) ?? (r.status === 'COMPLETED' ? 100 :  r.status === 'PROCESSING' ? 0 : 0) }))
    return res.json(enriched)
  } catch (e) {
    return res.status(500).json({ message: 'Error listing replicas' })
  }
}

// Progreso completo (principal + replicas)
export const getFullProgress = async (req, res) => {
  try {
    const id = Number(req.params.id)
    const asset = await prisma.asset.findUnique({ where: { id }, select: { status: true, accountId: true } })
    if (!asset) return res.status(404).json({ message: 'Not found' })
    let expectedReplicas = []
    try {
      const links = await prisma.megaAccountBackup.findMany({
        where: { mainAccountId: asset.accountId },
        include: { backupAccount: { select: { id: true, alias: true, type: true } } }
      })
      expectedReplicas = links
        .map(l => l.backupAccount)
        .filter(b => b && b.type === 'backup')
        .map(b => ({ accountId: b.id, alias: b.alias }))
    } catch (err) { console.warn('[ASSETS] expectedReplicas warn:', err.message) }
    const mainProgress = progressMap.get(id) ?? (asset.status === 'PUBLISHED' ? 100 : 0)
    const replicas = await prisma.assetReplica.findMany({ where: { assetId: id }, include: { account: { select: { id: true, alias: true } } } })
    const replicaItems = replicas.map(r => {
      const inMem = replicaProgressMap.get(`${id}:${r.accountId}`)
      let p = inMem ?? (r.status === 'COMPLETED' ? 100 : 0)
      if (r.status === 'FAILED') p = 100
      return { id: r.id, accountId: r.accountId, alias: r.account.alias, status: r.status, progress: p }
    })
    const totalTargets = 1 + replicaItems.length
    const perTarget = [mainProgress, ...replicaItems.map(r => r.progress)]
    const overallPercent = perTarget.length ? Math.round(perTarget.reduce((a,b) => a + b, 0) / perTarget.length) : mainProgress
    const allDone = (asset.status === 'PUBLISHED' || asset.status === 'FAILED') && replicaItems.every(r => ['COMPLETED','FAILED'].includes(r.status))
    return res.json({ main: { status: asset.status, progress: mainProgress }, replicas: replicaItems, totalTargets, overallPercent, allDone, expectedReplicas })
  } catch (e) {
    console.error('[ASSETS] fullProgress error:', e)
    return res.status(500).json({ message: 'Error getting full progress' })
  }
}

// DELETE /api/assets/:id
export const deleteAsset = async (req, res) => {
  const id = Number(req.params.id)
  try {
    const asset = await prisma.asset.findUnique({ where: { id }, include: { account: { include: { credentials: true } }, replicas: { include: { account: { include: { credentials: true } } } } } })
    if (!asset) return res.status(404).json({ message: 'Asset not found' })

    const imgDir = path.join(IMAGES_DIR, asset.slug) // imágenes por slug
    const archDir = path.join(ARCHIVES_DIR, asset.slug) // archivo por slug

    // Borrar archivos locales (imágenes, thumbs y archivo)
    try { if (fs.existsSync(imgDir)) fs.rmSync(imgDir, { recursive: true, force: true }) } catch (e) { console.warn('[ASSETS] rm images warn:', e.message) }
    try { if (fs.existsSync(archDir)) fs.rmSync(archDir, { recursive: true, force: true }) } catch (e) { console.warn('[ASSETS] rm archives warn:', e.message) }
    try { removeEmptyDirsUp(path.dirname(imgDir), IMAGES_DIR) } catch {}
    try { removeEmptyDirsUp(path.dirname(archDir), ARCHIVES_DIR) } catch {}

    // Recolectar cuentas a borrar: principal + backups (de replicas existentes)
    const accountsToDelete = []
    if (asset.account && asset.account.credentials) accountsToDelete.push({ kind: 'main', acc: asset.account })
    const backupSeen = new Set()
    for (const r of asset.replicas || []) {
      if (r.account && r.account.credentials && !backupSeen.has(r.account.id)) {
        backupSeen.add(r.account.id)
        accountsToDelete.push({ kind: 'backup', acc: r.account })
      }
    }

    const loginCmd = 'mega-login'
    const rmCmd = 'mega-rm'
    const logoutCmd = 'mega-logout'

    const results = []
    for (const entry of accountsToDelete) {
      const { acc } = entry
      let deleted = false
      try {
        const payload = decryptToJson(acc.credentials.encData, acc.credentials.encIv, acc.credentials.encTag)
        const remoteBase = (acc.baseFolder || '/').replaceAll('\\', '/')
        const remotePath = path.posix.join(remoteBase, asset.slug)
        await withMegaLock(async () => {
          try { await runCmd(logoutCmd, []) } catch {}
          if (payload?.type === 'session' && payload.session) await runCmd(loginCmd, [payload.session])
          else if (payload?.username && payload?.password) await runCmd(loginCmd, [payload.username, payload.password])
          else throw new Error('Invalid credentials payload')
          try { await runCmd(rmCmd, ['-rf', remotePath]) ; deleted = true } catch (e) { console.warn(`[ASSETS] rm warn acc=${acc.id}:`, e.message) }
          try { await runCmd(logoutCmd, []) } catch {}
        }, `DEL-${acc.id}`)
      } catch (e) {
        console.warn('[ASSETS] mega delete warn acc=' + acc.id, e.message)
      }
      results.push({ accountId: acc.id, kind: entry.kind, deleted })
    }

    // Eliminar de DB (asset + replicas cascada si FK ON DELETE CASCADE)
    await prisma.asset.delete({ where: { id } })

    const mainResult = results.find(r => r.kind === 'main')
    return res.json({ dbDeleted: true, megaDeleted: mainResult?.deleted || false, results })
  } catch (e) {
    console.error('[ASSETS] delete error:', e)
    return res.status(500).json({ message: 'Error deleting asset' })
  }
}

// Obtener últimas N novedades (publicadas)
export const latestAssets = async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 20))
    const items = await prisma.asset.findMany({
      where: { status: 'PUBLISHED' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
      select: {
        id: true,
        title: true,
        titleEn: true,
        images: true,
        isPremium: true,
        categories: { select: { id: true, name: true, nameEn: true, slug: true, slugEn: true } },
        tags: { select: { slug: true, name: true, nameEn: true } },
      },
    })

    const enriched = items.map(it => {
      const tagsEs = Array.isArray(it.tags) ? it.tags.map(t => t.slug) : []
      const tagsEn = Array.isArray(it.tags) ? it.tags.map(t => t.nameEn || t.name || t.slug) : []
      return { ...it, tagsEs, tagsEn }
    })

    return res.json(enriched)
  } catch (e) {
    console.error('[ASSETS] latest error:', e)
    return res.status(500).json({ message: 'Error getting latest assets' })
  }
}

// Obtener más descargados (publicados)
export const mostDownloadedAssets = async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 20))
    const items = await prisma.asset.findMany({
      where: { status: 'PUBLISHED' },
      orderBy: [{ downloads: 'desc' }, { id: 'desc' }],
      take: limit,
      select: {
        id: true,
        title: true,
        titleEn: true,
        images: true,
        isPremium: true,
        downloads: true,
        categories: { select: { id: true, name: true, nameEn: true, slug: true, slugEn: true } },
        tags: { select: { slug: true, name: true, nameEn: true } },
      },
    })

    const enriched = items.map(it => {
      const tagsEs = Array.isArray(it.tags) ? it.tags.map(t => t.slug) : []
      const tagsEn = Array.isArray(it.tags) ? it.tags.map(t => t.nameEn || t.name || t.slug) : []
      return { ...it, tagsEs, tagsEn }
    })

    return res.json(enriched)
  } catch (e) {
    console.error('[ASSETS] mostDownloaded error:', e)
    return res.status(500).json({ message: 'Error getting most downloaded assets' })
  }
}

// Búsqueda pública con filtros por categorías, tags y texto libre
export const searchAssets = async (req, res) => {
  try {
    const { q = '', categories = '', tags = '', order = '', plan, isPremium } = req.query || {};

    const qStr = String(q || '').trim();
    const qLower = qStr.toLowerCase();
    const qSlug = qLower.replace(/[^a-z0-9-_]+/g, '-');

    const catListRaw = String(categories || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const catList = catListRaw.map((s) => safeName(s));

    const tagTokens = String(tags || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);

    let resolvedTagSlugsSet = new Set();
    if (tagTokens.length) {
      try {
        const rows = await prisma.tag.findMany({
          where: { OR: [ { slug: { in: tagTokens } }, { slugEn: { in: tagTokens } } ] },
          select: { slug: true },
        });
        for (const r of rows) resolvedTagSlugsSet.add(String(r.slug).toLowerCase());
        for (const t of tagTokens) resolvedTagSlugsSet.add(t);
      } catch (e) {
        resolvedTagSlugsSet = new Set(tagTokens);
      }
    }

    const where = { status: 'PUBLISHED' };
    // Filtro por plan o isPremium: plan=free|premium o isPremium=true|false
    const planStr = String(plan || '').toLowerCase();
    if (planStr === 'free') where.isPremium = false;
    else if (planStr === 'premium') where.isPremium = true;
    if (isPremium !== undefined && String(isPremium).length) {
      const b = String(isPremium).toLowerCase();
      if (b === 'true') where.isPremium = true;
      if (b === 'false') where.isPremium = false;
    }

    const andArr = [];
    if (catList.length) {
      andArr.push({ OR: [
        { categories: { some: { slug: { in: catList } } } },
        { categories: { some: { slugEn: { in: catList } } } },
      ]});
    }
    const tagList = Array.from(resolvedTagSlugsSet);
    if (tagList.length) {
      andArr.push({ tags: { some: { slug: { in: tagList } } } });
    }
    if (andArr.length) where.AND = andArr;

    const itemsDb = await prisma.asset.findMany({
      where,
      orderBy: String(order).toLowerCase() === 'downloads' ? [{ downloads: 'desc' }, { id: 'desc' }] : { id: 'desc' },
      take: 1000,
      select: {
        id: true,
        title: true,
        titleEn: true,
        images: true,
        isPremium: true,
        downloads: true,
        categories: { select: { id: true, name: true, nameEn: true, slug: true, slugEn: true } },
        tags: { select: { slug: true, slugEn: true, name: true, nameEn: true } },
      },
    });

    const scored = [];
    for (const it of itemsDb) {
      if (!qLower) { scored.push({ it, score: 0 }); continue; }

      const title = String(it.title || '');
      const titleEn = String(it.titleEn || '');
      const descr = String(it.description || '');
      const arch = String(it.archiveName || '');
      const imgs = Array.isArray(it.images) ? it.images : [];

      const tagsArr = Array.isArray(it.tags) ? it.tags : [];
      const catsArr = Array.isArray(it.categories) ? it.categories : [];

      const titleL = title.toLowerCase();
      const titleEnL = titleEn.toLowerCase();
      const descrL = descr.toLowerCase();
      const archL = arch.toLowerCase();
      const imgsL = imgs.map((p) => String(p).toLowerCase());

      const tagsTexts = tagsArr.flatMap(t => [t.slug, t.slugEn, t.name, t.nameEn].filter(Boolean).map(String));
      const catsTexts = catsArr.flatMap(c => [c.slug, c.slugEn, c.name, c.nameEn].filter(Boolean).map(String));
      const tagsL = tagsTexts.map(x => x.toLowerCase());
      const catsL = catsTexts.map(x => x.toLowerCase());

      let score = 0;
      if (titleL.includes(qLower)) score += 120;
      if (titleEnL.includes(qLower)) score += 115;
      if (archL && archL.includes(qLower)) score += 90;
      if (imgsL.some((p) => p.includes(qLower))) score += 85;
      if (tagsL.some((t) => t.includes(qLower))) score += 75;
      if (catsL.some((c) => c.includes(qLower))) score += 55;
      if (descrL.includes(qLower)) score += 35;
      if (titleL.startsWith(qLower) || titleEnL.startsWith(qLower)) score += 10;

      if (score > 0) scored.push({ it, score });
    }

    if (qLower) {
      scored.sort((a, b) => (b.score - a.score) || (b.it.id - a.it.id));
    } else if (String(order).toLowerCase() === 'downloads') {
      scored.sort((a,b)=> (b.it.downloads - a.it.downloads) || (b.it.id - a.it.id))
    }

    const out = (qLower ? scored.map(({ it }) => it) : itemsDb).slice(0, 200);

    const enriched = out.map((it) => {
      const rest = { ...it };
      delete rest.megaLink;
      const tagsEs = Array.isArray(it.tags) ? it.tags.map(t => t.slug) : [];
      const tagsEn = Array.isArray(it.tags) ? it.tags.map(t => t.nameEn || t.name || t.slug) : [];
      return { ...rest, tagsEs, tagsEn };
    });

    return res.json({ items: enriched });
  } catch (e) {
    console.error('[ASSETS] search error:', e);
    return res.status(500).json({ message: 'Error searching assets' });
  }
};

// Solicitud de descarga
export const requestDownload = async (req, res) => {
  try {
    const id = Number(req.params.id)
    if (!id) return res.status(400).json({ message: 'Invalid asset id' })

    const asset = await prisma.asset.findUnique({ where: { id }, select: { id: true, status: true, isPremium: true, megaLink: true } })
    if (!asset) return res.status(404).json({ message: 'Asset not found' })
    if (asset.status !== 'PUBLISHED') return res.status(409).json({ message: 'Asset not available' })
    if (!asset.megaLink) return res.status(409).json({ message: 'Download link not ready' })

    let allowed = false
    let userId = null
    if (!asset.isPremium) {
      // Free: permitido sin autenticación
      allowed = true
      // Si viene token, capturar userId para registrar historial
      try {
        const auth = req.headers.authorization || ''
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
        if (token) {
          const secret = process.env.JWT_SECRET || 'dev-secret'
          const payload = jwt.verify(token, secret)
          const uid = Number(payload?.id)
          if (uid) userId = uid
        }
      } catch {}
    } else {
      // Premium: requiere token + suscripción activa o admin
      try {
        const auth = req.headers.authorization || ''
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
        if (!token) return res.status(401).json({ message: 'Unauthorized' })
        const secret = process.env.JWT_SECRET || 'dev-secret'
        const payload = jwt.verify(token, secret)
        userId = Number(payload?.id)
        const roleId = Number(payload?.roleId)
        if (!userId) return res.status(401).json({ message: 'Unauthorized' })
        // Admin siempre permitido
        if (roleId === 2) {
          allowed = true
        } else {
          const now = new Date()
          // Buscar la última suscripción (activa o expirada) para informar fecha si aplica
          const lastSub = await prisma.subscription.findFirst({
            where: { userId },
            orderBy: { id: 'desc' },
          })
          if (!lastSub) {
            return res.status(403).json({ code: 'NO_SUB', message: 'Subscription required' })
          }
          const end = new Date(lastSub.currentPeriodEnd)
          const isActive = lastSub.status === 'ACTIVE' && end > now
          if (!isActive) {
            return res.status(403).json({ code: 'EXPIRED', message: 'Subscription expired', expiredAt: end.toISOString() })
          }
          allowed = true
        }
      } catch (e) {
        return res.status(401).json({ message: 'Unauthorized' })
      }
    }

    if (!allowed) return res.status(403).json({ message: 'Forbidden' })

    // Incrementar contador de descargas de forma atómica por SQL crudo
    await prisma.$executeRawUnsafe('UPDATE asset SET downloads = downloads + 1 WHERE id = ?', id)

    // Registrar historial de descarga si el usuario está logueado
    if (userId) {
      // Obtener título actual del asset (puede ser null si se borra luego)
      let assetTitle = null;
      try {
        const assetObj = await prisma.asset.findUnique({ where: { id }, select: { title: true } });
        assetTitle = assetObj?.title || null;
      } catch {}
      // Insertar registro
      await prisma.downloadHistory.create({
        data: {
          userId,
          assetId: id,
          assetTitle,
        }
      });
      // Limitar a 20: borrar las más antiguas si hay más de 20
      const count = await prisma.downloadHistory.count({ where: { userId } });
      if (count > 20) {
        // Borrar todo lo que esté por detrás de las 20 más recientes
        const old = await prisma.downloadHistory.findMany({
          where: { userId },
          orderBy: { downloadedAt: 'desc' },
          skip: 20,
          select: { id: true },
        });
        const idsToDelete = old.map(d => d.id);
        if (idsToDelete.length) {
          await prisma.downloadHistory.deleteMany({ where: { id: { in: idsToDelete } } });
        }
      }
    }

    return res.json({ ok: true, link: asset.megaLink })
  } catch (e) {
    console.error('[ASSETS] requestDownload error:', e)
    return res.status(500).json({ message: 'Error processing download' })
  }
}

// Randomizar freebies: poner todos los publicados como premium y luego seleccionar N aleatorios para dejarlos gratis
export const randomizeFree = async (req, res) => {
  try {
    let n = Number(req.body?.count ?? req.query?.count ?? 0)
    if (!Number.isFinite(n) || n < 0) n = 0

    const where = { status: 'PUBLISHED' }

    // Total de assets publicados
    const total = await prisma.asset.count({ where })
    if (total === 0) return res.json({ total: 0, selected: 0 })

    // Paso 1: marcar todos como premium
    await prisma.asset.updateMany({ where, data: { isPremium: true } })

    // Paso 2: seleccionar N aleatorios para dejar free
    if (n > 0) {
      const rows = await prisma.asset.findMany({ where, select: { id: true } })
      const ids = rows.map(r => r.id)
      // Fisher-Yates shuffle parcial
      for (let i = ids.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        const tmp = ids[i]; ids[i] = ids[j]; ids[j] = tmp
      }
      const pick = ids.slice(0, Math.min(n, ids.length))
      await prisma.asset.updateMany({ where: { id: { in: pick } }, data: { isPremium: false } })
      return res.json({ total, selected: pick.length })
    }

    return res.json({ total, selected: 0 })
  } catch (e) {
    console.error('[ASSETS] randomizeFree error:', e)
    return res.status(500).json({ message: 'Error randomizing freebies' })
  }
}
