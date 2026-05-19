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

// 4. Agregar Pines a la Cola (Schedule)
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

router.post('/schedule', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { 
      assetId, 
      scheduledAt, 
      boardId, 
      title, 
      description, 
      link, 
      filters, 
      images 
    } = req.body;

    if (!assetId || !images || images.length === 0 || !scheduledAt) {
      return res.status(400).json({ error: 'Faltan datos obligatorios para programar (assetId, images, scheduledAt).' });
    }

    // Convertir a Date
    const baseScheduleDate = new Date(scheduledAt);

    const queuedPins = [];
    
    // Si hay multiples imagenes, generamos un pin para cada una esparcido en el tiempo (ej. cada 1 hora)
    for (let i = 0; i < images.length; i++) {
      const imgUrl = images[i];
      // Si hay más de una foto, programamos con 45 minutos de diferencia para humanizar
      const pinDate = new Date(baseScheduleDate.getTime() + (i * 45 * 60000));
      
      const newPin = await prisma.pinterestPinQueue.create({
        data: {
          assetId: Number(assetId),
          scheduledAt: pinDate,
          status: 'PENDING',
          boardId: boardId || 'Automático', // El worker lo procesará si es automático
          title: title,
          description: description,
          link: link,
          // Pasamos la URL de la imagen específica dentro de filters u otro lugar
          filters: { ...filters, imageUrl: imgUrl }
        }
      });
      queuedPins.push(newPin);
    }

    res.json({ success: true, queued: queuedPins.length, data: queuedPins });
  } catch (error) {
    console.error('Error scheduling Pinterest pins:', error);
    res.status(500).json({ error: 'Ocurrió un error al encolar los pines.' });
  }
});

export default router;
