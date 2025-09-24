import { Router } from 'express'
import { createPayPalOrder } from '../../../controllers/paypal.controller'


const router = Router()

// Ruta para crear una orden de PayPal
router.get('/order', createPayPalOrder)


export default router
