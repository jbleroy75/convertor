'use strict';

const express = require('express');
const { rateLimit } = require('../security');
const { extOf } = require('../convert');
const { runTool, toolList, ToolError } = require('../tools');
const { displayBase, uniqueName, makeJobDir, receiveFiles, sendResult, sendZip } = require('./jobs');

const router = express.Router();

const ZIP_NAMES = {
  compress: 'compresse',
  'pdf-split': 'pages',
  'pdf-extract': 'pages-extraites',
  'image-resize': 'redimensionne',
  'image-rotate': 'pivote',
  'media-trim': 'extraits',
};

router.get('/', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.json({ tools: toolList() });
});

router.post(
  '/:id',
  rateLimit({ windowMs: 10 * 60_000, max: 60, name: 'outils' }),
  makeJobDir,
  receiveFiles,
  async (req, res, next) => {
    try {
      const id = req.params.id;
      const files = (req.files || []).map((f) => ({
        path: f.path,
        ext: extOf(f.originalname),
        base: displayBase(f.originalname),
        originalName: f.originalname,
      }));
      if (!files.length) return res.status(400).json({ error: 'Aucun fichier reçu' });

      if (id === 'zip') {
        const used = new Set();
        const entries = files.map((f) => ({ path: f.path, name: uniqueName(`${f.base}${f.ext ? '.' + f.ext : ''}`, used) }));
        return sendZip(res, entries, [], files.length === 1 ? `${files[0].base}.zip` : 'archive.zip');
      }

      let options = {};
      if (req.body.options) {
        try {
          options = JSON.parse(req.body.options);
        } catch {
          return res.status(400).json({ error: 'Options invalides' });
        }
        if (!options || typeof options !== 'object' || Array.isArray(options)) return res.status(400).json({ error: 'Options invalides' });
      }

      let result;
      try {
        result = await runTool(id, files, options, req.jobDir);
      } catch (e) {
        if (e instanceof ToolError) return res.status(422).json({ error: e.message });
        console.warn(`[tool:${id}] ${e.message}${e.details ? '\n' + e.details : ''}`);
        return res.status(422).json({ error: 'Traitement impossible : un fichier est peut-être abîmé ou non pris en charge.' });
      }
      const { outputs, errors } = result;
      if (!outputs.length) return res.status(422).json({ error: errors.join('\n') || 'Traitement impossible' });

      const used = new Set();
      outputs.forEach((o) => (o.name = uniqueName(o.name, used)));

      // Gains de la compression, lus par l'interface (en-tête ASCII : JSON encodé).
      if (id === 'compress') {
        const stats = outputs.map((o) => ({ name: o.name, before: o.before, after: o.after, kept: !!o.kept }));
        res.set('X-Convertor-Stats', encodeURIComponent(JSON.stringify(stats)));
      }

      const zipName = files.length === 1 && outputs.length > 1 ? `${files[0].base}-${ZIP_NAMES[id] || id}.zip` : `convertor-${ZIP_NAMES[id] || id}.zip`;
      return sendResult(res, outputs, errors, zipName);
    } catch (e) {
      next(e);
    }
  }
);

module.exports = router;
