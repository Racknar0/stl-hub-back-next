import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import {
  megaCmdWithProgressAndStall,
  megaGetWithStallRetry,
  megaPutWithStallRetry,
} from '../src/utils/megaTransfer.js';

function fakeMega(t, { enabled = false, failEnable = false } = {}) {
  const state = { enabled, calls: [] };
  t.mock.method(childProcess, 'spawn', (command, args) => {
    state.calls.push({ command, args: [...args] });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write() {} };
    child.kill = () => true;
    queueMicrotask(() => {
      if (command === 'mega-https') {
        if (args[0] === 'on') {
          if (failEnable) {
            child.stderr.emit('data', Buffer.from('Unable to configure transport'));
            child.emit('close', 1);
            return;
          }
          state.enabled = true;
          child.stdout.emit('data', Buffer.from('File transfer now uses HTTPS\n'));
        } else {
          child.stdout.emit('data', Buffer.from(`File transfer is done using ${state.enabled ? 'HTTPS' : 'HTTP'}\n`));
        }
      } else if (command === 'mega-put' || command === 'mega-get') {
        assert.equal(state.enabled, true, 'payload must never start while HTTP is active');
        child.stdout.emit('data', Buffer.from('100%\n'));
      }
      child.emit('close', 0);
    });
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return state;
}

for (const command of ['mega-put', 'mega-get']) {
  test(`${command} repairs HTTP and verifies HTTPS before spawning the payload`, async (t) => {
    const state = fakeMega(t);
    const result = await megaCmdWithProgressAndStall({ cmd: command, args: ['source', 'destination'] });
    assert.equal(result.code, 0);
    assert.deepEqual(state.calls.map(c => [c.command, c.args]), [
      ['mega-https', []],
      ['mega-https', ['on']],
      ['mega-https', []],
      [command, ['source', 'destination']],
    ]);
  });
}

test('a reset after an earlier successful transfer is repaired before the next payload', async (t) => {
  const state = fakeMega(t);
  await megaCmdWithProgressAndStall({ cmd: 'mega-put', args: ['first', 'folder'] });
  state.enabled = false; // MEGAcmd logout or daemon restart.
  await megaCmdWithProgressAndStall({ cmd: 'mega-get', args: ['remote', 'local'] });
  assert.equal(state.calls.filter(c => c.command === 'mega-https' && c.args[0] === 'on').length, 2);
});

for (const direction of ['upload', 'download']) {
  test(`${direction} does not start or rotate credentials/proxies if HTTPS cannot be enabled`, async (t) => {
    const state = fakeMega(t, { failEnable: true });
    const options = {
      ctx: 'test-transfer',
      account: { id: 1 },
      getProxyIndex: () => 0,
      setProxyIndex: () => assert.fail('transport configuration must not rotate the proxy'),
      relogin: () => assert.fail('transport configuration must not trigger another login'),
    };
    const operation = direction === 'upload'
      ? megaPutWithStallRetry({ ...options, localPath: 'local', remoteFolderOrFile: 'remote' })
      : megaGetWithStallRetry({ ...options, remoteFile: 'remote', destLocal: 'local' });
    await assert.rejects(operation, error => error.code === 'MEGA_HTTPS_REQUIRED');
    assert.deepEqual(state.calls.map(c => c.command), ['mega-https', 'mega-https']);
    assert.equal(state.calls.some(c => c.command === 'mega-put' || c.command === 'mega-get'), false);
  });
}

test('non-transfer commands do not change the session transport', async (t) => {
  const state = fakeMega(t);
  await megaCmdWithProgressAndStall({ cmd: 'mega-ls', args: ['folder'] });
  assert.deepEqual(state.calls, [{ command: 'mega-ls', args: ['folder'] }]);
  assert.equal(state.enabled, false);
});
