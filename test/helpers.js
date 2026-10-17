'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Dossiers isolés pour les tests (à définir AVANT de charger la config).
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'convertor-test-'));
process.env.DATA_DIR = path.join(root, 'data');
process.env.TMP_DIR = path.join(root, 'tmp');
process.env.TRUST_PROXY = '0';

const { createApp } = require('../server');

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

module.exports = { startServer, root };
