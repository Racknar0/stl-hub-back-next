import crypto from 'node:crypto';

const TTL_MS = 10 * 60 * 1000;
export const cleanupError = (message, status = 409, details) => Object.assign(new Error(message), { status, details, expose: true, ...(details?.code ? { code: details.code } : {}) });
const EPSILON_MB = 1 / 1048576;
const space = mb => mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${Math.ceil(mb)} MB`;

function cleanupCandidates(accounts, assets) {
  const candidates = assets.map(asset => ({
    key: `asset:${asset.id}`, assetId: asset.id, title: asset.title, slug: asset.slug,
    copies: accounts.map(account => ({ accountId: account.id, ...(account.files.get(asset.id) || { missing: true, sizeMB: 0 }) })),
  }));
  // A file can use a historical folder name in one copy. Associate an otherwise
  // unmatched counterpart only when the complete relative path is unambiguous.
  const byRelativePath = new Map();
  for (const candidate of candidates) for (const copy of candidate.copies) {
    if (!copy.relativePath) continue;
    const previous = byRelativePath.get(copy.relativePath);
    if (previous && previous !== candidate) throw cleanupError('Dos modelos comparten una ruta de archivo. Revisa esa asociación antes de depurar.');
    byRelativePath.set(copy.relativePath, candidate);
  }
  const uncatalogued = new Map();
  for (const account of accounts) for (const file of account.unmatchedFiles || []) {
    if (!file.relativePath || file.relativePath.startsWith('/') || file.relativePath.split('/').some(part => !part || part === '.' || part === '..')) {
      throw cleanupError(`No se pudo validar la ubicación de un archivo de ${account.alias}. No se ha borrado nada.`);
    }
    let candidate = byRelativePath.get(file.relativePath) || uncatalogued.get(file.relativePath);
    if (!candidate) {
      candidate = { key: `file:${file.relativePath}`, assetId: null, title: file.relativePath.split('/').at(-1), relativePath: file.relativePath,
        copies: accounts.map(item => ({ accountId: item.id, missing: true, sizeMB: 0 })) };
      uncatalogued.set(file.relativePath, candidate);
    }
    const index = candidate.copies.findIndex(copy => copy.accountId === account.id);
    if (!candidate.copies[index].missing) throw cleanupError(`Hay archivos duplicados en ${account.alias}. Revisa sus rutas antes de depurar.`);
    candidate.copies[index] = { ...file, accountId: account.id, missing: false };
  }
  return [...candidates, ...uncatalogued.values()].map(candidate => ({ ...candidate,
    sizeMB: Math.max(0, ...candidate.copies.map(copy => copy.sizeMB || 0)),
  })).filter(candidate => candidate.sizeMB > 0).sort((a, b) => b.sizeMB - a.sizeMB || a.key.localeCompare(b.key));
}

export function cleanupAccountSummary(account, selected = []) {
  const freedMB = selected.reduce((sum, file) => sum + (file.copies.find(copy => copy.accountId === account.id)?.sizeMB || 0), 0);
  const availableMB = [...account.files.values(), ...(account.unmatchedFiles || [])].reduce((sum, file) => sum + file.sizeMB, 0);
  const requiredMB = account.usedMB / account.totalMB >= .99 ? Math.max(0, account.usedMB - account.totalMB * .95) : 0;
  return { id: account.id, alias: account.alias, type: account.type, usedMB: account.usedMB, totalMB: account.totalMB,
    beforePercent: account.usedMB / account.totalMB * 100, freedMB, requiredMB, availableMB,
    scannedFiles: account.scannedFiles ?? account.files.size + (account.unmatchedFiles?.length || 0),
    matchedFiles: account.files.size, unmatchedFiles: account.unmatchedFiles?.length || 0,
    protectedFiles: account.protectedFiles?.length || 0,
    remainingMB: Math.max(0, requiredMB - freedMB),
    afterPercent: Math.max(0, account.usedMB - freedMB) / account.totalMB * 100 };
}

export function selectExcessFiles(accounts, assets) {
  const targets = accounts.filter(account => account.usedMB / account.totalMB >= .99);
  if (!targets.length) throw cleanupError('Main y Backup están por debajo del 99 %. No necesitan depuración.', 409,
    { code: 'ALREADY_BELOW_THRESHOLD', accounts: accounts.map(account => cleanupAccountSummary(account)) });
  const remaining = new Map(targets.map(account => [account.id, Math.max(0, account.usedMB - account.totalMB * .95)]));
  const candidates = cleanupCandidates(accounts, assets);
  const selected = [];
  for (const candidate of candidates) {
    if ([...remaining.values()].every(value => value <= EPSILON_MB)) break;
    if (!candidate.copies.some(copy => !copy.missing && (remaining.get(copy.accountId) || 0) > 0)) continue;
    selected.push(candidate);
    candidate.copies.forEach(copy => {
      if (remaining.has(copy.accountId)) remaining.set(copy.accountId, remaining.get(copy.accountId) - copy.sizeMB);
    });
  }
  if ([...remaining.values()].some(value => value > EPSILON_MB)) {
    const summaries = accounts.map(account => cleanupAccountSummary(account, selected));
    const blocked = summaries.filter(account => account.remainingMB > EPSILON_MB);
    throw cleanupError(`No se puede llegar al 95 % con los archivos de la carpeta de modelos. ${blocked.map(account =>
      `${account.type === 'main' ? 'Main' : 'Backup'} ${account.alias}: necesita liberar ${space(account.requiredMB)}; se encontraron ${account.scannedFiles} archivos, con ${space(account.availableMB)} disponibles para esta limpieza. Faltan ${space(account.remainingMB)}.${account.protectedFiles ? ` Se conservan ${account.protectedFiles} archivos de otros modelos o en procesamiento.` : ''}`
    ).join(' ')} No se ha borrado nada.`, 409, { code: 'INSUFFICIENT_MODEL_FILES', accounts: summaries });
  }
  return { selected, targetIds: targets.map(account => account.id) };
}

function snapshotFingerprint(accounts, assets) {
  return crypto.createHash('sha256').update(JSON.stringify({
    assets: assets.map(asset => [asset.id, asset.slug, asset.archiveName, asset.replicas, asset.cleanupProtected]).sort((a, b) => a[0] - b[0]),
    accounts: accounts.map(account => [account.id, account.usedMB, account.totalMB, account.inventoryFingerprint || null,
      [...account.files].map(([id, file]) => [id, file?.handle || null, file?.sizeMB || 0, file?.path || null, file?.versions, file?.modifiedAt,
        (file?.entries || []).map(entry => [entry.handle, entry.sizeMB, entry.path, entry.versions, entry.modifiedAt]).sort((a, b) => a[0].localeCompare(b[0])),
      ]).sort((a, b) => a[0] - b[0]),
      (account.unmatchedFiles || []).map(file => [file.handle, file.sizeMB, file.path, file.versions, file.modifiedAt]).sort((a, b) => a[0].localeCompare(b[0])),
    ]).sort((a, b) => a[0] - b[0]),
  })).digest('hex');
}

export function createExcessCleanupService(deps) {
  const plans = new Map();
  const now = deps.now || Date.now;
  const prune = () => { for (const [id, plan] of plans) if (plan.expiresAt <= now()) plans.delete(id); };
  const inspect = async (family, onProgress = async () => {}) => {
    const snapshots = [];
    for (const account of family.accounts) {
      await onProgress({ phase: 'validating', currentAccount: { id: account.id, alias: account.alias, type: account.type },
        message: `Validando ${account.type === 'main' ? 'Main' : 'Backup'} ${account.alias}…` });
      let snapshot;
      try { snapshot = await deps.inspectAccount(account, [...family.assets, ...(family.protectedAssets || [])]); }
      catch (error) {
        throw cleanupError(`${account.type === 'main' ? 'Main' : 'Backup'} ${account.alias}: ${error.status ? error.message : 'no se pudo leer su almacenamiento o sus archivos. Vuelve a intentarlo.'} No se ha iniciado el borrado.`, error.status || 502,
          { code: 'ACCOUNT_INSPECTION_FAILED', accountId: account.id, alias: account.alias, type: account.type });
      }
      if (!(snapshot.totalMB > 0) || !(snapshot.usedMB >= 0)) throw cleanupError(`No se pudo validar el almacenamiento de ${account.alias}.`);
      snapshots.push({ ...snapshot, id: account.id, alias: account.alias, type: account.type });
    }
    return snapshots;
  };
  const exclusive = async task => {
    return deps.withLock(async () => {
      await deps.ensureIdle();
      const stop = deps.startBusy();
      try { return await (deps.withSessionScope ? deps.withSessionScope(task) : task()); } finally { stop(); }
    });
  };
  const publicPlan = plan => ({
    planId: plan.id, expiresAt: new Date(plan.expiresAt).toISOString(), targetPercent: 95,
    files: plan.selected.map(asset => ({ key: asset.key, assetId: asset.assetId, title: asset.title, relativePath: asset.relativePath, catalogued: asset.assetId !== null, sizeMB: asset.sizeMB,
      copies: asset.copies.map(copy => ({ accountId: copy.accountId, missing: Boolean(copy.missing), sizeMB: copy.sizeMB,
        fileCount: copy.missing ? 0 : (copy.entries?.length || 1),
        paths: copy.missing ? [] : (copy.entries || [copy]).map(file => file.relativePath || file.path),
      })),
    })),
    accounts: plan.snapshots.map(account => cleanupAccountSummary(account, plan.selected)),
  });
  const confirmedPlan = (accountId, ownerId, planId, confirmed) => {
    prune();
    const plan = plans.get(planId);
    if (!plan || plan.requestedAccountId !== accountId || plan.ownerId !== String(ownerId)) throw cleanupError('La vista previa caducó o no pertenece a esta cuenta. Vuelve a calcularla.');
    if (confirmed !== true) throw cleanupError('Debes confirmar expresamente la eliminación del plan mostrado.', 400);
    return plan;
  };
  return {
    planInfo(accountId, ownerId, planId, confirmed) {
      const plan = confirmedPlan(accountId, ownerId, planId, confirmed);
      return { accountIds: plan.snapshots.map(account => account.id), totalModels: plan.selected.length,
        totalFiles: plan.selected.reduce((sum, asset) => sum + asset.copies.reduce((count, copy) => count + (copy.missing ? 0 : copy.entries?.length || 1), 0), 0) };
    },
    async preview(accountId, ownerId, { onProgress = async () => {} } = {}) {
      prune();
      if (plans.size >= 100) throw cleanupError('Hay demasiadas vistas previas pendientes. Reintenta en unos minutos.', 429);
      await onProgress({ phase: 'waiting', message: 'Esperando turno para validar las cuentas en MEGA…' });
      return exclusive(async () => {
        const family = await deps.loadFamily(accountId);
        const snapshots = await inspect(family, onProgress);
        await onProgress({ phase: 'planning', message: 'Calculando los archivos necesarios para llegar al 95 %…' });
        const { selected, targetIds } = selectExcessFiles(snapshots, family.assets);
        const plan = { id: crypto.randomUUID(), requestedAccountId: accountId, ownerId: String(ownerId),
          expiresAt: now() + TTL_MS, snapshots, selected, targetIds,
          fingerprint: snapshotFingerprint(snapshots, [...family.assets, ...(family.protectedAssets || [])]) };
        plans.set(plan.id, plan);
        return publicPlan(plan);
      });
    },
    async execute(accountId, ownerId, planId, confirmed, { onProgress = async () => {} } = {}) {
      const plan = confirmedPlan(accountId, ownerId, planId, confirmed);
      const counters = { completedModels: 0, totalModels: plan.selected.length, completedFiles: 0,
        totalFiles: plan.selected.reduce((sum, asset) => sum + asset.copies.reduce((count, copy) => count + (copy.missing ? 0 : copy.entries?.length || 1), 0), 0) };
      const notify = patch => onProgress({ ...counters, ...patch });
      // Consume before waiting for the global lock: duplicate clicks cannot replay a plan.
      plans.delete(planId);
      await notify({ phase: 'waiting', message: 'Depuración confirmada. Esperando turno de MEGA…' });
      return exclusive(async () => {
        if (plan.expiresAt <= now()) throw cleanupError('La vista previa caducó. Vuelve a calcularla.');
        const family = await deps.loadFamily(accountId);
        const fresh = await inspect(family, notify);
        if (plan.expiresAt <= now()) throw cleanupError('La vista previa caducó durante la validación. Vuelve a calcularla.');
        if (snapshotFingerprint(fresh, [...family.assets, ...(family.protectedAssets || [])]) !== plan.fingerprint) throw cleanupError('Las cuentas o sus archivos cambiaron desde la vista previa. Recalcula antes de eliminar.');
        await deps.audit({ planId, stage: 'confirmed', ownerId: String(ownerId), ...publicPlan(plan) });
        const results = [];
        let stopped = false;
        let auditWarning = '';
        for (const asset of plan.selected) {
          const result = { key: asset.key, assetId: asset.assetId, title: asset.title, copies: [], completed: false };
          results.push(result);
          try {
            const currentAsset = { id: asset.assetId, title: asset.title };
            await notify({ phase: 'deleting', currentAsset, currentAccount: null, results,
              message: `Preparando modelo ${counters.completedModels + 1} de ${counters.totalModels}: ${asset.title}` });
            // Withdraw before touching the public download, including on partial failures.
            if (asset.assetId !== null) await deps.withdrawAsset(asset.assetId, planId);
            for (const copy of asset.copies) {
              if (copy.missing) { result.copies.push({ accountId: copy.accountId, missing: true }); continue; }
              const account = family.accounts.find(item => item.id === copy.accountId);
              const copyResult = { accountId: account.id, deleted: false, files: [] };
              result.copies.push(copyResult);
              for (const file of copy.entries || [copy]) {
                await notify({ phase: 'deleting', currentAsset, currentAccount: { id: account.id, alias: account.alias, type: account.type }, results,
                  message: `Modelo ${counters.completedModels + 1} de ${counters.totalModels} · ${account.type === 'main' ? 'Main' : 'Backup'} ${account.alias}` });
                try {
                  await deps.deleteFile(account, file);
                } catch (error) {
                  copyResult.files.push({ path: file.relativePath || file.path, deleted: false, error: error.message });
                  throw error;
                }
                copyResult.files.push({ path: file.relativePath || file.path, deleted: true });
                counters.completedFiles++;
                await notify({ phase: 'deleting', currentAsset, currentAccount: { id: account.id, alias: account.alias, type: account.type }, results,
                  message: `${counters.completedFiles} de ${counters.totalFiles} archivos procesados` });
              }
              copyResult.deleted = true;
            }
            result.completed = true;
            counters.completedModels++;
            await notify({ phase: 'deleting', currentAsset, currentAccount: null, results,
              message: `${counters.completedModels} de ${counters.totalModels} modelos procesados` });
          } catch (error) {
            result.error = error.message;
            stopped = true;
            // Do not continue deleting other assets after an unexpected failure.
            break;
          }
          try { await deps.audit({ planId, stage: 'progress', results }); }
          catch {
            stopped = true;
            auditWarning = 'Se detuvo la depuración porque no se pudo guardar su registro de progreso. Revisa los archivos procesados.';
            break;
          }
        }
        const accounts = [];
        for (const account of family.accounts) {
          try {
            await notify({ phase: 'refreshing', currentAccount: { id: account.id, alias: account.alias, type: account.type }, currentAsset: null, results,
              message: `Comprobando el porcentaje final de ${account.alias}…` });
            const storage = await deps.refreshAccount(account);
            accounts.push({ id: account.id, alias: account.alias, ...storage, percent: storage.usedMB / storage.totalMB * 100 });
          } catch (error) { accounts.push({ id: account.id, alias: account.alias, error: error.message }); stopped = true; }
        }
        const targetReached = plan.targetIds.every(id => accounts.find(account => account.id === id)?.percent <= 95);
        const report = { planId, ok: !stopped && targetReached, partial: stopped || !targetReached, results, accounts,
          message: auditWarning || (stopped ? 'La depuración se detuvo. Revisa el resultado antes de volver a calcular.' : targetReached ? 'Depuración completada. Las cuentas saturadas están al 95% o menos.' : 'Los archivos se eliminaron, pero MEGA todavía informa más del 95%. No se borraron archivos adicionales.') };
        try { await deps.audit({ ...report, stage: 'finished' }); }
        catch {
          report.ok = false;
          report.partial = true;
          report.message = 'No se pudo guardar el registro final. Revisa el resultado de los archivos procesados antes de continuar.';
        }
        return report;
      });
    },
  };
}
