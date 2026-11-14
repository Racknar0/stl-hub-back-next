import { cleanupError } from '../services/accountExcessCleanup.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// This layer acknowledges a persisted task. No HTTP request awaits MEGA work.
export function createCleanupJobHandlers({ jobs, service, loadFamily, logError = console.error }) {
  const progressReporter = update => async info => {
    const { results, ...progress } = info;
    await update({ progress, ...(results ? { result: { partial: true, results, accounts: [], message: 'La depuración sigue en curso.' } } : {}) });
  };
  const wrapped = (label, fn, { account = true } = {}) => async (req, res) => {
    const accountId = Number(req.params?.id);
    if (!req.user?.id) return res.status(401).json({ message: 'Sesión no válida.' });
    if (account && (!Number.isSafeInteger(accountId) || accountId <= 0)) return res.status(400).json({ message: 'Cuenta no válida.' });
    res.set?.('Cache-Control', 'no-store');
    try {
      await jobs.ready();
      return await fn(req, res, accountId, req.user.id);
    } catch (error) {
      const expose = error.expose === true || Number.isInteger(error.status) && error.status >= 400 && error.status < 500
        || ['JOB_STORAGE_UNAVAILABLE', 'JOB_UNSUPPORTED_WORKER', 'JOB_CAPACITY_REACHED'].includes(error.code);
      logError(`[EXCESS-CLEANUP] ${label} account=${accountId || '-'}: ${expose ? error.message : 'Internal task error'}`);
      return res.status(error.status || 500).json({
        message: expose ? error.message : 'No se pudo consultar la depuración. Vuelve a comprobar su estado; no inicies otra limpieza.',
        ...(error.code ? { code: error.code } : {}),
        ...(expose && error.details ? { details: error.details } : {}),
      });
    }
  };
  return {
    preview: wrapped('preview', async (req, res, accountId, ownerId) => {
      const family = await loadFamily(accountId);
      const job = await jobs.start({ kind: 'preview', requestedAccountId: accountId,
        accountIds: family.accounts.map(account => account.id), ownerId,
        run: update => service.preview(accountId, ownerId, { onProgress: progressReporter(update) }),
      });
      return res.status(202).json({ job });
    }),
    execute: wrapped('execute', async (req, res, accountId, ownerId) => {
      const { planId, confirm } = req.body || {};
      if (confirm !== true || !UUID.test(String(planId || ''))) throw cleanupError('Confirma la vista previa que deseas depurar.', 400);
      const requestKey = `execute:${accountId}:${planId}`;
      const previous = await jobs.findRequest(requestKey, ownerId);
      if (previous) return res.status(202).json({ job: previous });
      const info = service.planInfo(accountId, ownerId, planId, confirm);
      const job = await jobs.start({ kind: 'execute', requestedAccountId: accountId, accountIds: info.accountIds, ownerId, requestKey,
        run: async update => {
          await update({ progress: { phase: 'waiting', message: 'Depuración confirmada. Esperando turno de MEGA…',
            completedModels: 0, totalModels: info.totalModels, completedFiles: 0, totalFiles: info.totalFiles } });
          return service.execute(accountId, ownerId, planId, true, { onProgress: progressReporter(update) });
        },
      });
      return res.status(202).json({ job });
    }),
    get: wrapped('status', async (req, res, accountId, ownerId) => res.json({ job: await jobs.get(req.params.jobId, accountId, ownerId) })),
    current: wrapped('current', async (req, res, accountId, ownerId) => res.json({ job: await jobs.current(accountId, ownerId) })),
    list: wrapped('list', async (req, res, _accountId, ownerId) => {
      const all = await jobs.list(ownerId);
      const active = all.filter(job => ['queued', 'running'].includes(job.status));
      const recent = all.filter(job => !['queued', 'running'].includes(job.status) && Date.now() - Date.parse(job.updatedAt) <= 86400000).slice(0, 20);
      // The list is polled from the account overview: full manifests belong only
      // in an individual job, never in a repeated list response.
      return res.json({ jobs: [...active, ...recent].map(({ result, ...job }) => ({ ...job,
        ...(result ? { result: { ok: result.ok, partial: result.partial, message: result.message } } : {}),
      })) });
    }, { account: false }),
  };
}
