import { PrismaClient } from '@prisma/client'
import { decryptToJson } from './cryptoUtils.js'
import { withMegaLock } from './megaQueue.js'
import { spawn } from 'child_process'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { log } from './logger.js'

/*
  Script: validateAssetsOnLastAccount (REFACTORED to auto-restore MAIN)
  Objetivo:
    - Seleccionar la cuenta MAIN con lastCheckAt más antigua (NULL primero) que tenga al menos un backup asociado.
      Override: MAIN_ACCOUNT_ID
    - Escanear TODOS los assets pertenecientes a esa MAIN y detectar existentes vs faltantes (fase 1).
    - Descargar desde backups sólo los faltantes (fase 2).
    - Subirlos al MAIN regenerando link público y marcando status PUBLISHED (fase 3).
    - Regenerar link para los que existen pero no tienen megaLink.
    - Pensado para ejecutarse vía cron: node ./src/utils/validateAssetsOnLastAccount.js

  Vars opcionales:
    MAIN_ACCOUNT_ID  -> forzar id de main
    MAX_ASSETS       -> limitar número de assets procesados (debug)
*/

const prisma = new PrismaClient()
const UPLOADS_DIR = path.resolve('uploads')
const TEMP_DIR = path.join(UPLOADS_DIR, 'tmp')
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive:true })
const DEFAULT_FREE_QUOTA_MB = Number(process.env.MEGA_FREE_QUOTA_MB) || 20480
const UPLOADS_ACTIVE_FLAG = process.env.UPLOADS_ACTIVE_FLAG || path.join(UPLOADS_DIR, 'sync-cache', 'uploads-active.lock')



// ==========================================
// NUEVO: SISTEMA DE PROXIES Y ANTI-BAN
// ==========================================
const PROXY_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'proxies.txt');
let PROXY_LIST = [];

// Toggle básico CONTROLADO EN CÓDIGO (sin variables de entorno)
// Cambia USE_BASIC_PROXY a true para activar el uso de proxy.
// Si BASIC_PROXY_URL está vacío, se usará un proxy aleatorio de proxies.txt (si existe).
const USE_BASIC_PROXY = false
const BASIC_PROXY_URL = '' // ejemplo: 'socks5://usuario:pass@ip:puerto'

// Carga automática de proxies.txt
try {
  if (fs.existsSync(PROXY_FILE)) {
    const content = fs.readFileSync(PROXY_FILE, 'utf-8');
    PROXY_LIST = content.split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'))
      .map(line => {
        // Tu formato es IP:PORT:USER:PASS -> Convertimos a URL de MEGA
        const parts = line.split(':');
        if (parts.length === 4) {
          return `socks5://${parts[2]}:${parts[3]}@${parts[0]}:${parts[1]}`;
        }
        return line; // Si ya viene formateado lo dejamos igual
      });
    log.info(`[INIT] Proxies cargados: ${PROXY_LIST.length}`);
  } else {
    log.warn('[INIT] NO se encontró proxies.txt. Se usará IP DIRECTA (Riesgo de Ban).');
  }
} catch (e) {
  log.error(`[INIT] Error leyendo proxies: ${e.message}`);
}

async function setRandomProxy() {
  if (!PROXY_LIST || PROXY_LIST.length === 0) return;
  const proxy = PROXY_LIST[Math.floor(Math.random() * PROXY_LIST.length)];
  try {
    await runCmd('mega-proxy', [proxy], { quiet: true });
  } catch (e) {
    // Si falla poner el proxy, limpiamos para evitar errores de red
    await clearProxy();
  }
}

async function clearProxy() {
  try { await runCmd('mega-proxy', ['-d'], { quiet: true }); } catch {}
}
// ==========================================

// Helper simple: aplica proxy si está habilitado por ENV (o usa uno aleatorio de proxies.txt)
async function applyBasicProxyIfEnabled(){
  if (!USE_BASIC_PROXY) return false
  try {
    if (BASIC_PROXY_URL){
      await runCmd('mega-proxy', [BASIC_PROXY_URL], { quiet:true })
      log.info('[PROXY] Aplicado BASIC_PROXY_URL')
      return true
    }
    if (PROXY_LIST && PROXY_LIST.length){
      const proxy = PROXY_LIST[Math.floor(Math.random()*PROXY_LIST.length)]
      await runCmd('mega-proxy', [proxy], { quiet:true })
      log.info(`[PROXY] Aplicado proxy de lista: ${proxy}`)
      return true
    }
    log.warn('[PROXY] ENABLE_BASIC_PROXY activo pero no hay BASIC_PROXY_URL ni proxies.txt')
    return false
  } catch (e){
    log.warn('[PROXY] No se pudo aplicar proxy básico: '+e.message)
    try { await clearProxy() } catch {}
    return false
  }
}





function runCmd(cmd, args = [], { quiet=false } = {}) {
  const printable = `${cmd} ${(args||[]).join(' ')}`.trim()
  log.verbose(`[CRON] cmd ${printable}`)
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { shell:true })
    let out='', err=''
    child.stdout.on('data', d=> out += d.toString())
    child.stderr.on('data', d=> err += d.toString())
    child.on('close', code => {
      if (code===0) return resolve({ out, err })
      if (!quiet) log.warn(`[CRON] fallo cmd ${cmd} code=${code} msg=${(err||out).slice(0,160)}`)
      reject(new Error(err||out||`${cmd} exited ${code}`))
    })
  })
}

function pickFirstFileFromLs(lsOut){
  const lines = String(lsOut).split(/\r?\n/).map(l=>l.trim()).filter(Boolean)
  const withExt = lines.filter(l => /\.[A-Za-z0-9]{1,10}$/.test(l))
  return (withExt[0] || lines[0]) || null
}

function buildCtx(acc){ return acc?`accId=${acc.id} alias=${acc.alias||'--'} email=${acc.email||'--'}`:'' }

function sleep(ms){ return new Promise(r=>setTimeout(r, ms)) }

function parseSizeToMB(str){
  if (!str) return 0
  const s = String(str).trim().toUpperCase()
  const m = s.match(/[\d.,]+\s*[KMGT]?B/)
  if (!m) return 0
  const num = parseFloat((m[0].match(/[\d.,]+/) || ['0'])[0].replace(',', '.'))
  const unit = (m[0].match(/[KMGT]?B/) || ['MB'])[0]
  const factor = unit === 'KB' ? 1/1024 : unit === 'MB' ? 1 : unit === 'GB' ? 1024 : unit === 'TB' ? 1024*1024 : 1/(1024*1024)
  return Math.round(num * factor)
}

async function getAccountMetrics(base){
  const dfCmd = 'mega-df'
  const duCmd = 'mega-du'
  const findCmd = 'mega-find'
  let storageUsedMB=0, storageTotalMB=0, fileCount=0, folderCount=0
  let storageSource='none'
  try {
    const df = await runCmd(dfCmd, ['-h'], { quiet: true })
    const txt = (df.out || df.err || '').toString()
    let m = txt.match(/account\s+storage\s*:\s*([^/]+)\/\s*([^\n]+)/i)
      || txt.match(/storage\s*:\s*([\d.,]+\s*[KMGT]?B)\s*of\s*([\d.,]+\s*[KMGT]?B)/i)
      || txt.match(/([\d.,]+\s*[KMGT]?B)\s*\/\s*([\d.,]+\s*[KMGT]?B)/i)
      || txt.match(/almacenamiento\s+de\s+la\s+cuenta\s*:\s*([^\n]+?)\s*de\s*([^\n]+)/i)
      || txt.match(/almacenamiento\s*:\s*([\d.,]+\s*[KMGT]?B)\s*de\s*([\d.,]+\s*[KMGT]?B)/i)
    if (m){ storageUsedMB = parseSizeToMB(m[1]); storageTotalMB = parseSizeToMB(m[2]); storageSource='df -h' }
    if (!storageTotalMB){
      const p = txt.match(/storage[^\n]*?:\s*([\d.,]+)\s*%[^\n]*?(?:of|de)\s*([\d.,]+\s*[KMGT]?B)/i)
        || txt.match(/almacenamiento[^\n]*?:\s*([\d.,]+)\s*%[^\n]*?(?:de|of)\s*([\d.,]+\s*[KMGT]?B)/i)
      if (p){
        storageTotalMB = parseSizeToMB(p[2])
        const pct = parseFloat(String(p[1]).replace(',', '.'))
        if (!isNaN(pct) && isFinite(pct)) storageUsedMB = Math.round((pct/100)*storageTotalMB)
        storageSource = storageSource==='none' ? 'df -h (pct)' : storageSource
      }
    }
  } catch {}
  if (!storageTotalMB){
    try {
      const df = await runCmd(dfCmd, [], { quiet: true })
      const txt = (df.out || df.err || '').toString()
      let m = txt.match(/account\s+storage\s*:\s*([^/]+)\/\s*([^\n]+)/i)
        || txt.match(/storage\s*:\s*([\d.,]+\s*[KMGT]?B)\s*of\s*([\d.,]+\s*[KMGT]?B)/i)
        || txt.match(/([\d.,]+\s*[KMGT]?B)\s*\/\s*([\d.,]+\s*[KMGT]?B)/i)
        || txt.match(/almacenamiento\s+de\s+la\s+cuenta\s*:\s*([^\n]+?)\s*de\s*([^\n]+)/i)
        || txt.match(/almacenamiento\s*:\s*([\d.,]+\s*[KMGT]?B)\s*de\s*([\d.,]+\s*[KMGT]?B)/i)
      if (m){ storageUsedMB = parseSizeToMB(m[1]); storageTotalMB = parseSizeToMB(m[2]); storageSource = storageSource==='none' ? 'df' : storageSource }
    } catch {}
  }
  if (!storageUsedMB){
    try {
      const du = await runCmd(duCmd, ['-h', base || '/'], { quiet: true })
      const txt = (du.out || du.err || '').toString()
      const mm = txt.match(/[\r\n]*\s*([\d.,]+\s*[KMGT]?B)/i) || txt.match(/([\d.,]+\s*[KMGT]?B)/i)
      if (mm){ storageUsedMB = parseSizeToMB(mm[1]); storageSource = storageSource==='none' ? 'du -h' : storageSource }
    } catch {}
  }
  try {
    const f = await runCmd(findCmd, [base || '/', '--type=f'], { quiet: true })
    fileCount = (f.out || '').split(/\r?\n/).filter(Boolean).length
  } catch {
    try { const f = await runCmd(findCmd, ['--type=f', base || '/'], { quiet: true }); fileCount = (f.out || '').split(/\r?\n/).filter(Boolean).length } catch {}
  }
  try {
    const d = await runCmd(findCmd, [base || '/', '--type=d'], { quiet: true })
    folderCount = (d.out || '').split(/\r?\n/).filter(Boolean).length
  } catch {
    try { const d = await runCmd(findCmd, ['--type=d', base || '/'], { quiet: true }); folderCount = (d.out || '').split(/\r?\n/).filter(Boolean).length } catch {}
  }
  if (!storageTotalMB || storageTotalMB<=0) storageTotalMB = DEFAULT_FREE_QUOTA_MB
  if (storageUsedMB > storageTotalMB) storageTotalMB = storageUsedMB
  return { storageUsedMB, storageTotalMB, fileCount, folderCount, storageSource }
}

async function megaLogin(payload, ctx){
  for (let attempt=1; attempt<=3; attempt++){
    try {
      if (payload?.type==='session' && payload.session) await runCmd('mega-login',[payload.session],{ quiet:true })
      else if (payload?.username && payload?.password) await runCmd('mega-login',[payload.username,payload.password],{ quiet:true })
      else throw new Error('Credenciales inválidas')
      log.info(`[MEGA][LOGIN][OK] ${ctx} intento=${attempt}`)
      return
    } catch (e){
      log.warn(`[MEGA][LOGIN][FAIL] intento=${attempt} ${ctx} msg=${e.message}`)
      await new Promise(r=>setTimeout(r, 500*attempt))
    }
  }
}
async function megaLogout(ctx){ try { await runCmd('mega-logout',[],{ quiet:true }); log.info(`[MEGA][LOGOUT][OK] ${ctx}`) } catch(e){ log.warn(`[MEGA][LOGOUT][WARN] ${ctx} ${e.message}`) } }

export async function runAutoRestoreMain(){
  const tStart = Date.now()
  const RUN_LOCK = path.join(TEMP_DIR, 'auto-restore-main.running')
  const forced = process.env.MAIN_ACCOUNT_ID?Number(process.env.MAIN_ACCOUNT_ID):null
  const maxAssets = process.env.MAX_ASSETS!==undefined ? Number(process.env.MAX_ASSETS) : null
  let main
  try {
    // Evitar solapamiento de ejecuciones
    if (fs.existsSync(RUN_LOCK)){
      const ageMin = (Date.now() - fs.statSync(RUN_LOCK).mtimeMs) / 60000
      // Si hay un lock de ejecución reciente (< 240 min), omitir
      if (ageMin < 240){
        log.info('[CRON][SKIP] Ya hay una ejecución en curso (lock activo). Se omite esta corrida.')
        return { ok:true, skipped:true, reason:'RUNNING' }
      }
    }
    // Crear lock
    try { fs.writeFileSync(RUN_LOCK, String(new Date().toISOString())) } catch{}
    // Si hay subidas activas, no ejecutar para no interferir con MEGAcmd
    try {
      const st = fs.existsSync(UPLOADS_ACTIVE_FLAG) ? fs.statSync(UPLOADS_ACTIVE_FLAG) : null
      if (st){
        const ageMin = (Date.now() - st.mtimeMs) / 60000
        // Considera "activo" si el lock es reciente (< 60 min) o si variable fuerza ignorar tiempo
        const maxIdleMin = process.env.UPLOADS_ACTIVE_MAX_IDLE_MIN ? Number(process.env.UPLOADS_ACTIVE_MAX_IDLE_MIN) : 60
        if (ageMin < maxIdleMin){
          log.info(`[CRON][SKIP] Subidas activas detectadas (lock: ${UPLOADS_ACTIVE_FLAG}, edad ${ageMin.toFixed(1)} min). Se omite esta corrida.`)
          return { ok:true, skipped:true, reason:'UPLOADS_ACTIVE' }
        }
      }
    } catch(e){ log.warn('[CRON][WARN] No se pudo evaluar bandera de subidas activas: '+e.message) }
    if (forced){
      main = await prisma.megaAccount.findUnique({ where:{ id:forced }, include:{ credentials:true, backups:{ include:{ backupAccount:{ include:{ credentials:true } } } } } })
      if (!main) throw new Error(`Main forzada id=${forced} no encontrada`)
      if (main.type!=='main') throw new Error('Cuenta forzada no es MAIN')
    } else {
      const mains = await prisma.megaAccount.findMany({
        where:{ type:'main', suspended:false, backups:{ some:{} }, assets:{ some:{} } },
        include:{ credentials:true, backups:{ include:{ backupAccount:{ include:{ credentials:true } } } } }
      })
      // ordenar por lastCheckAt null primero -> más antiguo
      mains.sort((a,b)=>{
        const an=a.lastCheckAt==null, bn=b.lastCheckAt==null
        if (an && !bn) return -1; if (!an && bn) return 1
        const at=a.lastCheckAt? a.lastCheckAt.getTime():0
        const bt=b.lastCheckAt? b.lastCheckAt.getTime():0
        return at-bt
      })
      main = mains[0]
    }
    if (!main) { log.info('[CRON] No hay main candidate'); return { ok:true, skipped:true, reason:'NO_MAIN' } }
    if (!main.credentials) throw new Error('Main sin credenciales')
    const backupAccounts = (main.backups||[]).map(r=>r.backupAccount).filter(Boolean)
    if (!backupAccounts.length){ log.info('[CRON] Main sin backups asociados'); return { ok:true, skipped:true, reason:'NO_BACKUPS' } }

    // Si MAX_ASSETS=0 no hay nada que procesar
    if (maxAssets === 0){
      log.info('[CRON] MAX_ASSETS=0: no se procesarán assets en esta corrida')
      return { ok:true, skipped:true, reason:'MAX_ASSETS_ZERO' }
    }

    // Tomar TODOS los assets pertenecientes a la MAIN
    let candidateAssets = await prisma.asset.findMany({
      where: { accountId: main.id },
      select: { id: true, slug: true, archiveName: true, megaLink: true }
    })
    // Fallback: si la MAIN no tiene assets, intentar derivarlos de las réplicas en BACKUPs
    if (!candidateAssets.length){
      const backupIds = (backupAccounts||[]).map(b=>b.id)
      if (backupIds.length){
        const replicas = await prisma.assetReplica.findMany({
          where: { accountId: { in: backupIds }, status: 'COMPLETED' },
          select: { asset: { select: { id: true, slug: true, archiveName: true, megaLink: true } } }
        })
        const uniq = new Map()
        for (const r of replicas){ if (r.asset && !uniq.has(r.asset.id)) uniq.set(r.asset.id, r.asset) }
        candidateAssets = Array.from(uniq.values())
        if (candidateAssets.length){
          log.info(`[CRON][FALLBACK] MAIN sin assets propios. Usando ${candidateAssets.length} assets desde réplicas en BACKUPs`)
        }
      }
    }
    const assetMap = new Map(candidateAssets.map(a => [a.id, a]))
    if (maxAssets) candidateAssets = candidateAssets.slice(0, maxAssets)
    if (!candidateAssets.length){
      log.info('[CRON] MAIN seleccionada sin assets para procesar. Se actualizarán métricas y backups, no hay nada que restaurar.')
      // Actualizar métricas de MAIN aunque no haya assets
      await withMegaLock(async () => {
        try {
          await applyBasicProxyIfEnabled()
          const payload = decryptToJson(main.credentials.encData, main.credentials.encIv, main.credentials.encTag)
          await megaLogout(buildCtx(main)); await megaLogin(payload, buildCtx(main))
          const base = (main.baseFolder||'/').replaceAll('\\','/')
          const m = await getAccountMetrics(base)
          await prisma.megaAccount.update({ where:{ id: main.id }, data:{
            status: 'CONNECTED', statusMessage: null, lastCheckAt: new Date(),
            storageUsedMB: m.storageUsedMB, storageTotalMB: m.storageTotalMB, fileCount: m.fileCount, folderCount: m.folderCount,
          }})
          log.info(`[CRON][MÉTRICAS][MAIN] alias=${main.alias||'--'} usados=${m.storageUsedMB}MB de ${m.storageTotalMB}MB | archivos=${m.fileCount} carpetas=${m.folderCount} (fuente=${m.storageSource})`)
        } catch(e){ log.warn('[CRON][MÉTRICAS][MAIN][WARN] '+e.message) }
        finally { try { await megaLogout(buildCtx(main)) } catch{} try { await clearProxy() } catch{} }
      }, 'CRON-NO-ASSETS-MAIN')

      // Warmup de BACKUPs al final
      log.info('[CRON][WARMUP] Esperando 10s antes de autenticar BACKUPs (sin assets en MAIN)...')
      await sleep(10000)
      for (const b of backupAccounts){
        if (!b?.credentials) continue
        const payloadB = decryptToJson(b.credentials.encData, b.credentials.encIv, b.credentials.encTag)
        await withMegaLock(async () => {
          try {
            await applyBasicProxyIfEnabled()
            await megaLogout(buildCtx(b)); await megaLogin(payloadB, buildCtx(b))
            const baseB = (b.baseFolder||'/').replaceAll('\\','/')
            try {
              const m = await getAccountMetrics(baseB)
              await prisma.megaAccount.update({ where:{ id: b.id }, data:{
                status: 'CONNECTED', statusMessage: null, lastCheckAt: new Date(),
                storageUsedMB: m.storageUsedMB, storageTotalMB: m.storageTotalMB, fileCount: m.fileCount, folderCount: m.folderCount,
              }})
              log.info(`[CRON][MÉTRICAS][BACKUP] alias=${b.alias||'--'} usados=${m.storageUsedMB}MB de ${m.storageTotalMB}MB | archivos=${m.fileCount} carpetas=${m.folderCount} (fuente=${m.storageSource})`)
            } catch(me){
              await prisma.megaAccount.update({ where:{ id: b.id }, data:{ lastCheckAt: new Date(), status: 'CONNECTED', statusMessage: null } })
              log.warn(`[CRON][MÉTRICAS][BACKUP][WARN] No se pudieron obtener métricas de alias=${b.alias||'--'}: ${me.message}`)
            }
          } catch(e){ log.warn(`[CRON][WARMUP][WARN] No se pudo autenticar backup id=${b.id}: ${e.message}`) }
          finally { try { await megaLogout(buildCtx(b)) } catch{} try { await clearProxy() } catch{} }
        }, `CRON-WARMUP-NO-ASSETS-${b.id}`)
      }

      return { ok:true, skipped:true, reason:'NO_ASSETS' }
    }

  log.info('__________________________________________________')
  log.info('____ INICIANDO RECUPERACIÓN AUTOMÁTICA (CRON) ____')
  log.info('__________________________________________________')
  log.info(`[CRON][RESUMEN] Cuenta MAIN id=${main.id} alias=${main.alias||'--'} email=${main.email||'--'} assets=${candidateAssets.length} backups=${backupAccounts.length}`)
  log.info('[CRON][DETALLE] Lista de assets a verificar: '+candidateAssets.map(a=>a.id).join(', '))

  const existingSet = new Set()
  const needDownload = new Map() // assetId -> asset
  const recovered = new Map()    // assetId -> { fileName, localTemp, size }
    let regeneratedLinks=0, restored=0

    // FASE 1: Escaneo en MAIN (existentes vs faltantes) y re-export de links faltantes
    await withMegaLock(async () => {
      await applyBasicProxyIfEnabled()
      const payload = decryptToJson(main.credentials.encData, main.credentials.encIv, main.credentials.encTag)
      await megaLogout(buildCtx(main))
      await megaLogin(payload, buildCtx(main))
      const remoteBaseMain = (main.baseFolder||'/').replaceAll('\\','/')
      for (let i=0;i<candidateAssets.length;i++){
        const asset = candidateAssets[i]
        const remoteFolder = path.posix.join(remoteBaseMain, asset.slug)
        const expectedFile = asset.archiveName ? path.basename(asset.archiveName) : null
        let lsOut=''
        try { const ls = await runCmd('mega-ls',[remoteFolder],{ quiet:true }); lsOut=ls.out } catch {}
        const lines = String(lsOut).split(/\r?\n/).map(l=>l.trim()).filter(Boolean)
        let fileName=null
        if (expectedFile && lines.includes(expectedFile)) fileName=expectedFile
        if (!fileName) fileName = pickFirstFileFromLs(lsOut)
        const exists=!!fileName
        if (exists){
          existingSet.add(asset.id)
          if (!asset.megaLink && fileName){
            try {
              const remoteFile = path.posix.join(remoteFolder, fileName)
              try { await runCmd('mega-export',['-d', remoteFile],{ quiet:true }) } catch{}
              const exp= await runCmd('mega-export',['-a', remoteFile],{ quiet:true })
              const m = exp.out.match(/https?:\/\/mega\.nz\/\S+/i)
              if (m){ await prisma.asset.update({ where:{ id: asset.id }, data:{ megaLink:m[0], status:'PUBLISHED' } }); regeneratedLinks++; }
            } catch (e){ log.warn(`[CRON][ESCANEO] No se pudo regenerar link para asset=${asset.id} -> ${e.message}`) }
          }
        } else {
          needDownload.set(asset.id, asset)
        }
      }
      // Medimos y actualizamos métricas de la MAIN (como el botón "Actualizar")
      try {
        const m = await getAccountMetrics(remoteBaseMain)
        await prisma.megaAccount.update({
          where:{ id: main.id },
          data:{
            status: 'CONNECTED',
            statusMessage: null,
            lastCheckAt: new Date(),
            storageUsedMB: m.storageUsedMB,
            storageTotalMB: m.storageTotalMB,
            fileCount: m.fileCount,
            folderCount: m.folderCount,
          }
        })
        log.info(`[CRON][MÉTRICAS][MAIN] alias=${main.alias||'--'} usados=${m.storageUsedMB}MB de ${m.storageTotalMB}MB | archivos=${m.fileCount} carpetas=${m.folderCount} (fuente=${m.storageSource})`)
      } catch(e){ log.warn(`[CRON][MÉTRICAS][MAIN][WARN] No se pudo actualizar métricas: ${e.message}`) }
      await megaLogout(buildCtx(main))
      try { await clearProxy() } catch{}
    }, 'CRON-PHASE1')
    log.info(`[CRON][RESUMEN][FASE1] existentes=${existingSet.size} faltantes=${needDownload.size} linksRegenerados=${regeneratedLinks}`)

    // FASE 2: Descargar faltantes desde BACKUPs
    if (needDownload.size){
      for (const b of backupAccounts){
        if (!needDownload.size) break
        const payloadB = decryptToJson(b.credentials.encData, b.credentials.encIv, b.credentials.encTag)
        await withMegaLock( async () => {
          await applyBasicProxyIfEnabled()
          await megaLogout(buildCtx(b)); await megaLogin(payloadB, buildCtx(b))
          for (const [assetId, asset] of Array.from(needDownload.entries())){
            const remoteBaseB = (b.baseFolder||'/').replaceAll('\\','/')
            const remoteFolderB = path.posix.join(remoteBaseB, asset.slug)
            let lsOut=''; try { const ls = await runCmd('mega-ls',[remoteFolderB],{ quiet:true }); lsOut=ls.out } catch { continue }
            const fileName = pickFirstFileFromLs(lsOut); if (!fileName) continue
            const remoteFile = path.posix.join(remoteFolderB, fileName)
            const localTemp = path.join(TEMP_DIR, `restore-${asset.id}-${Date.now()}-${fileName}`)
            try {
              await runCmd('mega-get',[remoteFile, localTemp],{ quiet:true })
              if (fs.existsSync(localTemp)){
                const size = fs.statSync(localTemp).size
                recovered.set(asset.id,{ fileName, localTemp, size }); needDownload.delete(asset.id)
                log.info(`[CRON][DESCARGA] asset=${asset.id} desde backup=${b.id} bytes=${size}`)
              }
            } catch (e){ log.warn(`[CRON][DESCARGA] fallo asset=${asset.id} desde backup=${b.id} -> ${e.message}`) }
          }
          await megaLogout(buildCtx(b))
          try { await clearProxy() } catch{}
        }, `CRON-DL-${b.id}`)
      }
    }

    // FASE 3: Subir a MAIN y exportar link
    await withMegaLock(async () => {
      await applyBasicProxyIfEnabled()
      if (recovered.size){
        const payload = decryptToJson(main.credentials.encData, main.credentials.encIv, main.credentials.encTag)
        await megaLogout(buildCtx(main)); await megaLogin(payload, buildCtx(main))
        for (const [assetId, info] of recovered.entries()){
          const asset = assetMap.get(assetId)
          const remoteBase = (main.baseFolder||'/').replaceAll('\\','/')
          const remoteFolder = path.posix.join(remoteBase, asset.slug)
            try { await runCmd('mega-mkdir',['-p', remoteFolder],{ quiet:true }) } catch{}
          const remoteFile = path.posix.join(remoteFolder, info.fileName)
          try {
            await runCmd('mega-put',[info.localTemp, remoteFile],{ quiet:true })
            try { await runCmd('mega-export',['-d', remoteFile],{ quiet:true }) } catch{}
            const exp = await runCmd('mega-export',['-a', remoteFile],{ quiet:true })
            const m = exp.out.match(/https?:\/\/mega\.nz\/\S+/i)
            if (!m) throw new Error('No link')
            await prisma.asset.update({ where:{ id: asset.id }, data:{ megaLink:m[0], status:'PUBLISHED' } })
            restored++
            log.info(`[CRON][SUBIDA] asset=${asset.id} restaurado y publicado`)
          } catch (e){ log.error(`[CRON][SUBIDA] fallo asset=${asset.id} -> ${e.message}`) }
          finally { try { if (fs.existsSync(info.localTemp)) fs.unlinkSync(info.localTemp) } catch{} }
        }
        await megaLogout(buildCtx(main))
      }
      try { await clearProxy() } catch{}
    }, 'CRON-PHASE3')

    const skippedExisting = existingSet.size
    const notRecovered = Array.from(needDownload.keys()).length
    const durMs = Date.now() - tStart
    const completos = (restored===0 && skippedExisting===candidateAssets.length)
    if (completos){
      log.info(`[CRON][FINAL] Assets COMPLETOS para MAIN alias=${main.alias||'--'} (id=${main.id}). total=${candidateAssets.length} (existentes=${skippedExisting}, restaurados=0, linksRegenerados=${regeneratedLinks}). duraciónMs=${durMs}`)
    } else {
      log.info(`[CRON][FINAL] MAIN alias=${main.alias||'--'} (id=${main.id}). total=${candidateAssets.length} restaurados=${restored} existentes=${skippedExisting} linksRegenerados=${regeneratedLinks} noRecuperados=${notRecovered} duraciónMs=${durMs}`)
    }
    await prisma.megaAccount.update({ where:{ id: main.id }, data:{ lastCheckAt: new Date() } }).catch(()=>{})

    // Solo ahora, cuando todo el proceso de MAIN ha finalizado, actualizamos BACKUPs
    log.info('[CRON][WARMUP] Esperando 10s antes de autenticar BACKUPs (post-proceso MAIN)...')
    await sleep(10000)
    for (const b of backupAccounts){
      if (!b?.credentials) continue
      const payloadB = decryptToJson(b.credentials.encData, b.credentials.encIv, b.credentials.encTag)
      await withMegaLock(async () => {
        try {
          await applyBasicProxyIfEnabled()
          await megaLogout(buildCtx(b));
          await megaLogin(payloadB, buildCtx(b))
          const remoteBaseB = (b.baseFolder||'/').replaceAll('\\','/')
          try {
            const m = await getAccountMetrics(remoteBaseB)
            await prisma.megaAccount.update({
              where:{ id: b.id },
              data:{
                status: 'CONNECTED',
                statusMessage: null,
                lastCheckAt: new Date(),
                storageUsedMB: m.storageUsedMB,
                storageTotalMB: m.storageTotalMB,
                fileCount: m.fileCount,
                folderCount: m.folderCount,
              }
            })
            log.info(`[CRON][MÉTRICAS][BACKUP] alias=${b.alias||'--'} usados=${m.storageUsedMB}MB de ${m.storageTotalMB}MB | archivos=${m.fileCount} carpetas=${m.folderCount} (fuente=${m.storageSource})`)
          } catch(me){
            await prisma.megaAccount.update({ where:{ id: b.id }, data:{ lastCheckAt: new Date(), status: 'CONNECTED', statusMessage: null } })
            log.warn(`[CRON][MÉTRICAS][BACKUP][WARN] No se pudieron obtener métricas de alias=${b.alias||'--'}: ${me.message}`)
          }
        } catch(e){
          log.warn(`[CRON][WARMUP][WARN] No se pudo autenticar backup id=${b.id}: ${e.message}`)
        } finally {
          try { await megaLogout(buildCtx(b)) } catch{}
          try { await clearProxy() } catch{}
        }
      }, `CRON-WARMUP-${b.id}`)
    }
    // Notificación solo si hubo restauraciones reales para evitar spam cuando todo está completo
    if (restored > 0) {
      try {
        const notifTitle = 'Restauración automática de assets desde backups completada'
        const notifBody = `Cuenta MAIN ${main.alias||'--'} (${main.email||'--'}). Total: ${candidateAssets.length}. Restaurados: ${restored}. Existentes: ${skippedExisting}. Links regenerados: ${regeneratedLinks}. No recuperados: ${notRecovered}. Duración: ${durMs} ms.`
        await prisma.notification.create({ data: { title: notifTitle, body: notifBody, status: 'UNREAD', type: 'AUTOMATION', typeStatus: 'SUCCESS' } })
      } catch(e){ log.warn('[NOTIF][CRON] No se pudo crear notificación (restored>0): '+e.message) }
    } else if (notRecovered > 0) {
      // Caso de fallo: había faltantes pero ninguno pudo restaurarse
      try {
        const pendingIds = Array.from(needDownload.keys())
        const notifTitle = 'Fallo en restauración automática de assets'
        const notifBody = `Cuenta MAIN ${main.alias||'--'} (${main.email||'--'}). Faltantes=${pendingIds.length}. Ninguno restaurado. IDs pendientes: ${pendingIds.slice(0,50).join(', ')}${pendingIds.length>50?' ...':''}. Links regenerados: ${regeneratedLinks}. Duración: ${durMs} ms.`
        await prisma.notification.create({ data: { title: notifTitle, body: notifBody, status: 'UNREAD', type: 'AUTOMATION', typeStatus: 'ERROR' } })
        log.warn('[CRON][NOTIF] Generada notificación de fallo en restauración (restored=0 & notRecovered>0)')
      } catch(e){ log.warn('[NOTIF][CRON][FAIL] No se pudo crear notificación de fallo: '+e.message) }
    } else {
      // restored=0 y notRecovered=0 => todos existían, sin spam
      log.info('[CRON][NOTIF][SKIP] restored=0 pero noRecovered=0 (todos existen, sin restauraciones)')
    }
    return { ok:true, restored, existing: skippedExisting, regeneratedLinks, notRecovered, total: candidateAssets.length }
  } catch (e){
    log.error(`[CRON][RESTORE] fallo general: ${e.message}`)
    // Notificación de error
    try {
      await prisma.notification.create({
        data: {
          title: 'Error en restauración automática de backups',
          body: `Ocurrió un error al restaurar backups hacia assets (MAIN id=${main?.id||'?'} alias=${main?.alias||'--'}): ${e.message}`,
          status: 'UNREAD',
          type: 'AUTOMATION',
          typeStatus: 'ERROR'
        }
      })
    } catch(err){ log.warn('[NOTIF][CRON][ERROR] No se pudo crear notificación de error: '+err.message) }
    return { ok:false, error:e.message }
  } finally {
    // Liberar lock
    try { if (fs.existsSync(RUN_LOCK)) fs.unlinkSync(RUN_LOCK) } catch{}
    try { await runCmd('mega-logout',[],{ quiet:true }) } catch{}
    try { await prisma.$disconnect() } catch{}
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Modo de prueba básico del proxy: node autoBackupAssetsToMain.js --proxy-smoke
  if (process.argv.includes('--proxy-smoke')){
    (async ()=>{
      try {
        const main = await prisma.megaAccount.findFirst({ where:{ type:'main', suspended:false }, include:{ credentials:true } })
        if (!main || !main.credentials){ log.warn('[SMOKE] No hay MAIN con credenciales'); return }
        await clearProxy()
        const applied = await applyBasicProxyIfEnabled()
        const payload = decryptToJson(main.credentials.encData, main.credentials.encIv, main.credentials.encTag)
        await megaLogout('[SMOKE]')
        await megaLogin(payload, buildCtx(main))
        const res = await runCmd('mega-ls', ['/'], { quiet:true })
        log.info(`[SMOKE] mega-ls / ok, length=${(res.out||'').length} proxy=${applied?'on':'off'}`)
        await megaLogout(buildCtx(main))
      } catch (e){ log.warn('[SMOKE] fallo: '+e.message) }
      finally { try { await clearProxy() } catch{} try { await prisma.$disconnect() } catch{} }
    })()
  } else {
    runAutoRestoreMain().then(r=>{ if(!r.ok) process.exitCode=1 })
  }
}
