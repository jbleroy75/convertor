'use strict';

const crypto = require('crypto');
const fsp = require('fs/promises');
const path = require('path');
const config = require('../config');

const ID_RE = /^[A-Za-z0-9_-]{22}$/;

/**
 * Stockage des transferts sur disque :
 *   <dataDir>/transfers/<id>/meta.json
 *   <dataDir>/transfers/<id>/<index>.bin   (blocs chiffrés, opaques pour le serveur)
 */
class TransferStore {
  constructor(root = path.join(config.dataDir, 'transfers')) {
    this.root = root;
    this.items = new Map();
    this.saving = new Map();
  }

  async init() {
    await fsp.mkdir(this.root, { recursive: true, mode: 0o700 });
    for (const id of await fsp.readdir(this.root)) {
      if (!ID_RE.test(id)) continue;
      try {
        const t = JSON.parse(await fsp.readFile(this.metaPath(id), 'utf8'));
        t.tickets = {};
        this.items.set(id, t);
      } catch {
        await fsp.rm(this.dir(id), { recursive: true, force: true });
      }
    }
    await this.sweep();
    this.timer = setInterval(() => this.sweep().catch((e) => console.error('[sweep]', e)), 60_000);
    this.timer.unref();
  }

  dir(id) {
    return path.join(this.root, id);
  }
  metaPath(id) {
    return path.join(this.dir(id), 'meta.json');
  }
  chunkPath(id, index) {
    return path.join(this.dir(id), `${index}.bin`);
  }

  get(id) {
    if (!ID_RE.test(id)) return null;
    const t = this.items.get(id);
    if (!t || t.deleted) return null;
    return t;
  }

  /** Transfert finalisé, non expiré, avec des téléchargements restants. */
  getAvailable(id) {
    const t = this.get(id);
    if (!t || !t.complete || t.expiresAt <= Date.now()) return null;
    return t;
  }

  usedBytes() {
    let n = 0;
    for (const t of this.items.values()) n += t.storedBytes;
    return n;
  }

  async create(t) {
    await fsp.mkdir(this.dir(t.id), { mode: 0o700 });
    t.tickets = {};
    this.items.set(t.id, t);
    await this.save(t);
  }

  /**
   * Les blocs arrivent en parallèle : les écritures d'un même transfert sont mises en file,
   * et chacune sérialise l'état courant au moment où elle s'exécute (la dernière gagne).
   */
  save(t) {
    const previous = this.saving.get(t.id) || Promise.resolve();
    const next = previous.catch(() => {}).then(() => this.write(t));
    this.saving.set(t.id, next);
    next.finally(() => this.saving.get(t.id) === next && this.saving.delete(t.id)).catch(() => {});
    return next;
  }

  async write(t) {
    if (t.deleted) return;
    const { tickets, ...persisted } = t;
    const tmp = `${this.metaPath(t.id)}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(persisted), { mode: 0o600 });
    if (t.deleted) return fsp.rm(tmp, { force: true });
    await fsp.rename(tmp, this.metaPath(t.id));
  }

  async destroy(id) {
    const t = this.items.get(id);
    if (t) t.deleted = true;
    this.items.delete(id);
    await fsp.rm(this.dir(id), { recursive: true, force: true });
  }

  async sweep() {
    const now = Date.now();
    for (const t of [...this.items.values()]) {
      for (const [k, tk] of Object.entries(t.tickets)) if (tk.expiresAt <= now) delete t.tickets[k];
      const expired = t.complete && t.expiresAt <= now;
      const abandoned = !t.complete && now - t.createdAt > config.transfer.incompleteTtlMs;
      const exhausted = t.complete && t.downloads >= t.maxDownloads && !Object.keys(t.tickets).length;
      if (expired || abandoned || exhausted) await this.destroy(t.id);
    }
  }
}

module.exports = { TransferStore, ID_RE };
