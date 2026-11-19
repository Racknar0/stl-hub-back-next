import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import telegramDownloaderService from '../src/services/telegramDownloader.service.js';
import { bytesFromDone, loadPartState, partStatePath } from '../src/utils/telegramPartState.js';

const PART = 512 * 1024;
const WORKERS = 4;
const SIZE = PART * 10 + 12345; // 11 trozos, el último más corto

const byteAt = (pos) => pos % 251;

// Cliente falso: reparte los trozos como iterDownload (offset, stride, limit) y anota los offsets pedidos.
function fakeClient(requested) {
  return {
    async *iterDownload({ offset, stride, chunkSize, limit }) {
      let pos = offset.toJSNumber();
      for (let i = 0; i < limit; i++) {
        requested.push(pos);
        const len = Math.min(chunkSize, SIZE - pos);
        const buf = Buffer.alloc(len);
        for (let j = 0; j < len; j++) buf[j] = byteAt(pos + j);
        yield buf;
        pos += Number(stride);
      }
    },
  };
}

const opts = (outputFile, extra = {}) => ({
  dcId: 1,
  fileSizeBytes: SIZE,
  outputFile,
  workers: WORKERS,
  partSizeKb: 512,
  msgId: 77,
  progressCallback: null,
  ...extra,
});

function assertFileContent(file) {
  const data = fs.readFileSync(file);
  assert.equal(data.length, SIZE);
  for (let pos = 0; pos < SIZE; pos += 4099) assert.equal(data[pos], byteAt(pos), `byte ${pos}`);
  assert.equal(data[SIZE - 1], byteAt(SIZE - 1));
}

test('una descarga interrumpida se retoma sin repetir los trozos ya bajados', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgresume-'));
  const out = path.join(dir, 'video.mp4.part');
  const svc = telegramDownloaderService;
  try {
    // 1ª pasada: se "apaga" el backend tras 5 trozos
    const first = [];
    const client1 = fakeClient(first);
    let chunks = 0;
    const origIter = client1.iterDownload;
    client1.iterDownload = async function* (o) {
      for await (const c of origIter.call(client1, o)) {
        yield c;
        if (++chunks === 5) svc.shouldCancel = true;
      }
    };
    svc.shouldCancel = false;
    await svc.parallelDownloadToFile(client1, {}, opts(out));
    svc.shouldCancel = false;

    const done = loadPartState(out, { msgId: 77, fileSizeBytes: SIZE, partSize: PART, workers: WORKERS });
    assert.ok(done, 'debe quedar avance guardado');
    const doneChunks = done.reduce((a, b) => a + b, 0);
    assert.ok(doneChunks >= 5 && doneChunks < 11);
    assert.ok(bytesFromDone(done, PART, SIZE) > 0);

    // 2ª pasada: retoma; solo debe pedir los trozos que faltan
    const second = [];
    await svc.parallelDownloadToFile(fakeClient(second), {}, opts(out, { resumeDone: done }));
    assert.equal(second.length, 11 - doneChunks);
    assert.equal(new Set(second).size, second.length);

    assertFileContent(out);
    assert.equal(fs.existsSync(partStatePath(out)), false, 'al terminar se borra el estado');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('el avance guardado se descarta si es de otro archivo o el .part no cuadra', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgresume-'));
  const out = path.join(dir, 'a.part');
  const svc = telegramDownloaderService;
  try {
    let chunks = 0;
    const requested = [];
    const client = fakeClient(requested);
    const orig = client.iterDownload;
    client.iterDownload = async function* (o) {
      for await (const c of orig.call(client, o)) {
        yield c;
        if (++chunks === 3) svc.shouldCancel = true;
      }
    };
    svc.shouldCancel = false;
    await svc.parallelDownloadToFile(client, {}, opts(out));
    svc.shouldCancel = false;

    const base = { fileSizeBytes: SIZE, partSize: PART, workers: WORKERS };
    assert.ok(loadPartState(out, { msgId: 77, ...base }));
    assert.equal(loadPartState(out, { msgId: 78, ...base }), null, 'otro mensaje');
    assert.equal(loadPartState(out, { msgId: 77, ...base, fileSizeBytes: SIZE + 1 }), null, 'otro tamaño');
    fs.truncateSync(out, 1000);
    assert.equal(loadPartState(out, { msgId: 77, ...base }), null, '.part truncado');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
