import * as crypto from 'crypto';

// Función para generar un token aleatorio (útil para verificación o reseteo de contraseña)
export const generateRandomToken = (size = 32) => {
    return crypto.randomBytes(size).toString('hex');
  };

// Clave derivada de variable de entorno
const getAesKey = () => {
  const secret = process.env.ACCOUNT_SECRET || process.env.JWT_SECRET || 'change-me';
  return crypto.createHash('sha256').update(secret).digest(); // 32 bytes
};

const ALGO = 'aes-256-gcm';

export const encryptBlob = (buf) => {
  const key = getAesKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(buf), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { enc, iv, tag };
};

export const decryptBlob = ({ enc, iv, tag }) => {
  const key = getAesKey();
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return dec;
};

export const encryptJson = (obj) => {
  const buf = Buffer.from(JSON.stringify(obj));
  const { enc, iv, tag } = encryptBlob(buf);
  return { encData: enc, encIv: iv, encTag: tag };
};

export const decryptToJson = (encData, encIv, encTag) => {
  const dec = decryptBlob({ enc: encData, iv: encIv, tag: encTag });
  return JSON.parse(dec.toString('utf8'));
};