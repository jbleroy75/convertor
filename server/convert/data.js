'use strict';

// Conversions de données structurées : JSON <-> YAML <-> CSV <-> TSV, en pur JS.

const fs = require('fs/promises');
const YAML = require('yaml');

function parseDelimited(text, sep) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let i = 0;
  if (text.charCodeAt(0) === 0xfeff) i = 1; // BOM
  for (; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === sep) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  const nonEmpty = rows.filter((r) => !(r.length === 1 && r[0] === ''));
  if (!nonEmpty.length) return [];
  const [header, ...body] = nonEmpty;
  return body.map((r) => Object.fromEntries(header.map((h, idx) => [h, r[idx] ?? ''])));
}

function stringifyDelimited(data, sep) {
  let rows = Array.isArray(data) ? data : [data];
  rows = rows.map((r) => (r !== null && typeof r === 'object' && !Array.isArray(r) ? r : { value: r }));
  const headers = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!headers.includes(k)) headers.push(k);
  const cell = (v) => {
    if (v === undefined || v === null) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /["\r\n]/.test(s) || s.includes(sep) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.map(cell).join(sep), ...rows.map((r) => headers.map((h) => cell(r[h])).join(sep))].join('\r\n') + '\r\n';
}

const parsers = {
  json: (t) => JSON.parse(t.replace(/^﻿/, '')),
  yaml: (t) => YAML.parse(t, { maxAliasCount: 100 }),
  yml: (t) => YAML.parse(t, { maxAliasCount: 100 }),
  csv: (t) => parseDelimited(t, t.split('\n', 1)[0].split(';').length > t.split('\n', 1)[0].split(',').length ? ';' : ','),
  tsv: (t) => parseDelimited(t, '\t'),
};

const writers = {
  json: (d) => JSON.stringify(d, null, 2) + '\n',
  yaml: (d) => YAML.stringify(d),
  yml: (d) => YAML.stringify(d),
  csv: (d) => stringifyDelimited(d, ','),
  tsv: (d) => stringifyDelimited(d, '\t'),
};

async function convertData(input, from, to, output) {
  const text = await fs.readFile(input, 'utf8');
  let data;
  try {
    data = parsers[from](text);
  } catch (e) {
    throw new Error(`Fichier ${from.toUpperCase()} invalide : ${e.message.split('\n')[0]}`);
  }
  await fs.writeFile(output, writers[to](data));
}

module.exports = { convertData, parseDelimited, stringifyDelimited, DATA_FORMATS: Object.keys(parsers) };
