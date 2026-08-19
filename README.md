# Doodl

A meeting companion. You doodle full-screen; it transcribes in the background. Tap the
highlight button and it captures the moment three ways: a timestamp in the transcript,
the doodle exactly as it stood at that instant, and an entry in the highlight reel.

Everything runs locally in the browser — no server, no API keys, no cost.

## Status

**Phase 1 is built.** Canvas, background transcription, highlights, wrap-up screen,
local session history.

Phase 2 (audio recording) and Phase 3 (stroke-synced playback) are not started, but
Phase 1 stores what Phase 3 needs: every stroke is a timestamped vector, so playback is
a matter of replaying data that is already there.

## Layout

- `index.html` — the app shell: home, session, wrap-up
- `js/strokes.js` — stroke model and rendering. Vectors with timestamps, never bitmaps
- `js/speech.js` — transcription, highlight anchoring, restart watchdog
- `js/store.js` — IndexedDB session persistence
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
| Up to 6 coalesced points per pointer event | Used for smooth lines rather than visible corners |
| A 250-char final arrived *after* recognition was stopped | Highlights anchor to interim samples, never to finals |
| First `onstart` took 4.5 s; later ones instant | A distinct "warming up" state, so the UI never lies about listening |
| ~39 GB quota, IndexedDB blobs fine | IndexedDB over localStorage, whose ~5 MB cap is the real limit |
| Recording and transcription coexisted | Phase 2 is not blocked on microphone contention |
| Survived 20s of enforced silence, no restarts | Endurance is not the risk it looked like |
| Warm start with permission granted: 7 ms | Earlier multi-second "start-up" was permission dialogs |
| Finalisation fires on a detected pause, 2.6 s after talking stopped | Anchoring must not wait for finals |
| Trailing speech never finalised before stop | Unfinalised text is kept as provisional, not dropped |

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
