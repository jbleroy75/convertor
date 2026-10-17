'use strict';

const express = require('express');
const fsp = require('fs/promises');
const path = require('path');
const config = require('./config');
const { securityHeaders } = require('./security');
const { TransferStore } = require('./transfers/store');
const convertRouter = require('./routes/convert');
const transfersRouter = require('./routes/transfers');

async function createApp({ store } = {}) {
  await fsp.mkdir(config.tmpDir, { recursive: true, mode: 0o700 });
  store ??= new TransferStore();
  await store.init();

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.use(securityHeaders);

  const pub = path.join(__dirname, '..', 'public');
  app.get('/healthz', (req, res) => res.json({ ok: true }));
  app.use('/api', convertRouter);
  app.use('/api/transfers', transfersRouter(store));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Introuvable' }));

  app.get('/vendor/fflate.js', (req, res) =>
    res.sendFile(path.join(__dirname, '..', 'node_modules', 'fflate', 'umd', 'index.js'), { maxAge: '7d', headers: { 'Content-Type': 'text/javascript; charset=utf-8' } })
  );
  // Page de réception : /t/<id>#<clé>  (la clé, dans le fragment, n'est jamais envoyée au serveur).
  app.get('/t/:id', (req, res) => res.sendFile(path.join(pub, 'receive.html'), { headers: { 'Cache-Control': 'no-store' } }));
  // Le service worker de téléchargement doit pouvoir contrôler tout le site.
  app.get('/sw.js', (req, res) => res.sendFile(path.join(pub, 'sw.js'), { headers: { 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/' } }));
  app.use(express.static(pub, { index: 'index.html', maxAge: '1h' }));

  app.use((err, req, res, next) => {
    console.error(err);
    if (res.headersSent) return res.destroy();
    res.status(500).json({ error: 'Erreur interne du serveur' });
  });

  return { app, store };
}

if (require.main === module) {
  createApp().then(({ app }) => {
    const server = app.listen(config.port, config.host, () => console.log(`Convertor en écoute sur http://${config.host}:${config.port}`));
    // Gros fichiers : pas de délai global sur la requête (Caddy protège en amont).
    server.requestTimeout = 0;
    server.headersTimeout = 60_000;
    server.keepAliveTimeout = 65_000;
    const stop = () => server.close(() => process.exit(0));
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
  });
}

module.exports = { createApp };
