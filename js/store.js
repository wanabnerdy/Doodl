// Local session persistence. IndexedDB rather than localStorage: the probe measured
// ~39 GB of quota here, against localStorage's ~5 MB — and stroke data grows fast.

const DB_NAME = 'doodl';
const DB_VERSION = 2;
const STORE = 'sessions';
const AUDIO = 'audio';

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
      // Audio lives in chunks, keyed by session and order, rather than as one blob on
      // the session record. A meeting is written as it happens — roughly 93 MB an hour
      // — and holding that in memory to save at the end would risk the lot on a crash
      // and put hundreds of megabytes in RAM on a long meeting.
      if (!db.objectStoreNames.contains(AUDIO)) {
        db.createObjectStore(AUDIO, { keyPath: ['sessionId', 'index'] })
          .createIndex('sessionId', 'sessionId');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(mode, fn, storeName = STORE) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const result = fn(t.objectStore(storeName));
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

export async function deleteSession(id) {
  await deleteAudio(id);
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
      wordCount: (s.utterances || []).reduce((n, u) => n + u.text.trim().split(/\s+/).filter(Boolean).length, 0),
      audioBytes: s.audio ? s.audio.bytes : 0
    }))
    .sort((a, b) => b.startedAt - a.startedAt);
}

/* ---------------------------------------------------------------- audio ---- */

// One chunk, written the moment it arrives from the recorder.
export function putAudioChunk(sessionId, index, blob, t) {
  return tx('readwrite', store => { store.put({ sessionId, index, blob, t }); }, AUDIO);
}

function chunksFor(sessionId) {
  return tx('readonly', store => ({
    __req: store.index('sessionId').getAll(IDBKeyRange.only(sessionId))
  }), AUDIO).then(rows => (rows || []).sort((a, b) => a.index - b.index));
}

// Reassembled in order. The pieces are only meaningful as one stream — a WebM chunk
// on its own has no header and will not play.
export async function getAudioBlob(sessionId, mimeType) {
  const rows = await chunksFor(sessionId);
  if (!rows.length) return null;
  return new Blob(rows.map(r => r.blob), { type: mimeType || rows[0].blob.type });
}

export async function audioBytes(sessionId) {
  const rows = await chunksFor(sessionId);
  return rows.reduce((n, r) => n + (r.blob.size || 0), 0);
}

export async function deleteAudio(sessionId) {
  const rows = await chunksFor(sessionId);
  await tx('readwrite', store => {
    for (const r of rows) store.delete([sessionId, r.index]);
  }, AUDIO);
  return rows.length;
}

/* -------------------------------------------------------------- storage ---- */

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
