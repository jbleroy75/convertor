'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const C = require('../public/js/crypto.js');
const { startServer } = require('./helpers');

let srv;
test.before(async () => (srv = await startServer()));
test.after(() => srv.close());

const json = (body, headers = {}) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

/** Simule le navigateur expéditeur. */
async function upload(data, { password, maxDownloads = 5, expiresIn = 3600 } = {}) {
  const secret = C.randomBytes(32);
  const hkdfSalt = C.randomBytes(16);
  const pwSalt = password ? C.randomBytes(16) : null;
  const pwIter = password ? 100_000 : 0;
  const keys = await C.deriveKeys({ secret, hkdfSalt, password, pwSalt, pwIter });
  const res = await fetch(
    `${srv.base}/api/transfers`,
    json({
      v: 1, expiresIn, maxDownloads, hkdfSalt: C.b64urlEncode(hkdfSalt), hasPassword: !!password,
      pwSalt: pwSalt && C.b64urlEncode(pwSalt), pwIter, authHash: C.b64urlEncode(await C.sha256(keys.authToken)),
    })
  );
  assert.equal(res.status, 201);
  const { id, ownerToken } = await res.json();
  const auth = { Authorization: `Bearer ${ownerToken}` };
  const n = Math.max(1, Math.ceil(data.length / C.CHUNK_BYTES));
  for (let i = 0; i < n; i++) {
    const body = await C.encryptChunk(keys.fileKey, i, i === n - 1, data.subarray(i * C.CHUNK_BYTES, (i + 1) * C.CHUNK_BYTES));
    const r = await fetch(`${srv.base}/api/transfers/${id}/chunks/${i}`, { method: 'PUT', headers: auth, body });
    assert.equal(r.status, 204, await r.text());
  }
  const encMeta = C.b64urlEncode(await C.encryptMeta(keys.metaKey, { name: 'test.bin', size: data.length }));
  const done = await fetch(`${srv.base}/api/transfers/${id}/complete`, json({ chunkCount: n, encMeta }, auth));
  assert.equal(done.status, 200, await done.clone().text());
  return { id, ownerToken, secret, auth };
}

/** Simule le navigateur destinataire. */
async function download(id, secret, password) {
  const p = await (await fetch(`${srv.base}/api/transfers/${id}/params`)).json();
  const keys = await C.deriveKeys({
    secret, hkdfSalt: C.b64urlDecode(p.hkdfSalt), password,
    pwSalt: p.pwSalt && C.b64urlDecode(p.pwSalt), pwIter: p.pwIter,
  });
  const headers = { 'X-Auth': C.b64urlEncode(keys.authToken) };
  const openRes = await fetch(`${srv.base}/api/transfers/${id}/open`, { method: 'POST', headers });
  if (!openRes.ok) return { status: openRes.status, body: await openRes.json() };
  const opened = await openRes.json();
  const meta = await C.decryptMeta(keys.metaKey, C.b64urlDecode(opened.encMeta));
  const { ticket } = await (await fetch(`${srv.base}/api/transfers/${id}/claim`, { method: 'POST', headers })).json();
  const parts = [];
  for (let i = 0; i < opened.chunkCount; i++) {
    const r = await fetch(`${srv.base}/api/transfers/${id}/chunks/${i}`, { headers: { 'X-Ticket': ticket } });
    assert.equal(r.status, 200);
    parts.push(await C.decryptChunk(keys.fileKey, i, i === opened.chunkCount - 1, new Uint8Array(await r.arrayBuffer())));
  }
  return { status: 200, meta, data: Buffer.concat(parts) };
}

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

test('aller-retour multi-blocs (2 blocs pleins + 1 partiel)', { timeout: 60_000 }, async () => {
  const data = crypto.randomBytes(2 * C.CHUNK_BYTES + 12345);
  const { id, secret } = await upload(data);
  const out = await download(id, secret);
  assert.equal(out.status, 200);
  assert.equal(out.meta.name, 'test.bin');
  assert.equal(sha(out.data), sha(data));
});

test('fichier vide', async () => {
  const { id, secret } = await upload(Buffer.alloc(0));
  const out = await download(id, secret);
  assert.equal(out.data.length, 0);
});

test('le serveur ne stocke jamais le clair', async () => {
  const data = Buffer.from('DONNEES-ULTRA-CONFIDENTIELLES '.repeat(100));
  const { id } = await upload(data);
  const fs = require('fs');
  const dir = srv.store.dir(id);
  for (const f of fs.readdirSync(dir)) {
    const content = fs.readFileSync(`${dir}/${f}`);
    assert.ok(!content.includes('CONFIDENTIELLES'), `${f} contient du clair`);
    assert.ok(!content.includes('test.bin'), `${f} contient le nom du fichier`);
  }
});

test('mot de passe : obligatoire, et transfert détruit après 10 échecs', async () => {
  const data = crypto.randomBytes(1000);
  const { id, secret } = await upload(data, { password: 'S3cret-pass' });
  const ok = await download(id, secret, 'S3cret-pass');
  assert.equal(sha(ok.data), sha(data));

  const noPw = await download(id, secret);
  assert.equal(noPw.status, 403);
  for (let i = 0; i < 8; i++) assert.equal((await download(id, secret, 'mauvais')).status, 403);
  assert.equal((await download(id, secret, 'mauvais')).status, 410);
  assert.equal((await fetch(`${srv.base}/api/transfers/${id}/params`)).status, 404);
});

test('mauvaise clé de lien : accès refusé aux blocs chiffrés', async () => {
  const { id } = await upload(crypto.randomBytes(100));
  const out = await download(id, C.randomBytes(32));
  assert.equal(out.status, 403);
  // Sans ticket, impossible de lire un bloc.
  assert.equal((await fetch(`${srv.base}/api/transfers/${id}/chunks/0`)).status, 404);
  assert.equal((await fetch(`${srv.base}/api/transfers/${id}/chunks/0`, { headers: { 'X-Ticket': 'x'.repeat(32) } })).status, 404);
});

test('autodestruction après le nombre de téléchargements', async () => {
  const data = crypto.randomBytes(5000);
  const { id, secret } = await upload(data, { maxDownloads: 1 });
  assert.equal(sha((await download(id, secret)).data), sha(data));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await fetch(`${srv.base}/api/transfers/${id}/params`)).status, 404);
  assert.equal(srv.store.get(id), null);
});

test('suppression par le propriétaire uniquement', async () => {
  const { id, auth } = await upload(crypto.randomBytes(10));
  const bad = await fetch(`${srv.base}/api/transfers/${id}`, { method: 'DELETE', headers: { Authorization: 'Bearer AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' } });
  assert.equal(bad.status, 404);
  const s = await (await fetch(`${srv.base}/api/transfers/${id}/status`, { headers: auth })).json();
  assert.equal(s.downloads, 0);
  assert.equal((await fetch(`${srv.base}/api/transfers/${id}`, { method: 'DELETE', headers: auth })).status, 204);
  assert.equal((await fetch(`${srv.base}/api/transfers/${id}/params`)).status, 404);
});

test('validation : blocs incomplets, trop gros, paramètres invalides', async () => {
  const bad = await fetch(`${srv.base}/api/transfers`, json({ v: 1, expiresIn: 999, maxDownloads: 5 }));
  assert.equal(bad.status, 400);

  const keys = await C.deriveKeys({ secret: C.randomBytes(32), hkdfSalt: C.randomBytes(16) });
  const created = await (
    await fetch(`${srv.base}/api/transfers`, json({ v: 1, expiresIn: 3600, maxDownloads: 1, hkdfSalt: C.b64urlEncode(C.randomBytes(16)), authHash: C.b64urlEncode(await C.sha256(keys.authToken)) }))
  ).json();
  const auth = { Authorization: `Bearer ${created.ownerToken}` };
  // Bloc 0 non plein suivi d'un bloc 1 : refusé à la finalisation.
  await fetch(`${srv.base}/api/transfers/${created.id}/chunks/0`, { method: 'PUT', headers: auth, body: new Uint8Array(100) });
  await fetch(`${srv.base}/api/transfers/${created.id}/chunks/1`, { method: 'PUT', headers: auth, body: new Uint8Array(100) });
  const meta = C.b64urlEncode(new Uint8Array(32));
  assert.equal((await fetch(`${srv.base}/api/transfers/${created.id}/complete`, json({ chunkCount: 2, encMeta: meta }, auth))).status, 400);
  assert.equal((await fetch(`${srv.base}/api/transfers/${created.id}/complete`, json({ chunkCount: 3, encMeta: meta }, auth))).status, 400);
  // Bloc trop gros.
  const big = await fetch(`${srv.base}/api/transfers/${created.id}/chunks/2`, { method: 'PUT', headers: auth, body: new Uint8Array(C.CHUNK_BYTES + 17) });
  assert.equal(big.status, 413);
  // Non finalisé => invisible pour les destinataires.
  assert.equal((await fetch(`${srv.base}/api/transfers/${created.id}/params`)).status, 404);
});

test('envoi de blocs en parallèle (comme le navigateur)', { timeout: 60_000 }, async () => {
  const data = crypto.randomBytes(5 * C.CHUNK_BYTES + 99);
  const secret = C.randomBytes(32);
  const hkdfSalt = C.randomBytes(16);
  const keys = await C.deriveKeys({ secret, hkdfSalt });
  const created = await (
    await fetch(`${srv.base}/api/transfers`, json({ v: 1, expiresIn: 3600, maxDownloads: 5, hkdfSalt: C.b64urlEncode(hkdfSalt), authHash: C.b64urlEncode(await C.sha256(keys.authToken)) }))
  ).json();
  const auth = { Authorization: `Bearer ${created.ownerToken}` };
  const n = 6;
  const bodies = await Promise.all(
    Array.from({ length: n }, (_, i) => C.encryptChunk(keys.fileKey, i, i === n - 1, data.subarray(i * C.CHUNK_BYTES, (i + 1) * C.CHUNK_BYTES)))
  );
  const statuses = await Promise.all(bodies.map((body, i) => fetch(`${srv.base}/api/transfers/${created.id}/chunks/${i}`, { method: 'PUT', headers: auth, body }).then((r) => r.status)));
  assert.deepEqual(statuses, Array(n).fill(204));
  const encMeta = C.b64urlEncode(await C.encryptMeta(keys.metaKey, { name: 'p.bin', size: data.length }));
  assert.equal((await fetch(`${srv.base}/api/transfers/${created.id}/complete`, json({ chunkCount: n, encMeta }, auth))).status, 200);
  // L'état persisté sur disque doit contenir tous les blocs (pas un instantané périmé).
  const onDisk = JSON.parse(require('fs').readFileSync(srv.store.metaPath(created.id), 'utf8'));
  assert.equal(Object.keys(onDisk.chunks).length, n);
  assert.equal(onDisk.complete, true);
  assert.equal(sha((await download(created.id, secret)).data), sha(data));
});

test('la limite de taille porte sur les données en clair, pas sur le surcoût du chiffrement', () => {
  const { plaintextBytes } = require('../server/routes/transfers');
  assert.equal(plaintextBytes({ storedBytes: 2 * (C.CHUNK_BYTES + 16), chunks: { 0: 1, 1: 1 } }), 2 * C.CHUNK_BYTES);
});
