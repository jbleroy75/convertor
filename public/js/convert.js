/* Onglets « Convertir un fichier » et « Créer un ZIP » (même zone de fichiers). */
(function () {
  'use strict';
  const { $, el, setChildren, formatBytes, extOf, setupDrop, showError, saveBlob, setProgress } = window.UI;
  const Icons = window.FileIcons;

  const GROUPS = [
    ['Documents', ['pdf', 'docx', 'odt', 'rtf', 'txt', 'html', 'md', 'epub', 'rst', 'tex']],
    ['Images', ['jpg', 'png', 'webp', 'gif', 'bmp', 'tiff', 'ico']],
    ['Vidéo', ['mp4', 'webm', 'mkv', 'mov', 'avi']],
    ['Audio', ['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'opus']],
    ['Tableurs & présentations', ['xlsx', 'ods', 'pptx', 'odp']],
    ['Données', ['csv', 'tsv', 'json', 'yaml']],
  ];
  const CAT_LABEL = { image: 'Images', audio: 'Audio', video: 'Vidéo', document: 'Documents', office: 'Tableurs & présentations', data: 'Données' };

  let formats = {};
  let maxFileBytes = Infinity;
  let maxFiles = 20;
  let files = [];
  let target = null;
  let mode = 'convert';

  const list = $('#convert-files');
  const bar = $('#convert-options');
  const subopts = $('#convert-subopts');
  const select = $('#convert-target');
  const targetWrap = $('#convert-target-wrap');
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

  document.addEventListener('modechange', (e) => {
    if (e.detail === 'transfer') return;
    mode = e.detail;
    showError(error, '');
    progress.hidden = true;
    render();
  });

  setupDrop($('#convert-drop'), $('#convert-input'), (added) => {
    showError(error, '');
    progress.hidden = true;
    files = files.concat(added).slice(0, maxFiles);
    if (files.length >= maxFiles) showError(error, `Maximum ${maxFiles} fichiers à la fois.`);
    render();
  });

  $('#convert-clear').addEventListener('click', () => {
    files = [];
    target = null;
    showError(error, '');
    progress.hidden = true;
    render();
  });

  select.addEventListener('change', () => {
    target = select.value || null;
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

  function fileRow(f, i) {
    const ext = extOf(f.name);
    const supported = mode === 'zip' || !!formats[ext];
    const tooBig = f.size > maxFileBytes;
    const sizeText = tooBig ? `Trop volumineux (max ${formatBytes(maxFileBytes)})` : supported ? formatBytes(f.size) : `${formatBytes(f.size)} · format non pris en charge`;
    return el(
      'li',
      {},
      Icons.node(ext),
      el('span', { class: 'fmeta' }, el('span', { class: 'name', title: f.name }, f.name), el('span', { class: `size${tooBig || !supported ? ' bad' : ''}` }, sizeText)),
      el('button', { class: 'rm', type: 'button', 'aria-label': `Retirer ${f.name}`, onclick: () => (files.splice(i, 1), render()) }, '×')
    );
  }

  function render() {
    const hasFiles = files.length > 0;
    // Un seul fichier : il est résumé dans la barre d'action (comme sur la maquette).
    list.replaceChildren(...(files.length > 1 ? files.map(fileRow) : []));
    bar.hidden = !hasFiles;
    subopts.hidden = !hasFiles;
    hint.textContent = '';
    if (!hasFiles) return;

    const total = files.reduce((s, f) => s + f.size, 0);
    const first = files[0];
    const summaryIcon = Icons.node(files.length > 1 ? 'zip' : extOf(first.name));
    setChildren(
      $('#convert-summary'),
      summaryIcon,
      el(
        'span',
        { class: 'fmeta' },
        el('span', { class: 'name', title: first.name }, files.length > 1 ? `${files.length} fichiers` : first.name),
        el('span', { class: 'size' }, formatBytes(total))
      ),
      files.length === 1 ? el('button', { class: 'rm', type: 'button', 'aria-label': `Retirer ${first.name}`, onclick: () => (files = [], render()) }, '×') : null
    );

    if (mode === 'zip') {
      targetWrap.hidden = true;
      zipBox.closest('label').hidden = true;
      go.disabled = files.some((f) => f.size > maxFileBytes);
      go.textContent = 'Créer le ZIP';
      return;
    }

    targetWrap.hidden = false;
    zipBox.closest('label').hidden = false;
    const supported = files.filter((f) => formats[extOf(f.name)]);
    const available = targetsFor(supported);
    if (target && !available.has(target)) target = null;
    if (!target && available.size) target = available.has('pdf') ? 'pdf' : [...available][0];

    const groups = [];
    for (const [label, exts] of GROUPS) {
      const inGroup = exts.filter((e) => available.has(e));
      if (inGroup.length) groups.push(el('optgroup', { label }, ...inGroup.map((e) => el('option', { value: e }, e.toUpperCase()))));
    }
    const leftovers = [...available].filter((e) => !GROUPS.some(([, exts]) => exts.includes(e)));
    if (leftovers.length) groups.push(el('optgroup', { label: 'Autres' }, ...leftovers.map((e) => el('option', { value: e }, e.toUpperCase()))));
    if (!groups.length) groups.push(el('option', { value: '' }, 'Aucun format commun'));
    select.replaceChildren(...groups);
    select.value = target || '';
    $('#convert-target-icon').innerHTML = target ? Icons.svg(target) : '';

    const unsupported = files.length - supported.length;
    if (unsupported) hint.textContent = `${unsupported} fichier(s) dans un format non pris en charge seront ignorés. Utilisez « Créer un ZIP » pour les regrouper tels quels.`;
    else if (!available.size) hint.textContent = 'Ces fichiers n’ont pas de format de sortie commun : convertissez-les séparément, ou regroupez-les avec « Créer un ZIP ».';

    // Plusieurs fichiers => le résultat est forcément une archive.
    zipBox.disabled = files.length > 1;
    if (files.length > 1) zipBox.checked = true;
    go.disabled = !target || !supported.length || files.some((f) => f.size > maxFileBytes);
    go.textContent = 'Convertir';
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
    $('#formats-table').replaceChildren(table, el('p', { class: 'muted small' }, 'Et tous les fichiers, quel que soit leur format, peuvent être regroupés dans un ZIP.'));
  }

  function filenameFrom(disposition, fallback) {
    const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition || '');
    if (star) return decodeURIComponent(star[1]);
    const plain = /filename="([^"]+)"/i.exec(disposition || '');
    return plain ? plain[1] : fallback;
  }

  go.addEventListener('click', () => {
    showError(error, '');
    const zipOnly = mode === 'zip';
    const toSend = zipOnly ? files : files.filter((f) => formats[extOf(f.name)]);
    const wanted = zipOnly ? 'zip' : target;
    const form = new FormData();
    form.append('target', wanted);
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
    xhr.upload.onload = () => setProgress(progress, null, zipOnly ? 'Création de l’archive…' : 'Conversion en cours… (peut prendre un moment pour les vidéos)');
    xhr.onprogress = (e) => {
      if (e.loaded) setProgress(progress, e.lengthComputable ? e.loaded / e.total : null, `Récupération du résultat : ${formatBytes(e.loaded)}`);
    };
    xhr.onerror = () => {
      progress.hidden = true;
      go.disabled = false;
      showError(error, 'Erreur réseau pendant l’opération.');
    };
    xhr.onload = async () => {
      go.disabled = false;
      if (xhr.status === 200) {
        const name = filenameFrom(xhr.getResponseHeader('Content-Disposition'), `convertor.${wanted}`);
        saveBlob(xhr.response, name);
        setProgress(progress, 1, `✅ Terminé : ${name} (${formatBytes(xhr.response.size)})`);
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
