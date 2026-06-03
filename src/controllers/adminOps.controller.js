import { transporter } from './nodeMailerController.js';

export const testEmail = async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ message: 'Email is required' });
  }

  try {
    const info = await transporter.sendMail({
      to: email,
      from: process.env.SMTP_EMAIL,
      subject: 'STL Hub - Test de configuración de correo (Nodemailer)',
      text: 'Este es un correo de prueba enviado desde el dashboard de STL Hub para validar la configuración de Nodemailer.',
      html: `
        <div style="font-family: sans-serif; padding: 20px; border: 1px solid #ddd; border-radius: 8px; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #4f46e5;">¡Configuración de correo correcta!</h2>
          <p>Este correo ha sido enviado con éxito desde tu panel de administración.</p>
          <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
          <p style="font-size: 12px; color: #777;">
            <strong>Servidor SMTP:</strong> ${process.env.SMTP_HOST || 'no definido'}<br>
            <strong>Puerto SMTP:</strong> ${process.env.SMTP_PORT || 'no definido'}<br>
            <strong>Usuario SMTP:</strong> ${process.env.EMAIL_USER || 'no definido'}
          </p>
        </div>
      `
    });

    return res.status(200).json({
      ok: true,
      message: 'Correo de prueba enviado con éxito.',
      messageId: info.messageId,
      response: info.response
    });
  } catch (error) {
    console.error('[ADMIN_OPS] Error sending test email:', error);
    return res.status(500).json({
      ok: false,
      message: 'Error al enviar el correo de prueba.',
      error: error.message || String(error)
    });
  }
};

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
