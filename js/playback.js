// Playing back a recording made by MediaRecorder.
//
// The file is written as a live stream with no duration in its header, so a browser
// reports Infinity and refuses to seek — which reads as "this format cannot be
// seeked" and is wrong. Asking to seek far past the end forces it to scan the file
// and work the real duration out, after which seeking is exact. Measured on the
// device: duration recovered, and a seek to 42.422s landed on 42.422s.

const SEEK_PROBE = 1e101;
const READY_TIMEOUT_MS = 6000;

export async function createPlayer(blob) {
  const url = URL.createObjectURL(blob);
  const audio = new Audio();
  audio.preload = 'metadata';
  audio.src = url;

  await once(audio, 'loadedmetadata', READY_TIMEOUT_MS);

  if (!Number.isFinite(audio.duration)) {
    await new Promise(resolve => {
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(); } };
      audio.ondurationchange = () => { if (Number.isFinite(audio.duration)) done(); };
      try { audio.currentTime = SEEK_PROBE; } catch (e) { done(); }
      setTimeout(done, READY_TIMEOUT_MS);
    });
    audio.ondurationchange = null;
    try { audio.currentTime = 0; } catch (e) { /* nothing to rewind */ }
  }

  const durationMs = Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : null;

  return {
    audio,
    durationMs,
    seekable: durationMs !== null,

    playFrom(ms) {
      try { audio.currentTime = Math.max(0, ms) / 1000; } catch (e) { /* not seekable */ }
      return audio.play();
    },

    toggle() {
      if (audio.paused) return audio.play();
      audio.pause();
      return Promise.resolve();
    },

    destroy() {
      audio.pause();
      audio.src = '';
      URL.revokeObjectURL(url);
    }
  };
}

function once(target, event, timeoutMs) {
  return new Promise(resolve => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    target.addEventListener(event, done, { once: true });
    target.addEventListener('error', done, { once: true });
    setTimeout(done, timeoutMs);
  });
}
