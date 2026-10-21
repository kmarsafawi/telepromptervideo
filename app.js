import { tokenize, Matcher } from './matcher.js';
import { SpeechFollower } from './speech.js';
import { db } from './storage.js';
import { VideoRecorder } from './recorder.js';

const $ = (s) => document.querySelector(s);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode etc. */ } },
};

const LANGS = [
  ['en-US', 'English (US)'], ['en-GB', 'English (UK)'], ['en-AU', 'English (Australia)'], ['en-IN', 'English (India)'],
  ['ar-SA', 'Arabic (Saudi Arabia)'], ['es-ES', 'Spanish (Spain)'], ['es-MX', 'Spanish (Mexico)'], ['fr-FR', 'French'],
  ['de-DE', 'German'], ['it-IT', 'Italian'], ['pt-BR', 'Portuguese (Brazil)'], ['nl-NL', 'Dutch'], ['hi-IN', 'Hindi'],
  ['ja-JP', 'Japanese'], ['ko-KR', 'Korean'], ['zh-CN', 'Chinese (Mandarin)'],
];
const DEFAULTS = { fontSize: 44, lineHeight: 1.5, margin: 6, mirror: false, marker: true, theme: 'dark', lang: 'en-US', mode: 'voice', wpm: 150, record: false, camera: 'user' };
const settings = { ...DEFAULTS, ...store.get('tp.settings', {}) };

let scripts = [];
let selectedId = store.get('tp.last', null);
let current = null; // loaded script record
let tokens = [], spans = [], matcher = null, pos = 0;
let state = 'idle'; // idle | running | paused | suspended
let follower = null;
let editing = null; // script id being edited (null = new)
let recorder = null; // active VideoRecorder, or null when not recording
let recSegments = []; // {blob, mimeType} clips finished so far this reader visit (backgrounding can split a take)
let recTimer = null;

// ---------- helpers ----------
let toastTimer;
function toast(msg, ms = 4000) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => (t.hidden = true), ms);
}
function cleanScript(t) {
  return t.replace(/\r\n?/g, '\n')
    .replace(/^---\n[\s\S]*?\n---\n/, '') // front matter
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s*/gm, '').replace(/^\s*>\s?/gm, '').replace(/^\s*[-*+]\s+/gm, '')
    .replace(/(\*\*|__|\*|`)/g, '');
}

// ---------- settings ----------
function applySettings() {
  const r = document.documentElement.style;
  r.setProperty('--fs', settings.fontSize + 'px');
  r.setProperty('--lh', settings.lineHeight);
  r.setProperty('--mx', settings.margin + '%');
  document.body.classList.toggle('light', settings.theme === 'light');
  $('#text').classList.toggle('mirror', !!settings.mirror);
  $('#reader').classList.toggle('nomarker', !settings.marker);
  $('meta[name=theme-color]').content = settings.theme === 'light' ? '#ffffff' : '#000000';
  $('#wpmVal').textContent = settings.wpm + ' wpm';
  needAlign = true;
}
function syncSettingsUI() {
  document.querySelectorAll('[data-key]').forEach((el) => {
    const v = settings[el.dataset.key];
    if (el.type === 'checkbox') el.checked = !!v; else el.value = v;
  });
}
function bindSettings() {
  $('#langSel').innerHTML = LANGS.map(([c, n]) => `<option value="${c}">${n}</option>`).join('');
  syncSettingsUI();
  document.querySelectorAll('[data-key]').forEach((el) => {
    el.addEventListener('input', () => {
      const k = el.dataset.key;
      settings[k] = el.type === 'checkbox' ? el.checked : el.type === 'range' ? Number(el.value) : el.value;
      store.set('tp.settings', settings);
      applySettings();
      syncSettingsUI(); // keeps the two wpm sliders in step
      if (k === 'lang' && follower) follower.setLang(settings.lang);
      if (k === 'wpm' && state === 'running' && effectiveMode() === 'scroll') setStatus('ok', `Auto-scroll · ${settings.wpm} wpm`);
      if (k === 'record') {
        if (settings.record && state === 'running') maybeStartRecording(); // this click is itself the user gesture
        else if (!settings.record && recorder && recorder.recording) stopRecordingSegment();
        refreshRecUI();
      }
    });
  });
}

// ---------- library ----------
function renderList() {
  const ul = $('#list');
  ul.innerHTML = '';
  $('#empty').hidden = scripts.length > 0;
  for (const s of scripts) {
    const li = document.createElement('li');
    if (s.id === selectedId) li.className = 'sel';
    const pick = document.createElement('button');
    pick.className = 'pick';
    pick.innerHTML = '<b></b><span></span>';
    pick.firstChild.textContent = s.title;
    pick.lastChild.textContent = `${s.words} words`;
    pick.onclick = () => selectScript(s.id);
    const ed = document.createElement('button');
    ed.className = 'edit'; ed.textContent = 'Edit';
    ed.onclick = () => openEditor(s.id);
    li.append(pick, ed);
    ul.append(li);
  }
}
async function loadList() {
  try {
    scripts = await db.list();
  } catch {
    showNotice('Could not open on-device storage. Are you in a Private tab? Use a normal Safari tab or the Home Screen app.');
    return;
  }
  if (selectedId && !scripts.some((s) => s.id === selectedId)) selectedId = null;
  if (!selectedId && scripts.length) selectedId = scripts[0].id;
  renderList();
  if (selectedId && (!current || current.id !== selectedId)) await selectScript(selectedId);
}
function showNotice(msg) { const n = $('#notice'); n.textContent = msg; n.hidden = !msg; }

async function selectScript(id) {
  selectedId = id;
  store.set('tp.last', id);
  renderList();
  $('#btnStart').disabled = true;
  try {
    const rec = await db.get(id);
    if (!rec) throw new Error('missing');
    if (selectedId !== id) return; // user picked something else meanwhile
    current = rec;
    tokens = tokenize(cleanScript(rec.text));
    matcher = new Matcher(tokens);
    buildText();
    const saved = store.get('tp.pos.' + id, 0);
    pos = 0;
    paintAll();
    setPos(saved > 0 && saved < tokens.length ? saved : 0, { instant: true });
    updateStartLabel();
  } catch {
    showNotice('Could not load that script.');
  }
}
function updateStartLabel() {
  const b = $('#btnStart');
  b.disabled = !current || !tokens.length;
  b.textContent = pos > 0 && pos < tokens.length ? `Continue (${Math.round((pos / tokens.length) * 100)}%)` : 'Start';
}

// ---------- editor ----------
async function openEditor(id, prefill) {
  editing = id || null;
  $('#edHeading').textContent = id ? 'Edit script' : 'New script';
  $('#edDelete').hidden = !id;
  $('#edTitle').value = prefill?.title || '';
  $('#edText').value = prefill?.text || '';
  if (id) {
    try { const r = await db.get(id); $('#edTitle').value = r.title; $('#edText').value = r.text; } catch { toast('Could not load script'); return; }
  }
  $('#editor').hidden = false;
}
function readFileInto(file, cb) {
  const fr = new FileReader();
  fr.onload = () => cb(String(fr.result), file.name.replace(/\.[^.]+$/, ''));
  fr.readAsText(file);
}
async function saveEditor() {
  const title = $('#edTitle').value.trim();
  const text = $('#edText').value;
  if (!text.trim()) { toast('Script is empty'); return; }
  try {
    const data = { title: title || text.trim().slice(0, 40), text };
    const rec = editing ? await db.update(editing, data) : await db.create(data);
    db.persist();
    if (editing) store.set('tp.pos.' + rec.id, 0);
    $('#editor').hidden = true;
    current = null; selectedId = rec.id;
    await loadList();
    await selectScript(rec.id);
  } catch { toast('Save failed'); }
}

// ---------- text rendering / pointer ----------
const scroller = $('#scroller');
function buildText() {
  const frag = document.createDocumentFragment();
  spans = tokens.map((t, i) => {
    if (i > 0) {
      if (t.nl >= 2) frag.append(document.createElement('br'), document.createElement('br'));
      else if (t.nl === 1) frag.append(document.createElement('br'));
      else if (!t.joined) frag.append(' ');
    }
    const s = document.createElement('span');
    s.className = 'w'; s.dataset.i = i; s.textContent = t.raw;
    frag.append(s);
    return s;
  });
  const host = $('#text');
  host.replaceChildren(frag);
}
function paint(k) { const el = spans[k]; if (el) el.className = 'w' + (k < pos ? ' past' : k === pos ? ' cur' : ''); }
function paintAll() { for (let k = 0; k < spans.length; k++) paint(k); }

let saveTimer;
let needAlign = true;
function setPos(i, { manual = false, instant = false } = {}) {
  if (!matcher) return;
  i = Math.max(0, Math.min(tokens.length, i | 0));
  const old = pos;
  pos = i; matcher.setPos(i);
  const a = Math.max(0, Math.min(old, i)), b = Math.min(tokens.length - 1, Math.max(old, i));
  for (let k = a; k <= b; k++) paint(k);
  needAlign = true;
  if (instant) alignInstant();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => current && store.set('tp.pos.' + current.id, pos), 250);
  $('#prog').textContent = tokens.length ? Math.round((pos / tokens.length) * 100) + '%' : '0%';
  if (manual) onManualMove();
  if (pos >= tokens.length && state === 'running') { toast('End of script'); pause(); }
}
function targetDelta() {
  const el = spans[Math.min(pos, spans.length - 1)];
  if (!el) return 0;
  const r = el.getBoundingClientRect(), sr = scroller.getBoundingClientRect();
  return r.top + r.height / 2 - (sr.top + sr.height * 0.33);
}
function alignInstant() { if (!$('#reader').hidden) scroller.scrollTop += targetDelta(); }

// smooth scroller: keeps the current line ~1/3 from the top
let userScroll = false, touching = false, raf = 0;
function loop() {
  raf = requestAnimationFrame(loop);
  if (!needAlign || userScroll || touching) return;
  const d = targetDelta();
  if (Math.abs(d) < 0.6) { needAlign = false; return; }
  scroller.scrollTop += Math.abs(d) > scroller.clientHeight * 1.5 ? d : d * 0.14 + Math.sign(d) * 0.4;
}
function wordAtMarker() {
  const sr = scroller.getBoundingClientRect();
  const y = sr.top + sr.height * 0.33;
  let lo = 0, hi = spans.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (spans[mid].getBoundingClientRect().bottom < y) lo = mid + 1; else hi = mid;
  }
  return lo;
}
let dragTimer;
function markUserScroll() { userScroll = true; }
scroller.addEventListener('touchstart', () => { touching = true; }, { passive: true });
scroller.addEventListener('touchmove', markUserScroll, { passive: true });
scroller.addEventListener('touchend', () => { touching = false; }, { passive: true });
scroller.addEventListener('touchcancel', () => { touching = false; }, { passive: true });
scroller.addEventListener('wheel', markUserScroll, { passive: true });
scroller.addEventListener('scroll', () => {
  if (!userScroll) return;
  clearTimeout(dragTimer);
  dragTimer = setTimeout(() => { // scrolling has settled: the word at the marker becomes the position
    if (touching) return;
    userScroll = false;
    setPos(wordAtMarker(), { manual: true });
  }, 350);
}, { passive: true });

// tap: middle band = pause/resume, a word elsewhere = reposition, empty/edges = show controls
scroller.addEventListener('click', (e) => {
  const y = e.clientY / window.innerHeight;
  if (y > 0.2 && y < 0.5) { togglePause(); return; }
  const w = e.target.closest && e.target.closest('.w');
  if (w && y > 0.16 && y < 0.84) { setPos(Number(w.dataset.i), { manual: true }); return; }
  showControls();
});

// ---------- manual moves & recognizer baseline ----------
let baseline = 0, lastLen = 0, curSid = null;
function onManualMove() {
  baseline = lastLen; // ignore what the recognizer already heard before the reposition
  if (follower && follower.reset) follower.reset();
  autoAcc = 0;
  updateStartLabel();
}
function feed(words, sid) {
  if (state !== 'running') return;
  if (sid !== curSid) { curSid = sid; baseline = 0; }
  lastLen = words.length;
  const fresh = words.slice(baseline).slice(-12);
  if (!fresh.length) return;
  const r = matcher.update(fresh);
  if (r.advanced) setPos(matcher.pos);
}
function backSentence() {
  let i = Math.min(pos, tokens.length - 1);
  let s = i; while (s > 0 && !tokens[s].sentenceStart) s--;
  if (i - s <= 2 && s > 0) { s--; while (s > 0 && !tokens[s].sentenceStart) s--; }
  setPos(s, { manual: true });
}

// ---------- keep-alive ----------
let wake = null;
const standalone = () => navigator.standalone || (window.matchMedia && matchMedia('(display-mode: standalone)').matches);
async function acquireWake() {
  let ok = false;
  try {
    if ('wakeLock' in navigator && !wake && document.visibilityState === 'visible') {
      wake = await navigator.wakeLock.request('screen');
      wake.addEventListener('release', () => { wake = null; });
    }
    ok = !!wake;
  } catch { wake = null; }
  // Older iOS (or home-screen mode on iOS < 18.4, where wakeLock is unreliable): silent looping video trick.
  const v = $('#nosleep');
  if (!ok || standalone()) { v.play().catch(() => {}); } else { v.pause(); }
}
function releaseWake() {
  try { wake && wake.release(); } catch { /* ignore */ }
  wake = null;
  $('#nosleep').pause();
}

// ---------- video recording ----------
function fmtTime(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function refreshRecUI() {
  const on = !!(recorder && recorder.recording);
  $('#recBadge').hidden = !on;
  $('#camPreview').hidden = !on;
  if (on) $('#recTime').textContent = fmtTime(recorder.elapsedMs);
  const b = $('#btnCam');
  b.classList.toggle('recording', on);
  b.textContent = on ? '⏹ Stop' : settings.record ? '🎥 On' : '🎥 Off';
}
function cameraError(e) {
  const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
  settings.record = false;
  store.set('tp.settings', settings);
  syncSettingsUI();
  toast(
    denied
      ? 'Camera or microphone access was denied, so video recording is off. Allow it in Safari website settings to try again.'
      : e && e.message === 'not-supported'
        ? "This browser can't record video here. Reading still works normally."
        : 'Could not start the camera, so video recording is off.',
    7000
  );
  refreshRecUI();
}
/** Fire-and-forget from a user gesture: starts a fresh recording segment if the setting is on and none is running. */
function maybeStartRecording() {
  if (!settings.record || (recorder && recorder.recording)) return;
  if (!VideoRecorder.supported) { cameraError({ message: 'not-supported' }); return; }
  const r = new VideoRecorder();
  recorder = r;
  r.start({ facingMode: settings.camera })
    .then((stream) => {
      if (recorder !== r) return; // superseded/stopped already
      const v = $('#camPreview');
      v.srcObject = stream;
      v.classList.toggle('mirror', settings.camera === 'user');
      clearInterval(recTimer);
      recTimer = setInterval(refreshRecUI, 500);
      refreshRecUI();
    })
    .catch((e) => { if (recorder === r) recorder = null; cameraError(e); });
}
/** Stop the current segment (if any) and keep its clip for review. Safe to call when nothing is recording. */
async function stopRecordingSegment() {
  const r = recorder;
  if (!r) return;
  recorder = null;
  clearInterval(recTimer);
  $('#camPreview').srcObject = null;
  refreshRecUI();
  try {
    const blob = await r.stop();
    if (blob) recSegments.push({ blob, mimeType: r.mimeType || blob.type });
  } catch { /* recording lost; nothing to review for this segment */ }
}
function openReviewSheet() {
  if (!recSegments.length) return;
  const list = $('#reviewList');
  list.replaceChildren();
  $('#reviewNote').textContent =
    recSegments.length > 1
      ? `Recorded in ${recSegments.length} parts (the app was backgrounded during the take).`
      : 'Save it to Files, or share it directly.';
  recSegments.forEach((seg, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'review-item';
    const v = document.createElement('video');
    v.controls = true; v.playsInline = true;
    v.src = URL.createObjectURL(seg.blob);
    const row = document.createElement('div');
    row.className = 'row';
    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn primary';
    saveBtn.textContent = recSegments.length > 1 ? `Save part ${i + 1}` : 'Save video';
    saveBtn.onclick = () => saveRecording(seg);
    row.append(saveBtn);
    wrap.append(v, row);
    list.append(wrap);
  });
  $('#review').hidden = false;
}
async function saveRecording(seg) {
  const ext = VideoRecorder.extFor(seg.mimeType);
  const name = `${(current ? slugify(current.title) : 'teleprompter')}-${Date.now()}.${ext}`;
  const file = new File([seg.blob], name, { type: seg.mimeType || 'video/webm' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: name });
      return;
    }
  } catch (e) { if (e && e.name === 'AbortError') return; }
  const url = URL.createObjectURL(file);
  const el = document.createElement('a');
  el.href = url; el.download = name;
  document.body.append(el); el.click(); el.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
function slugify(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'recording'; }
function closeReview(discard) {
  $('#review').hidden = true;
  $('#reviewList').replaceChildren();
  recSegments = [];
  if (discard) toast('Recording discarded');
}

// ---------- session control ----------
function effectiveMode() {
  let m = settings.mode;
  if (m === 'whisper') m = 'voice';
  if (m === 'voice' && !SpeechFollower.supported) m = 'scroll';
  return m;
}
function setStatus(kind, text) {
  const s = $('#status');
  s.textContent = text;
  s.className = 'pill ' + ({ ok: 'ok', warn: 'warn', err: 'err' }[kind] || '');
}
function onFollowerStatus(k) {
  if (state !== 'running') return;
  if (k === 'listening') setStatus('ok', '● Listening');
  else if (k === 'reconnecting') setStatus('warn', '↻ Reconnecting…');
  else if (k === 'error') setStatus('err', 'Error');
}
function makeFollower(mode) {
  const h = { lang: settings.lang, onWords: feed, onStatus: onFollowerStatus, onFatal: (msg) => { pause(); setStatus('err', 'Mic blocked'); toast(msg, 9000); } };
  return new SpeechFollower(h);
}

let autoRaf = 0, autoLast = 0, autoAcc = 0;
function autoLoop(t) {
  if (state !== 'running' || effectiveMode() !== 'scroll') return;
  autoAcc += ((t - autoLast) * settings.wpm) / 60000;
  autoLast = t;
  let n = 0; while (autoAcc >= 1) { autoAcc -= 1; n++; }
  if (n) setPos(pos + n);
  autoRaf = requestAnimationFrame(autoLoop);
}

/** Must run inside a user-gesture handler (click/tap) on iOS. */
function startSession() {
  if (!current || !tokens.length) return;
  if (pos >= tokens.length) setPos(0, { instant: true });
  state = 'running';
  $('#resume').hidden = true;
  $('#reader').classList.remove('stopped');
  acquireWake();
  maybeStartRecording(); // independent of voice/scroll mode and of pausing; keeps rolling across a pause tap
  const mode = effectiveMode();
  $('#mode').value = mode;
  $('#wpmWrap').hidden = mode !== 'scroll';
  baseline = 0; lastLen = 0; curSid = null;
  if (follower) { follower.stop(); follower = null; }
  if (mode === 'scroll') {
    setStatus('ok', `Auto-scroll · ${settings.wpm} wpm`);
    autoLast = performance.now(); autoAcc = 0;
    cancelAnimationFrame(autoRaf); autoRaf = requestAnimationFrame(autoLoop);
  } else {
    setStatus('warn', 'Starting…');
    follower = makeFollower(mode);
    follower.start();
  }
  $('#btnPlay').textContent = 'Pause';
  showControls();
}
function stopSession(next) {
  state = next;
  if (follower) { follower.stop(); follower = null; }
  cancelAnimationFrame(autoRaf);
  $('#reader').classList.add('stopped');
  $('#btnPlay').textContent = pos > 0 ? 'Resume' : 'Start';
  if (current) store.set('tp.pos.' + current.id, pos);
}
function pause() { stopSession('paused'); setStatus('', 'Paused'); }
function togglePause() { if (state === 'running') pause(); else startSession(); }

let hideTimer;
function showControls() {
  const r = $('#reader');
  r.classList.add('show');
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => { if (state === 'running') r.classList.remove('show'); }, 3500);
}

// ---------- screens ----------
function openReader() {
  $('#library').hidden = true; $('#reader').hidden = false;
  document.body.classList.add('reading');
  $('#mode').value = effectiveMode();
  $('#wpmWrap').hidden = effectiveMode() !== 'scroll';
  cancelAnimationFrame(raf); raf = requestAnimationFrame(loop);
  requestAnimationFrame(() => { needAlign = true; alignInstant(); });
  startSession();
}
async function closeReader() {
  stopSession('idle');
  await stopRecordingSegment();
  releaseWake();
  cancelAnimationFrame(raf);
  $('#reader').hidden = true; $('#library').hidden = false;
  document.body.classList.remove('reading');
  updateStartLabel();
  openReviewSheet();
}

// ---------- backgrounding ----------
function suspend() {
  if (recorder && recorder.recording) stopRecordingSegment(); // finalize this clip; a fresh one starts on Resume
  if (state !== 'running') return;
  stopSession('suspended');
  setStatus('warn', 'Suspended');
  $('#resumeMsg').textContent = `Paused while you were away (${Math.round((pos / Math.max(1, tokens.length)) * 100)}% through).`;
  $('#resume').hidden = false;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') suspend();
  else if (!$('#reader').hidden) acquireWake(); // wake locks are auto-released when hidden; re-acquire on return
});
window.addEventListener('pagehide', suspend);
window.addEventListener('pageshow', (e) => { if (e.persisted && !$('#reader').hidden) { suspend(); $('#resume').hidden = false; } });
window.addEventListener('resize', () => { needAlign = true; });

// ---------- backup / first run ----------
async function exportBackup() {
  try {
    const data = await db.exportAll();
    if (!data.scripts.length) { toast('No scripts to export'); return; }
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const file = new File([blob], 'teleprompter-backup.json', { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) { // iOS share sheet: Save to Files, AirDrop, Mail...
      await navigator.share({ files: [file], title: 'Teleprompter backup' });
    } else {
      const url = URL.createObjectURL(blob);
      const el = document.createElement('a');
      el.href = url; el.download = 'teleprompter-backup.json';
      document.body.append(el); el.click(); el.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }
  } catch (e) { if (e && e.name !== 'AbortError') toast('Export failed'); }
}
const WELCOME = `Welcome to your teleprompter. Read this text out loud at a natural pace and watch the highlight follow your voice. The current word glows yellow, words you have already spoken fade away, and the page keeps the line you are reading about a third of the way down the screen.

If you skip a few words, or add a comment of your own, the app waits for the next words it recognizes and carries on from there. To move manually, tap any word above or below the middle of the screen, or drag the text and let go. Tap the middle of the screen to pause and resume.

When you are ready, tap Back, then New or paste, and add your own script. You can also upload a text file or a markdown file from the Files app. Good luck with the recording.`;
async function firstRun() {
  try {
    if (!store.get('tp.seeded', false) && !(await db.list()).length) {
      const r = await db.create({ title: 'Welcome - read me first', text: WELCOME });
      selectedId = r.id;
    }
    store.set('tp.seeded', true);
  } catch { /* storage unavailable: loadList will show the notice */ }
}

// ---------- wiring ----------
function wire() {
  $('#btnStart').onclick = openReader; // synchronous: keeps the user gesture for mic + wake lock + video
  $('#btnNew').onclick = () => openEditor(null);
  $('#fileIn').onchange = (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    readFileInto(f, async (text, title) => {
      if (/\.json$/i.test(f.name) || (text.trimStart().startsWith('{') && text.includes('"voice-teleprompter"'))) { // restore from a backup
        try {
          const n = await db.importAll(JSON.parse(text));
          toast(n ? `Restored ${n} script${n === 1 ? '' : 's'}` : 'Nothing new to restore');
          await loadList();
        } catch { toast('That file is not a teleprompter backup'); }
      } else openEditor(null, { title, text });
    });
  };
  $('#btnExport').onclick = exportBackup;
  $('#hintClose').onclick = () => { $('#installHint').hidden = true; store.set('tp.hintDismissed', 1); };
  $('#edFile').onchange = (e) => { const f = e.target.files[0]; if (f) readFileInto(f, (text, title) => { $('#edText').value = text; if (!$('#edTitle').value) $('#edTitle').value = title; }); e.target.value = ''; };
  $('#edSave').onclick = saveEditor;
  $('#edCancel').onclick = () => ($('#editor').hidden = true);
  $('#edDelete').onclick = async () => {
    if (!editing || !confirm('Delete this script?')) return;
    try { await db.remove(editing); } catch { toast('Delete failed'); return; }
    store.set('tp.pos.' + editing, 0);
    $('#editor').hidden = true; current = null; selectedId = null; tokens = []; spans = []; $('#text').replaceChildren();
    await loadList(); updateStartLabel();
  };
  const openSettings = () => { syncSettingsUI(); $('#settings').hidden = false; };
  $('#btnLibSettings').onclick = openSettings;
  $('#btnSettings').onclick = openSettings;
  $('#btnSettingsClose').onclick = () => { $('#settings').hidden = true; needAlign = true; };

  $('#btnBack').onclick = closeReader;
  $('#btnRestart').onclick = () => { setPos(0, { manual: true }); showControls(); };
  $('#btnSentence').onclick = () => { backSentence(); showControls(); };
  $('#btnPlay').onclick = togglePause;
  $('#btnResume').onclick = startSession;
  $('#btnCam').onclick = async () => {
    if (recorder && recorder.recording) { await stopRecordingSegment(); openReviewSheet(); return; }
    if (state === 'running') { toast('Turn recording on before you tap Start (or use it in Settings)'); return; }
    settings.record = !settings.record;
    store.set('tp.settings', settings);
    syncSettingsUI();
    refreshRecUI();
  };
  $('#reviewClose').onclick = () => closeReview(false);
  $('#reviewDiscard').onclick = () => { if (confirm('Discard this recording?')) closeReview(true); };
  $('#mode').onchange = (e) => {
    settings.mode = e.target.value; store.set('tp.settings', settings);
    if (state === 'running') startSession(); else { $('#wpmWrap').hidden = effectiveMode() !== 'scroll'; }
  };
  $('#topbar').addEventListener('click', showControls);
  $('#bottombar').addEventListener('click', showControls);
}

async function init() {
  bindSettings();
  applySettings();
  wire();
  if (!SpeechFollower.supported) {
    showNotice('Speech recognition is not available in this browser, so Auto-scroll will be used. (On iPhone/iPad use Safari.)');
    if (settings.mode === 'voice') settings.mode = 'scroll';
  }
  if (!window.isSecureContext) showNotice('This page is not HTTPS, so the microphone will be blocked. Use the https:// address printed by the server.');
  if (settings.mode === 'whisper') settings.mode = 'voice';
  $('#mode').value = settings.mode;
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (ios && !standalone() && !store.get('tp.hintDismissed', 0)) $('#installHint').hidden = false;
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  if (!VideoRecorder.supported && settings.record) { settings.record = false; store.set('tp.settings', settings); }
  refreshRecUI();
  await firstRun();
  await loadList();
  db.persist();
}
init();
