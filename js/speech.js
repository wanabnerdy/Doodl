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
//
//  4. Listening continues while the page is hidden and while the screen is locked. A
//     meeting does not stop because you glanced at your calendar. The microphone is
//     held for the length of a session, as a voice recorder would, and handed back
//     explicitly — on Finish, or on the pause control — with the audio route repaired
//     each time.

const SAMPLE_INTERVAL_MS = 250;
const RESTART_DELAY_MS = 300;
const STALE_AFTER_MS = 20000;
const RELEASE_GRACE_MS = 700;     // long enough for a trailing final, short enough to feel instant
const CHASER_MS = 400;
const CHASER_TIMEOUT_MS = 2500;   // the reset is best-effort; it must never hang the wrap-up

export function createTranscriber({ now, onState, onUtterance, onRelease, log }) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const utterances = [];

  let rec = null;
  let active = false;
  let paused = false;
  // Set the moment recognition starts and cleared by the repair. Damage outlives any
  // particular recognition object, so whether a repair is owed cannot be decided by
  // looking at whether one is currently running.
  let routeDirty = false;
  // When recognition was genuinely listening. Every restart costs the delay plus
  // start-up time, and words spoken in those windows are simply never heard. Without
  // measuring it there is no way to tell a sparse transcript from a lossy one.
  const segments = [];
  let segmentStart = null;
  let state = 'idle';
  let lastEventAt = 0;
  let lastSampleAt = -Infinity;
  let watchdog = null;
  let pending = newPending();
  let nextId = 1;

  // Isolation testing on the target phone showed a bare getUserMedia stream leaves
  // other apps' dictation working, while speech recognition breaks it — same device,
  // same headset. JavaScript cannot touch the audio session directly, but opening and
  // closing a harmless stream afterwards may re-establish the route through the path
  // that demonstrably works. Confirmed on the device: recognition alone broke another
  // app's dictation, recognition followed by this did not.
  async function resetAudioRoute() {
    if (!routeDirty) return;
    routeDirty = false;
    // Only an explicit denial is a reason to skip. iOS tracks the speech-recognition
    // grant separately from getUserMedia, so this can still read 'prompt' after a
    // session that has been listening for minutes — and skipping on anything short of
    // 'denied' would quietly disable the one thing measured to work. The probe that
    // proved this out had no guard at all and raised no dialog.
    try {
      const status = await navigator.permissions.query({ name: 'microphone' });
      say('speech: mic permission reads ' + status.state);
      if (status.state === 'denied') return;
    } catch (e) { /* cannot tell — attempt it anyway */ }
    // Bounded: on a device with no microphone, or where the request stalls awaiting a
    // decision, this would otherwise sit between the user tapping Finish and their
    // session appearing.
    let stream = null;
    try {
      stream = await Promise.race([
        navigator.mediaDevices.getUserMedia({ audio: true }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), CHASER_TIMEOUT_MS))
      ]);
      await new Promise(r => setTimeout(r, CHASER_MS));
      say('speech: audio route reset');
    } catch (e) {
      say('speech: route reset skipped — ' + (e.name === 'Error' ? e.message : e.name));
    } finally {
      // The request may still land after the race is lost; close it either way.
      if (stream) stream.getTracks().forEach(t => t.stop());
      // The repair is itself a microphone request, so the indicator lights up again
      // for a moment after finishing. Callers can say so rather than leave the user
      // wondering whether the app let go.
      if (onRelease) onRelease();
    }
  }

  // Recorded, not acted upon. Removing the hide handler also removed any trace of when
  // the app was backgrounded, which left the diagnostics unable to show whether a
  // stretch of silence coincided with a screen lock.
  function noteVisibility() {
    say('page ' + (document.hidden ? 'hidden' : 'visible'));
  }

  function closeSegment() {
    if (segmentStart === null) return;
    segments.push({ from: segmentStart, to: now() });
    segmentStart = null;
  }

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

  // One recognition object, reused. Previously every watchdog restart constructed a
  // new one, which seizes and releases the system audio session each time. That churn
  // is the most plausible reason another dictation app was left unable to recover:
  // it sees a burst of interruptions rather than one clean start and stop.
  function build() {
    const r = new SR();
    r.continuous = true;
    r.interimResults = true;
    r.lang = 'en-US';

    r.onstart = () => {
      segmentStart = now();
      setState('listening');
      say('speech: listening');
    };

    r.onresult = e => {
      lastEventAt = Date.now();
      const t = now();
      let interim = '';

      // Finals only from resultIndex — anything earlier is already committed, and
      // re-reading it would duplicate.
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) commit(e.results[i][0].transcript.trim(), t);
      }

      // Interim text, however, is gathered from every unfinalised result rather than
      // from resultIndex onwards. resultIndex marks what CHANGED in this event, so an
      // in-progress result sitting before it would be dropped, silently truncating
      // whatever ends up flushed as partial text.
      for (let i = 0; i < e.results.length; i++) {
        if (!e.results[i].isFinal) interim += e.results[i][0].transcript;
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
      closeSegment();
      flushPending();
      if (!active || paused) { setState(paused ? 'paused' : 'idle'); return; }
      // Restarts even with the page hidden. A meeting does not stop because the screen
      // locked, and if iOS has frozen the page this timer will not fire anyway — so
      // there is nothing lost by trying.
      setState('starting');
      setTimeout(start, RESTART_DELAY_MS);
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
    if (!active || paused) return;
    if (!rec) rec = build();
    try {
      rec.start();
      routeDirty = true;
      lastEventAt = Date.now();
    } catch (err) {
      // 'already started' is harmless. Anything else: discard this object and let the
      // next attempt build a fresh one.
      if (/already|invalid/i.test(err.message || '')) return;
      say('speech: start failed — ' + err.message);
      rec = null;
      setTimeout(start, 1000);
    }
  }

  // Releasing the microphone is an explicit act now, not something that happens
  // whenever the user glances at another app. Holding it for the length of a session
  // is ordinary contention — another app is told the microphone is busy and recovers
  // on a retry — rather than the unrecoverable damage recognition leaves behind,
  // which the repair below still handles.
  function pause() {
    if (!active || paused) return Promise.resolve();
    paused = true;
    const dying = rec;
    rec = null;
    setState('paused');
    if (dying) {
      dying.onend = dying.onresult = dying.onerror = dying.onstart = null;
      try { dying.abort(); } catch (e) { /* nothing to abort */ }
      closeSegment();
      flushPending();
    }
    say('speech: paused by request — microphone released');
    return resetAudioRoute();
  }

  function resume() {
    if (!active || !paused) return;
    paused = false;
    say('speech: resumed');
    setState('starting');
    start();
  }

  return {
    supported: !!SR,
    utterances,

    get state() { return state; },
    get paused() { return paused; },

    pause,
    resume,

    begin() {
      if (!SR || active) return;
      active = true;
      paused = false;
      setState('starting');
      document.addEventListener('visibilitychange', noteVisibility);
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
      paused = false;
      clearInterval(watchdog);
      watchdog = null;
      document.removeEventListener('visibilitychange', noteVisibility);

      const dying = rec;
      rec = null;
      setState('idle');

      // Nothing live to tear down — but recognition may have run earlier in this
      // session and been aborted by the page being hidden. Returning early here meant
      // a session finished after backgrounding never repaired the audio route at all.
      if (!dying) {
        flushPending();
        return resetAudioRoute();
      }

      dying.onend = () => say('speech: ended');   // detached from the restart path
      try { dying.stop(); } catch (e) { /* already stopped */ }

      return new Promise(resolve => {
        setTimeout(async () => {
          dying.onresult = dying.onerror = dying.onend = dying.onstart = null;
          try { dying.abort(); } catch (e) { /* nothing left to abort */ }
          closeSegment();
          flushPending();
          say('speech: microphone released');
          // Deliberately not awaited: the transcript is complete at this point, so the
          // wrap-up should appear straight away. The route reset is repair work that
          // belongs after the user has their session, not in front of it.
          resetAudioRoute();
          resolve();
        }, RELEASE_GRACE_MS);
      });
    },

    // How much of the session was actually being listened to, and where the deaf
    // spots were. Gaps under a second are the ordinary cost of a restart and would
    // only be noise here.
    coverage(totalMs) {
      // Include a segment still in progress. Callers happen to ask after teardown, but
      // a listening-time figure that omits the listening happening right now is wrong.
      const open = segmentStart === null ? [] : [{ from: segmentStart, to: now() }];
      const heard = segments.concat(open).sort((a, b) => a.from - b.from);
      const listeningMs = heard.reduce((n, s2) => n + (s2.to - s2.from), 0);
      const gaps = [];
      let cursor = 0;
      for (const seg of heard) {
        if (seg.from - cursor >= 1000) gaps.push({ from: cursor, to: seg.from });
        cursor = Math.max(cursor, seg.to);
      }
      if (totalMs - cursor >= 1000) gaps.push({ from: cursor, to: totalMs });
      return { listeningMs, totalMs, gaps };
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
