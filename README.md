# Doodl

A meeting companion. You doodle full-screen; it transcribes in the background. Tap the
highlight button and it captures the moment three ways: a timestamp in the transcript,
the doodle exactly as it stood at that instant, and an entry in the highlight reel.

Everything runs locally in the browser — no server, no API keys, no cost.

## Status

**Phase 1 is built and validated on the target device.** Canvas, background
transcription, highlights, wrap-up screen, local session history — all exercised in
real sessions on an iPhone, not only in tests.

**Phase 2 is built and confirmed on the device.** Playback works, a highlight plays
from the moment it was tapped, and audio recorded while the screen was locked was
played back and contains real sound — verified by listening, which is the only way
that question could be answered. Still untested: a long session, where memory,
battery and thermals would show up and 85 seconds tells you nothing.

**Phase 3 is built, pending device testing.** The doodle redraws itself in step with
the audio: a full-screen replay with a scrubbable timeline, highlight moments marked
on it, and playback speed. It needed nothing new from the data — strokes have carried
timestamps since the first build, and the renderer already accepted an "up to time T"
argument. A session with no audio replays on a plain timer instead.

Audio records alongside the session and
is written to storage in five-second chunks as it happens, so a long meeting costs
disk rather than memory and a crash loses seconds. The wrap-up plays it back, each
highlight can be heard as well as read, and a stretch the transcriber missed is
playable where the gap is marked. Audio can be deleted on its own, leaving the doodle
and transcript.

Phase 2 (audio recording) and Phase 3 (stroke-synced playback) are not started, but
Phase 1 stores what Phase 3 needs: every stroke is a timestamped vector, so playback is
a matter of replaying data that is already there.

## Layout

- `index.html` — the app shell: home, session, wrap-up
- `js/strokes.js` — stroke model and rendering. Vectors with timestamps, never bitmaps
- `js/speech.js` — transcription, highlight anchoring, restart watchdog
- `js/store.js` — IndexedDB session persistence
- `js/recorder.js` — audio capture, chunked to storage as it arrives
- `js/playback.js` — playback, including recovering a duration the file does not carry
- `js/backgrounds.js` — procedurally drawn paper templates
- `js/app.js` — screens, canvas input, export
- `probe/` — device capability probes (see below)
- `test/smoke.mjs` — Playwright run through the whole flow

## Why it is built the way it is

The design follows what `probe/` measured on the target device (iPhone, iOS 18.7,
Safari 26.6), not what the APIs advertise:

| Measured | Consequence |
|---|---|
| Pointer pressure is flat zero on touch | Line weight comes from stroke speed instead |
| iPadOS reports a Pencil as `pen` and a resting palm as `touch` | Touch stops drawing once a pen is used, and marks the palm already left are swept |
| Up to 6 coalesced points per pointer event | Used for smooth lines rather than visible corners |
| A 250-char final arrived *after* recognition was stopped | Highlights anchor to interim samples, never to finals |
| First `onstart` took 4.5 s; later ones instant | A distinct "warming up" state, so the UI never lies about listening |
| ~39 GB quota, IndexedDB blobs fine | IndexedDB over localStorage, whose ~5 MB cap is the real limit |
| Recording and transcription coexisted | Phase 2 is not blocked on microphone contention |
| Capture ran through backgrounding and a locked screen with no holes | Recording never stops itself on visibility |
| Chunk handlers kept firing while hidden | The page is not frozen while capturing, so chunks can be written as they arrive |
| ~93 MB per hour | Chunked to storage rather than held in memory |
| Duration absent from the file, recovered by seeking past the end | Playback and Phase 3 are not blocked by the container |
| Survived 20s of enforced silence, no restarts | Endurance is not the risk it looked like |
| Warm start with permission granted: 7 ms | Earlier multi-second "start-up" was permission dialogs |
| Finalisation fires on a detected pause, 2.6 s after talking stopped | Anchoring must not wait for finals |
| Trailing speech never finalised before stop | Unfinalised text is kept as provisional, not dropped |

## The microphone problem

Using the Web Speech API on iOS leaves the system audio session in a state other
recording apps cannot recover from. Symptom: another app connects to the microphone,
shows it as available, and receives no audio.

This took five wrong theories to pin down. It is not how recognition is stopped, not
how often it restarts, not Bluetooth, and not microphone use in general. Isolation
testing on the device settled it:

| Test | What it does | Other app's dictation afterwards |
|---|---|---|
| A | `getUserMedia` stream, opened and closed | **works** |
| C | Speech recognition, cleanly torn down | **broken** |
| D | Speech recognition, then A | **works** |

So a plain stream is harmless *and* repairs what recognition damages. The app opens
and closes one after recognition ends — see `resetAudioRoute` in `js/speech.js`.
JavaScript cannot touch the audio session directly, so this is the only lever
available. `probe/mic.html` reproduces the whole comparison.

Repairs run when a session ends and when listening is paused.

The repair races its microphone request against a timeout so it can never hold up the
wrap-up, and **the cleanup belongs to the request, not to whichever promise wins**. An
earlier version assigned the stream only when the request won, so a slow request — a
Bluetooth headset renegotiating, for instance — left an arriving stream with no
reference and nothing to stop it. It stayed live for the lifetime of the page, keeping
the phone's recording indicator lit until Safari was closed. The comment above that
code claimed the late arrival was handled, which is why re-reading it never revealed
the fault.

**A session holds the microphone for its whole length**, through backgrounding and a
locked screen, as a voice recorder does. An earlier build released it automatically
whenever the page was hidden, which fixed contention at the cost of the feature: a
meeting does not stop because you glanced at your calendar. Another app asking
mid-session is told the microphone is busy and recovers on a retry — ordinary
contention, not the unrecoverable state. Handing it over is explicit: tap the
listening pill, or finish the session.

**The two microphone consumers must not share a policy.** Speech recognition causes
the damage and dies on suspension anyway, so stopping it when the page is hidden is
correct. A plain recording stream does not: holding one open causes ordinary
contention that another app recovers from with a retry, exactly as any voice memo app
does. Applying the recognition policy to a recorder would destroy the recording by our
own hand — and a probe that stopped the recorder on hide would measure that policy
while appearing to measure iOS. `probe/record.html` never stops the recorder itself,
for that reason.

**One case remains, and it is inherent.** Swiping away mid-session leaves the audio
session damaged until you return to the app. Releasing recognition happens
synchronously on the way out, but the repair needs an asynchronous microphone
request, and there is no window for that while the page is being suspended.
Returning to the app fixes it — that is the first moment code can run again.
Closing this case entirely would mean not using the Web Speech API.

## Running it

No build step and no dependencies — plain HTML/CSS/ES modules. It must be served over
HTTPS, though: microphone and speech recognition are both blocked on insecure origins.
GitHub Pages (`.github/workflows/pages.yml`) handles that.

The smoke test needs a static server and Playwright:

    npx http-server -p 8080 -c-1 .
    node test/smoke.mjs

`test/anchor.mjs` needs neither, and is the more interesting one: it replays a real
recorded device timeline through the transcriber and checks that a highlight tapped
10 seconds in is filed against the words spoken at that moment, rather than 17.6
seconds later when Safari finally got round to finalising the sentence.

    node test/anchor.mjs
