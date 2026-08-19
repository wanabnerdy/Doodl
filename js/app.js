import { BACKGROUNDS, paintBackground } from './backgrounds.js';
import * as S from './strokes.js';
import { createTranscriber } from './speech.js';
import * as store from './store.js';

const COLORS = ['#232a33', '#2f6fd0', '#c8402f', '#1f8a53', '#8a4fbd', '#d98324'];
const SIZES = [2.5, 4.5, 8, 14];          // css px, converted to normalised units per stroke
const SAVE_INTERVAL_MS = 5000;
const BUILD = 'v1.0.9';   // bump on each deploy; shown on the home screen so a stale cache is obvious

const $ = id => document.getElementById(id);

let session = null;
let drawing = null;
let transcriber = null;
let t0 = 0;
let wakeLock = null;
let saveTimer = null;
let livePainted = 0;
let micPending = false;
let cssW = 0, cssH = 0;
let colour = COLORS[0];
let sizePx = SIZES[1];
let background = 'lined';

const bgCanvas = $('bgCanvas'), inkCanvas = $('inkCanvas');
const bgCtx = bgCanvas.getContext('2d');
const inkCtx = inkCanvas.getContext('2d');

const now = () => Date.now() - t0;
const debugLines = [];

function log(msg) {
  debugLines.push(new Date().toLocaleTimeString() + '  ' + msg);
  if (debugLines.length > 300) debugLines.shift();
  $('debug').textContent = debugLines.join('\n');
  $('debug').scrollTop = $('debug').scrollHeight;
}

/* ---------------------------------------------------------------- screens */

function show(name) {
  for (const el of document.querySelectorAll('.screen')) el.classList.toggle('active', el.id === name);
}

/* ------------------------------------------------------------ home screen */

async function renderHome() {
  const list = await store.listSessions();
  const box = $('sessionList');
  if (!list.length) {
    box.innerHTML = '<p class="empty">No sessions yet. The first one will show up here.</p>';
  } else {
    box.innerHTML = '';
    for (const s of list) {
      const btn = document.createElement('button');
      btn.className = 'session-card';
      const when = new Date(s.startedAt);
      const mins = s.endedAt ? Math.round((s.endedAt - s.startedAt) / 60000) : 0;
      btn.innerHTML =
        '<h3>' + escapeHtml(s.title || 'Untitled meeting') + '</h3>' +
        '<div class="meta">' + when.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
        ' · ' + when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) +
        ' · ' + mins + ' min · ' + s.highlightCount + ' highlight' + (s.highlightCount === 1 ? '' : 's') +
        ' · ' + s.wordCount + ' words</div>';
      btn.onclick = () => openSession(s.id);
      box.appendChild(btn);
    }
  }
  const u = await store.usage();
  const vv = window.visualViewport;
  const inset = Math.round(parseFloat(getComputedStyle($('insetProbe')).height) || 0);
  $('storageLine').textContent =
    BUILD + '  ·  ' + window.innerWidth + '\u00d7' + window.innerHeight +
    (vv ? ' vv' + Math.round(vv.height) : ' vv-') + ' inset' + inset +
    (u ? '  ·  ' + u.usedMB.toFixed(1) + ' MB' : '');
}

/* --------------------------------------------------------- active session */

async function startSession(withMic = true) {
  t0 = Date.now();
  session = {
    id: 'S' + t0.toString(36),
    title: '',
    startedAt: t0,
    endedAt: null,
    background,
    aspect: 1,
    strokes: [],
    utterances: [],
    highlights: []
  };
  drawing = S.createDrawing();
  show('session');
  sizeCanvases();
  $('hlCount').textContent = '0';

  if (!withMic) {
    transcriber = null;
    setSpeechState('off');
    log('doodle-only session — microphone never touched');
    await requestWakeLock();
    saveTimer = setInterval(persist, SAVE_INTERVAL_MS);
    return;
  }

  transcriber = createTranscriber({
    now,
    log,
    onState: setSpeechState,
    onUtterance: u => log('utterance +' + (u.startT / 1000).toFixed(1) + 's: ' + u.text.slice(0, 60))
  });

  if (!transcriber.supported) {
    setSpeechState('error');
    log('speech recognition unavailable — doodling still works');
  } else {
    await checkMicPermission();
    transcriber.begin();
  }

  await requestWakeLock();
  saveTimer = setInterval(persist, SAVE_INTERVAL_MS);
  log('session started ' + session.id);
}

// On a first run iOS puts up permission dialogs, and nothing happens until they are
// dismissed. Saying "warming up" there would blame the browser for waiting on a tap.
async function checkMicPermission() {
  try {
    const st = await navigator.permissions.query({ name: 'microphone' });
    micPending = st.state === 'prompt';
    log('mic permission: ' + st.state);
  } catch (e) {
    micPending = false;
    log('mic permission unknown: ' + e.name);
  }
}

function setSpeechState(state) {
  if (state === 'listening') micPending = false;
  $('stateDot').className = 'dot ' + (state === 'off' ? '' : state);
  $('stateText').textContent =
    state === 'off' ? 'doodle only' :
    state === 'listening' ? 'listening' :
    state === 'starting' ? (micPending ? 'allow mic' : 'warming up') :
    state === 'error' ? 'no audio' : 'off';
}

async function endSession() {
  clearInterval(saveTimer);
  saveTimer = null;
  if (transcriber) {
    await transcriber.end();
    for (const h of session.highlights) h.anchor = transcriber.anchorAt(h.t);
  }
  releaseWakeLock();
  session.endedAt = Date.now();
  await persist();
  log('session ended');
  renderWrap(session);
  show('wrap');
}

async function persist() {
  if (!session) return;
  session.strokes = drawing.strokes;
  session.utterances = transcriber ? transcriber.utterances : [];
  session.background = background;
  session.aspect = cssH / cssW;
  await store.saveSession(session);
}

/* ------------------------------------------------------------ the canvas */

function sizeCanvases() {
  const rect = $('session').getBoundingClientRect();
  cssW = rect.width;
  cssH = rect.height;
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  for (const [c, ctx] of [[bgCanvas, bgCtx], [inkCanvas, inkCtx]]) {
    c.width = Math.round(cssW * dpr);
    c.height = Math.round(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  paintBackground(bgCtx, background, cssW, cssH);
  repaintInk();
}

function repaintInk() {
  inkCtx.clearRect(0, 0, cssW, cssH);
  S.render(inkCtx, drawing, cssW);
  livePainted = drawing.live ? drawing.live.points.length : 0;
}

// Painting only the newest points keeps the line under the finger instead of
// re-rendering every stroke on every move.
function paintLiveTail() {
  const s = drawing.live;
  if (!s) return;
  inkCtx.strokeStyle = s.color;
  inkCtx.lineCap = 'round';
  inkCtx.lineJoin = 'round';
  for (let i = Math.max(livePainted, 1); i < s.points.length; i++) {
    const a = s.points[i - 1], b = s.points[i];
    inkCtx.lineWidth = Math.max((a.w + b.w) / 2 * cssW, 0.5);
    inkCtx.beginPath();
    inkCtx.moveTo(a.x * cssW, a.y * cssW);
    inkCtx.lineTo(b.x * cssW, b.y * cssW);
    inkCtx.stroke();
  }
  livePainted = s.points.length;
}

const toLocal = e => {
  const r = inkCanvas.getBoundingClientRect();
  return { x: (e.clientX - r.left) / cssW, y: (e.clientY - r.top) / cssW };
};

inkCanvas.addEventListener('pointerdown', e => {
  if (!drawing) return;
  closeTools();
  const p = toLocal(e);
  S.beginStroke(drawing, p.x, p.y, now(), colour, sizePx / cssW);
  livePainted = 1;
  const s = drawing.live, pt = s.points[0];
  inkCtx.fillStyle = colour;
  inkCtx.beginPath();
  inkCtx.arc(pt.x * cssW, pt.y * cssW, Math.max(pt.w * cssW / 2, 0.5), 0, Math.PI * 2);
  inkCtx.fill();
  inkCanvas.setPointerCapture(e.pointerId);
  e.preventDefault();
}, { passive: false });

inkCanvas.addEventListener('pointermove', e => {
  if (!drawing || !drawing.live) return;
  // The probe reported up to 6 coalesced points per event — using them is the
  // difference between a smooth line and a chain of visible corners.
  const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
  const t = now();
  for (const ev of events) {
    const p = toLocal(ev);
    S.extendStroke(drawing, p.x, p.y, t);
  }
  paintLiveTail();
  e.preventDefault();
}, { passive: false });

for (const type of ['pointerup', 'pointercancel', 'pointerleave']) {
  inkCanvas.addEventListener(type, () => {
    if (drawing && drawing.live) { S.endStroke(drawing); livePainted = 0; }
  });
}

/* -------------------------------------------------------------- highlights */

function addHighlight() {
  if (!session) return;
  const t = now();
  // Only the timestamp is recorded here. The sentence being spoken right now has
  // not been finalised yet — it exists solely as pending interim text — so resolving
  // the anchor at this moment would attach the highlight to the PREVIOUS finished
  // sentence and label it "between sentences". Anchors are resolved at the end of
  // the session instead, when every utterance actually exists.
  session.highlights.push({ id: 'H' + session.highlights.length, t, anchor: null });
  $('hlCount').textContent = session.highlights.length;
  const flash = $('flash');
  flash.classList.add('on');
  requestAnimationFrame(() => requestAnimationFrame(() => flash.classList.remove('on')));
  log('highlight at +' + (t / 1000).toFixed(1) + 's');
}

/* --------------------------------------------------------------- wrap-up */

function renderWrap(s) {
  $('wrapDate').textContent = new Date(s.startedAt).toLocaleString([], {
    weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit'
  });
  $('wrapTitle').value = s.title || '';
  $('wrapTitle').oninput = () => { s.title = $('wrapTitle').value; store.saveSession(s); };

  const byId = new Map((s.utterances || []).map(u => [u.id, u]));
  const hlBox = $('hlList');
  hlBox.innerHTML = '';

  if (!s.highlights.length) {
    hlBox.innerHTML = '<p class="empty">No highlights were tapped in this session.</p>';
  } else {
    const thumbW = Math.min(window.innerWidth - 60, 420);
    const thumbH = thumbW * (s.aspect || 1.6);
    for (const h of s.highlights) {
      const card = document.createElement('div');
      card.className = 'hl-card';

      const time = document.createElement('div');
      time.className = 'time';
      time.textContent = clock(h.t);
      card.appendChild(time);

      // The doodle as it stood at that instant, re-rendered from the vectors rather
      // than pulled from a stored bitmap. Rendered at full card width but displayed
      // small, so enlarging it stays sharp.
      const body = document.createElement('div');
      body.className = 'body';
      body.appendChild(S.renderToCanvas(s.strokes, h.t, thumbW, thumbH, s.background, paintBackground));

      const quote = document.createElement('div');
      quote.className = 'quote';
      quote.innerHTML = quoteFor(h, byId) + '<div class="tap">Tap to enlarge</div>';
      body.appendChild(quote);
      card.appendChild(body);
      card.onclick = () => card.classList.toggle('big');

      hlBox.appendChild(card);
    }
  }

  const box = $('transcriptBox');
  if (!(s.utterances || []).length) {
    box.innerHTML = '<p class="empty" style="margin:0">Nothing was transcribed.</p>';
  } else {
    box.innerHTML = s.utterances.map(u => {
      const hit = s.highlights.some(h => h.anchor && h.anchor.utteranceId === u.id);
      return '<p class="' + (hit ? 'has-hl' : '') + '"><b>' + clock(u.startT) + '</b> ' +
             escapeHtml(u.text) + (u.provisional ? ' <i>(partial)</i>' : '') + '</p>';
    }).join('');
  }

  $('shareBtn').onclick = () => exportSession(s);
  $('deleteBtn').onclick = async () => {
    if (!confirm('Delete this session permanently?')) return;
    await store.deleteSession(s.id);
    goHome();
  };
}

// Shows the sentence a highlight landed in, with the moment itself marked — the
// character offset comes from the interim samples, since finals arrive too late
// to timestamp directly.
function quoteFor(h, byId) {
  if (!h.anchor) return '<span class="before">No transcript at this moment.</span>';
  const u = byId.get(h.anchor.utteranceId);
  if (!u) return '<span class="before">No transcript at this moment.</span>';
  const cut = Math.max(0, Math.min(h.anchor.charOffset, u.text.length));
  const before = u.text.slice(Math.max(0, cut - 90), cut);
  const after = u.text.slice(cut, cut + 90);
  return '<span class="before">' + (cut > 90 ? '…' : '') + escapeHtml(before) + '</span>' +
         '<mark>▸</mark>' + escapeHtml(after) + (u.text.length > cut + 90 ? '…' : '') +
         (h.anchor.during ? '' : ' <span class="before">(between sentences)</span>');
}

function buildExport(s) {
  const lines = [];
  lines.push('DOODL — ' + (s.title || 'Untitled meeting'));
  lines.push(new Date(s.startedAt).toLocaleString());
  if (s.endedAt) lines.push('Duration: ' + clock(s.endedAt - s.startedAt));
  lines.push('');
  const byId = new Map((s.utterances || []).map(u => [u.id, u]));

  lines.push('HIGHLIGHTS');
  lines.push('----------');
  if (!s.highlights.length) lines.push('(none)');
  for (const h of s.highlights) {
    const u = h.anchor && byId.get(h.anchor.utteranceId);
    lines.push('[' + clock(h.t) + '] ' + (u ? markAt(u.text, h.anchor.charOffset) : '(no transcript)'));
    lines.push('');
  }

  lines.push('TRANSCRIPT');
  lines.push('----------');
  for (const u of (s.utterances || [])) {
    lines.push('[' + clock(u.startT) + '] ' + u.text + (u.provisional ? ' (partial)' : ''));
  }
  return lines.join('\n');
}

function markAt(text, offset) {
  const cut = Math.max(0, Math.min(offset, text.length));
  return text.slice(0, cut) + ' >>> ' + text.slice(cut);
}

// iOS Safari treats download links unpredictably, so the share sheet is the
// primary path and the link is the fallback.
async function exportSession(s) {
  const text = buildExport(s);
  const name = 'doodl-' + new Date(s.startedAt).toISOString().slice(0, 10) + '.txt';
  const file = new File([text], name, { type: 'text/plain' });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: s.title || 'Doodl session' }); return; }
    catch (e) { if (e.name === 'AbortError') return; log('share failed: ' + e.message); }
  }
  try {
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  } catch (e) {
    await navigator.clipboard.writeText(text);
    alert('Copied the session to the clipboard.');
  }
}

async function openSession(id) {
  const s = await store.getSession(id);
  if (!s) return;
  session = s;
  renderWrap(s);
  show('wrap');
}

function goHome() {
  session = null;
  drawing = null;
  transcriber = null;
  show('home');
  renderHome();
}

/* ------------------------------------------------------------ wake lock */

async function requestWakeLock() {
  if (!navigator.wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    log('wake lock held');
  } catch (e) { log('wake lock refused: ' + e.message); }
}

function releaseWakeLock() {
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && session && !session.endedAt && !wakeLock) requestWakeLock();
});

/* ---------------------------------------------------------------- tools */

function buildTools() {
  const sw = $('swatches');
  sw.innerHTML = '';
  COLORS.forEach(c => {
    const b = document.createElement('button');
    b.className = 'swatch' + (c === colour ? ' sel' : '');
    b.style.background = c;
    b.onclick = () => { colour = c; buildTools(); };
    sw.appendChild(b);
  });

  const sz = $('sizes');
  sz.innerHTML = '';
  SIZES.forEach(px => {
    const b = document.createElement('button');
    b.className = 'size' + (px === sizePx ? ' sel' : '');
    b.innerHTML = '<i style="width:' + px * 1.6 + 'px;height:' + px * 1.6 + 'px"></i>';
    b.onclick = () => { sizePx = px; buildTools(); };
    sz.appendChild(b);
  });

  const bg = $('bgs');
  bg.innerHTML = '';
  BACKGROUNDS.forEach(t => {
    const b = document.createElement('button');
    b.className = 'bg-opt' + (t.id === background ? ' sel' : '');
    b.textContent = t.name;
    b.onclick = () => {
      background = t.id;
      paintBackground(bgCtx, background, cssW, cssH);
      buildTools();
    };
    bg.appendChild(b);
  });
}

function closeTools() { $('tools').classList.remove('open'); }

/* ----------------------------------------------------------------- misc */

function clock(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60), s = total % 60;
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/* ------------------------------------------------------------- wiring */

$('newSessionBtn').onclick = () => startSession(true);
$('quietSessionBtn').onclick = () => startSession(false);
$('endBtn').onclick = () => { if (confirm('Finish this session?')) endSession(); };
$('highlightBtn').onclick = addHighlight;
$('undoBtn').onclick = () => { S.undo(drawing); repaintInk(); };
$('clearBtn').onclick = () => { if (confirm('Clear the whole page?')) { S.clear(drawing); repaintInk(); closeTools(); } };
$('toolsBtn').onclick = () => $('tools').classList.toggle('open');
$('toolsDone').onclick = closeTools;
$('homeBtn').onclick = goHome;
$('debugToggle').onclick = () => $('debug').classList.toggle('open');

// iOS Safari's address bar overlays the window, so window.innerHeight lies about what
// is visible and CSS viewport units only approximate it. visualViewport reports the
// area actually on screen; everything is sized from that.
let lastViewportH = 0;
function applyViewport() {
  const vv = window.visualViewport;
  const h = Math.round(vv ? vv.height : window.innerHeight);
  if (h === lastViewportH) return;
  lastViewportH = h;
  document.documentElement.style.setProperty('--app-h', h + 'px');
  if (drawing) sizeCanvases();
}

if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', applyViewport);
  window.visualViewport.addEventListener('scroll', applyViewport);
}
window.addEventListener('resize', applyViewport);
window.addEventListener('orientationchange', () => setTimeout(() => { if (drawing) sizeCanvases(); }, 250));
// Closing the tab or navigating away has to free the microphone as well, or it stays
// held by Safari and no other app can record.
window.addEventListener('pagehide', () => { if (transcriber) transcriber.end(); });

window.addEventListener('error', e => log('JS ERROR: ' + e.message + ' @' + e.lineno));
window.addEventListener('unhandledrejection', e => log('PROMISE: ' + (e.reason && e.reason.message)));

applyViewport();
buildTools();
store.requestPersistence().then(ok => log('persistent storage: ' + ok));
renderHome();

// Test hooks. The smoke test drives the app through these rather than reaching into
// module internals, so refactoring the modules does not break the test.
window.__doodl = {
  strokeCount: () => (drawing ? drawing.strokes.length : (session ? session.strokes.length : 0)),
  widthSpread: () => {
    const ws = (drawing ? drawing.strokes : []).flatMap(s => s.points.map(p => p.w.toFixed(5)));
    return { distinct: new Set(ws).size, points: ws.length };
  },
  pointsAreTimestamped: () =>
    (drawing ? drawing.strokes : []).every(s => s.points.every(p => typeof p.t === 'number')),
  exportText: () => (session ? buildExport(session) : '')
};
