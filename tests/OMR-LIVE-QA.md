# Experimental OMR live verification — 2026-10-17

These are small smoke tests, not a general accuracy benchmark. Run `npm test` for the deterministic tests. Live tests used the real deployed `convert.html` in desktop Chromium 154, with no recognition mocks and no upload/inference endpoint. Models were downloaded from the official Partsong host. The converter had no access to a reference MIDI during recognition.

## Original synthetic score

Generate with `python3 tests/fixtures/make_scale.py` (ReportLab and Noto Music required). Select the resulting one-page PDF in the converter at 100 BPM. Expected MIDI pitches: `60,62,64,65,67,69,71,72`; eight quarter notes, onsets `0,0.6,1.2,1.8,2.4,3.0,3.6,4.2` seconds, each 0.6 seconds long.

Observed live output: `60,60,64,66,67,69,71,72`. All eight note onsets and durations matched; six of eight pitches matched. This exposes real recognition errors, including a hallucinated key signature, and is why the feature stays experimental. Download produced a valid MIDI file, and **Use in instrument studio** restored its eight notes without autoplay. Pressing Play loaded the selected violin samples and showed active playback. No direct acoustic measurement was performed.

## Three-page piano score

A private user-provided PDF was selected locally; the source PDF and generated test output are deliberately not committed. At 120 BPM the real converter produced 519 notes in two staves/tracks, lasting 116 seconds. Comparing `(pitch, beat onset, beat duration)` multisets with the previously bundled piano-reference MIDI matched all 519 notes. This success on one clean score does not imply fidelity on other scores. All three pages were rendered and recognized independently; recognition logs showed actual segmentation/encoder/decoder inference (about a minute per page on this cloud machine).

## Flows checked

- Both independent PDFs went through the deployed PDF renderer, recognition worker, MusicXML parser, MIDI exporter, and studio import.
- Downloaded files were independently parsed with the vendored MIDI parser.
- A second recognition run was cancelled; the UI returned to a usable state with no result and no saved-MIDI change. A later check confirmed no stale worker callback replaced this state.
- Existing instrument, speed, and other studio settings survived converter handoff.
- Unsupported-browser messaging, invalid input, oversized files, invalid ranges, cancellation races, MusicXML timing/ties/chords/staves, and existing player/storage behavior are covered by 100 deterministic tests.
- Phone hardware, iOS, Safari, and Firefox were not available for end-to-end verification. Runtime feature detection disables unsupported browsers; API support is not a full compatibility guarantee. Recommend desktop Chrome/Edge and one page first.

## No-JSPI async bridge verification

The compatibility revision removes the Python `run_sync`/JavaScript `callPromising` dependency. In an isolated GitHub Pages test, the worker deleted `WebAssembly.Suspending`, `WebAssembly.promising`, and legacy `WebAssembly.Suspender` before loading any runtime. It used ONNX's plain WASM build, one WASM thread, no WebGPU, and no cross-origin isolation. Pyodide loaded with `enableRunUntilComplete: false`.

The original synthetic PDF was rendered at 2479 × 3508 pixels with real PDF.js. Real segmentation, encoder, and decoder inference completed in 41,549 ms and produced MusicXML that the actual parser converted to valid MIDI: 8 notes, 2 measures, 100 BPM, 4.8 seconds. Pitches were `60,60,64,66,67,69,71,72`, exactly the previous JSPI engine's output, including its known two pitch errors. No recognition model or score was mocked. The compatibility test was run in cloud desktop Chromium, with JSPI APIs absent; this is not a physical iPhone or WebKit test.

Deterministic tests cover unavailable-JSPI upload, ordinary awaited inference, model readiness, failure cleanup, GPU setup retry on WASM, and reproducible call-graph changes. Actual iPhone/iPad conversion, Safari/WebKit performance and mobile memory ceilings remain unverified. There is no browser-version gate or recommendation to upgrade to an unverified Safari version.
