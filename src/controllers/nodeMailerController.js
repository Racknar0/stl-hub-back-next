import { fileURLToPath } from 'url';
import path from 'path';
import nodemailer from 'nodemailer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configurar el transporte de nodemailer
const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT, 10), // Asegúrate de que sea un número
    secure: false,
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
    },
    tls: {
        rejectUnauthorized: false  // Permitir conexiones no autorizadas
    }
});

// Configurar la imagen de firma del correo
const signatureImageProperties = {
    filename: 'imagen_firma_correo.png',
    path: path.join(__dirname, '../assets/imagen_firma_correo_black.png'),
    cid: 'firma_usuario@correo.com' // mismo valor que en el src del html
};
const signatureImageTag = `<img src="cid:${signatureImageProperties.cid}" style="width:175px"/>`;

export {
    transporter,
    // signatureImageProperties,
    // signatureImageTag,
};
