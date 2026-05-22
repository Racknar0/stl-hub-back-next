import { PrismaClient } from '@prisma/client';
import pinterestPublisherService from './pinterestPublisher.service.js';

const prisma = new PrismaClient();
let isProcessing = false;

class PinterestWorkerService {
  constructor() {
    this.intervalId = null;
  }

  start(intervalMs = 60000) { // Por defecto cada 1 minuto
    if (this.intervalId) return;
    
    console.log('[Pinterest Worker] Iniciando cron job de automatización...');
    this.intervalId = setInterval(() => this.processQueue(), intervalMs);
    
    // Procesar inmediatamente al arrancar
    this.processQueue();
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log('[Pinterest Worker] Cron job detenido.');
    }
  }

  async processQueue() {
    if (isProcessing) return;
    isProcessing = true;

    try {
      const now = new Date();
      
      // Buscar pines PENDING que ya deberían publicarse (scheduledAt <= ahora)
      const pendingPins = await prisma.pinterestPinQueue.findMany({
        where: {
          status: 'PENDING',
          scheduledAt: { lte: now }
        },
        orderBy: { scheduledAt: 'asc' },
        take: 3 // Procesamos máximo 3 por ciclo para no saturar la API
      });

      if (pendingPins.length > 0) {
        console.log(`[Pinterest Worker] Procesando ${pendingPins.length} pines encolados...`);
      }

      for (const pin of pendingPins) {
        try {
          // Extraer URL de la imagen (la guardamos en filters para el ejemplo)
          const filters = pin.filters || {};
          const imageUrl = filters.imageUrl;
          
          if (!imageUrl) throw new Error('No hay imageUrl en los filtros.');

          // Publicar usando el Publisher Service (it downloads the image internally)
          console.log(`[Pinterest Worker] Publicando Pin ID ${pin.id} (Asset ${pin.assetId})...`);
          
          const result = await pinterestPublisherService.publishPin(
            imageUrl,
            (pin.boardId === 'Automático' || pin.boardId === 'auto') ? null : pin.boardId,
            pin.title,
            pin.description,
            pin.link,
            filters,
            pin.assetId
          );

          // Actualizar DB a PUBLISHED
          await prisma.pinterestPinQueue.update({
            where: { id: pin.id },
            data: {
              status: 'PUBLISHED',
              publishedPinId: result.id
            }
          });
          
          console.log(`[Pinterest Worker] ✅ Pin ${pin.id} publicado con éxito (Pinterest ID: ${result.id})`);

        } catch (error) {
          console.error(`[Pinterest Worker] ❌ Error publicando Pin ${pin.id}:`, error.message);
          
          // Actualizar DB a FAILED
          await prisma.pinterestPinQueue.update({
            where: { id: pin.id },
            data: {
              status: 'FAILED',
              errorMessage: error.message
            }
          });

          // Crear notificación de error interna en la BD
          try {
            await prisma.notification.create({
              data: {
                title: `Error publicando Pin #${pin.id} (Asset #${pin.assetId})`,
                body: `Ocurrió un error al intentar publicar automáticamente el Pin en Pinterest.\n\nError: ${error.message}\n\nTítulo del Pin: ${pin.title || 'Sin título'}\n\nEnlace: ${pin.link || 'Sin enlace'}`,
                status: 'UNREAD',
                type: 'AUTOMATION',
                typeStatus: 'ERROR'
              }
            });
          } catch (notifErr) {
            console.error('[Pinterest Worker] No se pudo crear la notificación en la BD:', notifErr.message);
          }
        }
      }
    } catch (error) {
      console.error('[Pinterest Worker] Error general en el procesador:', error);
    } finally {
      isProcessing = false;
    }
  }
}

export default new PinterestWorkerService();
