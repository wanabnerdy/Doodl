// Replays a real recorded device timeline through the live transcriber and checks
// that highlights land where the words actually were.
//
// The data below is verbatim from probe/speech.html run on the target iPhone
// (iOS 18.7 / Safari 26.6): the tester read a passage for 25s, sat in silence for
// 20s, then read again for 25s. Recognition emitted just two final results in 70
// seconds — one 2.6s AFTER the talking stopped, one 40s after that.
//
//   node test/anchor.mjs

const FAILS = [];
const check = (ok, label, extra = '') => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (extra ? '  — ' + extra : ''));
  if (!ok) FAILS.push(label);
};

// --- recorded device data -------------------------------------------------
const SAMPLES = [
  [2748,3],[3480,20],[4455,29],[5173,38],[5864,48],[6378,53],[7297,73],[7803,81],
  [8540,99],[9736,106],[10428,116],[11163,133],[11905,143],[12821,154],[13327,165],
  [14064,177],[14979,197],[15715,204],[16225,208],[16915,228],[17420,236],[18347,252],
  [18847,271],[19593,276],[20795,289],[21468,305],[22203,318],[22939,330],[23872,346],
  [24375,356],[25106,375],[25796,386],[26534,393],
  [47862,6],[48608,11],[49593,24],[50528,35],[51241,47],[51745,58],[52440,65],
  [53388,76],[54115,86],[54865,98],[55547,109],[56547,118],[57487,132],[58231,146],
  [58908,153],[59437,166],[60099,170],[61286,179],[61818,184],[62771,203],[63463,219],
  [64441,223],[65395,234],[66126,243]
];
// The second final reads as gibberish because the tester deliberately read the
// passage backwards. Safari transcribed it faithfully — note "hole" for "whole" and
// "beating" for "meeting", the recogniser falling back on homophones with no word
// order to help it. Nothing here is broken; do not go looking for a parser bug.
const FINALS = [
  [27623, 393, 'The quarterly numbers came in ahead of plan mostly on the back of renewals rather than new business engineering shipped the migration two weeks late which pushed the launch into the following month nobody was thrilled about that but the alternative was shipping something half finished for next quarter the priority is reducing churn in the mid market and we need a decision on pricing before the'],
  [67589, 259, 'Window hole the loose we again slips that if beating board before pricing on decisions and need we and market mid the in churn reducing is priority the quarter next for finished half something shipping was alternative the but that about thrilled was nobody month following the into launch the pushed which']
];

// --- a stand-in for the browser's SpeechRecognition ------------------------
let instance = null;
class FakeRecognition {
  constructor() { instance = this; }
  start() { if (this.onstart) this.onstart(); }
  stop() { if (this.onend) this.onend(); }
}
globalThis.window = { SpeechRecognition: FakeRecognition };
// speech.js checks visibility before reclaiming the microphone, so the stub needs it
globalThis.document = {
  hidden: false,
  addEventListener() {},
  removeEventListener() {}
};

const { createTranscriber } = await import('../js/speech.js');

let clock = 0;
const t = createTranscriber({ now: () => clock, onState: () => {}, log: () => {} });
t.begin();
const inst1 = instance;   // captured: a later transcriber replaces the shared handle

const fire = (text, isFinal) =>
  inst1.onresult({ resultIndex: 0, results: [{ 0: { transcript: text }, isFinal }] });

// Replay the timeline in order, interims and finals interleaved by timestamp.
const timeline = [
  ...SAMPLES.map(([ms, len]) => ({ ms, kind: 'interim', len })),
  ...FINALS.map(([ms, chars, text]) => ({ ms, kind: 'final', text: text.slice(0, chars) }))
].sort((a, b) => a.ms - b.ms);

let source = FINALS[0][2];
for (const ev of timeline) {
  clock = ev.ms;
  if (ev.kind === 'final') { fire(ev.text, true); source = FINALS[1][2]; }
  else fire(source.slice(0, ev.len), false);
}

console.log('\nHighlight anchoring against recorded device data\n');

check(t.utterances.length === 2, 'two utterances reconstructed', t.utterances.length + ' found');

const u1 = t.utterances[0], u2 = t.utterances[1];
check(u1.startT === 2748, 'utterance starts when speech started, not when it finalised',
      'startT ' + u1.startT + ' vs final at 27623');
check(u1.endT === 27623, 'utterance ends at finalisation');

// The whole point: a highlight tapped 10s in must not be filed at 27.6s.
const a = t.anchorAt(10000);
check(a && a.utteranceId === u1.id && a.during, 'a highlight 10s in lands inside the right sentence');
check(a && a.charOffset === 106, 'and at the words being spoken at that instant',
      'char ' + (a && a.charOffset) + ' of ' + u1.text.length);
console.log('          naive approach would have filed it at ' +
            ((27623 - 10000) / 1000).toFixed(1) + 's too late');

// 276 is the sample recorded at 19.593s — the most recent one that had actually
// happened. Reaching for the 20.795s sample would mean anchoring to words not yet
// spoken when the button was pressed.
const mid = t.anchorAt(20000);
check(mid && mid.charOffset === 276, 'a highlight 20s in moves further along the same sentence',
      'char ' + (mid && mid.charOffset));
check(mid.charOffset > a.charOffset, 'later highlights sit later in the text');

// Tapped during the 20s silence: no sentence in play, so it should say so.
const quiet = t.anchorAt(35000);
check(quiet && !quiet.during && quiet.utteranceId === u1.id,
      'a highlight during silence attaches to the previous sentence, flagged as between');

const second = t.anchorAt(50000);
check(second && second.utteranceId === u2.id && second.during,
      'a highlight after the silence lands in the second sentence');
check(second && second.charOffset === 24, 'positioned by that sentence own samples',
      'char ' + (second && second.charOffset));

// Before anyone spoke at all.
check(t.anchorAt(500) === null, 'a highlight before any speech has no anchor');

// A highlight tapped mid-sentence, BEFORE that sentence has finalised. This is the
// normal case in a real meeting and it was landing on the previous sentence: at tap
// time the words being spoken exist only as pending interim text, so a lookup over
// finished utterances cannot see them. Resolving after the session ends fixes it.
{
  const clockRef = { v: 0 };
  const live = createTranscriber({ now: () => clockRef.v, onState: () => {}, log: () => {} });
  live.begin();
  const inst2 = instance;
  const emit = (text, isFinal) =>
    inst2.onresult({ resultIndex: 0, results: [{ 0: { transcript: text }, isFinal }] });

  clockRef.v = 1000; emit('we should ship the', false);
  clockRef.v = 2000; emit('we should ship the pricing change before', false);
  const tapped = 2000;                       // tapped here, mid-sentence
  const atTap = live.anchorAt(tapped);
  check(atTap === null || !atTap.during, 'mid-sentence tap cannot resolve yet (this was the bug)');

  clockRef.v = 4500; emit('we should ship the pricing change before the board meeting', true);
  const resolved = live.anchorAt(tapped);
  check(resolved && resolved.during, 'and resolves correctly once the sentence finalises');
  check(resolved && resolved.charOffset === 40, 'landing on the words spoken at tap time',
        'char ' + (resolved && resolved.charOffset));
}

// The recorded run lost words this way: the tester was still mid-sentence when the
// test ended, and those ~40 characters were never finalised — they existed only as
// interim text. Ending a session must keep them rather than drop them on the floor.
clock = 69951;
fire('and if that slips again we lose the whole', false);
clock = 70259;
await t.end();   // async now: it waits briefly for a trailing final, then frees the mic
const last = t.utterances[t.utterances.length - 1];
check(t.utterances.length === 3, 'unfinalised trailing speech is kept, not lost',
      t.utterances.length + ' utterances');
check(last && last.provisional && last.text.startsWith('and if that slips'),
      'and is marked provisional so the wrap-up can flag it');

// Reclaiming the microphone while the user is in another app is the behaviour most
// likely to leave a different dictation app unable to record.
{
  const bg = createTranscriber({ now: () => 0, onState: () => {}, log: () => {} });
  bg.begin();
  const inst = instance;
  let starts = 0;
  inst.start = () => { starts++; };

  document.hidden = true;
  inst.onend();                       // recognition dies while backgrounded
  await new Promise(r => setTimeout(r, 500));
  check(starts === 0, 'a backgrounded page does not grab the microphone back', starts + ' starts');

  document.hidden = false;
  bg.begin();                          // no-op, already active
  starts = 0;
  inst.onend();
  await new Promise(r => setTimeout(r, 500));
  check(starts === 1, 'and resumes once the page is visible again', starts + ' starts');
  await bg.end();
  document.hidden = false;
}

console.log('\n' + (FAILS.length ? FAILS.length + ' FAILING\n' : 'all checks passed\n'));
process.exit(FAILS.length ? 1 : 0);
