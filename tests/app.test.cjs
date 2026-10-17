'use strict';

// Run: node --test tests/*.test.cjs
// Install jsdom as a dev dependency, or set NODE_PATH to an existing install.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
let JSDOM;
try {
  ({ JSDOM } = require('jsdom'));
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
  // Also support the isolated test dependency directory used by this workspace.
  ({ JSDOM } = require(path.join(__dirname, '../../.testdeps/node_modules/jsdom')));
}
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const appSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const midiSource = fs.readFileSync(path.join(root, 'vendor/midi.js'), 'utf8');
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'instruments.json'), 'utf8'));
const { Midi } = require('../vendor/midi.js');
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8,
  `Expected ${actual} to be approximately ${expected}`);
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture({ drums = true, empty = false, drumsOnly = false } = {}) {
  const midi = new Midi();
  midi.header.setTempo(120);
  if (!empty && !drumsOnly) {
    const melody = midi.addTrack();
    melody.name = 'Melody';
    melody.addNote({ midi: 60, time: 0, duration: 2, velocity: 0.8 });
    melody.addNote({ midi: 64, time: 1, duration: 1, velocity: 0.7 });
    melody.addNote({ midi: 67, time: 3, duration: 1, velocity: 0.6 });
    const harmony = midi.addTrack();
    harmony.channel = 1;
    harmony.name = 'Harmony';
    harmony.addNote({ midi: 48, time: 0, duration: 4, velocity: 0.5 });
  }
  if (!empty && drums) {
    const percussion = midi.addTrack();
    percussion.channel = 9;
    percussion.name = 'Drums';
    percussion.addNote({ midi: 36, time: 0, duration: 0.1 });
  }
  const bytes = midi.toArray();
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

async function harness(t, options = {}) {
  // No resource loading: all network and audio surfaces are deterministic mocks.
  const dom = new JSDOM(html, { url: 'https://medici.example/', runScripts: 'outside-only' });
  const w = dom.window;
  const errors = [], noteCalls = [], instrumentCalls = [], contexts = [], fetchCalls = [];
  const waits = new Map(), players = new Map(), timers = new Map();
  let now = 0, nextTimer = 1;
  const addTimer = (fn, delay, interval) => {
    const id = nextTimer++;
    timers.set(id, { fn, at: now + Number(delay || 0), interval });
    return id;
  };
  w.setTimeout = (fn, delay) => addTimer(fn, delay, 0);
  w.setInterval = (fn, delay) => addTimer(fn, delay, Number(delay || 1));
  w.clearTimeout = w.clearInterval = id => timers.delete(id);
  function advance(milliseconds) {
    const target = now + milliseconds;
    let count = 0;
    while (true) {
      const entry = [...timers.entries()].filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!entry) break;
      assert.ok(++count < 10000, 'Unexpected timer loop');
      const [id, timer] = entry;
      now = timer.at;
      contexts.forEach(context => { context.currentTime = now / 1000; });
      if (timer.interval) timer.at += timer.interval;
      else timers.delete(id);
      timer.fn();
    }
    now = target;
    contexts.forEach(context => { context.currentTime = now / 1000; });
  }
  class MockAudioContext {
    constructor() {
      this.currentTime = now / 1000;
      this.destination = {};
      this.resumes = 0;
      contexts.push(this);
    }
    resume() { this.resumes++; return Promise.resolve(); }
    createGain() {
      return {
        destination: null,
        connect(destination) { this.destination = destination; },
        gain: { value: 1, changes: [], setTargetAtTime(value, at, constant) {
          this.value = value;
          this.changes.push({ value, at, constant });
        } },
      };
    }
  }
  const playerFor = name => {
    if (!players.has(name)) players.set(name, { play(pitch, when, settings) {
      const node = { stopped: false, stops: 0, stop() { this.stopped = true; this.stops++; } };
      noteCalls.push({ instrument: name, pitch, when, settings, node });
      return options.missingSamples ? undefined : node;
    } });
    return players.get(name);
  };
  w.AudioContext = options.noAudio ? undefined : MockAudioContext;
  w.Soundfont = { instrument(context, name, settings) {
    instrumentCalls.push({ context, name, settings });
    return waits.has(name) ? waits.get(name).promise : Promise.resolve(playerFor(name));
  } };
  w.fetch = async url => {
    fetchCalls.push(url);
    if (options.catalogFailure) throw new Error('Catalog offline');
    return { ok: true, json: async () => catalog };
  };
  w.addEventListener('error', event => { errors.push(event.error || event.message); event.preventDefault(); });
  w.eval(midiSource + '\n//# sourceURL=vendor/midi.js');
  w.eval(appSource + '\n//# sourceURL=app.js');
  const get = id => w.document.getElementById(id);
  const change = (id, value, type = 'change') => {
    get(id).value = String(value);
    get(id).dispatchEvent(new w.Event(type, { bubbles: true }));
  };
  const upload = async (name, bytes = fixture(), read) => {
    const file = new w.File([bytes], name, { type: 'audio/midi' });
    Object.defineProperty(file, 'arrayBuffer', { value: async () => {
      const result = await (read ? read() : bytes);
      // Real File.arrayBuffer() returns a buffer in the browser realm. The
      // vendored parser uses instanceof ArrayBuffer, so mirror that accurately.
      return w.Uint8Array.from(new Uint8Array(result)).buffer;
    } });
    Object.defineProperty(get('midi-file'), 'files', { configurable: true, value: [file] });
    get('midi-file').dispatchEvent(new w.Event('change', { bubbles: true }));
    await flush();
    return file;
  };
  t.after(() => {
    w.dispatchEvent(new w.Event('pagehide'));
    w.close();
    assert.deepEqual(errors, [], 'The app should not raise uncaught DOM errors');
  });
  await flush();
  return {
    w, get, change, upload, advance, noteCalls, instrumentCalls, contexts, fetchCalls,
    click: id => get(id).click(),
    choose: name => w.document.querySelector(`[data-instrument="${name}"]`).click(),
    status: () => get('status').textContent,
    deferInstrument(name) { const wait = deferred(); waits.set(name, wait); return {
      resolve: () => { waits.delete(name); wait.resolve(playerFor(name)); },
      reject: error => { waits.delete(name); wait.reject(error); },
    }; },
  };
}

test('initial state loads the catalog and keeps transport disabled without MIDI', async t => {
  const h = await harness(t);
  assert.equal(catalog.length, 128);
  assert.equal(catalog.includes('percussion'), false);
  assert.equal(h.get('instrument-select').options.length, catalog.length);
  assert.equal(h.get('instrument-select').value, 'acoustic_grand_piano');
  for (const id of ['play', 'restart', 'loop', 'seek', 'track']) assert.equal(h.get(id).disabled, true);
  assert.equal(h.contexts.length, 0, 'Audio is not created before a gesture');
  assert.equal(h.instrumentCalls.length, 0, 'No samples are loaded on startup');
  assert.equal(h.w.document.querySelector('iframe'), null, 'YouTube is not loaded on startup');
  assert.deepEqual(h.fetchCalls, ['instruments.json']);
});

test('featured and dropdown instrument selection synchronize badges and selection', async t => {
  const h = await harness(t);
  h.choose('violin');
  assert.equal(h.get('instrument-select').value, 'violin');
  assert.equal(h.get('instrument-badge').textContent, 'VIOLIN');
  assert.equal(h.w.document.querySelector('[data-instrument="violin"]').getAttribute('aria-pressed'), 'true');
  assert.equal(h.w.document.querySelector('[data-instrument="acoustic_grand_piano"]').getAttribute('aria-pressed'), 'false');
  h.change('instrument-select', 'flute');
  assert.equal(h.get('instrument-badge').textContent, 'FLUTE');
  assert.equal(h.w.document.querySelectorAll('[data-instrument].selected').length, 0);
  assert.match(h.status(), /Flute selected/);
});

test('preview plays an explicitly labeled arpeggio and can be stopped', async t => {
  const h = await harness(t);
  h.choose('acoustic_guitar_nylon');
  h.click('preview');
  await flush();
  assert.deepEqual(h.noteCalls.map(call => call.pitch), [60, 64, 67, 72, 67, 64, 60]);
  assert.ok(h.noteCalls.every(call => call.instrument === 'acoustic_guitar_nylon'));
  assert.match(h.status(), /short C-major arpeggio, not “Love For Duty”/);
  assert.match(h.get('preview').textContent, /Stop preview/);
  near(h.noteCalls[0].settings.duration, 0.38);
  h.click('preview');
  assert.ok(h.noteCalls.every(call => call.node.stopped));
  assert.match(h.get('preview').textContent, /Preview sound/);
  assert.equal(h.status(), 'Preview stopped.');
  h.advance(4000);
  assert.equal(h.status(), 'Preview stopped.', 'Canceled preview must not later overwrite status');
});

test('preview ends automatically and reuses cached instrument samples', async t => {
  const h = await harness(t);
  h.click('preview'); await flush();
  h.advance(2700);
  assert.match(h.status(), /Preview finished/);
  assert.match(h.get('preview').textContent, /Preview sound/);
  h.click('preview'); await flush();
  assert.equal(h.instrumentCalls.length, 1);
  assert.equal(h.noteCalls.length, 14);
});

test('MIDI import exposes melodic parts, excludes drums, and enables transport', async t => {
  const h = await harness(t);
  await h.upload('My arrangement.mid');
  assert.equal(h.get('score-name').textContent, 'My arrangement');
  assert.equal(h.get('file-title').textContent, 'My arrangement.mid');
  assert.match(h.get('score-meta').textContent, /^4 notes · 2 melodic parts · 0:04$/);
  assert.equal(h.get('track').options.length, 3);
  assert.equal(h.get('seek').max, '4');
  assert.equal(h.get('total-time').textContent, '0:04');
  for (const id of ['play', 'restart', 'loop', 'seek', 'track']) assert.equal(h.get(id).disabled, false);
  assert.match(h.status(), /MIDI ready/);
  assert.deepEqual(h.fetchCalls, ['instruments.json'], 'MIDI contents are never uploaded');
  assert.equal(h.contexts.length, 0);
});

test('track selection plays only the selected melodic part', async t => {
  const h = await harness(t);
  await h.upload('parts.midi');
  h.change('track', '1');
  assert.match(h.get('score-meta').textContent, /^1 notes · 1 melodic part · 0:04$/);
  h.click('play'); await flush();
  assert.deepEqual(h.noteCalls.map(call => call.pitch), [48]);
  h.advance(1500);
  assert.deepEqual(h.noteCalls.map(call => call.pitch), [48]);
});

test('play, pause, and resume retain position and stop previously scheduled notes', async t => {
  const h = await harness(t);
  await h.upload('transport.mid');
  h.click('play'); await flush();
  assert.equal(h.get('play-text').textContent, 'Pause');
  assert.deepEqual(h.noteCalls.map(call => call.pitch), [60, 48]);
  h.advance(1250);
  h.click('play');
  assert.equal(h.get('play-text').textContent, 'Play arrangement');
  assert.equal(h.get('current-time').textContent, '0:01');
  near(Number(h.get('seek').value), 1.25);
  assert.ok(h.noteCalls.every(call => call.node.stopped));
  const previousCount = h.noteCalls.length;
  h.advance(1000);
  near(Number(h.get('seek').value), 1.25);
  h.click('play'); await flush();
  assert.equal(h.instrumentCalls.length, 1);
  assert.equal(h.get('play-text').textContent, 'Pause');
  const resumed = h.noteCalls.slice(previousCount);
  assert.deepEqual(resumed.map(call => call.pitch), [60, 48, 64]);
  near(resumed.find(call => call.pitch === 60).settings.duration, 0.75);
  near(resumed.find(call => call.pitch === 48).settings.duration, 2.75);
});

test('seek resumes currently sustained notes with their remaining durations', async t => {
  const h = await harness(t);
  await h.upload('seek.mid');
  h.change('seek', 2.5, 'input');
  h.change('seek', 2.5, 'change');
  near(Number(h.get('seek').value), 2.5);
  h.click('play'); await flush();
  assert.deepEqual(h.noteCalls.map(call => call.pitch), [48]);
  near(h.noteCalls[0].settings.duration, 1.5);
  h.change('seek', 3.5, 'input');
  h.change('seek', 3.5, 'change'); await flush();
  assert.equal(h.noteCalls[0].node.stopped, true);
  assert.deepEqual(h.noteCalls.slice(1).map(call => call.pitch), [48, 67]);
  h.noteCalls.slice(1).forEach(call => near(call.settings.duration, 0.5));
});

test('restart, speed, transpose, and volume update playback correctly', async t => {
  const h = await harness(t);
  await h.upload('settings.mid');
  h.change('speed', 0.5, 'input');
  h.change('transpose', 12);
  h.change('volume', 30, 'input');
  h.click('play'); await flush();
  assert.equal(h.get('speed-value').textContent, '0.50×');
  assert.equal(h.get('volume-value').textContent, '30%');
  assert.deepEqual(h.noteCalls.map(call => call.pitch), [72, 60]);
  near(h.noteCalls[0].settings.duration, 4);
  near(h.instrumentCalls[0].settings.destination.gain.value, 0.3 * 0.65);
  h.advance(1000);
  h.click('play');
  near(Number(h.get('seek').value), 0.5);
  h.change('volume', 50, 'input');
  near(h.instrumentCalls[0].settings.destination.gain.changes.at(-1).value, 0.5 * 0.65);
  h.click('restart');
  near(Number(h.get('seek').value), 0);
  assert.equal(h.status(), 'Back at the beginning.');
});

test('natural finish resets transport and loop restarts the arrangement', async t => {
  const h = await harness(t);
  await h.upload('loop.mid');
  h.click('play'); await flush();
  h.advance(4050);
  assert.equal(h.get('play-text').textContent, 'Play arrangement');
  assert.match(h.status(), /Arrangement finished/);
  near(Number(h.get('seek').value), 0);
  h.click('loop');
  assert.equal(h.get('loop').getAttribute('aria-pressed'), 'true');
  h.click('play'); await flush();
  const before = h.noteCalls.length;
  h.advance(4050); await flush();
  assert.equal(h.get('play-text').textContent, 'Pause');
  assert.ok(h.noteCalls.length > before);
  h.click('loop');
  assert.equal(h.get('loop').getAttribute('aria-pressed'), 'false');
});

test('invalid extension, malformed, empty, and drum-only files show useful errors', async t => {
  const h = await harness(t);
  await h.upload('recording.mp3');
  assert.match(h.status(), /Choose a \.mid or \.midi file/);
  await h.upload('broken.mid', Uint8Array.from([1, 2, 3]).buffer);
  assert.match(h.status(), /Couldn’t import this MIDI/);
  assert.match(h.status(), /Bad MIDI file/);
  await h.upload('empty.mid', fixture({ empty: true }));
  assert.match(h.status(), /no melodic notes/);
  await h.upload('drums.mid', fixture({ drumsOnly: true }));
  assert.match(h.status(), /no melodic notes/);
  assert.equal(h.get('status').classList.contains('error'), true);
  assert.equal(h.get('play').disabled, true);
  assert.equal(h.get('score-name').textContent, 'No MIDI loaded');
});

test('oversized input is rejected before reading file bytes', async t => {
  const h = await harness(t);
  let read = false;
  await h.upload('too-big.mid', new ArrayBuffer(5 * 1024 * 1024 + 1), () => {
    read = true;
    return Promise.resolve(fixture());
  });
  assert.equal(read, false);
  assert.match(h.status(), /too large/);
});

test('failed import preserves the previous arrangement and valid reimport clears the error', async t => {
  const h = await harness(t);
  await h.upload('first.mid');
  h.click('play'); await flush();
  await h.upload('bad.mid', Uint8Array.from([0]).buffer);
  assert.equal(h.get('score-name').textContent, 'first');
  assert.equal(h.get('play').disabled, false);
  assert.equal(h.get('play-text').textContent, 'Play arrangement');
  assert.ok(h.noteCalls.every(call => call.node.stopped));
  await h.upload('second.mid');
  assert.equal(h.get('score-name').textContent, 'second');
  assert.equal(h.get('status').classList.contains('error'), false);
  assert.match(h.status(), /MIDI ready/);
});

test('latest import wins when an earlier file read resolves later', async t => {
  const h = await harness(t);
  const oldRead = deferred();
  await h.upload('old.mid', fixture(), () => oldRead.promise);
  await h.upload('new.mid');
  oldRead.resolve(fixture({ drums: false })); await flush();
  assert.equal(h.get('score-name').textContent, 'new');
  assert.match(h.status(), /MIDI ready/);
});

test('a stale failed file read cannot overwrite a newer successful import status', async t => {
  const h = await harness(t);
  const oldRead = deferred();
  await h.upload('old.mid', fixture(), () => oldRead.promise);
  await h.upload('new.mid');
  oldRead.reject(new Error('Old file read failed')); await flush();
  assert.equal(h.get('score-name').textContent, 'new');
  assert.match(h.status(), /MIDI ready/);
  assert.equal(h.get('status').classList.contains('error'), false);
});

test('switching instrument during preview loading prevents stale audio', async t => {
  const h = await harness(t);
  const oldLoad = h.deferInstrument('acoustic_grand_piano');
  h.click('preview'); await flush();
  h.choose('violin');
  h.click('preview'); await flush();
  assert.equal(h.noteCalls.length, 7);
  assert.ok(h.noteCalls.every(call => call.instrument === 'violin'));
  oldLoad.resolve(); await flush();
  assert.equal(h.noteCalls.length, 7);
  assert.match(h.status(), /Previewing violin/);
});

test('switching during arrangement loading cancels the stale player', async t => {
  const h = await harness(t);
  await h.upload('race.mid');
  const oldLoad = h.deferInstrument('acoustic_grand_piano');
  h.click('play'); await flush();
  assert.equal(h.get('play').disabled, true);
  assert.equal(h.get('play-text').textContent, 'Loading instrument…');
  h.choose('cello');
  assert.equal(h.get('play').disabled, true);
  await flush();
  assert.equal(h.get('play-text').textContent, 'Pause');
  assert.ok(h.noteCalls.length > 0);
  assert.ok(h.noteCalls.every(call => call.instrument === 'cello'));
  const count = h.noteCalls.length;
  oldLoad.resolve(); await flush();
  assert.equal(h.noteCalls.length, count);
  assert.match(h.status(), /Playing cello/);
});

test('switching instrument while playing resumes at the same position', async t => {
  const h = await harness(t);
  await h.upload('switch.mid');
  h.click('play'); await flush();
  h.advance(1500);
  h.choose('violin'); await flush();
  assert.equal(h.get('play-text').textContent, 'Pause');
  near(Number(h.get('seek').value), 1.5);
  assert.ok(h.noteCalls.filter(call => call.instrument === 'acoustic_grand_piano').every(call => call.node.stopped));
  const violin = h.noteCalls.filter(call => call.instrument === 'violin');
  assert.deepEqual(violin.map(call => call.pitch), [60, 48, 64]);
  near(violin.find(call => call.pitch === 60).settings.duration, 0.5);
});

test('changing speed while a preview is loading resets preview UI and cancels audio', async t => {
  const h = await harness(t);
  const load = h.deferInstrument('acoustic_grand_piano');
  h.click('preview'); await flush();
  h.change('speed', 0.75, 'input');
  load.resolve(); await flush();
  assert.equal(h.noteCalls.length, 0);
  assert.match(h.get('preview').textContent, /Preview sound/);
  h.click('preview'); await flush();
  assert.equal(h.noteCalls.length, 7, 'The next preview click should start, not merely reset');
});

test('sample-load failure is recoverable and failed cache entries are retried', async t => {
  const h = await harness(t);
  await h.upload('retry.mid');
  const load = h.deferInstrument('acoustic_grand_piano');
  h.click('play'); await flush();
  load.reject(new Error('Network unavailable')); await flush();
  assert.equal(h.get('play').disabled, false);
  assert.match(h.status(), /Couldn’t load instrument samples/);
  assert.equal(h.get('status').classList.contains('error'), true);
  h.click('play'); await flush();
  assert.equal(h.instrumentCalls.length, 2);
  assert.equal(h.get('play-text').textContent, 'Pause');
  assert.equal(h.get('status').classList.contains('error'), false);
});

test('catalog failure retains working featured instruments', async t => {
  const h = await harness(t, { catalogFailure: true });
  assert.match(h.status(), /full instrument list could not load/);
  h.choose('cello');
  h.click('preview'); await flush();
  assert.equal(h.noteCalls.length, 7);
  assert.ok(h.noteCalls.every(call => call.instrument === 'cello'));
});

test('missing Web Audio shows a recoverable error instead of an uncaught exception', async t => {
  const h = await harness(t, { noAudio: true });
  h.click('preview'); await flush();
  assert.match(h.status(), /Couldn’t load instrument samples/);
  assert.match(h.get('preview').textContent, /Preview sound/);
  assert.equal(h.noteCalls.length, 0);
});

test('opening the official recording stops arrangement playback and lazily creates the player', async t => {
  const h = await harness(t);
  await h.upload('original.mid');
  h.click('play'); await flush();
  h.click('load-video');
  assert.ok(h.noteCalls.every(call => call.node.stopped));
  assert.equal(h.get('play-text').textContent, 'Play arrangement');
  const frame = h.w.document.querySelector('iframe');
  assert.ok(frame);
  assert.match(frame.src, /^https:\/\/www\.youtube-nocookie\.com\/embed\/Y3zOQWJReJU\?/);
  assert.equal(h.get('video-placeholder').hidden, true);
  assert.ok(h.w.document.querySelector('script[src="https://www.youtube.com/iframe_api"]'));
});


test('dragging seek through multiple positions resumes once at the final position', async t => {
  const h = await harness(t);
  await h.upload('drag.mid');
  h.click('play'); await flush();
  h.get('seek').dispatchEvent(new h.w.Event('pointerdown'));
  h.change('seek', 0.7, 'input');
  h.change('seek', 1.8, 'input');
  h.change('seek', 2.5, 'input');
  assert.equal(h.get('play-text').textContent, 'Play arrangement');
  const before = h.noteCalls.length;
  h.get('seek').dispatchEvent(new h.w.Event('pointerup'));
  h.change('seek', 2.5, 'change'); await flush();
  assert.equal(h.get('play-text').textContent, 'Pause');
  near(Number(h.get('seek').value), 2.5);
  assert.deepEqual(h.noteCalls.slice(before).map(call => call.pitch), [48]);
  near(h.noteCalls.at(-1).settings.duration, 1.5);
});

test('rapid speed and transpose changes retain pending playback intent', async t => {
  const h = await harness(t);
  await h.upload('pending.mid');
  const load = h.deferInstrument('acoustic_grand_piano');
  h.click('play'); await flush();
  h.change('speed', 0.5, 'input');
  h.change('speed', 1.5, 'input');
  h.change('transpose', -12);
  await flush();
  load.resolve(); await flush();
  assert.equal(h.get('play-text').textContent, 'Pause');
  assert.deepEqual(h.noteCalls.map(call => call.pitch), [48, 36]);
  near(h.noteCalls[0].settings.duration, 2 / 1.5);
  assert.equal(h.instrumentCalls.length, 1);
});

test('MIDI extremes use the nearest available sample with pitch-correcting cents', async t => {
  const h = await harness(t);
  const score = new Midi();
  score.header.setTempo(120);
  const part = score.addTrack();
  part.addNote({ midi: 0, time: 0, duration: 1 });
  part.addNote({ midi: 127, time: 0, duration: 1 });
  const bytes = score.toArray();
  await h.upload('extremes.mid', bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  h.click('play'); await flush();
  assert.deepEqual(h.noteCalls.map(call => call.pitch), [21, 108]);
  assert.deepEqual(h.noteCalls.map(call => call.settings.cents), [-2100, 1900]);
  h.click('play');
  h.change('transpose', 12);
  h.click('restart');
  const count = h.noteCalls.length;
  h.click('play'); await flush();
  assert.equal(h.noteCalls.length, count + 1, 'Transposed pitches above MIDI 127 are safely skipped');
  assert.equal(h.noteCalls.at(-1).pitch, 21);
  assert.equal(h.noteCalls.at(-1).settings.cents, -900);
});

test('a missing sample node does not break preview or transport cleanup', async t => {
  const h = await harness(t, { missingSamples: true });
  h.click('preview'); await flush();
  assert.equal(h.noteCalls.length, 7);
  h.click('preview');
  assert.equal(h.status(), 'Preview stopped.');
  await h.upload('missing-sample.mid');
  h.click('play'); await flush();
  h.click('play');
  assert.equal(h.status(), 'Paused.');
});

for (const action of ['restart', 'seek']) {
  test(`${action} cancels a pending preview and restores its button`, async t => {
    const h = await harness(t);
    await h.upload('preview-interaction.mid');
    const load = h.deferInstrument('acoustic_grand_piano');
    h.click('preview'); await flush();
    if (action === 'restart') h.click('restart');
    else {
      h.change('seek', 1, 'input');
      h.change('seek', 1, 'change');
    }
    load.resolve(); await flush();
    assert.equal(h.noteCalls.length, 0);
    assert.match(h.get('preview').textContent, /Preview sound/);
    h.click('preview'); await flush();
    assert.equal(h.noteCalls.length, 7);
  });
}

test('drag-and-drop imports uppercase MIDI extensions locally', async t => {
  const h = await harness(t);
  const bytes = fixture();
  const file = new h.w.File([bytes], 'Dropped.MIDI', { type: 'audio/midi' });
  Object.defineProperty(file, 'arrayBuffer', { value: async () => h.w.Uint8Array.from(new Uint8Array(bytes)).buffer });
  const enter = new h.w.Event('dragenter', { bubbles: true, cancelable: true });
  h.get('file-zone').dispatchEvent(enter);
  assert.equal(enter.defaultPrevented, true);
  assert.equal(h.get('file-zone').classList.contains('dragging'), true);
  const drop = new h.w.Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(drop, 'dataTransfer', { value: { files: [file] } });
  h.get('file-zone').dispatchEvent(drop);
  await flush();
  assert.equal(drop.defaultPrevented, true);
  assert.equal(h.get('file-zone').classList.contains('dragging'), false);
  assert.equal(h.get('score-name').textContent, 'Dropped');
  assert.match(h.status(), /MIDI ready/);
  assert.deepEqual(h.fetchCalls, ['instruments.json']);
});

test('an arrangement longer than two hours is rejected without replacing valid content', async t => {
  const h = await harness(t);
  await h.upload('valid.mid');
  const score = new Midi();
  score.header.setTempo(120);
  score.addTrack().addNote({ midi: 60, time: 0, duration: 7201 });
  const bytes = score.toArray();
  await h.upload('too-long.mid', bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  assert.match(h.status(), /shorter than two hours/);
  assert.equal(h.get('score-name').textContent, 'valid');
  assert.equal(h.get('play').disabled, false);
});
