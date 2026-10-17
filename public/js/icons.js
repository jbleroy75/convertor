/* Icônes de types de fichiers (SVG générés, sans dépendance). */
(function () {
  'use strict';

  const FAMILIES = [
    ['pdf', '#E5322D', ['pdf']],
    ['word', '#2B6DE8', ['doc', 'docx', 'odt', 'rtf', 'wpd', 'pages']],
    ['sheet', '#1E9E57', ['xls', 'xlsx', 'ods', 'csv', 'tsv']],
    ['slide', '#F0711E', ['ppt', 'pptx', 'odp', 'key']],
    ['image', '#8B5CF6', ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'ico', 'avif', 'heic', 'heif', 'psd', 'tga', 'svg']],
    ['video', '#D946EF', ['mp4', 'webm', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'm4v', 'mpeg', 'mpg', '3gp', 'ts', 'mts']],
    ['audio', '#0EA5E9', ['mp3', 'wav', 'ogg', 'oga', 'flac', 'aac', 'm4a', 'opus', 'wma', 'aiff', 'aif', 'amr', 'caf']],
    ['zip', '#64748B', ['zip', '7z', 'rar', 'gz', 'tar']],
  ];

  function family(ext) {
    for (const [name, color, exts] of FAMILIES) if (exts.includes(ext)) return { name, color };
    return { name: 'text', color: '#475569' };
  }

  const GLYPHS = {
    pdf: '<path d="M10 15h12M10 19h12M10 23h8" stroke="#fff" stroke-width="2" stroke-linecap="round"/>',
    word: '<path d="M9.5 14l2.2 9 2.3-7 2.3 7 2.2-9" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    sheet: '<path d="M11 14l8 10M19 14l-8 10" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/>',
    slide: '<path d="M12 24V14h4.5a3 3 0 0 1 0 6H12" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
    image: '<circle cx="12" cy="15" r="2" fill="#fff"/><path d="M8 25l5-5 3 3 3-4 5 6z" fill="#fff"/>',
    video: '<path d="M12 13.5v11l9-5.5z" fill="#fff"/>',
    audio: '<path d="M18 13v9.5a2.5 2.5 0 1 1-2-2.45V15l-4 1" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    zip: '<path d="M14 3h2v2h-2zM16 5h2v2h-2zM14 7h2v2h-2zM16 9h2v2h-2zM14 11h2v2h-2z" fill="#fff"/><rect x="13" y="15" width="6" height="9" rx="2" fill="#fff"/><rect x="15" y="19" width="2" height="3" rx="1" fill="#64748B"/>',
    text: '<path d="M10 15h12M10 19h12M10 23h7" stroke="#fff" stroke-width="2" stroke-linecap="round"/>',
  };

  /** Retourne le markup SVG d'une icône de fichier pour l'extension donnée. */
  function svg(ext) {
    const { name, color } = family(String(ext || '').toLowerCase());
    return (
      `<svg viewBox="0 0 32 34" aria-hidden="true" class="ficon ficon-${name}">` +
      `<path d="M7 1h13l9 9v20a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V4a3 3 0 0 1 3-3z" fill="${color}"/>` +
      `<path d="M20 1v6a3 3 0 0 0 3 3h6z" fill="#fff" fill-opacity=".45"/>` +
      GLYPHS[name] +
      `</svg>`
    );
  }

  function node(ext, cls) {
    const span = document.createElement('span');
    span.className = `${cls || 'ficon-wrap'} tint-${family(String(ext || '').toLowerCase()).name}`;
    span.innerHTML = svg(ext);
    return span;
  }

  // Remplit tous les éléments décoratifs <… data-icon="pdf">.
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-icon]').forEach((elt) => elt.insertAdjacentHTML('afterbegin', svg(elt.dataset.icon)));
  });

  window.FileIcons = { svg, node, family };
})();
