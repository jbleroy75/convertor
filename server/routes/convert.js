'use strict';

const express = require('express');
const fsp = require('fs/promises');
const path = require('path');
const config = require('../config');
const { rateLimit } = require('../security');
const { convertFile, SUPPORTED, extOf } = require('../convert');
const { displayBase, uniqueName, makeJobDir, receiveFiles, sendResult, sendZip } = require('./jobs');

const router = express.Router();

router.get('/formats', (req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.json({ formats: SUPPORTED, maxFileBytes: config.convert.maxFileBytes, maxFiles: config.convert.maxFiles });
});

router.post(
  '/convert',
  rateLimit({ windowMs: 10 * 60_000, max: 60, name: 'conversion' }),
  makeJobDir,
  receiveFiles,
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

      const zipName = files.length === 1 ? `${displayBase(files[0].originalname)}-${target}.zip` : `convertor-${target}.zip`;
      return sendResult(res, outputs, errors, zipName, { forceZip });
    } catch (e) {
      next(e);
    }
  }
);

module.exports = router;
