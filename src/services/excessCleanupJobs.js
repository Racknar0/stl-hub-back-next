import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile, rename, unlink, chmod } from 'node:fs/promises';
import path from 'node:path';
import cluster from 'node:cluster';

const ACTIVE = new Set(['queued', 'running']);
const STATUSES = new Set([...ACTIVE, 'succeeded', 'partial', 'failed', 'interrupted']);
const DAY = 86400000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const progressKeys = ['phase', 'message', 'currentAsset', 'currentAccount', 'completedModels', 'totalModels', 'completedFiles', 'totalFiles'];
const secretKey = /password|passwd|secret|token|credential|session|cookie|authorization|handle|nonce|requestkey|ownerid|fingerprint|inventory|proxy|command|stdout|stderr|stack/i;
const error = (message, status, code, details) => Object.assign(new Error(message), { status, code, details });
const unavailable = () => error('El registro de tareas no está disponible. No se ha iniciado otra operación.', 503, 'JOB_STORAGE_UNAVAILABLE');
const notFound = () => error('No se encontró la tarea.', 404, 'JOB_NOT_FOUND');

// The runner supplies public plan/report data. Strip private implementation fields
// again at this boundary, including nested copies, before either persisting or returning.
function sanitize(value, depth = 0) {
  if (depth > 24) return null;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return value.slice(0, 20000).replace(/\bH:[A-Za-z0-9_-]{8}\b/g, '[redacted]');
  if (Array.isArray(value)) return value.slice(0, 20000).map(item => sanitize(item, depth + 1));
  if (typeof value !== 'object') return undefined;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !secretKey.test(key) && !['run', '__proto__', 'constructor', 'prototype'].includes(key))
    .map(([key, item]) => [key, sanitize(item, depth + 1)]));
}

function publicJob(job) {
  return sanitize({ id: job.id, kind: job.kind, requestedAccountId: job.requestedAccountId, accountIds: job.accountIds,
    status: job.status, createdAt: job.createdAt, updatedAt: job.updatedAt, finishedAt: job.finishedAt,
    progress: job.progress, result: job.result, error: job.error });
}

/** One manager per directory and one PM2 fork only. Multiple processes/workers
 * need an external transactional reservation store and are not supported here.
 * No startup path invokes a runner: destructive work is never replayed. */
export function createExcessCleanupJobs({ directory, now = Date.now, schedule = callback => setImmediate(callback),
  runtime = { isClusterWorker: cluster.isWorker, instanceId: process.env.NODE_APP_INSTANCE } }) {
  if (!directory) throw new TypeError('directory is required');
  const jobs = new Map();
  let initialization;
  let failure;
  let serial = Promise.resolve();
  const exclusive = task => {
    const promise = serial.then(task);
    serial = promise.catch(() => {});
    return promise;
  };
  const timestamp = () => new Date(now()).toISOString();
  const file = id => path.join(directory, `${id}.json`);

  async function persist(job) {
    const temporary = path.join(directory, `.${job.id}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(job)}\n`, { mode: 0o600, flag: 'wx' });
      await rename(temporary, file(job.id));
      await chmod(file(job.id), 0o600);
    } catch {
      failure = unavailable();
      throw failure;
    } finally { await unlink(temporary).catch(() => {}); }
  }

  async function prune(reserve = 0) {
    const terminal = [...jobs.values()].filter(job => !ACTIVE.has(job.status)).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    const allowance = Math.max(0, 1000 - reserve - [...jobs.values()].filter(job => ACTIVE.has(job.status)).length);
    for (let index = 0; index < terminal.length; index++) {
      const job = terminal[index];
      if (index < allowance && now() - Date.parse(job.updatedAt) <= 7 * DAY) continue;
      try { await unlink(file(job.id)); jobs.delete(job.id); }
      catch { failure = unavailable(); throw failure; }
    }
  }

  async function initialize() {
    if (runtime.isClusterWorker || (runtime.instanceId !== undefined && String(runtime.instanceId) !== '0')) {
      failure = error('La depuración requiere una única instancia del servidor.', 503, 'JOB_UNSUPPORTED_WORKER');
      throw failure;
    }
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      for (const name of await readdir(directory)) {
        if (!name.endsWith('.json')) continue;
        const job = JSON.parse(await readFile(path.join(directory, name), 'utf8'));
        if (!UUID.test(job.id) || name !== `${job.id}.json` || !['preview', 'execute'].includes(job.kind)
          || !STATUSES.has(job.status) || typeof job.ownerId !== 'string' || !job.ownerId || !Number.isSafeInteger(job.requestedAccountId) || job.requestedAccountId <= 0
          || !Array.isArray(job.accountIds) || !job.accountIds.includes(job.requestedAccountId)
          || job.accountIds.some(id => !Number.isSafeInteger(id) || id <= 0)
          || !Number.isFinite(Date.parse(job.createdAt)) || !Number.isFinite(Date.parse(job.updatedAt))) throw unavailable();
        jobs.set(job.id, job);
      }
      for (const job of jobs.values()) {
        if (ACTIVE.has(job.status)) {
          job.status = 'interrupted';
          job.error = { code: 'JOB_INTERRUPTED', message: 'El servidor se reinició. Revisa el estado antes de iniciar otra operación.' };
          job.progress = { ...job.progress, phase: 'interrupted', message: job.error.message };
        } else if (job.kind === 'preview' && ['succeeded', 'partial'].includes(job.status)) {
          job.status = 'failed';
          job.error = { code: 'PREVIEW_EXPIRED', message: 'La vista previa caducó al reiniciar el servidor. Vuelve a calcularla.' };
          job.progress = { ...job.progress, phase: 'failed', message: job.error.message };
          delete job.result;
        } else continue;
        job.updatedAt = timestamp(); job.finishedAt = job.updatedAt;
        await persist(job);
      }
      await prune();
    } catch { failure = unavailable(); throw failure; }
  }

  async function ready() {
    initialization ||= initialize();
    await initialization;
    if (failure) throw failure;
  }

  function requestMatch(requestKey, ownerId) {
    if (!requestKey) return null;
    return [...jobs.values()].find(job => job.ownerId === String(ownerId) && job.requestKey === requestKey) || null;
  }

  function available(accountIds, ownerId) {
    const occupied = [...jobs.values()].find(job => ACTIVE.has(job.status) && job.accountIds.some(id => accountIds.includes(id)));
    if (occupied) throw error('Ya hay una operación en curso para estas cuentas.', 409, 'JOB_ACCOUNT_BUSY',
      occupied.ownerId === String(ownerId) ? { job: publicJob(occupied) } : undefined);
  }

  async function work(id, run) {
    const job = jobs.get(id);
    let status;
    let updates = Promise.resolve();
    let updateFailure;
    const update = patch => {
      const pending = updates.then(async () => {
        if (failure) throw failure;
        if (!ACTIVE.has(job.status)) throw error('La tarea ya terminó.', 409, 'JOB_FINISHED');
        const progress = patch?.progress || patch || {};
        job.progress = { ...job.progress, ...sanitize(Object.fromEntries(progressKeys.filter(key => progress[key] !== undefined).map(key => [key, progress[key]]))) };
        if (patch?.result !== undefined) job.result = sanitize(patch.result);
        job.updatedAt = timestamp();
        await persist(job);
      });
      updates = pending.catch(cause => { updateFailure ||= cause; });
      return pending;
    };
    try {
      job.status = 'running'; job.updatedAt = timestamp();
      await persist(job);
      const result = await run(update);
      await updates;
      if (updateFailure) throw updateFailure;
      job.result = sanitize(result);
      status = result?.partial ? 'partial' : 'succeeded';
    } catch (cause) {
      await updates;
      status = 'failed';
      // Unknown exceptions may contain commands/credentials. Only controlled
      // application errors expose their intended public message/details.
      const exposed = cause?.expose === true || (Number.isInteger(cause?.status) && cause.status < 500);
      const code = cause?.code || (exposed ? cause?.details?.code : null);
      job.error = { code: typeof code === 'string' && /^[A-Z0-9_]{1,80}$/.test(code) ? code : 'JOB_FAILED',
        message: exposed ? sanitize(String(cause.message).slice(0, 2000)) : 'La operación se detuvo. Revisa su progreso antes de continuar.',
        ...(exposed && cause.details ? { details: sanitize(cause.details) } : {}) };
    }
    try {
      await exclusive(async () => {
        job.status = status;
        if (status === 'succeeded') {
          job.progress = { ...job.progress, phase: 'finished',
            message: job.result?.message || (job.kind === 'preview' ? 'Vista previa preparada.' : 'Depuración completada.'),
            currentAsset: null, currentAccount: null };
        } else if (status === 'partial') {
          job.progress = { ...job.progress, phase: 'partial', message: job.result?.message || 'La depuración terminó parcialmente. Revisa los archivos procesados.' };
        } else if (status === 'failed') {
          job.progress = { ...job.progress, phase: 'failed', message: job.error.message };
        }
        job.updatedAt = timestamp(); job.finishedAt = job.updatedAt;
        await persist(job);
        await prune();
      });
    } catch { /* failure blocks all later starts/reads until restart */ }
  }

  return {
    ready,
    async start({ kind, requestedAccountId, accountIds, ownerId, requestKey, run }) {
      await ready();
      return exclusive(async () => {
        if (failure) throw failure;
        if (!['preview', 'execute'].includes(kind) || typeof run !== 'function' || !ownerId
          || !Number.isSafeInteger(requestedAccountId) || requestedAccountId <= 0 || !Array.isArray(accountIds)
          || !accountIds.includes(requestedAccountId) || accountIds.some(id => !Number.isSafeInteger(id) || id <= 0)
          || (requestKey !== undefined && (typeof requestKey !== 'string' || !requestKey || requestKey.length > 512))) {
          throw error('Los datos de la tarea no son válidos.', 400, 'INVALID_JOB');
        }
        const previous = requestMatch(requestKey, ownerId);
        if (previous) {
          if (previous.kind !== kind || previous.requestedAccountId !== requestedAccountId) throw error('La solicitud ya pertenece a otra tarea.', 409, 'REQUEST_KEY_CONFLICT');
          return publicJob(previous);
        }
        available(accountIds, ownerId);
        if ([...jobs.values()].filter(job => ACTIVE.has(job.status)).length >= 1000) throw error('Hay demasiadas tareas en curso.', 503, 'JOB_CAPACITY_REACHED');
        await prune(1);
        const job = { id: randomUUID(), kind, requestedAccountId, accountIds: [...new Set(accountIds)], ownerId: String(ownerId),
          ...(requestKey ? { requestKey } : {}), status: 'queued', createdAt: timestamp(), updatedAt: timestamp(), progress: { phase: 'queued', message: 'Operación en cola.', completedModels: 0, totalModels: 0, completedFiles: 0, totalFiles: 0 } };
        await persist(job);
        jobs.set(job.id, job);
        const response = publicJob(job);
        try { schedule(() => work(job.id, run)); }
        catch {
          job.status = 'failed'; job.error = { code: 'JOB_SCHEDULE_FAILED', message: 'No se pudo iniciar la tarea.' };
          job.progress = { ...job.progress, phase: 'failed', message: job.error.message };
          job.updatedAt = timestamp(); job.finishedAt = job.updatedAt; await persist(job);
          throw unavailable();
        }
        return response;
      });
    },
    async get(jobId, accountId, ownerId) {
      await ready();
      const job = UUID.test(String(jobId)) ? jobs.get(jobId) : null;
      if (!job || job.ownerId !== String(ownerId) || !job.accountIds.includes(Number(accountId))) throw notFound();
      return publicJob(job);
    },
    async current(accountId, ownerId) {
      await ready();
      const candidates = [...jobs.values()].filter(job => job.ownerId === String(ownerId) && job.accountIds.includes(Number(accountId))
        && (ACTIVE.has(job.status) || now() - Date.parse(job.updatedAt) <= DAY))
        .sort((a, b) => Number(ACTIVE.has(b.status)) - Number(ACTIVE.has(a.status)) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
      return candidates.length ? publicJob(candidates[0]) : null;
    },
    async list(ownerId) {
      await ready();
      const owned = [...jobs.values()].filter(job => job.ownerId === String(ownerId))
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
      const selected = [...owned.filter(job => ACTIVE.has(job.status)),
        ...owned.filter(job => !ACTIVE.has(job.status) && now() - Date.parse(job.updatedAt) <= DAY).slice(0, 20)];
      return selected.map(job => { const summary = publicJob(job); delete summary.result; return summary; });
    },
    async assertAvailable(accountIds, ownerId) { await ready(); available(accountIds.map(Number), ownerId); },
    async findRequest(requestKey, ownerId) { await ready(); const job = requestMatch(requestKey, ownerId); return job ? publicJob(job) : null; },
  };
}
