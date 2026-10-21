// On-device script storage (replaces the Mac server API).
// Primary backend: IndexedDB. Fallback: localStorage (e.g. if IndexedDB is unavailable/blocked).
const DB_NAME = 'voice-teleprompter';
const STORE = 'scripts';
const LS_KEY = 'tp.scripts';

const slug = (s) =>
  String(s).toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'script';
const wordCount = (t) => (t.trim() ? t.trim().split(/\s+/).length : 0);

function openIDB() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window) || !window.indexedDB) return reject(new Error('no indexedDB'));
    const timer = setTimeout(() => reject(new Error('indexedDB timeout')), 3000); // Safari can hang here
    let req;
    try { req = indexedDB.open(DB_NAME, 1); } catch (e) { clearTimeout(timer); return reject(e); }
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => { clearTimeout(timer); resolve(req.result); };
    req.onerror = () => { clearTimeout(timer); reject(req.error); };
    req.onblocked = () => { clearTimeout(timer); reject(new Error('blocked')); };
  });
}

function idbBackend(dbh) {
  const tx = (mode, fn) =>
    new Promise((resolve, reject) => {
      const t = dbh.transaction(STORE, mode);
      const out = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(out && 'result' in out ? out.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  return {
    kind: 'indexeddb',
    getAll: () => tx('readonly', (s) => s.getAll()),
    get: (id) => tx('readonly', (s) => s.get(id)),
    put: (rec) => tx('readwrite', (s) => s.put(rec)),
    del: (id) => tx('readwrite', (s) => s.delete(id)),
  };
}

function lsBackend() {
  const read = () => { try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch { return {}; } };
  const write = (m) => localStorage.setItem(LS_KEY, JSON.stringify(m));
  return {
    kind: 'localstorage',
    getAll: async () => Object.values(read()),
    get: async (id) => read()[id],
    put: async (rec) => { const m = read(); m[rec.id] = rec; write(m); },
    del: async (id) => { const m = read(); delete m[id]; write(m); },
  };
}

let backendP;
function backend() {
  if (!backendP) backendP = openIDB().then(idbBackend).catch(() => lsBackend());
  return backendP;
}

async function uniqueId(b, base) {
  const all = new Set((await b.getAll()).map((r) => r.id));
  let id = base, n = 2;
  while (all.has(id)) id = `${base}-${n++}`;
  return id;
}

export const db = {
  async kind() { return (await backend()).kind; },

  /** Ask Safari not to evict our data (best effort; Home Screen apps are already exempt from 7-day eviction). */
  async persist() {
    try { return navigator.storage && navigator.storage.persist ? await navigator.storage.persist() : false; } catch { return false; }
  },

  async list() {
    const b = await backend();
    return (await b.getAll())
      .map((r) => ({ id: r.id, title: r.title, words: wordCount(r.text), updated: r.updated }))
      .sort((a, b2) => b2.updated - a.updated);
  },

  async get(id) { return (await backend()).get(id); },

  async create({ title, text }) {
    const b = await backend();
    const t = String(title || text.slice(0, 40)).slice(0, 120);
    const rec = { id: await uniqueId(b, slug(t)), title: t, text: String(text), updated: Date.now() };
    await b.put(rec);
    return rec;
  },

  async update(id, { title, text }) {
    const b = await backend();
    const old = await b.get(id);
    if (!old) throw new Error('not found');
    const rec = { ...old, title: String(title || old.title).slice(0, 120), text: String(text), updated: Date.now() };
    await b.put(rec);
    return rec;
  },

  async remove(id) { await (await backend()).del(id); },

  async exportAll() {
    const rows = await (await backend()).getAll();
    return {
      app: 'voice-teleprompter',
      version: 1,
      exported: new Date().toISOString(),
      scripts: rows.map(({ title, text, updated }) => ({ title, text, updated })),
    };
  },

  /** Import a backup produced by exportAll (skips exact duplicates). Returns number imported. */
  async importAll(data) {
    const items = Array.isArray(data) ? data : data && Array.isArray(data.scripts) ? data.scripts : null;
    if (!items) throw new Error('not a teleprompter backup');
    const b = await backend();
    const existing = await b.getAll();
    let n = 0;
    for (const it of items) {
      if (!it || typeof it.text !== 'string' || !it.text.trim()) continue;
      if (existing.some((r) => r.title === it.title && r.text === it.text)) continue;
      const title = String(it.title || it.text.slice(0, 40)).slice(0, 120);
      const rec = { id: await uniqueId(b, slug(title)), title, text: it.text, updated: it.updated || Date.now() };
      await b.put(rec);
      existing.push(rec);
      n++;
    }
    return n;
  },
};
