'use strict';

// Outils : compression (images, vidéo, audio, PDF), PDF (fusion, extraction, découpe),
// images (vers PDF, redimensionner, pivoter), médias (couper) et ZIP.
// Toutes les options sont validées contre des listes blanches ou des bornes numériques :
// aucun texte fourni par l'utilisateur n'est transmis tel quel aux commandes.

const fsp = require('fs/promises');
const path = require('path');
const { run, slots } = require('../convert/run');
const { IMG_IN, AUDIO_IN, VIDEO_IN, AUDIO_OUT, MAGICK_CODER, FFMPEG_DEMUXERS, FFMPEG_OUT, extOf } = require('../convert');

class ToolError extends Error {}

const PDF = ['pdf'];
const MEDIA = [...AUDIO_IN, ...VIDEO_IN];
const ANY = '*';

// Formats image que l'on peut réécrire tels quels ; les autres (HEIC, TIFF…) sortent en JPG.
const IMG_KEEP = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif']);
const imgOutExt = (ext) => (IMG_KEEP.has(ext) ? (ext === 'jpeg' ? 'jpg' : ext) : 'jpg');
const coder = (ext) => MAGICK_CODER[ext] || ext;
const magickIn = (file, ext, frame = '[0]') => `${coder(ext)}:${file}${frame}`;

const ffmpegIn = (file) => ['-hide_banner', '-nostdin', '-y', '-protocol_whitelist', 'file', '-format_whitelist', FFMPEG_DEMUXERS, '-i', file];

// --- Validation des options --------------------------------------------------

function oneOf(value, allowed, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (!allowed.includes(value)) throw new ToolError('Option invalide');
  return value;
}

function int(value, min, max, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new ToolError(`Valeur hors limites (${min} à ${max})`);
  return n;
}

/** « 90 », « 1:30 », « 01:02:03.5 » → secondes. */
function seconds(value, label) {
  if (value === undefined || value === null || value === '') return null;
  const m = /^(?:(\d{1,2}):)?(?:(\d{1,2}):)?(\d{1,5}(?:[.,]\d{1,3})?)$/.exec(String(value).trim());
  if (!m) throw new ToolError(`${label} invalide (ex. 1:30 ou 01:02:03)`);
  const parts = [m[1], m[2], m[3]].filter((x) => x !== undefined).map((x) => Number(String(x).replace(',', '.')));
  return parts.reduce((acc, v) => acc * 60 + v, 0);
}

/** « 1-3, 5, 8- » → [1,2,3,5,8,…,total] (ordre conservé, bornes vérifiées). */
function parsePages(spec, total) {
  const text = String(spec || '').replace(/\s+/g, '');
  if (!/^[0-9,-]{1,200}$/.test(text)) throw new ToolError('Pages invalides (ex. 1-3,5,8-)');
  const pages = [];
  for (const part of text.split(',').filter(Boolean)) {
    const m = /^(\d*)(-?)(\d*)$/.exec(part);
    if (!m || (!m[1] && !m[3])) throw new ToolError(`Plage invalide : « ${part} »`);
    const a = m[1] ? Number(m[1]) : 1;
    const b = m[2] ? (m[3] ? Number(m[3]) : total) : a;
    if (a < 1 || b < a || b > total) throw new ToolError(`Plage « ${part} » hors du document (${total} pages)`);
    for (let p = a; p <= b; p++) pages.push(p);
  }
  if (!pages.length) throw new ToolError('Aucune page sélectionnée');
  if (pages.length > 5000) throw new ToolError('Trop de pages');
  return pages;
}

async function pdfPageCount(file, cwd) {
  const { stdout } = await run('pdfinfo', [file], { cwd });
  const m = /^Pages:\s+(\d+)/m.exec(stdout);
  if (!m) throw new ToolError('PDF illisible');
  return Number(m[1]);
}

// --- Compression -------------------------------------------------------------

const LEVELS = {
  light: { jpg: 85, webp: 85, crf: 24, abr: '192k', vabr: '160k', pdf: '/printer', maxImg: 0, maxVideo: 0 },
  balanced: { jpg: 75, webp: 75, crf: 28, abr: '128k', vabr: '128k', pdf: '/ebook', maxImg: 2560, maxVideo: 1080 },
  strong: { jpg: 60, webp: 60, crf: 32, abr: '96k', vabr: '96k', pdf: '/screen', maxImg: 1920, maxVideo: 720 },
};

async function compressOne(file, ext, opts, dir) {
  const L = LEVELS[opts.level];
  if (IMG_IN.includes(ext) && ext !== 'gif') {
    const outExt = imgOutExt(ext);
    const out = path.join(dir, `out.${outExt}`);
    const max = opts.maxImage ?? L.maxImg;
    const args = [magickIn(file, ext), '-auto-orient', '-strip'];
    if (max) args.push('-resize', `${max}x${max}>`);
    if (outExt === 'jpg') args.push('-background', 'white', '-alpha', 'remove', '-sampling-factor', '4:2:0', '-interlace', 'Plane', '-quality', String(L.jpg));
    if (outExt === 'webp') args.push('-quality', String(L.webp));
    if (outExt === 'png') args.push('-define', 'png:compression-level=9', '-define', 'png:compression-filter=5');
    args.push(`${coder(outExt)}:${out}`);
    await run('convert', args, { cwd: dir });
    return { path: out, ext: outExt };
  }
  if (VIDEO_IN.includes(ext) || ext === 'gif') {
    const out = path.join(dir, 'out.mp4');
    const h = opts.maxVideo ?? L.maxVideo;
    const scale = h ? `scale=-2:'min(${h},trunc(ih/2)*2)'` : 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
    await run(
      'ffmpeg',
      [...ffmpegIn(file), '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'medium', '-crf', String(L.crf), '-pix_fmt', 'yuv420p', '-vf', scale, '-c:a', 'aac', '-b:a', L.vabr, '-movflags', '+faststart', out],
      { cwd: dir }
    );
    return { path: out, ext: 'mp4' };
  }
  if (AUDIO_IN.includes(ext)) {
    const out = path.join(dir, 'out.mp3');
    await run('ffmpeg', [...ffmpegIn(file), '-vn', '-c:a', 'libmp3lame', '-b:a', L.abr, out], { cwd: dir });
    return { path: out, ext: 'mp3' };
  }
  if (ext === 'pdf') {
    const out = path.join(dir, 'out.pdf');
    await run(
      'gs',
      ['-q', '-dNOPAUSE', '-dBATCH', '-dSAFER', '-sDEVICE=pdfwrite', '-dCompatibilityLevel=1.5', `-dPDFSETTINGS=${L.pdf}`, '-dDetectDuplicateImages=true', '-dCompressFonts=true', `-sOutputFile=${out}`, file],
      { cwd: dir }
    );
    return { path: out, ext: 'pdf' };
  }
  throw new ToolError(`Format .${ext} non compressible (essayez « Créer un ZIP »)`);
}

// --- Définition des outils ---------------------------------------------------

const TOOLS = {
  compress: {
    accepts: [...IMG_IN, ...MEDIA, 'pdf'],
    mode: 'each',
    options: (o) => ({
      level: oneOf(o.level, Object.keys(LEVELS), 'balanced'),
      maxImage: o.maxImage === undefined || o.maxImage === '' ? undefined : int(o.maxImage, 0, 8000),
      maxVideo: o.maxVideo === undefined || o.maxVideo === '' ? undefined : oneOf(Number(o.maxVideo), [0, 2160, 1440, 1080, 720, 480, 360]),
    }),
    async run({ file, ext, base, dir, opts }) {
      const r = await compressOne(file, ext, opts, dir);
      const [before, after] = await Promise.all([fsp.stat(file), fsp.stat(r.path)]);
      if (after.size < before.size) return [{ path: r.path, name: `${base}.${r.ext}`, before: before.size, after: after.size }];
      // Rien à gagner. Pour une photo, on ne rend JAMAIS l'original brut (GPS, appareil…) :
      // passe « métadonnées seulement », sans redimensionnement, à la qualité d'origine.
      if (IMG_IN.includes(ext) && ext !== 'gif') {
        const outExt = imgOutExt(ext);
        const clean = path.join(dir, `clean.${outExt}`);
        await run('convert', [magickIn(file, ext), '-auto-orient', '-strip', `${coder(outExt)}:${clean}`], { cwd: dir });
        const size = (await fsp.stat(clean)).size;
        return [{ path: clean, name: `${base}.${outExt}`, before: before.size, after: size, kept: true }];
      }
      // Autres formats : l'original, dans son format d'origine.
      return [{ path: file, name: `${base}.${ext}`, before: before.size, after: before.size, kept: true }];
    },
  },

  'pdf-merge': {
    accepts: PDF,
    mode: 'all',
    min: 2,
    async run({ files, dir }) {
      const out = path.join(dir, 'fusion.pdf');
      await run('pdfunite', [...files.map((f) => f.path), out], { cwd: dir });
      return [{ path: out, name: 'fusion.pdf' }];
    },
  },

  'pdf-extract': {
    accepts: PDF,
    mode: 'each',
    options: (o) => ({ pages: String(o.pages || '') }),
    async run({ file, base, dir, opts }) {
      const pages = parsePages(opts.pages, await pdfPageCount(file, dir));
      const parts = [];
      for (const [i, p] of pages.entries()) {
        const part = path.join(dir, `p${i}.pdf`);
        await run('pdfseparate', ['-f', String(p), '-l', String(p), file, part], { cwd: dir });
        parts.push(part);
      }
      const out = path.join(dir, 'extrait.pdf');
      await run('pdfunite', [...parts, out], { cwd: dir });
      return [{ path: out, name: `${base}-pages.pdf` }];
    },
  },

  'pdf-split': {
    accepts: PDF,
    mode: 'each',
    async run({ file, base, dir }) {
      await run('pdfseparate', [file, path.join(dir, 'page-%d.pdf')], { cwd: dir });
      const pageNo = (f) => Number(/page-(\d+)\.pdf$/.exec(f)[1]);
      const files = (await fsp.readdir(dir)).filter((f) => /^page-\d+\.pdf$/.test(f)).sort((a, b) => pageNo(a) - pageNo(b));
      const width = String(files.length).length;
      return files.map((f) => ({ path: path.join(dir, f), name: `${base}-page-${String(pageNo(f)).padStart(Math.max(2, width), '0')}.pdf` }));
    },
  },

  'images-to-pdf': {
    accepts: IMG_IN,
    mode: 'all',
    async run({ files, dir }) {
      const out = path.join(dir, 'images.pdf');
      const args = [];
      for (const f of files) args.push(magickIn(f.path, f.ext));
      // Pages A4 à ~200 dpi au plus : PDF léger mais net.
      args.push('-auto-orient', '-resize', '2400x2400>', '-background', 'white', '-alpha', 'remove', '-compress', 'jpeg', '-quality', '85', `pdf:${out}`);
      await run('convert', args, { cwd: dir });
      return [{ path: out, name: files.length === 1 ? `${files[0].base}.pdf` : 'images.pdf' }];
    },
  },

  'image-resize': {
    accepts: IMG_IN,
    mode: 'each',
    options: (o) => {
      const percent = int(o.percent, 1, 400);
      const width = int(o.width, 1, 16000);
      const height = int(o.height, 1, 16000);
      if (!percent && !width && !height) throw new ToolError('Indiquez une largeur, une hauteur ou un pourcentage');
      return { percent, width, height };
    },
    async run({ file, ext, base, dir, opts }) {
      const outExt = imgOutExt(ext);
      const out = path.join(dir, `out.${outExt}`);
      const geometry = opts.percent ? `${opts.percent}%` : `${opts.width || ''}x${opts.height || ''}`;
      const frame = outExt === 'gif' ? '' : '[0]';
      await run('convert', [magickIn(file, ext, frame), '-auto-orient', '-resize', geometry, ...(outExt === 'jpg' ? ['-quality', '90'] : []), `${coder(outExt)}:${out}`], { cwd: dir });
      return [{ path: out, name: `${base}.${outExt}` }];
    },
  },

  'image-rotate': {
    accepts: IMG_IN,
    mode: 'each',
    options: (o) => ({ angle: oneOf(Number(o.angle), [90, 180, 270], 90) }),
    async run({ file, ext, base, dir, opts }) {
      const outExt = imgOutExt(ext);
      const out = path.join(dir, `out.${outExt}`);
      const frame = outExt === 'gif' ? '' : '[0]';
      await run('convert', [magickIn(file, ext, frame), '-auto-orient', '-rotate', String(opts.angle), ...(outExt === 'jpg' ? ['-quality', '92'] : []), `${coder(outExt)}:${out}`], { cwd: dir });
      return [{ path: out, name: `${base}.${outExt}` }];
    },
  },

  'media-trim': {
    accepts: MEDIA,
    mode: 'each',
    options: (o) => {
      const start = seconds(o.start, 'Début') ?? 0;
      const end = seconds(o.end, 'Fin');
      if (end !== null && end <= start) throw new ToolError('La fin doit être après le début');
      return { start, end };
    },
    async run({ file, ext, base, dir, opts }) {
      const isAudio = AUDIO_IN.includes(ext);
      const outExt = isAudio ? (AUDIO_OUT.includes(ext) ? ext : 'mp3') : 'mp4';
      const out = path.join(dir, `out.${outExt}`);
      const args = ['-ss', String(opts.start), ...ffmpegIn(file)];
      if (opts.end !== null) args.push('-t', String(opts.end - opts.start));
      args.push(...(isAudio ? FFMPEG_OUT[outExt] : FFMPEG_OUT.mp4), out);
      await run('ffmpeg', args, { cwd: dir });
      return [{ path: out, name: `${base}-extrait.${outExt}` }];
    },
  },

  zip: { accepts: ANY, mode: 'zip' },
};

/** Ce que l'interface doit savoir de chaque outil. */
function toolList() {
  return Object.fromEntries(Object.entries(TOOLS).map(([id, t]) => [id, { accepts: t.accepts, mode: t.mode, min: t.min || 1 }]));
}

/**
 * Exécute un outil. `files` : [{ path, ext, base }]. Retourne { outputs, errors }.
 * Les erreurs propres à un fichier n'empêchent pas de traiter les autres.
 */
async function runTool(id, files, rawOptions, workDir) {
  const tool = Object.hasOwn(TOOLS, id) ? TOOLS[id] : null;
  if (!tool || tool.mode === 'zip') throw new ToolError('Outil inconnu');
  const opts = tool.options ? tool.options(rawOptions || {}) : {};
  const bad = files.filter((f) => tool.accepts !== ANY && !tool.accepts.includes(f.ext));
  if (tool.mode === 'all') {
    if (bad.length) throw new ToolError(`Format non accepté par cet outil : ${bad.map((f) => '.' + (f.ext || '?')).join(', ')}`);
    if (files.length < (tool.min || 1)) throw new ToolError(`Il faut au moins ${tool.min} fichiers`);
    const dir = path.join(workDir, 'all');
    await fsp.mkdir(dir);
    return { outputs: await slots.use(() => tool.run({ files, dir, opts })), errors: [] };
  }
  const outputs = [];
  const errors = [];
  await Promise.all(
    files.map(async (f, i) => {
      try {
        if (!tool.accepts.includes(f.ext)) throw new ToolError(`format .${f.ext || '?'} non accepté par cet outil`);
        const dir = path.join(workDir, `w${i}`);
        await fsp.mkdir(dir);
        const produced = await slots.use(() => tool.run({ file: f.path, ext: f.ext, base: f.base, dir, opts }));
        produced.forEach((p, n) => outputs.push({ ...p, order: i * 100000 + n }));
      } catch (e) {
        if (!(e instanceof ToolError)) console.warn(`[tool:${id}] ${f.ext} : ${e.message}${e.details ? '\n' + e.details : ''}`);
        errors.push(`${f.originalName} : ${e instanceof ToolError ? e.message : 'traitement impossible (fichier abîmé ou non pris en charge)'}`);
      }
    })
  );
  outputs.sort((a, b) => a.order - b.order);
  return { outputs, errors };
}

module.exports = { runTool, toolList, ToolError, parsePages, seconds, TOOLS };
