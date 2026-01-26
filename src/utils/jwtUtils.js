import jwt from 'jsonwebtoken';

// Función para generar un token JWT (para autenticación)
export const generateJWT = (payload, expiresIn = '7d') => {
  const options = {};
  // Si expiresIn es null/undefined/false, no agregamos "exp" (token sin vencimiento)
  if (expiresIn) options.expiresIn = expiresIn;
  return jwt.sign(payload, process.env.JWT_SECRET, options);
};
