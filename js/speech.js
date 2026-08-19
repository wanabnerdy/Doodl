// Background transcription.
//
// Shaped entirely by what the device probe measured on iOS Safari:
//
//  1. Finals arrive in huge lumps, long after the words were spoken — a 20-second
//     stretch of speech came back as ONE final result 300ms AFTER recognition stopped.
//     Timestamping a final when it arrives would put every highlight in the wrong
//     place. Interim results, by contrast, stream continuously (132 updates against 3
//     finals). So we sample the growing interim text and use those samples to work out
//     roughly where in the final sentence any given moment landed.
//
//  2. First start took 4.5 seconds before onstart fired; later starts were instant.
//     Callers get a distinct 'starting' state so the UI doesn't claim to be listening
//     before it is.
//
//  3. It never died unprompted in testing, but 20 seconds of continuous speech is a
//     kind test. The watchdog restarts on death or on a long silence regardless, so
//     endurance stops being something we have to be right about.

const SAMPLE_INTERVAL_MS = 250;
const RESTART_DELAY_MS = 300;
const STALE_AFTER_MS = 20000;
const RELEASE_GRACE_MS = 700;   // long enough for a trailing final, short enough to feel instant

export function createTranscriber({ now, onState, onUtterance, log }) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const utterances = [];

  let rec = null;
  let active = false;
  let state = 'idle';
  let lastEventAt = 0;
  let lastSampleAt = -Infinity;
  let watchdog = null;
  let pending = newPending();
  let nextId = 1;

  function newPending() {
    return { startT: null, samples: [], text: '' };
  }

  function setState(next) {
    if (state === next) return;
    state = next;
    if (onState) onState(next);
  }

  function say(msg) {
    if (log) log(msg);
  }

  function build() {
    const r = new SR();
    r.continuous = true;
    r.interimResults = true;
    r.lang = 'en-US';

    r.onstart = () => { setState('listening'); say('speech: listening'); };

    r.onresult = e => {
      lastEventAt = Date.now();
      const t = now();
      let interim = '';

      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i];
        const text = result[0].transcript;
        if (result.isFinal) {
          commit(text.trim(), t);
        } else {
          interim += text;
        }
      }

      if (interim) {
        if (pending.startT === null) pending.startT = t;
        pending.text = interim;
        // Throttled: 130 interim events over a short test is more resolution than a
        // highlight anchor needs, and every sample is stored with the session.
        if (t - lastSampleAt >= SAMPLE_INTERVAL_MS) {
          lastSampleAt = t;
          pending.samples.push({ t, len: interim.length });
        }
      }
    };

    r.onerror = e => {
      lastEventAt = Date.now();
      // 'no-speech' and 'aborted' are routine during a quiet meeting, not failures.
      if (e.error === 'no-speech' || e.error === 'aborted') {
        say('speech: ' + e.error + ' (ignored)');
        return;
      }
      say('speech: ERROR ' + e.error);
      setState('error');
    };

    r.onend = () => {
      say('speech: ended');
      flushPending();
      if (active) {
        setState('starting');
        setTimeout(start, RESTART_DELAY_MS);
      } else {
        setState('idle');
      }
    };

    return r;
  }

  function commit(text, t) {
    if (!text) return;
    const u = {
      id: nextId++,
      text,
      startT: pending.startT === null ? t : pending.startT,
      endT: t,
      samples: pending.samples
    };
    utterances.push(u);
    pending = newPending();
    lastSampleAt = -Infinity;
    if (onUtterance) onUtterance(u);
  }

  // A restart throws away whatever was mid-sentence, so keep it as provisional text
  // rather than silently losing the words.
  function flushPending() {
    if (pending.text.trim()) {
      const u = {
        id: nextId++,
        text: pending.text.trim(),
        startT: pending.startT === null ? now() : pending.startT,
        endT: now(),
        samples: pending.samples,
        provisional: true
      };
      utterances.push(u);
      if (onUtterance) onUtterance(u);
    }
    pending = newPending();
    lastSampleAt = -Infinity;
  }

  function start() {
    if (!active) return;
    try {
      rec = build();
      rec.start();
      lastEventAt = Date.now();
    } catch (err) {
      say('speech: start failed — ' + err.message);
      setTimeout(start, 1000);
    }
  }

  return {
    supported: !!SR,
    utterances,

    get state() { return state; },

    begin() {
      if (!SR || active) return;
      active = true;
      setState('starting');
      start();
      watchdog = setInterval(() => {
        if (!active) return;
        if (Date.now() - lastEventAt > STALE_AFTER_MS) {
          say('speech: silent too long, restarting');
          lastEventAt = Date.now();
          try { rec && rec.stop(); } catch (e) { /* onend will restart it */ }
        }
      }, 5000);
    },

    // Returns a promise: teardown is deliberately not instant.
    //
    // Calling stop() alone leaves Safari holding the audio session, which locks the
    // microphone away from every other app on the phone until Safari is force quit.
    // abort() is what actually releases it. But aborting immediately would throw away
    // the last final, which the probe measured arriving 130–290 ms AFTER stop. So:
    // stop, keep listening briefly for that straggler, then abort and let go.
    end() {
      active = false;
      clearInterval(watchdog);
      watchdog = null;

      const dying = rec;
      rec = null;
      setState('idle');

      if (!dying) { flushPending(); return Promise.resolve(); }

      dying.onend = () => say('speech: ended');   // detached from the restart path
      try { dying.stop(); } catch (e) { /* already stopped */ }

      return new Promise(resolve => {
        setTimeout(() => {
          dying.onresult = dying.onerror = dying.onend = dying.onstart = null;
          try { dying.abort(); } catch (e) { /* nothing left to abort */ }
          flushPending();
          say('speech: microphone released');
          resolve();
        }, RELEASE_GRACE_MS);
      });
    },

    // Where in the transcript was this moment? Returns the utterance in play at time T
    // plus a character offset into it, derived from the interim samples.
    anchorAt(t) {
      const inPlay = utterances.find(u => t >= u.startT && t <= u.endT);
      const u = inPlay || lastBefore(t);
      if (!u) return null;

      let offset = u.text.length;
      if (inPlay && u.samples.length) {
        const sample = [...u.samples].reverse().find(s => s.t <= t);
        offset = sample ? Math.min(sample.len, u.text.length) : 0;
      }
      return { utteranceId: u.id, charOffset: offset, during: !!inPlay };
    }
  };

  function lastBefore(t) {
    let best = null;
    for (const u of utterances) if (u.endT <= t && (!best || u.endT > best.endT)) best = u;
    return best;
  }
}
