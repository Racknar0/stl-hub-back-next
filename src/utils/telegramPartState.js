import fs from 'fs';

// Estado de una descarga paralela a medias de Telegram.
// Junto al archivo `.part` se guarda un `.part.json` con cuántos trozos (chunks) lleva cada worker,
// para poder retomar la descarga a mitad de archivo tras un reinicio del backend.

export const partStatePath = (tempPath) => `${tempPath}.json`;

// Bytes que cubre el trozo número `chunkIndex` (el último trozo del archivo puede ser más corto).
export function chunkBytes(chunkIndex, partSize, fileSizeBytes) {
    return Math.max(0, Math.min(partSize, fileSizeBytes - chunkIndex * partSize));
}

// Bytes ya descargados según los trozos hechos por cada worker (worker w descarga los trozos w, w+workers, ...).
export function bytesFromDone(done, partSize, fileSizeBytes) {
    const workers = done.length;
    let total = 0;
    for (let w = 0; w < workers; w++) {
        for (let k = 0; k < done[w]; k++) total += chunkBytes(w + k * workers, partSize, fileSizeBytes);
    }
    return total;
}

export function savePartState(tempPath, state) {
    const target = partStatePath(tempPath);
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
    fs.renameSync(tmp, target); // escritura atómica: nunca queda un JSON a medias
}

export function clearPartState(tempPath) {
    for (const p of [partStatePath(tempPath), `${partStatePath(tempPath)}.tmp`]) {
        try { fs.unlinkSync(p); } catch { /* no existe */ }
    }
}

// Devuelve los trozos hechos por worker si el estado guardado es válido para este mismo archivo, o null.
export function loadPartState(tempPath, { msgId, fileSizeBytes, partSize, workers }) {
    try {
        if (!fs.existsSync(tempPath)) return null;
        const state = JSON.parse(fs.readFileSync(partStatePath(tempPath), 'utf8'));
        if (
            Number(state.msgId) !== Number(msgId) ||
            Number(state.fileSizeBytes) !== Number(fileSizeBytes) ||
            Number(state.partSize) !== Number(partSize) ||
            Number(state.workers) !== Number(workers) ||
            !Array.isArray(state.done) || state.done.length !== workers
        ) return null;
        if (fs.statSync(tempPath).size !== fileSizeBytes) return null;

        const totalChunks = Math.ceil(fileSizeBytes / partSize);
        const done = state.done.map((n) => Number(n));
        for (let w = 0; w < workers; w++) {
            const max = w >= totalChunks ? 0 : Math.ceil((totalChunks - w) / workers);
            if (!Number.isInteger(done[w]) || done[w] < 0 || done[w] > max) return null;
        }
        return done;
    } catch {
        return null;
    }
}
