# Sheet Music Studio source and third-party notices

The Sheet Music Studio application code is distributed under GNU Affero General Public License version 3 (AGPL-3.0). See LICENSE. This licensing choice does not grant rights to the music, recordings, fonts, or instrument samples: they retain their separate copyrights and licenses.

Complete application source: https://github.com/Eduard20/medici

## Optical music recognition

- Partsong © 2026 Paul Fremantle, AGPL-3.0. Source pinned to commit `18b38f2602ec5a4cf6230ebee391595a4d18d9fd`: https://github.com/pzfreo/partsong/tree/18b38f2602ec5a4cf6230ebee391595a4d18d9fd . Adapted `omr-worker.js`, `omr/onnxruntime.py`, and `omr/runner.py`. License: vendor/partsong-LICENSE.
- Sheet Music Studio modifications (2026-10-17): integrated PDF upload and recognition UI; bounded sequential PDF rendering; MusicXML-to-MIDI export; progress/cancellation; on-demand cross-origin model fetching with SHA-256 verification; browser-storage fallback; input-file cleanup; automatic private save and playable-score handoff, searchable visual instrument picker. The browser bridge uses async Python model calls without JSPI. `scripts/build_async_homr.py` reproducibly builds `vendor/homr-async.zip` from the unchanged pinned archive by converting the named inference call chain to async/await. All modifications are in this repository.
- homr contributors, AGPL-3.0. Source pinned to `863eb3c6487f3c6fe50267fb71613f05162bb7c5`: https://github.com/liebharc/homr/tree/863eb3c6487f3c6fe50267fb71613f05162bb7c5 . `vendor/homr.zip` is an unmodified archive of the `homr/` Python package and LICENSE from that commit (excluding model/cache files). License: vendor/homr-LICENSE. Full corresponding source, build scripts, and model documentation are in the linked upstream commit.
- The three homr ONNX models are downloaded, never committed here, from the official Partsong GitHub Pages host (`https://partsong.app/models/`). They are published upstream under AGPL-3.0 and are integrity-checked against the official homr `onnx_checkpoints` release: https://github.com/liebharc/homr/releases/tag/onnx_checkpoints . Each filename includes its upstream checkpoint identifier. Expected sizes and SHA-256 hashes are in `omr-worker.js`.
- Model training-data caveat: homr's FAQ notes unresolved questions about noncommercial training-data terms and model weights. No commercial clearance is claimed. See vendor/homr-LICENSE-FAQ.md, retrieved 2026-10-17 from https://github.com/liebharc/homr/blob/main/LICENSE_FAQ.md . This is a noncommercial experiment.
- Pyodide v314.0.7, MPL-2.0, https://github.com/pyodide/pyodide ; includes NumPy (BSD-3-Clause), OpenCV (Apache-2.0), Pillow (MIT-CMU), typing-extensions (PSF-2.0). Downloaded on demand from the official versioned Pyodide distribution on jsDelivr. Source/builds: https://github.com/pyodide/pyodide (see the versioned distribution metadata for exact package versions).
- ONNX Runtime Web 1.30.0, Microsoft and contributors, MIT: https://github.com/microsoft/onnxruntime/blob/main/LICENSE . Downloaded on demand from jsDelivr's versioned npm distribution.
- PDF.js 6.4.299, Mozilla Foundation and contributors, Apache-2.0: https://github.com/mozilla/pdf.js/blob/master/LICENSE . Downloaded on demand from jsDelivr's versioned npm distribution.

## Existing player and assets

- @tonejs/midi 2.0.28: MIT, vendor/midi-LICENSE.
- soundfont-player 0.12.0: MIT, vendor/soundfont-player-LICENSE.
- FluidR3_GM instrument samples by Frank Wen and contributors: CC BY 3.0, hosted by https://github.com/gleitz/midi-js-soundfonts . Loaded on demand from gleitz.github.io.
- Google Fonts: DM Sans and Playfair Display retain their open-font licenses.
