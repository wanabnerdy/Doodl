# Doodl

A meeting companion. You doodle full-screen; it transcribes in the background. Tap the
highlight button and it captures the transcript timestamp, a snapshot of the doodle at that
instant, and an entry in a highlight reel.

Everything runs locally in the browser — no server, no API keys, no cost.

## Status

Pre-build. The only thing here is a device probe, because every meaningful architecture
decision depends on what the target phone actually supports.

## Layout

- `index.html` — landing page (becomes the app)
- `probe/` — device capability probe: drawing pressure, speech recognition endurance,
  audio recording, whether the two can run simultaneously, storage quota, wake lock

## Running it

There is no build step and no dependencies — it is plain HTML/CSS/JS, opened directly.
It must be served over HTTPS, though: microphone and speech recognition are both blocked
on insecure origins. GitHub Pages (see `.github/workflows/pages.yml`) is enough.
