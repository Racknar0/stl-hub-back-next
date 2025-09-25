import { Router } from 'express'
import { createPayPalOrder, capturePayPalOrder } from '../../../controllers/paypal.controller.js';


const router = Router()

// Ruta para crear una orden de PayPal
router.post('/order', createPayPalOrder)

// Ruta para capturar una orden de PayPal
router.post('/capture', capturePayPalOrder)


export default router
