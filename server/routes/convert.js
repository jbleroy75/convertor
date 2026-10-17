'use strict';

const express = require('express');
const multer = require('multer');
const archiver = require('archiver');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const config = require('../config');
const { randomId, rateLimit } = require('../security');
const { convertFile, SUPPORTED, extOf } = require('../convert');

const router = express.Router();

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
  limits: { fileSize: config.convert.maxFileBytes, files: config.convert.maxFiles, fields: 10, fieldSize: 1024 },
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

router.get('/formats', (req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.json({ formats: SUPPORTED, maxFileBytes: config.convert.maxFileBytes, maxFiles: config.convert.maxFiles });
});

router.post(
  '/convert',
  rateLimit({ windowMs: 10 * 60_000, max: 60, name: 'conversion' }),
  makeJobDir,
  (req, res, next) =>
    upload.array('files', config.convert.maxFiles)(req, res, (err) => {
      if (!err) return next();
      const msg =
        err.code === 'LIMIT_FILE_SIZE'
          ? `Fichier trop volumineux (max ${Math.round(config.convert.maxFileBytes / 1024 ** 2)} Mo)`
          : err.code === 'LIMIT_FILE_COUNT'
            ? `Trop de fichiers (max ${config.convert.maxFiles})`
            : 'Envoi invalide';
      res.status(413).json({ error: msg });
    }),
  async (req, res, next) => {
    try {
      const files = req.files || [];
      const target = String(req.body.target || '').toLowerCase();
      const forceZip = req.body.zip === '1' || req.body.zip === 'true';
      if (!files.length) return res.status(400).json({ error: 'Aucun fichier reçu' });

      // Mode « zipper uniquement » : on archive les fichiers tels quels.
      if (target === 'zip') {
        const used = new Set();
        return sendZip(
          res,
          files.map((f) => ({ path: f.path, name: uniqueName(`${displayBase(f.originalname)}${extOf(f.originalname) ? '.' + extOf(f.originalname) : ''}`, used) })),
          [],
          files.length === 1 ? `${displayBase(files[0].originalname)}.zip` : 'archive.zip'
        );
      }

      if (!/^[a-z0-9]{1,10}$/.test(target)) return res.status(400).json({ error: 'Format cible invalide' });

      const outputs = [];
      const errors = [];
      const used = new Set();
      // Conversion fichier par fichier (le sémaphore global limite la charge machine).
      await Promise.all(
        files.map(async (f, i) => {
          const from = extOf(f.originalname);
          const base = displayBase(f.originalname);
          const workDir = path.join(req.jobDir, `w${i}`);
          await fsp.mkdir(workDir);
          try {
            if (!SUPPORTED[from]) throw new Error(`Format d’entrée .${from || '?'} non pris en charge`);
            const produced = await convertFile(f.path, from, target, workDir);
            produced.forEach((p, n) => {
              const ext = extOf(p) || target;
              const suffix = produced.length > 1 ? `-${String(n + 1).padStart(3, '0')}` : '';
              outputs.push({ order: i * 10000 + n, path: p, name: `${base}${suffix}.${ext}` });
            });
          } catch (e) {
            console.warn(`[convert] ${from}->${target} : ${e.message}${e.details ? '\n' + e.details : ''}`);
            errors.push(`${f.originalname} : ${e.message}`);
          }
        })
      );
      outputs.sort((a, b) => a.order - b.order);
      outputs.forEach((o) => (o.name = uniqueName(o.name, used)));

      if (!outputs.length) {
        return res.status(422).json({ error: errors.join('\n') || 'Conversion impossible' });
      }

      if (outputs.length === 1 && !forceZip && !errors.length) {
        const out = outputs[0];
        const stat = await fsp.stat(out.path);
        res.attachment(out.name);
        res.set('Content-Length', String(stat.size));
        res.set('Cache-Control', 'no-store');
        return fs.createReadStream(out.path).pipe(res);
      }

      const zipName = files.length === 1 ? `${displayBase(files[0].originalname)}-${target}.zip` : `convertor-${target}.zip`;
      return sendZip(res, outputs, errors, zipName);
    } catch (e) {
      next(e);
    }
  }
);

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

module.exports = router;
