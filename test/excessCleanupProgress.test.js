import test from 'node:test';
import assert from 'node:assert/strict';
import { createExcessCleanupService } from '../src/services/accountExcessCleanup.js';

const accounts = [{ id: 1, alias: 'main-fixture', type: 'main' }, { id: 2, alias: 'backup-fixture', type: 'backup' }];
const entry = (accountId, assetId, index, sizeMB) => ({
  sizeMB, handle: `H:${accountId}${assetId}${index}ABCD`, versions: '1', modifiedAt: '2026-11-14T12:00:00',
  path: `/STLHUB/model-${assetId}/file-${index}.zip`, relativePath: `model-${assetId}/file-${index}.zip`, missing: false,
});
function progressFixture() {
  let clock = 1000;
  let activeScopes = 0;
  const assets = [10, 20].map(id => ({ id, title: `Model ${id}`, slug: `model-${id}`, archiveName: `file-${id}.zip` }));
  const state = new Map(accounts.map(account => [account.id, {
    usedMB: 1050, totalMB: 1000,
    files: new Map(assets.map(asset => {
      const sizeMB = asset.id === 10 ? 60 : 40;
      const files = account.id === 2 && asset.id === 10
        ? [entry(account.id, asset.id, 0, 30), entry(account.id, asset.id, 1, 30)]
        : [entry(account.id, asset.id, 0, sizeMB)];
      return [asset.id, files.length > 1 ? { sizeMB, entries: files, path: '/STLHUB/model-10', relativePath: 'model-10', missing: false } : files[0]];
    })),
  }]));
  const calls = { inspected: [], withdrawn: [], deleted: [], audit: [], opened: 0, closed: 0, stopped: 0, lockReleased: 0 };
  const deps = {
    now: () => clock,
    loadFamily: async () => ({ accounts, assets }),
    withLock: async task => { try { return await task(); } finally { calls.lockReleased++; } },
    ensureIdle: async () => {}, startBusy: () => () => { calls.stopped++; },
    withSessionScope: async task => {
      calls.opened++; activeScopes++;
      try { return await task(); } finally { activeScopes--; calls.closed++; }
    },
    inspectAccount: async account => {
      assert.equal(activeScopes, 1); calls.inspected.push(account.id);
      return structuredClone(state.get(account.id));
    },
    withdrawAsset: async id => { assert.equal(activeScopes, 1); calls.withdrawn.push(id); },
    deleteFile: async (account, file) => {
      assert.equal(activeScopes, 1);
      calls.deleted.push([account.id, file.handle]);
      state.get(account.id).usedMB -= file.sizeMB;
    },
    refreshAccount: async account => {
      assert.equal(activeScopes, 1);
      const storage = state.get(account.id);
      return { usedMB: storage.usedMB, totalMB: storage.totalMB };
    },
    audit: async event => { calls.audit.push(structuredClone(event)); },
  };
  return { deps, calls, state, service: createExcessCleanupService(deps), advance: ms => { clock += ms; }, scopes: () => activeScopes };
}

test('preview emits account-specific validation and planning progress without mutation', async () => {
  const f = progressFixture(); const updates = [];
  await f.service.preview(1, 7, { onProgress: async event => { updates.push(structuredClone(event)); } });
  assert.deepEqual(updates.map(event => event.phase), ['waiting', 'validating', 'validating', 'planning']);
  assert.deepEqual(updates.filter(event => event.currentAccount).map(event => event.currentAccount), accounts);
  assert.deepEqual(f.calls.withdrawn, []); assert.deepEqual(f.calls.deleted, []); assert.deepEqual(f.calls.audit, []);
  assert.equal(f.calls.opened, 1); assert.equal(f.calls.closed, 1); assert.equal(f.scopes(), 0);
});

test('execution progress counts two models and five physical files with Main/Backup phases', async () => {
  const f = progressFixture(); const updates = [];
  const plan = await f.service.preview(1, 7);
  assert.equal(f.service.planInfo(1, 7, plan.planId, true).totalFiles, 5);
  const report = await f.service.execute(1, 7, plan.planId, true, { onProgress: async event => { updates.push(structuredClone(event)); } });
  assert.equal(report.ok, true); assert.equal(f.calls.deleted.length, 5); assert.deepEqual(f.calls.withdrawn, [10, 20]);
  assert.ok(updates.every(event => event.totalFiles === 5 && event.totalModels === 2));
  assert.ok(updates.every((event, index) => !index || event.completedFiles >= updates[index - 1].completedFiles));
  assert.ok(updates.every((event, index) => !index || event.completedModels >= updates[index - 1].completedModels));
  assert.deepEqual([...new Set(updates.map(event => event.phase))], ['waiting', 'validating', 'deleting', 'refreshing']);
  assert.deepEqual(updates.filter(event => event.phase === 'validating').map(event => event.currentAccount.type), ['main', 'backup']);
  assert.deepEqual(new Set(updates.filter(event => event.phase === 'deleting' && event.currentAccount).map(event => event.currentAccount.type)), new Set(['main', 'backup']));
  assert.deepEqual(updates.filter(event => event.phase === 'refreshing').map(event => event.currentAccount.type), ['main', 'backup']);
  assert.equal(updates.at(-1).completedFiles, 5); assert.equal(updates.at(-1).completedModels, 2);
  assert.equal(f.calls.opened, 2); assert.equal(f.calls.closed, 2); assert.equal(f.calls.stopped, 2); assert.equal(f.scopes(), 0);
  assert.throws(() => f.service.planInfo(1, 7, plan.planId, true), { status: 409 });
});

test('session scope and busy flag release when account validation throws', async () => {
  const f = progressFixture();
  f.deps.inspectAccount = async account => { if (account.id === 2) throw new Error('Fixture account unavailable'); return structuredClone(f.state.get(account.id)); };
  await assert.rejects(f.service.preview(1, 7), { status: 502 });
  assert.equal(f.calls.opened, 1); assert.equal(f.calls.closed, 1); assert.equal(f.calls.stopped, 1); assert.equal(f.calls.lockReleased, 1); assert.equal(f.scopes(), 0);
  assert.deepEqual(f.calls.deleted, []); assert.deepEqual(f.calls.withdrawn, []);
});

test('progress persistence failure after a deletion preserves its true result once and stops later models', async () => {
  const f = progressFixture(); const updates = []; let failed = false;
  const plan = await f.service.preview(1, 7);
  const report = await f.service.execute(1, 7, plan.planId, true, { onProgress: async event => {
    updates.push(structuredClone(event));
    if (!failed && event.phase === 'deleting' && event.completedFiles === 1) {
      failed = true; throw new Error('Fixture progress write failed');
    }
  } });
  assert.equal(failed, true); assert.equal(report.partial, true); assert.equal(report.ok, false);
  assert.equal(f.calls.deleted.length, 1); assert.deepEqual(f.calls.withdrawn, [10]);
  assert.equal(report.results.length, 1); assert.match(report.results[0].error, /progress write failed/);
  const files = report.results.flatMap(result => result.copies.flatMap(copy => copy.files || []));
  assert.deepEqual(files, [{ path: 'model-10/file-0.zip', deleted: true }]);
  assert.equal(new Set(f.calls.deleted.map(([id, handle]) => `${id}:${handle}`)).size, 1);
  assert.equal(updates.at(-1).completedFiles, 1); assert.equal(updates.at(-1).completedModels, 0);
  assert.equal(f.calls.closed, 2); assert.equal(f.calls.stopped, 2); assert.equal(f.scopes(), 0);
});

test('progress failure after completing a model does not relabel its files as failed', async () => {
  const f = progressFixture(); let failed = false;
  const plan = await f.service.preview(1, 7);
  const report = await f.service.execute(1, 7, plan.planId, true, { onProgress: async event => {
    if (!failed && event.phase === 'deleting' && event.completedModels === 1) { failed = true; throw new Error('Fixture model progress failed'); }
  } });
  assert.equal(report.partial, true); assert.deepEqual(f.calls.withdrawn, [10]); assert.equal(f.calls.deleted.length, 3);
  assert.equal(report.results.length, 1); assert.equal(report.results[0].completed, true);
  const files = report.results[0].copies.flatMap(copy => copy.files);
  assert.equal(files.length, 3); assert.ok(files.every(file => file.deleted));
  assert.equal(f.calls.closed, 2); assert.equal(f.scopes(), 0);
});

test('planInfo validates owner, account, confirmation and expiry immediately without consuming valid plans', async () => {
  const f = progressFixture(); const plan = await f.service.preview(1, 7);
  const before = structuredClone(f.calls);
  assert.deepEqual(f.service.planInfo(1, 7, plan.planId, true), { accountIds: [1, 2], totalModels: 2, totalFiles: 5 });
  assert.deepEqual(f.calls, before);
  assert.throws(() => f.service.planInfo(1, 8, plan.planId, true), { status: 409 });
  assert.throws(() => f.service.planInfo(2, 7, plan.planId, true), { status: 409 });
  assert.throws(() => f.service.planInfo(1, 7, plan.planId, false), { status: 400 });
  assert.throws(() => f.service.planInfo(1, 7, plan.planId, 'true'), { status: 400 });
  assert.throws(() => f.service.planInfo(1, 7, 'wrong-plan', true), { status: 409 });
  assert.deepEqual(f.service.planInfo(1, 7, plan.planId, true), { accountIds: [1, 2], totalModels: 2, totalFiles: 5 });
  assert.deepEqual(f.calls, before);
  f.advance(600001);
  assert.throws(() => f.service.planInfo(1, 7, plan.planId, true), { status: 409 });
  assert.deepEqual(f.calls, before);
});
