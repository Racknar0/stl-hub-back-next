import { PrismaClient } from '@prisma/client';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { megaLoginFull, megaLogoutSafe } from '../utils/megaSession.js';
import { decryptToJson } from '../utils/cryptoUtils.js';
import { parseStorageFromDfText } from '../utils/megaDfParser.js';
import { withMegaLock } from '../utils/megaQueue.js';
import { isUploadsActive, startUploadsActive } from '../utils/uploadsActiveFlag.js';
import { createExcessCleanupService, cleanupError } from '../services/accountExcessCleanup.js';
import { expectedAssetPath, inspectCleanupInventory, parseCleanupEntries } from '../utils/excessCleanupInventory.js';
import { applyMegaProxy, getStickyProxyForAccount, listMegaProxies } from '../utils/megaProxy.js';

const prisma = new PrismaClient();
const executeFile = promisify(execFile);
const mega = async (command, args, timeout = 60000) => {
  const { stdout } = await executeFile(command, args, { shell: false, timeout, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
};
const credentials = account => decryptToJson(account.credentials.encData, account.credentials.encIv, account.credentials.encTag);
const session = async (account, task) => {
  const ctx = `excess-cleanup account=${account.id}`;
  try {
    const proxies = listMegaProxies({ shuffle: false });
    if (!proxies.length) throw cleanupError('No hay un proxy MEGA disponible para validar esta cuenta.', 503);
    let loggedIn = false;
    let loginError;
    for (let attempt = 0; attempt < Math.min(3, proxies.length); attempt++) {
      try {
        const proxy = getStickyProxyForAccount(account, attempt);
        if (!proxy) continue;
        const applied = await applyMegaProxy(proxy, { ctx, timeoutMs: 15000, clearOnFail: false });
        if (!applied?.enabled) continue;
        await megaLoginFull(prisma, account.id, credentials(account), ctx, { skipStorageRefresh: true, skipProxySetup: true, skipResetServer: true, timeoutMs: 15000, maxProxyRetries: 0 });
        loggedIn = true;
        break;
      } catch (error) { loginError = error; }
    }
    if (!loggedIn) throw cleanupError(`No se pudo validar ${account.alias} mediante proxy. Reintenta más tarde.`, 503);
    void loginError;
    return await task();
  } finally { await megaLogoutSafe(ctx); }
};

async function loadFamily(id) {
  const requested = await prisma.megaAccount.findUnique({ where: { id }, include: { assignedAsBackup: true } });
  if (!requested) throw cleanupError('Cuenta no encontrada.', 404);
  if (requested.type === 'backup' && requested.assignedAsBackup.length !== 1) throw cleanupError('Este backup no tiene un único Main. Inicia la depuración desde la cuenta Main correspondiente.');
  const mainId = requested.type === 'main' ? id : requested.assignedAsBackup[0].mainAccountId;
  const main = await prisma.megaAccount.findUnique({ where: { id: mainId }, include: { credentials: true, backups: { include: { backupAccount: { include: { credentials: true } } } } } });
  if (!main || main.type !== 'main') throw cleanupError('No se pudo identificar la cuenta Main.');
  const accounts = new Map([[main.id, main], ...main.backups.map(link => [link.backupAccount.id, link.backupAccount])]);
  if (accounts.size < 2) throw cleanupError('La cuenta Main no tiene un Backup vinculado.');
  const assets = await prisma.asset.findMany({ where: { accountId: main.id, status: { not: 'PROCESSING' } }, select: { id: true, title: true, slug: true, archiveName: true, replicas: { select: { accountId: true, remotePath: true } } } });
  const extraIds = [...new Set(assets.flatMap(asset => asset.replicas.map(replica => replica.accountId)))].filter(accountId => !accounts.has(accountId));
  if (extraIds.length) {
    const extras = await prisma.megaAccount.findMany({ where: { id: { in: extraIds } }, include: { credentials: true } });
    extras.forEach(account => accounts.set(account.id, account));
    if (extras.length !== extraIds.length) throw cleanupError('Faltan cuentas de algunas réplicas. Revisa sus relaciones.');
  }
  // Shared or historical backups may contain another Main's catalogue. Those
  // files must never become "unassociated" deletion candidates for this family.
  const accountIds = [...accounts.keys()];
  const protectedAssets = await prisma.asset.findMany({
    where: { OR: [
      { accountId: { not: main.id }, OR: [{ accountId: { in: accountIds } }, { replicas: { some: { accountId: { in: accountIds } } } }] },
      { accountId: main.id, status: 'PROCESSING' },
    ] },
    select: { id: true, title: true, slug: true, archiveName: true, replicas: { select: { accountId: true, remotePath: true } } },
  });
  for (const account of accounts.values()) {
    if (!account.credentials) throw cleanupError(`La cuenta ${account.alias} no tiene credenciales para validarse.`);
    // Validate the base even when there are no candidate files.
    expectedAssetPath(account.baseFolder, { slug: 'validation', archiveName: 'validation.zip' });
  }
  return { accounts: [...accounts.values()], assets, protectedAssets: protectedAssets.map(asset => ({ ...asset, cleanupProtected: true })) };
}

async function readStorage() {
  const storage = parseStorageFromDfText(await mega('mega-df', []));
  if (!(storage.storageTotalMB > 0) || storage.storageUsedMB < 0) throw cleanupError('MEGA no devolvió una cuota real válida. No se usará una cuota estimada para borrar archivos.');
  return { usedMB: storage.storageUsedMB, totalMB: storage.storageTotalMB, fileCount: storage.fileCount, folderCount: storage.folderCount };
}

const service = createExcessCleanupService({
  loadFamily,
  withLock: task => withMegaLock(task, 'ACCOUNT-EXCESS-CLEANUP'),
  ensureIdle: async () => {
    if (isUploadsActive()) throw cleanupError('Hay subidas activas. Reintenta cuando terminen.', 423);
    const flags = [process.env.UPLOADS_ACTIVE_FLAG || path.resolve('uploads/sync-cache/uploads-active.lock'), path.resolve('uploads/uploads-active.lock')];
    for (const flag of flags) {
      const stat = await fs.stat(flag).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (stat && Date.now() - stat.mtimeMs < 120000) throw cleanupError('Hay una operación de MEGA activa. Reintenta cuando termine.', 423);
    }
  },
  startBusy: () => startUploadsActive('account-excess-cleanup'),
  inspectAccount: (account, assets) => session(account, async () => {
    const storage = await readStorage();
    let listing;
    // find -l has a different, descriptive format. ls -lR supplies stable
    // file rows (versions, bytes, timestamp, handle) under each directory header.
    try { listing = await mega('mega-ls', ['-lR', '--show-handles', '--time-format=ISO6081_WITH_TIME', account.baseFolder || '/'], 180000); }
    catch (error) {
      if (/not found|no such file|not exist/i.test(String(error.stderr || error.message))) throw cleanupError(`La carpeta de modelos ${account.baseFolder || '/'} no existe o no se puede leer.`);
      else throw error;
    }
    const entries = parseCleanupEntries(listing, account.baseFolder || '/');
    const inventoryFingerprint = crypto.createHash('sha256').update(JSON.stringify(entries.sort((a, b) => a.handle.localeCompare(b.handle)))).digest('hex');
    // Restores can leave an unregistered copy of another Main's model here.
    // Protect catalogue matches by observed folder too, not only DB replicas.
    const base = path.posix.normalize(account.baseFolder || '/');
    const folders = [...new Set(entries.map(file => path.posix.dirname(path.posix.relative(base, file.path))))].filter(folder => folder !== '.');
    const otherCatalogueAssets = folders.length ? await prisma.asset.findMany({
      where: { id: { notIn: assets.map(asset => asset.id) }, OR: [
        { slug: { in: [...new Set(folders.map(folder => path.posix.basename(folder)))] } },
        ...folders.map(folder => ({ archiveName: { startsWith: `${folder}/` } })),
      ] },
      select: { id: true, title: true, slug: true, archiveName: true, replicas: { where: { accountId: account.id }, select: { accountId: true, remotePath: true } } },
    }) : [];
    const inventory = inspectCleanupInventory(listing, account.baseFolder || '/', [
      ...assets, ...otherCatalogueAssets.map(asset => ({ ...asset, cleanupProtected: true })),
    ], account.id);
    const percent = storage.usedMB / storage.totalMB * 100;
    const requiredMB = percent >= 99 ? Math.max(0, storage.usedMB - storage.totalMB * .95) : 0;
    const availableMB = [...inventory.files.values(), ...inventory.unmatchedFiles].reduce((sum, file) => sum + file.sizeMB, 0);
    console.log(`[EXCESS-CLEANUP][INVENTORY] account=${account.id} type=${account.type} usedMB=${storage.usedMB} totalMB=${storage.totalMB} percent=${percent.toFixed(2)} files=${entries.length} catalogued=${inventory.files.size} unassociated=${inventory.unmatchedFiles.length} protected=${inventory.protectedFiles.length} availableMB=${availableMB.toFixed(2)} requiredMB=${requiredMB.toFixed(2)}`);
    return { ...storage, inventoryFingerprint, scannedFiles: entries.length, ...inventory };
  }),
  audit: async entry => {
    const dir = path.resolve('logs/excess-cleanup');
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    if (!/^[a-f0-9-]{36}$/i.test(entry.planId)) throw new Error('Invalid audit identifier');
    await fs.appendFile(path.join(dir, `${entry.planId}.jsonl`), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
  },
  withdrawAsset: async (assetId, planId) => {
    await prisma.$transaction([
      prisma.asset.update({ where: { id: assetId }, data: { status: 'DRAFT', megaLink: null, megaLinkAlive: false, megaLinkCheckedAt: new Date() } }),
      prisma.assetReplica.updateMany({ where: { assetId }, data: { status: 'FAILED', megaLink: null, errorMessage: `Depuración de exceso ${planId}` } }),
    ]);
  },
  deleteFile: (account, file) => session(account, async () => {
    if (!/^H:[A-Za-z0-9_-]{8}$/.test(file.handle)) throw cleanupError('Identificador de archivo no válido.');
    let listing;
    try { listing = await mega('mega-ls', ['-l', '--show-handles', '--time-format=ISO6081_WITH_TIME', file.handle]); }
    catch (error) {
      if (/not found|no such file|not exist/i.test(String(error.stderr || error.message))) return;
      throw error;
    }
    const current = parseCleanupEntries(listing);
    if (current.length !== 1 || current[0].handle !== file.handle || current[0].sizeMB !== file.sizeMB || current[0].modifiedAt !== file.modifiedAt || current[0].versions !== file.versions) throw cleanupError('El archivo cambió durante la ejecución. La depuración se ha detenido.');
    // Exact file handle, no glob, no shell, no recursive folder deletion.
    // A file that was independently removed after revalidation is also acceptable.
    try { await mega('mega-rm', ['-f', file.handle]); }
    catch (error) {
      if (!/not found|no such file|not exist/i.test(String(error.stderr || error.message))) throw error;
    }
  }),
  refreshAccount: account => session(account, async () => {
    const storage = await readStorage();
    await prisma.megaAccount.update({ where: { id: account.id }, data: { storageUsedMB: storage.usedMB, storageTotalMB: storage.totalMB, lastCheckAt: new Date(), status: 'CONNECTED' } });
    return storage;
  }),
});

function handler(action) {
  return async (req, res) => {
    const accountId = Number(req.params.id);
    if (!Number.isSafeInteger(accountId) || accountId <= 0) return res.status(400).json({ message: 'Cuenta no válida.' });
    if (!req.user?.id) return res.status(401).json({ message: 'Sesión no válida.' });
    try {
      const result = action === 'preview'
        ? await service.preview(accountId, req.user.id)
        : await service.execute(accountId, req.user.id, req.body?.planId, req.body?.confirm);
      return res.status(result.partial ? 207 : 200).json(result);
    } catch (error) {
      console.error(`[EXCESS-CLEANUP] ${action} account=${accountId}: ${error.message}${error.details ? ` details=${JSON.stringify(error.details)}` : ''}`);
      return res.status(error.status || 500).json({ message: error.status ? error.message : 'No se pudo completar la operación. Revisa las cuentas y vuelve a calcular la vista previa.', details: error.status ? error.details : undefined });
    }
  };
}

export const previewAccountExcessCleanup = handler('preview');
export const executeAccountExcessCleanup = handler('execute');
