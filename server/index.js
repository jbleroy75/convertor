'use strict';

const express = require('express');
const fsp = require('fs/promises');
const path = require('path');
const config = require('./config');
const { securityHeaders } = require('./security');
const { missingTools } = require('./convert/binaries');
const { TransferStore } = require('./transfers/store');
const convertRouter = require('./routes/convert');
const transfersRouter = require('./routes/transfers');
const toolsRouter = require('./routes/tools');

async function createApp({ store } = {}) {
  await fsp.mkdir(config.tmpDir, { recursive: true, mode: 0o700 });
  store ??= new TransferStore();
  await store.init();

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.use(securityHeaders);

  const pub = path.join(__dirname, '..', 'public');
  // Liste aussi les outils de conversion absents : diagnostic d'un déploiement incomplet
  // (ex. image construite sans le Dockerfile du projet).
  app.get('/healthz', (req, res) => {
    const missing = missingTools().map((t) => t.cmd);
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, tools: missing.length ? 'incomplete' : 'ok', missing });
  });
  app.use('/api', convertRouter);
  app.use('/api/transfers', transfersRouter(store));
  app.use('/api/tools', toolsRouter);
  app.use('/api', (req, res) => res.status(404).json({ error: 'Introuvable' }));

  app.get('/vendor/fflate.js', (req, res) =>
    res.sendFile(path.join(__dirname, '..', 'node_modules', 'fflate', 'umd', 'index.js'), { headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' } })
  );
  // Page de réception : /t/<id>#<clé>  (la clé, dans le fragment, n'est jamais envoyée au serveur).
  app.get('/t/:id', (req, res) => res.sendFile(path.join(pub, 'receive.html'), { headers: { 'Cache-Control': 'no-store' } }));
  // Le service worker de téléchargement doit pouvoir contrôler tout le site.
  app.get('/sw.js', (req, res) => res.sendFile(path.join(pub, 'sw.js'), { headers: { 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/' } }));
  app.use(
    express.static(pub, {
      index: 'index.html',
      setHeaders(res, file) {
        // Polices et icône : immuables. Pages, scripts et styles : toujours revalidés (ETag),
        // sinon un navigateur peut garder une ancienne version après un déploiement.
        res.set('Cache-Control', /\.(woff2|svg)$/.test(file) ? 'public, max-age=604800' : 'no-cache');
      },
    })
  );

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
    const missing = missingTools();
    if (missing.length)
      console.warn(
        `⚠️  Outils absents : ${missing.map((t) => `${t.cmd} (${t.label})`).join(', ')}.\n` +
          '   Les conversions correspondantes échoueront. Construisez l’image avec le Dockerfile du projet ' +
          '(Coolify : Build Pack « Dockerfile », pas Nixpacks).'
      );
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
