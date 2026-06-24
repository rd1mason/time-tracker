const DB_NAME = 'time-tracker-db';
const DB_VER  = 3;
let db = null;

export function openDB() {
  return new Promise((res, rej) => {
    if (db) return res(db);
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = e => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('sessions')) {
        const s = d.createObjectStore('sessions', { keyPath: 'id', autoIncrement: true });
        s.createIndex('date', 'date', { unique: false });
      }
      if (!d.objectStoreNames.contains('screenshots')) {
        const s = d.createObjectStore('screenshots', { keyPath: 'id', autoIncrement: true });
        s.createIndex('sessionId', 'sessionId', { unique: false });
      }
      if (!d.objectStoreNames.contains('state')) {
        d.createObjectStore('state', { keyPath: 'key' });
      }
      // v2→v3: no schema changes; old 'note' field is handled in UI layer
    };
    req.onsuccess = e => { db = e.target.result; res(db); };
    req.onerror   = () => rej(req.error);
  });
}

async function tx(stores, mode, fn) {
  const d = await openDB();
  return new Promise((res, rej) => {
    const t = d.transaction(stores, mode);
    t.onerror = () => rej(t.error);
    fn(t, res, rej);
  });
}

export const saveSession = (s) => tx(['sessions'], 'readwrite', (t, res) => {
  const r = t.objectStore('sessions').add(s);
  r.onsuccess = () => res(r.result);
});

export const updateSession = (s) => tx(['sessions'], 'readwrite', (t, res) => {
  const r = t.objectStore('sessions').put(s);
  r.onsuccess = () => res(r.result);
});

export const deleteSession = (id) => tx(['sessions', 'screenshots'], 'readwrite', (t, res) => {
  t.objectStore('sessions').delete(id);
  const idx = t.objectStore('screenshots').index('sessionId');
  const req = idx.getAllKeys(id);
  req.onsuccess = () => {
    req.result.forEach(k => t.objectStore('screenshots').delete(k));
    res();
  };
});

export const getAllSessions = () => tx(['sessions'], 'readonly', (t, res) => {
  const r = t.objectStore('sessions').getAll();
  r.onsuccess = () => res([...r.result].reverse());
});

export const clearAllSessions = () => tx(['sessions', 'screenshots'], 'readwrite', (t, res) => {
  t.objectStore('sessions').clear();
  t.objectStore('screenshots').clear();
  t.oncomplete = () => res();
});

export const saveScreenshot = (s) => tx(['screenshots'], 'readwrite', (t, res) => {
  const r = t.objectStore('screenshots').add(s);
  r.onsuccess = () => res(r.result);
});

export const updateScreenshot = (sc) => tx(['screenshots'], 'readwrite', (t, res) => {
  const r = t.objectStore('screenshots').put(sc);
  r.onsuccess = () => res(r.result);
});

export const deleteScreenshot = (id) => tx(['screenshots'], 'readwrite', (t, res) => {
  const r = t.objectStore('screenshots').delete(id);
  r.onsuccess = () => res();
});

export const getScreenshotsBySession = (sid) => tx(['screenshots'], 'readonly', (t, res) => {
  const r = t.objectStore('screenshots').index('sessionId').getAll(sid);
  r.onsuccess = () => res(r.result);
});

export const getState = (key) => tx(['state'], 'readonly', (t, res) => {
  const r = t.objectStore('state').get(key);
  r.onsuccess = () => res(r.result?.value ?? null);
});

export const setState = (key, value) => tx(['state'], 'readwrite', (t, res) => {
  const r = t.objectStore('state').put({ key, value });
  r.onsuccess = () => res();
});

export const importSessions = (sessions) => tx(['sessions'], 'readwrite', (t, res) => {
  const store = t.objectStore('sessions');
  sessions.forEach(s => store.put(s));
  t.oncomplete = () => res(sessions.length);
});
