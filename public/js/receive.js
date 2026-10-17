/* Page de réception : /t/<id>#<secret> */
(function () {
  'use strict';
  const { $, el, formatBytes, formatDate, showError, saveBlob, apiJson, setProgress, speedometer } = window.UI;
  const C = window.ConvertorCrypto;

  const id = location.pathname.split('/')[2] || '';
  const secretStr = location.hash.slice(1);
  const error = $('#error');
  let keys = null;
  let opened = null;
  let meta = null;

  // Prépare le service worker de déchiffrement en flux (indispensable pour les très gros fichiers).
  const swReady =
    'serviceWorker' in navigator && window.isSecureContext
      ? navigator.serviceWorker
          .register('/sw.js', { scope: '/' })
          .then(() => navigator.serviceWorker.ready)
          .catch(() => null)
      : Promise.resolve(null);

  function fail(msg) {
    $('#loading').hidden = true;
    showError(error, msg);
  }

  async function start() {
    let secret;
    try {
      secret = C.b64urlDecode(secretStr);
      if (secret.length !== 32) throw new Error();
    } catch {
      return fail('Lien incomplet : la clé de déchiffrement (après le #) est manquante ou abîmée. Vérifiez que vous avez copié le lien en entier.');
    }
    let params;
    try {
      params = await apiJson(`/api/transfers/${encodeURIComponent(id)}/params`);
    } catch (e) {
      return fail(e.status === 404 ? 'Ce transfert n’existe pas, a expiré, ou a atteint son nombre maximum de téléchargements.' : e.message);
    }
    const base = { secret, hkdfSalt: C.b64urlDecode(params.hkdfSalt) };

    if (!params.hasPassword) {
      keys = await C.deriveKeys(base);
      return open();
    }

    $('#loading').hidden = true;
    $('#password-card').hidden = false;
    $('#password').focus();
    $('#password-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      showError(error, '');
      const btn = $('#unlock');
      btn.disabled = true;
      btn.textContent = 'Vérification…';
      try {
        keys = await C.deriveKeys({ ...base, password: $('#password').value, pwSalt: C.b64urlDecode(params.pwSalt), pwIter: params.pwIter });
        if (await open()) $('#password-card').hidden = true;
      } finally {
        btn.disabled = false;
        btn.textContent = 'Déverrouiller';
      }
    });
  }

  const authHeaders = () => ({ 'X-Auth': C.b64urlEncode(keys.authToken) });

  async function open() {
    try {
      opened = await apiJson(`/api/transfers/${encodeURIComponent(id)}/open`, { method: 'POST', headers: authHeaders() });
      meta = await C.decryptMeta(keys.metaKey, C.b64urlDecode(opened.encMeta));
    } catch (e) {
      if (e.status === 403) {
        showError(error, `Mot de passe incorrect. ${e.body?.attemptsLeft ?? ''} essai(s) restant(s) avant destruction du transfert.`);
        return false;
      }
      fail(e.status === 410 ? 'Trop de tentatives : le transfert a été détruit.' : e.status === 404 ? 'Ce transfert n’existe plus.' : e.message);
      return false;
    }
    $('#loading').hidden = true;
    $('#file-card').hidden = false;
    $('#file-name').textContent = meta.name;
    document.title = `${meta.name} — Convertor`;
    $('#file-info').textContent =
      `${formatBytes(meta.size)} · disponible jusqu’au ${formatDate(opened.expiresAt)} · ` +
      `${opened.downloadsLeft} téléchargement(s) restant(s)`;
    if (meta.zipped && meta.files?.length) {
      $('#file-list-box').hidden = false;
      $('#file-list').replaceChildren(
        ...meta.files.map((f) => el('li', {}, el('span', {}, f.name), el('span', {}, formatBytes(f.size)))),
        meta.fileCount > meta.files.length ? el('li', {}, el('span', {}, `… et ${meta.fileCount - meta.files.length} autres`), el('span')) : null
      );
    }
    return true;
  }

  $('#download').addEventListener('click', async () => {
    const btn = $('#download');
    btn.disabled = true;
    showError(error, '');
    const prog = $('#dl-progress');
    setProgress(prog, null, 'Préparation…');
    try {
      const { ticket, downloadsLeft } = await apiJson(`/api/transfers/${encodeURIComponent(id)}/claim`, { method: 'POST', headers: authHeaders() });
      const reg = await swReady;
      const job = { transferId: id, ticket, chunkCount: opened.chunkCount, size: meta.size, filename: meta.name, fileKey: keys.fileKey };
      if (reg?.active) await viaServiceWorker(reg.active, job, prog);
      else await inMemory(job, prog);
      setProgress(prog, 1, `✅ Fichier déchiffré et enregistré (${formatBytes(meta.size)}). Intégrité vérifiée.` + (downloadsLeft ? '' : ' Ce lien est maintenant détruit.'));
    } catch (e) {
      prog.hidden = true;
      showError(error, `Échec du téléchargement : ${e.message}`);
      btn.disabled = false;
    }
  });

  /** Déchiffrement en flux dans le service worker : aucune limite de taille. */
  function viaServiceWorker(worker, job, prog) {
    return new Promise((resolve, reject) => {
      const channel = new MessageChannel();
      const dlId = C.b64urlEncode(C.randomBytes(16));
      const speed = speedometer();
      let iframe;
      channel.port1.onmessage = ({ data }) => {
        if (data.type === 'ready') {
          iframe = el('iframe', { hidden: true, src: `/__dl/${dlId}` });
          document.body.append(iframe);
        } else if (data.type === 'progress') {
          setProgress(prog, data.written / Math.max(data.size, 1), `Téléchargement et déchiffrement : ${speed(data.written, data.size)}`);
        } else if (data.type === 'done') {
          setTimeout(() => iframe?.remove(), 30000);
          resolve();
        } else if (data.type === 'error') {
          iframe?.remove();
          reject(new Error(data.message));
        }
      };
      worker.postMessage({ type: 'download', dlId, ...job }, [channel.port2]);
    });
  }

  /** Repli sans service worker (navigation privée…) : assemblage en mémoire. */
  async function inMemory(job, prog) {
    const parts = [];
    const speed = speedometer();
    let written = 0;
    for (let i = 0; i < job.chunkCount; i++) {
      let res;
      for (let attempt = 0; ; attempt++) {
        try {
          res = await fetch(`/api/transfers/${job.transferId}/chunks/${i}`, { headers: { 'X-Ticket': job.ticket }, cache: 'no-store', credentials: 'omit' });
          if (res.ok || res.status === 404 || attempt >= 4) break;
        } catch (e) {
          if (attempt >= 4) throw e;
        }
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      }
      if (!res.ok) throw new Error(res.status === 404 ? 'Transfert expiré' : `HTTP ${res.status}`);
      const plain = await C.decryptChunk(job.fileKey, i, i === job.chunkCount - 1, new Uint8Array(await res.arrayBuffer()));
      parts.push(plain);
      written += plain.length;
      setProgress(prog, written / Math.max(job.size, 1), `Téléchargement et déchiffrement : ${speed(written, job.size)}`);
    }
    if (written !== job.size) throw new Error('Taille finale incohérente');
    saveBlob(new Blob(parts, { type: 'application/octet-stream' }), job.filename);
  }

  start().catch((e) => fail(e.message));
})();
