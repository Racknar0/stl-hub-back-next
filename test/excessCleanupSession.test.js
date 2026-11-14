import test from 'node:test';
import assert from 'node:assert/strict';
import { createCleanupSessionRunner } from '../src/utils/excessCleanupSession.js';

const account = id => ({ id, alias: `fixture-${id}` });
function fixture({ loginFails = () => false, proxyCount = 3, selectDuplicate = false } = {}) {
  let proxies = Array.from({ length: proxyCount }, (_, index) => ({ proxyUrl: `fixture-proxy-${index + 1}` }));
  let cliAccount = null;
  let credentialVersion = 0;
  const calls = { apply: [], login: [], logout: [], credentials: [], events: [] };
  const deps = {
    listProxies: () => proxies,
    getProxyForAccount: (item, attempt) => proxies[selectDuplicate ? 0 : attempt],
    applyProxy: async (proxy, options) => {
      calls.apply.push([options.account.id, proxy.proxyUrl]);
      calls.events.push(`proxy:${options.account.id}:${proxy.proxyUrl}`);
      return { enabled: true };
    },
    credentials: async item => {
      const result = { username: `fixture-user-${item.id}`, password: `fixture-only-${++credentialVersion}` };
      calls.credentials.push(result);
      return result;
    },
    login: async (item, options) => {
      assert.ok(options.credentials.password.startsWith('fixture-only-'));
      assert.equal(cliAccount, null, 'previous CLI session must be released before another login');
      calls.login.push([item.id, options.proxy.proxyUrl]);
      calls.events.push(`login:${item.id}`);
      // Simulate a login that may leave a partial session even on rejection.
      cliAccount = item.id;
      if (loginFails(item, options.proxy)) throw new Error('Fixture login unavailable');
    },
    logout: async ctx => { calls.logout.push(ctx); calls.events.push(`logout:${cliAccount}`); cliAccount = null; },
  };
  return { calls, deps, runner: createCleanupSessionRunner(deps), activeAccount: () => cliAccount, setProxies: next => { proxies = next; } };
}

test('consecutive files from one account share one login and one credential read', async () => {
  const f = fixture();
  assert.equal(await f.runner.run(account(1), async () => 'first'), 'first');
  assert.equal(await f.runner.run(account(1), async () => 'second'), 'second');
  assert.equal(f.calls.login.length, 1); assert.equal(f.calls.apply.length, 1);
  assert.equal(f.calls.credentials.length, 1); assert.equal(f.calls.logout.length, 0);
  assert.equal(f.activeAccount(), 1);
  await f.runner.close();
  assert.equal(f.calls.logout.length, 1); assert.equal(f.activeAccount(), null);
});

test('after switching accounts the last successful proxy is tried first', async () => {
  const f = fixture({ loginFails: (item, proxy) => item.id === 1 && proxy.proxyUrl === 'fixture-proxy-1' });
  await f.runner.run(account(1), async () => {});
  await f.runner.run(account(2), async () => {});
  await f.runner.run(account(1), async () => {});
  assert.deepEqual(f.calls.login, [
    [1, 'fixture-proxy-1'], [1, 'fixture-proxy-2'], [2, 'fixture-proxy-1'], [1, 'fixture-proxy-2'],
  ]);
  assert.equal(f.calls.credentials.length, 4);
  assert.notEqual(f.calls.credentials[1], f.calls.credentials[3], 'cleartext credentials are not cached');
  await f.runner.close();
  assert.equal(f.activeAccount(), null);
});

test('switching always logs out the current account before applying another proxy', async () => {
  const f = fixture();
  await f.runner.run(account(1), async () => { f.calls.events.push('file:1'); });
  await f.runner.run(account(2), async () => { f.calls.events.push('file:2'); });
  assert.deepEqual(f.calls.events, [
    'proxy:1:fixture-proxy-1', 'login:1', 'file:1', 'logout:1',
    'proxy:2:fixture-proxy-1', 'login:2', 'file:2',
  ]);
  await f.runner.close();
});

test('a destructive callback failure is never retried and releases its session', async () => {
  const f = fixture(); let deletionAttempts = 0;
  await assert.rejects(f.runner.run(account(1), async () => { deletionAttempts++; throw new Error('Delete rejected'); }), /Delete rejected/);
  assert.equal(deletionAttempts, 1); assert.equal(f.calls.login.length, 1);
  assert.equal(f.calls.logout.length, 1); assert.equal(f.activeAccount(), null);
  await f.runner.close(); assert.equal(f.calls.logout.length, 1);
});

test('failed logins release partial sessions and never run more than three unique proxies', async () => {
  const f = fixture({ loginFails: () => true, proxyCount: 5, selectDuplicate: true }); let fileCalls = 0;
  await assert.rejects(f.runner.run(account(1), async () => { fileCalls++; }), error => {
    assert.equal(error.code, 'EXCESS_CLEANUP_LOGIN_FAILED');
    assert.ok(!error.message.includes('fixture-only-')); return true;
  });
  assert.equal(fileCalls, 0); assert.equal(f.calls.login.length, 3);
  assert.equal(new Set(f.calls.login.map(([, proxy]) => proxy)).size, 3);
  assert.equal(f.calls.logout.length, 3); assert.equal(f.activeAccount(), null);
  await f.runner.close();
});

test('a remembered proxy removed from the available list is not reused', async () => {
  const f = fixture({ loginFails: (item, proxy) => item.id === 1 && proxy.proxyUrl === 'fixture-proxy-1' });
  await f.runner.run(account(1), async () => {});
  await f.runner.run(account(2), async () => {});
  f.setProxies([{ proxyUrl: 'fixture-proxy-3' }]);
  await f.runner.run(account(1), async () => {});
  assert.deepEqual(f.calls.login.at(-1), [1, 'fixture-proxy-3']);
  await f.runner.close();
});

test('disabled proxy application does not run login or the file callback on that proxy', async () => {
  const f = fixture();
  const apply = f.deps.applyProxy;
  f.deps.applyProxy = async (...args) => args[0].proxyUrl === 'fixture-proxy-1' ? { enabled: false } : apply(...args);
  const runner = createCleanupSessionRunner(f.deps);
  let fileCalls = 0;
  await runner.run(account(1), async () => { fileCalls++; });
  assert.equal(fileCalls, 1); assert.deepEqual(f.calls.login, [[1, 'fixture-proxy-2']]);
  await runner.close();
});

test('close is idempotent and a closed runner cannot execute another operation', async () => {
  const f = fixture(); await f.runner.run(account(1), async () => {});
  await f.runner.close(); await f.runner.close();
  assert.equal(f.calls.logout.length, 1);
  await assert.rejects(f.runner.run(account(1), () => assert.fail('unexpected callback')), { code: 'EXCESS_CLEANUP_SESSION_CLOSED' });
});

test('parallel calls and closing an active callback are rejected instead of mixing CLI sessions', async () => {
  const f = fixture(); let releaseTask;
  const pending = f.runner.run(account(1), () => new Promise(resolve => { releaseTask = resolve; }));
  while (!releaseTask) await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(f.runner.run(account(2), () => assert.fail('unexpected parallel callback')), { code: 'EXCESS_CLEANUP_SESSION_BUSY' });
  await assert.rejects(f.runner.close(), { code: 'EXCESS_CLEANUP_SESSION_BUSY' });
  releaseTask('done'); assert.equal(await pending, 'done');
  await f.runner.close(); assert.equal(f.calls.login.length, 1); assert.equal(f.activeAccount(), null);
});

test('cleanup failure preserves the original operation error and close retries the release', async () => {
  const f = fixture(); let logoutAttempts = 0;
  const originalLogout = f.deps.logout;
  f.deps.logout = async ctx => { if (++logoutAttempts === 1) throw new Error('Temporary logout failure'); return originalLogout(ctx); };
  const runner = createCleanupSessionRunner(f.deps);
  await assert.rejects(runner.run(account(1), async () => { throw new Error('Original delete error'); }), /Original delete error/);
  await runner.close();
  assert.equal(logoutAttempts, 2); assert.equal(f.activeAccount(), null);
});
