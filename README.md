# Guess the Phrase (Family Heads Up–style)

A minimal, polished **static** web app (HTML/CSS/JS only, no build step) for a family “guess the word/phrase” game.

## Features

- Paste phrases (one per line) or load a `.txt` file
- Ignores blank lines + comments starting with `#`
- Remembers last list + options via `localStorage`
- Huge high-contrast game screen
- Swipe right = **Got it**, swipe left = **Pass**
- Tap left/right zones + Next button fallback
- Round timer + results summary
- Shuffle on start toggle, loop toggle
- Fullscreen button (where supported)
- Wake Lock attempt (where supported)
- Optional vibration feedback
- Optional tilt controls (DeviceOrientationEvent)
  - Tilt forward = Got it
  - Tilt backward = Pass
  - Debounce + neutral reset zone
  - iOS motion permission button when required
- ✅ Offline caching via Service Worker (after first load)

## Files

- `index.html`
- `styles.css`
- `app.js`
- `sw.js` (service worker)
- `README.md`

## Deploy on GitHub Pages

1. Create a new GitHub repo
2. Add the five files above at the repo root
3. Settings → Pages → Deploy from branch → `main` / `/root`
4. Open the Pages URL on your phone

## Offline notes (Service Worker)

- First visit must be online so files can be cached.
- After that, the app should work offline even after a reload.
- When you update the app, users may need to refresh once while online.
  - The service worker updates in the background and will take over on the next navigation.

## Tilt notes

- Enable “Enable tilt controls” in Setup.
- On iOS Safari, motion sensors may require permission:
  - Tap “Request Motion Access” (must be a user gesture).
- If tilt feels too sensitive, adjust thresholds in `app.js`:
  `const TILT = { ... }`

## Run locally

Service workers require a secure context (HTTPS) or localhost.

```bash
python3 -m http.server 8080
# visit http://localhost:8080
