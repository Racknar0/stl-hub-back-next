import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createExcessCleanupJobs } from '../src/services/excessCleanupJobs.js';
import { createCleanupJobHandlers } from '../src/controllers/accountExcessCleanupJobs.controller.js';

const PLAN = '11111111-1111-4111-8111-111111111111';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
async function until(check) { const deadline = Date.now() + 2000; while (Date.now() < deadline) { if (await check()) return; await tick(); } throw new Error('State did not settle'); }
function response() {
  return { statusCode: 200, headers: {}, set(key, value) { this.headers[key] = value; }, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
}
const request = (body = {}, id = 747, owner = 7, extra = {}) => ({ params: { id: String(id), ...extra }, user: owner ? { id: owner } : null, body });

async function harness(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cleanup-http-'));
  t.after(async () => {
    assert.equal(path.dirname(directory), os.tmpdir());
    assert.ok(path.basename(directory).startsWith('cleanup-http-'));
    await rm(directory, { recursive: true, force: true });
  });
  const scheduled = [];
  const gate = deferred();
  const calls = { execute: 0, preview: 0, planInfo: 0 };
  const jobs = createExcessCleanupJobs({ directory, schedule: callback => scheduled.push(callback) });
  const report = { ok: true, partial: false, message: 'Completada', accounts: [{ id: 747, percent: 94 }], results: [{ assetId: 4, completed: true }] };
  const service = {
    planInfo(id, owner, plan, confirmed) {
      calls.planInfo++;
      assert.equal(id, 747); assert.equal(owner, 7); assert.equal(plan, PLAN); assert.equal(confirmed, true);
      return { accountIds: [747, 748], totalModels: 1, totalFiles: 2 };
    },
    async preview(id, owner, { onProgress }) {
      calls.preview++;
      await onProgress({ phase: 'validating', message: 'Validando Main', currentAccount: { id: 747, alias: 'Main', type: 'main' } });
      await gate.promise;
      return { planId: PLAN, files: [], accounts: [], expiresAt: '2099-01-01T00:00:00Z' };
    },
    async execute(id, owner, plan, confirmed, { onProgress }) {
      calls.execute++;
      await onProgress({ phase: 'deleting', message: 'Procesando Backup', currentAccount: { id: 748, alias: 'Backup', type: 'backup' },
        completedFiles: 1, totalFiles: 2, results: [{ assetId: 4, completed: false, copies: [{ accountId: 747, deleted: true }] }] });
      await gate.promise;
      return report;
    },
  };
  const handlers = createCleanupJobHandlers({ jobs, service, loadFamily: async () => ({ accounts: [{ id: 747 }, { id: 748 }] }), logError: () => {} });
  return { jobs, handlers, service, scheduled, calls, gate, report };
}

test('execution returns persisted 202 before MEGA work and duplicate acknowledgement starts only one worker', async t => {
  const h = await harness(t);
  const first = response();
  await h.handlers.execute(request({ planId: PLAN, confirm: true }), first);
  assert.equal(first.statusCode, 202); assert.equal(first.body.job.status, 'queued');
  assert.equal(h.calls.execute, 0); assert.equal(h.scheduled.length, 1);
  assert.equal(first.headers['Cache-Control'], 'no-store');
  const again = response();
  await h.handlers.execute(request({ planId: PLAN, confirm: true }), again);
  assert.equal(again.body.job.id, first.body.job.id); assert.equal(h.scheduled.length, 1); assert.equal(h.calls.planInfo, 1);
  const work = h.scheduled.shift()();
  await until(() => h.calls.execute === 1);
  await until(async () => (await h.jobs.get(first.body.job.id, 747, 7)).progress.completedFiles === 1);
  const current = response(); await h.handlers.current(request({}, 748), current);
  assert.equal(current.body.job.id, first.body.job.id); assert.equal(current.body.job.progress.currentAccount.id, 748);
  assert.equal(current.body.job.result.results[0].copies[0].deleted, true);
  // Completing the task does not depend on the original response or connection.
  h.gate.resolve(); await work;
  const completed = response(); await h.handlers.get(request({}, 748, 7, { jobId: first.body.job.id }), completed);
  assert.equal(completed.body.job.status, 'succeeded'); assert.deepEqual(completed.body.job.result, h.report);
});

test('preview is asynchronous and overlapping family requests return the existing job without a second worker', async t => {
  const h = await harness(t);
  const first = response(); await h.handlers.preview(request(), first);
  assert.equal(first.statusCode, 202); assert.equal(h.calls.preview, 0);
  const overlap = response(); await h.handlers.preview(request({}, 748), overlap);
  assert.equal(overlap.statusCode, 409); assert.equal(overlap.body.details.job.id, first.body.job.id);
  assert.equal(h.scheduled.length, 1);
  const work = h.scheduled.shift()(); await until(() => h.calls.preview === 1);
  h.gate.resolve(); await work;
  assert.equal((await h.jobs.current(747, 7)).result.planId, PLAN);
});

test('status endpoints enforce job owner and family, and never start work', async t => {
  const h = await harness(t);
  const started = response(); await h.handlers.preview(request(), started);
  for (const [id, owner] of [[747, 8], [999, 7]]) {
    const denied = response(); await h.handlers.get(request({}, id, owner, { jobId: started.body.job.id }), denied);
    assert.equal(denied.statusCode, 404);
  }
  const anonymous = response(); await h.handlers.current(request({}, 747, null), anonymous);
  assert.equal(anonymous.statusCode, 401); assert.equal(h.calls.preview, 0);
  const otherOwner = response(); await h.handlers.current(request({}, 747, 8), otherOwner);
  assert.equal(otherOwner.body.job, null);
  const list = response(); await h.handlers.list(request({}, 747, 7), list);
  assert.equal(list.body.jobs.length, 1); assert.ok(!JSON.stringify(list.body).includes('ownerId'));
});

test('invalid confirmations never queue deletion and list responses omit full manifests', async t => {
  const h = await harness(t);
  for (const body of [{ planId: PLAN, confirm: false }, { planId: '../bad', confirm: true }]) {
    const rejected = response(); await h.handlers.execute(request(body), rejected);
    assert.equal(rejected.statusCode, 400);
  }
  assert.equal(h.scheduled.length, 0);
  const start = response(); await h.handlers.execute(request({ planId: PLAN, confirm: true }), start);
  h.gate.resolve(); await h.scheduled.shift()();
  const list = response(); await h.handlers.list(request(), list);
  assert.equal(list.body.jobs.length, 1); assert.ok(!JSON.stringify(list.body).includes('copies'));
  assert.ok(!JSON.stringify(list.body).includes('results'));
});
