import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile, stat, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createExcessCleanupJobs } from '../src/services/excessCleanupJobs.js';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cleanup-jobs-'));
  const running = [];
  t.after(async () => { await Promise.all(running); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); });
  let clock = Date.parse('2026-11-14T12:00:00Z');
  const callbacks = [];
  const options = { directory, now: () => clock, schedule: callback => callbacks.push(() => { const promise = callback(); running.push(promise); return promise; }) };
  const manager = createExcessCleanupJobs(options);
  await manager.ready();
  return { directory, options, callbacks, manager, advance: ms => { clock += ms; } };
}
const input = run => ({ kind: 'execute', requestedAccountId: 1, accountIds: [1, 2], ownerId: 7, requestKey: 'execute:plan-one', run });
async function settled(manager, job) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const current = await manager.get(job.id, 1, 7);
    if (!['queued', 'running'].includes(current.status)) return current;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('worker did not settle');
}

test('ack is persisted before deferred runner and worker survives request lifetime', async t => {
  const f = await fixture(t); let calls = 0;
  const job = await f.manager.start(input(async update => {
    calls++; await update({ phase: 'deleting', completedFiles: 1, totalFiles: 2 });
    return { ok: true, results: [{ assetId: 5 }] };
  }));
  assert.equal(job.status, 'queued'); assert.equal(calls, 0);
  const disk = JSON.parse(await readFile(path.join(f.directory, `${job.id}.json`)));
  assert.equal(disk.status, 'queued');
  if (process.platform !== 'win32') {
    assert.equal((await stat(f.directory)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(f.directory, `${job.id}.json`))).mode & 0o777, 0o600);
  }
  // No HTTP request object is retained by the worker.
  f.callbacks.shift()();
  const done = await settled(f.manager, job);
  assert.equal(calls, 1); assert.equal(done.status, 'succeeded');
  assert.equal(done.progress.completedFiles, 1); assert.equal(done.result.results[0].assetId, 5);
  assert.equal(done.progress.phase, 'finished'); assert.equal(done.progress.message, 'Depuración completada.');
  assert.equal(done.progress.currentAsset, null); assert.equal(done.progress.currentAccount, null);
});

test('simultaneous lost-ack retries return same job and run once', async t => {
  const f = await fixture(t); let calls = 0;
  const payload = input(async () => { calls++; return { partial: true, message: 'Faltan archivos por procesar.' }; });
  const [a, b] = await Promise.all([f.manager.start(payload), f.manager.start(payload)]);
  assert.equal(a.id, b.id); assert.equal(f.callbacks.length, 1);
  f.callbacks.shift()(); const partial = await settled(f.manager, a); assert.equal(partial.status, 'partial');
  assert.equal(partial.progress.phase, 'partial'); assert.equal(partial.progress.message, 'Faltan archivos por procesar.');
  assert.equal(calls, 1);
  assert.equal((await f.manager.findRequest(payload.requestKey, 7)).id, a.id);
  assert.equal(await f.manager.findRequest(payload.requestKey, 8), null);
  assert.equal((await f.manager.start(payload)).id, a.id);
});

test('family aliases reserve atomically; overlap never exposes another owner', async t => {
  const f = await fixture(t);
  const job = await f.manager.start(input(async () => ({})));
  await assert.rejects(f.manager.start({ ...input(async () => ({})), requestedAccountId: 2, accountIds: [2, 3], requestKey: 'other' }), e => e.status === 409 && e.details.job.id === job.id);
  await assert.rejects(f.manager.start({ ...input(async () => ({})), ownerId: 8, requestKey: 'other' }), e => e.status === 409 && e.details === undefined);
  await assert.rejects(f.manager.assertAvailable([2], 8), e => e.status === 409 && !e.details);
  assert.equal((await f.manager.current(2, 7)).id, job.id);
  assert.equal(await f.manager.current(2, 8), null);
  assert.deepEqual(await f.manager.list(8), []);
  await assert.rejects(f.manager.get(job.id, 2, 8), e => e.status === 404);
  await assert.rejects(f.manager.get(job.id, 3, 7), e => e.status === 404);
  await assert.rejects(f.manager.get('../private', 1, 7), e => e.status === 404);
});

test('queued and running tasks become interrupted on restart without replay', async t => {
  const f = await fixture(t); let called = 0;
  const job = await f.manager.start(input(async () => { called++; return {}; }));
  const queued = await f.manager.start({ ...input(async () => { called++; }), requestedAccountId: 3, accountIds: [3], requestKey: 'queued' });
  const p = path.join(f.directory, `${job.id}.json`);
  const data = JSON.parse(await readFile(p)); data.status = 'running'; await writeFile(p, JSON.stringify(data));
  const restarted = createExcessCleanupJobs(f.options); await restarted.ready();
  assert.equal(called, 0); assert.equal((await restarted.get(job.id, 1, 7)).status, 'interrupted');
  assert.equal((await restarted.get(job.id, 1, 7)).progress.phase, 'interrupted');
  assert.equal((await restarted.get(queued.id, 3, 7)).status, 'interrupted');
  assert.equal((JSON.parse(await readFile(p))).status, 'interrupted');
  await restarted.assertAvailable([1, 2], 7);
});

test('restart invalidates finished previews but preserves completed execution results', async t => {
  const f = await fixture(t);
  const execute = await f.manager.start(input(async () => ({ ok: true, results: [{ assetId: 99 }] })));
  f.callbacks.shift()(); await settled(f.manager, execute);
  const preview = await f.manager.start({ ...input(async () => ({ planId: 'public-plan', expiresAt: '2026-11-14T12:10:00Z' })), kind: 'preview', requestKey: 'preview:one' });
  f.callbacks.shift()(); const readyPreview = await settled(f.manager, preview);
  assert.equal(readyPreview.progress.phase, 'finished'); assert.equal(readyPreview.progress.message, 'Vista previa preparada.');
  const restarted = createExcessCleanupJobs(f.options); await restarted.ready();
  const expired = await restarted.get(preview.id, 1, 7);
  assert.equal(expired.status, 'failed'); assert.equal(expired.error.code, 'PREVIEW_EXPIRED'); assert.equal(expired.result, undefined);
  assert.equal(expired.progress.phase, 'failed'); assert.equal(expired.progress.message, expired.error.message);
  assert.equal((await restarted.get(execute.id, 1, 7)).result.results[0].assetId, 99);
});

test('progress is ordered and all public/persisted results redact private nested fields', async t => {
  const f = await fixture(t);
  const job = await f.manager.start(input(async update => {
    await Promise.all([update({ completedFiles: 1, currentAsset: { title: 'A', handle: 'ABCDEFGH', password: 'secret' } }), update({ completedFiles: 2 })]);
    return { planId: 'public-plan', password: 'no', nested: { handle: 'ABCDEFGH', token: 'no', title: 'yes' }, copies: [{ accountId: 2, nodeHandle: 'ABCDEFGH' }] };
  }));
  f.callbacks.shift()(); const done = await settled(f.manager, job);
  assert.equal(done.progress.completedFiles, 2);
  for (const object of [done, ...(await f.manager.list(7)), await f.manager.current(2, 7)]) {
    const text = JSON.stringify(object);
    assert.ok(!text.includes('requestKey')); assert.ok(!text.includes('ownerId'));
    assert.ok(!text.includes('ABCDEFGH')); assert.ok(!text.includes('password')); assert.ok(!text.includes('token'));
  }
  const disk = JSON.parse(await readFile(path.join(f.directory, `${job.id}.json`)));
  assert.equal(disk.ownerId, '7'); assert.equal(disk.result.nested.title, 'yes'); assert.equal(disk.result.nested.handle, undefined);
});

test('controlled error keeps last safe progress and result, unknown errors hide internals', async t => {
  const f = await fixture(t);
  const job = await f.manager.start(input(async update => {
    await update({ progress: { phase: 'working', completedFiles: 3, currentAsset: { title: 'Current model' }, currentAccount: { id: 2 } }, result: { partial: true, results: [{ assetId: 11 }] } });
    throw Object.assign(new Error('Cambió el inventario.'), { status: 409, code: 'INVENTORY_CHANGED', details: { password: 'no', accountId: 1 } });
  }));
  f.callbacks.shift()(); const failed = await settled(f.manager, job);
  assert.equal(failed.status, 'failed'); assert.equal(failed.progress.completedFiles, 3);
  assert.equal(failed.progress.phase, 'failed'); assert.equal(failed.progress.message, failed.error.message);
  assert.equal(failed.progress.currentAsset.title, 'Current model'); assert.equal(failed.progress.currentAccount.id, 2);
  assert.equal(failed.result.results[0].assetId, 11); assert.equal(failed.error.details.password, undefined);
  const other = await f.manager.start({ ...input(async () => { throw new Error('password=secret command output'); }), requestKey: 'unknown' });
  f.callbacks.shift()(); assert.ok(!JSON.stringify(await settled(f.manager, other)).includes('secret'));
});

test('corrupt persistence fails closed and never starts another runner', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.directory, 'broken.json'), '{bad');
  const restarted = createExcessCleanupJobs(f.options);
  await assert.rejects(restarted.ready(), e => e.status === 503);
  await assert.rejects(restarted.start(input(async () => ({}))), e => e.status === 503);
  await assert.rejects(restarted.list(7), e => e.status === 503);
});

test('explicit exposed upstream failures preserve alias and code; unknown 503 errors stay private', async t => {
  const f = await fixture(t);
  const exposed = await f.manager.start(input(async () => {
    throw Object.assign(new Error('Backup cuenta-demo: no se pudo leer el inventario.'), { status: 502, expose: true, details: { code: 'ACCOUNT_INSPECTION_FAILED', alias: 'cuenta-demo', handle: 'ABCDEFGH' } });
  }));
  await f.callbacks.shift()();
  const failed = await settled(f.manager, exposed);
  assert.equal(failed.error.code, 'ACCOUNT_INSPECTION_FAILED');
  assert.match(failed.error.message, /cuenta-demo/);
  assert.equal(failed.error.details.alias, 'cuenta-demo');
  assert.equal(failed.error.details.handle, undefined);
  const unknown = await f.manager.start({ ...input(async () => {
    throw Object.assign(new Error('mega-login user password-secret command stdout'), { status: 503, details: { stdout: 'password-secret' } });
  }), requestKey: 'unexposed-503' });
  await f.callbacks.shift()();
  assert.ok(!JSON.stringify(await settled(f.manager, unknown)).includes('password-secret'));
});

test('list returns summaries without results and omits terminal tasks after 24h', async t => {
  const f = await fixture(t);
  const job = await f.manager.start(input(async () => ({ files: [{ title: 'Large result' }] })));
  await f.callbacks.shift()(); await settled(f.manager, job);
  const list = await f.manager.list(7);
  assert.equal(list.length, 1); assert.equal(list[0].result, undefined);
  assert.equal((await f.manager.get(job.id, 1, 7)).result.files[0].title, 'Large result');
  f.advance(86400001); assert.deepEqual(await f.manager.list(7), []);
});

test('cluster workers and secondary PM2 instances fail before filesystem writes', async t => {
  const f = await fixture(t);
  for (const [index, runtime] of [{ isClusterWorker: true, instanceId: '0' }, { isClusterWorker: false, instanceId: '1' }].entries()) {
    const directory = path.join(f.directory, `unsupported-${index}`);
    const manager = createExcessCleanupJobs({ directory, runtime });
    await assert.rejects(manager.ready(), e => e.status === 503 && e.code === 'JOB_UNSUPPORTED_WORKER');
    await assert.rejects(manager.start(input(async () => ({}))), e => e.code === 'JOB_UNSUPPORTED_WORKER');
    await assert.rejects(stat(directory), e => e.code === 'ENOENT');
  }
  const manager = createExcessCleanupJobs({ directory: path.join(f.directory, 'fork-zero'), runtime: { isClusterWorker: false, instanceId: '0' } });
  await manager.ready();
});

test('current expires terminal after 24h; seven-day pruning retains active work', async t => {
  const f = await fixture(t);
  const terminal = await f.manager.start(input(async () => ({})));
  f.callbacks.shift()(); await settled(f.manager, terminal);
  f.advance(86400001); assert.equal(await f.manager.current(1, 7), null);
  const active = await f.manager.start({ ...input(async () => ({})), requestedAccountId: 3, accountIds: [3], requestKey: 'active' });
  f.advance(7 * 86400000);
  await f.manager.start({ ...input(async () => ({})), requestedAccountId: 4, accountIds: [4], requestKey: 'new' });
  assert.equal((await f.manager.get(active.id, 3, 7)).status, 'queued');
  await assert.rejects(f.manager.get(terminal.id, 1, 7), e => e.status === 404);
  assert.ok(!(await readdir(f.directory)).some(name => name.endsWith('.tmp')));
});

test('retention stays bounded at 1000 records, reserving room before another ack', async t => {
  const f = await fixture(t);
  await Promise.all(Array.from({ length: 1001 }, async (_, index) => {
    const id = randomUUID();
    const timestamp = new Date(f.options.now() - index).toISOString();
    await writeFile(path.join(f.directory, `${id}.json`), JSON.stringify({ id, kind: 'execute', requestedAccountId: 1,
      accountIds: [1], ownerId: '7', status: 'succeeded', createdAt: timestamp, updatedAt: timestamp, result: { ok: true } }));
  }));
  const restarted = createExcessCleanupJobs(f.options); await restarted.ready();
  assert.equal((await restarted.list(7)).length, 20);
  const queued = await restarted.start(input(async () => ({})));
  assert.equal((await restarted.list(7)).length, 21);
  assert.equal((await restarted.get(queued.id, 2, 7)).status, 'queued');
  assert.equal((await readdir(f.directory)).filter(name => name.endsWith('.json')).length, 1000);
});
