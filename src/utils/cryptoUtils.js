import * as crypto from 'crypto';

// Función para generar un token aleatorio (útil para verificación o reseteo de contraseña)
export const generateRandomToken = (size = 32) => {
    return crypto.randomBytes(size).toString('hex');
  };