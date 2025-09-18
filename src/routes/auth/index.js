import { Router } from 'express';
import { login, forgotPassword, resetPassword, registerUserSale } from '../../controllers/auth.controller.js';

const router = Router();

// Inicio de sesión
router.post('/login', login);

// Recuperación de contraseña
router.post('/forgot-password', forgotPassword);

// Cambio de contraseña
router.post('/reset-password/:token', resetPassword);

// Registro por venta con suscripción
router.post('/register-sale', registerUserSale);

export default router;