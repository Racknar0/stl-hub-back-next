/**
 * batchWorker.js  –  Worker de procesamiento masivo (Batch Import)
 *
 * Flujo por cada BatchImportItem con status=PENDING:
 *   1. Extraer .rar/.zip/.7z internos
 *   2. Re-comprimir TODO en un único {slug}.rar
 *   3. Subir a MEGA Main (proxy + stall detection)
 *   4. Replicar a cuentas Backup (proxy + stall detection)
 *   5. Crear registro Asset en BD
 *   6. Limpiar archivos locales
 *
 * Subidas en serie: Main1 → Main2 → … → Backup1 → Backup2 → …
 * NO interfiere con el uploader principal.
 */

import { PrismaClient } from '@prisma/client'
import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import sharp from 'sharp'
import { withMegaLock } from '../utils/megaQueue.js'
import { applyMegaProxy, listMegaProxies } from '../utils/megaProxy.js'
import { decryptToJson } from '../utils/cryptoUtils.js'

const prisma = new PrismaClient()
const UPLOADS_DIR  = path.resolve('uploads')
const BATCH_DIR    = path.join(UPLOADS_DIR, 'batch_imports')
const ARCHIVES_DIR = path.join(UPLOADS_DIR, 'archives')
const IMAGES_DIR   = path.join(UPLOADS_DIR, 'images')
const STAGING_DIR  = path.join(UPLOADS_DIR, 'batch_staging')

const POLL_INTERVAL_MS = 5_000
const STALL_TIMEOUT_MS = Number(process.env.MEGA_STALL_TIMEOUT_MS) || 3 * 60 * 1000  // 3 min
const MAX_STALL_RETRIES = 3
const ARCHIVE_EXTS = ['.rar', '.zip', '.7z', '.tar', '.gz', '.tgz']
const IMAGE_EXTS   = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tiff']

// ────────────────────────────── HELPERS ──────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function runCmd(cmd, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { shell: true })
    let out = '', err = ''
    child.stdout.on('data', d => (out += d.toString()))
    child.stderr.on('data', d => (err += d.toString()))
    child.on('close', code =>
      code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}: ${(err || out).slice(0, 300)}`))
    )
  })
}

// Resolver la ruta de 7z según el SO
const SEVEN_ZIP = (() => {
  if (process.platform !== 'win32') return '7z'
  const candidates = [
    'C:\\Program Files\\7-Zip\\7z.exe',
    'C:\\Program Files (x86)\\7-Zip\\7z.exe',
    path.join(process.env.LOCALAPPDATA || '', '7-Zip', '7z.exe'),
  ]
  for (const p of candidates) { if (fs.existsSync(p)) return p }
  return '7z' // fallback: asume que está en el PATH
})()

function run7z(args) {
  return new Promise((resolve, reject) => {
    // shell: false evita problemas de escape de rutas con espacios en Windows
    const child = spawn(SEVEN_ZIP, args, { shell: false })
    let out = '', err = ''
    child.stdout.on('data', d => (out += d.toString()))
    child.stderr.on('data', d => (err += d.toString()))
    child.on('error', (e) => reject(new Error(`Spawn error: ${e.message}`)))
    child.on('close', code =>
      code === 0 ? resolve(out) : reject(new Error(`7z exited ${code}: ${(err || out).slice(0, 300)}`))
    )
  })
}

function killProcessTreeBestEffort(child, label) {
  try {
    if (!child?.pid) return
    if (process.platform === 'win32') {
      try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { shell: true }) } catch {}
    } else {
      try { process.kill(-child.pid, 'SIGKILL') } catch {}
      try { child.kill('SIGKILL') } catch {}
    }
    console.warn(`[${label}] kill sent pid=${child.pid}`)
  } catch {}
}

function attachAutoAcceptTerms(child, label = 'MEGA') {
  const EOL = '\n'
  const ACCEPT_RE = [/Do you accept.*terms\??/i, /Type '\s*yes\s*' to continue/i]
  const PROMPT_YNA = /\[y\]es\s*\/\s*\[n\]o\s*\/\s*\[a\]ll/i
  const PROMPT_YN  = /\[(y|Y)\]es\s*\/\s*\[(n|N)\]o/i
  const safeWrite = (txt) => { try { child.stdin.write(txt) } catch {} }
  const check = (s) => {
    if (ACCEPT_RE.some(r => r.test(s))) safeWrite('yes' + EOL)
    if (PROMPT_YNA.test(s)) safeWrite('a' + EOL)
    else if (PROMPT_YN.test(s)) safeWrite('y' + EOL)
  }
  child.stdout.on('data', d => check(d.toString()))
  child.stderr.on('data', d => check(d.toString()))
}

async function safeMkdir(remotePath) {
  try { await runCmd('mega-mkdir', ['-p', remotePath]) } catch {}
}

async function megaLogout(ctx) {
  try { await runCmd('mega-logout', []); console.log(`[BATCH][LOGOUT][OK] ${ctx}`) }
  catch { console.log(`[BATCH][LOGOUT][WARN] ${ctx}`) }
}

async function megaLogin(payload, ctx) {
  if (payload?.type === 'session' && payload.session) {
    await runCmd('mega-login', [payload.session])
  } else if (payload?.username && payload?.password) {
    await runCmd('mega-login', [payload.username, payload.password])
  } else throw new Error('Invalid credentials payload')
  console.log(`[BATCH][LOGIN][OK] ${ctx}`)
}

// ────────── mega-put CON stall detection (idéntico al uploader) ──────────

function megaPutWithStall({ srcPath, remotePath, logPrefix, onProgress, stallTimeoutMs = STALL_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const child = spawn('mega-put', [srcPath, remotePath], { shell: true })
    attachAutoAcceptTerms(child, logPrefix || 'BATCH PUT')

    let settled = false, lastPct = -1, lastProgressAt = Date.now(), stallTimer = null

    const noteProgress = (pct) => {
      if (pct > lastPct) { lastPct = pct; lastProgressAt = Date.now() }
      try { onProgress && onProgress(pct) } catch {}
    }

    const parseProgress = (buf) => {
      const txt = buf.toString()
      const re = /([0-9]{1,3}(?:\.[0-9]+)?)\s*%/g
      let m, last = null
      while ((m = re.exec(txt)) !== null) last = m[1]
      if (last !== null) noteProgress(Math.max(0, Math.min(100, parseFloat(last))))
      if (/upload finished/i.test(txt)) noteProgress(100)
    }

    const cleanup = () => { if (stallTimer) clearInterval(stallTimer); stallTimer = null }
    const fail = (err) => { if (settled) return; settled = true; cleanup(); reject(err) }
    const ok   = ()    => { if (settled) return; settled = true; cleanup(); resolve() }

    // Stall watchdog
    if (stallTimeoutMs > 0) {
      stallTimer = setInterval(() => {
        const idle = Date.now() - lastProgressAt
        if (idle < stallTimeoutMs) return
        console.warn(`[BATCH][STALL] mega-put sin progreso ${Math.round(idle/1000)}s lastPct=${lastPct} ${logPrefix}`)
        killProcessTreeBestEffort(child, logPrefix)
        fail(new Error(`MEGA_PUT_STALL_TIMEOUT no progress for ${idle}ms`))
      }, 1000)
    }

    child.stdout.on('data', d => parseProgress(d))
    child.stderr.on('data', d => parseProgress(d))
    child.on('error', e => { killProcessTreeBestEffort(child, logPrefix); fail(e) })
    child.on('close', code => { if (!settled) code === 0 ? ok() : fail(new Error(`mega-put exited ${code}`)) })
  })
}

function megaExportLink(remoteFile) {
  return new Promise((resolve, reject) => {
    let buf = ''
    const child = spawn('mega-export', ['-a', remoteFile], { shell: true })
    attachAutoAcceptTerms(child, 'BATCH EXPORT')
    child.stdout.on('data', d => (buf += d.toString()))
    child.stderr.on('data', d => (buf += d.toString()))
    child.on('close', code => {
      if (code !== 0) return reject(new Error('export failed'))
      const m = buf.match(/https?:\/\/mega\.nz\/\S+/i)
      resolve(m ? m[0] : null)
    })
  })
}

function getAllFiles(dir) {
  let results = []
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isFile()) results.push(p)
      else if (e.isDirectory()) results.push(...getAllFiles(p))
    }
  } catch {}
  return results
}

function slugify(str) {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120)
}

async function uniqueSlug(baseSlug) {
  let candidate = baseSlug, suffix = 1
  while (true) {
    const existing = await prisma.asset.findFirst({ where: { slug: candidate } })
    if (!existing) return candidate
    suffix++
    candidate = `${baseSlug}-${suffix}`
    console.log(`[BATCH][SLUG] "${baseSlug}" ya existe → "${candidate}"`)
  }
}

// ──────────────────── EXTRACT + RECOMPRESS ────────────────────

async function extractInnerArchives(folderPath) {
  const archives = getAllFiles(folderPath).filter(f => ARCHIVE_EXTS.includes(path.extname(f).toLowerCase()))
  for (const arc of archives) {
    try {
      // Sin comillas manuales, Node se encarga
      await run7z(['x', arc, `-o${path.dirname(arc)}`, '-y', '-aoa'])
      fs.unlinkSync(arc)
      console.log(`[BATCH][EXTRACT] OK ${path.basename(arc)}`)
    } catch (e) { console.error(`[BATCH][EXTRACT] Error ${path.basename(arc)}: ${e.message}`) }
  }
}

async function recompressFolder(folderPath, outputName) {
  fs.mkdirSync(STAGING_DIR, { recursive: true })
  const outputPath = path.join(STAGING_DIR, `${outputName}.rar`)
  if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath)

  // Sin comillas manuales, Node se encarga
  await run7z(['a', '-trar', outputPath, path.join(folderPath, '*'), '-r', '-mx5'])
  const sizeMB = fs.existsSync(outputPath) ? (fs.statSync(outputPath).size / (1024 * 1024)).toFixed(1) : 0
  console.log(`[BATCH][RECOMPRESS] OK → ${outputName}.rar (${sizeMB} MB)`)
  return outputPath
}

async function extractImages(folderPath, slug) {
  const images = getAllFiles(folderPath).filter(f => IMAGE_EXTS.includes(path.extname(f).toLowerCase()))
  const saved = []
  if (!images.length) return saved

  // Misma estructura que el uploader: images/{slug}/ + images/{slug}/thumbs/
  const imgDir = path.join(IMAGES_DIR, slug)
  const thumbsDir = path.join(imgDir, 'thumbs')
  fs.mkdirSync(imgDir, { recursive: true })
  fs.mkdirSync(thumbsDir, { recursive: true })

  // Convertir a WebP igual que el uploader (700px max, quality 80)
  for (let i = 0; i < images.length; i++) {
    const outName = `${Date.now()}_${i}.webp`
    const dest = path.join(imgDir, outName)
    try {
      await sharp(images[i])
        .rotate()
        .resize({ width: 700, withoutEnlargement: true })
        .webp({ quality: 80, effort: 6 })
        .toFile(dest)
      saved.push(path.relative(UPLOADS_DIR, dest).replace(/\\/g, '/'))
    } catch (e) { console.warn(`[BATCH][IMG] Error procesando ${images[i]}: ${e.message}`) }
  }

  // Generar thumbnails (primeras 2 imágenes, 400x400) igual que el uploader
  for (let i = 0; i < Math.min(2, saved.length); i++) {
    const src = path.join(UPLOADS_DIR, saved[i])
    const out = path.join(thumbsDir, `thumb_${i + 1}.webp`)
    try {
      await sharp(src)
        .resize(400, 400, { fit: 'inside' })
        .webp({ quality: 65, effort: 6 })
        .toFile(out)
    } catch {}
  }

  console.log(`[BATCH][IMG] ${saved.length} imágenes convertidas a WebP para ${slug}`)
  return saved
}

// ──────────────────── MEGA UPLOAD (con stall retry) ────────────────────

async function uploadToAccountWithRetry({ archivePath, slug, account, role, onProgress }) {
  const creds = account.credentials
  if (!creds) throw new Error(`Sin credenciales para account=${account.id}`)
  const payload = decryptToJson(creds.encData, creds.encIv, creds.encTag)
  const remoteBase = (account.baseFolder || '/').replace(/\\/g, '/')
  const remotePath = path.posix.join(remoteBase, slug)
  const ctx = `batch-${role} accId=${account.id} alias=${account.alias || '--'}`
  let publicLink = null

  for (let attempt = 1; attempt <= MAX_STALL_RETRIES; attempt++) {
    try {
      // Aplicar proxy
      const proxies = await listMegaProxies()
      if (proxies.length > 0) {
        const picked = proxies[Math.floor(Math.random() * proxies.length)]
        try {
          const r = await applyMegaProxy(picked, { ctx, timeoutMs: 15000, clearOnFail: false })
          if (r?.enabled) console.log(`[BATCH][PROXY][OK] ${picked.proxyUrl} ${ctx}`)
        } catch {}
      }

      await withMegaLock(async () => {
        await megaLogout(`PREV ${ctx}`)
        await megaLogin(payload, ctx)
        await safeMkdir(remotePath)

        if (!fs.existsSync(archivePath)) throw new Error('Local archive not found: ' + archivePath)
        console.log(`[BATCH][UPLOAD][${role.toUpperCase()}] attempt=${attempt} ${path.basename(archivePath)} → ${remotePath}`)

        await megaPutWithStall({
          srcPath: archivePath,
          remotePath,
          logPrefix: `batch-${role} accId=${account.id}`,
          stallTimeoutMs: STALL_TIMEOUT_MS,
          onProgress,
        })

        // Link público solo en role=main
        if (role === 'main') {
          try {
            const remoteFile = path.posix.join(remotePath, path.basename(archivePath))
            publicLink = await megaExportLink(remoteFile)
            if (publicLink) console.log(`[BATCH][LINK] ${publicLink}`)
          } catch (e) { console.warn(`[BATCH][EXPORT] warn: ${e.message}`) }
        }

        await megaLogout(`END ${ctx}`)
      }, `BATCH-${role.toUpperCase()}-${account.id}`)

      console.log(`[BATCH][${role.toUpperCase()}][OK] accId=${account.id}`)
      return publicLink  // éxito → salir del retry loop

    } catch (e) {
      console.error(`[BATCH][${role.toUpperCase()}][FAIL] attempt=${attempt}/${MAX_STALL_RETRIES} accId=${account.id}: ${e.message}`)
      if (attempt >= MAX_STALL_RETRIES) throw e
      // Espera antes de reintentar
      await sleep(5000)
    }
  }
}

// ──────────────────── CREAR ASSET EN BD (idéntico al uploader) ────────────────────

async function createAssetRecord({ slug, title, archiveName, images, account, megaLink, sizeBytes, tags, categories }) {
  // Título con prefijo "STL - " igual que el uploader
  const fullTitle = title.startsWith('STL - ') ? title : `STL - ${title}`
  const archiveSizeB = BigInt(sizeBytes || 0)

  const data = {
    title: fullTitle,
    titleEn: fullTitle,
    slug,
    archiveName,
    archiveSizeB,
    fileSizeB: archiveSizeB,
    images: images || [],
    status: 'PROCESSING',
    megaLink: megaLink || null,
    megaLinkAlive: !!megaLink,
    megaLinkCheckedAt: megaLink ? new Date() : null,
    accountId: account.id,
    isPremium: false,
  }

  // Conectar categorías/tags con relaciones si se enviaron
  if (Array.isArray(categories) && categories.length > 0) {
    data.categories = { connect: categories.map(c => ({ id: typeof c === 'object' ? c.id : Number(c) })).filter(c => c.id) }
  }
  if (Array.isArray(tags) && tags.length > 0) {
    data.tags = { connect: tags.map(t => ({ id: typeof t === 'object' ? t.id : Number(t) })).filter(t => t.id) }
  }

  const asset = await prisma.asset.create({ data })
  console.log(`[BATCH][ASSET] Creado id=${asset.id} slug=${slug} title="${fullTitle}"`)
  return asset
}

// ──────────────────── PROCESAR UN ITEM COMPLETO ────────────────────

async function processItem(item) {
  const batchFolder = await prisma.batchImport.findUnique({ where: { id: item.batchId } })
  const folderPath = path.join(BATCH_DIR, batchFolder?.folderName || '', item.folderName)
  const friendlyName = item.folderName
  const baseSlug = slugify(friendlyName)
  const slug = await uniqueSlug(baseSlug)

  console.log(`\n${'='.repeat(60)}`)
  console.log(`[BATCH] Procesando item #${item.id}: ${friendlyName} → slug="${slug}"`)
  console.log(`${'='.repeat(60)}\n`)

  if (!fs.existsSync(folderPath)) throw new Error(`Carpeta no encontrada: ${folderPath}`)
  if (!item.targetAccount) throw new Error('No tiene cuenta MEGA asignada')

  const mainAccount = await prisma.megaAccount.findUnique({
    where: { id: item.targetAccount },
    include: { credentials: true, backups: { include: { backupAccount: { include: { credentials: true } } } } }
  })
  if (!mainAccount) throw new Error(`Cuenta MEGA id=${item.targetAccount} no encontrada`)

  const updateItem = (data) => prisma.batchImportItem.update({ where: { id: item.id }, data })

  // ─── STEP 1: Extraer archivos internos ───
  await updateItem({ error: 'Extrayendo archivos internos...', mainStatus: 'EXTRACTING' })
  await extractInnerArchives(folderPath)

  // ─── STEP 2: Extraer imágenes (WebP + thumbnails igual que el uploader) ───
  await updateItem({ error: 'Procesando imágenes...' })
  const imagePaths = await extractImages(folderPath, slug)

  // ─── STEP 3: Recomprimir ───
  await updateItem({ error: 'Comprimiendo RAR final...', mainStatus: 'COMPRESSING' })
  const archivePath = await recompressFolder(folderPath, slug)
  const archiveSizeBytes = fs.statSync(archivePath).size

  // Copiar a archives/{slug}/ (misma estructura que el uploader)
  const archDir = path.join(ARCHIVES_DIR, slug)
  fs.mkdirSync(archDir, { recursive: true })
  const finalArchive = path.join(archDir, `${slug}.rar`)
  fs.copyFileSync(archivePath, finalArchive)
  const archiveName = path.relative(UPLOADS_DIR, finalArchive).replace(/\\/g, '/')

  // ─── STEP 4: Subir a MEGA MAIN ───
  await updateItem({ error: 'Subiendo a MEGA (Main)...', mainStatus: 'UPLOADING', mainProgress: 0 })
  const megaLink = await uploadToAccountWithRetry({
    archivePath: finalArchive,
    slug,
    account: mainAccount,
    role: 'main',
    onProgress: async (pct) => {
      try { await updateItem({ mainProgress: Math.round(pct) }) } catch {}
    }
  })
  await updateItem({ mainStatus: 'OK', mainProgress: 100 })

  // ─── STEP 5: Replicar a Backups en serie ───
  const backupAccounts = (mainAccount.backups || [])
    .map(b => b.backupAccount)
    .filter(b => b && b.type === 'backup')

  if (backupAccounts.length > 0) {
    await updateItem({ error: 'Replicando a backups...', backupStatus: 'UPLOADING' })
    for (const backup of backupAccounts) {
      try {
        await uploadToAccountWithRetry({
          archivePath: finalArchive,
          slug,
          account: backup,
          role: 'backup',
        })
      } catch (e) {
        console.error(`[BATCH][BACKUP][ERROR] accId=${backup.id}: ${e.message}`)
      }
    }
    await updateItem({ backupStatus: 'OK' })
  } else {
    await updateItem({ backupStatus: 'N/A' })
  }

  // ─── STEP 6: Crear Asset en BD (idéntico al uploader) ───
  await updateItem({ error: 'Guardando en base de datos...' })
  const asset = await createAssetRecord({
    slug,
    title: item.title || friendlyName,
    archiveName,
    images: imagePaths,
    account: mainAccount,
    megaLink,
    sizeBytes: archiveSizeBytes,
    tags: item.tags,
    categories: item.categories,
  })

  // ─── STEP 7: Cleanup ───
  try { if (fs.existsSync(archivePath)) fs.unlinkSync(archivePath) } catch {}  // staging
  try { if (fs.existsSync(finalArchive)) fs.unlinkSync(finalArchive) } catch {} // archives
  try { if (fs.existsSync(folderPath)) fs.rmSync(folderPath, { recursive: true, force: true }) } catch {} // source folder
  console.log(`[BATCH][CLEANUP] Archivos locales de "${slug}" eliminados`)

  return asset.id
}

// ──────────────────── LOOP PRINCIPAL ────────────────────

export async function startBatchWorker() {
  console.log('[BatchWorker] ✅ Worker iniciado y monitoreando la cola...')
  for (const dir of [BATCH_DIR, STAGING_DIR, ARCHIVES_DIR, IMAGES_DIR]) {
    fs.mkdirSync(dir, { recursive: true })
  }

  while (true) {
    try {
      const item = await prisma.batchImportItem.findFirst({
        where: { status: 'QUEUED' },
        orderBy: { createdAt: 'asc' },
        include: { batch: true }
      })

      if (!item) { await sleep(POLL_INTERVAL_MS); continue }

      await prisma.batchImportItem.update({
        where: { id: item.id },
        data: { status: 'PROCESSING', mainStatus: 'PENDING', backupStatus: 'PENDING', mainProgress: 0 }
      })

      try {
        const assetId = await processItem(item)
        await prisma.batchImportItem.update({
          where: { id: item.id },
          data: {
            status: 'COMPLETED',
            error: null,
            createdAssetId: assetId,
            archiveFile: `${slugify(item.folderName)}.rar`
          }
        })
        console.log(`[BatchWorker] ✅ Item #${item.id} completado → asset=${assetId}`)
      } catch (err) {
        console.error(`[BatchWorker] ❌ Item #${item.id} falló:`, err.message)
        await prisma.batchImportItem.update({
          where: { id: item.id },
          data: {
            status: 'FAILED',
            error: String(err.message || err).slice(0, 500),
            mainStatus: 'ERROR',
          }
        })
      }

      await sleep(2000)
    } catch (err) {
      console.error('[BatchWorker] Error no controlado:', err.message)
      await sleep(POLL_INTERVAL_MS)
    }
  }
}
