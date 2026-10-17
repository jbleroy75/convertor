'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { startServer, root } = require('./helpers');
const { parsePages, seconds } = require('../server/tools');

const fx = path.join(root, 'tool-fixtures');
fs.mkdirSync(fx, { recursive: true });
const sh = (cmd, args) => execFileSync(cmd, args, { cwd: fx, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
const pdfPages = (file) => Number(/Pages:\s+(\d+)/.exec(sh('pdfinfo', [file]))[1]);
const imgSize = (file) => sh('identify', ['-format', '%w %h', `${file}[0]`]).trim().split(' ').map(Number);
const duration = (file) => Number(sh('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]));

let srv;
test.before(async () => {
  sh('convert', ['-size', '3000x2000', 'plasma:', '-quality', '98', 'photo.jpg']);
  sh('convert', ['-size', '400x300', 'gradient:red-blue', 'small.png']);
  sh('ffmpeg', ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:a', 'libmp3lame', '-b:a', '32k', 'low.mp3']);
  sh('ffmpeg', ['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:v', 'libx264', '-crf', '12', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', 'clip.mp4']);
  sh('ffmpeg', ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', 'tone.wav']);
  // PDF de 3 pages avec images lourdes (Ghostscript doit pouvoir le réduire).
  sh('convert', ['photo.jpg', 'photo.jpg', 'photo.jpg', '-quality', '100', 'heavy.pdf']);
  sh('convert', ['small.png', 'small.png', 'doc2.pdf']);
  srv = await startServer();
});
test.after(() => srv.close());

async function tool(id, names, options) {
  const form = new FormData();
  if (options) form.append('options', JSON.stringify(options));
  for (const n of names) form.append('files', new Blob([fs.readFileSync(path.join(fx, n))]), n);
  const res = await fetch(`${srv.base}/api/tools/${id}`, { method: 'POST', body: form });
  const buf = Buffer.from(await res.arrayBuffer());
  const out = path.join(fx, `out-${id}-${Date.now()}${/filename="[^"]*(\.[a-z0-9]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || ''}`);
  if (res.ok) fs.writeFileSync(out, buf);
  return { res, buf, out, stats: res.headers.get('x-convertor-stats') && JSON.parse(decodeURIComponent(res.headers.get('x-convertor-stats'))) };
}

test('liste des outils', async () => {
  const { tools } = await (await fetch(`${srv.base}/api/tools`)).json();
  assert.ok(tools.compress.accepts.includes('pdf'));
  assert.equal(tools['pdf-merge'].min, 2);
});

test('compression photo : plus légère, redimensionnée, métadonnées retirées', { timeout: 60_000 }, async () => {
  const before = fs.statSync(path.join(fx, 'photo.jpg')).size;
  const { res, out, stats } = await tool('compress', ['photo.jpg'], { level: 'strong' });
  assert.equal(res.status, 200);
  assert.ok(fs.statSync(out).size < before / 3, 'au moins 3x plus léger');
  assert.deepEqual(imgSize(out), [1920, 1280]);
  assert.equal(stats[0].before, before);
  assert.equal(stats[0].after, fs.statSync(out).size);
});

test('compression : taille max d’image personnalisée', { timeout: 60_000 }, async () => {
  const { out } = await tool('compress', ['photo.jpg'], { level: 'light', maxImage: 800 });
  assert.deepEqual(imgSize(out), [800, 533]);
});

test('compression vidéo : MP4 plus léger, résolution réduite', { timeout: 120_000 }, async () => {
  const before = fs.statSync(path.join(fx, 'clip.mp4')).size;
  const { res, out } = await tool('compress', ['clip.mp4'], { level: 'strong' });
  assert.equal(res.status, 200);
  assert.ok(fs.statSync(out).size < before);
  assert.equal(sh('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=height', '-of', 'csv=p=0', out]).trim(), '720');
});

test('compression audio et PDF', { timeout: 120_000 }, async () => {
  const wav = await tool('compress', ['tone.wav'], { level: 'balanced' });
  assert.match(wav.res.headers.get('content-disposition'), /tone\.mp3/);
  assert.ok(wav.stats[0].after < wav.stats[0].before);
  const pdf = await tool('compress', ['heavy.pdf'], { level: 'strong' });
  assert.equal(pdf.res.status, 200);
  assert.ok(pdf.stats[0].after < pdf.stats[0].before / 2, `PDF ${pdf.stats[0].before} -> ${pdf.stats[0].after}`);
  assert.equal(pdfPages(pdf.out), 3);
});

test('compression : si le résultat est plus gros, on rend l’original', async () => {
  // MP3 à 32 kb/s : le réencoder en 192 kb/s (niveau léger) le ferait grossir.
  const { res, buf, stats } = await tool('compress', ['low.mp3'], { level: 'light' });
  assert.equal(res.status, 200);
  assert.deepEqual(buf, fs.readFileSync(path.join(fx, 'low.mp3')));
  assert.equal(stats[0].kept, true);
});

test('photo impossible à alléger : métadonnées quand même supprimées', async () => {
  // JPG déjà très compressé (qualité 30) + commentaire « secret » : le réencoder en qualité 85 le ferait grossir.
  sh('convert', ['-size', '200x150', 'plasma:', '-set', 'comment', 'GPS-SECRET-48.85N', '-quality', '30', 'tagged.jpg']);
  assert.match(sh('identify', ['-format', '%c', 'tagged.jpg']), /GPS-SECRET/);
  const { res, buf, out, stats } = await tool('compress', ['tagged.jpg'], { level: 'light' });
  assert.equal(res.status, 200);
  assert.ok(!buf.includes(Buffer.from('GPS-SECRET')), 'les métadonnées doivent être retirées');
  assert.deepEqual(imgSize(out), [200, 150]);
  assert.equal(stats[0].kept, true);
});

test('compression de plusieurs fichiers → ZIP', { timeout: 60_000 }, async () => {
  const { res, buf } = await tool('compress', ['photo.jpg', 'small.png'], { level: 'balanced' });
  assert.equal(res.status, 200);
  assert.equal(buf.subarray(0, 2).toString(), 'PK');
});

test('fusion de PDF', async () => {
  const { res, out } = await tool('pdf-merge', ['heavy.pdf', 'doc2.pdf']);
  assert.equal(res.status, 200);
  assert.equal(pdfPages(out), 5);
});

test('fusion : il faut au moins deux PDF', async () => {
  const { res, buf } = await tool('pdf-merge', ['doc2.pdf']);
  assert.equal(res.status, 422);
  assert.match(JSON.parse(buf).error, /au moins 2/);
});

test('extraction de pages (ordre respecté)', async () => {
  const { res, out } = await tool('pdf-extract', ['heavy.pdf'], { pages: '3,1' });
  assert.equal(res.status, 200);
  assert.equal(pdfPages(out), 2);
});

test('extraction : pages hors document refusées', async () => {
  const { res, buf } = await tool('pdf-extract', ['heavy.pdf'], { pages: '2-9' });
  assert.equal(res.status, 422);
  assert.match(JSON.parse(buf).error, /hors du document/);
});

test('découpe : un PDF par page', async () => {
  const { res, buf } = await tool('pdf-split', ['heavy.pdf']);
  assert.equal(res.status, 200);
  for (const p of ['heavy-page-01.pdf', 'heavy-page-02.pdf', 'heavy-page-03.pdf']) assert.ok(buf.includes(Buffer.from(p)), p);
});

test('images → un seul PDF', { timeout: 60_000 }, async () => {
  const { res, out } = await tool('images-to-pdf', ['small.png', 'photo.jpg']);
  assert.equal(res.status, 200);
  assert.equal(pdfPages(out), 2);
});

test('redimensionner et pivoter', async () => {
  const half = await tool('image-resize', ['small.png'], { percent: 50 });
  assert.deepEqual(imgSize(half.out), [200, 150]);
  const w = await tool('image-resize', ['small.png'], { width: 100 });
  assert.deepEqual(imgSize(w.out), [100, 75]);
  const rot = await tool('image-rotate', ['small.png'], { angle: 90 });
  assert.deepEqual(imgSize(rot.out), [300, 400]);
  const none = await tool('image-resize', ['small.png'], {});
  assert.equal(none.res.status, 422);
});

test('couper une vidéo et un audio', { timeout: 60_000 }, async () => {
  const v = await tool('media-trim', ['clip.mp4'], { start: '0:01', end: '2' });
  assert.equal(v.res.status, 200);
  assert.ok(Math.abs(duration(v.out) - 1) < 0.15, `durée ${duration(v.out)}`);
  const a = await tool('media-trim', ['tone.wav'], { start: '1.5' });
  assert.match(a.res.headers.get('content-disposition'), /tone-extrait\.wav/);
  assert.ok(Math.abs(duration(a.out) - 1.5) < 0.1);
  const bad = await tool('media-trim', ['tone.wav'], { start: '2', end: '1' });
  assert.equal(bad.res.status, 422);
});

test('ZIP de fichiers quelconques', async () => {
  const { res, buf } = await tool('zip', ['tone.wav', 'doc2.pdf']);
  assert.equal(res.status, 200);
  assert.ok(buf.includes(Buffer.from('doc2.pdf')));
});

test('format non accepté, outil inconnu, options invalides', async () => {
  assert.equal((await tool('pdf-split', ['small.png'])).res.status, 422);
  assert.equal((await tool('rm-rf', ['small.png'])).res.status, 422);
  assert.equal((await tool('image-rotate', ['small.png'], { angle: 45 })).res.status, 422);
  assert.equal((await tool('compress', ['small.png'], { level: '; rm -rf /' })).res.status, 422);
});

test('analyse des pages et des durées', () => {
  assert.deepEqual(parsePages('1-3, 5, 7-', 8), [1, 2, 3, 5, 7, 8]);
  assert.throws(() => parsePages('0', 3));
  assert.throws(() => parsePages('a', 3));
  assert.equal(seconds('1:30'), 90);
  assert.equal(seconds('01:02:03.5'), 3723.5);
  assert.equal(seconds(''), null);
  assert.throws(() => seconds('1:2:3:4'));
});
