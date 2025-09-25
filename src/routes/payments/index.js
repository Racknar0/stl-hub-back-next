import express from 'express';
const router = express.Router();
import paypalRoutes from './paypal/index.js';


// Rutas de paypal
router.use('/paypal', paypalRoutes);

// Rutas de Stripe


export default router;