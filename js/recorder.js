// Local audio recording.
//
// Measured on the target device (probe/record.html, iOS 18.7 / Safari 26.6):
//
//  1. Capture survives both backgrounding and a locked screen with no holes — 85
//     seconds across two hidden stretches, chunks arriving on schedule throughout.
//     Nothing here stops on visibility, deliberately: doing so would destroy the
//     recording by our own hand, whatever the platform allows.
//
//  2. The page is not frozen while capturing. Chunk handlers kept firing at their
//     interval the whole time the app was hidden, which is why writing each chunk
//     away as it arrives actually works rather than piling up until resume.
//
//  3. Roughly 93 MB an hour. Small against the ~39 GB of quota, far too large to
//     hold in memory for a long meeting — hence chunks, written immediately.

const CHUNK_MS = 5000;   // a write every five seconds: a crash costs seconds, not hours

export function createRecorder({ log, now, onChunk }) {
  const say = msg => { if (log) log(msg); };

  // Every stream this module opens. A stream with no reference cannot be stopped, and
  // an unstopped one keeps the phone's recording indicator lit until the tab closes.
  const openStreams = new Set();
  let recorder = null;
  let index = 0;
  let bytes = 0;
  let startedAt = null;

  function closeAll() {
    for (const s of openStreams) {
      try { s.getTracks().forEach(t => t.stop()); } catch (e) { /* already stopped */ }
    }
    openStreams.clear();
  }

  return {
    supported: typeof MediaRecorder !== 'undefined' &&
               !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),

    get bytes() { return bytes; },
    get chunkCount() { return index; },
    get running() { return !!recorder && recorder.state === 'recording'; },

    async start() {
      if (recorder) return true;
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        openStreams.add(stream);
      } catch (e) {
        say('recorder: microphone refused — ' + e.name);
        return false;
      }

      // Opus in WebM is preferred and mp4 is the fallback; the device supports both.
      const preferred = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
        .find(m => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m));

      try {
        recorder = new MediaRecorder(stream, preferred ? { mimeType: preferred } : undefined);
      } catch (e) {
        say('recorder: could not start — ' + e.name);
        closeAll();
        return false;
      }

      startedAt = now();
      recorder.ondataavailable = e => {
        if (!e.data || !e.data.size) return;
        bytes += e.data.size;
        const i = index++;
        // Handed straight to the caller to be written away. Nothing accumulates here.
        Promise.resolve(onChunk && onChunk(e.data, i, now()))
          .catch(err => say('recorder: chunk ' + i + ' failed to store — ' + err.message));
      };
      recorder.onerror = e => say('recorder: error — ' + ((e.error && e.error.name) || 'unknown'));

      recorder.start(CHUNK_MS);
      say('recorder: recording as ' + recorder.mimeType);
      return true;
    },

    // Resolves once the final chunk has been handed over, so the caller can save a
    // complete record rather than one missing its tail.
    async stop() {
      if (!recorder) { closeAll(); return null; }
      const mimeType = recorder.mimeType;
      const dying = recorder;
      recorder = null;

      await new Promise(resolve => {
        dying.onstop = resolve;
        try { dying.stop(); } catch (e) { resolve(); }
        setTimeout(resolve, 3000);        // never hang the end of a session
      });
      closeAll();

      const durationMs = startedAt === null ? 0 : now() - startedAt;
      say('recorder: stopped — ' + index + ' chunks, ' + (bytes / 1048576).toFixed(1) + ' MB');
      return { mimeType, chunks: index, bytes, durationMs, startedAt };
    }
  };
}
