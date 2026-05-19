import express from 'express';
import { requireAuth, requireAdmin } from '../../middlewares/auth.js';
import pinterestService from '../../services/pinterest.service.js';

const router = express.Router();

// 1. Obtener URL de autorización (Protegido para uso oficial)
router.get('/auth', requireAuth, requireAdmin, (req, res) => {
  try {
    const authUrl = pinterestService.getAuthUrl();
    res.json({ url: authUrl });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// TEMPORAL: Ruta pública para que puedas enlazar tu cuenta AHORA MISMO
router.get('/auth-test', (req, res) => {
  try {
    const authUrl = pinterestService.getAuthUrl();
    // Redirige directamente al login de Pinterest
    res.redirect(authUrl);
  } catch (error) {
    res.status(500).send(error.message);
  }
});

// 2. Callback de Pinterest (A donde nos redirige después de dar permisos)
// IMPORTANTE: Esto debe coincidir con PINTEREST_REDIRECT_URI.
router.get('/callback', async (req, res) => {
  try {
    const { code, state, error } = req.query;

    if (error) {
      return res.status(400).send(`Error desde Pinterest: ${error}`);
    }

    if (!code) {
      return res.status(400).send('No se proporcionó un código de autorización.');
    }

    // Intercambiar código por tokens
    await pinterestService.exchangeCodeForToken(code);

    // Redirigir de vuelta al dashboard del frontend (puedes ajustar la URL del dashboard)
    res.send(`
      <html>
        <head><title>Pinterest Conectado</title></head>
        <body style="background-color: #09090b; color: #fff; font-family: sans-serif; text-align: center; padding-top: 50px;">
          <h2>¡Pinterest conectado con éxito!</h2>
          <p>Ya puedes cerrar esta ventana y volver al Dashboard.</p>
          <script>
            setTimeout(() => {
              window.close();
            }, 3000);
          </script>
        </body>
      </html>
    `);
  } catch (error) {
    console.error('Error en callback de Pinterest:', error);
    res.status(500).send('Hubo un error al conectar con Pinterest.');
  }
});

// 3. Probar conexión actual
router.get('/status', requireAuth, requireAdmin, async (req, res) => {
  try {
    const status = await pinterestService.testConnection();
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
