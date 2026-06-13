import { PrismaClient } from '@prisma/client'
import { decryptToJson } from '../utils/cryptoUtils.js'
import { withMegaLock } from '../utils/megaQueue.js'
import { log, isVerbose } from '../utils/logger.js'
import { listMegaProxies } from '../utils/megaProxy.js'
import { megaCmdWithProgressAndStall, isMegaStallError, applyProxyByIndexOrThrow, megaGetWithStallRetry, megaPutWithStallRetry } from '../utils/megaTransfer.js'
import path from 'path'
import fs from 'fs'
import { runCmd } from '../utils/megaCmd.js'
import { megaLoginFull, megaLogoutSafe, refreshStorageMetrics } from '../utils/megaSession.js'
import { parseStorageFromDfText, pickFirstFileFromLs } from '../utils/megaDfParser.js'

const prisma = new PrismaClient()
const UPLOADS_DIR = path.resolve('uploads')
const TEMP_DIR = path.join(UPLOADS_DIR, 'tmp')
const DEFAULT_FREE_QUOTA_MB = Number(process.env.MEGA_FREE_QUOTA_MB) || 20480

function ensureDir(p){ if(!fs.existsSync(p)) fs.mkdirSync(p,{recursive:true}) }
ensureDir(TEMP_DIR)


function buildCtx(acc){
  if(!acc) return ''
  return `accId=${acc.id||'?'} alias=${acc.alias||'--'} email=${acc.email||'--'}`
}

const ROTATE_AFTER_DOWNLOAD_BYTES = Number(process.env.MEGA_ROTATE_AFTER_DOWNLOAD_BYTES || (3 * 1024 * 1024 * 1024));
const MEGA_TRANSFER_STALL_TIMEOUT_MS = Number(process.env.MEGA_TRANSFER_STALL_TIMEOUT_MS || (5 * 60 * 1000));
const MEGA_TRANSFER_STALL_MAX_RETRIES = Number(process.env.MEGA_TRANSFER_STALL_MAX_RETRIES || 2);
const MEGA_TRANSFER_STALL_BACKOFF_MS = Number(process.env.MEGA_TRANSFER_STALL_BACKOFF_MS || 30000);



async function refreshAccountStorageInCurrentSession(accountId, ctx = '') {
  return refreshStorageMetrics(prisma, accountId, ctx)
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

    // Proxies globales para este run (rotación por índice)
    const proxies = listMegaProxies({ shuffle: false });
    if (!proxies.length) throw new Error('[RESTORE][PROXY] Sin proxies válidos (no se permite IP directa)');
    let proxyIndex = 0;
    const getProxyIndex = () => proxyIndex;
    const setProxyIndex = (v) => { proxyIndex = v };

    let downloadedBytesTotal = 0;

    // =============== FASE 1: SCAN MAIN (1 login) ===============
    await withMegaLock(async () => {
      await applyProxyByIndexOrThrow(main, getProxyIndex(), buildCtx(main))
      const payload = decryptToJson(main.credentials.encData, main.credentials.encIv, main.credentials.encTag)
      await megaLogoutSafe(buildCtx(main))
      await megaLoginFull(prisma, main.id, payload, buildCtx(main), {
        skipStorageRefresh: true,
        skipProxySetup: true,
        maxProxyRetries: 0,
      })
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
      await megaLogoutSafe(buildCtx(main))
    }, 'RESTORE-PHASE1')

    // =============== FASE 2: DESCARGA BACKUPS (1 login por backup usado) ===============
    if (needDownload.size){
      for (const b of backupAccounts){
        if (!needDownload.size) break
        const payloadB = decryptToJson(b.credentials.encData, b.credentials.encIv, b.credentials.encTag)
        await withMegaLock(async () => {
          const bCtx = buildCtx(b)
          const reloginB = async () => {
            await megaLogoutSafe(bCtx)
            await megaLoginFull(prisma, b.id, payloadB, bCtx, {
              skipStorageRefresh: true,
              skipProxySetup: true,
              maxProxyRetries: 0,
            })
          }

          await applyProxyByIndexOrThrow(b, getProxyIndex(), bCtx)
          await reloginB()
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
              await megaGetWithStallRetry({
                remoteFile,
                destLocal: localTemp,
                ctx: `${bCtx} asset=${asset.id}`,
                account: b,
                getProxyIndex,
                setProxyIndex,
                relogin: reloginB,
              })
              if (fs.existsSync(localTemp)) {
                const size = fs.statSync(localTemp).size
                downloadedBytesTotal += size
                recovered.set(asset.id, { fileName, localTemp, size })
                needDownload.delete(asset.id)
                log.info(`[RESTORE][DL] asset=${asset.id} desde backup=${b.id} size=${size}`)
              }
            } catch(e){ log.warn(`[RESTORE][DL] fallo asset=${asset.id} backup=${b.id} msg=${e.message}`) }

            if (downloadedBytesTotal >= ROTATE_AFTER_DOWNLOAD_BYTES) {
              const prev = getProxyIndex();
              setProxyIndex(prev + 1);
              log.info(`[RESTORE][PROXY] Rotación intermedia total=${Math.round(downloadedBytesTotal/1024/1024)}MB (>=${Math.round(ROTATE_AFTER_DOWNLOAD_BYTES/1024/1024)}MB) idx ${prev} -> ${getProxyIndex()}`);
              await applyProxyByIndexOrThrow(b, getProxyIndex(), bCtx);
              await reloginB();
              downloadedBytesTotal = 0;
            }
          }
          try {
            await refreshAccountStorageInCurrentSession(b.id, `restore phase=download backup=${b.id}`)
          } catch (e) {
            log.warn(`[RESTORE][METRICS][WARN] backup=${b.id} no actualizado: ${String(e?.message || e).slice(0, 200)}`)
          }
          await megaLogoutSafe(buildCtx(b))
        }, `RESTORE-DL-${b.id}`)
      }
    }

    // (Rotación post-descarga eliminada, ahora es dinámica)

    // =============== FASE 3: SUBIDA MAIN (1 login) ===============
    let restored = 0
    await withMegaLock(async () => {
      if (recovered.size){
        const mainCtx = buildCtx(main)
        const payload = decryptToJson(main.credentials.encData, main.credentials.encIv, main.credentials.encTag)
        const reloginMain = async () => {
          await megaLogoutSafe(mainCtx)
          await megaLoginFull(prisma, main.id, payload, mainCtx, {
            skipStorageRefresh: true,
            skipProxySetup: true,
            maxProxyRetries: 0,
          })
        }

        await applyProxyByIndexOrThrow(main, getProxyIndex(), mainCtx)
        await reloginMain()
        for (const [assetId, info] of recovered.entries()){
          const asset = assetMap.get(assetId)
          const remoteBase = (main.baseFolder||'/').replaceAll('\\','/')
          const remoteFolder = path.posix.join(remoteBase, asset.slug)
          const remoteFile = path.posix.join(remoteFolder, info.fileName)
          try { await runCmd('mega-mkdir', ['-p', remoteFolder], { quiet:true }) } catch {}
          const t0 = Date.now()
          try {
            await megaPutWithStallRetry({
              localPath: info.localTemp,
              remoteFolderOrFile: remoteFile,
              ctx: `${mainCtx} asset=${assetId}`,
              account: main,
              getProxyIndex,
              setProxyIndex,
              relogin: reloginMain,
            })
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
        try {
          await refreshAccountStorageInCurrentSession(main.id, `restore phase=upload main=${main.id}`)
        } catch (e) {
          log.warn(`[RESTORE][METRICS][WARN] main=${main.id} no actualizada: ${String(e?.message || e).slice(0, 200)}`)
        }
        await megaLogoutSafe(mainCtx)
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
          type: 'STORAGE',
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
          type: 'STORAGE',
          typeStatus: 'ERROR'
        }
      })
    } catch(err){ log.warn('[NOTIF][RESTORE][ERROR] No se pudo crear notificación de error: '+err.message) }
    return res.status(500).json({ message:'Error en restauración', error: e.message })
  }
}
