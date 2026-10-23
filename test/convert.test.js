'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer, root, available, needs, sh: run } = require('./helpers');

const fx = path.join(root, 'fixtures');
fs.mkdirSync(fx, { recursive: true });
const sh = (cmd, args) => run(fx, cmd, args);

// Fichier dont le contenu est sans importance (conversions refusées avant tout outil).
fs.writeFileSync(path.join(fx, 'any.wav'), 'RIFF');

let srv;
test.before(async () => {
  // Fixtures produites seulement si l'outil est là ; les tests qui en dépendent sont sautés sinon.
  if (available('convert')) sh('convert', ['-size', '64x48', 'gradient:red-blue', 'img.png']);
  if (available('ffmpeg')) {
    sh('ffmpeg', ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', 'tone.wav']);
    sh('ffmpeg', ['-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10:duration=1', '-pix_fmt', 'yuv420p', 'clip.mp4']);
  }
  fs.writeFileSync(path.join(fx, 'doc.md'), '# Titre\n\nUn *paragraphe* avec des accents : été, garçon.\n');
  fs.writeFileSync(path.join(fx, 'data.json'), JSON.stringify([{ nom: 'Ada', age: 36 }, { nom: 'Alan', age: 41 }]));
  if (available('pandoc')) sh('pandoc', ['doc.md', '-o', 'doc.docx']);
  srv = await startServer();
});
// srv absent si la préparation a échoué : ne pas masquer l'erreur d'origine.
test.after(() => srv?.close());

async function convert(names, target, { zip = false } = {}) {
  const form = new FormData();
  form.append('target', target);
  form.append('zip', zip ? '1' : '0');
  for (const n of names) form.append('files', new Blob([fs.readFileSync(path.join(fx, n))]), n);
  const res = await fetch(`${srv.base}/api/convert`, { method: 'POST', body: form });
  return { res, buf: Buffer.from(await res.arrayBuffer()) };
}

const magic = {
  jpg: (b) => b[0] === 0xff && b[1] === 0xd8,
  png: (b) => b.subarray(1, 4).toString() === 'PNG',
  pdf: (b) => b.subarray(0, 4).toString() === '%PDF',
  zip: (b) => b.subarray(0, 2).toString() === 'PK',
  mp3: (b) => b.subarray(0, 3).toString() === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0),
  gif: (b) => b.subarray(0, 3).toString() === 'GIF',
  webp: (b) => b.subarray(8, 12).toString() === 'WEBP',
};

test('formats exposés', async () => {
  const r = await (await fetch(`${srv.base}/api/formats`)).json();
  assert.ok(r.formats.png.targets.includes('jpg'));
  assert.ok(r.formats.docx.targets.includes('pdf'));
  assert.ok(r.formats.mp4.targets.includes('mp3'));
});

for (const [file, target, check, tools] of [
  ['img.png', 'jpg', magic.jpg, ['convert']],
  ['img.png', 'webp', magic.webp, ['convert']],
  ['img.png', 'pdf', magic.pdf, ['convert', 'convert:pdf']],
  ['tone.wav', 'mp3', magic.mp3, ['ffmpeg']],
  ['clip.mp4', 'gif', magic.gif, ['ffmpeg']],
  ['doc.docx', 'pdf', magic.pdf, ['pandoc', 'soffice']],
  ['doc.md', 'pdf', magic.pdf, ['pandoc', 'soffice']],
  ['doc.md', 'docx', magic.zip, ['pandoc']],
  ['doc.docx', 'md', (b) => b.toString().startsWith('# Titre'), ['pandoc']],
]) {
  test(`conversion ${file} → ${target}`, { timeout: 120_000, ...needs(...tools) }, async () => {
    const { res, buf } = await convert([file], target);
    assert.equal(res.status, 200, buf.toString().slice(0, 300));
    assert.ok(check(buf), `signature ${target} attendue`);
    assert.match(res.headers.get('content-disposition'), new RegExp(`\\.${target}"?`));
  });
}

test('PDF de 11 pages → images dans l’ordre des pages', { timeout: 120_000, ...needs('convert:pdf', 'pdftoppm') }, async () => {
  // Pages de largeurs croissantes : la page n doit être plus large que la page n-1.
  const pages = Array.from({ length: 11 }, (_, i) => `page${i}.png`);
  pages.forEach((p, i) => sh('convert', ['-size', `${20 + i * 10}x20`, 'xc:gray', p]));
  sh('convert', [...pages, 'multi.pdf']);
  const { convertFile } = require('../server/convert');
  const work = fs.mkdtempSync(path.join(root, 'pdfpages-'));
  const out = await convertFile(path.join(fx, 'multi.pdf'), 'pdf', 'png', work);
  assert.equal(out.length, 11);
  const widths = out.map((f) => fs.readFileSync(f).readUInt32BE(16));
  assert.deepEqual(widths, [...widths].sort((a, b) => a - b));
});

test('md → html conserve les accents', needs('pandoc'), async () => {
  const { res, buf } = await convert(['doc.md'], 'html');
  assert.equal(res.status, 200);
  assert.match(buf.toString(), /<em>paragraphe<\/em>/);
  assert.match(buf.toString(), /été, garçon/);
});

test('json → csv', async () => {
  const { res, buf } = await convert(['data.json'], 'csv');
  assert.equal(res.status, 200);
  assert.equal(buf.toString(), 'nom,age\r\nAda,36\r\nAlan,41\r\n');
});

test('plusieurs fichiers → ZIP', needs('convert'), async () => {
  const { res, buf } = await convert(['img.png', 'img.png'], 'jpg');
  assert.equal(res.status, 200);
  assert.ok(magic.zip(buf));
  assert.ok(buf.includes(Buffer.from('img.jpg')) && buf.includes(Buffer.from('img (2).jpg')));
});

test('mode « zipper uniquement »', async () => {
  const { res, buf } = await convert(['doc.md', 'data.json'], 'zip');
  assert.equal(res.status, 200);
  assert.ok(magic.zip(buf));
  assert.ok(buf.includes(Buffer.from('doc.md')) && buf.includes(Buffer.from('data.json')));
});

test('conversion impossible → 422 avec message', async () => {
  const { res, buf } = await convert(['any.wav'], 'docx');
  assert.equal(res.status, 422);
  assert.match(JSON.parse(buf).error, /non prise en charge/);
});

test('fichier corrompu → erreur propre', needs('convert'), async () => {
  fs.writeFileSync(path.join(fx, 'broken.png'), 'pas une image');
  const { res } = await convert(['broken.png'], 'jpg');
  assert.equal(res.status, 422);
});

test('les fichiers temporaires sont supprimés', needs('convert'), async () => {
  await convert(['img.png'], 'jpg');
  await new Promise((r) => setTimeout(r, 200));
  const left = fs.readdirSync(process.env.TMP_DIR);
  assert.deepEqual(left, []);
});

test('scripts et pages revalidés à chaque visite (pas de vieille version en cache)', async () => {
  for (const url of ['/', '/js/receive.js', '/css/style.css', '/vendor/fflate.js']) {
    const res = await fetch(`${srv.base}${url}`);
    assert.equal(res.headers.get('cache-control'), 'no-cache', url);
    assert.ok(res.headers.get('etag'), url);
    // Requête HTTP brute : fetch() modifie les en-têtes des requêtes conditionnelles.
    const status = await new Promise((resolve, reject) =>
      require('http').get(`${srv.base}${url}`, { headers: { 'If-None-Match': res.headers.get('etag') } }, (r) => (r.resume(), resolve(r.statusCode))).on('error', reject)
    );
    assert.equal(status, 304, url);
  }
  assert.match((await fetch(`${srv.base}/fonts/inter-latin-wght-normal.woff2`)).headers.get('cache-control'), /max-age=604800/);
});

test('en-têtes de sécurité', async () => {
  const res = await fetch(`${srv.base}/`);
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
});

test('/healthz liste les outils de conversion manquants', async () => {
  const body = await (await fetch(`${srv.base}/healthz`)).json();
  assert.equal(body.ok, true);
  assert.ok(Array.isArray(body.missing));
  const { missingTools, which } = require('../server/convert/binaries');
  assert.deepEqual(body.missing, missingTools().map((t) => t.cmd));
  assert.equal(body.tools, body.missing.length ? 'incomplete' : 'ok');
  // Détection indépendante de l'environnement : node est forcément là, une commande inventée non.
  assert.equal(which(process.execPath), process.execPath);
  assert.equal(which('commande-introuvable-convertor'), null);
});
