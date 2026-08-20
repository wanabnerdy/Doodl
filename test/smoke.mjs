// Smoke test for the whole Phase 1 flow. Exists because the author develops from a
// phone and cannot open a console: this catches the errors that would otherwise only
// show up as "it just doesn't work" on a device.
//
//   node test/smoke.mjs        (needs playwright + a static server on :8080)

import { chromium, devices } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:8080';
const problems = [];
const note = (ok, label, extra = '') => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (extra ? '  — ' + extra : ''));
  if (!ok) problems.push(label + (extra ? ': ' + extra : ''));
};

// A fake microphone, so the recording path is exercised rather than skipped.
const browser = await chromium.launch({
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream']
});
const context = await browser.newContext({ ...devices['iPhone 13'], hasTouch: true });
// The session teardown asks for the microphone to reset the audio route. Granting it
// here keeps the test on the same path a real device takes.
await context.grantPermissions(['microphone']);
const page = await context.newPage();

const consoleErrors = [];
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));
page.on('dialog', d => d.accept());

console.log('\nDoodl smoke test\n');

await page.goto(BASE, { waitUntil: 'networkidle' });
note(await page.locator('#home.active').count() === 1, 'home screen renders');
note((await page.locator('#sessionList').innerText()).length > 0, 'session list populated');

// --- start a session ------------------------------------------------------
await page.click('#newSessionBtn');
await page.waitForTimeout(400);
note(await page.locator('#session.active').count() === 1, 'session screen opens');

const box = await page.locator('#inkCanvas').boundingBox();
note(!!box && box.width > 100, 'canvas has layout', box ? `${Math.round(box.width)}x${Math.round(box.height)}` : 'none');

// --- draw three strokes ---------------------------------------------------
async function stroke(points, steps = 12) {
  await page.mouse.move(points[0].x, points[0].y);
  await page.mouse.down();
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    for (let s = 1; s <= steps; s++) {
      await page.mouse.move(a.x + (b.x - a.x) * s / steps, a.y + (b.y - a.y) * s / steps);
    }
  }
  await page.mouse.up();
}

const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
await stroke([{ x: cx - 90, y: cy - 60 }, { x: cx + 80, y: cy - 20 }, { x: cx - 40, y: cy + 50 }]);
await page.waitForTimeout(600);
await stroke([{ x: cx - 60, y: cy + 90 }, { x: cx + 90, y: cy + 120 }]);

const afterTwo = await page.evaluate(() => window.__doodl.strokeCount());
note(afterTwo === 2, 'two strokes recorded', 'got ' + afterTwo);

const widths = await page.evaluate(() => window.__doodl.widthSpread());
note(widths.distinct > 1, 'line weight varies with speed', widths.distinct + ' distinct widths');

const timed = await page.evaluate(() => window.__doodl.pointsAreTimestamped());
note(timed, 'every point carries a timestamp (Phase 3 depends on this)');

// --- undo -----------------------------------------------------------------
// Checked before any highlight is taken: undo deletes a stroke from history, so a
// snapshot taken afterwards correctly stops showing it. Testing undo later would
// erase the very stroke the snapshot comparison below depends on.
await stroke([{ x: cx + 20, y: cy + 20 }, { x: cx + 120, y: cy + 40 }]);
note(await page.evaluate(() => window.__doodl.strokeCount()) === 3, 'third stroke recorded');
await page.click('#undoBtn');
note(await page.evaluate(() => window.__doodl.strokeCount()) === 2, 'undo removes the last stroke');

// Every control has to sit inside the viewport that browser chrome leaves behind —
// the tester found Undo and the tool sheet hidden under Safari's address bar.
const reachable = await page.evaluate(() => {
  const h = window.innerHeight, out = [];
  for (const id of ['endBtn', 'undoBtn', 'toolsBtn', 'highlightBtn']) {
    const r = document.getElementById(id).getBoundingClientRect();
    if (r.bottom > h || r.top < 0) out.push(id);
  }
  return out;
});
note(reachable.length === 0, 'every control sits inside the usable viewport', reachable.join(', '));

await page.click('#toolsBtn');
await page.waitForTimeout(350);
const sheetOk = await page.evaluate(() => {
  const r = document.getElementById('clearBtn').getBoundingClientRect();
  return r.bottom <= window.innerHeight && r.top >= 0;
});
note(sheetOk, 'Clear is reachable inside the tool sheet');
await page.click('#toolsDone');
await page.waitForTimeout(400);

// Closed, the sheet parks just below the app box. Unless it is clipped it shows
// through underneath, which reads as controls sitting under the address bar.
const clipped = await page.evaluate(() => {
  const sheet = document.getElementById('tools').getBoundingClientRect();
  return getComputedStyle(document.getElementById('session')).overflow === 'hidden'
      && sheet.top >= window.innerHeight - 1;
});
note(clipped, 'the closed tool sheet is clipped, not spilling below the app');

// --- highlights -----------------------------------------------------------
await page.click('#highlightBtn');
await page.waitForTimeout(200);
await stroke([{ x: cx - 100, y: cy - 120 }, { x: cx + 60, y: cy - 140 }]);
await page.click('#highlightBtn');
await page.waitForTimeout(150);
note((await page.locator('#hlCount').innerText()) === '2', 'highlight counter updates');
note(await page.evaluate(() => window.__doodl.strokeCount()) === 3, 'drawing continues between highlights');

// --- palm rejection -------------------------------------------------------
// A palm rests on the glass before the pen tip lands, so its marks are already
// committed when the pen appears. Touch must stop drawing from then on, and the marks
// the hand already left must be swept up.
const palm = await page.evaluate(async () => {
  const canvas = document.getElementById('inkCanvas');
  const r = canvas.getBoundingClientRect();
  const at = (x, y) => ({ clientX: r.left + x, clientY: r.top + y });

  const send = (type, opts) => canvas.dispatchEvent(new PointerEvent(type,
    Object.assign({ bubbles: true, pointerId: opts.id, pointerType: opts.kind,
                    isPrimary: true, pressure: 0.5 }, at(opts.x, opts.y))));

  const before = window.__doodl.strokeCount();

  // A pause first: earlier drawing is deliberate work and must survive the sweep.
  await new Promise(r => setTimeout(r, 1200));

  // the heel of the hand goes down first
  send('pointerdown', { id: 91, kind: 'touch', x: 60, y: 200 });
  send('pointermove', { id: 91, kind: 'touch', x: 75, y: 210 });
  send('pointerup',   { id: 91, kind: 'touch', x: 75, y: 210 });
  const afterPalm = window.__doodl.strokeCount();

  // then the pen
  send('pointerdown', { id: 92, kind: 'pen', x: 150, y: 120 });
  send('pointermove', { id: 92, kind: 'pen', x: 200, y: 140 });
  send('pointerup',   { id: 92, kind: 'pen', x: 200, y: 140 });
  const afterPen = window.__doodl.strokeCount();

  // a later palm touch must not draw at all
  send('pointerdown', { id: 93, kind: 'touch', x: 70, y: 240 });
  send('pointermove', { id: 93, kind: 'touch', x: 90, y: 250 });
  send('pointerup',   { id: 93, kind: 'touch', x: 90, y: 250 });

  return { before, afterPalm, afterPen, final: window.__doodl.strokeCount() };
});
note(palm.afterPalm === palm.before + 1, 'a palm alone still draws, before any pen is seen');
note(palm.afterPen === palm.before + 1, 'the pen sweeps up the marks the palm just left',
     'strokes went ' + palm.afterPalm + ' -> ' + palm.afterPen);
note(palm.final === palm.afterPen, 'and touch stops drawing once a pen is in use');

// --- finish ---------------------------------------------------------------
await page.click('#endBtn');
// Waiting on the screen rather than a fixed delay: finishing must not be gated on the
// audio-route reset that follows it.
const wrapOpened = await page.locator('#wrap.active').waitFor({ timeout: 4000 })
  .then(() => true).catch(() => false);
note(wrapOpened, 'wrap-up screen opens');
note(await page.locator('.hl-card').count() === 2, 'a card per highlight');
note(await page.locator('.hl-card canvas').count() === 2, 'each highlight re-renders a doodle snapshot');

const snapshotsDiffer = await page.evaluate(() => {
  const cs = [...document.querySelectorAll('.hl-card canvas')];
  return cs.length === 2 && cs[0].toDataURL() !== cs[1].toDataURL();
});
note(snapshotsDiffer, 'snapshots show the doodle as it stood at each moment');

await page.fill('#wrapTitle', 'Smoke test meeting');
await page.waitForTimeout(300);

const exported = await page.evaluate(() => window.__doodl.exportText());
note(exported.includes('HIGHLIGHTS') && exported.includes('TRANSCRIPT'), 'export builds both sections');
note(exported.includes('Smoke test meeting'), 'export carries the title');

// --- persistence across a reload -----------------------------------------
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
const listed = await page.locator('.session-card').count();
note(listed === 1, 'session survives a reload', listed + ' card(s)');
note((await page.locator('.session-card').innerText()).includes('Smoke test meeting'), 'saved title shown on home');

await page.locator('.session-card').first().click();
await page.waitForTimeout(3000);
note(await page.locator('.hl-card').count() === 2, 'reopening a saved session restores highlights');
note(await page.evaluate(() => Number(document.getElementById('scrub').max)) > 1000,
     'and its recording still plays');

// --- audio ----------------------------------------------------------------
// Recording is stored in chunks as it happens, so the checks are that it survived
// the session, that a duration was recovered from a file that reports none, and that
// a highlight can be heard rather than only read.
const audio = await page.evaluate(() => ({
  playerShown: getComputedStyle(document.getElementById('player')).display !== 'none',
  durationMs: Number(document.getElementById('scrub').max),
  hearButtons: document.querySelectorAll('.hear').length,
  deleteOffered: getComputedStyle(document.getElementById('deleteAudioBtn')).display !== 'none'
}));
note(audio.playerShown, 'a recording is available to play back');
note(audio.durationMs > 1000, 'duration recovered from a headerless stream',
     audio.durationMs + ' ms');
note(audio.hearButtons === 2, 'each highlight can be heard', audio.hearButtons + ' buttons');
note(audio.deleteOffered, 'audio can be deleted without losing the notes');

const stored = await page.evaluate(async () => {
  const db = await new Promise(res => { const r = indexedDB.open('doodl', 2); r.onsuccess = () => res(r.result); });
  return await new Promise(res => {
    const req = db.transaction('audio').objectStore('audio').getAll();
    req.onsuccess = () => res(req.result.length);
  });
});
note(stored > 0, 'chunks were written to storage during the session', stored + ' chunks');

// --- replay ---------------------------------------------------------------
// The doodle redrawing in step with the audio. The check that matters is that the
// canvas actually differs across the timeline: identical frames would mean the
// timestamps are being ignored and the whole drawing is painted at once.
await page.click('#replayBtn');
await page.waitForTimeout(2500);
note(await page.locator('#replay.active').count() === 1, 'replay opens');

const frames = await page.evaluate(async () => {
  const scrub = document.getElementById('rScrub');
  const ink = document.getElementById('rInk');
  const grab = async v => {
    scrub.value = String(v);
    scrub.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 350));
    return ink.toDataURL();
  };
  const max = Number(scrub.max);
  return {
    max,
    start: await grab(0),
    middle: await grab(Math.round(max * 0.5)),
    end: await grab(max),
    pips: document.querySelectorAll('#rPips i').length
  };
});

note(frames.max > 1000, 'the timeline spans the session', frames.max + ' ms');
note(frames.start !== frames.end, 'the drawing builds up over the timeline');
note(frames.middle !== frames.end, 'and is genuinely partway through in the middle');
note(frames.pips === 2, 'highlights are marked on the timeline', frames.pips + ' pips');

await page.click('#rBack');
await page.waitForTimeout(400);
note(await page.locator('#wrap.active').count() === 1, 'and returns to the wrap-up');

// --- console --------------------------------------------------------------
const real = consoleErrors.filter(e => !/speech|SpeechRecognition|not-allowed|network/i.test(e));
note(real.length === 0, 'no unexpected console errors', real.slice(0, 3).join(' | '));

await browser.close();

console.log('\n' + (problems.length ? problems.length + ' FAILING\n' : 'all checks passed\n'));
process.exit(problems.length ? 1 : 0);
