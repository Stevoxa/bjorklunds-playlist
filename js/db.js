import { APP_STORAGE_ID } from './config.js';

const DB_NAME = `${APP_STORAGE_ID}-idb`;
const DB_VERSION = 1;
const STORE_VAULT = 'vault';

/**
 * @returns {Promise<IDBDatabase>}
 */
export function openDatabase() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_VAULT)) {
        db.createObjectStore(STORE_VAULT, { keyPath: 'id' });
      }
    };
  });
}

/**
 * @param {string} id
 * @returns {Promise<unknown | undefined>}
 */
export async function idbGet(id) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_VAULT, 'readonly');
    const store = tx.objectStore(STORE_VAULT);
    const req = store.get(id);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result?.value);
    tx.oncomplete = () => db.close();
  });
}

/**
 * @param {string} id
 * @param {unknown} value
 */
export async function idbPut(id, value) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_VAULT, 'readwrite');
    const store = tx.objectStore(STORE_VAULT);
    store.put({ id, value });
    tx.onerror = () => reject(tx.error);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
  });
}

export async function idbDelete(id) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_VAULT, 'readwrite');
    const store = tx.objectStore(STORE_VAULT);
    store.delete(id);
    tx.onerror = () => reject(tx.error);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
  });
}

/**
 * Tar bort alla poster vars `id` börjar med något av prefixen.
 * Används av Inställningar -> cache-rensning utan att behöva känna till exakta nycklar.
 *
 * @param {string[]} prefixes
 * @returns {Promise<number>} antal rader som togs bort
 */
export async function idbDeleteByIdPrefix(prefixes) {
  const normalized = Array.isArray(prefixes)
    ? prefixes.filter((p) => typeof p === 'string' && p.length > 0)
    : [];
  if (normalized.length === 0) return 0;
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_VAULT, 'readwrite');
    const store = tx.objectStore(STORE_VAULT);
    let deleted = 0;
    const req = store.openCursor();
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      const key = typeof cursor.key === 'string' ? cursor.key : String(cursor.key ?? '');
      if (normalized.some((prefix) => key.startsWith(prefix))) {
        cursor.delete();
        deleted += 1;
      }
      cursor.continue();
    };
    tx.onerror = () => reject(tx.error);
    tx.oncomplete = () => {
      db.close();
      resolve(deleted);
    };
  });
}
