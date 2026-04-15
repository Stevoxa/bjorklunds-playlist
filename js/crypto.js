const ITERATIONS = 210_000;
const SALT_LEN = 16;
const IV_LEN = 12;

function bufferToB64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function b64ToBuffer(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/**
 * @param {string} password
 * @param {ArrayBuffer} salt
 * @returns {Promise<CryptoKey>}
 */
export async function deriveKey(password, salt) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: new Uint8Array(salt),
      iterations: ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * @param {object} payload
 * @param {string} password
 * @returns {Promise<{ salt: string, iv: string, ciphertext: string }>}
 */
export async function encryptJson(payload, password) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const key = await deriveKey(password, salt.buffer);
  const enc = new TextEncoder();
  const plaintext = enc.encode(JSON.stringify(payload));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  return {
    salt: bufferToB64(salt.buffer),
    iv: bufferToB64(iv.buffer),
    ciphertext: bufferToB64(ciphertext),
  };
}

/**
 * @param {{ salt: string, iv: string, ciphertext: string }} blob
 * @param {string} password
 * @returns {Promise<object>}
 */
export async function decryptJson(blob, password) {
  const salt = b64ToBuffer(blob.salt);
  const iv = new Uint8Array(b64ToBuffer(blob.iv));
  const ciphertext = b64ToBuffer(blob.ciphertext);
  const key = await deriveKey(password, salt);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  const dec = new TextDecoder();
  return JSON.parse(dec.decode(plaintext));
}

export function randomSaltBytes() {
  return crypto.getRandomValues(new Uint8Array(SALT_LEN)).buffer;
}
