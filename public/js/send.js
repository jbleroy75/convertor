/* Onglet « Transfert sécurisé » : chiffrement dans le navigateur puis envoi par blocs. */
(function () {
  'use strict';
  const { $, el, formatBytes, formatDate, setupDrop, showError, apiJson, setProgress, speedometer } = window.UI;
  const C = window.ConvertorCrypto;

  const PARALLEL_UPLOADS = 3;
  const ZIP_LIMIT = 4 * 1024 ** 3 - 64 * 1024 ** 2; // pas de ZIP64 côté navigateur
  const STORE_KEY = 'convertor.transfers';
  const STORED_EXT = /\.(jpe?g|png|gif|webp|avif|heic|mp[34]|m4[av]|aac|ogg|opus|flac|webm|mkv|mov|avi|zip|7z|rar|gz|bz2|xz|zst|docx|xlsx|pptx|od[tsp]|epub|pdf|iso|dmg)$/i;

  let files = [];
  let running = null;

  const drop = $('#send-drop');
  const list = $('#send-files');
  const options = $('#send-options');
  const pw = $('#send-password');
  const zipBox = $('#send-zip');
  const go = $('#send-go');
  const progress = $('#send-progress');
  const error = $('#send-error');
  const card = $('#send-card');
  const result = $('#send-result');

  const addFiles = (added) => {
    showError(error, '');
    files = files.concat(added);
    render();
  };
  setupDrop(drop, $('#send-input'), addFiles);
  const folderInput = $('#send-folder-input');
  $('#send-folder').addEventListener('click', () => folderInput.click());
  folderInput.addEventListener('change', () => {
    addFiles([...folderInput.files]);
    folderInput.value = '';
  });
  $('#send-clear').addEventListener('click', () => {
    files = [];
    render();
  });

  const pathOf = (f) => f.webkitRelativePath || f.name;
  const totalSize = () => files.reduce((s, f) => s + f.size, 0);

  function render() {
    const shown = files.slice(0, 200);
    list.replaceChildren(
      ...shown.map((f, i) =>
        el(
          'li',
          {},
          el('span', { class: 'name', title: pathOf(f) }, pathOf(f)),
          el('span', { class: 'size' }, formatBytes(f.size)),
          el('button', { class: 'rm', 'aria-label': `Retirer ${f.name}`, onclick: () => (files.splice(i, 1), render()) }, '×')
        )
      ),
      files.length > shown.length ? el('li', { class: 'muted' }, `… et ${files.length - shown.length} autres fichiers`) : null,
      files.length > 1 ? el('li', { class: 'muted' }, `${files.length} fichiers · ${formatBytes(totalSize())} au total`) : null
    );
    options.hidden = !files.length;
    zipBox.disabled = files.length > 1;
    if (files.length > 1) zipBox.checked = true;
  }

  // --- Mot de passe --------------------------------------------------------

  $('#send-pw-show').addEventListener('click', (e) => {
    const show = pw.type === 'password';
    pw.type = show ? 'text' : 'password';
    e.currentTarget.textContent = show ? 'Masquer' : 'Afficher';
    e.currentTarget.setAttribute('aria-pressed', String(show));
  });

  $('#send-pw-gen').addEventListener('click', () => {
    const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = C.randomBytes(64);
    let out = '';
    // Tirage sans biais (rejet des octets >= 232 pour un alphabet de 58).
    for (const b of bytes) {
      if (b >= 232) continue;
      out += alphabet[b % alphabet.length];
      if (out.length === 20) break;
    }
    pw.value = out.replace(/(.{5})(?!$)/g, '$1-');
    pw.type = 'text';
    $('#send-pw-show').textContent = 'Masquer';
    updateMeter();
  });

  function passwordBits(p) {
    if (!p) return 0;
    let pool = 0;
    if (/[a-z]/.test(p)) pool += 26;
    if (/[A-Z]/.test(p)) pool += 26;
    if (/[0-9]/.test(p)) pool += 10;
    if (/[^A-Za-z0-9]/.test(p)) pool += 33;
    const unique = new Set(p).size;
    return Math.round(Math.min(p.length, unique * 1.5) * Math.log2(pool || 1));
  }

  function updateMeter() {
    const meter = $('#send-pw-meter');
    const bits = passwordBits(pw.value);
    meter.hidden = !pw.value;
    const [label, color] =
      bits < 40 ? ['Faible', 'var(--danger)'] : bits < 60 ? ['Correct', '#e8a33d'] : bits < 80 ? ['Fort', 'var(--ok)'] : ['Excellent', 'var(--ok)'];
    $('span', meter).style.setProperty('--w', `${Math.min(100, (bits / 100) * 100)}%`);
    $('span', meter).style.setProperty('--c', color);
    $('em', meter).textContent = label;
  }
  pw.addEventListener('input', updateMeter);

  // --- Sources de données -----------------------------------------------------

  async function* fileSource(file) {
    const reader = file.stream().getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      yield value;
    }
  }

  /** ZIP en flux (fflate) : les fichiers ne sont jamais chargés entièrement en mémoire. */
  async function* zipSource(list) {
    const out = [];
    let zipError = null;
    const zip = new window.fflate.Zip((err, data) => {
      if (err) zipError = err;
      else out.push(data);
    });
    const used = new Set();
    for (const file of list) {
      let name = pathOf(file);
      for (let i = 2; used.has(name); i++) name = pathOf(file).replace(/(\.[^./]*)?$/, ` (${i})$1`);
      used.add(name);
      const entry = STORED_EXT.test(name) ? new window.fflate.ZipPassThrough(name) : new window.fflate.ZipDeflate(name, { level: 6 });
      entry.mtime = file.lastModified || Date.now();
      zip.add(entry);
      const reader = file.stream().getReader();
      for (;;) {
        const { value, done } = await reader.read();
        entry.push(done ? new Uint8Array(0) : value, done);
        if (zipError) throw zipError;
        while (out.length) yield out.shift();
        if (done) break;
      }
    }
    zip.end();
    if (zipError) throw zipError;
    while (out.length) yield out.shift();
  }

  // --- Envoi des blocs ------------------------------------------------------

  class Uploader {
    constructor({ id, ownerToken, fileKey, signal, onChunkDone }) {
      Object.assign(this, { id, ownerToken, fileKey, signal, onChunkDone });
      this.inflight = new Set();
      this.error = null;
    }

    async submit(index, plaintext, last) {
      while (this.inflight.size >= PARALLEL_UPLOADS) await Promise.race(this.inflight);
      if (this.error) throw this.error;
      const task = this.upload(index, plaintext, last)
        .catch((e) => (this.error ??= e))
        .finally(() => this.inflight.delete(task));
      this.inflight.add(task);
    }

    async drain() {
      await Promise.all(this.inflight);
      if (this.error) throw this.error;
    }

    async upload(index, plaintext, last) {
      const body = await C.encryptChunk(this.fileKey, index, last, plaintext);
      for (let attempt = 0; ; attempt++) {
        if (this.signal.aborted) throw new DOMException('Envoi annulé', 'AbortError');
        try {
          const res = await fetch(`/api/transfers/${this.id}/chunks/${index}`, {
            method: 'PUT',
            headers: { Authorization: `Bearer ${this.ownerToken}`, 'Content-Type': 'application/octet-stream' },
            body,
            signal: this.signal,
            credentials: 'omit',
          });
          if (res.ok) break;
          const msg = (await res.json().catch(() => null))?.error || `HTTP ${res.status}`;
          // Erreurs définitives : inutile de réessayer.
          if ([400, 404, 409, 413, 507].includes(res.status)) throw Object.assign(new Error(msg), { fatal: true });
          throw new Error(msg);
        } catch (e) {
          if (e.fatal || e.name === 'AbortError' || attempt >= 6) throw e;
          await new Promise((r) => setTimeout(r, Math.min(30000, 1000 * 2 ** attempt)));
        }
      }
      this.onChunkDone(plaintext.length);
    }
  }

  async function send() {
    showError(error, '');
    const zipped = files.length > 1 || zipBox.checked;
    const total = totalSize();
    if (zipped && total > ZIP_LIMIT)
      return showError(error, 'Un ZIP est limité à 4 Go. Pour de plus gros volumes, envoyez les fichiers un par un, sans les zipper (jusqu’à 50 Go chacun).');

    const password = pw.value;
    if (password && password.length < 8) return showError(error, 'Mot de passe trop court (8 caractères minimum).');

    const abort = new AbortController();
    running = { abort, id: null, ownerToken: null };
    go.disabled = true;
    options.hidden = true;
    setProgress(progress, null, password ? 'Dérivation de la clé depuis le mot de passe…' : 'Génération des clés…');

    try {
      const secret = C.randomBytes(32);
      const hkdfSalt = C.randomBytes(16);
      const pwSalt = password ? C.randomBytes(16) : null;
      const pwIter = password ? C.PBKDF2_ITERATIONS : 0;
      const keys = await C.deriveKeys({ secret, hkdfSalt, password, pwSalt, pwIter });

      const created = await apiJson('/api/transfers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          v: 1,
          expiresIn: Number($('#send-expiry').value),
          maxDownloads: Number($('#send-downloads').value),
          hkdfSalt: C.b64urlEncode(hkdfSalt),
          hasPassword: !!password,
          pwSalt: pwSalt && C.b64urlEncode(pwSalt),
          pwIter,
          authHash: C.b64urlEncode(await C.sha256(keys.authToken)),
        }),
        signal: abort.signal,
      });
      running.id = created.id;
      running.ownerToken = created.ownerToken;
      if (total > created.maxBytes) throw new Error(`Trop volumineux : maximum ${formatBytes(created.maxBytes)}.`);

      let uploaded = 0;
      const speed = speedometer();
      const uploader = new Uploader({
        id: created.id,
        ownerToken: created.ownerToken,
        fileKey: keys.fileKey,
        signal: abort.signal,
        onChunkDone: (n) => {
          uploaded += n;
          // En mode ZIP la taille finale est inconnue : on se base sur la taille des fichiers.
          setProgress(progress, Math.min(1, uploaded / Math.max(total, 1)), `Chiffrement et envoi : ${speed(Math.min(uploaded, total), total)}`);
        },
      });
      setProgress(progress, 0, 'Chiffrement et envoi…');

      // Découpage en blocs de CHUNK_BYTES ; on garde toujours un bloc plein en réserve
      // pour pouvoir marquer correctement le DERNIER bloc.
      const CHUNK = C.CHUNK_BYTES;
      let buf = new Uint8Array(CHUNK);
      let fill = 0;
      let held = null;
      let index = 0;
      let plainBytes = 0;
      const source = zipped ? zipSource(files) : fileSource(files[0]);
      for await (let piece of source) {
        plainBytes += piece.length;
        while (piece.length) {
          const n = Math.min(piece.length, CHUNK - fill);
          buf.set(piece.subarray(0, n), fill);
          fill += n;
          piece = piece.subarray(n);
          if (fill === CHUNK) {
            if (held) await uploader.submit(index++, held, false);
            held = buf;
            buf = new Uint8Array(CHUNK);
            fill = 0;
          }
        }
      }
      if (fill > 0) {
        if (held) await uploader.submit(index++, held, false);
        await uploader.submit(index++, buf.subarray(0, fill), true);
      } else {
        await uploader.submit(index++, held || new Uint8Array(0), true);
      }
      await uploader.drain();

      setProgress(progress, 1, 'Finalisation…');
      const name = zipped
        ? `${files.length === 1 ? files[0].name.replace(/\.[^.]*$/, '') : (files[0].webkitRelativePath.split('/')[0] || 'fichiers')}.zip`
        : files[0].name;
      const meta = {
        v: 1,
        name,
        size: plainBytes,
        type: zipped ? 'application/zip' : files[0].type || 'application/octet-stream',
        zipped,
        files: files.slice(0, 1000).map((f) => ({ name: pathOf(f), size: f.size })),
        fileCount: files.length,
      };
      const done = await apiJson(`/api/transfers/${created.id}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${created.ownerToken}` },
        body: JSON.stringify({ chunkCount: index, encMeta: C.b64urlEncode(await C.encryptMeta(keys.metaKey, meta)) }),
      });

      const link = `${location.origin}/t/${created.id}#${C.b64urlEncode(secret)}`;
      remember({ id: created.id, ownerToken: created.ownerToken, name, size: plainBytes, expiresAt: done.expiresAt, maxDownloads: done.maxDownloads, password: !!password });
      showResult(link, { name, size: plainBytes, expiresAt: done.expiresAt, maxDownloads: done.maxDownloads, password: !!password });
    } catch (e) {
      if (running?.id) cleanupRemote(running.id, running.ownerToken);
      progress.hidden = true;
      options.hidden = false;
      showError(error, e.name === 'AbortError' ? 'Envoi annulé.' : `Échec de l’envoi : ${e.message}`);
    } finally {
      running = null;
      go.disabled = false;
    }
  }

  function cleanupRemote(id, ownerToken) {
    fetch(`/api/transfers/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${ownerToken}` }, credentials: 'omit' }).catch(() => {});
  }

  go.addEventListener('click', send);
  $('#send-cancel').addEventListener('click', () => running?.abort.abort());
  window.addEventListener('beforeunload', (e) => {
    if (running) e.preventDefault();
  });

  // --- Résultat ---------------------------------------------------------------

  function showResult(link, info) {
    card.hidden = true;
    result.hidden = false;
    $('#send-link').value = link;
    $('#send-result-pw').textContent = info.password ? 'ET le mot de passe peut télécharger le fichier — envoyez le mot de passe par un autre canal' : 'peut télécharger le fichier';
    $('#send-result-info').textContent =
      `${info.name} · ${formatBytes(info.size)} · expire le ${formatDate(info.expiresAt)} · ` +
      `${info.maxDownloads === 1 ? 'un seul téléchargement' : `${info.maxDownloads} téléchargements max.`}`;
    renderMine();
  }

  $('#send-copy').addEventListener('click', async (e) => {
    const button = e.currentTarget;
    const input = $('#send-link');
    try {
      await navigator.clipboard.writeText(input.value);
    } catch {
      input.select();
      document.execCommand('copy');
    }
    button.textContent = 'Copié ✓';
    setTimeout(() => (button.textContent = 'Copier'), 2000);
  });
  $('#send-link').addEventListener('focus', (e) => e.target.select());

  $('#send-again').addEventListener('click', () => {
    files = [];
    pw.value = '';
    updateMeter();
    $('#send-link').value = '';
    result.hidden = true;
    card.hidden = false;
    progress.hidden = true;
    render();
  });

  // --- « Mes envois » (localStorage : id + jeton propriétaire, jamais la clé) --

  function loadMine() {
    try {
      return JSON.parse(localStorage.getItem(STORE_KEY) || '[]').filter((t) => t.expiresAt > Date.now());
    } catch {
      return [];
    }
  }
  function saveMine(items) {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(items));
    } catch {
      /* stockage indisponible */
    }
  }
  function remember(item) {
    saveMine([item, ...loadMine()].slice(0, 50));
  }

  async function renderMine() {
    const items = loadMine();
    saveMine(items);
    const box = $('#my-transfers');
    box.hidden = !items.length;
    const ul = $('#my-transfers-list');
    ul.replaceChildren(
      ...items.map((t) => {
        const status = el('span', { class: 'muted small' }, '…');
        const li = el(
          'li',
          {},
          el('div', { class: 'info' }, el('strong', {}, t.name), el('span', { class: 'muted small' }, `${formatBytes(t.size)} · expire le ${formatDate(t.expiresAt)}${t.password ? ' · 🔑' : ''}`)),
          status,
          el(
            'button',
            {
              class: 'btn ghost small danger',
              onclick: async () => {
                if (!confirm(`Supprimer définitivement « ${t.name} » ? Le lien ne fonctionnera plus.`)) return;
                await fetch(`/api/transfers/${t.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${t.ownerToken}` }, credentials: 'omit' }).catch(() => {});
                saveMine(loadMine().filter((x) => x.id !== t.id));
                renderMine();
              },
            },
            'Supprimer'
          )
        );
        apiJson(`/api/transfers/${t.id}/status`, { headers: { Authorization: `Bearer ${t.ownerToken}` } })
          .then((s) => (status.textContent = `${s.downloads} / ${s.maxDownloads} téléchargement(s)`))
          .catch(() => {
            status.textContent = 'expiré ou supprimé';
            li.style.opacity = '.6';
          });
        return li;
      })
    );
  }

  renderMine();
})();
