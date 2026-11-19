/**
 * licenseCrypto.js — Seriales y licencias firmadas (Ed25519) del servidor de licencias.
 *
 *  - Seriales: 25 caracteres Crockford Base32 aleatorios (125 bits), formato XXXXX-XXXXX-XXXXX-XXXXX-XXXXX.
 *    En la base solo se guarda su SHA-256.
 *  - Licencias: JWT con alg "EdDSA" (Ed25519). La clave privada vive solo en el .env del servidor;
 *    los programas cliente llevan la clave pública para verificar la firma sin conexión.
 */
import crypto from 'crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford Base32 (sin I, L, O, U)
const SERIAL_LENGTH = 25;
export const LICENSE_ISSUER = 'stlhub-licenses';

// ─── Seriales ──────────────────────────────────────────────────────
export function generateSerial() {
  let raw = '';
  for (let i = 0; i < SERIAL_LENGTH; i++) raw += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return raw.match(/.{5}/g).join('-');
}

// Mayúsculas, sin guiones ni espacios, y las confusiones típicas de Crockford (O→0, I/L→1).
// Devuelve null si no tiene el formato de un serial.
export function normalizeSerial(input) {
  if (typeof input !== 'string') return null;
  const s = input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (s.length !== SERIAL_LENGTH) return null;
  for (const ch of s) if (!ALPHABET.includes(ch)) return null;
  return s;
}

export const hashSerial = (normalized) => crypto.createHash('sha256').update(normalized).digest('hex');

// Solo los últimos 4 caracteres: suficiente para reconocerlo, inútil para adivinarlo
export const maskSerial = (normalized) => `*****-*****-*****-*****-*${normalized.slice(-4)}`;

// ─── Claves Ed25519 ────────────────────────────────────────────────
let cachedKeys = null;
let cachedFrom = null;

// LICENSE_SIGNING_PRIVATE_KEY: clave privada PKCS#8 en DER y Base64 (una sola línea), o PEM con "\n".
export function loadSigningKeys(env = process.env) {
  const raw = (env.LICENSE_SIGNING_PRIVATE_KEY || '').trim();
  if (!raw) return null;
  const cacheKey = `${raw}|${env.LICENSE_SIGNING_KEY_ID || ''}`;
  if (cachedKeys && cachedFrom === cacheKey) return cachedKeys;
  const privateKey = raw.includes('BEGIN')
    ? crypto.createPrivateKey(raw.replace(/\\n/g, '\n'))
    : crypto.createPrivateKey({ key: Buffer.from(raw, 'base64'), format: 'der', type: 'pkcs8' });
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('LICENSE_SIGNING_PRIVATE_KEY no es una clave Ed25519');
  const publicKey = crypto.createPublicKey(privateKey);
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  cachedKeys = {
    kid: (env.LICENSE_SIGNING_KEY_ID || 'k1').trim(),
    privateKey,
    publicKey,
    publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    publicKeyRawBase64: spki.subarray(spki.length - 32).toString('base64'), // 32 bytes "crudos" de Ed25519
  };
  cachedFrom = cacheKey;
  return cachedKeys;
}

export function generateKeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  return {
    privateKeyBase64: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    publicKeyRawBase64: spki.subarray(spki.length - 32).toString('base64'),
  };
}

// ─── JWT EdDSA ─────────────────────────────────────────────────────
const b64url = (buf) => Buffer.from(buf).toString('base64url');
const fromB64urlJson = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

export function signLicense(payload, keys) {
  const header = { alg: 'EdDSA', typ: 'JWT', kid: keys.kid };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = crypto.sign(null, Buffer.from(signingInput), keys.privateKey);
  return `${signingInput}.${b64url(signature)}`;
}

// Comprueba formato y firma. NO comprueba el vencimiento: validate renueva también tokens vencidos.
// Devuelve el payload o null.
export function verifyLicense(token, keys) {
  if (typeof token !== 'string' || token.length > 4096) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const header = fromB64urlJson(parts[0]);
    if (header.alg !== 'EdDSA') return null;
    const ok = crypto.verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), keys.publicKey, Buffer.from(parts[2], 'base64url'));
    if (!ok) return null;
    const payload = fromB64urlJson(parts[1]);
    if (payload.iss !== LICENSE_ISSUER) return null;
    return payload;
  } catch {
    return null;
  }
}
