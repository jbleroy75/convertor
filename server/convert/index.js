'use strict';

const fs = require('fs/promises');
const path = require('path');
const { run, slots } = require('./run');
const { convertData } = require('./data');

// Binaire pandoc officiel recommandé : celui de Debian casse --sandbox pour docx/odt/epub.
const PANDOC = process.env.PANDOC_BIN || 'pandoc';

// ---------------------------------------------------------------------------
// Familles de formats
// ---------------------------------------------------------------------------

const IMG_IN = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'ico', 'avif', 'heic', 'heif', 'psd', 'tga'];
const IMG_OUT = ['png', 'jpg', 'webp', 'gif', 'bmp', 'tiff', 'ico', 'pdf'];
const AUDIO_IN = ['mp3', 'wav', 'ogg', 'oga', 'flac', 'aac', 'm4a', 'opus', 'wma', 'aiff', 'aif', 'amr', 'caf'];
const AUDIO_OUT = ['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'opus'];
const VIDEO_IN = ['mp4', 'webm', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'm4v', 'mpeg', 'mpg', '3gp', 'ts', 'mts'];
const VIDEO_OUT = ['mp4', 'webm', 'mkv', 'avi', 'mov', 'gif'];
const WRITER_IN = ['doc', 'docx', 'odt', 'rtf', 'txt', 'wpd', 'pages'];
const SHEET_IN = ['xls', 'xlsx', 'ods'];
const SLIDE_IN = ['ppt', 'pptx', 'odp', 'key'];
const MARKUP_IN = ['md', 'markdown', 'html', 'htm', 'epub', 'rst', 'tex'];
const DATA = ['json', 'yaml', 'yml', 'csv', 'tsv'];

/** Catégorie affichée dans l'interface pour chaque extension d'entrée. */
const CATEGORY = {};
const tag = (list, cat) => list.forEach((e) => (CATEGORY[e] ??= cat));
tag(IMG_IN, 'image');
tag(['svg'], 'image');
tag(AUDIO_IN, 'audio');
tag(VIDEO_IN, 'video');
tag([...WRITER_IN, ...MARKUP_IN, 'pdf'], 'document');
tag([...SHEET_IN, ...SLIDE_IN], 'office');
tag(DATA, 'data');

// ---------------------------------------------------------------------------
// Moteurs
// ---------------------------------------------------------------------------

const MAGICK_CODER = { jpg: 'jpeg', jpeg: 'jpeg', tif: 'tiff', heif: 'heic', yml: 'yaml' };
const MULTI_FRAME_OUT = new Set(['gif', 'webp', 'tiff', 'pdf']);

async function magick(input, from, to, outDir) {
  const coder = MAGICK_CODER[from] || from;
  // Coder forcé en préfixe : ImageMagick ne devine pas le format (évite MVG/MSL & co).
  const src = `${coder}:${input}${MULTI_FRAME_OUT.has(to) ? '' : '[0]'}`;
  const args = [src, '-auto-orient'];
  if (to === 'jpg' || to === 'bmp') args.push('-background', 'white', '-alpha', 'remove', '-alpha', 'off');
  if (to === 'jpg') args.push('-quality', '90');
  if (to === 'webp') args.push('-quality', '90');
  if (to === 'ico') args.push('-resize', '256x256>', '-define', 'icon:auto-resize=256,128,64,48,32,16');
  if (to === 'gif' && from !== 'gif') args.push('-layers', 'optimize');
  const out = path.join(outDir, `out.${to}`);
  args.push(`${MAGICK_CODER[to] || to}:${out}`);
  await run('convert', args, { cwd: outDir });
  return [out];
}

async function svgRaster(input, from, to, outDir) {
  const png = path.join(outDir, 'svg.png');
  await run('rsvg-convert', ['--format=png', '--output', png, input], { cwd: outDir });
  if (to === 'png') return [png];
  return magick(png, 'png', to, outDir);
}

async function svgPdf(input, from, to, outDir) {
  const out = path.join(outDir, 'out.pdf');
  await run('rsvg-convert', ['--format=pdf', '--output', out, input], { cwd: outDir });
  return [out];
}

const FFMPEG_DEMUXERS = 'mov,matroska,webm,avi,flv,mpeg,mpegts,mp3,wav,ogg,flac,aac,asf,aiff,amr,gif,caf,w64';

const FFMPEG_OUT = {
  mp3: ['-vn', '-c:a', 'libmp3lame', '-q:a', '2'],
  wav: ['-vn', '-c:a', 'pcm_s16le'],
  ogg: ['-vn', '-c:a', 'libvorbis', '-q:a', '5'],
  flac: ['-vn', '-c:a', 'flac'],
  aac: ['-vn', '-c:a', 'aac', '-b:a', '192k'],
  m4a: ['-vn', '-c:a', 'aac', '-b:a', '192k'],
  opus: ['-vn', '-c:a', 'libopus', '-b:a', '128k'],
  mp4: ['-c:v', 'libx264', '-preset', 'medium', '-crf', '23', '-pix_fmt', 'yuv420p', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart'],
  mov: ['-c:v', 'libx264', '-preset', 'medium', '-crf', '23', '-pix_fmt', 'yuv420p', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:a', 'aac', '-b:a', '160k'],
  mkv: ['-c:v', 'libx264', '-preset', 'medium', '-crf', '23', '-c:a', 'aac', '-b:a', '160k'],
  webm: ['-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '4', '-c:a', 'libopus', '-b:a', '128k'],
  avi: ['-c:v', 'mpeg4', '-q:v', '4', '-c:a', 'libmp3lame', '-q:a', '4'],
  gif: ['-an', '-vf', "fps=12,scale='min(720,iw)':-2:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse", '-loop', '0'],
};

async function ffmpeg(input, from, to, outDir) {
  const out = path.join(outDir, `out.${to}`);
  await run(
    'ffmpeg',
    [
      '-hide_banner', '-nostdin', '-y',
      // Aucun accès réseau, aucun démuxeur à base de playlist (HLS, concat…).
      '-protocol_whitelist', 'file',
      '-format_whitelist', FFMPEG_DEMUXERS,
      '-i', input,
      ...FFMPEG_OUT[to],
      out,
    ],
    { cwd: outDir }
  );
  return [out];
}

const LO_FILTER = {
  pdf: 'pdf',
  docx: 'docx:MS Word 2007 XML',
  odt: 'odt',
  rtf: 'rtf',
  txt: 'txt:Text (encoded):UTF8',
  html: 'html',
  xlsx: 'xlsx:Calc MS Excel 2007 XML',
  ods: 'ods',
  csv: 'csv:Text - txt - csv (StarCalc):44,34,76,1',
  pptx: 'pptx:Impress MS PowerPoint 2007 XML',
  odp: 'odp',
};
const LO_INFILTER = {
  txt: 'Text (encoded):UTF8',
  csv: 'Text - txt - csv (StarCalc):44,34,76,1',
  pdf: 'writer_pdf_import',
};

async function libreoffice(input, from, to, outDir) {
  // Un profil LibreOffice par tâche : permet les conversions en parallèle.
  const profile = path.join(outDir, '.lo-profile');
  const args = ['--headless', '--norestore', '--nolockcheck', '--nodefault', `-env:UserInstallation=file://${profile}`];
  if (LO_INFILTER[from]) args.push(`--infilter=${LO_INFILTER[from]}`);
  args.push('--convert-to', LO_FILTER[to], '--outdir', outDir, input);
  await run('soffice', args, { cwd: outDir });
  const base = path.basename(input, path.extname(input));
  const out = path.join(outDir, `${base}.${to}`);
  await fs.access(out).catch(() => {
    throw new Error('LibreOffice n’a produit aucun fichier (format non pris en charge ?)');
  });
  return [out];
}

const PANDOC_IN = { md: 'markdown', markdown: 'markdown', html: 'html', htm: 'html', epub: 'epub', rst: 'rst', tex: 'latex', docx: 'docx', odt: 'odt' };
const PANDOC_OUT = { md: 'gfm', html: 'html5', docx: 'docx', odt: 'odt', epub: 'epub3', txt: 'plain', rst: 'rst', tex: 'latex' };

async function pandoc(input, from, to, outDir) {
  const out = path.join(outDir, `out.${to}`);
  const args = ['--sandbox', '-f', PANDOC_IN[from], '-t', PANDOC_OUT[to], '-o', out];
  if (['html', 'tex', 'epub'].includes(to)) args.push('--standalone', '--metadata', 'pagetitle=Document');
  args.push(input);
  await run(PANDOC, args, { cwd: outDir });
  return [out];
}

async function pdfImages(input, from, to, outDir) {
  const prefix = path.join(outDir, 'page');
  const fmt = to === 'png' ? ['-png'] : ['-jpeg', '-jpegopt', 'quality=90'];
  await run('pdftoppm', ['-r', '150', ...fmt, input, prefix], { cwd: outDir });
  const pageNo = (f) => Number(/(\d+)\.\w+$/.exec(f)?.[1] || 0);
  const files = (await fs.readdir(outDir)).filter((f) => f.startsWith('page')).sort((a, b) => pageNo(a) - pageNo(b));
  return files.map((f) => path.join(outDir, f));
}

async function pdfText(input, from, to, outDir) {
  const out = path.join(outDir, 'out.txt');
  await run('pdftotext', ['-layout', '-enc', 'UTF-8', input, out], { cwd: outDir });
  return [out];
}

async function data(input, from, to, outDir) {
  const out = path.join(outDir, `out.${to}`);
  await convertData(input, from, to, out);
  return [out];
}

// txt -> md : simple copie (le texte brut est du Markdown valide).
async function copyAs(input, from, to, outDir) {
  const out = path.join(outDir, `out.${to}`);
  await fs.copyFile(input, out);
  return [out];
}

// ---------------------------------------------------------------------------
// Règles : la première règle qui correspond à (entrée, sortie) gagne.
// `via` = conversion en deux étapes par un format intermédiaire.
// ---------------------------------------------------------------------------

const RULES = [
  { from: DATA, to: DATA, engine: data },
  { from: ['csv'], to: ['xlsx', 'ods', 'pdf', 'html'], engine: libreoffice },
  { from: ['json', 'yaml', 'yml', 'tsv'], to: ['xlsx', 'ods'], via: 'csv' },

  { from: ['gif'], to: ['mp4', 'webm', 'mkv', 'mov'], engine: ffmpeg },
  { from: ['svg'], to: ['pdf'], engine: svgPdf },
  { from: ['svg'], to: IMG_OUT, engine: svgRaster },
  { from: IMG_IN, to: IMG_OUT, engine: magick },

  { from: AUDIO_IN, to: AUDIO_OUT, engine: ffmpeg },
  { from: VIDEO_IN, to: [...VIDEO_OUT, ...AUDIO_OUT], engine: ffmpeg },

  { from: ['pdf'], to: ['png', 'jpg'], engine: pdfImages },
  { from: ['pdf'], to: ['txt'], engine: pdfText },
  { from: ['pdf'], to: ['docx', 'odt'], engine: libreoffice },

  { from: ['docx', 'odt'], to: ['md', 'epub', 'rst', 'tex'], engine: pandoc },
  { from: WRITER_IN, to: ['pdf', 'docx', 'odt', 'rtf', 'txt', 'html'], engine: libreoffice },
  { from: ['txt'], to: ['md'], engine: copyAs },
  { from: SHEET_IN, to: ['xlsx', 'ods', 'csv', 'pdf', 'html'], engine: libreoffice },
  { from: SHEET_IN, to: ['json', 'yaml', 'tsv'], via: 'csv' },
  { from: SLIDE_IN, to: ['pdf', 'pptx', 'odp'], engine: libreoffice },

  { from: MARKUP_IN, to: Object.keys(PANDOC_OUT), engine: pandoc },
  { from: MARKUP_IN, to: ['pdf'], via: 'docx' },
];

function findRule(from, to) {
  return RULES.find((r) => r.from.includes(from) && r.to.includes(to) && from !== to);
}

/** Table extension d'entrée -> formats de sortie possibles (pour l'UI). */
function formatMap() {
  const map = {};
  for (const r of RULES) {
    for (const f of r.from) {
      map[f] ??= new Set();
      for (const t of r.to) if (t !== f && !(f === 'jpeg' && t === 'jpg') && !(f === 'yml' && t === 'yaml')) map[f].add(t);
    }
  }
  const out = {};
  for (const [k, v] of Object.entries(map)) out[k] = { category: CATEGORY[k] || 'document', targets: [...v].sort() };
  return out;
}

const SUPPORTED = formatMap();

function extOf(name) {
  const m = /\.([A-Za-z0-9]{1,10})$/.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

/**
 * Convertit `input` (extension `from`) vers `to`. Retourne la liste des fichiers produits.
 * `workDir` doit être un dossier vide et propre à cette tâche.
 */
async function convertFile(input, from, to, workDir) {
  const rule = findRule(from, to);
  if (!rule) throw new Error(`Conversion ${from.toUpperCase()} → ${to.toUpperCase()} non prise en charge`);
  if (rule.via) {
    const stepDir = path.join(workDir, 'step1');
    await fs.mkdir(stepDir);
    const [mid] = await convertFile(input, from, rule.via, stepDir);
    const stepDir2 = path.join(workDir, 'step2');
    await fs.mkdir(stepDir2);
    return convertFile(mid, rule.via, to, stepDir2);
  }
  // Les moteurs « pur JS » ne passent pas par la file d'attente des process lourds.
  if (rule.engine === data || rule.engine === copyAs) return rule.engine(input, from, to, workDir);
  return slots.use(() => rule.engine(input, from, to, workDir));
}

module.exports = { convertFile, findRule, formatMap, SUPPORTED, extOf, CATEGORY };
