'use strict';

const express = require('express');
const fs = require('fs');
const fsp = require('fs/promises');
const config = require('../config');
const { rateLimit, sha256, safeEqual, randomId, b64 } = require('../security');

const T = config.transfer;
// Taille max d'un bloc chiffré : bloc clair + tag GCM (16 o).
const MAX_CHUNK = T.chunkBytes + 16;
const MAX_CHUNKS = Math.ceil(T.maxTransferBytes / T.chunkBytes) + 1;
const MAX_META = 64 * 1024;

module.exports = function transfersRouter(store) {
  const router = express.Router();
  const json = express.json({ limit: '128kb' });

  const notFound = (res) => res.status(404).json({ error: 'Transfert introuvable ou expiré' });

  function bearer(req) {
    const m = /^Bearer ([A-Za-z0-9_-]{1,100})$/.exec(req.get('authorization') || '');
    return m ? b64(m[1]) : null;
  }

  function requireOwner(req, res, next) {
    const t = store.get(req.params.id);
    const token = bearer(req);
    if (!t || !token || !safeEqual(sha256(token), Buffer.from(t.ownerHash, 'base64url'))) return notFound(res);
    req.transfer = t;
    next();
  }

  /** Vérifie le jeton d'accès dérivé de la clé (prouve la possession du lien + mot de passe). */
  async function requireReader(req, res, next) {
    const t = store.getAvailable(req.params.id);
    if (!t) return notFound(res);
    const token = b64(req.get('x-auth') || '', 32);
    if (!token || !safeEqual(sha256(token), Buffer.from(t.authHash, 'base64url'))) {
      t.failedAuth = (t.failedAuth || 0) + 1;
      if (t.failedAuth >= T.maxFailedAuth) {
        console.warn(`[transfer] ${t.id} détruit après ${t.failedAuth} échecs d'authentification`);
        await store.destroy(t.id);
        return res.status(410).json({ error: 'Trop de tentatives : le transfert a été détruit.' });
      }
      await store.save(t);
      return res.status(403).json({ error: 'Mot de passe ou lien invalide', attemptsLeft: T.maxFailedAuth - t.failedAuth });
    }
    req.transfer = t;
    next();
  }

  // --- Envoi ------------------------------------------------------------------

  router.post('/', rateLimit({ windowMs: 3600_000, max: 30, name: 'création de transfert' }), json, async (req, res, next) => {
    try {
      const b = req.body || {};
      const expiresIn = Number(b.expiresIn);
      const maxDownloads = Number(b.maxDownloads);
      const hkdfSalt = b64(b.hkdfSalt, 16);
      const authHash = b64(b.authHash, 32);
      const hasPassword = b.hasPassword === true;
      const pwSalt = hasPassword ? b64(b.pwSalt, 16) : null;
      const pwIter = hasPassword ? Number(b.pwIter) : 0;
      if (b.v !== 1 || !T.expiryChoices.includes(expiresIn) || !T.maxDownloadsChoices.includes(maxDownloads) || !hkdfSalt || !authHash)
        return res.status(400).json({ error: 'Paramètres invalides' });
      if (hasPassword && (!pwSalt || !Number.isInteger(pwIter) || pwIter < 100_000 || pwIter > 10_000_000))
        return res.status(400).json({ error: 'Paramètres de mot de passe invalides' });
      if (store.usedBytes() >= T.maxStorageBytes) return res.status(507).json({ error: 'Stockage du serveur plein, réessayez plus tard.' });

      const ownerToken = randomId(32);
      const t = {
        v: 1,
        id: randomId(16),
        createdAt: Date.now(),
        expiresIn,
        expiresAt: 0,
        maxDownloads,
        downloads: 0,
        hkdfSalt: hkdfSalt.toString('base64url'),
        hasPassword,
        pwSalt: pwSalt ? pwSalt.toString('base64url') : null,
        pwIter,
        authHash: authHash.toString('base64url'),
        ownerHash: sha256(Buffer.from(ownerToken, 'base64url')).toString('base64url'),
        chunks: {},
        storedBytes: 0,
        complete: false,
        failedAuth: 0,
      };
      await store.create(t);
      res.status(201).json({ id: t.id, ownerToken, chunkBytes: T.chunkBytes, maxBytes: T.maxTransferBytes });
    } catch (e) {
      next(e);
    }
  });

  router.put('/:id/chunks/:index', requireOwner, (req, res, next) => {
    const t = req.transfer;
    const index = Number(req.params.index);
    if (t.complete) return res.status(409).json({ error: 'Transfert déjà finalisé' });
    if (!Number.isInteger(index) || index < 0 || index >= MAX_CHUNKS || !/^\d+$/.test(req.params.index))
      return res.status(400).json({ error: 'Index de bloc invalide' });
    const declared = Number(req.get('content-length'));
    if (!Number.isFinite(declared) || declared < 16 || declared > MAX_CHUNK) return res.status(413).json({ error: 'Bloc de taille invalide' });
    const previous = t.chunks[index] || 0;
    if (t.storedBytes - previous + declared > T.maxTransferBytes)
      return res.status(413).json({ error: `Transfert trop volumineux (max ${T.maxTransferBytes / 1024 ** 3} Go)` });
    if (store.usedBytes() + declared > T.maxStorageBytes) return res.status(507).json({ error: 'Stockage du serveur plein' });

    const final = store.chunkPath(t.id, index);
    const tmp = `${final}.${randomId(6)}.part`;
    const out = fs.createWriteStream(tmp, { mode: 0o600 });
    let received = 0;
    let failed = false;
    const fail = (status, msg) => {
      if (failed) return;
      failed = true;
      out.destroy();
      fsp.rm(tmp, { force: true }).catch(() => {});
      if (!res.headersSent) res.status(status).json({ error: msg });
    };
    req.on('data', (d) => {
      received += d.length;
      if (received > declared) {
        req.unpipe(out);
        fail(400, 'Bloc plus grand qu’annoncé');
      }
    });
    req.on('aborted', () => fail(400, 'Envoi interrompu'));
    out.on('error', (e) => {
      console.error('[chunk]', e);
      fail(500, 'Erreur d’écriture');
    });
    out.on('finish', async () => {
      if (failed) return;
      if (received !== declared) return fail(400, 'Bloc incomplet');
      try {
        if (!store.get(t.id)) return fail(404, 'Transfert supprimé');
        await fsp.rename(tmp, final);
        t.storedBytes += received - (t.chunks[index] || 0);
        t.chunks[index] = received;
        await store.save(t);
        res.status(204).end();
      } catch (e) {
        next(e);
      }
    });
    req.pipe(out);
  });

  router.post('/:id/complete', requireOwner, json, async (req, res, next) => {
    try {
      const t = req.transfer;
      if (t.complete) return res.status(409).json({ error: 'Transfert déjà finalisé' });
      const chunkCount = Number(req.body?.chunkCount);
      const encMeta = b64(req.body?.encMeta);
      if (!Number.isInteger(chunkCount) || chunkCount < 1 || chunkCount > MAX_CHUNKS) return res.status(400).json({ error: 'Nombre de blocs invalide' });
      if (!encMeta || encMeta.length < 17 || encMeta.length > MAX_META) return res.status(400).json({ error: 'Métadonnées invalides' });
      const indexes = Object.keys(t.chunks).map(Number);
      if (indexes.length !== chunkCount || indexes.some((i) => i >= chunkCount))
        return res.status(400).json({ error: 'Blocs manquants ou en trop' });
      // Tous les blocs sauf le dernier doivent être pleins.
      for (let i = 0; i < chunkCount - 1; i++) if (t.chunks[i] !== MAX_CHUNK) return res.status(400).json({ error: `Bloc ${i} incomplet` });
      t.chunkCount = chunkCount;
      t.encMeta = encMeta.toString('base64url');
      t.complete = true;
      t.expiresAt = Date.now() + t.expiresIn * 1000;
      await store.save(t);
      res.json({ id: t.id, expiresAt: t.expiresAt, maxDownloads: t.maxDownloads });
    } catch (e) {
      next(e);
    }
  });

  router.get('/:id/status', requireOwner, (req, res) => {
    const t = req.transfer;
    res.json({ complete: t.complete, expiresAt: t.expiresAt, downloads: t.downloads, maxDownloads: t.maxDownloads });
  });

  router.delete('/:id', requireOwner, async (req, res, next) => {
    try {
      await store.destroy(req.transfer.id);
      res.status(204).end();
    } catch (e) {
      next(e);
    }
  });

  // --- Réception --------------------------------------------------------------

  const readLimit = rateLimit({ windowMs: 15 * 60_000, max: 60, name: 'accès transfert' });

  router.get('/:id/params', readLimit, (req, res) => {
    const t = store.getAvailable(req.params.id);
    if (!t || t.downloads >= t.maxDownloads) return notFound(res);
    res.set('Cache-Control', 'no-store');
    res.json({ v: t.v, hasPassword: t.hasPassword, pwSalt: t.pwSalt, pwIter: t.pwIter, hkdfSalt: t.hkdfSalt });
  });

  router.post('/:id/open', readLimit, requireReader, (req, res) => {
    const t = req.transfer;
    if (t.downloads >= t.maxDownloads) return notFound(res);
    res.set('Cache-Control', 'no-store');
    res.json({
      encMeta: t.encMeta,
      chunkCount: t.chunkCount,
      storedBytes: t.storedBytes,
      expiresAt: t.expiresAt,
      downloadsLeft: t.maxDownloads - t.downloads,
    });
  });

  router.post('/:id/claim', readLimit, requireReader, async (req, res, next) => {
    try {
      const t = req.transfer;
      if (t.downloads >= t.maxDownloads) return notFound(res);
      t.downloads++;
      const ticket = randomId(24);
      t.tickets[ticket] = { expiresAt: Date.now() + T.ticketTtlMs };
      await store.save(t);
      res.set('Cache-Control', 'no-store');
      res.json({ ticket, downloadsLeft: t.maxDownloads - t.downloads });
    } catch (e) {
      next(e);
    }
  });

  router.get('/:id/chunks/:index', async (req, res) => {
    const t = store.get(req.params.id);
    const ticket = req.get('x-ticket') || '';
    const tk = t && Object.hasOwn(t.tickets, ticket) ? t.tickets[ticket] : null;
    if (!t || !t.complete || !tk || tk.expiresAt <= Date.now()) return notFound(res);
    const index = Number(req.params.index);
    if (!/^\d+$/.test(req.params.index) || index >= t.chunkCount) return res.status(400).json({ error: 'Index invalide' });
    res.set('Content-Type', 'application/octet-stream');
    res.set('Content-Length', String(t.chunks[index]));
    res.set('Cache-Control', 'no-store');
    const stream = fs.createReadStream(store.chunkPath(t.id, index));
    stream.on('error', () => res.destroy());
    res.on('finish', () => {
      // Dernier bloc servi : ce téléchargement est terminé.
      if (index === t.chunkCount - 1) {
        delete t.tickets[ticket];
        if (t.downloads >= t.maxDownloads && !Object.keys(t.tickets).length) store.destroy(t.id).catch(() => {});
      }
    });
    stream.pipe(res);
  });

  return router;
};
