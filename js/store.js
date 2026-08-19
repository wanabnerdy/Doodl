// Local session persistence. IndexedDB rather than localStorage: the probe measured
// ~39 GB of quota here, against localStorage's ~5 MB — and stroke data grows fast.

const DB_NAME = 'doodl';
const DB_VERSION = 1;
const STORE = 'sessions';

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' }).createIndex('startedAt', 'startedAt');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const result = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(result && result.__req ? result.__req.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export function saveSession(session) {
  return tx('readwrite', store => { store.put(session); });
}

export function getSession(id) {
  return tx('readonly', store => ({ __req: store.get(id) }));
}

export function deleteSession(id) {
  return tx('readwrite', store => { store.delete(id); });
}

// Full records are heavy, so the home screen only needs a summary of each.
export async function listSessions() {
  const all = await tx('readonly', store => ({ __req: store.getAll() }));
  return (all || [])
    .map(s => ({
      id: s.id,
      title: s.title,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      background: s.background,
      strokeCount: (s.strokes || []).length,
      highlightCount: (s.highlights || []).length,
      wordCount: (s.utterances || []).reduce((n, u) => n + u.text.trim().split(/\s+/).filter(Boolean).length, 0)
    }))
    .sort((a, b) => b.startedAt - a.startedAt);
}

// Without this, the browser may evict everything under storage pressure.
export async function requestPersistence() {
  if (!navigator.storage || !navigator.storage.persist) return null;
  if (await navigator.storage.persisted()) return true;
  return navigator.storage.persist();
}

export async function usage() {
  if (!navigator.storage || !navigator.storage.estimate) return null;
  const { usage, quota } = await navigator.storage.estimate();
  return { usedMB: usage / 1048576, quotaMB: quota / 1048576 };
}
