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
    - Seleccionar la cuenta MAIN con lastCheckAt más antigua (NULL primero) que tenga al menos un backup asociado y assets en los backups.
      Override: MAIN_ACCOUNT_ID
    - Escanear el MAIN y detectar assets existentes vs faltantes (fase 1 de syncBackupsToMain).
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
             body: `Ocurrió un error al restaurar backups hacia assets (main=${main?.id||'?'}, email=${main?.email || '--'}) (script): ${e.message}`,
      await new Promise(r=>setTimeout(r, 500*attempt))
    }
  }
}
async function megaLogout(ctx){ try { await runCmd('mega-logout',[],{ quiet:true }); log.info(`[MEGA][LOGOUT][OK] ${ctx}`) } catch(e){ log.warn(`[MEGA][LOGOUT][WARN] ${ctx} ${e.message}`) } }

export async function runAutoRestoreMain(){
  const forced = process.env.MAIN_ACCOUNT_ID?Number(process.env.MAIN_ACCOUNT_ID):null
  const maxAssets = process.env.MAX_ASSETS?Number(process.env.MAX_ASSETS):null
  let main
  try {
    if (forced){
      main = await prisma.megaAccount.findUnique({ where:{ id:forced }, include:{ credentials:true, backups:{ include:{ backupAccount:{ include:{ credentials:true } } } } } })
      if (!main) throw new Error(`Main forzada id=${forced} no encontrada`)
      if (main.type!=='main') throw new Error('Cuenta forzada no es MAIN')
    } else {
      const mains = await prisma.megaAccount.findMany({
        where:{ type:'main', suspended:false, backups:{ some:{} } },
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

    const backupIds = backupAccounts.map(b=>b.id)
    const replicas = await prisma.assetReplica.findMany({ where:{ accountId:{ in: backupIds } }, include:{ asset:true } })
    const assetMap = new Map()
    for (const r of replicas){ if (r.asset) assetMap.set(r.asset.id, r.asset) }
    let candidateAssets = Array.from(assetMap.values())
    if (maxAssets) candidateAssets = candidateAssets.slice(0, maxAssets)
    if (!candidateAssets.length){ log.info('[CRON] No hay replicas en backups'); return { ok:true, skipped:true, reason:'NO_REPLICAS' } }

    log.info('__________________________________________________')
    log.info('___________ INICIANDO RECUPERACION (CRON) ___________')
    log.info('__________________________________________________')
    log.info(`[CRON][RESTORE] main=${main.id} assetsBackups=${candidateAssets.length} backups=${backupAccounts.length}`)
    log.info('[CRON][RESTORE] Lista assets: '+candidateAssets.map(a=>a.id).join(', '))

    const existingSet = new Set()
    const needDownload = new Map()
    const recovered = new Map()
    let regeneratedLinks=0, restored=0

    // FASE 1
    await withMegaLock(async () => {
      const payload = decryptToJson(main.credentials.encData, main.credentials.encIv, main.credentials.encTag)
      await megaLogout(buildCtx(main))
      await megaLogin(payload, buildCtx(main))
      for (let i=0;i<candidateAssets.length;i++){
        const asset = candidateAssets[i]
        const remoteBase = (main.baseFolder||'/').replaceAll('\\','/')
        const remoteFolder = path.posix.join(remoteBase, asset.slug)
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
            } catch (e){ log.warn(`[CRON][SCAN] fallo link asset=${asset.id} ${e.message}`) }
          }
        } else {
          needDownload.set(asset.id, asset)
        }
      }
      await megaLogout(buildCtx(main))
    }, 'CRON-PHASE1')

    // FASE 2
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
                log.info(`[CRON][DL] asset=${asset.id} backup=${b.id} size=${size}`)
              }
            } catch (e){ log.warn(`[CRON][DL] fallo asset=${asset.id} backup=${b.id} ${e.message}`) }
          }
          await megaLogout(buildCtx(b))
        }, `CRON-DL-${b.id}`)
      }
    }

    // FASE 3
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
            log.info(`[CRON][UP] asset=${asset.id} ok`)
          } catch (e){ log.error(`[CRON][UP] fallo asset=${asset.id} ${e.message}`) }
          finally { try { if (fs.existsSync(info.localTemp)) fs.unlinkSync(info.localTemp) } catch{} }
        }
        await megaLogout(buildCtx(main))
      }
    }, 'CRON-PHASE3')

    const skippedExisting = existingSet.size
    const notRecovered = Array.from(needDownload.keys()).length
    log.info(`[CRON][RESTORE] Finalizado main=${main.id} total=${candidateAssets.length} restaurados=${restored} existentes=${skippedExisting} linksRegenerados=${regeneratedLinks} noRecuperados=${notRecovered}`)
    await prisma.megaAccount.update({ where:{ id: main.id }, data:{ lastCheckAt: new Date() } }).catch(()=>{})
    // Notificación: backup → assets (script)
    try {
      await prisma.notification.create({
        data: {
          title: `Restauración automática de backups a assets completada`,
          body: `Se restauraron ${restored} assets desde backups hacia la cuenta principal (main=${main.id}, email=${main.email}). Existentes: ${skippedExisting}, links regenerados: ${regeneratedLinks}, no recuperados: ${notRecovered}.`,
          status: 'UNREAD',
          type: 'AUTOMATION',
          typeStatus: 'SUCCESS'
        }
      })
    } catch(e){ log.warn('[NOTIF][CRON] No se pudo crear notificación: '+e.message) }
    return { ok:true, restored, existing: skippedExisting, regeneratedLinks, notRecovered, total: candidateAssets.length }
  } catch (e){
    log.error(`[CRON][RESTORE] fallo general: ${e.message}`)
    // Notificación de error
    try {
      await prisma.notification.create({
        data: {
          title: 'Error en restauración automática de backups',
          body: `Ocurrió un error al restaurar backups hacia assets (main=${main?.id||'?'}) (script): ${e.message}`,
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
