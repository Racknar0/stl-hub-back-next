import { PrismaClient } from '@prisma/client';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { megaLoginFull, megaLogoutSafe } from '../utils/megaSession.js';
import { decryptToJson } from '../utils/cryptoUtils.js';
import { parseStorageFromDfText } from '../utils/megaDfParser.js';
import { withMegaLock } from '../utils/megaQueue.js';
import { isUploadsActive, startUploadsActive } from '../utils/uploadsActiveFlag.js';
import { createExcessCleanupService, cleanupError } from '../services/accountExcessCleanup.js';
import { expectedAssetPath, inspectCleanupInventory, parseCleanupEntries } from '../utils/excessCleanupInventory.js';
import { applyMegaProxy, getStickyProxyForAccount, listMegaProxies } from '../utils/megaProxy.js';
import { createCleanupSessionRunner } from '../utils/excessCleanupSession.js';
import { createExcessCleanupJobs } from '../services/excessCleanupJobs.js';
import { createCleanupJobHandlers } from './accountExcessCleanupJobs.controller.js';

const prisma = new PrismaClient();
const executeFile = promisify(execFile);
const mega = async (command, args, timeout = 60000) => {
  const { stdout } = await executeFile(command, args, { shell: false, timeout, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
};
const credentials = account => decryptToJson(account.credentials.encData, account.credentials.encIv, account.credentials.encTag);
const sessionScope = new AsyncLocalStorage();
const session = (account, task) => {
  const runner = sessionScope.getStore();
  if (!runner) throw cleanupError('No se pudo preparar la sesión de esta depuración.', 503);
  return runner.run(account, task);
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
  withSessionScope: async task => {
    const runner = createCleanupSessionRunner({
      listProxies: listMegaProxies,
      getProxyForAccount: getStickyProxyForAccount,
      applyProxy: (proxy, { ctx }) => applyMegaProxy(proxy, { ctx, timeoutMs: 15000, clearOnFail: false }),
      credentials,
      login: (account, { ctx, credentials: payload }) => megaLoginFull(prisma, account.id, payload, ctx,
        { skipStorageRefresh: true, skipProxySetup: true, skipResetServer: true, timeoutMs: 15000, maxProxyRetries: 0 }),
      logout: megaLogoutSafe,
    });
    return sessionScope.run(runner, async () => {
      try { return await task(); }
      finally { await runner.close(); }
    });
  },
  ensureIdle: async () => {
    if (isUploadsActive()) throw cleanupError('MEGA está ocupado con otra operación. Vuelve a calcular cuando termine.', 423);
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

const jobs = createExcessCleanupJobs({ directory: path.resolve('logs/excess-cleanup-jobs') });
const handlers = createCleanupJobHandlers({ jobs, service, loadFamily });
export const previewAccountExcessCleanup = handlers.preview;
export const executeAccountExcessCleanup = handlers.execute;
export const getAccountExcessCleanupJob = handlers.get;
export const getCurrentAccountExcessCleanupJob = handlers.current;
export const listAccountExcessCleanupJobs = handlers.list;
