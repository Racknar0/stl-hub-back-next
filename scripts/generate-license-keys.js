// Genera un par de claves Ed25519 para el servidor de licencias.
// Uso: node scripts/generate-license-keys.js
// La línea LICENSE_SIGNING_PRIVATE_KEY va al .env del servidor (secreta).
// La clave pública (PEM o Base64 cruda) va dentro de los programas cliente.
import { generateKeyPair } from '../src/utils/licenseCrypto.js';

const { privateKeyBase64, publicKeyPem, publicKeyRawBase64 } = generateKeyPair();
console.log('# ── .env del servidor (NO compartir) ──');
console.log('# Clave privada Ed25519 (PKCS#8 DER en Base64) con la que se firman las licencias');
console.log(`LICENSE_SIGNING_PRIVATE_KEY=${privateKeyBase64}`);
console.log('# Identificador de la clave (va en el campo "kid" de la licencia)');
console.log('LICENSE_SIGNING_KEY_ID=k1');
console.log('');
console.log('# ── Clave pública para los programas cliente ──');
console.log(publicKeyPem.trim());
console.log(`Base64 cruda (32 bytes): ${publicKeyRawBase64}`);
