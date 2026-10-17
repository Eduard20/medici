# Medici · The listening room

A polished, responsive, static web app for **Love For Duty** by Paolo Buonvino, from the *I Medici* soundtrack.

## What works

- Two visible, ready-to-load MIDI arrangements: **Love for Duty · piano score**, transcribed from the user-provided sheet music by Paolo Buonvino at a steady tempo; and **Two-chord demo**, C major → A minor, four seconds at 120 BPM, from the user-provided code. These are synthesized MIDI arrangements, not the original recording. The demo is not Love for Duty.
- Love for Duty loads automatically only when there is no privately saved MIDI, without autoplay. Both Load buttons work without uploads and never replace your privately saved arrangement. The requested MIDI files are public in `assets/`; the source PDF is not included.

- Official recording through the visible YouTube player, with a direct YouTube fallback.
- A separate instrument studio with 128 General MIDI sampled instruments, including guitar, violin, piano, cello, harp, and flute.
- Local `.mid`/`.midi` import, melodic-part selection, playback/pause, seek, restart, loop, speed, volume, and transposition.
- Instrument preview plays a short C-major arpeggio, clearly labelled as a preview rather than the song.
- Imported MIDI is saved in IndexedDB on this device and browser, then restored on later visits without autoplay. It is never uploaded or added to this public repository.
- Instrument, speed, transpose, volume, and loop settings are remembered locally.
- **Remove saved MIDI** deletes the saved arrangement and clears the player. The original file is unchanged.
- Storage failures do not prevent playback for the current visit, and the app does not claim a failed save succeeded.

## Experimental PDF sheet music → MIDI

Open `convert.html` to render selected PDF pages locally with PDF.js, recognize notes with homr/Partsong in a Pyodide + ONNX Web Worker, and export real MIDI. This is optical recognition, not a lookup of known songs and not an audio converter. Nothing in the implementation matches file names or content to a prewritten arrangement.

- Up to 15 MB; 1–3 pages per run. One page is recommended for a first test. Choose a starting page and tempo (30–240 BPM).
- Engine/model downloads happen only after pressing **Read the notes**. First use downloads roughly 200–250 MB; the 157 MB models are cached when storage permits. Cancellation terminates the worker; PDF pages and partial recognition results are discarded.
- PDF images and notes never leave the browser. The app fetches versioned runtime packages from jsDelivr and pinned, hash-verified models from official `partsong.app` hosting. Those hosts receive ordinary request metadata such as IP addresses, but no score data.
- **Download MIDI** creates a local file. **Use in instrument studio** deliberately replaces this browser's saved MIDI and opens the existing player. Bundled songs remain available. No autoplay is added.
- Feature detection requires WebAssembly JSPI (`Suspending` and `promising`), workers, and Web Crypto. Tested in Chromium 154. Safari/iOS 27+ and Firefox 153+ expose JSPI, but full converter compatibility on those platforms and low-memory phones has not been verified. Unsupported browsers get a clear disabled state; the MIDI player remains usable.
- Recognition can misread notes, accidentals, timing, staves, and key/time signatures. Repeats and expressive performance details are not fully reproduced. The output is a rough draft that must be checked, not a faithful-transcription guarantee. No transcription accuracy percentage is claimed for general scores.
- The converter runs single-threaded WASM when cross-origin isolation is unavailable. There is no service worker changing the main app's YouTube/audio behavior, no paid backend, and no account or API key.

See `NOTICE.md`, `LICENSE`, and the visible converter credits for all source and model licensing details, including the upstream model-training-data caveat for commercial use.

## Important distinction

**The app does not convert the official audio recording into another instrument.** A MIDI arrangement is required to replay the song's notes on different instruments. The bundled piano-score transcription was created from the user-supplied sheet music and published at their request. It follows a steady tempo rather than recreating the original performance. You may also import your own arrangement. Drum tracks are excluded. Pitch-bend, sustain-pedal automation, and performance articulations are not currently reproduced.

Browser storage is device/browser-specific, is not a cloud backup, and may be erased by clearing site data, private browsing, storage eviction, or browser settings. A one-time MIDI import is still required for your own arrangement; the two bundled arrangements need no upload. If a replacement cannot be saved, the previous saved arrangement may reappear on reload; the app warns about this.

The soundtrack is streamed by YouTube, not copied into this repository. The player requires an internet connection and remains subject to YouTube availability, regional restrictions, and ads.

## Free GitHub Pages deployment

1. Open the repository's **Settings → Pages**.
2. Choose **Deploy from a branch**.
3. Select **main** and **/(root)**, then Save.
4. Wait for GitHub's Pages build to finish.

Expected project URL: `https://eduard20.github.io/medici/`. Verify the build and URL after enabling Pages. No paid hosting, backend, secrets, or API keys are needed.

## Run locally

```sh
python3 -m http.server 8080
```

Open `http://localhost:8080/`. Use HTTP rather than opening the HTML file directly because the instrument catalog is fetched locally.

## Tests

```sh
npm install
npm test
```

The DOM suite uses mocked Web Audio and instrument loading to verify app behavior, including asynchronous race conditions. It does not verify actual audio output or pixel layout. The standalone MIDI parser suite can also run without npm install: `node --test tests/midi.test.cjs`.

An optional browser smoke test is in `tests/browser-smoke.cjs`. Run `npx playwright install chromium` and `npm run test:browser`, or set `CHROMIUM_PATH` to an existing Chromium binary. It requires Playwright plus Chromium and exercises local MIDI import, real sample loading, player controls, desktop/mobile layouts, and the official embed. Browser tests need outbound access for fonts and samples. 

## Third-party sources and licenses

- Official recording: [Love For Duty — Paolo Buonvino](https://www.youtube.com/watch?v=QVOhsRnkLZA), provided to YouTube by Universal Music Group. All music rights remain with the respective owners.
- MIDI parsing: [@tonejs/midi](https://github.com/Tonejs/Midi), version 2.0.28, MIT; license in `vendor/midi-LICENSE`.
- Sample playback: [soundfont-player](https://github.com/danigb/soundfont-player), version 0.12.0, MIT; license in `vendor/soundfont-player-LICENSE`.
- Samples: FluidR3_GM by Frank Wen and contributors, hosted by [midi-js-soundfonts](https://github.com/gleitz/midi-js-soundfonts), [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/). Samples are loaded on demand from `gleitz.github.io`; they are not vendored here. They are not covered by the code libraries' MIT licenses.
- Fonts: DM Sans and Playfair Display, loaded from Google Fonts under their open font licenses. The UI falls back to system fonts when unavailable.
- Florence illustration: original SVG illustration created for this app.

This independent fan project is not affiliated with Netflix, Lux Vide, or Paolo Buonvino.
