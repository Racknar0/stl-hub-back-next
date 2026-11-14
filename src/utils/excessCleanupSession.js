// One runner belongs to one preview/execution under the global MEGA lock.
// MEGAcmd has one active account; this never keeps parallel account sessions.
const sessionError = (message, code, status = 503) => Object.assign(new Error(message), { code, status });
const proxyKey = proxy => {
  if (typeof proxy === 'string') return proxy;
  return proxy?.proxyUrl || proxy?.url || (proxy?.id !== undefined ? String(proxy.id) : null);
};

export function createCleanupSessionRunner({ listProxies, getProxyForAccount, applyProxy, login, logout, credentials }) {
  const successfulProxyByAccount = new Map();
  let active = null;
  let busy = false;
  let closed = false;

  const context = accountId => `excess-cleanup account=${accountId}`;
  const release = async () => {
    if (!active) return;
    const current = active;
    await logout(context(current.accountId));
    active = null;
  };

  async function candidates(account, accountId) {
    const available = await listProxies({ shuffle: false });
    if (!Array.isArray(available) || !available.length) throw sessionError('No hay un proxy MEGA disponible para validar esta cuenta.', 'EXCESS_CLEANUP_NO_PROXY');
    const byKey = new Map(available.map(proxy => [proxyKey(proxy), proxy]).filter(([key]) => key !== null));
    const result = new Map();
    const add = proxy => {
      const key = proxyKey(proxy);
      if (key !== null && byKey.has(key)) result.set(key, byKey.get(key));
    };
    const previousKey = successfulProxyByAccount.get(accountId);
    if (previousKey && byKey.has(previousKey)) add(byKey.get(previousKey));
    for (let attempt = 0; attempt < Math.min(3, available.length); attempt++) add(await getProxyForAccount(account, attempt));
    // Duplicate sticky selections must not prevent trying another available proxy.
    for (const proxy of available) add(proxy);
    return [...result.values()].slice(0, 3);
  }

  async function connect(account, accountId) {
    const proxies = await candidates(account, accountId);
    for (const proxy of proxies) {
      const key = proxyKey(proxy);
      let loginStarted = false;
      try {
        const applied = await applyProxy(proxy, { ctx: context(accountId), account });
        if (!applied?.enabled) continue;
        const payload = credentials ? await credentials(account) : undefined;
        loginStarted = true;
        active = { accountId, authenticated: false };
        await login(account, { ctx: context(accountId), proxy, credentials: payload });
        active = { accountId, authenticated: true };
        successfulProxyByAccount.set(accountId, key);
        return;
      } catch {
        if (successfulProxyByAccount.get(accountId) === key) successfulProxyByAccount.delete(accountId);
        if (loginStarted) {
          // A failed login can leave a partial session. Clean it before switching.
          // If logout itself fails, do not attempt another account/proxy blindly.
          await release();
        }
      }
    }
    throw sessionError(`No se pudo validar ${account.alias || `la cuenta #${accountId}`} mediante proxy. Reintenta más tarde.`, 'EXCESS_CLEANUP_LOGIN_FAILED');
  }

  return {
    async run(account, task) {
      if (closed) throw sessionError('La sesión de esta depuración ya terminó.', 'EXCESS_CLEANUP_SESSION_CLOSED', 409);
      if (busy) throw sessionError('Ya hay una operación en curso en esta sesión de depuración.', 'EXCESS_CLEANUP_SESSION_BUSY', 409);
      const accountId = Number(account?.id);
      if (!Number.isSafeInteger(accountId) || accountId <= 0 || typeof task !== 'function') throw sessionError('Cuenta u operación de depuración no válida.', 'EXCESS_CLEANUP_INVALID_OPERATION', 400);
      busy = true;
      try {
        if (active?.accountId !== accountId || !active.authenticated) {
          await release();
          await connect(account, accountId);
        }
        // Only login/proxy selection can retry. Never replay a file operation.
        return await task();
      } catch (error) {
        try { await release(); } catch { /* Preserve the operation's original failure. */ }
        throw error;
      } finally { busy = false; }
    },
    async close() {
      if (closed) return;
      if (busy) throw sessionError('La operación de depuración todavía está en curso.', 'EXCESS_CLEANUP_SESSION_BUSY', 409);
      try { await release(); }
      finally { closed = true; successfulProxyByAccount.clear(); }
    },
  };
}
