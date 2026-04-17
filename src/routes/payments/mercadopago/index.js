import { Router } from 'express';
import {
  createMercadoPagoPreference,
  captureMercadoPagoPayment,
  mercadoPagoWebhook,
} from '../../../controllers/mercadopago.controller.js';

const router = Router();

// Crear preferencia de checkout en MercadoPago
router.post('/preference', createMercadoPagoPreference);

// Confirmar y registrar un pago de MercadoPago (retorno desde frontend)
router.post('/capture', captureMercadoPagoPayment);

// Webhook para actualizaciones asíncronas de estado (PSE, efectivo, etc.)
router.post('/webhook', mercadoPagoWebhook);
router.get('/webhook', mercadoPagoWebhook);

export default router; 
