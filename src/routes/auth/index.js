import { Router } from 'express';
import { login, forgotPassword, resetPassword, registerUserSale, register, activateAccount } from '../../controllers/auth.controller.js';

const router = Router();

// Inicio de sesión
router.post('/login', login);

// Registro de usuario
router.post('/register', register);

// Activación de cuenta
router.post('/activate', activateAccount);

// Recuperación de contraseña
router.post('/forgot-password', forgotPassword);

// Cambio de contraseña
router.post('/reset-password', resetPassword);

// Registro por venta con suscripción
router.post('/register-sale', registerUserSale);

export default router;