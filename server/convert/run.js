'use strict';

const { spawn } = require('child_process');
const config = require('../config');
const { resolveCommand } = require('./binaries');

/** Sémaphore pour limiter les conversions lourdes simultanées. */
class Semaphore {
  constructor(max) {
    this.max = max;
    this.active = 0;
    this.queue = [];
  }
  async acquire() {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    await new Promise((resolve) => this.queue.push(resolve));
    this.active++;
  }
  release() {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
  async use(fn) {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

const slots = new Semaphore(config.convert.concurrency);

/**
 * Lance un binaire SANS shell (arguments en tableau), avec timeout dur.
 * Rejette avec la fin de stderr si le code de sortie n'est pas 0.
 */
function run(cmd, args, { cwd, timeoutMs = config.convert.timeoutMs, env } = {}) {
  cmd = resolveCommand(cmd);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { PATH: process.env.PATH, HOME: cwd || process.env.HOME, LANG: 'C.UTF-8', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    let stdout = '';
    const keep = (s, d) => (s + d).slice(-4000);
    child.stdout.on('data', (d) => (stdout = keep(stdout, d)));
    child.stderr.on('data', (d) => (stderr = keep(stderr, d)));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err.code === 'ENOENT' ? new Error(`Outil manquant sur le serveur : ${cmd}`) : err);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ stdout, stderr });
      const why = signal === 'SIGKILL' ? 'délai dépassé' : `code ${code}`;
      const err = new Error(`${cmd} a échoué (${why})`);
      err.details = stderr.trim().split('\n').slice(-5).join('\n');
      reject(err);
    });
  });
}

module.exports = { run, slots, Semaphore };
