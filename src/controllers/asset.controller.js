import { PrismaClient } from '@prisma/client';
import path from 'path';
import fs from 'fs';
import sharp from 'sharp';
import { spawn } from 'child_process';
import { decryptToJson } from '../utils/cryptoUtils.js';
import jwt from 'jsonwebtoken'

const prisma = new PrismaClient();

// Progreso en memoria por assetId (0..100)
const progressMap = new Map();

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

// Listar y obtener
export const listAssets = async (req, res) => {
  try {
    const { q = '', pageIndex, pageSize } = req.query;
    const hasPagination = pageIndex !== undefined && pageSize !== undefined;

    const where = q
      ? { title: { contains: String(q) } }
      : undefined;

    if (hasPagination) {
      const take = Math.max(1, Math.min(1000, Number(pageSize) || 50));
      const page = Math.max(0, Number(pageIndex) || 0);
      const skip = page * take;

      const [items, total] = await Promise.all([
        prisma.asset.findMany({
          where,
          include: { account: { select: { alias: true } } },
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
      include: { account: { select: { alias: true } } },
      orderBy: { id: 'desc' },
      take: 50,
    });
    return res.json(items);
  } catch (e) {
    console.error('[ASSETS] list error:', e);
    return res.status(500).json({ message: 'Error listing assets' });
  }
};

export const getAsset = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const item = await prisma.asset.findUnique({ where: { id } });
    if (!item) return res.status(404).json({ message: 'Not found' });
    return res.json(item);
  } catch (e) {
    console.error('[ASSETS] get error:', e);
    return res.status(500).json({ message: 'Error getting asset' });
  }
};

export const updateAsset = async (req, res) => {
  try {
    const id = Number(req.params.id)
    const existing = await prisma.asset.findUnique({ where: { id } })
    if (!existing) return res.status(404).json({ message: 'Asset not found' })

    const { title, category, tags, isPremium } = req.body
    const data = {}
    if (title !== undefined) data.title = String(title)
    if (category !== undefined) data.category = String(category)
    if (typeof isPremium !== 'undefined') data.isPremium = Boolean(isPremium)
    if (typeof tags !== 'undefined') {
      try {
        data.tags = Array.isArray(tags) ? tags : JSON.parse(tags)
      } catch {
        data.tags = undefined
      }
    }

    const updated = await prisma.asset.update({ where: { id }, data })
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
    const { title, category, tags, isPremium, accountId, tempArchivePath, archiveOriginal } = req.body;
    if (!title) return res.status(400).json({ message: 'title required' });
    if (!accountId) return res.status(400).json({ message: 'accountId required' });
    const accId = Number(accountId);

    const slugBase = safeName(title);
    const slug = slugBase || `asset-${Date.now()}`;

    // carpeta final: archives/category/slug
    const finalDir = path.join(ARCHIVES_DIR, safeName(category || 'uncategorized'), slug);
    ensureDir(finalDir);

    let archiveName = null, archiveSizeB = null, megaLink = null;

    // mover archivo si vino tempArchivePath
    if (tempArchivePath) {
      const absTemp = path.join(UPLOADS_DIR, tempArchivePath);
      const fname = archiveOriginal ? safeFileName(archiveOriginal) : path.basename(absTemp);
      const target = path.join(finalDir, fname);
      fs.renameSync(absTemp, target);
      archiveName = path.relative(UPLOADS_DIR, target);
      const sz = fs.statSync(path.resolve(target)).size;
      archiveSizeB = sz;
      // tamaño persistente
      megaLink = megaLink; // noop to keep order; we'll set fileSizeB in create
    }

    const created = await prisma.asset.create({
      data: {
        title,
        slug,
        category,
        tags: tags ? JSON.parse(tags) : undefined,
        isPremium: Boolean(isPremium),
        accountId: accId,
        archiveName,
        archiveSizeB,
        fileSizeB: archiveSizeB ?? null,
        megaLink,
        status: 'DRAFT',
      }
    });

    return res.status(201).json(created);
  } catch (e) {
    console.error('[ASSETS] create error:', e);
    return res.status(500).json({ message: 'Error creating asset' });
  }
};

// 3) Subida de imágenes SOLO si ya existe el asset (para no orphan)
export const uploadImages = async (req, res) => {
  try {
    const assetId = Number(req.params.assetId);
    const asset = await prisma.asset.findUnique({ where: { id: assetId } });
    if (!asset) return res.status(404).json({ message: 'Asset not found' });

    const replacing = String(req.query?.replace || '').toLowerCase() === 'true'

    const category = safeName(asset.category || 'uncategorized');
    const slug = asset.slug;

    // carpeta imágenes: images/category/slug
    const baseDir = path.join(IMAGES_DIR, category, slug);
    const thumbsDir = path.join(baseDir, 'thumbs');
    ensureDir(baseDir); ensureDir(thumbsDir);

    const files = req.files || [];
    const stored = [];

    // Si se reemplaza, eliminar imágenes anteriores registradas en DB
    if (replacing) {
      const prev = Array.isArray(asset.images) ? asset.images : []
      for (const rel of prev) {
        try {
          const abs = path.join(UPLOADS_DIR, rel)
          if (fs.existsSync(abs)) fs.unlinkSync(abs)
          // limpiar directorios vacíos ascendiendo
          removeEmptyDirsUp(path.dirname(abs), IMAGES_DIR)
        } catch (e) { console.warn('[ASSETS] replace cleanup warn:', e.message) }
      }
      // limpiar thumbs
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
      const ext = path.extname(f.originalname) || path.extname(f.filename) || '';
      const name = `${Date.now()}_${i}${ext}`;
      const dest = path.join(baseDir, name);
      fs.renameSync(f.path, dest);
      const rel = path.relative(UPLOADS_DIR, dest);
      stored.push(rel);
    }

    // Generar thumbs: solo de las dos primeras imágenes disponibles
    const toThumb = stored.slice(0, 2);
    const thumbs = [];
    for (let i = 0; i < toThumb.length; i++) {
      const src = path.join(UPLOADS_DIR, toThumb[i]);
      const out = path.join(thumbsDir, `thumb_${i + 1}.jpg`);
      await sharp(src).resize(400, 400, { fit: 'inside' }).jpeg({ quality: 80 }).toFile(out);
      thumbs.push(path.relative(UPLOADS_DIR, out));
    }

    // actualizar asset.images (guardar rutas relativas)
    const imagesJson = Array.isArray(asset.images) ? asset.images : [];
    const newImages = replacing ? stored : imagesJson.concat(stored);

    const updated = await prisma.asset.update({
      where: { id: assetId },
      data: { images: newImages },
    });

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

    // Simular cola simple en memoria con spawn mega-cmd cuando corresponda
    // Para demo: lanzar proceso en background y loguear progreso a consola
    const account = await prisma.megaAccount.findUnique({ where: { id: asset.accountId } });
    if (!account) return res.status(400).json({ message: 'Account not found' });

    const archiveAbs = asset.archiveName ? path.join(UPLOADS_DIR, asset.archiveName) : null;
    if (!archiveAbs || !fs.existsSync(archiveAbs)) return res.status(400).json({ message: 'Archive not found on server' });

    // Construir destino remoto en MEGA
    const remoteBase = account.baseFolder || '/';
    const remoteCategory = safeName(asset.category || 'uncategorized');
    const remotePath = path.posix.join(remoteBase.replaceAll('\\', '/'), remoteCategory, asset.slug);

    console.log(`[ASSETS] enqueue upload asset id=${id} to MEGA ${remotePath}`);

    // simulación/ejecución: mkdir y put con mega-cmd
    // Nota: no guardamos megaLink todavía (placeholder)

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

    // responder inmediatamente (encolado)
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
    const { title, category, tags, isPremium, accountId } = req.body;
    if (!title) return res.status(400).json({ message: 'title required' });
    if (!accountId) return res.status(400).json({ message: 'accountId required' });
    const accId = Number(accountId);

    const archiveFile = (req.files?.archive || [])[0];
    const imageFiles = (req.files?.images || []);
    if (!archiveFile) return res.status(400).json({ message: 'archive required' });

    const slugBase = safeName(title);
    const slug = slugBase || `asset-${Date.now()}`;
    const cat = safeName(category || 'uncategorized');

    // construir carpetas definitivas
    const archDir = path.join(ARCHIVES_DIR, cat, slug);
    const imgDir = path.join(IMAGES_DIR, cat, slug);
    const thumbsDir = path.join(imgDir, 'thumbs');
    ensureDir(archDir); ensureDir(imgDir); ensureDir(thumbsDir);

    // mover archivo principal desde tmp -> destino conservando nombre original (sanitizado)
    const targetName = safeFileName(archiveFile.originalname || archiveFile.filename);
    const archiveTarget = path.join(archDir, targetName);
    fs.renameSync(archiveFile.path, archiveTarget);

    // mover imágenes desde tmp -> destino y recolectar rutas
    const imagesRel = [];
    for (let i = 0; i < imageFiles.length; i++) {
      const f = imageFiles[i];
      const extI = path.extname(f.originalname) || path.extname(f.filename) || '';
      const dest = path.join(imgDir, `${Date.now()}_${i}${extI}`);
      fs.renameSync(f.path, dest);
      imagesRel.push(path.relative(UPLOADS_DIR, dest));
    }

    // thumbs de las dos primeras
    const thumbs = [];
    for (let i = 0; i < Math.min(2, imagesRel.length); i++) {
      const src = path.join(UPLOADS_DIR, imagesRel[i]);
      const out = path.join(thumbsDir, `thumb_${i + 1}.jpg`);
      await sharp(src).resize(400, 400, { fit: 'inside' }).jpeg({ quality: 80 }).toFile(out);
      thumbs.push(path.relative(UPLOADS_DIR, out));
    }

    // crear asset
    const created = await prisma.asset.create({
      data: {
        title,
        slug,
        category: cat,
        tags: tags ? JSON.parse(tags) : undefined,
        isPremium: Boolean(isPremium),
        accountId: accId,
        archiveName: path.relative(UPLOADS_DIR, archiveTarget),
        archiveSizeB: fs.statSync(archiveTarget).size,
        fileSizeB: fs.statSync(archiveTarget).size,
        images: imagesRel,
        status: 'PROCESSING',
      }
    });

    // encolar subida a mega real con credenciales
    enqueueToMegaReal(created).catch(err => console.error('[MEGA-UP] async error:', err));

    return res.status(201).json(created);
  } catch (e) {
    console.error('[ASSETS] createFull error:', e);
    try { cleanupPaths.forEach(p => { if (p && fs.existsSync(p)) fs.unlinkSync(p) }) } catch {}
    return res.status(500).json({ message: 'Error creating asset' });
  }
};

// Endpoint: progreso de subida a MEGA
export const getAssetProgress = async (req, res) => {
  try {
    const id = Number(req.params.id)
    const asset = await prisma.asset.findUnique({ where: { id }, select: { status: true } })
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

export async function enqueueToMegaReal(asset) {
  const acc = await prisma.megaAccount.findUnique({ where: { id: asset.accountId }, include: { credentials: true } });
  if (!acc) throw new Error('Account not found');
  if (!acc.credentials) throw new Error('No credentials stored');

  const payload = decryptToJson(acc.credentials.encData, acc.credentials.encIv, acc.credentials.encTag);
  const loginCmd = 'mega-login';
  const mkdirCmd = 'mega-mkdir';
  const putCmd = 'mega-put';
  const logoutCmd = 'mega-logout';

  const remoteBase = (acc.baseFolder || '/').replaceAll('\\', '/');
  const remoteCategory = safeName(asset.category || 'uncategorized');
  const remotePath = path.posix.join(remoteBase, remoteCategory, asset.slug);

  const localArchive = asset.archiveName ? path.join(UPLOADS_DIR, asset.archiveName) : null;

  console.log(`[MEGA-UP] start asset id=${asset.id} to ${remotePath}`);

  const runCmd = (cmd, args = [], options = {}) => new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { shell: true, ...options });
    child.stdout.on('data', d => console.log(`[MEGA] ${d.toString().trim()}`));
    child.stderr.on('data', d => console.error(`[MEGA] ${d.toString().trim()}`));
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)) )
  });

  const parseAndSetProgress = (buf) => {
    const txt = buf.toString();
    // Caso: mensaje de finalización
    if (/upload finished/i.test(txt)) {
      progressMap.set(asset.id, 100)
      return
    }
    // Buscar la última ocurrencia del porcentaje dentro del chunk
    // Formatos típicos: "(66/70 MB:  94.89 %)" o "94.89 %"
    let last = null
    const re1 = /:\s*([0-9]{1,3}(?:\.[0-9]+)?)\s*%/g
    const re2 = /([0-9]{1,3}(?:\.[0-9]+)?)\s*%/g
    let m
    while ((m = re1.exec(txt)) !== null) last = m[1]
    if (last === null) {
      while ((m = re2.exec(txt)) !== null) last = m[1]
    }
    if (last !== null) {
      const p = Math.max(0, Math.min(100, parseFloat(last)))
      progressMap.set(asset.id, p)
    }
  }

  try {
    progressMap.set(asset.id, 0)
    try { await runCmd(logoutCmd, []); } catch {}

    if (payload?.type === 'session' && payload.session) {
      await runCmd(loginCmd, [payload.session]);
    } else if (payload?.username && payload?.password) {
      await runCmd(loginCmd, [payload.username, payload.password]);
    } else {
      throw new Error('Invalid credentials payload');
    }

    await runCmd(mkdirCmd, ['-p', remotePath]);

    if (!localArchive || !fs.existsSync(localArchive)) throw new Error('Local archive not found');

    // Subir con streaming de progreso
    await new Promise((resolve, reject) => {
      const child = spawn(putCmd, [localArchive, remotePath], { shell: true });
      let answered = false
      const maybeAnswer = (s) => {
        if (!answered && /Do you accept these terms\?/i.test(s)) {
          try { child.stdin.write('Yes\n'); answered = true } catch {}
        }
      }
      child.stdout.on('data', (d) => { const s = d.toString(); console.log(`[MEGA] ${s.trim()}`); parseAndSetProgress(d); maybeAnswer(s) });
      child.stderr.on('data', (d) => { const s = d.toString(); console.error(`[MEGA] ${s.trim()}`); parseAndSetProgress(d); maybeAnswer(s) });
      child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`${putCmd} exited ${code}`)));
    })

    progressMap.set(asset.id, 100)

    // Intentar exportar link público del archivo en MEGA
    let publicLink = null
    try {
      const remoteFilePath = path.posix.join(remotePath, path.basename(localArchive))
      const out = await new Promise((resolve, reject) => {
        let buffer = ''
        let answered = false
        const child = spawn('mega-export', ['-a', remoteFilePath], { shell: true })
        const maybeAnswer = (s) => {
          if (!answered && /Do you accept estos términos\?/i.test(s)) {
            try { child.stdin.write('Yes\n'); answered = true } catch {}
          }
        }
        child.stdout.on('data', (d) => { const s = d.toString(); buffer += s; console.log(`[MEGA] ${s.trim()}`); maybeAnswer(s) })
        child.stderr.on('data', (d) => { const s = d.toString(); buffer += s; console.error(`[MEGA] ${s.trim()}`); maybeAnswer(s) })
        child.on('close', (code) => code === 0 ? resolve(buffer) : reject(new Error(`mega-export exited ${code}`)))
      })
      const m = String(out).match(/https?:\/\/mega\.nz\/[\S]+/i)
      if (m) publicLink = m[0]
    } catch (e) {
      console.warn('[MEGA-UP] export warn:', e.message)
    }

    // Subida a MEGA completada: eliminar archivo local y limpiar campos
    try { fs.unlinkSync(localArchive); } catch (e) { console.warn('[MEGA-UP] unlink warn:', e.message); }
    try {
      const archiveDir = path.dirname(localArchive)
      removeEmptyDirsUp(archiveDir, ARCHIVES_DIR)
    } catch (e) {
      console.warn('[MEGA-UP] rmdir warn:', e.message)
    }

    // Imprimir link público si se obtuvo
    if (publicLink) console.log(`*******************************  [MEGA-UP] public link: ${publicLink}`);

    await prisma.asset.update({ where: { id: asset.id }, data: { status: 'PUBLISHED', archiveName: null, archiveSizeB: null, megaLink: publicLink || undefined } });

    console.log(`[MEGA-UP] done asset id=${asset.id}`);
  } catch (e) {
    console.error('[MEGA-UP] error:', e);
    await prisma.asset.update({ where: { id: asset.id }, data: { status: 'FAILED' } });
    throw e;
  } finally {
    progressMap.delete(asset.id)
    try { await runCmd(logoutCmd, []); } catch {}
  }
}

// DELETE /api/assets/:id
export const deleteAsset = async (req, res) => {
  const id = Number(req.params.id)
  try {
    const asset = await prisma.asset.findUnique({ where: { id } })
    if (!asset) return res.status(404).json({ message: 'Asset not found' })

    const cat = safeName(asset.category || 'uncategorized')
    const imgDir = path.join(IMAGES_DIR, cat, asset.slug)
    const archDir = path.join(ARCHIVES_DIR, cat, asset.slug)

    // Borrar archivos locales (imágenes, thumbs y archivo)
    try { if (fs.existsSync(imgDir)) fs.rmSync(imgDir, { recursive: true, force: true }) } catch (e) { console.warn('[ASSETS] rm images warn:', e.message) }
    try { if (fs.existsSync(archDir)) fs.rmSync(archDir, { recursive: true, force: true }) } catch (e) { console.warn('[ASSETS] rm archives warn:', e.message) }
    try { removeEmptyDirsUp(path.dirname(imgDir), IMAGES_DIR) } catch {}
    try { removeEmptyDirsUp(path.dirname(archDir), ARCHIVES_DIR) } catch {}

    // Eliminar de DB primero
    await prisma.asset.delete({ where: { id } })

    // Intentar eliminar en MEGA
    let megaDeleted = false
    try {
      const acc = await prisma.megaAccount.findUnique({ where: { id: asset.accountId }, include: { credentials: true } })
      if (!acc || !acc.credentials) throw new Error('No account/credentials')
      const payload = decryptToJson(acc.credentials.encData, acc.credentials.encIv, acc.credentials.encTag)

      const loginCmd = 'mega-login'
      const rmCmd = 'mega-rm'
      const logoutCmd = 'mega-logout'

      const remoteBase = (acc.baseFolder || '/').replaceAll('\\', '/')
      const remotePath = path.posix.join(remoteBase, cat, asset.slug)

      try { await runCmd(logoutCmd, []) } catch {}
      if (payload?.type === 'session' && payload.session) {
        await runCmd(loginCmd, [payload.session])
      } else if (payload?.username && payload?.password) {
        await runCmd(loginCmd, [payload.username, payload.password])
      } else {
        throw new Error('Invalid credentials payload')
      }

      // Forzar borrado recursivo del folder del asset
      await runCmd(rmCmd, ['-rf', remotePath])
      megaDeleted = true
      try { await runCmd(logoutCmd, []) } catch {}
    } catch (e) {
      console.warn('[ASSETS] mega delete warn:', e.message)
    }

    return res.json({ dbDeleted: true, megaDeleted })
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
      select: { id: true, title: true, category: true, tags: true, images: true, megaLink: true, isPremium: true },
    })
    return res.json(items)
  } catch (e) {
    console.error('[ASSETS] latest error:', e)
    return res.status(500).json({ message: 'Error getting latest assets' })
  }
}

// Obtener más descargados (publicados)
export const mostDownloadedAssets = async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 20))
    // SQL crudo para evitar depender de client regenerado
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, title, category, tags, images, megaLink, isPremium, downloads
       FROM asset
       WHERE status = 'PUBLISHED'
       ORDER BY downloads DESC, id DESC
       LIMIT ?`,
      limit
    )
    const items = rows.map((r) => {
      const out = { ...r }
      // Normalizar JSON
      try { if (typeof out.tags === 'string') out.tags = JSON.parse(out.tags) } catch {}
      try { if (typeof out.images === 'string') out.images = JSON.parse(out.images) } catch {}
      return out
    })
    return res.json(items)
  } catch (e) {
    console.error('[ASSETS] mostDownloaded error:', e)
    return res.status(500).json({ message: 'Error getting most downloaded assets' })
  }
}

// Búsqueda pública con filtros por categorías, tags y texto libre
export const searchAssets = async (req, res) => {
  try {
    const { q = '', categories = '', tags = '' } = req.query || {};

    const qStr = String(q || '').trim();
    const qLower = qStr.toLowerCase();

    const catList = String(categories || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);

    const tagList = String(tags || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);

    console.log('[ASSETS][SEARCH] params:', { q: qStr, categories: catList, tags: tagList });

    // Reducir universo por categoría en DB si se especifica
    const where = {};
    if (catList.length) where.category = { in: catList };

    // Traer un set razonable y filtrar/ordenar en memoria
    const itemsDb = await prisma.asset.findMany({
      where,
      orderBy: { id: 'desc' },
      take: 1000,
    });

    console.log('[ASSETS][SEARCH] universe:', { where, dbCount: itemsDb.length });

    const scored = [];
    let filteredByTags = 0;
    let dbgLoggedMatched = 0;
    let dbgLoggedSkipped = 0;

    for (const it of itemsDb) {
      // Filtrar por tags explícitos (si se enviaron)
      if (tagList.length) {
        const itsTags = Array.isArray(it.tags) ? it.tags : [];
        const itsLower = itsTags.map((t) => String(t).toLowerCase());
        const some = tagList.some((t) => itsLower.includes(t));
        if (!some) { filteredByTags++; continue; }
      }

      // Si no hay q, incluir tal cual (solo por categorías/tags)
      if (!qLower) {
        scored.push({ it, score: 0 });
        continue;
      }

      // Campos a evaluar
      const title = String(it.title || '');
      const descr = String(it.description || '');
      const cat = String(it.category || '');
      const arch = String(it.archiveName || '');
      const imgs = Array.isArray(it.images) ? it.images : [];
      const tagsArr = Array.isArray(it.tags) ? it.tags : [];

      const titleL = title.toLowerCase();
      const descrL = descr.toLowerCase();
      const catL = cat.toLowerCase();
      const archL = arch.toLowerCase();
      const imgsL = imgs.map((p) => String(p).toLowerCase());
      const tagsL = tagsArr.map((t) => String(t).toLowerCase());

      let score = 0;
      let matched = false;
      const reasons = [];

      // Pesos: título > archivo > imagen > tag > categoría > descripción
      if (titleL.includes(qLower)) { score += 100; matched = true; reasons.push('title'); }
      if (archL && archL.includes(qLower)) { score += 90; matched = true; reasons.push('archive'); }
      if (imgsL.some((p) => p.includes(qLower))) { score += 80; matched = true; reasons.push('image'); }
      if (tagsL.includes(qLower)) { score += 70; matched = true; reasons.push('tag'); }
      if (catL.includes(qLower)) { score += 50; matched = true; reasons.push('category'); }
      if (descrL.includes(qLower)) { score += 30; matched = true; reasons.push('description'); }

      if (!matched) {
        if (dbgLoggedSkipped < 10) {
          console.log('[ASSETS][SEARCH] skip(no match):', { id: it.id, title: it.title });
          dbgLoggedSkipped++;
        }
        continue;
      }

      // bonus por empieza con
      if (titleL.startsWith(qLower)) score += 10;

      if (dbgLoggedMatched < 15) {
        console.log('[ASSETS][SEARCH] match:', { id: it.id, title: it.title, score, reasons });
        dbgLoggedMatched++;
      }

      scored.push({ it, score });
    }

    // Ordenar por score desc y desempatar por id desc
    scored.sort((a, b) => (b.score - a.score) || (b.it.id - a.it.id));

    // Limitar respuesta
    const out = scored.slice(0, 200).map(({ it }) => it);

    console.log('[ASSETS][SEARCH] result:', {
      totalInDb: itemsDb.length,
      filteredByTags,
      matched: scored.length,
      returned: out.length,
      top: scored.slice(0, 5).map(s => ({ id: s.it.id, title: s.it.title, score: s.score }))
    });

    return res.json({ items: out });
  } catch (e) {
    console.error('[ASSETS] search error:', e);
    return res.status(500).json({ message: 'Error searching assets' });
  }
};

// Solicitud de descarga: valida acceso, incrementa contador y devuelve link
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
          const sub = await prisma.subscription.findFirst({
            where: { userId, status: 'ACTIVE', currentPeriodEnd: { gt: now } },
            orderBy: { id: 'desc' }
          })
          allowed = !!sub
          if (!allowed) return res.status(403).json({ message: 'Subscription required' })
        }
      } catch (e) {
        return res.status(401).json({ message: 'Unauthorized' })
      }
    }

    if (!allowed) return res.status(403).json({ message: 'Forbidden' })

    // Incrementar contador de descargas de forma atómica por SQL crudo
    await prisma.$executeRawUnsafe('UPDATE asset SET downloads = downloads + 1 WHERE id = ?', id)

    return res.json({ ok: true, link: asset.megaLink })
  } catch (e) {
    console.error('[ASSETS] requestDownload error:', e)
    return res.status(500).json({ message: 'Error processing download' })
  }
}
