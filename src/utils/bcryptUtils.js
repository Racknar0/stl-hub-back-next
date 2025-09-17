import bcrypt from 'bcrypt';

// Función para encriptar una contraseña
export const hashPassword = async (password) => {
    return await bcrypt.hash(password, 10);
};

// Función para comparar una contraseña en texto plano con el hash almacenado
export const comparePassword = async (plainPassword, hashedPassword) => {
    return await bcrypt.compare(plainPassword, hashedPassword);
  };
  