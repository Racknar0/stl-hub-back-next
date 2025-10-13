import fs from 'fs'
import path from 'path'
import { log } from './logger.js'

const UPLOADS_DIR = path.resolve('uploads')
const SYNC_CACHE_DIR = path.join(UPLOADS_DIR, 'sync-cache')
const FLAG_PATH = process.env.UPLOADS_ACTIVE_FLAG || path.join(SYNC_CACHE_DIR, 'uploads-active.lock')

let activeCount = 0
let timer = null

function ensureDir(p){ if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }) }

function touchFlag(){
  try {
    ensureDir(path.dirname(FLAG_PATH))
    const now = new Date()
    // Escribir timestamp para actualizar mtime y contenido
    fs.writeFileSync(FLAG_PATH, now.toISOString())
    // Asegurar mtime reciente incluso en FS con caché
    try { fs.utimesSync(FLAG_PATH, now, now) } catch {}
  } catch (e){
    log?.warn && log.warn('[UPLOADS-FLAG] touch warn: '+e.message)
  }
}

export function startUploadsActive(label=''){
  activeCount++
  if (activeCount === 1){
    touchFlag()
    timer = setInterval(() => touchFlag(), Number(process.env.UPLOADS_ACTIVE_HEARTBEAT_MS || 30000))
    log?.info && log.info(`[UPLOADS-FLAG] ACTIVADO contador=${activeCount} ${label?`(${label})`:''}`)
  } else {
    log?.verbose && log.verbose(`[UPLOADS-FLAG] contador=${activeCount} ${label?`(${label})`:''}`)
  }
  let stopped = false
  return function stop(){
    if (stopped) return
    stopped = true
    activeCount = Math.max(0, activeCount - 1)
    if (activeCount === 0){
      if (timer){ try { clearInterval(timer) } catch {} timer = null }
      // Intentar borrar el flag inmediatamente; si falla, lo dejará expirar por tiempo
      try { if (fs.existsSync(FLAG_PATH)) fs.unlinkSync(FLAG_PATH) } catch {}
      log?.info && log.info('[UPLOADS-FLAG] DESACTIVADO (contador=0)')
    } else {
      log?.verbose && log.verbose(`[UPLOADS-FLAG] stop parcial contador=${activeCount}`)
    }
  }
}

export async function withUploadsActive(fn, label=''){
  const stop = startUploadsActive(label)
  try { return await fn() } finally { try { stop() } catch{} }
}

export function isUploadsActive(){ return activeCount > 0 }
