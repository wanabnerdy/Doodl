// Backgrounds are drawn procedurally rather than loaded as images: they stay crisp at
// any device pixel ratio, cost nothing to store, and keep the app a single deployable
// folder with no assets to fetch.

export const BACKGROUNDS = [
  { id: 'blank',  name: 'Blank' },
  { id: 'lined',  name: 'Lined' },
  { id: 'graph',  name: 'Graph' },
  { id: 'dots',   name: 'Dot grid' },
  { id: 'iso',    name: 'Isometric' },
  { id: 'circles', name: 'Circles' }
];

const PAPER = '#fbfaf6';
const INK = 'rgba(70, 90, 120, 0.30)';
const INK_SOFT = 'rgba(70, 90, 120, 0.16)';

export function paintBackground(ctx, id, w, h) {
  ctx.save();
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = INK_SOFT;
  ctx.fillStyle = INK;
  ctx.lineWidth = 1;

  const step = 26;
  switch (id) {
    case 'lined':
      for (let y = step * 1.5; y < h; y += step) line(ctx, 0, y, w, y);
      ctx.strokeStyle = 'rgba(200, 90, 90, 0.28)';
      line(ctx, 34, 0, 34, h);
      break;

    case 'graph':
      for (let x = 0; x < w; x += step / 2) line(ctx, x, 0, x, h);
      for (let y = 0; y < h; y += step / 2) line(ctx, 0, y, w, y);
      ctx.strokeStyle = INK;
      for (let x = 0; x < w; x += step * 2) line(ctx, x, 0, x, h);
      for (let y = 0; y < h; y += step * 2) line(ctx, 0, y, w, y);
      break;

    case 'dots':
      for (let x = step; x < w; x += step) {
        for (let y = step; y < h; y += step) {
          ctx.beginPath();
          ctx.arc(x, y, 1.3, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      break;

    case 'iso': {
      const dx = step * Math.sqrt(3) / 2;
      for (let x = -h; x < w + h; x += dx) {
        line(ctx, x, 0, x + h * 0.577, h);
        line(ctx, x, 0, x - h * 0.577, h);
      }
      break;
    }

    case 'circles':
      for (let y = step; y < h + step; y += step * 2) {
        for (let x = step; x < w + step; x += step * 2) {
          ctx.beginPath();
          ctx.arc(x, y, step * 0.8, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      break;

    case 'blank':
    default:
      break;
  }
  ctx.restore();
}

function line(ctx, x1, y1, x2, y2) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}
