import { PrismaClient } from '@prisma/client'
import { decryptToJson } from '../utils/cryptoUtils.js'
import { withMegaLock } from '../utils/megaQueue.js'
import { log, isVerbose } from '../utils/logger.js'
import path from 'path'
import fs from 'fs'
import { spawn } from 'child_process'

const prisma = new PrismaClient()
const UPLOADS_DIR = path.resolve('uploads')
const TEMP_DIR = path.join(UPLOADS_DIR, 'tmp')

function ensureDir(p){ if(!fs.existsSync(p)) fs.mkdirSync(p,{recursive:true}) }
ensureDir(TEMP_DIR)

// Reutilizamos un runCmd liviano (no exportado en otros controladores)
function runCmd(cmd, args = [], { quiet=false } = {}) {
  const printable = `${cmd} ${(args||[]).join(' ')}`.trim()
  const verbose = typeof isVerbose === 'function' && isVerbose()
  if (verbose && !quiet) log.verbose(`[RESTORE] cmd ${printable}`)
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { shell: true })
    let out = '', err = ''
    child.stdout.on('data', d => out += d.toString())
    child.stderr.on('data', d => err += d.toString())
    child.on('close', code => {
      if (code === 0) return resolve({ out, err })
      if (!quiet) log.warn(`[RESTORE] fallo cmd ${cmd} code=${code} msg=${(err||out).slice(0,200)}`)
      reject(new Error(err||out||`${cmd} exited ${code}`))
    })
  })
}

function buildCtx(acc){
  if(!acc) return ''
  return `accId=${acc.id||'?'} alias=${acc.alias||'--'} email=${acc.email||'--'}`
}

async function megaLogin(payload, accCtx) {
  try {
    const ctx = accCtx ? ` ${accCtx}` : ''
    if (payload?.type === 'session' && payload.session) {
      log.info(`[MEGA][LOGIN] usando session${ctx}`)
      await runCmd('mega-login', [payload.session], { quiet: true })
    } else if (payload?.username && payload?.password) {
      log.info(`[MEGA][LOGIN] usando usuario/password${ctx}`)
      await runCmd('mega-login', [payload.username, payload.password], { quiet: true })
    } else throw new Error('Credenciales inválidas')
    log.info(`[MEGA][LOGIN][OK]${ctx}`)
  } catch (e){
    log.error('[MEGA][LOGIN][FAIL] '+e.message + (accCtx?` ${accCtx}`:''))
    throw e
  }
}

async function megaLogout(accCtx) {
  const ctx = accCtx?` ${accCtx}`:''
  try { await runCmd('mega-logout', [], { quiet: true }); log.info(`[MEGA][LOGOUT][OK]${ctx}`) } catch (e){ log.warn('[MEGA][LOGOUT][WARN] '+e.message + ctx) }
}

function pickFirstFileFromLs(lsOut){
  // mega-ls salida típica: nombres en líneas; ignorar directorios sin punto si no hay extensión.
  const lines = String(lsOut).split(/\r?\n/).map(l=>l.trim()).filter(Boolean)
  // Preferir archivos con extensión
  const withExt = lines.filter(l => /\.[A-Za-z0-9]{1,10}$/.test(l))
  return (withExt[0] || lines[0]) || null
}


export const syncBackupsToMain = async (req, res) => {
  const id = Number(req.params.id)
  try {
    const main = await prisma.megaAccount.findUnique({ where:{ id }, include:{ credentials:true, backups:{ include:{ backupAccount:{ include:{ credentials:true } } } } } })
    if (!main) return res.status(404).json({ message:'Cuenta no encontrada' })
    if (main.type !== 'main') return res.status(400).json({ message:'Solo cuentas main' })
    const backupAccounts = (main.backups||[]).map(r=>r.backupAccount).filter(b=>b)
    if (!backupAccounts.length) return res.status(400).json({ message:'La cuenta no tiene backups asociados' })
    const backupIds = backupAccounts.map(b=>b.id)
    // Traer replicas en backups con su asset
    const replicas = await prisma.assetReplica.findMany({ where:{ accountId:{ in: backupIds } }, include:{ asset:true } })
    const assetMap = new Map()
    for (const r of replicas){
      if (r.asset) assetMap.set(r.asset.id, r.asset)
    }
    const candidateAssets = Array.from(assetMap.values())
    if (!candidateAssets.length) {
      log.info(`[RESTORE] No se hallaron replicas en backups para main=${id}`)
      return res.json({ restored:0, skippedExisting:0, notFoundInBackups:0, total:0, message:'No hay replicas en backups' })
    }

    // Banner inicial solicitado
    log.info('__________________________________________________')
    log.info('___________ INICIANDO RECUPERACION ___________')
    log.info('__________________________________________________')

    log.info(`[RESTORE] Analizando main=${id} assetsEnBackups=${candidateAssets.length} backups=${backupAccounts.length}`)
    log.info(`[RESTORE] Lista assets: ${candidateAssets.map(a=>a.id).join(', ')}`)
    log.info(`[RESTORE] Backups involucrados: ${backupAccounts.map(b=>`${b.id}:${b.alias}`).join(', ')}`)

    const total = candidateAssets.length
    let regeneratedLinks = 0
    const existingSet = new Set()
    const needDownload = new Map() // assetId -> asset
    const recovered = new Map() // assetId -> { fileName, localTemp, size }

    // =============== FASE 1: SCAN MAIN (1 login) ===============
    await withMegaLock(async () => {
      const payload = decryptToJson(main.credentials.encData, main.credentials.encIv, main.credentials.encTag)
      await megaLogout(buildCtx(main))
      await megaLogin(payload, buildCtx(main))
      for (let i=0;i<candidateAssets.length;i++){
        const asset = candidateAssets[i]
        const idx = i+1
        const remoteBase = (main.baseFolder||'/').replaceAll('\\','/')
        const remoteFolder = path.posix.join(remoteBase, asset.slug)
        const expectedFile = asset.archiveName ? path.basename(asset.archiveName) : null
        let lsOut=''
        try {
          const ls = await runCmd('mega-ls', [remoteFolder], { quiet:true })
          lsOut = ls.out
        } catch { /* carpeta no existe */ }
        const lines = String(lsOut).split(/\r?\n/).map(l=>l.trim()).filter(Boolean)
        let fileName = null
        if (expectedFile && lines.includes(expectedFile)) fileName = expectedFile
        else if (expectedFile) fileName = lines.find(l=>l===expectedFile) || null
        if (!fileName) fileName = pickFirstFileFromLs(lsOut)
        const exists = !!fileName
        if (exists) {
          existingSet.add(asset.id)
          log.info(`[RESTORE][SCAN] (${idx}/${total}) existe asset=${asset.id} file=${fileName}`)
          if (!asset.megaLink && fileName) {
            // regenerar link dentro de misma sesión
            try {
              const remoteFile = path.posix.join(remoteFolder, fileName)
              try { await runCmd('mega-export', ['-d', remoteFile], { quiet:true }) } catch {}
              const exp = await runCmd('mega-export', ['-a', remoteFile], { quiet:true })
              const m = exp.out.match(/https?:\/\/mega\.nz\/\S+/i)
              if (m) {
                await prisma.asset.update({ where:{ id: asset.id }, data:{ megaLink: m[0], status:'PUBLISHED' } })
                regeneratedLinks++
                log.info(`[RESTORE][SCAN] link regenerado asset=${asset.id}`)
              }
            } catch(e){ log.warn(`[RESTORE][SCAN] fallo regenerar link asset=${asset.id} msg=${e.message}`) }
          }
        } else {
          needDownload.set(asset.id, asset)
          log.info(`[RESTORE][SCAN] (${idx}/${total}) falta asset=${asset.id}`)
        }
      }
      await megaLogout(buildCtx(main))
    }, 'RESTORE-PHASE1')

    // =============== FASE 2: DESCARGA BACKUPS (1 login por backup usado) ===============
    if (needDownload.size){
      for (const b of backupAccounts){
        if (!needDownload.size) break
        const payloadB = decryptToJson(b.credentials.encData, b.credentials.encIv, b.credentials.encTag)
        await withMegaLock(async () => {
          await megaLogout(buildCtx(b))
          await megaLogin(payloadB, buildCtx(b))
          for (const [assetId, asset] of Array.from(needDownload.entries())){
            const remoteBaseB = (b.baseFolder||'/').replaceAll('\\','/')
            const remoteFolderB = path.posix.join(remoteBaseB, asset.slug)
            let lsOut=''
            try { const ls = await runCmd('mega-ls', [remoteFolderB], { quiet:true }); lsOut = ls.out } catch { continue }
            const fileName = pickFirstFileFromLs(lsOut)
            if (!fileName) continue
            const remoteFile = path.posix.join(remoteFolderB, fileName)
            const localTemp = path.join(TEMP_DIR, `restore-${asset.id}-${Date.now()}-${fileName}`)
            try {
              await runCmd('mega-get', [remoteFile, localTemp], { quiet:true })
              if (fs.existsSync(localTemp)) {
                const size = fs.statSync(localTemp).size
                recovered.set(asset.id, { fileName, localTemp, size })
                needDownload.delete(asset.id)
                log.info(`[RESTORE][DL] asset=${asset.id} desde backup=${b.id} size=${size}`)
              }
            } catch(e){ log.warn(`[RESTORE][DL] fallo asset=${asset.id} backup=${b.id} msg=${e.message}`) }
          }
          await megaLogout(buildCtx(b))
        }, `RESTORE-DL-${b.id}`)
      }
    }

    // =============== FASE 3: SUBIDA MAIN (1 login) ===============
    let restored = 0
    await withMegaLock(async () => {
      if (recovered.size){
        const payload = decryptToJson(main.credentials.encData, main.credentials.encIv, main.credentials.encTag)
        await megaLogout(buildCtx(main))
        await megaLogin(payload, buildCtx(main))
        for (const [assetId, info] of recovered.entries()){
          const asset = assetMap.get(assetId)
          const remoteBase = (main.baseFolder||'/').replaceAll('\\','/')
          const remoteFolder = path.posix.join(remoteBase, asset.slug)
          const remoteFile = path.posix.join(remoteFolder, info.fileName)
          try { await runCmd('mega-mkdir', ['-p', remoteFolder], { quiet:true }) } catch {}
          const t0 = Date.now()
          try {
            await runCmd('mega-put', [info.localTemp, remoteFile], { quiet:true })
            try { await runCmd('mega-export', ['-d', remoteFile], { quiet:true }) } catch {}
            const exp = await runCmd('mega-export', ['-a', remoteFile], { quiet:true })
            const m = exp.out.match(/https?:\/\/mega\.nz\/\S+/i)
            const link = m?m[0]:null
            if (!link) throw new Error('No link')
            await prisma.asset.update({ where:{ id: asset.id }, data:{ megaLink: link, status:'PUBLISHED' } })
            restored++
            log.info(`[RESTORE][UP] asset=${asset.id} linkOK ms=${Date.now()-t0}`)
          } catch(e){
            log.error(`[RESTORE][UP] fallo asset=${asset.id} msg=${e.message}`)
          } finally {
            try { if (fs.existsSync(info.localTemp)) fs.unlinkSync(info.localTemp) } catch {}
          }
        }
        await megaLogout(buildCtx(main))
      }
    }, 'RESTORE-PHASE3')

    const skippedExisting = existingSet.size
    const notFoundSource = Array.from(needDownload.keys()).length
    log.info(`[RESTORE] Finalizado main=${id} total=${total} restaurados=${restored} existentes=${skippedExisting} linksRegenerados=${regeneratedLinks} noRecuperados=${notFoundSource}`)
    // Notificación: backup → assets
    try {
      await prisma.notification.create({
        data: {
          title: `Restauración de backups a assets completada`,
          body: `Se restauraron ${restored} assets desde backups hacia la cuenta principal (main=${id}, email=${main.email}). Existentes: ${skippedExisting}, links regenerados: ${regeneratedLinks}, no recuperados: ${notFoundSource}.`,
          status: 'UNREAD',
          type: 'AUTOMATION',
          typeStatus: 'SUCCESS'
        }
      })
    } catch(e){ log.warn('[NOTIF][RESTORE] No se pudo crear notificación: '+e.message) }
    return res.json({ restored, skippedExisting, regeneratedLinks, notFoundInBackups: notFoundSource, total })
  } catch (e){
    log.error('[RESTORE] fallo general: '+e.message)
    // Notificación de error
    try {
      await prisma.notification.create({
        data: {
          title: 'Error en restauración de backups',
          body: `Ocurrió un error al restaurar backups hacia assets (main=${req.params.id}, email=${main?.email || '--'}): ${e.message}`,
          status: 'UNREAD',
          type: 'AUTOMATION',
          typeStatus: 'ERROR'
        }
      })
    } catch(err){ log.warn('[NOTIF][RESTORE][ERROR] No se pudo crear notificación de error: '+err.message) }
    return res.status(500).json({ message:'Error en restauración', error: e.message })
  }
}
