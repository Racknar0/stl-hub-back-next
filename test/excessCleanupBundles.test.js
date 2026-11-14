import test from 'node:test';
import assert from 'node:assert/strict';
import { createExcessCleanupService } from '../src/services/accountExcessCleanup.js';
import { inspectCleanupInventory } from '../src/utils/excessCleanupInventory.js';

const timestamp = '2026-11-14T12:00:00';
const rows = (folder, files) => `${folder}:\nFLAGS VERS SIZE DATE HANDLE NAME\n${files.map(file =>
  `---- 1 ${file.mb * 1048576} ${timestamp} H:${file.handle} ${file.name}`
).join('\n')}\n`;

function bundleFixture({ failSecondBackupFile = false } = {}) {
  const accounts = [{ id: 1, alias: 'main', type: 'main' }, { id: 2, alias: 'backup', type: 'backup' }];
  const model = { id: 10, title: 'Modelo propio', slug: 'model-a', archiveName: 'model-a/model.zip' };
  const protectedModel = { id: 42, title: 'Modelo de otro Main', slug: 'foreign', archiveName: 'foreign/other.zip', cleanupProtected: true };
  const mainListing = rows('/STLHUB/model-a', [{ name: 'model.zip', mb: 60, handle: 'MAIN0001' }])
    + rows('/STLHUB/foreign', [{ name: 'other.zip', mb: 100, handle: 'FOREIGN1' }]);
  const backupListing = rows('/STLHUB/model-a', [
    { name: 'restored-original.zip', mb: 30, handle: 'BACK0001' },
    { name: 'restored-extra.7z', mb: 30, handle: 'BACK0002' },
  ]) + rows('/STLHUB/foreign', [{ name: 'other.zip', mb: 100, handle: 'FOREIGN2' }]);
  const state = new Map(accounts.map(account => [account.id, {
    usedMB: 1000, totalMB: 1000, scannedFiles: account.id === 1 ? 2 : 3,
    ...inspectCleanupInventory(account.id === 1 ? mainListing : backupListing, '/STLHUB', [model, protectedModel], account.id),
  }]));
  const calls = { withdrawn: [], deleted: [], attempts: [], audit: [], released: 0 };
  const deps = {
    now: () => 1000,
    loadFamily: async () => ({ accounts, assets: [model], protectedAssets: [protectedModel] }),
    withLock: task => task(), ensureIdle: async () => {}, startBusy: () => () => { calls.released++; },
    inspectAccount: async account => structuredClone(state.get(account.id)),
    audit: async entry => { calls.audit.push(structuredClone(entry)); },
    withdrawAsset: async id => { calls.withdrawn.push(id); },
    deleteFile: async (account, file) => {
      calls.attempts.push([account.id, file.handle]);
      if (failSecondBackupFile && file.handle === 'H:BACK0002') throw new Error('Second backup file unavailable');
      calls.deleted.push([account.id, file.handle]);
      const current = state.get(account.id);
      current.usedMB -= file.sizeMB;
      for (const [assetId, copy] of current.files) {
        const entries = (copy.entries || [copy]).filter(entry => entry.handle !== file.handle);
        if (!entries.length) current.files.delete(assetId);
        else current.files.set(assetId, { ...copy, entries, sizeMB: entries.reduce((sum, entry) => sum + entry.sizeMB, 0) });
      }
    },
    refreshAccount: async account => ({ usedMB: state.get(account.id).usedMB, totalMB: state.get(account.id).totalMB }),
  };
  return { accounts, state, calls, deps, service: createExcessCleanupService(deps) };
}

test('bundle preview includes every exact path and sums both backup files without mutating anything', async () => {
  const fixture = bundleFixture();
  const plan = await fixture.service.preview(1, 7);
  assert.equal(plan.files.length, 1);
  assert.equal(plan.files[0].assetId, 10);
  const main = plan.files[0].copies.find(copy => copy.accountId === 1);
  const backup = plan.files[0].copies.find(copy => copy.accountId === 2);
  assert.deepEqual(main.paths, ['model-a/model.zip']);
  assert.deepEqual(backup.paths, ['model-a/restored-original.zip', 'model-a/restored-extra.7z']);
  assert.equal(main.fileCount, 1); assert.equal(backup.fileCount, 2);
  assert.equal(main.sizeMB, 60); assert.equal(backup.sizeMB, 60);
  assert.ok(plan.accounts.every(account => account.requiredMB === 50 && account.afterPercent === 94));
  assert.ok(plan.accounts.every(account => account.protectedFiles === 1));
  assert.deepEqual(fixture.calls.withdrawn, []); assert.deepEqual(fixture.calls.deleted, []); assert.deepEqual(fixture.calls.audit, []);
  assert.ok(!JSON.stringify(plan).includes('H:'));
  assert.ok(!JSON.stringify(plan).includes('handle'));
});

test('confirming a bundle withdraws its model once and deletes exactly three explicit files', async () => {
  const fixture = bundleFixture();
  const plan = await fixture.service.preview(2, 7);
  const report = await fixture.service.execute(2, 7, plan.planId, true);
  assert.equal(report.ok, true); assert.equal(report.partial, false);
  assert.deepEqual(fixture.calls.withdrawn, [10]);
  assert.deepEqual(fixture.calls.deleted, [[1, 'H:MAIN0001'], [2, 'H:BACK0001'], [2, 'H:BACK0002']]);
  assert.ok(report.accounts.every(account => account.percent === 94));
  assert.equal(report.results[0].copies.find(copy => copy.accountId === 2).files.length, 2);
  assert.ok(report.results[0].copies.every(copy => copy.deleted));
  assert.ok(fixture.calls.deleted.every(([, handle]) => !handle.includes('FOREIGN')));
});

test('a failed second backup file preserves the first file result and returns a partial report', async () => {
  const fixture = bundleFixture({ failSecondBackupFile: true });
  const plan = await fixture.service.preview(1, 7);
  const report = await fixture.service.execute(1, 7, plan.planId, true);
  assert.equal(report.ok, false); assert.equal(report.partial, true);
  assert.deepEqual(fixture.calls.withdrawn, [10]);
  assert.deepEqual(fixture.calls.deleted, [[1, 'H:MAIN0001'], [2, 'H:BACK0001']]);
  assert.equal(report.results[0].completed, false);
  const main = report.results[0].copies.find(copy => copy.accountId === 1);
  const backup = report.results[0].copies.find(copy => copy.accountId === 2);
  assert.equal(main.deleted, true); assert.equal(backup.deleted, false);
  assert.deepEqual(backup.files, [
    { path: 'model-a/restored-original.zip', deleted: true },
    { path: 'model-a/restored-extra.7z', deleted: false, error: 'Second backup file unavailable' },
  ]);
  assert.equal(report.accounts.find(account => account.id === 1).percent, 94);
  assert.equal(report.accounts.find(account => account.id === 2).percent, 97);
});

test('changing a bundle entry revision invalidates confirmation before any deletion or withdrawal', async () => {
  const fixture = bundleFixture();
  const plan = await fixture.service.preview(1, 7);
  fixture.state.get(2).files.get(10).entries[1].versions = '2';
  await assert.rejects(fixture.service.execute(1, 7, plan.planId, true), error => {
    assert.equal(error.status, 409); assert.match(error.message, /cambiaron/); return true;
  });
  assert.deepEqual(fixture.calls.deleted, []); assert.deepEqual(fixture.calls.withdrawn, []);
  assert.deepEqual(fixture.calls.audit, []);
});

test('larger files belonging to another Main remain protected and are never candidates', async () => {
  const fixture = bundleFixture();
  const plan = await fixture.service.preview(1, 7);
  assert.deepEqual(plan.files.map(file => file.assetId), [10]);
  assert.ok(plan.files.every(file => !file.copies.some(copy => copy.paths.some(path => path.startsWith('foreign/')))));
  assert.ok(fixture.accounts.every(account => fixture.state.get(account.id).protectedFiles.length === 1));
  assert.ok(plan.accounts.every(account => account.availableMB === 60));
});
