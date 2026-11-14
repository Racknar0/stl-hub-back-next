import test from 'node:test';
import assert from 'node:assert/strict';
import { createExcessCleanupService } from '../src/services/accountExcessCleanup.js';
import { expectedAssetPath, parseCleanupInventory } from '../src/utils/excessCleanupInventory.js';

function fixture({ missingBackup = false, sizes = [80, 40], failBackup = false } = {}) {
  let clock = 1000;
  const accounts = [{ id: 1, alias: 'main', type: 'main' }, { id: 2, alias: 'backup', type: 'backup' }];
  const assets = sizes.map((size, index) => ({ id: index + 10, title: `Asset ${index}`, slug: `asset-${index}`, archiveName: `file-${index}.zip` }));
  const state = new Map(accounts.map(account => [account.id, { usedMB: account.id === 2 && missingBackup ? 900 : 1000, totalMB: 1000,
    files: new Map(assets.filter(() => !(account.id === 2 && missingBackup)).map((asset, index) => [asset.id, { handle: `H:${account.id}${String(index).padStart(7, '0')}`, sizeMB: sizes[index], path: `/STLHUB/${asset.slug}/${asset.archiveName}`, modifiedAt: '2026-11-14T12:00:00', versions: '1' }])) }]));
  const calls = { deleted: [], withdrawn: [], audit: [], released: 0, inspected: 0 };
  const deps = {
    now: () => clock,
    loadFamily: async () => ({ accounts, assets }),
    withLock: task => task(), ensureIdle: async () => {}, startBusy: () => () => { calls.released++; },
    inspectAccount: async account => { calls.inspected++; return structuredClone(state.get(account.id)); },
    audit: async entry => { calls.audit.push(structuredClone(entry)); },
    withdrawAsset: async id => { calls.withdrawn.push(id); },
    deleteFile: async (account, file) => {
      if (failBackup && account.id === 2) throw new Error('Backup unavailable');
      calls.deleted.push([account.id, file.handle]);
      const storage = state.get(account.id);
      const assetId = [...storage.files].find(([, current]) => current.handle === file.handle)?.[0];
      if (assetId !== undefined) { storage.files.delete(assetId); storage.usedMB -= file.sizeMB; }
    },
    refreshAccount: async account => ({ usedMB: state.get(account.id).usedMB, totalMB: state.get(account.id).totalMB }),
  };
  return { accounts, assets, state, calls, deps, service: createExcessCleanupService(deps), advance: ms => { clock += ms; } };
}

test('preview is read-only and selects largest files until both saturated accounts reach target', async () => {
  const f = fixture(); const plan = await f.service.preview(1, 7);
  assert.deepEqual(plan.files.map(file => file.assetId), [10]);
  assert.ok(plan.accounts.every(account => account.afterPercent === 92));
  assert.equal(f.calls.deleted.length, 0); assert.equal(f.calls.withdrawn.length, 0); assert.equal(f.calls.audit.length, 0);
  assert.ok(!JSON.stringify(plan).includes('H:')); assert.equal(f.calls.released, 1);
});

test('confirmation withdraws and deletes only the approved copies, then verifies live quota', async () => {
  const f = fixture(); const plan = await f.service.preview(2, 7);
  const result = await f.service.execute(2, 7, plan.planId, true);
  assert.equal(result.ok, true); assert.equal(f.calls.deleted.length, 2);
  assert.deepEqual(f.calls.withdrawn, [10]); assert.ok(result.accounts.every(account => account.percent === 92));
  await assert.rejects(f.service.execute(2, 7, plan.planId, true), { status: 409 });
});

test('missing copy is skipped without deleting other files', async () => {
  const f = fixture({ missingBackup: true }); const plan = await f.service.preview(1, 7);
  const result = await f.service.execute(1, 7, plan.planId, true);
  assert.equal(result.ok, true); assert.equal(f.calls.deleted.length, 1);
  assert.equal(result.results[0].copies.find(copy => copy.accountId === 2).missing, true);
});

test('expired, wrong owner, wrong account or unconfirmed plans cannot delete', async () => {
  const f = fixture(); const plan = await f.service.preview(1, 7);
  await assert.rejects(f.service.execute(1, 8, plan.planId, true), { status: 409 });
  await assert.rejects(f.service.execute(2, 7, plan.planId, true), { status: 409 });
  await assert.rejects(f.service.execute(1, 7, plan.planId, false), { status: 400 });
  f.advance(600001);
  await assert.rejects(f.service.execute(1, 7, plan.planId, true), { status: 409 });
  assert.equal(f.calls.deleted.length, 0); assert.equal(f.calls.withdrawn.length, 0);
});

test('changes in storage or a file revision invalidate the preview before any mutation', async () => {
  for (const change of [f => { f.state.get(1).usedMB++; }, f => { f.state.get(1).files.get(10).versions = '2'; }]) {
    const f = fixture(); const plan = await f.service.preview(1, 7); change(f);
    await assert.rejects(f.service.execute(1, 7, plan.planId, true), { status: 409 });
    assert.equal(f.calls.deleted.length, 0); assert.equal(f.calls.withdrawn.length, 0);
  }
});

test('duplicate execution requests consume the plan once', async () => {
  const f = fixture(); const plan = await f.service.preview(1, 7);
  const results = await Promise.allSettled([f.service.execute(1, 7, plan.planId, true), f.service.execute(1, 7, plan.planId, true)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(f.calls.deleted.length, 2);
});

test('a preview expiring during a slow revalidation cannot mutate data', async () => {
  const f = fixture(); const plan = await f.service.preview(1, 7);
  const inspect = f.deps.inspectAccount;
  f.deps.inspectAccount = async account => { f.advance(400000); return inspect(account); };
  await assert.rejects(f.service.execute(1, 7, plan.planId, true), { status: 409 });
  assert.equal(f.calls.deleted.length, 0); assert.equal(f.calls.withdrawn.length, 0);
});

test('unexpected backup failure stops further deletion and reports a partial result', async () => {
  const f = fixture({ sizes: [30, 25, 10], failBackup: true }); const plan = await f.service.preview(1, 7);
  const result = await f.service.execute(1, 7, plan.planId, true);
  assert.equal(result.partial, true); assert.equal(result.ok, false);
  assert.deepEqual(f.calls.withdrawn, [10]); assert.equal(f.calls.deleted.length, 1);
  assert.match(result.results[0].error, /Backup unavailable/);
});

test('insufficient model-folder files and active transfers do not delete or withdraw anything', async () => {
  const f = fixture({ sizes: [10] }); await assert.rejects(f.service.preview(1, 7));
  assert.equal(f.calls.deleted.length, 0); assert.equal(f.calls.withdrawn.length, 0);
  const g = fixture(); g.deps.ensureIdle = async () => { throw Object.assign(new Error('Busy'), { status: 423 }); };
  await assert.rejects(g.service.preview(1, 7), { status: 423 }); assert.equal(g.calls.inspected, 0);
});

test('a file exactly reaching 95% does not cause additional deletion', async () => {
  const f = fixture({ sizes: [50, 40] }); const plan = await f.service.preview(1, 7);
  assert.deepEqual(plan.files.map(file => file.assetId), [10]);
  assert.equal((await f.service.execute(1, 7, plan.planId, true)).ok, true);
});

test('failure to write the confirmation audit prevents all catalog and file mutation', async () => {
  const f = fixture(); const plan = await f.service.preview(1, 7);
  f.deps.audit = async () => { throw new Error('Disk full'); };
  await assert.rejects(f.service.execute(1, 7, plan.planId, true));
  assert.equal(f.calls.deleted.length, 0); assert.equal(f.calls.withdrawn.length, 0);
});

test('progress audit failure stops later assets and returns the processed result', async () => {
  const f = fixture({ sizes: [30, 25, 10] }); const plan = await f.service.preview(1, 7);
  f.deps.audit = async entry => { if (entry.stage === 'progress') throw new Error('Disk full'); };
  const result = await f.service.execute(1, 7, plan.planId, true);
  assert.equal(result.partial, true); assert.equal(result.ok, false);
  assert.equal(result.results[0].completed, true); assert.equal(result.results.length, 1);
  assert.equal(f.calls.deleted.length, 2); assert.deepEqual(f.calls.withdrawn, [10]);
});

test('final audit failure returns a structured partial report instead of losing the result', async () => {
  const f = fixture(); const plan = await f.service.preview(1, 7);
  f.deps.audit = async entry => { if (entry.stage === 'finished') throw new Error('Disk full'); };
  const result = await f.service.execute(1, 7, plan.planId, true);
  assert.equal(result.partial, true); assert.equal(result.results[0].completed, true);
  assert.equal(f.calls.deleted.length, 2); assert.match(result.message, /registro final/);
});

test('changes to unrelated files invalidate the complete-inventory fingerprint', async () => {
  const f = fixture(); f.state.get(1).inventoryFingerprint = 'before';
  const plan = await f.service.preview(1, 7); f.state.get(1).inventoryFingerprint = 'after';
  await assert.rejects(f.service.execute(1, 7, plan.planId, true), { status: 409 });
  assert.equal(f.calls.deleted.length, 0); assert.equal(f.calls.withdrawn.length, 0);
});

test('inventory maps exact known file paths and rejects ambiguous or malformed records', () => {
  const assets = [{ id: 10, slug: 'asset-0', archiveName: 'file with spaces.zip' }];
  const line = '---- 1 1048576 2026-11-14T12:00:00 H:ABCDEFGH /STLHUB/asset-0/file with spaces.zip';
  const files = parseCleanupInventory(`FLAGS VERS SIZE DATE HANDLE NAME\n${line}`, '/STLHUB', assets);
  assert.equal(files.get(10).sizeMB, 1); assert.equal(files.get(10).handle, 'H:ABCDEFGH');
  assert.throws(() => parseCleanupInventory(`${line}\n${line}`, '/STLHUB', assets));
  assert.throws(() => parseCleanupInventory('---- unrecognized file', '/STLHUB', assets));
  assert.equal(expectedAssetPath('/STLHUB', { slug: '../other', archiveName: 'x.zip' }), null);
  assert.throws(() => expectedAssetPath('/STL*', assets[0]));
});

test('several whole files can pass the 95% goal without an exact size match', async () => {
  const f = fixture({ sizes: [22, 19, 17, 5] });
  const plan = await f.service.preview(1, 7);
  assert.equal(plan.files.length, 3);
  assert.ok(plan.accounts.every(account => Math.abs(account.afterPercent - 94.2) < 1e-10));
  assert.ok(plan.accounts.every(account => account.requiredMB === 50 && account.freedMB === 58));
});

test('insufficient files identify the blocked backup and exact remaining space', async () => {
  const f = fixture();
  f.state.get(2).files.clear();
  await assert.rejects(f.service.preview(1, 7), error => {
    assert.equal(error.details.code, 'INSUFFICIENT_MODEL_FILES');
    assert.match(error.message, /Backup backup/);
    const backup = error.details.accounts.find(account => account.id === 2);
    assert.equal(backup.scannedFiles, 0); assert.equal(backup.remainingMB, 50);
    assert.equal(error.details.accounts.find(account => account.id === 1).remainingMB, 0);
    return true;
  });
  assert.equal(f.calls.deleted.length, 0);
});

test('only saturated accounts determine how much must be freed', async () => {
  const f = fixture({ sizes: [80, 40] });
  f.state.get(1).usedMB = 700;
  const plan = await f.service.preview(2, 7);
  assert.equal(plan.files.length, 1);
  assert.equal(plan.accounts.find(account => account.id === 1).requiredMB, 0);
  assert.equal(plan.accounts.find(account => account.id === 2).afterPercent, 92);
});

test('real files without a catalogue association are previewed and matched across Main and Backup', async () => {
  const f = fixture({ sizes: [] });
  for (const account of f.accounts) f.state.get(account.id).unmatchedFiles = [{
    relativePath: 'old-folder/model.zip', path: '/STLHUB/old-folder/model.zip',
    sizeMB: 65, handle: `H:${account.id}ABCDEFG`, versions: '1', modifiedAt: '2026-11-14T12:00:00',
  }];
  f.deps.deleteFile = async (account, file) => {
    f.calls.deleted.push([account.id, file.handle]);
    f.state.get(account.id).usedMB -= file.sizeMB;
    f.state.get(account.id).unmatchedFiles = [];
  };
  const plan = await f.service.preview(1, 7);
  assert.equal(plan.files.length, 1); assert.equal(plan.files[0].catalogued, false);
  assert.equal(plan.files[0].relativePath, 'old-folder/model.zip');
  assert.equal(plan.files[0].copies.filter(copy => !copy.missing).length, 2);
  assert.equal(f.calls.deleted.length, 0);
  const report = await f.service.execute(1, 7, plan.planId, true);
  assert.equal(report.ok, true); assert.equal(f.calls.deleted.length, 2);
  assert.equal(f.calls.withdrawn.length, 0);
});

test('changed unassociated files invalidate approval before deletion', async () => {
  const f = fixture();
  f.state.get(1).unmatchedFiles = [{ relativePath: 'old/model.zip', path: '/STLHUB/old/model.zip', sizeMB: 150, handle: 'H:ABCDEFGH', versions: '1' }];
  const plan = await f.service.preview(1, 7);
  f.state.get(1).unmatchedFiles[0].sizeMB++;
  await assert.rejects(f.service.execute(1, 7, plan.planId, true), { status: 409 });
  assert.equal(f.calls.deleted.length, 0); assert.equal(f.calls.withdrawn.length, 0);
});

test('unreadable inventory names the account instead of saying files are insufficient', async () => {
  const f = fixture();
  f.deps.inspectAccount = async account => { if (account.id === 2) throw new Error('Unexpected output'); return structuredClone(f.state.get(account.id)); };
  await assert.rejects(f.service.preview(1, 7), error => {
    assert.equal(error.details.code, 'ACCOUNT_INSPECTION_FAILED'); assert.equal(error.details.accountId, 2);
    assert.match(error.message, /Backup backup/); assert.doesNotMatch(error.message, /insuficientes/); return true;
  });
  assert.equal(f.calls.deleted.length, 0);
});

test('protected copies cannot satisfy a deficit or enter an approved deletion', async () => {
  const f = fixture({ sizes: [10] });
  f.state.get(2).protectedFiles = [{ sizeMB: 800, handle: 'H:PROTECT1', path: '/STLHUB/other/file.zip' }];
  await assert.rejects(f.service.preview(1, 7), error => {
    const backup = error.details.accounts.find(account => account.id === 2);
    assert.equal(backup.protectedFiles, 1); assert.equal(backup.availableMB, 10);
    assert.equal(backup.remainingMB, 40); return true;
  });
  assert.equal(f.calls.deleted.length, 0);
});
