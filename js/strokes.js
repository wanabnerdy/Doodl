// Strokes are stored as timestamped vectors, never as pixels. Two reasons:
// a highlight snapshot becomes "render everything up to time T" instead of a stored
// bitmap, and Phase 3 playback is already sitting here waiting to be used.
//
// Coordinates are normalised against canvas WIDTH (both axes) so a session drawn on a
// phone replays on an iPad without distortion.

// The probe found pressure is flat zero on this hardware, so line weight comes from
// speed instead: fast strokes thin out, slow ones sit heavy, like a real pen.
const SPEED_FAST = 0.0028;   // normalised units per ms
const MIN_FACTOR = 0.45;
const MAX_FACTOR = 1.25;
const SMOOTHING = 0.25;      // EMA on width, so weight changes are gradual

export function createDrawing() {
  return { strokes: [], live: null, _speed: 0 };
}

export function beginStroke(drawing, x, y, t, color, baseWidth, kind) {
  drawing._speed = 0;
  drawing.live = {
    color,
    baseWidth,
    startedAt: t,
    kind: kind || 'touch',      // 'pen' or 'touch' — palm rejection needs to tell them apart
    points: [{ x, y, t, w: baseWidth * MAX_FACTOR }]
  };
  return drawing.live;
}

export function extendStroke(drawing, x, y, t) {
  const s = drawing.live;
  if (!s) return;
  const prev = s.points[s.points.length - 1];
  const dt = Math.max(t - prev.t, 1);
  const dist = Math.hypot(x - prev.x, y - prev.y);
  if (dist < 0.0008 && dt < 40) return;   // ignore jitter while the finger rests

  const speed = dist / dt;
  drawing._speed += (speed - drawing._speed) * SMOOTHING;
  const ratio = Math.min(drawing._speed / SPEED_FAST, 1);
  const factor = MAX_FACTOR - (MAX_FACTOR - MIN_FACTOR) * ratio;
  s.points.push({ x, y, t, w: s.baseWidth * factor });
}

export function endStroke(drawing) {
  const s = drawing.live;
  drawing.live = null;
  if (!s || s.points.length < 1) return null;
  s.endedAt = s.points[s.points.length - 1].t;
  drawing.strokes.push(s);
  return s;
}

// A palm usually lands before the pen tip does, so the marks it leaves are already
// committed by the time a pen is detected. This removes them — touch strokes only,
// and only ones started in the moments just before the pen arrived.
export function dropRecentTouchStrokes(drawing, beforeT, windowMs) {
  const cutoff = beforeT - windowMs;
  const before = drawing.strokes.length;
  drawing.strokes = drawing.strokes.filter(
    s => s.kind === 'pen' || s.startedAt < cutoff
  );
  if (drawing.live && drawing.live.kind !== 'pen') drawing.live = null;
  return before - drawing.strokes.length;
}

export function undo(drawing) {
  return drawing.strokes.pop() || null;
}

export function clear(drawing) {
  drawing.strokes = [];
  drawing.live = null;
}

// Draws every stroke laid down at or before upToT. Omit upToT for "everything".
export function render(ctx, drawing, pxWidth, upToT) {
  const all = drawing.live ? drawing.strokes.concat([drawing.live]) : drawing.strokes;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const stroke of all) {
    if (upToT !== undefined && stroke.startedAt > upToT) continue;
    const pts = upToT === undefined ? stroke.points : stroke.points.filter(p => p.t <= upToT);
    drawStroke(ctx, stroke, pts, pxWidth);
  }
}

// Renders a single segment pair at a time so line weight can vary along the stroke —
// a constant-width path would throw away the speed information.
function drawStroke(ctx, stroke, pts, scale) {
  if (!pts.length) return;
  ctx.strokeStyle = stroke.color;
  if (pts.length === 1) {
    const p = pts[0];
    ctx.fillStyle = stroke.color;
    ctx.beginPath();
    ctx.arc(p.x * scale, p.y * scale, Math.max(p.w * scale / 2, 0.5), 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    ctx.lineWidth = Math.max((a.w + b.w) / 2 * scale, 0.5);
    ctx.beginPath();
    ctx.moveTo(a.x * scale, a.y * scale);
    ctx.lineTo(b.x * scale, b.y * scale);
    ctx.stroke();
  }
}

// Used by highlight thumbnails and the wrap-up screen: re-render the vectors at any
// size rather than storing a bitmap per highlight.
export function renderToCanvas(strokes, upToT, pxWidth, pxHeight, background, paintBackground) {
  const c = document.createElement('canvas');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  c.width = pxWidth * dpr;
  c.height = pxHeight * dpr;
  const ctx = c.getContext('2d');
  ctx.scale(dpr, dpr);
  paintBackground(ctx, background, pxWidth, pxHeight);
  render(ctx, { strokes, live: null }, pxWidth, upToT);
  return c;
}
