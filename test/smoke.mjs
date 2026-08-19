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

const browser = await chromium.launch();
const context = await browser.newContext({ ...devices['iPhone 13'], hasTouch: true });
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

// --- highlights -----------------------------------------------------------
await page.click('#highlightBtn');
await page.waitForTimeout(200);
await stroke([{ x: cx - 100, y: cy - 120 }, { x: cx + 60, y: cy - 140 }]);
await page.click('#highlightBtn');
await page.waitForTimeout(150);
note((await page.locator('#hlCount').innerText()) === '2', 'highlight counter updates');
note(await page.evaluate(() => window.__doodl.strokeCount()) === 3, 'drawing continues between highlights');

// --- finish ---------------------------------------------------------------
await page.click('#endBtn');
await page.waitForTimeout(700);
note(await page.locator('#wrap.active').count() === 1, 'wrap-up screen opens');
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
await page.waitForTimeout(400);
note(await page.locator('.hl-card').count() === 2, 'reopening a saved session restores highlights');

// --- console --------------------------------------------------------------
const real = consoleErrors.filter(e => !/speech|SpeechRecognition|not-allowed|network/i.test(e));
note(real.length === 0, 'no unexpected console errors', real.slice(0, 3).join(' | '));

await browser.close();

console.log('\n' + (problems.length ? problems.length + ' FAILING\n' : 'all checks passed\n'));
process.exit(problems.length ? 1 : 0);
