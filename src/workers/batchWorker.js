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
import { withMegaLock, cancelPendingAutoLogout } from '../utils/megaQueue.js'
import { applyMegaProxy, listMegaProxies } from '../utils/megaProxy.js'
import { decryptToJson } from '../utils/cryptoUtils.js'
import {
  registerActiveBatchUpload,
  updateActiveBatchUpload,
  clearActiveBatchUpload,
  consumeBatchProxySwitchRequest,
  hasBatchProxySwitchRequest,
  hasBatchStopRequest,
  clearBatchStopRequest,
} from '../utils/batchProxySwitch.js'
import qdrantMultimodalService from '../services/qdrantMultimodal.service.js'

const prisma = new PrismaClient()
const UPLOADS_DIR  = path.resolve('uploads')
const BATCH_DIR    = path.join(UPLOADS_DIR, 'batch_imports')
const TELEGRAM_DIR = path.join(UPLOADS_DIR, 'telegram_downloads_organized')
const ARCHIVES_DIR = path.join(UPLOADS_DIR, 'archives')
const IMAGES_DIR   = path.join(UPLOADS_DIR, 'images')
const STAGING_DIR  = path.join(UPLOADS_DIR, 'batch_staging')

const POLL_INTERVAL_MS = 5_000
const STALL_TIMEOUT_MS = Number(process.env.MEGA_STALL_TIMEOUT_MS) || 5 * 60 * 1000  // 5 min
const MAX_STALL_RETRIES = 3
const MEGA_CMD_TIMEOUT_MS = Number(process.env.MEGA_CMD_TIMEOUT_MS) || 90_000
const UPLOAD_PROGRESS_HEARTBEAT_MS = Number(process.env.BATCH_PROGRESS_HEARTBEAT_MS) || 10_000
const ARCHIVE_EXTS = ['.rar', '.zip', '.7z', '.tar', '.gz', '.tgz']
const IMAGE_EXTS   = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tiff']
const NOTIFICATION_BODY_MAX = 0
let activeMegaSessionAccountId = 0
let activeMegaProxyUrl = ''
const preferredProxyByAccountId = new Map()
const sessionUploadedMbByAccountId = new Map()
const MAX_ACCOUNT_UPLOAD_MB = Number(process.env.BATCH_ACCOUNT_MAX_MB) || (18 * 1024)

// ────────────────────────────── HELPERS ──────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function envFlag(name, defaultValue = false) {
  const raw = process.env[name]
  if (raw == null) return !!defaultValue
  const v = String(raw).trim().toLowerCase()
  if (['1', 'true', 'yes', 'y', 'on'].includes(v)) return true
  if (['0', 'false', 'no', 'n', 'off'].includes(v)) return false
  return !!defaultValue
}

function removeEmptyDirsUp(startDir, stopDir) {
  try {
    let dir = path.resolve(startDir)
    const stop = path.resolve(stopDir)
    while (dir.startsWith(stop)) {
      if (!fs.existsSync(dir)) {
        dir = path.dirname(dir)
        continue
      }
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
    console.warn('[BATCH][CLEANUP] removeEmptyDirsUp warn:', e.message)
  }
}

function deleteLocalArchiveBestEffort(archiveAbsPath, ctx = '') {
  try {
    if (!envFlag('MEGA_DELETE_LOCAL_ARCHIVE_AFTER_UPLOAD', true)) return
    if (!archiveAbsPath) return
    const abs = path.resolve(archiveAbsPath)
    const root = path.resolve(ARCHIVES_DIR) + path.sep
    if (!abs.startsWith(root)) {
      console.warn(`[BATCH][CLEANUP] skip delete (outside archives) abs=${abs} ${ctx}`)
      return
    }
    if (!fs.existsSync(abs)) return
    fs.unlinkSync(abs)
    removeEmptyDirsUp(path.dirname(abs), ARCHIVES_DIR)
    console.log(`[BATCH][CLEANUP] deleted local archive ${path.basename(abs)} ${ctx}`)
  } catch (e) {
    console.warn(`[BATCH][CLEANUP] delete warn ${ctx}: ${e.message}`)
  }
}

function toSafeNumber(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function parseSizeToMB(str) {
  if (!str) return 0
  const s = String(str).trim().toUpperCase()
  const m = s.match(/([0-9.,]+)\s*([KMGT]?B)?/)
  if (!m) return 0
  const num = parseFloat(m[1].replace(',', '.'))
  const unit = m[2] || 'B'
  const factor = unit === 'B' ? 1 / (1024 * 1024) : unit === 'KB' ? 1 / 1024 : unit === 'MB' ? 1 : unit === 'GB' ? 1024 : unit === 'TB' ? 1024 * 1024 : 1 / (1024 * 1024)
  return Math.round(num * factor)
}

function parseStorageFromMegaDfText(txt) {
  const text = String(txt || '')
  let used = 0
  let total = 0

  let m = text.match(/(?:USED\s+STORAGE|ALMACENAMIENTO\s+USADO):\s*([0-9.,]+(?:\s*[KMGT]?B)?)\s+[0-9.,]+%?\s+(?:of|de)\s+([0-9.,]+(?:\s*[KMGT]?B)?)/i)
    || text.match(/account\s+storage\s*:\s*([^/]+)\/\s*([^\n]+)/i)
    || text.match(/storage\s*:\s*([\d.,]+\s*[KMGT]?B)\s*of\s*([\d.,]+\s*[KMGT]?B)/i)
    || text.match(/([\d.,]+\s*[KMGT]?B)\s*\/\s*([\d.,]+\s*[KMGT]?B)/i)
    || text.match(/almacenamiento\s+de\s+la\s+cuenta\s*:\s*([^\n]+?)\s*de\s*([^\n]+)/i)
    || text.match(/almacenamiento\s*:\s*([\d.,]+\s*[KMGT]?B)\s*de\s*([\d.,]+\s*[KMGT]?B)/i)

  if (m) {
    used = parseSizeToMB(m[1])
    total = parseSizeToMB(m[2])
  }

  if (!total) {
    const p = text.match(/storage[^\n]*?:\s*([\d.,]+)\s*%[^\n]*?(?:of|de)\s*([\d.,]+\s*[KMGT]?B)[^\n]*?(?:used|usado)?/i)
      || text.match(/almacenamiento[^\n]*?:\s*([\d.,]+)\s*%[^\n]*?(?:de|of)\s*([\d.,]+\s*[KMGT]?B)[^\n]*?(?:usado|used)?/i)
    if (p) {
      total = parseSizeToMB(p[2])
      const pct = parseFloat(String(p[1]).replace(',', '.'))
      if (!Number.isNaN(pct) && Number.isFinite(pct)) {
        used = Math.round((pct / 100) * total)
      }
    }
  }

  return { used, total }
}

function getSessionUploadedMb(accountId) {
  const id = Number(accountId) || 0
  return toSafeNumber(sessionUploadedMbByAccountId.get(id), 0)
}

function registerSessionUploadedMb(accountId, addedMb) {
  const id = Number(accountId) || 0
  if (!id) return
  const current = getSessionUploadedMb(id)
  sessionUploadedMbByAccountId.set(id, current + Math.max(0, toSafeNumber(addedMb, 0)))
}

function createProgressLogger(label) {
  let lastPct = -1
  return (pct) => {
    const normalized = Math.max(0, Math.min(100, Math.round(toSafeNumber(pct, 0))))
    if (normalized <= lastPct) return
    lastPct = normalized
    console.log(`[BATCH][PROGRESS] ${label} ${normalized}%`)
  }
}

function truncateText(text, max = NOTIFICATION_BODY_MAX) {
  const s = normalizeMetaText(text)
  const limit = Number(max)
  if (!Number.isFinite(limit) || limit <= 0) return s
  if (s.length <= limit) return s
  return `${s.slice(0, Math.max(0, limit - 1))}…`
}

function normalizeMetaText(value) {
  const plain = String(value || '').replace(/[\r\n\t]+/g, ' ')
  const compact = plain.replace(/\s{2,}/g, ' ').trim()
  return compact
}

async function notifyAutomation({ title, body, typeStatus = 'ERROR' }) {
  try {
    await prisma.notification.create({
      data: {
        title: truncateText(title, 120),
        body: truncateText(body, NOTIFICATION_BODY_MAX),
        status: 'UNREAD',
        type: 'AUTOMATION',
        typeStatus,
      },
    })
  } catch (e) {
    console.error('[BATCH][NOTIFY][WARN]', e.message)
  }
}

async function refreshMainAccountStorageMetrics(mainAccount, extraCtx = '') {
  const accountId = Number(mainAccount?.id || 0)
  if (!accountId) return null

  const creds = mainAccount?.credentials
  if (!creds) return null

  let payload
  try {
    payload = decryptToJson(creds.encData, creds.encIv, creds.encTag)
  } catch (e) {
    console.warn(`[BATCH][ACCOUNT][REFRESH][WARN] decrypt fail accId=${accountId}: ${e.message}`)
    return null
  }

  const baseFolder = (mainAccount?.baseFolder || '/').replace(/\\/g, '/')
  let storageUsedMB = 0
  let storageTotalMB = 0

  try {
    await withMegaLock(async () => {
      const ctx = `batch-main-metrics accId=${accountId}${extraCtx ? ` ${extraCtx}` : ''}`
      await ensureMegaSessionForAccount(payload, accountId, ctx)

      try {
        const out = await runCmd('mega-df', ['-h'])
        const parsed = parseStorageFromMegaDfText(out)
        storageUsedMB = parsed.used
        storageTotalMB = parsed.total
      } catch (e) {
        console.warn(`[BATCH][ACCOUNT][REFRESH][WARN] mega-df -h accId=${accountId}: ${e.message}`)
      }

      if (!storageTotalMB) {
        try {
          const out = await runCmd('mega-df', [])
          const parsed = parseStorageFromMegaDfText(out)
          storageUsedMB = parsed.used
          storageTotalMB = parsed.total
        } catch (e) {
          console.warn(`[BATCH][ACCOUNT][REFRESH][WARN] mega-df accId=${accountId}: ${e.message}`)
        }
      }

      if (!storageUsedMB) {
        try {
          const out = await runCmd('mega-du', ['-h', baseFolder || '/'])
          const mm = String(out || '').match(/[\r\n]*\s*([\d.,]+\s*[KMGT]?B)/i) || String(out || '').match(/([\d.,]+\s*[KMGT]?B)/i)
          if (mm) storageUsedMB = parseSizeToMB(mm[1])
        } catch (e) {
          console.warn(`[BATCH][ACCOUNT][REFRESH][WARN] mega-du accId=${accountId}: ${e.message}`)
        }
      }
    }, `BATCH-MAIN-METRICS-${accountId}`)
  } catch (e) {
    console.warn(`[BATCH][ACCOUNT][REFRESH][WARN] lock/session accId=${accountId}: ${e.message}`)
    return null
  }

  const prevUsed = toSafeNumber(mainAccount?.storageUsedMB, 0)
  const prevTotal = toSafeNumber(mainAccount?.storageTotalMB, 0)
  if (!storageUsedMB && prevUsed > 0) storageUsedMB = prevUsed
  if (!storageTotalMB && prevTotal > 0) storageTotalMB = prevTotal
  if (storageUsedMB > storageTotalMB) storageTotalMB = storageUsedMB
  if (!storageUsedMB && !storageTotalMB) return null

  try {
    const updated = await prisma.megaAccount.update({
      where: { id: accountId },
      data: {
        storageUsedMB,
        storageTotalMB,
        status: 'CONNECTED',
        statusMessage: null,
        lastCheckAt: new Date(),
      },
      select: { id: true, storageUsedMB: true, storageTotalMB: true },
    })

    // Ya persistimos la métrica real; reseteamos el acumulado de sesión para evitar doble conteo.
    sessionUploadedMbByAccountId.set(accountId, 0)
    console.log(`[BATCH][ACCOUNT][REFRESH][OK] accId=${accountId} used=${updated.storageUsedMB}MB total=${updated.storageTotalMB}MB`)
    return updated
  } catch (e) {
    console.warn(`[BATCH][ACCOUNT][REFRESH][WARN] db update accId=${accountId}: ${e.message}`)
    return null
  }
}

function runCmd(cmd, args = [], opts = {}) {
  return new Promise((resolve, reject) => {
    const timeoutMs = Number(opts?.timeoutMs || MEGA_CMD_TIMEOUT_MS)
    const child = spawn(cmd, args, { shell: true })
    let out = '', err = ''
    let settled = false
    let timer = null

    const cleanup = () => {
      if (timer) clearTimeout(timer)
      timer = null
    }

    const fail = (error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }

    const ok = (value) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        const toKill = Number(child?.pid || 0)
        try { if (toKill) killProcessTreeBestEffort(child, `RUN-CMD ${cmd}`) } catch {}
        fail(new Error(`${cmd} timeout after ${timeoutMs}ms`))
      }, timeoutMs)
    }

    child.stdout.on('data', d => (out += d.toString()))
    child.stderr.on('data', d => (err += d.toString()))
    child.on('error', (e) => fail(new Error(`${cmd} spawn error: ${e.message}`)))
    child.on('close', code =>
      code === 0 ? ok(out) : fail(new Error(`${cmd} exited ${code}: ${(err || out).slice(0, 300)}`))
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

function runUnrar(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('unrar', args, { shell: false })
    let out = '', err = ''
    child.stdout.on('data', d => (out += d.toString()))
    child.stderr.on('data', d => (err += d.toString()))
    child.on('error', (e) => reject(new Error(`Spawn error: ${e.message}`)))
    child.on('close', code =>
      code === 0 ? resolve(out) : reject(new Error(`unrar exited ${code}: ${(err || out).slice(0, 300)}`))
    )
  })
}

function isUnsupportedArchiveMethodError(msg = '') {
  return /unsupported method|no implementado|not implemented/i.test(String(msg || ''))
}

async function extractArchiveWithFallback(archivePath, extractDir) {
  try {
    await run7z(['x', archivePath, `-o${extractDir}`, '-y', '-aoa'])
    return { tool: '7z' }
  } catch (e) {
    const firstErr = String(e?.message || e)
    const ext = path.extname(String(archivePath || '')).toLowerCase()
    if (ext !== '.rar' || !isUnsupportedArchiveMethodError(firstErr)) {
      throw e
    }

    try {
      await runUnrar(['x', '-o+', '-y', archivePath, `${extractDir}${path.sep}`])
      return { tool: 'unrar' }
    } catch (e2) {
      const secondErr = String(e2?.message || e2)
      if (/spawn error:.*unrar/i.test(secondErr)) {
        throw new Error(`RAR no soportado por 7z y no existe 'unrar' instalado. Detalle 7z: ${firstErr.slice(0, 180)}`)
      }
      throw new Error(`7z: ${firstErr.slice(0, 160)} | unrar: ${secondErr.slice(0, 160)}`)
    }
  }
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
  try { await runCmd('mega-logout', [], { timeoutMs: MEGA_CMD_TIMEOUT_MS }); console.log(`[BATCH][LOGOUT][OK] ${ctx}`) }
  catch { console.log(`[BATCH][LOGOUT][WARN] ${ctx}`) }
}

async function megaLogin(payload, ctx) {
  if (payload?.type === 'session' && payload.session) {
    await runCmd('mega-login', [payload.session], { timeoutMs: MEGA_CMD_TIMEOUT_MS })
  } else if (payload?.username && payload?.password) {
    await runCmd('mega-login', [payload.username, payload.password], { timeoutMs: MEGA_CMD_TIMEOUT_MS })
  } else throw new Error('Invalid credentials payload')
  console.log(`[BATCH][LOGIN][OK] ${ctx}`)
}

async function ensureMegaSessionForAccount(payload, accountId, ctx, opts = {}) {
  const forceRelogin = !!opts?.forceRelogin

  if (!forceRelogin && activeMegaSessionAccountId === Number(accountId)) {
    try {
      await runCmd('mega-whoami', [], { timeoutMs: Math.min(MEGA_CMD_TIMEOUT_MS, 20_000) })
      console.log(`[BATCH][LOGIN][SKIP] sesión reutilizada accId=${accountId} ${ctx}`)
      return
    } catch {
      activeMegaSessionAccountId = 0
    }
  }

  if (forceRelogin && activeMegaSessionAccountId === Number(accountId)) {
    try { await megaLogout(`FORCE_RELOGIN acc ${accountId} ${ctx}`) } catch {}
    activeMegaSessionAccountId = 0
  }

  if (activeMegaSessionAccountId > 0 && activeMegaSessionAccountId !== Number(accountId)) {
    try { await megaLogout(`SWITCH acc ${activeMegaSessionAccountId} -> ${accountId}`) } catch {}
    activeMegaSessionAccountId = 0
  }

  await megaLogin(payload, ctx)
  activeMegaSessionAccountId = Number(accountId) || 0
}

// ────────── mega-put CON stall detection (idéntico al uploader) ──────────

function megaPutWithStall({
  srcPath,
  remotePath,
  logPrefix,
  onProgress,
  stallTimeoutMs = STALL_TIMEOUT_MS,
  shouldAbort,
  onRegisterCancel,
}) {
  return new Promise((resolve, reject) => {
    const child = spawn('mega-put', [srcPath, remotePath], { shell: true })
    attachAutoAcceptTerms(child, logPrefix || 'BATCH PUT')

    let settled = false, lastPct = -1, lastProgressAt = Date.now(), stallTimer = null
    let nextNoProgressLogSec = 10

    const noteProgress = (pct) => {
      if (pct > lastPct) {
        lastPct = pct
        lastProgressAt = Date.now()
        nextNoProgressLogSec = 10
      }
      try { onProgress && onProgress(pct) } catch {}
    }

    const parseProgress = (buf) => {
      const txt = buf.toString()
      if (txt && txt.trim()) {
        // Aunque MEGA no imprima porcentajes, hay actividad útil para evitar falsos stalls.
        lastProgressAt = Date.now()
      }
      const re = /([0-9]{1,3}(?:\.[0-9]+)?)\s*%/g
      let m, last = null
      while ((m = re.exec(txt)) !== null) last = m[1]
      if (last !== null) noteProgress(Math.max(0, Math.min(100, parseFloat(last))))
      if (/upload finished/i.test(txt)) noteProgress(100)
    }

    const cleanup = () => { if (stallTimer) clearInterval(stallTimer); stallTimer = null }
    const fail = (err) => { if (settled) return; settled = true; cleanup(); reject(err) }
    const ok   = ()    => { if (settled) return; settled = true; cleanup(); resolve() }

    if (typeof onRegisterCancel === 'function') {
      onRegisterCancel(() => {
        if (settled) return
        killProcessTreeBestEffort(child, logPrefix)
        fail(new Error('FORCE_PROXY_SWITCH_REQUESTED'))
      })
    }

    // Stall watchdog
    if (stallTimeoutMs > 0) {
      stallTimer = setInterval(() => {
        if (typeof shouldAbort === 'function' && shouldAbort()) {
          console.warn(`[BATCH][ABORT] cambio manual de proxy solicitado ${logPrefix}`)
          killProcessTreeBestEffort(child, logPrefix)
          fail(new Error('FORCE_PROXY_SWITCH_REQUESTED'))
          return
        }
        const idle = Date.now() - lastProgressAt
        const idleSec = Math.round(idle / 1000)
        while (idleSec >= nextNoProgressLogSec) {
          const pctText = lastPct >= 0 ? `${Math.round(lastPct)}%` : 'sin % aún'
          console.warn(`[BATCH][NO_PROGRESS] ${logPrefix} sin progreso hace ${nextNoProgressLogSec}s (pct=${pctText})`)
          nextNoProgressLogSec += 10
        }
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

function safeSlugLikeUploader(str) {
  return String(str || '')
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // eliminar diacríticos (á→a, é→e, ñ→n, etc.)
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120)
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

function normalizeTitleBase(raw) {
  const plain = String(raw || '').replace(/^\s*STL\s*-\s*/i, '').trim()
  return plain || 'Asset'
}

function withTitlePrefix(base) {
  return `STL - ${String(base || '').trim()}`
}

async function ensureUniqueAssetTitle(rawTitle) {
  const base = normalizeTitleBase(rawTitle)
  let attempt = 1

  while (attempt <= 500) {
    const candidateBase = attempt === 1 ? base : `${base} (${attempt})`
    const full = withTitlePrefix(candidateBase)
    const exists = await prisma.asset.findFirst({
      where: { OR: [{ title: full }, { titleEn: full }] },
      select: { id: true },
    })
    if (!exists) return full
    attempt += 1
  }

  throw new Error('No unique title available')
}

function ensurePrefixedTitle(rawTitle) {
  const t = String(rawTitle || '').trim()
  if (!t) return 'STL - Asset'
  return /^\s*stl\s*-/i.test(t) ? t : `STL - ${t}`
}

function normalizeToken(raw) {
  return String(raw || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
}

function firstNonEmpty(...values) {
  for (const v of values) {
    const s = String(v || '').trim()
    if (s) return s
  }
  return ''
}

function normalizeTagInput(rawTag) {
  if (typeof rawTag === 'string') {
    const value = firstNonEmpty(rawTag)
    return {
      id: 0,
      name: value,
      nameEn: value,
      slug: slugify(value) || 'tag',
      slugEn: slugify(value) || null,
    }
  }

  const id = Number(rawTag?.id || 0)
  const name = firstNonEmpty(rawTag?.name, rawTag?.es, rawTag?.label)
  const nameEn = firstNonEmpty(rawTag?.nameEn, rawTag?.en, name)
  const slug = firstNonEmpty(rawTag?.slug, slugify(nameEn || name), 'tag')
  const slugEn = firstNonEmpty(rawTag?.slugEn, slugify(nameEn), slugify(name), '')

  return {
    id,
    name,
    nameEn,
    slug,
    slugEn: slugEn || null,
  }
}

function collectTagKeys(tag) {
  return [
    normalizeToken(tag?.name),
    normalizeToken(tag?.nameEn),
    normalizeToken(tag?.slug),
    normalizeToken(tag?.slugEn),
  ].filter(Boolean)
}

function makeUniqueValue(base, usedSet, fallback = 'tag') {
  let candidate = String(base || '').trim() || fallback
  let idx = 1
  while (usedSet.has(normalizeToken(candidate))) {
    idx += 1
    candidate = `${String(base || fallback).trim() || fallback}-${idx}`
  }
  return candidate
}

async function resolveTagConnectIds(rawTags) {
  if (!Array.isArray(rawTags) || rawTags.length === 0) return []

  const parsed = rawTags.map(normalizeTagInput)
    .filter((t) => t.id > 0 || t.name || t.nameEn || t.slug)

  if (!parsed.length) return []

  const existing = await prisma.tag.findMany({
    select: { id: true, name: true, nameEn: true, slug: true, slugEn: true },
  })

  const byId = new Map(existing.map((t) => [Number(t.id), t]))
  const byKey = new Map()
  const usedName = new Set()
  const usedSlug = new Set()
  const usedSlugEn = new Set()

  for (const t of existing) {
    usedName.add(normalizeToken(t.name))
    usedSlug.add(normalizeToken(t.slug))
    if (t.slugEn) usedSlugEn.add(normalizeToken(t.slugEn))
    for (const key of collectTagKeys(t)) byKey.set(key, t)
  }

  const connectIds = []
  const seenIds = new Set()

  for (const input of parsed) {
    let found = null

    if (input.id > 0) {
      found = byId.get(input.id) || null
    }

    if (!found) {
      const inputKeys = collectTagKeys(input)
      found = inputKeys.map((k) => byKey.get(k)).find(Boolean) || null
    }

    if (!found) {
      const baseName = firstNonEmpty(input.name, input.nameEn, input.slug, 'tag')
      const baseNameEn = firstNonEmpty(input.nameEn, input.name, baseName)
      const baseSlug = firstNonEmpty(input.slug, slugify(baseNameEn), slugify(baseName), 'tag')
      const baseSlugEn = firstNonEmpty(input.slugEn, slugify(baseNameEn), slugify(baseName), '')

      const uniqueName = makeUniqueValue(baseName, usedName, 'tag')
      usedName.add(normalizeToken(uniqueName))

      const uniqueSlug = makeUniqueValue(baseSlug, usedSlug, 'tag')
      usedSlug.add(normalizeToken(uniqueSlug))

      const uniqueSlugEn = baseSlugEn ? makeUniqueValue(baseSlugEn, usedSlugEn, '') : ''
      if (uniqueSlugEn) usedSlugEn.add(normalizeToken(uniqueSlugEn))

      try {
        found = await prisma.tag.create({
          data: {
            name: uniqueName,
            nameEn: baseNameEn,
            slug: uniqueSlug,
            slugEn: uniqueSlugEn || null,
          },
          select: { id: true, name: true, nameEn: true, slug: true, slugEn: true },
        })
      } catch {
        const fallback = await prisma.tag.findFirst({
          where: {
            OR: [
              { slug: uniqueSlug },
              { name: uniqueName },
            ],
          },
          select: { id: true, name: true, nameEn: true, slug: true, slugEn: true },
        })
        found = fallback || null
      }

      if (found) {
        byId.set(Number(found.id), found)
        for (const key of collectTagKeys(found)) byKey.set(key, found)
      }
    }

    const foundId = Number(found?.id || 0)
    if (foundId > 0 && !seenIds.has(foundId)) {
      seenIds.add(foundId)
      connectIds.push(foundId)
    }
  }

  return connectIds
}

// ──────────────────── EXTRACT + RECOMPRESS ────────────────────

async function extractInnerArchives(folderPath) {
  const archives = getAllFiles(folderPath).filter(f => ARCHIVE_EXTS.includes(path.extname(f).toLowerCase()))
  for (const arc of archives) {
    try {
      const extraction = await extractArchiveWithFallback(arc, path.dirname(arc))
      fs.unlinkSync(arc)
      console.log(`[BATCH][EXTRACT] OK ${path.basename(arc)} (tool=${extraction.tool})`)
    } catch (e) { console.error(`[BATCH][EXTRACT] Error ${path.basename(arc)}: ${e.message}`) }
  }
}

async function recompressFolder(folderPath, outputName) {
  fs.mkdirSync(STAGING_DIR, { recursive: true })
  const outputRarPath = path.join(STAGING_DIR, `${outputName}.rar`)
  const outputZipPath = path.join(STAGING_DIR, `${outputName}.zip`)
  if (fs.existsSync(outputRarPath)) fs.unlinkSync(outputRarPath)
  if (fs.existsSync(outputZipPath)) fs.unlinkSync(outputZipPath)

  // Intento primario: RAR. En algunos entornos 7z no soporta creación de RAR.
  try {
    await run7z(['a', '-trar', outputRarPath, path.join(folderPath, '*'), '-r', '-mx0'])
    const sizeMB = fs.existsSync(outputRarPath) ? (fs.statSync(outputRarPath).size / (1024 * 1024)).toFixed(1) : 0
    console.log(`[BATCH][RECOMPRESS] OK → ${outputName}.rar (${sizeMB} MB)`)
    return { outputPath: outputRarPath, ext: 'rar' }
  } catch (e) {
    const msg = String(e?.message || e)
    if (!/no implementado|not implemented/i.test(msg)) throw e
    console.warn('[BATCH][RECOMPRESS][WARN] RAR no soportado por 7z en este host, fallback a ZIP')
  }

  await run7z(['a', '-tzip', outputZipPath, path.join(folderPath, '*'), '-r', '-mx0'])
  const sizeMB = fs.existsSync(outputZipPath) ? (fs.statSync(outputZipPath).size / (1024 * 1024)).toFixed(1) : 0
  console.log(`[BATCH][RECOMPRESS] OK → ${outputName}.zip (${sizeMB} MB)`)
  return { outputPath: outputZipPath, ext: 'zip' }
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
        .resize({ width: 1600, withoutEnlargement: true })
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
  const itemIdCtx = Number(account.__batchItemId || 0)
  const ctx = `batch-${role} item=${itemIdCtx || '-'} accId=${account.id} alias=${account.alias || '--'}`
  const accountIdNum = Number(account.id) || 0
  if (!fs.existsSync(archivePath)) throw new Error('Local archive not found: ' + archivePath)
  const archiveSizeMb = fs.statSync(archivePath).size / (1024 * 1024)
  let publicLink = null
  const triedProxyUrls = new Set()
  let lastProxyUrl = preferredProxyByAccountId.get(accountIdNum) || ''
  const accountSwitching = activeMegaSessionAccountId > 0 && activeMegaSessionAccountId !== accountIdNum
  let forceReloginNextAttempt = false
  let forceSkipLastProxy = false

  for (let attempt = 1; attempt <= MAX_STALL_RETRIES; attempt++) {
    try {
      if (hasBatchStopRequest(account.__batchItemId)) {
        throw new Error('BATCH_STOP_REQUESTED')
      }

      const manualSwitchRequested = consumeBatchProxySwitchRequest(account.__batchItemId)
      if (manualSwitchRequested && lastProxyUrl) {
        triedProxyUrls.add(lastProxyUrl)
      }

      const usedMb = toSafeNumber(account.storageUsedMB, 0)
      const sessionUploadedMb = getSessionUploadedMb(accountIdNum)
      const projectedMb = usedMb + sessionUploadedMb + archiveSizeMb
      if (projectedMb > MAX_ACCOUNT_UPLOAD_MB) {
        throw new Error(
          `ACCOUNT_STORAGE_LIMIT_REACHED_${MAX_ACCOUNT_UPLOAD_MB}MB accId=${account.id} role=${role} used=${usedMb.toFixed(2)}MB session=${sessionUploadedMb.toFixed(2)}MB incoming=${archiveSizeMb.toFixed(2)}MB projected=${projectedMb.toFixed(2)}MB`
        )
      }

      await withMegaLock(async () => {
        const proxies = await listMegaProxies()
        if (!proxies.length) {
          throw new Error('PROXY_REQUIRED_NO_PROXIES_AVAILABLE')
        }

        let picked = null
        const shouldReuseLastProxy = Boolean(
          lastProxyUrl
          && attempt === 1
          && !forceSkipLastProxy
          && !manualSwitchRequested
          && !(accountSwitching && activeMegaProxyUrl && lastProxyUrl === activeMegaProxyUrl)
        )
        if (shouldReuseLastProxy) {
          picked = proxies.find((p) => p?.proxyUrl === lastProxyUrl) || null
          if (picked?.proxyUrl) {
            console.log(`[BATCH][PROXY][REUSE] ${picked.proxyUrl} ${ctx}`)
          }
        }

        if (!picked) {
          let candidatePool = proxies.filter((p) => p?.proxyUrl && !triedProxyUrls.has(p.proxyUrl))
          if (accountSwitching && activeMegaProxyUrl) {
            const withoutActiveProxy = candidatePool.filter((p) => p.proxyUrl !== activeMegaProxyUrl)
            if (withoutActiveProxy.length) candidatePool = withoutActiveProxy
          }
          if (lastProxyUrl) {
            const withoutLast = candidatePool.filter((p) => p.proxyUrl !== lastProxyUrl)
            if (withoutLast.length) candidatePool = withoutLast
          }
          if (!candidatePool.length) {
            candidatePool = proxies.filter((p) => p?.proxyUrl && (!lastProxyUrl || p.proxyUrl !== lastProxyUrl))
          }
          if (!candidatePool.length) {
            candidatePool = proxies.filter((p) => p?.proxyUrl)
          }
          picked = candidatePool[Math.floor(Math.random() * candidatePool.length)]
        }

        if (!picked?.proxyUrl) {
          throw new Error('PROXY_REQUIRED_NO_VALID_PROXY')
        }

        const proxyResult = await applyMegaProxy(picked, { ctx, timeoutMs: 15000, clearOnFail: false })
        if (!proxyResult?.enabled) {
          throw new Error(`PROXY_REQUIRED_APPLY_FAIL: ${proxyResult?.error || 'unknown'}`)
        }
        triedProxyUrls.add(picked.proxyUrl)
        lastProxyUrl = picked.proxyUrl
        activeMegaProxyUrl = picked.proxyUrl
        preferredProxyByAccountId.set(accountIdNum, picked.proxyUrl)
        console.log(`[BATCH][PROXY][OK] ${picked.proxyUrl} ${ctx}`)

        let cancelUploadNow = null
        registerActiveBatchUpload(account.__batchItemId, {
          phase: role,
          accountId: account.id,
          proxyUrl: picked.proxyUrl,
          cancel: () => {
            if (typeof cancelUploadNow === 'function') cancelUploadNow()
          },
        })
        updateActiveBatchUpload(account.__batchItemId, { proxyUrl: picked.proxyUrl })

        if (forceReloginNextAttempt) {
          try { await megaLogout(`STALL_RECOVERY acc ${account.id} ${ctx}`) } catch {}
          activeMegaSessionAccountId = 0
        }

        await ensureMegaSessionForAccount(payload, account.id, ctx, { forceRelogin: forceReloginNextAttempt })
        await safeMkdir(remotePath)
        forceReloginNextAttempt = false
        forceSkipLastProxy = false

        console.log(`[BATCH][UPLOAD][${role.toUpperCase()}] attempt=${attempt} ${path.basename(archivePath)} → ${remotePath}`)

        await megaPutWithStall({
          srcPath: archivePath,
          remotePath,
          logPrefix: `batch-${role} item=${itemIdCtx || '-'} accId=${account.id} attempt=${attempt}`,
          stallTimeoutMs: STALL_TIMEOUT_MS,
          onProgress,
          shouldAbort: () => hasBatchProxySwitchRequest(account.__batchItemId) || hasBatchStopRequest(account.__batchItemId),
          onRegisterCancel: (cancelFn) => { cancelUploadNow = cancelFn },
        })

        // Link público solo en role=main
        if (role === 'main') {
          try {
            const remoteFile = path.posix.join(remotePath, path.basename(archivePath))
            publicLink = await megaExportLink(remoteFile)
            if (publicLink) console.log(`[BATCH][LINK] ${publicLink}`)
          } catch (e) { console.warn(`[BATCH][EXPORT] warn: ${e.message}`) }
        }

        clearActiveBatchUpload(account.__batchItemId)
      }, `BATCH-${role.toUpperCase()}-${account.id}`)

      console.log(`[BATCH][${role.toUpperCase()}][OK] accId=${account.id}`)
      registerSessionUploadedMb(accountIdNum, archiveSizeMb)
      return publicLink  // éxito → salir del retry loop

    } catch (e) {
      clearActiveBatchUpload(account.__batchItemId)
      const msg = String(e?.message || e)
      console.error(`[BATCH][${role.toUpperCase()}][FAIL] attempt=${attempt}/${MAX_STALL_RETRIES} accId=${account.id}: ${msg}`)
      if (/BATCH_STOP_REQUESTED/i.test(msg)) {
        throw new Error('BATCH_STOP_REQUESTED')
      }
      if (/FORCE_PROXY_SWITCH_REQUESTED/i.test(msg)) {
        // Reintento inmediato, sin consumir cupo por acción manual de "otro proxy".
        attempt -= 1
        forceSkipLastProxy = true
        forceReloginNextAttempt = true
        await sleep(350)
        continue
      }

      const looksLikeStall = /MEGA_PUT_STALL_TIMEOUT|timeout after|mega-put exited/i.test(msg)
      if (looksLikeStall && lastProxyUrl) {
        triedProxyUrls.add(lastProxyUrl)
        forceSkipLastProxy = true
        forceReloginNextAttempt = true
        console.warn(`[BATCH][${role.toUpperCase()}][RECOVERY] stall/timeout detectado, forzando logout+relogin+proxy-rotate accId=${account.id}`)
      }

      if (attempt >= MAX_STALL_RETRIES) {
        preferredProxyByAccountId.delete(accountIdNum)
        throw e
      }
      // Espera antes de reintentar
      await sleep(5000)
    }
  }
}

// ──────────────────── CREAR ASSET EN BD (idéntico al uploader) ────────────────────

async function createAssetRecord({ slug, title, titleEn, description, descriptionEn, archiveName, images, account, megaLink, sizeBytes, tags, categories }) {
  const fullTitle = await ensureUniqueAssetTitle(title)
  const fullTitleEn = ensurePrefixedTitle(titleEn || title)
  const archiveSizeB = BigInt(sizeBytes || 0)
  const rawDescriptionEs = String(description || '').trim()
  const rawDescriptionEn = String(descriptionEn || '').trim()
  const descriptionEs = normalizeMetaText(rawDescriptionEs)
  const descriptionEnSafe = normalizeMetaText(rawDescriptionEn)

  const data = {
    title: fullTitle,
    titleEn: fullTitleEn,
    description: descriptionEs || descriptionEnSafe || null,
    descriptionEn: descriptionEnSafe || descriptionEs || null,
    slug,
    archiveName,
    archiveSizeB,
    fileSizeB: archiveSizeB,
    images: images || [],
    status: 'PUBLISHED',
    megaLink: megaLink || null,
    megaLinkAlive: !!megaLink,
    megaLinkCheckedAt: megaLink ? new Date() : null,
    accountId: account.id,
    isPremium: true,
  }

  // Conectar categorías/tags con relaciones si se enviaron
  if (Array.isArray(categories) && categories.length > 0) {
    data.categories = { connect: categories.map(c => ({ id: typeof c === 'object' ? c.id : Number(c) })).filter(c => c.id) }
  }
  if (Array.isArray(tags) && tags.length > 0) {
    const tagIds = await resolveTagConnectIds(tags)
    if (tagIds.length > 0) {
      data.tags = { connect: tagIds.map((id) => ({ id })) }
    }
  }

  const asset = await prisma.asset.create({ data })
  console.log(`[BATCH][ASSET] Creado id=${asset.id} slug=${slug} title="${fullTitle}"`)
  return asset
}

// ──────────────────── MAIN PHASE (PREPARAR + SUBIR MAIN + CREAR ASSET) ────────────────────

async function prepareItemForMain(item, updateItem) {
  const batchFolder = await prisma.batchImport.findUnique({ where: { id: item.batchId } })
  // Resolver ruta: buscar primero en batch_imports (SCP), luego en telegram_downloads_organized
  let folderPath = path.join(BATCH_DIR, batchFolder?.folderName || '', item.folderName)
  if (!fs.existsSync(folderPath)) {
    const altPath = path.join(TELEGRAM_DIR, batchFolder?.folderName || '', item.folderName)
    if (fs.existsSync(altPath)) folderPath = altPath
  }
  const friendlyName = item.title || item.folderName || `item-${item.id}`
  const titleForSlug = ensurePrefixedTitle(friendlyName)
  const baseSlug = safeSlugLikeUploader(titleForSlug) || slugify(item.folderName || friendlyName)
  const slug = await uniqueSlug(baseSlug)

  console.log(`\n${'='.repeat(60)}`)
  console.log(`[BATCH][MAIN] Procesando item #${item.id}: ${friendlyName} → slug="${slug}"`)
  console.log(`${'='.repeat(60)}\n`)

  if (!fs.existsSync(folderPath)) throw new Error(`Carpeta no encontrada: ${folderPath}`)
  if (!item.targetAccount) throw new Error('No tiene cuenta MEGA asignada')

  let mainAccount = await prisma.megaAccount.findUnique({
    where: { id: item.targetAccount },
    include: {
      credentials: true,
      backups: { include: { backupAccount: { include: { credentials: true } } } },
    },
  })
  if (!mainAccount) throw new Error(`Cuenta MEGA id=${item.targetAccount} no encontrada`)

  let backupAccounts = (mainAccount.backups || [])
    .map((b) => b.backupAccount)
    .filter((b) => b && b.type === 'backup')

  await updateItem({ error: 'Extrayendo archivos internos...', mainStatus: 'EXTRACTING' })
  await extractInnerArchives(folderPath)

  await updateItem({ error: 'Procesando imágenes...' })
  const imagePaths = await extractImages(folderPath, slug)

  await updateItem({ error: 'Comprimiendo archivo final...', mainStatus: 'COMPRESSING' })
  const packed = await recompressFolder(folderPath, slug)
  const stagingArchivePath = packed.outputPath
  const archiveSizeBytes = fs.statSync(stagingArchivePath).size

  // -- NEW AUTO DISTRIBUTION LOGIC --
  const archiveSizeMb = archiveSizeBytes / (1024 * 1024)
  const usedMb = toSafeNumber(mainAccount.storageUsedMB, 0)
  const sessionUploadedMb = getSessionUploadedMb(mainAccount.id)
  const projectedMb = usedMb + sessionUploadedMb + archiveSizeMb

  if (projectedMb > MAX_ACCOUNT_UPLOAD_MB) {
    console.warn(`[BATCH][MAIN] Cuenta original ${mainAccount.id} llena (Proyectado: ${projectedMb.toFixed(2)} MB). Buscando alternativa...`)
    const batchItems = await prisma.batchImportItem.findMany({
      where: { batchId: item.batchId },
      select: { targetAccount: true }
    })
    const preferredIds = Array.from(new Set(batchItems.map(i => i.targetAccount).filter(Boolean)))
    
    const candidates = await prisma.megaAccount.findMany({
      where: { type: 'main', status: 'CONNECTED', suspended: false, ignoreInUploadBatch: false },
      include: {
        credentials: true,
        backups: { include: { backupAccount: { include: { credentials: true } } } },
      },
    })
    
    const accountsWithSpace = candidates.map(acc => {
      const u = toSafeNumber(acc.storageUsedMB, 0)
      const s = getSessionUploadedMb(acc.id)
      const p = u + s + archiveSizeMb
      return { acc, p, isPreferred: preferredIds.includes(acc.id) }
    }).filter(x => x.p <= MAX_ACCOUNT_UPLOAD_MB)
    
    if (accountsWithSpace.length > 0) {
      accountsWithSpace.sort((a, b) => {
        if (a.isPreferred && !b.isPreferred) return -1
        if (!a.isPreferred && b.isPreferred) return 1
        return a.p - b.p // Escoger la de menor espacio ocupado
      })
      const newAccount = accountsWithSpace[0].acc
      console.log(`[BATCH][MAIN] Reasignando item ${item.id} a cuenta alternativa ${newAccount.id} (${newAccount.alias})`)
      
      await updateItem({ targetAccount: newAccount.id })
      item.targetAccount = newAccount.id
      mainAccount = newAccount
      backupAccounts = (mainAccount.backups || []).map((b) => b.backupAccount).filter((b) => b && b.type === 'backup')
    } else {
      console.warn(`[BATCH][MAIN] No se encontraron cuentas alternativas con espacio suficiente para ${archiveSizeMb.toFixed(2)} MB.`)
    }
  }
  // -- END NEW LOGIC --

  const archDir = path.join(ARCHIVES_DIR, slug)
  fs.mkdirSync(archDir, { recursive: true })
  const finalArchivePath = path.join(archDir, `${slug}.${packed.ext}`)
  fs.copyFileSync(stagingArchivePath, finalArchivePath)
  const archiveName = path.relative(ARCHIVES_DIR, finalArchivePath).replace(/\\/g, '/')

  return {
    folderPath,
    friendlyName,
    slug,
    imagePaths,
    archiveSizeBytes,
    archiveName,
    stagingArchivePath,
    finalArchivePath,
    mainAccount,
    backupAccounts,
  }
}

async function processMainQueueItem(item) {
  // Cancelar auto-logout pendiente para que MEGAcmd no muera durante preparación
  cancelPendingAutoLogout()
  const updateItem = (data) => prisma.batchImportItem.update({ where: { id: item.id }, data })

  await updateItem({
    status: 'PROCESSING',
    mainStatus: 'PENDING',
    backupStatus: 'PENDING',
    mainProgress: 0,
    error: 'Iniciando fase MAIN...',
  })

  let ctx = null

  try {
    ctx = await prepareItemForMain(item, updateItem)

    await updateItem({ error: 'Subiendo a MEGA (Main)...', mainStatus: 'UPLOADING', mainProgress: 0 })
    const logMainProgress = createProgressLogger(`item=${item.id} role=MAIN acc=${ctx.mainAccount.id}`)
    const megaLink = await uploadToAccountWithRetry({
      archivePath: ctx.finalArchivePath,
      slug: ctx.slug,
      account: { ...ctx.mainAccount, __batchItemId: item.id },
      role: 'main',
      onProgress: async (pct) => {
        logMainProgress(pct)
        try { await updateItem({ mainProgress: Math.round(pct) }) } catch {}
      },
    })

    await updateItem({ mainStatus: 'OK', mainProgress: 100, error: 'Actualizando espacio de cuenta...' })
    const refreshedMain = await refreshMainAccountStorageMetrics(ctx.mainAccount, `item=${item.id}`)
    if (refreshedMain) {
      ctx.mainAccount.storageUsedMB = Number(refreshedMain.storageUsedMB || ctx.mainAccount.storageUsedMB || 0)
      ctx.mainAccount.storageTotalMB = Number(refreshedMain.storageTotalMB || ctx.mainAccount.storageTotalMB || 0)
    }
    await updateItem({ mainStatus: 'OK', mainProgress: 100, error: 'Guardando en base de datos...' })

    const asset = await createAssetRecord({
      slug: ctx.slug,
      title: item.title || ctx.friendlyName,
      titleEn: item.titleEn || item.title || ctx.friendlyName,
      description: item.description,
      descriptionEn: item.descriptionEn,
      archiveName: ctx.archiveName,
      images: ctx.imagePaths,
      account: ctx.mainAccount,
      megaLink,
      sizeBytes: ctx.archiveSizeBytes,
      tags: item.tags,
      categories: item.categories,
    })

    qdrantMultimodalService.upsertAssetMultimodalVector(asset.id).catch(err => console.error('[QDRANT][BATCH] Error generando vector multimodal:', err));

    const hasBackups = ctx.backupAccounts.length > 0
    await updateItem({
      status: 'COMPLETED',
      error: hasBackups ? 'Main completado. Pendiente fase BACKUP...' : null,
      createdAssetId: asset.id,
      archiveFile: path.basename(ctx.finalArchivePath),
      backupStatus: hasBackups ? 'PENDING' : 'N/A',
      mainStatus: 'OK',
      mainProgress: 100,
    })

    // Si no hay backups, el archivo local ya no es necesario tras MAIN.
    if (!hasBackups) {
      deleteLocalArchiveBestEffort(ctx.finalArchivePath, `item=${item.id} phase=main noBackups`)
    }

    try { if (fs.existsSync(ctx.stagingArchivePath)) fs.unlinkSync(ctx.stagingArchivePath) } catch {}
    try { if (fs.existsSync(ctx.folderPath)) fs.rmSync(ctx.folderPath, { recursive: true, force: true }) } catch {}
    console.log(`[BATCH][MAIN][OK] item=${item.id} asset=${asset.id}`)
  } catch (err) {
    const msg = String(err?.message || err).slice(0, 500)
    const manualStop = /BATCH_STOP_REQUESTED/i.test(msg)

    if (manualStop) {
      await updateItem({
        status: 'DRAFT',
        mainStatus: 'PENDING',
        backupStatus: 'PENDING',
        mainProgress: 0,
        error: 'Detenido manualmente. Devuelto a borrador.',
      })
      clearBatchStopRequest(item.id)
      if (ctx?.finalArchivePath) {
        deleteLocalArchiveBestEffort(ctx.finalArchivePath, `item=${item.id} phase=main manual-stop`)
      }
      return
    }

    const accId = Number(ctx?.mainAccount?.id || item?.targetAccount || 0) || '-'
    const folderName = String(item?.folderName || '').trim() || '-'
    const slug = String(ctx?.slug || '').trim() || '-'
    const stackTop = String(err?.stack || '').split('\n').slice(0, 3).join(' | ').slice(0, 500)

    console.error(`[BATCH][MAIN][FAIL] item=${item.id} acc=${accId} folder=${folderName} slug=${slug} err=${msg}`)
    if (stackTop) {
      console.error(`[BATCH][MAIN][ERROR_STACK] item=${item.id} ${stackTop}`)
    }
    await updateItem({
      status: 'FAILED',
      mainStatus: 'ERROR',
      backupStatus: 'ERROR',
      error: msg,
    })
    await notifyAutomation({
      title: `Batch MAIN falló (item #${item.id})`,
      body: `folder=${item.folderName || '-'} acc=${item.targetAccount || '-'} err=${msg}`,
      typeStatus: 'ERROR',
    })

    // Evita acumulación de archivos huérfanos si el MAIN falla tras copiar a /archives.
    if (ctx?.finalArchivePath) {
      deleteLocalArchiveBestEffort(ctx.finalArchivePath, `item=${item.id} phase=main failed`)
    }
  }
}

// ──────────────────── BACKUP PHASE (SOLO REPLICACIÓN) ────────────────────

async function processBackupsForCompletedItem(item) {
  // Cancelar auto-logout pendiente para que MEGAcmd no muera durante preparación
  cancelPendingAutoLogout()
  const updateItem = (data) => prisma.batchImportItem.update({ where: { id: item.id }, data })

  try {
    if (hasBatchStopRequest(item.id)) throw new Error('BATCH_STOP_REQUESTED')

    if (!item.createdAssetId) throw new Error('createdAssetId faltante para fase backup')

    const asset = await prisma.asset.findUnique({
      where: { id: item.createdAssetId },
      select: {
        id: true,
        slug: true,
        title: true,
        accountId: true,
        archiveName: true,
      },
    })
    if (!asset) throw new Error(`Asset id=${item.createdAssetId} no encontrado`)

    const mainAccount = await prisma.megaAccount.findUnique({
      where: { id: asset.accountId },
      include: { backups: { include: { backupAccount: { include: { credentials: true } } } } },
    })
    if (!mainAccount) throw new Error(`Cuenta principal no encontrada para asset=${asset.id}`)

    const backupAccounts = (mainAccount.backups || [])
      .map((b) => b.backupAccount)
      .filter((b) => b && b.type === 'backup')

    if (!backupAccounts.length) {
      await updateItem({ backupStatus: 'N/A', status: 'COMPLETED', error: null })
      return
    }

    const archiveRel = String(asset.archiveName || '').replace(/^\/+/, '')
    const archivePath = archiveRel ? path.join(ARCHIVES_DIR, archiveRel) : ''
    if (!archivePath || !fs.existsSync(archivePath)) {
      throw new Error(`Archivo local no encontrado para backup: ${archiveRel || '(vacío)'}`)
    }

    await updateItem({ backupStatus: 'UPLOADING', error: 'Replicando a backups...' })

    const failedBackups = []
    for (const backup of backupAccounts) {
      if (hasBatchStopRequest(item.id)) throw new Error('BATCH_STOP_REQUESTED')
      try {
        const logBackupProgress = createProgressLogger(`item=${item.id} role=BACKUP acc=${backup.id}`)
        await uploadToAccountWithRetry({
          archivePath,
          slug: asset.slug,
          account: { ...backup, __batchItemId: item.id },
          role: 'backup',
          onProgress: (pct) => {
            logBackupProgress(pct)
          },
        })

        // Mantener storage de backups sincronizado tras cada transacción de subida.
        try {
          await refreshMainAccountStorageMetrics(backup, `item=${item.id} phase=backup acc=${backup.id}`)
        } catch {}
      } catch (e) {
        const msg = String(e?.message || e)
        failedBackups.push({ id: backup.id, alias: backup.alias || backup.email || `acc-${backup.id}`, error: msg })
      }
    }

    if (failedBackups.length > 0) {
      const summary = failedBackups
        .map((f) => `${f.alias}(${f.id})`) 
        .join(', ')

      await updateItem({
        status: 'FAILED',
        backupStatus: 'ERROR',
        error: truncateText(`Backups con fallo: ${summary}`, 500),
      })

      await notifyAutomation({
        title: `Batch BACKUP con fallos (item #${item.id})`,
        body: `asset=${asset.id} slug=${asset.slug} fallos=${failedBackups.length} cuentas=[${summary}]`,
        typeStatus: 'ERROR',
      })
      return
    }

    await updateItem({ backupStatus: 'OK', status: 'COMPLETED', error: null })

    // Tras completar BACKUPs, el archivo local puede eliminarse.
    deleteLocalArchiveBestEffort(archivePath, `item=${item.id} phase=backup completed`)

    console.log(`[BATCH][BACKUP][OK] item=${item.id} asset=${asset.id}`)
  } catch (err) {
    const msg = String(err?.message || err).slice(0, 500)
    const manualStop = /BATCH_STOP_REQUESTED/i.test(msg)

    if (manualStop) {
      await updateItem({
        status: 'DRAFT',
        mainStatus: 'OK',
        backupStatus: 'ERROR',
        error: 'Main ya subido. Backup detenido manualmente para identificar y reintentar.',
      })
      clearBatchStopRequest(item.id)
      return
    }

    console.error(`[BATCH][BACKUP][FAIL] item=${item.id}:`, msg)
    await updateItem({
      status: 'FAILED',
      backupStatus: 'ERROR',
      error: msg,
    })
    await notifyAutomation({
      title: `Batch BACKUP falló (item #${item.id})`,
      body: `asset=${item.createdAssetId || '-'} err=${msg}`,
      typeStatus: 'ERROR',
    })
  }
}

// ──────────────────── LOOP PRINCIPAL ────────────────────

export async function startBatchWorker() {
  console.log('[BatchWorker] ✅ Worker iniciado y monitoreando la cola...')
  for (const dir of [BATCH_DIR, STAGING_DIR, ARCHIVES_DIR, IMAGES_DIR]) {
    fs.mkdirSync(dir, { recursive: true })
  }

  while (true) {
    try {
      // Fase 1 prioritaria: terminar todos los MAIN antes de arrancar BACKUPS.
      let nextMainItem = null

      // Si hay sesión MAIN activa, drenar primero esa misma cuenta para evitar saltos de cuenta.
      if (Number(activeMegaSessionAccountId || 0) > 0) {
        nextMainItem = await prisma.batchImportItem.findFirst({
          where: {
            status: 'QUEUED',
            targetAccount: Number(activeMegaSessionAccountId),
          },
          orderBy: { createdAt: 'asc' },
        })
      }

      // Si no hay pendiente para la cuenta activa, escoger por orden de cuenta y luego antiguedad.
      if (!nextMainItem) {
        nextMainItem = await prisma.batchImportItem.findFirst({
          where: { status: 'QUEUED' },
          orderBy: [
            { targetAccount: 'asc' },
            { createdAt: 'asc' },
          ],
        })
      }

      if (nextMainItem) {
        await processMainQueueItem(nextMainItem)
        await sleep(1500)
        continue
      }

      // Fase 2: cuando no quedan MAIN pendientes, correr BACKUPS de los que ya completaron MAIN.
      const nextBackupItem = await prisma.batchImportItem.findFirst({
        where: {
          status: 'COMPLETED',
          backupStatus: 'PENDING',
          createdAssetId: { not: null },
        },
        orderBy: { createdAt: 'asc' },
      })

      if (nextBackupItem) {
        await processBackupsForCompletedItem(nextBackupItem)
        await sleep(1500)
        continue
      }

      await sleep(POLL_INTERVAL_MS)
    } catch (err) {
      console.error('[BatchWorker] Error no controlado:', err.message)
      await sleep(POLL_INTERVAL_MS)
    }
  }
}
