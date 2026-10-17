'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../public/js/crypto.js');

test('base64url aller-retour', () => {
  const b = C.randomBytes(100);
  assert.deepEqual(C.b64urlDecode(C.b64urlEncode(b)), b);
  assert.throws(() => C.b64urlDecode('a+b/'));
});

test('chiffrement par blocs : aller-retour et détection des altérations', async () => {
  const secret = C.randomBytes(32);
  const hkdfSalt = C.randomBytes(16);
  const k = await C.deriveKeys({ secret, hkdfSalt });
  const data = C.randomBytes(1000);
  const enc = await C.encryptChunk(k.fileKey, 3, false, data);
  assert.equal(enc.length, data.length + C.TAG_BYTES);
  assert.deepEqual(await C.decryptChunk(k.fileKey, 3, false, enc), data);

  // Mauvais index (réordonnancement), mauvais drapeau « dernier » (troncature), octet modifié.
  await assert.rejects(C.decryptChunk(k.fileKey, 4, false, enc));
  await assert.rejects(C.decryptChunk(k.fileKey, 3, true, enc));
  const tampered = enc.slice();
  tampered[10] ^= 1;
  await assert.rejects(C.decryptChunk(k.fileKey, 3, false, tampered));
});

test('les clés dépendent du secret ET du mot de passe', async () => {
  const secret = C.randomBytes(32);
  const hkdfSalt = C.randomBytes(16);
  const pwSalt = C.randomBytes(16);
  const pwIter = 1000;
  const a = await C.deriveKeys({ secret, hkdfSalt, password: 'correct horse', pwSalt, pwIter });
  const b = await C.deriveKeys({ secret, hkdfSalt, password: 'correct horse', pwSalt, pwIter });
  const wrongPw = await C.deriveKeys({ secret, hkdfSalt, password: 'wrong horse', pwSalt, pwIter });
  const noPw = await C.deriveKeys({ secret, hkdfSalt });
  assert.deepEqual(a.authToken, b.authToken);
  assert.notDeepEqual(a.authToken, wrongPw.authToken);
  assert.notDeepEqual(a.authToken, noPw.authToken);

  const meta = { name: 'secret.pdf', size: 42 };
  const enc = await C.encryptMeta(a.metaKey, meta);
  assert.deepEqual(await C.decryptMeta(b.metaKey, enc), meta);
  await assert.rejects(C.decryptMeta(wrongPw.metaKey, enc));
  // Les clés contenu et métadonnées sont indépendantes.
  await assert.rejects(C.decryptMeta(a.fileKey, enc));
});

test('nonce : index et drapeau encodés', () => {
  assert.deepEqual([...C.chunkNonce(1, true)], [0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1]);
  assert.deepEqual([...C.chunkNonce(0x01020304, false)], [0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4]);
  assert.throws(() => C.chunkNonce(-1, false));
});
