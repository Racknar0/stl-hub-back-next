import { Router } from 'express';
import { login, forgotPassword, resetPassword } from '../../controllers/auth.controller.js';

const router = Router();

// Inicio de sesión
router.post('/login', login);

// Recuperación de contraseña
router.post('/forgot-password', forgotPassword);

// Cambio de contraseña
router.post('/reset-password/:token', resetPassword);

export default router;