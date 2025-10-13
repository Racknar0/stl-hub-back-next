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
  const forced = process.env.MAIN_ACCOUNT_ID?Number(process.env.MAIN_ACCOUNT_ID):null
  const maxAssets = process.env.MAX_ASSETS!==undefined ? Number(process.env.MAX_ASSETS) : null
  let main
  try {
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
        finally { try { await megaLogout(buildCtx(main)) } catch{} }
      }, 'CRON-NO-ASSETS-MAIN')

      // Warmup de BACKUPs al final
      log.info('[CRON][WARMUP] Esperando 10s antes de autenticar BACKUPs (sin assets en MAIN)...')
      await sleep(10000)
      for (const b of backupAccounts){
        if (!b?.credentials) continue
        const payloadB = decryptToJson(b.credentials.encData, b.credentials.encIv, b.credentials.encTag)
        await withMegaLock(async () => {
          try {
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
          finally { try { await megaLogout(buildCtx(b)) } catch{} }
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
    }, 'CRON-PHASE1')
    log.info(`[CRON][RESUMEN][FASE1] existentes=${existingSet.size} faltantes=${needDownload.size} linksRegenerados=${regeneratedLinks}`)

    // FASE 2: Descargar faltantes desde BACKUPs
    if (needDownload.size){
      for (const b of backupAccounts){
        if (!needDownload.size) break
        const payloadB = decryptToJson(b.credentials.encData, b.credentials.encIv, b.credentials.encTag)
        await withMegaLock( async () => {
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
        }, `CRON-DL-${b.id}`)
      }
    }

    // FASE 3: Subir a MAIN y exportar link
    await withMegaLock(async () => {
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
        }
      }, `CRON-WARMUP-${b.id}`)
    }
    // Notificación: backup → assets (script)
    try {
      const notifTitle = completos ? 'Validación de assets en MAIN: todo completo' : 'Restauración automática de assets desde backups completada'
      const notifBody = completos
        ? `Cuenta MAIN ${main.alias||'--'} (${main.email||'--'}). Total: ${candidateAssets.length}. Todos existentes. Links regenerados: ${regeneratedLinks}. Duración: ${durMs} ms.`
        : `Cuenta MAIN ${main.alias||'--'} (${main.email||'--'}). Total: ${candidateAssets.length}. Restaurados: ${restored}. Existentes: ${skippedExisting}. Links regenerados: ${regeneratedLinks}. No recuperados: ${notRecovered}. Duración: ${durMs} ms.`
      await prisma.notification.create({ data: { title: notifTitle, body: notifBody, status: 'UNREAD', type: 'AUTOMATION', typeStatus: 'SUCCESS' } })
    } catch(e){ log.warn('[NOTIF][CRON] No se pudo crear notificación: '+e.message) }
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
    try { await runCmd('mega-logout',[],{ quiet:true }) } catch{}
    try { await prisma.$disconnect() } catch{}
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runAutoRestoreMain().then(r=>{ if(!r.ok) process.exitCode=1 })
}
