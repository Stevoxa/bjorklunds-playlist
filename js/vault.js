import { idbGet, idbPut, idbDelete } from './db.js';
import { encryptJson, decryptJson } from './crypto.js';
import { APP_STORAGE_ID } from './config.js';

export const VAULT_KEY = `${APP_STORAGE_ID}-encrypted-vault`;

/**
 * @param {string} passphrase
 * @returns {Promise<object | null>}
 */
export async function loadVault(passphrase) {
  const raw = await idbGet(VAULT_KEY);
  if (!raw) return null;
  return decryptJson(raw, passphrase);
}

/**
 * @param {object} data
 * @param {string} passphrase
 */
export async function saveVault(data, passphrase) {
  const encrypted = await encryptJson(data, passphrase);
  await idbPut(VAULT_KEY, encrypted);
}

export async function clearVault() {
  await idbDelete(VAULT_KEY);
}
