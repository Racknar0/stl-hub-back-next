import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectCleanupInventory, parseCleanupEntries, parseCleanupInventory } from '../src/utils/excessCleanupInventory.js';

const row = (name, handle = 'ABCDEFGH', size = 1048576) => `-ep- 1 ${size} 2026-11-14T12:00:00 H:${handle} ${name}`;
const header = 'FLAGS VERS SIZE DATE HANDLE NAME';

test('recursive MEGAcmd ls resolves root-relative headings and exact file metadata', () => {
  const listing = `${header}\nSTLHUB:\nd--- - - 2026-11-14T12:00:00 H:FOLDER01 model\n\nSTLHUB/model:\n${row('file with spaces.zip')}\n`;
  const result = inspectCleanupInventory(listing, '/STLHUB', [{ id: 1, slug: 'model', archiveName: 'model/file with spaces.zip' }]);
  assert.equal(result.files.size, 1);
  assert.deepEqual(result.files.get(1), { path: '/STLHUB/model/file with spaces.zip', relativePath: 'model/file with spaces.zip', handle: 'H:ABCDEFGH', sizeMB: 1, versions: '1', modifiedAt: '2026-11-14T12:00:00', missing: false });
  assert.equal(result.unmatchedFiles.length, 0);
});

test('real archive path and recorded replica folder remain usable after a slug changes', () => {
  const assets = [{ id: 1, slug: 'new-name', archiveName: 'old-name/file.zip', replicas: [{ accountId: 2, remotePath: '/STLHUB/backup-folder' }] }];
  assert.equal(inspectCleanupInventory(`STLHUB/old-name:\n${row('file.zip')}`, '/STLHUB', assets, 1).files.size, 1);
  assert.equal(inspectCleanupInventory(`STLHUB/backup-folder:\n${row('file.zip')}`, '/STLHUB', assets, 2).files.size, 1);
});

test('unmatched real files are returned with relative paths without guessing by basename', () => {
  const assets = [{ id: 1, slug: 'model', archiveName: 'file.zip' }];
  const result = inspectCleanupInventory(`STLHUB/unrelated:\n${row('file.zip')}`, '/STLHUB', assets);
  assert.equal(result.files.size, 0);
  assert.equal(result.unmatchedFiles[0].relativePath, 'unrelated/file.zip');
});

test('ls by exact file handle parses basename and preserves revision data for execution', () => {
  const entries = parseCleanupEntries(`${header}\n${row('a file.zip')}`);
  assert.equal(entries[0].path, 'a file.zip');
  assert.equal(entries[0].versions, '1');
  assert.equal(entries[0].sizeMB, 1);
});

test('unsupported find output fails instead of silently reporting zero files', () => {
  assert.throws(() => parseCleanupEntries('/STLHUB/model/file.zip <H:ABCDEFGH> (1048576)', '/STLHUB'), /formato recibido/);
  assert.throws(() => parseCleanupEntries('---- unrecognized file', '/STLHUB'), /formato recibido/);
});

test('duplicate handles and duplicate paths are rejected, while one model can own distinct folders', () => {
  assert.throws(() => parseCleanupEntries(`${row('/STLHUB/a.zip')}\n${row('/STLHUB/b.zip')}`, '/STLHUB'), /duplicados/);
  assert.throws(() => parseCleanupEntries(`${row('/STLHUB/a.zip')}\n${row('/STLHUB/a.zip', 'IJKLMNOP')}`, '/STLHUB'), /duplicados/);
  const assets = [{ id: 1, slug: 'new', archiveName: 'old/file.zip' }];
  const bundled = parseCleanupInventory(`${row('/STLHUB/old/file.zip')}\n${row('/STLHUB/new/file.zip', 'IJKLMNOP')}`, '/STLHUB', assets).get(1);
  assert.equal(bundled.path, '/STLHUB');
  assert.equal(bundled.relativePath, undefined);
  assert.equal(bundled.sizeMB, 2);
  assert.deepEqual(bundled.entries.map(entry => entry.handle), ['H:ABCDEFGH', 'H:IJKLMNOP']);
});

test('files and replica paths outside the configured base are rejected', () => {
  for (const heading of ['/elsewhere', '/STLHUB/../other', 'STLHUB/../other']) {
    assert.throws(() => parseCleanupEntries(`${heading}:\n${row('file.zip')}`, '/STLHUB'));
  }
  assert.throws(() => parseCleanupEntries(row('/STLHUB2/file.zip'), '/STLHUB'));
  assert.throws(() => parseCleanupEntries(`STLHUB/model:\n${row('../file.zip')}`, '/STLHUB'));
  assert.throws(() => inspectCleanupInventory(row('/STLHUB/model/file.zip'), '/STLHUB', [{ id: 1, slug: 'model', archiveName: 'file.zip', replicas: [{ accountId: 2, remotePath: '/other' }] }], 2));
});

test('empty folders are a valid empty inventory and fractional MB uses exact bytes', () => {
  assert.deepEqual(parseCleanupEntries(`${header}\nSTLHUB:\n`, '/STLHUB'), []);
  assert.equal(parseCleanupEntries(`:\n${row('file.zip')}`, '/')[0].path, '/file.zip');
  assert.equal(parseCleanupEntries(row('file.zip', 'ABCDEFGH', 1))[0].sizeMB, 1 / 1048576);
});

test('files assigned to another Main stay protected rather than becoming cleanup candidates', () => {
  const assets = [
    { id: 1, slug: 'allowed', archiveName: 'allowed/file.zip' },
    { id: 2, slug: 'foreign', archiveName: 'foreign/file.zip', cleanupProtected: true, replicas: [{ accountId: 3, remotePath: '/STLHUB/foreign-backup' }] },
  ];
  const listing = `${row('/STLHUB/allowed/file.zip')}\n${row('/STLHUB/foreign-backup/file.zip', 'IJKLMNOP')}\n${row('/STLHUB/unknown/file.zip', 'QRSTUVWX')}`;
  const inventory = inspectCleanupInventory(listing, '/STLHUB', assets, 3);
  assert.deepEqual([...inventory.files.keys()], [1]);
  assert.deepEqual(inventory.unmatchedFiles.map(file => file.relativePath), ['unknown/file.zip']);
  assert.deepEqual(inventory.protectedFiles.map(file => [file.assetId, file.relativePath]), [[2, 'foreign-backup/file.zip']]);
  assert.throws(() => inspectCleanupInventory(row('/STLHUB/allowed/file.zip'), '/STLHUB', [...assets, { id: 4, slug: 'allowed', archiveName: 'allowed/file.zip', cleanupProtected: true }], 3), /Dos modelos/);
});

test('original RAR archives and restore-prefixed ZIPs match the model by its unique direct folder', () => {
  const assets = [
    { id: 19546, slug: 'stl---ranni-pink', archiveName: 'stl---ranni-pink/stl---ranni-pink.zip' },
    { id: 20000, slug: 'general-buta', archiveName: 'general-buta/general-buta.zip' },
  ];
  const listing = `${row('/STLHUB/stl---ranni-pink/restore-19546-1783465219843-stl---ranni-pink.zip')}\n${row('/STLHUB/general-buta/General Buta original.rar', 'IJKLMNOP')}`;
  const result = inspectCleanupInventory(listing, '/STLHUB', assets, 1);
  assert.deepEqual([...result.files.keys()], [19546, 20000]);
  assert.equal(result.unmatchedFiles.length, 0);
  assert.equal(result.files.get(19546).handle, 'H:ABCDEFGH');
  assert.equal(result.files.get(20000).path, '/STLHUB/general-buta/General Buta original.rar');
});

test('renamed archives from protected model folders remain protected', () => {
  const assets = [{ id: 2, slug: 'foreign', archiveName: 'foreign/file.zip', cleanupProtected: true, replicas: [{ accountId: 3, remotePath: '/STLHUB/foreign-backup' }] }];
  const inventory = inspectCleanupInventory(row('/STLHUB/foreign-backup/original.rar'), '/STLHUB', assets, 3);
  assert.equal(inventory.files.size, 0);
  assert.equal(inventory.unmatchedFiles.length, 0);
  assert.equal(inventory.protectedFiles[0].assetId, 2);
});

test('shared model folders abort but multiple archives in one unique model folder are bundled', () => {
  const assets = [
    { id: 1, slug: 'first', archiveName: 'shared/first.zip' },
    { id: 2, slug: 'second', archiveName: 'shared/second.zip' },
  ];
  assert.throws(() => inspectCleanupInventory(row('/STLHUB/shared/original.rar'), '/STLHUB', assets), /comparten una carpeta/);
  const bundled = inspectCleanupInventory(`${row('/STLHUB/first/first.zip')}\n${row('/STLHUB/first/restore-first.zip', 'IJKLMNOP', 2097152)}`, '/STLHUB', [assets[0]]);
  const file = bundled.files.get(1);
  assert.equal(file.sizeMB, 3);
  assert.equal(file.path, '/STLHUB/first');
  assert.equal(file.relativePath, 'first');
  assert.equal(file.missing, false);
  assert.equal(file.handle, undefined);
  assert.deepEqual(file.entries.map(entry => [entry.path, entry.handle, entry.sizeMB]), [
    ['/STLHUB/first/first.zip', 'H:ABCDEFGH', 1],
    ['/STLHUB/first/restore-first.zip', 'H:IJKLMNOP', 2],
  ]);
  assert.equal(bundled.unmatchedFiles.length, 0);
  const nested = inspectCleanupInventory(row('/STLHUB/first/subfolder/other.rar'), '/STLHUB', [assets[0]]);
  assert.equal(nested.files.size, 0);
  assert.equal(nested.unmatchedFiles.length, 1);
});

test('all restored and original files of a protected model remain protected individually', () => {
  const listing = `${row('/STLHUB/foreign/restore-file.zip')}\n${row('/STLHUB/foreign/original.rar', 'IJKLMNOP')}`;
  const result = inspectCleanupInventory(listing, '/STLHUB', [{ id: 2, slug: 'foreign', archiveName: 'foreign/file.zip', cleanupProtected: true }]);
  assert.equal(result.files.size, 0);
  assert.equal(result.unmatchedFiles.length, 0);
  assert.equal(result.protectedFiles.length, 2);
  assert.deepEqual(result.protectedFiles.map(file => file.assetId), [2, 2]);
});
