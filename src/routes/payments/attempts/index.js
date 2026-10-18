import { Router } from 'express';
import jwt from 'jsonwebtoken';
import {
  startPaymentAttempt,
  recordPaymentAttemptEvent,
  listPaymentAttempts,
} from '../../../controllers/paymentAttempts.controller.js';
import { requireAuth, requireAdmin } from '../../../middlewares/auth.js';

const router = Router();

// Sesión opcional: el seguimiento nunca responde 401, porque el front cierra la sesión ante un 401.
const optionalAuth = (req, _res, next) => {
  try {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (token) req.user = jwt.verify(token, process.env.JWT_SECRET || 'dev-secret');
  } catch {
    req.user = null;
  }
  next();
};

// El usuario eligió un método de pago (crea el intento)
router.post('/', optionalAuth, startPaymentAttempt);

// Pasos del intento que solo ve el navegador (cancelar, volver, errores del botón)
router.post('/:id/events', optionalAuth, recordPaymentAttemptEvent);

// Listado de intentos para el dashboard (solo admin)
router.get('/', requireAuth, requireAdmin, listPaymentAttempts);

export default router;
