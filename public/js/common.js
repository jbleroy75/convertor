/* Utilitaires partagés par les pages. */
(function () {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);

  function formatBytes(n) {
    if (!Number.isFinite(n)) return '—';
    const units = ['o', 'Ko', 'Mo', 'Go', 'To'];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) {
      n /= 1024;
      i++;
    }
    return `${n.toLocaleString('fr-FR', { maximumFractionDigits: i === 0 ? 0 : n < 10 ? 1 : 0 })} ${units[i]}`;
  }

  function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '';
    if (seconds < 60) return `${Math.ceil(seconds)} s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`;
    return `${Math.floor(seconds / 3600)} h ${Math.round((seconds % 3600) / 60)} min`;
  }

  function formatDate(ms) {
    return new Date(ms).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });
  }

  function extOf(name) {
    const m = /\.([A-Za-z0-9]{1,10})$/.exec(name || '');
    return m ? m[1].toLowerCase() : '';
  }

  /** Branche une zone de dépôt + un <input type=file>. */
  function setupDrop(drop, input, onFiles) {
    input.addEventListener('change', () => {
      if (input.files.length) onFiles([...input.files]);
      input.value = '';
    });
    ['dragenter', 'dragover'].forEach((t) =>
      drop.addEventListener(t, (e) => {
        e.preventDefault();
        drop.classList.add('over');
      })
    );
    ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, () => drop.classList.remove('over')));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      const files = [...(e.dataTransfer?.files || [])].filter((f) => f.size > 0 || f.type);
      if (files.length) onFiles(files);
    });
  }

  function showError(el, msg) {
    el.textContent = msg || '';
    el.hidden = !msg;
  }

  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  async function apiJson(url, options = {}) {
    const res = await fetch(url, { credentials: 'omit', cache: 'no-store', ...options });
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* corps vide */
    }
    if (!res.ok) {
      const err = new Error(body?.error || `Erreur HTTP ${res.status}`);
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return body;
  }

  /** Barre de progression : setProgress(el, ratio|null, texte). null => indéterminée. */
  function setProgress(el, ratio, text) {
    el.hidden = false;
    const bar = $('.bar', el);
    bar.classList.toggle('indeterminate', ratio === null);
    $('.bar span', el).style.width = ratio === null ? '' : `${Math.min(100, ratio * 100).toFixed(1)}%`;
    $('.status', el).textContent = text || '';
  }

  /** Mesure de débit lissée pour afficher vitesse + temps restant. */
  function speedometer() {
    const samples = [];
    return (done, total) => {
      const now = performance.now();
      samples.push([now, done]);
      while (samples.length > 2 && now - samples[0][0] > 5000) samples.shift();
      const [t0, d0] = samples[0];
      const rate = now - t0 > 300 ? ((done - d0) / (now - t0)) * 1000 : 0;
      const eta = rate > 0 ? (total - done) / rate : NaN;
      return `${formatBytes(done)} / ${formatBytes(total)}${rate ? ` · ${formatBytes(rate)}/s` : ''}${Number.isFinite(eta) && eta > 1 ? ` · reste ${formatDuration(eta)}` : ''}`;
    };
  }

  /** Comme replaceChildren, mais ignore les enfants null/undefined (sinon ils deviennent du texte « null »). */
  function setChildren(node, ...children) {
    node.replaceChildren(...children.flat().filter((c) => c != null));
  }

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') node.className = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c != null) node.append(c);
    return node;
  }

  // Onglets : convert / zip / transfer. Les liens #convertir, #zip, #transfert du menu y mènent.
  const HASH_TO_MODE = { '#convertir': 'convert', '#zip': 'zip', '#transfert': 'transfer' };
  const MODE_TO_HASH = { convert: '#convertir', zip: '#zip', transfer: '#transfert' };

  function initTabs() {
    const tabs = [...document.querySelectorAll('[role=tab][data-tab]')];
    if (!tabs.length) return;
    const select = (mode, scroll) => {
      tabs.forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === mode)));
      document.getElementById('panel-files').hidden = mode === 'transfer';
      document.getElementById('panel-transfer').hidden = mode !== 'transfer';
      document.querySelectorAll('.mainnav a').forEach((a) => {
        if (HASH_TO_MODE[a.getAttribute('href')] === mode) a.setAttribute('aria-current', 'page');
        else a.removeAttribute('aria-current');
      });
      window.UI.mode = mode;
      document.dispatchEvent(new CustomEvent('modechange', { detail: mode }));
      if (scroll) document.getElementById('outil').scrollIntoView({ block: 'start' });
    };
    tabs.forEach((t) =>
      t.addEventListener('click', () => {
        history.replaceState(null, '', MODE_TO_HASH[t.dataset.tab]);
        select(t.dataset.tab, false);
      })
    );
    const fromHash = (scroll) => {
      const mode = HASH_TO_MODE[location.hash];
      if (mode) select(mode, scroll);
      else if (!window.UI.mode) select('convert', false);
    };
    window.addEventListener('hashchange', () => fromHash(true));
    // Re-cliquer sur le lien déjà actif doit aussi ramener à l'outil.
    document.querySelectorAll('a[href^="#"]').forEach((a) =>
      a.addEventListener('click', () => {
        if (a.getAttribute('href') === location.hash && HASH_TO_MODE[location.hash]) fromHash(true);
      })
    );
    fromHash(!!HASH_TO_MODE[location.hash]);
  }

  window.UI = { mode: null, $, el, setChildren, formatBytes, formatDuration, formatDate, extOf, setupDrop, showError, saveBlob, apiJson, setProgress, speedometer };
  document.addEventListener('DOMContentLoaded', initTabs);
})();
