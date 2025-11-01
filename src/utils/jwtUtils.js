import jwt from 'jsonwebtoken';

// Función para generar un token JWT (para autenticación)
export const generateJWT = (payload, expiresIn = '7d') => {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn });
};
