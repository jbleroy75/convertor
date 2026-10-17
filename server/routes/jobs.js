'use strict';

// Mécanique commune aux routes qui traitent des fichiers envoyés : dossier temporaire par requête,
// réception (multer), noms d'affichage sûrs, et renvoi du résultat (fichier seul ou ZIP).

const multer = require('multer');
const archiver = require('archiver');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const config = require('../config');
const { randomId } = require('../security');
const { extOf } = require('../convert');

/** Nom d'affichage sûr (jamais utilisé comme chemin sur le disque). */
function displayBase(originalName) {
  const name = path.basename(String(originalName || 'fichier').replace(/\\/g, '/'));
  const base = name.replace(/\.[^.]*$/, '') || 'fichier';
  return base.replace(/[\u0000-\u001f\u007f"<>:|?*/\\]/g, '_').slice(0, 150);
}

function uniqueName(name, used) {
  if (!used.has(name)) return used.add(name), name;
  const m = /^(.*?)(\.[^.]*)?$/.exec(name);
  for (let i = 2; ; i++) {
    const candidate = `${m[1]} (${i})${m[2] || ''}`;
    if (!used.has(candidate)) return used.add(candidate), candidate;
  }
}

// Chaque requête obtient son propre dossier temporaire ; les noms sur disque sont aléatoires.
const upload = multer({
  storage: multer.diskStorage({
    destination(req, file, cb) {
      cb(null, req.jobDir);
    },
    filename(req, file, cb) {
      const ext = extOf(file.originalname);
      cb(null, `in-${randomId(8)}${ext ? '.' + ext : ''}`);
    },
  }),
  limits: { fileSize: config.convert.maxFileBytes, files: config.convert.maxFiles, fields: 10, fieldSize: 4096 },
});

async function makeJobDir(req, res, next) {
  try {
    req.jobDir = path.join(config.tmpDir, `job-${randomId(12)}`);
    await fsp.mkdir(req.jobDir, { recursive: true, mode: 0o700 });
    let cleaned = false;
    req.cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      fsp.rm(req.jobDir, { recursive: true, force: true }).catch(() => {});
    };
    res.on('close', req.cleanup);
    next();
  } catch (e) {
    next(e);
  }
}

function receiveFiles(req, res, next) {
  upload.array('files', config.convert.maxFiles)(req, res, (err) => {
    if (!err) return next();
    const msg =
      err.code === 'LIMIT_FILE_SIZE'
        ? `Fichier trop volumineux (max ${Math.round(config.convert.maxFileBytes / 1024 ** 2)} Mo)`
        : err.code === 'LIMIT_FILE_COUNT'
          ? `Trop de fichiers (max ${config.convert.maxFiles})`
          : 'Envoi invalide';
    res.status(413).json({ error: msg });
  });
}

/** Renvoie un fichier seul, ou un ZIP s'il y en a plusieurs (ou des erreurs à signaler). */
async function sendResult(res, outputs, errors, zipName, { forceZip = false } = {}) {
  if (outputs.length === 1 && !forceZip && !errors.length) {
    const out = outputs[0];
    const stat = await fsp.stat(out.path);
    res.attachment(out.name);
    res.set('Content-Length', String(stat.size));
    res.set('Cache-Control', 'no-store');
    return fs.createReadStream(out.path).pipe(res);
  }
  return sendZip(res, outputs, errors, zipName);
}

function sendZip(res, entries, errors, zipName) {
  res.attachment(zipName);
  res.set('Cache-Control', 'no-store');
  const archive = archiver('zip', { zlib: { level: 6 }, forceZip64: false });
  archive.on('warning', (e) => console.warn('[zip]', e.message));
  archive.on('error', (e) => {
    console.error('[zip]', e);
    res.destroy(e);
  });
  archive.pipe(res);
  for (const e of entries) {
    // Les médias déjà compressés sont simplement stockés : bien plus rapide.
    const store = /\.(jpe?g|png|gif|webp|mp[34]|m4a|aac|ogg|opus|webm|mkv|mov|avi|zip|docx|xlsx|pptx|od[tsp]|epub|pdf)$/i.test(e.name);
    archive.file(e.path, { name: e.name, store });
  }
  if (errors.length) archive.append(errors.join('\n') + '\n', { name: 'ERREURS.txt' });
  archive.finalize();
}

module.exports = { displayBase, uniqueName, makeJobDir, receiveFiles, sendResult, sendZip };
