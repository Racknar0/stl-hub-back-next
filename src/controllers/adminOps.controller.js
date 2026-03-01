export const restartBackend = async (req, res) => {
  const confirm = req.body?.confirm;
  if (confirm !== true) {
    return res.status(400).json({ message: 'Missing confirm=true' });
  }

  const requiredToken = process.env.ADMIN_RESTART_TOKEN;
  if (requiredToken) {
    const got = String(req.headers['x-admin-restart-token'] || req.body?.token || '');
    if (!got || got !== String(requiredToken)) {
      return res.status(403).json({ message: 'Forbidden' });
    }
  }

  const delayMsRaw = process.env.ADMIN_RESTART_DELAY_MS;
  const delayMs = Number.isFinite(Number(delayMsRaw)) ? Number(delayMsRaw) : 750;
  const requestedBy = req.user?.id ? String(req.user.id) : 'unknown';

  // Responder antes de salir del proceso para que el frontend reciba OK.
  res.status(202).json({ ok: true, message: `Restart scheduled in ${delayMs}ms`, requestedBy });

  // Dar tiempo a que la respuesta se envíe. PM2 debería relanzar el proceso.
  setTimeout(() => {
    try {
      // eslint-disable-next-line no-console
      console.log(`[ADMIN_OPS] Restart requested by userId=${requestedBy}. Exiting with code 0...`);
    } finally {
      process.exit(0);
    }
  }, delayMs);
};
