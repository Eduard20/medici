# Sheet Music Studio

A progressive, single-page, private **PDF sheet music → instrument playback** app. Public deployment: https://eduard20.github.io/medici/ (the existing repository URL is unchanged).

## Use it

1. Start with **Upload sheet music**, **Find a free score**, and your **Saved music** library. Upload a printed sheet-music PDF, or search Wikimedia Commons by piece/composer and choose **Use this score**; only recognition progress and cancellation are shown while it is read.
2. When conversion finishes, or when you open a saved piece, the instrument picker and player appear. Find a sound in the searchable 128-instrument library. Eight suggested sounds are shown first; family filters expose the full catalog without a long dropdown.
3. Press **Play score**. The recognized notes are ready automatically, with no MIDI import, download, or second page required.

There is no YouTube player, built-in song, MIDI upload, account, paid backend, or autoplay. Optional MIDI export remains a secondary action. The old `convert.html` URL redirects to the studio.

## Recognition and limits

- This is actual optical music recognition: PDF.js renders selected pages locally, Partsong/homr runs in a Pyodide + ONNX worker, and MusicXML is converted to a real MIDI score. No filename/content lookup substitutes a prewritten tune.
- PDFs up to 15 MB. By default read up to the first 3 pages. Advanced options choose starting page, 1–3 pages, and tempo (30–240 BPM). If only part of a PDF is read, the result explicitly identifies the pages.
- First use downloads roughly 200–250 MB. The 157 MB model set is cached when browser storage permits. Downloads start only after choosing a PDF. Runtime packages are versioned; model files are pinned and SHA-256 verified.
- Cancellation terminates recognition and discards partial results. A failed conversion keeps the last playable score. New work cannot be overwritten by a stale conversion or delayed restoration.
- Recognition is experimental. Notes, accidentals, rhythm, staves, and key/time signatures can be wrong. Repeats and expressive timing/pedal are not fully reproduced. Check the draft against the score; no general accuracy percentage is claimed.
- Requires WebAssembly, web workers, and Web Crypto over HTTPS. The recognition bridge uses ordinary async/await, so WebAssembly JSPI is no longer required. Browsers without JSPI use ONNX’s plain WASM runtime instead of its WebGPU/Asyncify bundle. Actual iPhone/iPad hardware and low-memory phones still need verification; availability of the APIs is not a full compatibility guarantee.
- Single-threaded WASM is used when cross-origin isolation is absent. No service worker changes site security headers.

## Free-score catalogue

- Wikimedia Commons provides a modest, uneven collection, mostly historical/classical. Search results are limited to 20 PDF candidates under 15 MB from the sheet-music category tree. Shorter, more specific composer/title queries work best; modern songs may be absent.
- Search shows edition filenames, available creator credit, page count, size and the source’s listed licence. Before importing, the app checks the selected edition’s actual categories again: these can reveal a modern CC arrangement even when the API’s headline label describes a public-domain composition. Public-domain, CC0 and standard CC BY/BY-SA editions are supported. Unfamiliar regional terms, ambiguous multiple CC licences, missing required credit, or incomplete category metadata require source-page review instead of automatic import. Metadata can still be wrong; users must check the source and local copyright law before reuse.
- Downloads use only validated HTTPS Wikimedia PDF URLs, omit credentials/referrers, reject redirects, enforce a streamed 15 MB limit, and check the PDF header before using the same local converter. Selecting a score reads up to three pages with the existing page/tempo options. Search/download cancellation, stale responses, unavailable search, missing results, unsupported files and browser limits have visible recovery paths.
- Creator/credit, source page, PDF URL and licence are stored with the recognized piece and shown in its player. MIDI exports include this source attribution as a MIDI text metadata event and identify experimental transcription as a modification. Keep required attribution and follow ShareAlike where applicable; this feature does not grant rights or verify worldwide public-domain status.
- API documentation: https://www.mediawiki.org/wiki/API:Search and https://www.mediawiki.org/wiki/API:Imageinfo . Source licensing guidance: https://commons.wikimedia.org/wiki/Commons:Reusing_content_outside_Wikimedia .

## Instrument player

- Search all instruments by name, friendly alias, or family; category buttons, clear-search and empty-state reset work with keyboard controls.
- The selected instrument remains visible when filtering. Choosing another sound during playback resumes at the same position. Preview plays a short, clearly labelled C-major arpeggio.
- Play/pause, seek, restart, loop, speed, volume, transposition, and melodic-part selection remain available. Advanced playback controls are tucked into a disclosure.
- Drum tracks, pitch-bend, sustain-pedal automation, and detailed articulations are not reproduced.
- No samples or audio context are loaded on startup. Samples load on an explicit preview/play action.
- On browsers with the Audio Session API, explicit Play/Preview selects the music-playback category so iPhone Silent Mode does not mute the score. Stop/pause/finish restores the automatic category. Unsupported browsers retain normal Web Audio behavior; actual audible output in iPhone Safari/Chrome still needs device verification.

## Privacy and persistence

Uploaded PDF pages and recognized notes never leave the browser. Free-score searches send the entered keywords to Wikimedia Commons only on an explicit search; selecting a score fetches its source metadata and PDF directly from Wikimedia. No API key, account, proxy, or backend is used. Runtime/model/sample/font hosts receive ordinary request metadata, but no score data. Sources: versioned jsDelivr packages, official Partsong model hosting, gleitz.github.io samples, and Google Fonts.

Multiple converted pieces are saved atomically as `pdf-arrangement` in the existing IndexedDB database (latest piece plus earlier entries). The previous single saved PDF is preserved automatically. Legacy song/manual-import records are deliberately not restored. Instrument, speed, transpose, volume, and loop preferences remain local. Reload opens the upload/library view without autoplay; choose a saved piece to reveal its player. **Your music** returns to the library and stops audio. **Remove saved score** deletes only that piece and cancels active recognition. Cross-tab writes merge inside a transaction. A storage failure is reported; unsaved pieces remain playable for the current visit.

Storage is device/browser-specific, has no cloud backup or cross-device sync, and may be erased by clearing site data, private browsing, or eviction. Clearing downloaded models does not delete saved music.

## Development and tests

```sh
npm install
npm test
npm run serve
```

Rebuild the browser-only homr async archive with `python3 scripts/build_async_homr.py`. Validate it with `python3 -m unittest discover -s tests -p 'test_*.py'`. The builder verifies the pinned upstream archive and each changed call site, preserves source comments, and produces `vendor/homr-async.zip`; the original `vendor/homr.zip` remains unchanged. Constructors use initialized session metadata; inference awaits the JavaScript model promises directly.

Serve the root over HTTP; opening the HTML as a file does not support catalog/worker loading. The DOM suites mock audio and recognition dependencies; they verify lifecycle, searches, race conditions, validation, storage, and controls, not transcription accuracy or actual audible output.

`npm run test:browser` runs the separate browser smoke test with Playwright and Chromium (`npx playwright install chromium`, or set `CHROMIUM_PATH`). Set `PDF_FIXTURE` to a printed sheet-music PDF for the optional full, real recognition pass. It requires network access for engine/models/samples. The browser suite checks actual rendered desktop/mobile layouts and keyboard interaction.

## License

Application code: AGPL-3.0. See `LICENSE` and `NOTICE.md` for Partsong/homr source provenance, runtime/library licenses, instrument sample attribution, and the upstream model-training-data caveat for commercial use. No source PDFs or soundtrack audio are published.
