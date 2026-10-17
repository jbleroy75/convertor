/* Onglets « Convertir », « Compresser » et « Outils » : même zone de fichiers. */
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

  // Présentation des outils ; les formats acceptés viennent du serveur (/api/tools).
  const TOOL_UI = [
    { id: 'pdf-merge', icon: 'pdf', title: 'Fusionner des PDF', desc: 'Plusieurs PDF en un seul, dans l’ordre voulu', verb: 'Fusionner', reorder: true },
    {
      id: 'pdf-extract',
      icon: 'pdf',
      title: 'Extraire des pages',
      desc: 'Garder seulement certaines pages',
      verb: 'Extraire',
      fields: [{ name: 'pages', label: 'Pages à garder', placeholder: 'ex. 1-3, 5, 8-', required: true, help: '« 8- » = de la page 8 à la fin. L’ordre indiqué est respecté.' }],
    },
    { id: 'pdf-split', icon: 'pdf', title: 'Découper un PDF', desc: 'Un fichier PDF par page', verb: 'Découper' },
    { id: 'images-to-pdf', icon: 'jpg', title: 'Images → PDF', desc: 'Réunir des photos dans un seul PDF', verb: 'Créer le PDF', reorder: true },
    { id: 'image-resize', icon: 'png', title: 'Redimensionner', desc: 'Changer la taille des images', verb: 'Redimensionner', fields: [{ name: 'resize', type: 'resize' }] },
    {
      id: 'image-rotate',
      icon: 'png',
      title: 'Faire pivoter',
      desc: 'Tourner des images',
      verb: 'Pivoter',
      fields: [{ name: 'angle', label: 'Rotation', type: 'select', options: [['90', '90° vers la droite'], ['180', '180°'], ['270', '90° vers la gauche']] }],
    },
    {
      id: 'media-trim',
      icon: 'mp4',
      title: 'Couper une vidéo / un audio',
      desc: 'Garder un extrait',
      verb: 'Couper',
      fields: [
        { name: 'start', label: 'Début', placeholder: 'ex. 0:30', help: 'Format minutes:secondes ou heures:minutes:secondes.' },
        { name: 'end', label: 'Fin (vide = jusqu’au bout)', placeholder: 'ex. 1:45' },
      ],
    },
    { id: 'zip', icon: 'zip', title: 'Créer un ZIP', desc: 'Regrouper tous les fichiers', verb: 'Créer le ZIP' },
  ];

  let formats = {};
  let tools = {};
  let maxFileBytes = Infinity;
  let maxFiles = 20;
  let files = [];
  let target = null;
  let mode = 'convert';
  let level = 'balanced';
  let zipForced = false;
  let toolId = location.hash === '#zip' ? 'zip' : null;
  const toolValues = {};

  const list = $('#convert-files');
  const bar = $('#convert-options');
  const subopts = $('#convert-subopts');
  const select = $('#convert-target');
  const hint = $('#convert-hint');
  const zipBox = $('#convert-zip');
  const go = $('#convert-go');
  const runActions = $('#run-actions');
  const runGo = $('#run-go');
  const compressOpts = $('#compress-options');
  const toolsOpts = $('#tools-options');
  const results = $('#compress-results');
  const progress = $('#convert-progress');
  const error = $('#convert-error');

  Promise.all([fetch('/api/formats').then((r) => r.json()), fetch('/api/tools').then((r) => r.json())])
    .then(([f, t]) => {
      formats = f.formats;
      maxFileBytes = f.maxFileBytes;
      maxFiles = f.maxFiles;
      tools = t.tools;
      renderFormatsTable();
      render();
    })
    .catch(() => showError(error, 'Impossible de charger la liste des formats.'));

  document.addEventListener('modechange', (e) => {
    if (e.detail === 'transfer') return;
    mode = e.detail;
    if (location.hash === '#zip') toolId = 'zip';
    resetFeedback();
    render();
  });

  function resetFeedback() {
    showError(error, '');
    progress.hidden = true;
    results.hidden = true;
  }

  setupDrop($('#convert-drop'), $('#convert-input'), (added) => {
    resetFeedback();
    files = files.concat(added).slice(0, maxFiles);
    if (files.length >= maxFiles) showError(error, `Maximum ${maxFiles} fichiers à la fois.`);
    render();
  });

  const clearAll = () => {
    files = [];
    target = null;
    resetFeedback();
    render();
  };
  $('#convert-clear').addEventListener('click', clearAll);
  $('#run-clear').addEventListener('click', clearAll);

  select.addEventListener('change', () => {
    target = select.value || null;
    render();
  });

  document.querySelectorAll('.levels [data-level]').forEach((b) =>
    b.addEventListener('click', () => {
      level = b.dataset.level;
      document.querySelectorAll('.levels [data-level]').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
    })
  );

  // --- Rendu -------------------------------------------------------------------

  const currentTool = () => TOOL_UI.find((t) => t.id === toolId) || null;
  const accepts = (id, ext) => tools[id] && (tools[id].accepts === '*' || tools[id].accepts.includes(ext));

  function isSupported(f) {
    const ext = extOf(f.name);
    if (mode === 'convert') return !!formats[ext];
    if (mode === 'compress') return accepts('compress', ext);
    return toolId ? accepts(toolId, ext) : true;
  }

  function targetsFor(fileList) {
    let common = null;
    for (const f of fileList) {
      const t = new Set(formats[extOf(f.name)]?.targets || []);
      common = common ? new Set([...common].filter((x) => t.has(x))) : t;
    }
    return common || new Set();
  }

  function move(i, delta) {
    const j = i + delta;
    if (j < 0 || j >= files.length) return;
    [files[i], files[j]] = [files[j], files[i]];
    render();
  }

  function fileRow(f, i) {
    const ext = extOf(f.name);
    const supported = isSupported(f);
    const tooBig = f.size > maxFileBytes;
    const sizeText = tooBig ? `Trop volumineux (max ${formatBytes(maxFileBytes)})` : supported ? formatBytes(f.size) : `${formatBytes(f.size)} · non pris en charge ici`;
    const reorder = mode === 'tools' && currentTool()?.reorder && files.length > 1;
    return el(
      'li',
      {},
      reorder ? el('span', { class: 'order' }, String(i + 1)) : null,
      Icons.node(ext),
      el('span', { class: 'fmeta' }, el('span', { class: 'name', title: f.name }, f.name), el('span', { class: `size${tooBig || !supported ? ' bad' : ''}` }, sizeText)),
      reorder
        ? el(
            'span',
            { class: 'moves' },
            el('button', { class: 'rm', type: 'button', 'aria-label': `Monter ${f.name}`, disabled: i === 0, onclick: () => move(i, -1) }, '↑'),
            el('button', { class: 'rm', type: 'button', 'aria-label': `Descendre ${f.name}`, disabled: i === files.length - 1, onclick: () => move(i, 1) }, '↓')
          )
        : null,
      el('button', { class: 'rm', type: 'button', 'aria-label': `Retirer ${f.name}`, onclick: () => (files.splice(i, 1), render()) }, '×')
    );
  }

  function render() {
    const hasFiles = files.length > 0;
    hint.textContent = '';
    compressOpts.hidden = mode !== 'compress';
    toolsOpts.hidden = mode !== 'tools';
    if (mode === 'tools') renderTools();

    if (mode === 'convert') {
      runActions.hidden = true;
      // Un seul fichier : il est résumé dans la barre d'action (comme sur la maquette).
      list.replaceChildren(...(files.length > 1 ? files.map(fileRow) : []));
      bar.hidden = !hasFiles;
      subopts.hidden = !hasFiles;
      if (hasFiles) renderConvert();
      return;
    }

    bar.hidden = true;
    subopts.hidden = true;
    list.replaceChildren(...files.map(fileRow));
    runActions.hidden = !hasFiles;
    if (!hasFiles) return;

    const usable = files.filter(isSupported);
    const ignored = files.length - usable.length;
    const tooBig = files.some((f) => f.size > maxFileBytes);
    if (mode === 'compress') {
      runGo.textContent = 'Compresser';
      runGo.disabled = !usable.length || tooBig;
      if (ignored) hint.textContent = `${ignored} fichier(s) ne peuvent pas être compressés (documents Office, archives…) et seront ignorés. L’outil « Créer un ZIP » peut les regrouper.`;
      return;
    }
    const tool = currentTool();
    const info = tool && tools[tool.id];
    runGo.textContent = tool ? tool.verb : 'Choisissez un outil';
    runGo.disabled = !tool || !usable.length || tooBig || (info && usable.length < info.min);
    if (tool && info && usable.length < info.min) hint.textContent = `Ajoutez au moins ${info.min} fichiers compatibles pour cet outil.`;
    else if (tool && ignored) hint.textContent = `${ignored} fichier(s) ne sont pas compatibles avec « ${tool.title} » et seront ignorés.`;
  }

  function renderConvert() {
    const total = files.reduce((s, f) => s + f.size, 0);
    const first = files[0];
    setChildren(
      $('#convert-summary'),
      Icons.node(files.length > 1 ? 'zip' : extOf(first.name)),
      el(
        'span',
        { class: 'fmeta' },
        el('span', { class: 'name', title: first.name }, files.length > 1 ? `${files.length} fichiers` : first.name),
        el('span', { class: 'size' }, formatBytes(total))
      ),
      files.length === 1 ? el('button', { class: 'rm', type: 'button', 'aria-label': `Retirer ${first.name}`, onclick: clearAll }, '×') : null
    );

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
    if (unsupported) hint.textContent = `${unsupported} fichier(s) dans un format non pris en charge seront ignorés. L’outil « Créer un ZIP » peut les regrouper tels quels.`;
    else if (!available.size) hint.textContent = 'Ces fichiers n’ont pas de format de sortie commun : convertissez-les séparément, ou regroupez-les avec l’outil « Créer un ZIP ».';

    // Plusieurs fichiers => le résultat est forcément une archive. On décoche en revenant à un seul
    // fichier si c'est nous qui avions coché la case.
    zipBox.disabled = files.length > 1;
    if (files.length > 1) {
      zipForced ||= !zipBox.checked;
      zipBox.checked = true;
    } else if (zipForced) {
      zipBox.checked = false;
      zipForced = false;
    }
    go.disabled = !target || !supported.length || files.some((f) => f.size > maxFileBytes);
  }

  function renderTools() {
    const exts = files.map((f) => extOf(f.name));
    setChildren(
      $('#tool-grid'),
      TOOL_UI.map((t) => {
        const fits = !exts.length || exts.some((e) => accepts(t.id, e));
        return el(
          'button',
          {
            type: 'button',
            role: 'radio',
            class: `tool-card${fits ? '' : ' dim'}`,
            'aria-checked': String(t.id === toolId),
            onclick: () => {
              toolId = t.id;
              resetFeedback();
              render();
            },
          },
          Icons.node(t.icon),
          el('span', {}, el('b', {}, t.title), el('small', {}, t.desc))
        );
      })
    );
    const tool = currentTool();
    const form = $('#tool-form');
    if (!tool?.fields) return form.replaceChildren();
    toolValues[tool.id] ??= {};
    const values = toolValues[tool.id];
    setChildren(form, tool.fields.map((f) => field(f, values)));
  }

  function field(f, values) {
    if (f.type === 'resize') {
      values.by ??= 'percent';
      values.value ??= '50';
      const by = el(
        'select',
        { 'aria-label': 'Méthode', onchange: (e) => (values.by = e.target.value) },
        el('option', { value: 'percent' }, 'Pourcentage (%)'),
        el('option', { value: 'width' }, 'Largeur (px)'),
        el('option', { value: 'height' }, 'Hauteur (px)')
      );
      by.value = values.by;
      const input = el('input', { type: 'number', min: '1', max: '16000', inputmode: 'numeric', value: values.value, 'aria-label': 'Valeur', oninput: (e) => (values.value = e.target.value) });
      return el(
        'div',
        { class: 'grid' },
        el('label', {}, 'Redimensionner selon', by),
        el('label', {}, 'Valeur', input),
        el('p', { class: 'muted small span2' }, 'Les proportions sont toujours conservées.')
      );
    }
    let input;
    if (f.type === 'select') {
      values[f.name] ??= f.options[0][0];
      input = el('select', { onchange: (e) => (values[f.name] = e.target.value) }, ...f.options.map(([v, l]) => el('option', { value: v }, l)));
      input.value = values[f.name];
    } else {
      input = el('input', { type: 'text', placeholder: f.placeholder || '', value: values[f.name] || '', autocomplete: 'off', oninput: (e) => (values[f.name] = e.target.value) });
    }
    return el('label', {}, f.label, input, f.help ? el('span', { class: 'muted small help' }, f.help) : null);
  }

  function toolOptions(tool) {
    const v = toolValues[tool.id] || {};
    if (tool.id === 'image-resize') {
      const n = Number(v.value);
      if (!Number.isInteger(n) || n < 1) throw new Error('Indiquez une valeur entière positive.');
      return { [v.by || 'percent']: n };
    }
    const out = {};
    for (const f of tool.fields || []) {
      const val = String(v[f.name] ?? (f.type === 'select' ? f.options[0][0] : '')).trim();
      if (f.required && !val) throw new Error(`Le champ « ${f.label} » est obligatoire.`);
      if (val) out[f.name] = val;
    }
    return out;
  }

  // --- Envoi -------------------------------------------------------------------

  go.addEventListener('click', () => {
    const toSend = files.filter((f) => formats[extOf(f.name)]);
    submit('/api/convert', toSend, { target, zip: zipBox.checked ? '1' : '0' }, go, 'Conversion en cours… (peut prendre un moment pour les vidéos)');
  });

  runGo.addEventListener('click', () => {
    const toSend = files.filter(isSupported);
    if (mode === 'compress') {
      const options = { level };
      const maxImage = $('#compress-max-image').value;
      const maxVideo = $('#compress-max-video').value;
      if (maxImage !== '') options.maxImage = Number(maxImage);
      if (maxVideo !== '') options.maxVideo = Number(maxVideo);
      return submit('/api/tools/compress', toSend, { options: JSON.stringify(options) }, runGo, 'Compression en cours… (les vidéos peuvent prendre un moment)');
    }
    const tool = currentTool();
    let options;
    try {
      options = toolOptions(tool);
    } catch (e) {
      return showError(error, e.message);
    }
    submit(`/api/tools/${tool.id}`, toSend, { options: JSON.stringify(options) }, runGo, 'Traitement en cours…');
  });

  function filenameFrom(disposition, fallback) {
    const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition || '');
    if (star) return decodeURIComponent(star[1]);
    const plain = /filename="([^"]+)"/i.exec(disposition || '');
    return plain ? plain[1] : fallback;
  }

  function submit(url, toSend, fields, button, workingText) {
    resetFeedback();
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    toSend.forEach((f) => form.append('files', f, f.name));

    const total = toSend.reduce((s, f) => s + f.size, 0);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.responseType = 'blob';
    button.disabled = true;
    setProgress(progress, 0, 'Envoi…');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) setProgress(progress, e.loaded / e.total, `Envoi : ${formatBytes(e.loaded)} / ${formatBytes(total)}`);
    };
    xhr.upload.onload = () => setProgress(progress, null, workingText);
    xhr.onprogress = (e) => {
      if (e.loaded) setProgress(progress, e.lengthComputable ? e.loaded / e.total : null, `Récupération du résultat : ${formatBytes(e.loaded)}`);
    };
    xhr.onerror = () => {
      progress.hidden = true;
      render();
      showError(error, 'Erreur réseau pendant l’opération.');
    };
    xhr.onload = async () => {
      render();
      if (xhr.status === 200) {
        const name = filenameFrom(xhr.getResponseHeader('Content-Disposition'), 'convertor');
        saveBlob(xhr.response, name);
        const stats = readStats(xhr.getResponseHeader('X-Convertor-Stats'));
        setProgress(progress, 1, stats ? `✅ Terminé : ${name} — ${savingText(stats)}` : `✅ Terminé : ${name} (${formatBytes(xhr.response.size)})`);
        if (stats) showSavings(stats);
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
  }

  // --- Gains de compression ----------------------------------------------------

  function readStats(header) {
    if (!header) return null;
    try {
      return JSON.parse(decodeURIComponent(header));
    } catch {
      return null;
    }
  }

  const pct = (before, after) => Math.round((1 - after / Math.max(before, 1)) * 100);

  function savingText(stats) {
    const before = stats.reduce((s, x) => s + x.before, 0);
    const after = stats.reduce((s, x) => s + x.after, 0);
    return `${formatBytes(before)} → ${formatBytes(after)} (−${pct(before, after)} %)`;
  }

  function showSavings(stats) {
    setChildren(
      results,
      stats.map((s) =>
        el(
          'li',
          {},
          Icons.node(extOf(s.name)),
          el(
            'span',
            { class: 'fmeta' },
            el('span', { class: 'name', title: s.name }, s.name),
            el('span', { class: 'size' }, s.kept ? `${formatBytes(s.before)} · déjà optimisé, fichier d’origine conservé` : `${formatBytes(s.before)} → ${formatBytes(s.after)}`)
          ),
          el('b', { class: `gain${s.kept ? ' none' : ''}` }, s.kept ? '0 %' : `−${pct(s.before, s.after)} %`)
        )
      )
    );
    results.hidden = false;
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
    $('#formats-table').replaceChildren(table, el('p', { class: 'muted small' }, 'Et tous les fichiers, quel que soit leur format, peuvent être regroupés dans un ZIP (onglet Outils).'));
  }
})();
