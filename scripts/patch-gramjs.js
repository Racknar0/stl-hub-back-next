// Parche para GramJS (telegram): PromisedNetSockets.connect() crea un net.Socket nuevo
// sin destruir el anterior. Cuando un DC falla y GramJS reintenta en bucle, cada intento
// deja un socket huérfano en CLOSE-WAIT hasta agotar los puertos efímeros (EADDRNOTAVAIL).
// Se ejecuta en postinstall; es idempotente.
import fs from 'fs';
import path from 'path';

const file = path.join(process.cwd(), 'node_modules', 'telegram', 'extensions', 'PromisedNetSockets.js');
const MARKER = '/* patched: destroy previous socket */';
const TARGET = 'async connect(port, ip) {\n        this.stream = Buffer.alloc(0);';
const REPLACEMENT = `async connect(port, ip) {
        ${MARKER}
        if (this.client) {
            try { this.client.removeAllListeners(); this.client.destroy(); this.client.unref(); } catch (e) {}
            this.client = undefined;
        }
        this.stream = Buffer.alloc(0);`;

if (!fs.existsSync(file)) {
    console.warn('[patch-gramjs] No se encontró', file);
    process.exit(0);
}

const src = fs.readFileSync(file, 'utf8');
if (src.includes(MARKER)) {
    console.log('[patch-gramjs] Ya aplicado');
} else if (!src.includes(TARGET)) {
    console.warn('[patch-gramjs] No se encontró el bloque a parchear (¿cambió la versión de telegram?)');
} else {
    fs.writeFileSync(file, src.replace(TARGET, REPLACEMENT), 'utf8');
    console.log('[patch-gramjs] Aplicado');
}
