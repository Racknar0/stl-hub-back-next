import { Router } from 'express';
import { requireAuth, requireAdmin } from '../../middlewares/auth.js';
import { login, googleLogin, forgotPassword, resetPassword, registerUserSale, register, activateAccount, resendActivationEmail } from '../../controllers/auth.controller.js';

const router = Router();

// Inicio de sesión
router.post('/login', login);

// Registro de usuario
router.post('/register', register);

// Activación de cuenta
router.post('/activate', activateAccount);

// Autenticación con Google
router.post('/google', googleLogin);

// Recuperación de contraseña
router.post('/forgot-password', forgotPassword);

// Cambio de contraseña
router.post('/reset-password', resetPassword);

// Registro por venta con suscripción (solo admin: permite elegir rol y días de suscripción)
router.post('/register-sale', requireAuth, requireAdmin, registerUserSale);

// Reenviar email de activación
router.post('/resend-activation', resendActivationEmail);

export default router;