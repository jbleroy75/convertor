/*
 * Convertor — chiffrement de bout en bout des transferts.
 *
 * - Un secret aléatoire de 256 bits est généré dans le navigateur. Il voyage
 *   uniquement dans le fragment du lien (#…), que les navigateurs n'envoient
 *   jamais au serveur.
 * - Mot de passe optionnel : PBKDF2-SHA256 (600 000 itérations), combiné au
 *   secret. Il faut LES DEUX pour déchiffrer.
 * - HKDF-SHA256 dérive trois clés indépendantes : contenu, métadonnées, et un
 *   jeton d'accès dont le serveur ne stocke que l'empreinte SHA-256 (sans lui,
 *   impossible même de récupérer les blocs chiffrés).
 * - Contenu découpé en blocs de 8 Mio chiffrés en AES-256-GCM. Le nonce encode
 *   l'index du bloc et un drapeau « dernier bloc » (construction STREAM) :
 *   blocs réordonnés, dupliqués ou fichier tronqué => échec du déchiffrement.
 *
 * Script « classique » : utilisable dans la page, le service worker et Node (tests).
 */
(function (root) {
  'use strict';

  const subtle = root.crypto.subtle;
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const VERSION = 1;
  const CHUNK_BYTES = 8 * 1024 * 1024;
  const TAG_BYTES = 16;
  const PBKDF2_ITERATIONS = 600000;

  function randomBytes(n) {
    const b = new Uint8Array(n);
    root.crypto.getRandomValues(b);
    return b;
  }

  function b64urlEncode(bytes) {
    bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function b64urlDecode(str) {
    if (typeof str !== 'string' || !/^[A-Za-z0-9_-]*$/.test(str)) throw new Error('Encodage invalide');
    const s = atob(str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4));
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  async function sha256(bytes) {
    return new Uint8Array(await subtle.digest('SHA-256', bytes));
  }

  function concat(a, b) {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  }

  /**
   * Dérive les clés d'un transfert.
   * @returns {Promise<{fileKey: CryptoKey, metaKey: CryptoKey, authToken: Uint8Array}>}
   */
  async function deriveKeys({ secret, hkdfSalt, password, pwSalt, pwIter }) {
    if (!(secret instanceof Uint8Array) || secret.length !== 32) throw new Error('Clé du lien invalide');
    let ikm = secret;
    if (password) {
      const pwKey = await subtle.importKey('raw', enc.encode(password.normalize('NFC')), 'PBKDF2', false, ['deriveBits']);
      const pwBits = await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: pwSalt, iterations: pwIter }, pwKey, 256);
      ikm = concat(secret, new Uint8Array(pwBits));
    }
    const base = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveKey', 'deriveBits']);
    const hkdf = (info) => ({ name: 'HKDF', hash: 'SHA-256', salt: hkdfSalt, info: enc.encode('convertor/v1/' + info) });
    const aes = { name: 'AES-GCM', length: 256 };
    const [fileKey, metaKey, authBits] = await Promise.all([
      subtle.deriveKey(hkdf('content'), base, aes, false, ['encrypt', 'decrypt']),
      subtle.deriveKey(hkdf('metadata'), base, aes, false, ['encrypt', 'decrypt']),
      subtle.deriveBits(hkdf('auth'), base, 256),
    ]);
    return { fileKey, metaKey, authToken: new Uint8Array(authBits) };
  }

  /** Nonce 96 bits : 7 octets nuls | drapeau dernier bloc | index (uint32 big-endian). */
  function chunkNonce(index, last) {
    if (!Number.isInteger(index) || index < 0 || index > 0xffffffff) throw new Error('Index de bloc invalide');
    const iv = new Uint8Array(12);
    iv[7] = last ? 1 : 0;
    new DataView(iv.buffer).setUint32(8, index, false);
    return iv;
  }

  async function encryptChunk(fileKey, index, last, plaintext) {
    return new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: chunkNonce(index, last) }, fileKey, plaintext));
  }

  async function decryptChunk(fileKey, index, last, ciphertext) {
    try {
      return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: chunkNonce(index, last) }, fileKey, ciphertext));
    } catch (e) {
      throw new Error('Bloc ' + index + ' corrompu ou altéré : déchiffrement refusé');
    }
  }

  // Clé de métadonnées à usage unique => nonce constant sans risque.
  const META_IV = new Uint8Array(12);

  async function encryptMeta(metaKey, meta) {
    return new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: META_IV }, metaKey, enc.encode(JSON.stringify(meta))));
  }

  async function decryptMeta(metaKey, data) {
    let plain;
    try {
      plain = await subtle.decrypt({ name: 'AES-GCM', iv: META_IV }, metaKey, data);
    } catch (e) {
      throw new Error('Impossible de déchiffrer les informations du fichier');
    }
    return JSON.parse(dec.decode(plain));
  }

  const api = {
    VERSION,
    CHUNK_BYTES,
    TAG_BYTES,
    PBKDF2_ITERATIONS,
    randomBytes,
    b64urlEncode,
    b64urlDecode,
    sha256,
    deriveKeys,
    chunkNonce,
    encryptChunk,
    decryptChunk,
    encryptMeta,
    decryptMeta,
  };
  root.ConvertorCrypto = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
