'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDelimited, stringifyDelimited } = require('../server/convert/data');

test('CSV : guillemets, séparateurs et sauts de ligne', () => {
  const rows = [{ a: 'x,y', b: 'il a dit "oui"', c: 'ligne1\nligne2' }, { a: '1', b: '', c: 'z' }];
  const csv = stringifyDelimited(rows, ',');
  assert.deepEqual(parseDelimited(csv, ','), rows);
});

test('CSV : objets imbriqués sérialisés en JSON, colonnes fusionnées', () => {
  const csv = stringifyDelimited([{ a: 1 }, { b: { c: 2 } }], ',');
  assert.equal(csv, 'a,b\r\n1,\r\n,"{""c"":2}"\r\n');
});
