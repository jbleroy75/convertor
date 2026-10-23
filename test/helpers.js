'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// Dossiers isolés pour les tests (à définir AVANT de charger la config).
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'convertor-test-'));
process.env.DATA_DIR = path.join(root, 'data');
process.env.TMP_DIR = path.join(root, 'tmp');
process.env.TRUST_PROXY = '0';

const { createApp } = require('../server');
const { which, resolveCommand } = require('../server/convert/binaries');

async function startServer() {
  const { app, store } = await createApp();
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    store,
    async close() {
      clearInterval(store.timer);
      await new Promise((r) => server.close(r));
    },
  };
}

// ---------------------------------------------------------------------------
// Outils système (ImageMagick, FFmpeg, LibreOffice, Poppler, Ghostscript, pandoc).
// Ils sont tous dans l'image Docker du site, mais pas forcément sur le poste ou en CI
// (node:22-bookworm n'a qu'ImageMagick, avec une politique qui interdit le PDF).
// Un test qui en dépend est sauté avec la raison, au lieu d'échouer.
// ---------------------------------------------------------------------------

/** Capacités qui ne se résument pas à la présence d'une commande. */
const CAPABILITIES = {
  // Debian interdit le coder PDF dans /etc/ImageMagick-6/policy.xml ; l'image du site
  // installe deploy/imagemagick-policy.xml qui l'autorise (écriture native, sans Ghostscript).
  'convert:pdf': {
    needs: ['convert'],
    label: 'écriture PDF par ImageMagick (interdite par la politique de sécurité de ce système)',
    probe() {
      const dir = fs.mkdtempSync(path.join(root, 'probe-'));
      try {
        execFileSync(resolveCommand('convert'), ['-size', '8x8', 'xc:gray', `pdf:${path.join(dir, 'p.pdf')}`], { stdio: 'ignore' });
        return true;
      } catch {
        return false;
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
};

const probed = new Map();
function available(req) {
  if (!probed.has(req)) {
    const cap = CAPABILITIES[req];
    probed.set(req, cap ? cap.needs.every(available) && cap.probe() : !!which(resolveCommand(req)));
  }
  return probed.get(req);
}

/**
 * Options node:test : `{ skip: 'raison' }` si une exigence manque, sinon `{}`.
 * Exigences : noms de commandes (`ffmpeg`, `pdfinfo`…) ou capacités (`convert:pdf`).
 */
function needs(...reqs) {
  const missing = [...new Set(reqs)].filter((r) => !available(r));
  if (!missing.length) return {};
  const names = missing.map((r) => CAPABILITIES[r]?.label || r);
  return { skip: `outil(s) absent(s) : ${names.join(', ')} — présents dans l’image Docker du site` };
}

/** Lance une commande de préparation (ImageMagick 7 : `magick` à la place de `convert`). */
function sh(cwd, cmd, args) {
  return execFileSync(resolveCommand(cmd), args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
}

module.exports = { startServer, root, available, needs, sh };
