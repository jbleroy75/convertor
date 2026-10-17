'use strict';

const path = require('path');
const os = require('os');

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

function num(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`Variable ${name} invalide : ${v}`);
  return n;
}

const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));

module.exports = {
  port: num('PORT', 3000),
  host: process.env.HOST || '0.0.0.0',
  // Nombre de proxies de confiance devant l'app (Caddy = 1).
  trustProxy: num('TRUST_PROXY', 1),
  publicUrl: (process.env.PUBLIC_URL || 'https://convertor.jbleroy.fr').replace(/\/$/, ''),

  dataDir,
  tmpDir: path.resolve(process.env.TMP_DIR || path.join(os.tmpdir(), 'convertor')),

  convert: {
    maxFileBytes: num('CONVERT_MAX_FILE_MB', 1024) * MiB,
    maxFiles: num('CONVERT_MAX_FILES', 20),
    timeoutMs: num('CONVERT_TIMEOUT_S', 900) * 1000,
    concurrency: num('CONVERT_CONCURRENCY', Math.max(1, Math.min(4, os.cpus().length - 1))),
  },

  transfer: {
    // Taille d'un bloc chiffré côté client (doit correspondre à public/js/crypto.js).
    chunkBytes: 8 * MiB,
    maxTransferBytes: num('TRANSFER_MAX_GB', 50) * GiB,
    maxStorageBytes: num('TRANSFER_STORAGE_GB', 200) * GiB,
    maxExpirySeconds: 30 * 24 * 3600,
    expiryChoices: [3600, 86400, 3 * 86400, 7 * 86400, 30 * 86400],
    maxDownloadsChoices: [1, 2, 5, 10, 50, 100],
    // Upload non finalisé : supprimé au bout de…
    incompleteTtlMs: 24 * 3600 * 1000,
    // Ticket de téléchargement : durée de validité.
    ticketTtlMs: 12 * 3600 * 1000,
    // Au-delà, le transfert est détruit (anti brute-force du mot de passe).
    maxFailedAuth: 10,
  },
};
