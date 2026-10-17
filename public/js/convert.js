/* Onglet « Convertir ». */
(function () {
  'use strict';
  const { $, el, formatBytes, extOf, setupDrop, showError, saveBlob, setProgress } = window.UI;

  const GROUPS = [
    ['Images', ['png', 'jpg', 'webp', 'gif', 'bmp', 'tiff', 'ico']],
    ['Vidéo', ['mp4', 'webm', 'mkv', 'mov', 'avi']],
    ['Audio', ['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'opus']],
    ['Documents', ['pdf', 'docx', 'odt', 'rtf', 'txt', 'html', 'md', 'epub', 'rst', 'tex']],
    ['Tableurs & présentations', ['xlsx', 'ods', 'pptx', 'odp']],
    ['Données', ['csv', 'tsv', 'json', 'yaml']],
  ];
  const CAT_LABEL = { image: 'Images', audio: 'Audio', video: 'Vidéo', document: 'Documents', office: 'Tableurs & présentations', data: 'Données' };

  let formats = {};
  let maxFileBytes = Infinity;
  let maxFiles = 20;
  let files = [];
  let target = null;

  const drop = $('#convert-drop');
  const input = $('#convert-input');
  const list = $('#convert-files');
  const options = $('#convert-options');
  const chips = $('#convert-targets');
  const hint = $('#convert-hint');
  const zipBox = $('#convert-zip');
  const go = $('#convert-go');
  const progress = $('#convert-progress');
  const error = $('#convert-error');

  fetch('/api/formats')
    .then((r) => r.json())
    .then((data) => {
      formats = data.formats;
      maxFileBytes = data.maxFileBytes;
      maxFiles = data.maxFiles;
      renderFormatsTable();
      render();
    })
    .catch(() => showError(error, 'Impossible de charger la liste des formats.'));

  setupDrop(drop, input, (added) => {
    showError(error, '');
    files = files.concat(added).slice(0, maxFiles);
    if (files.length >= maxFiles) showError(error, `Maximum ${maxFiles} fichiers par conversion.`);
    render();
  });

  $('#convert-clear').addEventListener('click', () => {
    files = [];
    target = null;
    showError(error, '');
    progress.hidden = true;
    render();
  });

  function targetsFor(fileList) {
    let common = null;
    for (const f of fileList) {
      const t = new Set(formats[extOf(f.name)]?.targets || []);
      common = common ? new Set([...common].filter((x) => t.has(x))) : t;
    }
    return common || new Set();
  }

  function render() {
    list.replaceChildren(
      ...files.map((f, i) => {
        const ext = extOf(f.name);
        const ok = !!formats[ext];
        const tooBig = f.size > maxFileBytes;
        return el(
          'li',
          {},
          el('span', { class: `badge${ok && !tooBig ? '' : ' bad'}`, title: ok ? '' : 'Format non pris en charge' }, ext || '?'),
          el('span', { class: 'name', title: f.name }, f.name),
          el('span', { class: 'size' }, tooBig ? `trop gros (max ${formatBytes(maxFileBytes)})` : formatBytes(f.size)),
          el('button', { class: 'rm', 'aria-label': `Retirer ${f.name}`, onclick: () => (files.splice(i, 1), render()) }, '×')
        );
      })
    );
    options.hidden = !files.length;
    if (!files.length) return;

    const supported = files.filter((f) => formats[extOf(f.name)]);
    const available = targetsFor(supported);
    if (target && target !== 'zip' && !available.has(target)) target = null;

    const nodes = [];
    for (const [label, exts] of GROUPS) {
      const inGroup = exts.filter((e) => available.has(e));
      if (!inGroup.length) continue;
      nodes.push(el('span', { class: 'sep' }, label));
      inGroup.forEach((e) => nodes.push(chip(e, e)));
    }
    const leftovers = [...available].filter((e) => !GROUPS.some(([, exts]) => exts.includes(e)));
    leftovers.forEach((e) => nodes.push(chip(e, e)));
    nodes.push(el('span', { class: 'sep' }, 'Archive'));
    nodes.push(chip('zip', 'ZIP — sans conversion', 'zip'));
    chips.replaceChildren(...nodes);

    const unsupported = files.length - supported.length;
    hint.textContent =
      unsupported && target !== 'zip'
        ? `${unsupported} fichier(s) dans un format non pris en charge seront ignorés (vous pouvez quand même les zipper).`
        : supported.length && !available.size
          ? 'Ces fichiers n’ont pas de format de sortie commun : convertissez-les séparément, ou zippez-les.'
          : '';

    // Plusieurs fichiers (ou mode ZIP) => le résultat est forcément une archive.
    const forced = target === 'zip' || files.length > 1;
    zipBox.disabled = forced;
    if (forced) zipBox.checked = true;
    go.disabled = !target || files.some((f) => f.size > maxFileBytes) || (target !== 'zip' && !supported.length);
    go.textContent = target === 'zip' ? 'Créer le ZIP' : target ? `Convertir en ${target.toUpperCase()}` : 'Choisissez un format';
  }

  function chip(value, label, cls) {
    return el(
      'button',
      {
        type: 'button',
        role: 'radio',
        class: cls || null,
        'aria-checked': String(target === value),
        onclick: () => {
          target = value;
          render();
        },
      },
      label
    );
  }

  function renderFormatsTable() {
    const byCat = {};
    for (const [ext, { category, targets }] of Object.entries(formats)) (byCat[category] ??= []).push([ext, targets]);
    const table = el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Depuis'), el('th', {}, 'Vers'))));
    const body = el('tbody');
    for (const cat of Object.keys(CAT_LABEL)) {
      if (!byCat[cat]) continue;
      body.append(el('tr', {}, el('th', { colspan: '2' }, CAT_LABEL[cat])));
      byCat[cat].sort().forEach(([ext, t]) => body.append(el('tr', {}, el('td', {}, ext), el('td', {}, t.join(', ')))));
    }
    table.append(body);
    $('#formats-table').replaceChildren(table, el('p', { class: 'muted small' }, 'Et tous les formats peuvent être zippés.'));
  }

  function filenameFrom(disposition, fallback) {
    const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition || '');
    if (star) return decodeURIComponent(star[1]);
    const plain = /filename="([^"]+)"/i.exec(disposition || '');
    return plain ? plain[1] : fallback;
  }

  go.addEventListener('click', () => {
    showError(error, '');
    const toSend = target === 'zip' ? files : files.filter((f) => formats[extOf(f.name)]);
    const form = new FormData();
    form.append('target', target);
    form.append('zip', zipBox.checked ? '1' : '0');
    toSend.forEach((f) => form.append('files', f, f.name));

    const total = toSend.reduce((s, f) => s + f.size, 0);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/convert');
    xhr.responseType = 'blob';
    go.disabled = true;
    setProgress(progress, 0, 'Envoi…');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) setProgress(progress, e.loaded / e.total, `Envoi : ${formatBytes(e.loaded)} / ${formatBytes(total)}`);
    };
    xhr.upload.onload = () => setProgress(progress, null, target === 'zip' ? 'Création de l’archive…' : 'Conversion en cours… (peut prendre un moment pour les vidéos)');
    xhr.onprogress = (e) => {
      if (e.loaded) setProgress(progress, e.lengthComputable ? e.loaded / e.total : null, `Téléchargement du résultat : ${formatBytes(e.loaded)}`);
    };
    xhr.onerror = () => {
      progress.hidden = true;
      go.disabled = false;
      showError(error, 'Erreur réseau pendant la conversion.');
    };
    xhr.onload = async () => {
      go.disabled = false;
      if (xhr.status === 200) {
        const name = filenameFrom(xhr.getResponseHeader('Content-Disposition'), `convertor.${target}`);
        saveBlob(xhr.response, name);
        setProgress(progress, 1, `Terminé : ${name} (${formatBytes(xhr.response.size)})`);
        return;
      }
      progress.hidden = true;
      let msg = `Erreur ${xhr.status}`;
      try {
        msg = JSON.parse(await xhr.response.text()).error || msg;
      } catch {
        /* réponse non JSON */
      }
      showError(error, msg);
    };
    xhr.send(form);
  });
})();
