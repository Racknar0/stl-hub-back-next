import express from 'express';
const router = express.Router();
import paypalRoutes from './paypal/index.js';
import mercadoPagoRoutes from './mercadopago/index.js';


// Rutas de paypal
router.use('/paypal', paypalRoutes);

// Rutas de MercadoPago
router.use('/mercadopago', mercadoPagoRoutes);

// Rutas de Stripe


export default router;