import express from 'express';
const router = express.Router();
import paypalRoutes from './paypal/index.js';
import mercadoPagoRoutes from './mercadopago/index.js';
import attemptRoutes from './attempts/index.js';


// Rutas de paypal
router.use('/paypal', paypalRoutes);

// Rutas de MercadoPago
router.use('/mercadopago', mercadoPagoRoutes);

// Seguimiento de intentos de pago (todas las pasarelas)
router.use('/attempts', attemptRoutes);

// Rutas de Stripe


export default router;