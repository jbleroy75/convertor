/*
 * Service worker de téléchargement : récupère les blocs chiffrés, les déchiffre
 * à la volée et les écrit directement dans le fichier téléchargé par le
 * navigateur. Aucune limite de taille liée à la mémoire.
 */
importScripts('/js/crypto.js');

const C = self.ConvertorCrypto;
const pending = new Map();

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('message', (e) => {
  const msg = e.data || {};
  if (msg.type !== 'download' || !e.ports[0]) return;
  pending.set(msg.dlId, { ...msg, port: e.ports[0] });
  // Nettoyage si le téléchargement n'est jamais lancé.
  setTimeout(() => pending.delete(msg.dlId), 60000);
  e.ports[0].postMessage({ type: 'ready' });
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith('/__dl/')) return;
  const dlId = url.pathname.split('/')[2];
  const job = pending.get(dlId);
  if (!job) return e.respondWith(new Response('Téléchargement expiré, rechargez la page.', { status: 404 }));
  pending.delete(dlId);
  e.respondWith(streamResponse(job));
});

async function fetchChunk(job, index) {
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(`/api/transfers/${job.transferId}/chunks/${index}`, {
        headers: { 'X-Ticket': job.ticket },
        cache: 'no-store',
        credentials: 'omit',
      });
      if (res.status === 404) throw Object.assign(new Error('Transfert expiré ou supprimé'), { fatal: true });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return new Uint8Array(await res.arrayBuffer());
    } catch (err) {
      lastErr = err;
      if (err.fatal) break;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
  throw lastErr;
}

function streamResponse(job) {
  const { chunkCount, size, fileKey, port } = job;
  let index = 0;
  let written = 0;
  const PREFETCH = 3;
  const inflight = new Map();
  const ensure = (i) => {
    for (let k = i; k < Math.min(chunkCount, i + PREFETCH); k++) {
      if (!inflight.has(k)) inflight.set(k, fetchChunk(job, k));
    }
  };

  const stream = new ReadableStream({
    async pull(controller) {
      try {
        ensure(index);
        const cipher = await inflight.get(index);
        inflight.delete(index);
        const last = index === chunkCount - 1;
        const plain = await C.decryptChunk(fileKey, index, last, cipher);
        written += plain.length;
        if (plain.length) controller.enqueue(plain);
        port.postMessage({ type: 'progress', written, size });
        index++;
        if (last) {
          if (written !== size) throw new Error('Taille finale incohérente');
          port.postMessage({ type: 'done', written });
          controller.close();
        }
      } catch (err) {
        port.postMessage({ type: 'error', message: err.message });
        controller.error(err);
      }
    },
    cancel() {
      port.postMessage({ type: 'error', message: 'Téléchargement annulé' });
    },
  });

  const ascii = job.filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return new Response(stream, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(size),
      'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(job.filename)}`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    },
  });
}
