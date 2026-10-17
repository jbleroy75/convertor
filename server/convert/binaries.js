'use strict';

// Repère les outils externes disponibles dans le PATH (diagnostic de déploiement).

const fs = require('fs');
const path = require('path');

const REQUIRED = {
  convert: 'ImageMagick (images)',
  ffmpeg: 'FFmpeg (audio / vidéo)',
  soffice: 'LibreOffice (documents Office)',
  pdftoppm: 'Poppler (PDF)',
  gs: 'Ghostscript (compression PDF)',
  'rsvg-convert': 'librsvg (SVG)',
  pandoc: 'pandoc (Markdown / HTML / EPUB)',
};

const cache = new Map();

function which(cmd) {
  if (cache.has(cmd)) return cache.get(cmd);
  let found = null;
  if (path.isAbsolute(cmd)) found = isExec(cmd) ? cmd : null;
  else for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const candidate = path.join(dir, cmd);
    if (dir && isExec(candidate)) {
      found = candidate;
      break;
    }
  }
  cache.set(cmd, found);
  return found;
}

function isExec(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** ImageMagick 6 fournit `convert`, ImageMagick 7 seulement `magick`. */
function resolveCommand(cmd) {
  if (cmd === 'convert' && !which('convert') && which('magick')) return 'magick';
  if (cmd === 'pandoc' && process.env.PANDOC_BIN) return process.env.PANDOC_BIN;
  return cmd;
}

/** Outils manquants : [{ cmd, label }]. */
function missingTools() {
  return Object.entries(REQUIRED)
    .filter(([cmd]) => !which(resolveCommand(cmd)))
    .map(([cmd, label]) => ({ cmd, label }));
}

module.exports = { which, resolveCommand, missingTools };
