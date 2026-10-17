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
const { createStorage } = require('./storage-mock.cjs');
const DEMO_URL = 'assets/two-chord-demo.mid';
const LOVE_URL = 'assets/love-for-duty-piano.mid';
const LOVE_TITLE = 'Love for Duty · piano score';
const bundledLove = () => {
  const bytes = fs.readFileSync(path.join(root, LOVE_URL));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
};
const bundledDemo = () => {
  const bytes = fs.readFileSync(path.join(root, DEMO_URL));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
};
const flush = async () => { for (let i = 0; i < 64; i++) await Promise.resolve(); };
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
  const storage = options.storage || createStorage();
  storage.install(w, { unavailable: options.noStorage, localUnavailable: options.noLocalStorage });
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
  const demo = { read: options.demoRead, failure: options.demoFailure, ok: options.demoOk !== false };
  const love = { read: options.loveRead, failure: options.loveFailure, ok: options.loveOk !== false };
  w.fetch = async url => {
    fetchCalls.push(url);
    if (url === 'instruments.json') {
      if (options.catalogFailure) throw new Error('Catalog offline');
      return { ok: true, json: async () => catalog };
    }
    if (url === DEMO_URL || url === LOVE_URL) {
      const score = url === DEMO_URL ? demo : love;
      if (score.failure) throw new Error('Arrangement download failed');
      return { ok: score.ok, arrayBuffer: async () => {
        const bytes = await (score.read ? score.read() : url === DEMO_URL ? bundledDemo() : bundledLove());
        return w.Uint8Array.from(new Uint8Array(bytes)).buffer;
      } };
    }
    throw new Error(`Unexpected network request: ${url}`);
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
    w, get, change, upload, advance, noteCalls, instrumentCalls, contexts, fetchCalls, storage, demo, love,
    click: id => get(id).click(),
    choose: name => w.document.querySelector(`[data-instrument="${name}"]`).click(),
    status: () => get('status').textContent,
    deferInstrument(name) { const wait = deferred(); waits.set(name, wait); return {
      resolve: () => { waits.delete(name); wait.resolve(playerFor(name)); },
      reject: error => { waits.delete(name); wait.reject(error); },
    }; },
  };
}

test('initial state loads the catalog and included piano score without starting audio', async t => {
  const h = await harness(t);
  assert.equal(catalog.length, 128);
  assert.equal(catalog.includes('percussion'), false);
  assert.equal(h.get('instrument-select').options.length, catalog.length);
  assert.equal(h.get('instrument-select').value, 'acoustic_grand_piano');
  for (const id of ['play', 'restart', 'loop', 'seek', 'track']) assert.equal(h.get(id).disabled, false);
  assert.equal(h.contexts.length, 0, 'Audio is not created before a gesture');
  assert.equal(h.instrumentCalls.length, 0, 'No samples are loaded on startup');
  assert.equal(h.w.document.querySelector('iframe'), null, 'YouTube is not loaded on startup');
  assert.deepEqual(h.fetchCalls, ['instruments.json', LOVE_URL]);
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
  assert.deepEqual(h.fetchCalls, ['instruments.json', LOVE_URL], 'Imported MIDI contents are never uploaded');
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
  assert.equal(h.get('play').disabled, false);
  assert.equal(h.get('score-name').textContent, LOVE_TITLE);
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
  assert.equal(h.get('instrument-select').options.length, 4);
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
  assert.match(frame.src, /^https:\/\/www\.youtube-nocookie\.com\/embed\/QVOhsRnkLZA\?/);
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
  assert.deepEqual(h.fetchCalls, ['instruments.json', LOVE_URL]);
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

const DB_NAME = 'medici-listening-room';
const STORE_NAME = 'local';
const savedArrangement = (name = 'Saved arrangement.mid', bytes = fixture()) => ({ version: 1, name, bytes });
const savedPreferences = overrides => ({
  version: 1, instrument: 'cello', speed: 1.25, transpose: -2, volume: 45, loop: true, ...overrides,
});
const storageValue = (storage, key) => storage.records().find(record =>
  record.database === DB_NAME && record.store === STORE_NAME && record.key === key)?.value;
function seededStorage(entries) {
  return createStorage().seed(DB_NAME, STORE_NAME, Object.entries(entries));
}
const storageText = h => h.get('storage-status').textContent;

test('import saves the original MIDI bytes in browser storage without transmitting them', async t => {
  const h = await harness(t);
  const bytes = fixture();
  await h.upload('Keep this.mid', bytes);
  await flush();
  const saved = storageValue(h.storage, 'arrangement');
  assert.ok(saved, 'A valid import should create a persisted arrangement');
  assert.equal(saved.version, 1);
  assert.equal(saved.name, 'Keep this.mid');
  assert.deepEqual(new Uint8Array(saved.bytes), new Uint8Array(bytes));
  assert.match(storageText(h), /saved|remembered|stored/i);
  assert.equal(h.get('clear-midi').hidden, false);
  assert.deepEqual(h.fetchCalls, ['instruments.json', LOVE_URL]);
});

test('reloading restores a saved MIDI at the beginning without autoplay or sample downloads', async t => {
  const first = await harness(t);
  await first.upload('Returning.mid');
  first.click('play'); await flush();
  first.advance(1250);
  first.click('play');
  const second = await harness(t, { storage: first.storage });
  assert.equal(second.get('score-name').textContent, 'Returning');
  assert.equal(second.get('play').disabled, false);
  assert.equal(second.get('play-text').textContent, 'Play arrangement');
  assert.equal(second.get('current-time').textContent, '0:00');
  near(Number(second.get('seek').value), 0);
  assert.equal(second.contexts.length, 0);
  assert.equal(second.noteCalls.length, 0);
  assert.equal(second.instrumentCalls.length, 0);
  assert.equal(second.w.document.querySelector('iframe'), null);
  assert.match(storageText(second), /restor|saved|browser/i);
  assert.deepEqual(second.fetchCalls, ['instruments.json']);
});

test('saved instrument and playback preferences restore all visible controls without autoplay', async t => {
  const storage = seededStorage({
    arrangement: savedArrangement(),
    preferences: savedPreferences(),
  });
  const h = await harness(t, { storage });
  assert.equal(h.get('instrument-select').value, 'cello');
  assert.equal(h.get('instrument-badge').textContent, 'CELLO');
  assert.equal(h.w.document.querySelector('[data-instrument="cello"]').getAttribute('aria-pressed'), 'true');
  assert.equal(h.get('speed').value, '1.25');
  assert.equal(h.get('speed-value').textContent, '1.25×');
  assert.equal(h.get('transpose').value, '-2');
  assert.equal(h.get('volume').value, '45');
  assert.equal(h.get('volume-value').textContent, '45%');
  assert.equal(h.get('loop').getAttribute('aria-pressed'), 'true');
  assert.equal(h.contexts.length, 0);
  assert.equal(h.instrumentCalls.length, 0);
  assert.equal(h.get('play-text').textContent, 'Play arrangement');
});

test('changed preferences are persisted and survive the next visit', async t => {
  const first = await harness(t);
  await first.upload('Preferences.mid');
  first.choose('violin');
  first.change('speed', 0.75, 'input');
  first.change('transpose', 7);
  first.change('volume', 32, 'input');
  first.click('loop');
  first.advance(251);
  await flush();
  const second = await harness(t, { storage: first.storage });
  assert.equal(second.get('instrument-select').value, 'violin');
  assert.equal(second.get('speed').value, '0.75');
  assert.equal(second.get('transpose').value, '7');
  assert.equal(second.get('volume').value, '32');
  assert.equal(second.get('loop').getAttribute('aria-pressed'), 'true');
  assert.equal(second.instrumentCalls.length, 0);
});

test('invalid stored preferences cannot select an unknown instrument or unsafe control values', async t => {
  const storage = seededStorage({ preferences: savedPreferences({
    instrument: '../unknown-instrument', speed: -99, transpose: 9000, volume: 9000, loop: 'true',
  }) });
  const h = await harness(t, { storage });
  assert.ok(catalog.includes(h.get('instrument-select').value));
  assert.ok(Number(h.get('speed').value) >= 0.5 && Number(h.get('speed').value) <= 1.5);
  assert.ok([...h.get('transpose').options].some(option => option.value === h.get('transpose').value));
  assert.ok(Number(h.get('volume').value) >= 0 && Number(h.get('volume').value) <= 100);
  assert.equal(h.get('loop').getAttribute('aria-pressed'), 'false');
  assert.equal(h.contexts.length, 0);
});

test('unavailable IndexedDB does not prevent a fresh MIDI from playing', async t => {
  const h = await harness(t, { noStorage: true });
  await h.upload('Temporary.mid');
  assert.equal(h.get('score-name').textContent, 'Temporary');
  assert.equal(h.get('play').disabled, false);
  assert.match(storageText(h), /unavailable|couldn.t|cannot|can.t|not saved/i);
  h.click('play'); await flush();
  assert.equal(h.get('play-text').textContent, 'Pause');
  assert.ok(h.noteCalls.length > 0);
});

test('denied database opening is reported without breaking import or preview', async t => {
  const storage = createStorage();
  storage.failAlways('open', 'SecurityError');
  const h = await harness(t, { storage });
  await h.upload('Denied storage.mid');
  assert.equal(h.get('play').disabled, false);
  assert.equal(storageValue(storage, 'arrangement'), undefined);
  assert.match(storageText(h), /unavailable|couldn.t|cannot|can.t|not saved/i);
  h.click('preview'); await flush();
  assert.equal(h.noteCalls.length, 7);
});

test('quota failure keeps the new score playable and warns the previous saved score remains', async t => {
  const storage = seededStorage({ arrangement: savedArrangement('Old saved.mid') });
  const h = await harness(t, { storage });
  storage.failNext('write', 'QuotaExceededError');
  await h.upload('New temporary.mid');
  assert.equal(h.get('score-name').textContent, 'New temporary');
  assert.equal(h.get('play').disabled, false);
  assert.equal(storageValue(storage, 'arrangement').name, 'Old saved.mid');
  assert.match(storageText(h), /couldn.t|cannot|can.t|not saved/i);
  assert.match(storageText(h), /previous|old|earlier/i);
  h.click('play'); await flush();
  assert.equal(h.get('play-text').textContent, 'Pause');
  const nextVisit = await harness(t, { storage });
  assert.equal(nextVisit.get('score-name').textContent, 'Old saved');
});

test('corrupt saved MIDI is rejected, can be removed, and does not autoplay', async t => {
  const storage = seededStorage({ arrangement: savedArrangement('Corrupt.mid', Uint8Array.from([1, 2, 3]).buffer) });
  const h = await harness(t, { storage });
  assert.equal(h.get('play').disabled, true);
  assert.equal(h.get('score-name').textContent, 'No MIDI loaded');
  assert.equal(h.contexts.length, 0);
  assert.equal(h.get('clear-midi').hidden, false);
  assert.match(storageText(h), /couldn.t|cannot|can.t|invalid|corrupt/i);
  h.click('clear-midi'); await flush();
  assert.equal(storageValue(storage, 'arrangement'), undefined);
  await h.upload('Recovered.mid');
  assert.equal(h.get('score-name').textContent, 'Recovered');
  assert.equal(h.get('play').disabled, false);
});

test('clear stops playback, removes only the saved MIDI, and prevents later restore', async t => {
  const storage = seededStorage({ arrangement: savedArrangement(), preferences: savedPreferences() });
  const h = await harness(t, { storage });
  h.click('play'); await flush();
  assert.ok(h.noteCalls.length > 0);
  h.click('clear-midi'); await flush();
  assert.ok(h.noteCalls.every(call => call.node.stopped));
  assert.equal(h.get('score-name').textContent, 'No MIDI loaded');
  assert.equal(h.get('play').disabled, true);
  assert.equal(h.get('track').disabled, true);
  assert.equal(h.get('clear-midi').hidden, true);
  assert.equal(storageValue(storage, 'arrangement'), undefined);
  assert.equal(storageValue(storage, 'preferences').instrument, 'cello');
  const nextVisit = await harness(t, { storage });
  assert.equal(nextVisit.get('score-name').textContent, LOVE_TITLE);
  assert.equal(nextVisit.get('instrument-select').value, 'cello');
  assert.equal(nextVisit.noteCalls.length, 0);
});

test('failed deletion is explicit and can be retried instead of falsely claiming removal', async t => {
  const storage = seededStorage({ arrangement: savedArrangement() });
  const h = await harness(t, { storage });
  storage.failNext('delete', 'UnknownError');
  h.click('clear-midi'); await flush();
  assert.equal(h.get('score-name').textContent, 'No MIDI loaded');
  assert.equal(h.get('play').disabled, true);
  assert.ok(storageValue(storage, 'arrangement'));
  assert.equal(h.get('clear-midi').hidden, false);
  assert.match(storageText(h), /couldn.t|cannot|can.t|failed|not removed/i);
  h.click('clear-midi'); await flush();
  assert.equal(storageValue(storage, 'arrangement'), undefined);
  assert.equal(h.get('clear-midi').hidden, true);
});

test('a new import wins over a delayed startup restore and is the file saved for next visit', async t => {
  const storage = seededStorage({ arrangement: savedArrangement('Old restore.mid') });
  const pending = storage.holdNext('read');
  const h = await harness(t, { storage });
  await pending.reached;
  await h.upload('New import.mid');
  assert.equal(h.get('score-name').textContent, 'New import');
  pending.release(); await flush();
  assert.equal(h.get('score-name').textContent, 'New import');
  assert.equal(storageValue(storage, 'arrangement').name, 'New import.mid');
  const nextVisit = await harness(t, { storage });
  assert.equal(nextVisit.get('score-name').textContent, 'New import');
});

test('user preference changes win over delayed preference restore', async t => {
  const storage = seededStorage({ preferences: savedPreferences() });
  const pending = storage.holdNext('read');
  const h = await harness(t, { storage });
  await pending.reached;
  h.choose('violin');
  h.change('speed', 0.75, 'input');
  h.change('volume', 20, 'input');
  h.advance(251);
  pending.release(); await flush();
  assert.equal(h.get('instrument-select').value, 'violin');
  assert.equal(h.get('speed').value, '0.75');
  assert.equal(h.get('volume').value, '20');
  const nextVisit = await harness(t, { storage });
  assert.equal(nextVisit.get('instrument-select').value, 'violin');
  assert.equal(nextVisit.get('speed').value, '0.75');
  assert.equal(nextVisit.get('volume').value, '20');
});

test('clear during a pending save cannot resurrect that MIDI after the save finishes', async t => {
  const h = await harness(t);
  const pending = h.storage.holdNext('write');
  await h.upload('Pending save.mid');
  await pending.reached;
  assert.equal(h.get('clear-midi').hidden, false);
  h.click('clear-midi');
  assert.equal(h.get('score-name').textContent, 'No MIDI loaded');
  pending.release(); await flush();
  assert.equal(h.get('score-name').textContent, 'No MIDI loaded');
  assert.equal(storageValue(h.storage, 'arrangement'), undefined);
  assert.equal(h.get('clear-midi').hidden, true);
  const nextVisit = await harness(t, { storage: h.storage });
  assert.equal(nextVisit.get('play').disabled, false);
  assert.equal(nextVisit.get('score-name').textContent, LOVE_TITLE);
});

test('import during pending clear remains visible and is saved after deletion', async t => {
  const storage = seededStorage({ arrangement: savedArrangement('Old before clear.mid') });
  const h = await harness(t, { storage });
  const pending = storage.holdNext('delete');
  h.click('clear-midi'); await flush();
  await pending.reached;
  await h.upload('New after clear.mid');
  assert.equal(h.get('score-name').textContent, 'New after clear');
  pending.release(); await flush();
  assert.equal(h.get('score-name').textContent, 'New after clear');
  assert.equal(h.get('play').disabled, false);
  assert.equal(h.get('clear-midi').hidden, false);
  assert.equal(storageValue(storage, 'arrangement').name, 'New after clear.mid');
  assert.match(storageText(h), /saved|remembered|stored/i);
});

test('the newest import remains saved when an earlier import write is delayed', async t => {
  const h = await harness(t);
  const pending = h.storage.holdNext('write');
  await h.upload('Earlier.mid');
  await pending.reached;
  await h.upload('Newest.mid');
  pending.release(); await flush();
  assert.equal(h.get('score-name').textContent, 'Newest');
  assert.equal(storageValue(h.storage, 'arrangement').name, 'Newest.mid');
});

test('a blocked database open times out while the imported MIDI stays usable', async t => {
  const storage = createStorage();
  const pending = storage.holdNext('open');
  const h = await harness(t, { storage });
  await pending.reached;
  await h.upload('Offline storage.mid');
  h.advance(8001); await flush();
  assert.equal(h.get('play').disabled, false);
  assert.match(storageText(h), /couldn.t|cannot|can.t|unavailable|timed? out|not saved/i);
  h.click('play'); await flush();
  assert.equal(h.get('play-text').textContent, 'Pause');
  pending.release(); await flush();
});

test('pagehide flushes pending preference changes before the debounce elapses', async t => {
  const first = await harness(t);
  first.choose('violin');
  first.change('volume', 28, 'input');
  assert.equal(storageValue(first.storage, 'preferences'), undefined);
  first.w.dispatchEvent(new first.w.Event('pagehide'));
  await flush();
  assert.equal(storageValue(first.storage, 'preferences').instrument, 'violin');
  assert.equal(storageValue(first.storage, 'preferences').volume, 28);
  const nextVisit = await harness(t, { storage: first.storage });
  assert.equal(nextVisit.get('instrument-select').value, 'violin');
  assert.equal(nextVisit.get('volume').value, '28');
  assert.equal(nextVisit.contexts.length, 0);
});

test('timed-out save is aborted and cannot replace the old saved MIDI later', async t => {
  const storage = seededStorage({ arrangement: savedArrangement('Preserved.mid') });
  const h = await harness(t, { storage });
  const pending = storage.holdNext('write');
  await h.upload('Timed out.mid');
  await pending.reached;
  h.advance(8001); await flush();
  assert.equal(h.get('score-name').textContent, 'Timed out');
  assert.equal(h.get('play').disabled, false);
  assert.match(storageText(h), /couldn.t|cannot|can.t|not saved/i);
  assert.equal(storageValue(storage, 'arrangement').name, 'Preserved.mid');
  pending.release(); await flush();
  assert.equal(storageValue(storage, 'arrangement').name, 'Preserved.mid');
  await h.upload('Retry succeeded.mid');
  assert.equal(storageValue(storage, 'arrangement').name, 'Retry succeeded.mid');
});

test('the bundled two-chord asset loads as a four-second demo and is never saved as user MIDI', async t => {
  const bytes = bundledDemo();
  const midi = new Midi(bytes);
  assert.equal(bytes.byteLength, 98);
  near(midi.duration, 4);
  assert.equal(midi.tracks.length, 1);
  assert.deepEqual(midi.tracks[0].notes.map(note => [note.midi, note.time, note.duration]), [
    [60, 0, 2], [64, 0, 2], [67, 0, 2], [57, 2, 2], [60, 2, 2], [64, 2, 2],
  ]);
  const h = await harness(t);
  h.click('load-demo'); await flush();
  assert.equal(h.get('score-name').textContent, 'Two-chord demo');
  assert.match(h.get('score-meta').textContent, /^6 notes · 1 melodic part · 0:04$/);
  assert.match(h.get('file-description').textContent, /not “Love For Duty”/);
  assert.equal(h.get('clear-midi').hidden, true);
  assert.equal(storageValue(h.storage, 'arrangement'), undefined);
  assert.equal(h.storage.operations.includes('write'), false);
  assert.equal(h.contexts.length, 0);
  h.click('play'); await flush();
  assert.deepEqual(h.noteCalls.map(call => call.pitch), [60, 64, 67]);
  assert.match(h.status(), /two-chord demo, not Love For Duty/);
  h.advance(2050);
  assert.deepEqual(h.noteCalls.map(call => call.pitch), [60, 64, 67, 57, 60, 64]);
});

test('a saved user MIDI takes precedence and prevents automatic bundled-score fetching', async t => {
  const storage = seededStorage({ arrangement: savedArrangement('User piece.mid') });
  const h = await harness(t, { storage });
  assert.equal(h.get('score-name').textContent, 'User piece');
  assert.deepEqual(h.fetchCalls, ['instruments.json']);
  assert.equal(h.contexts.length, 0);
  assert.equal(h.get('clear-midi').hidden, false);
});

test('explicit demo selection preserves the user MIDI and the next reload restores it', async t => {
  const storage = seededStorage({ arrangement: savedArrangement('Keep my piece.mid') });
  const h = await harness(t, { storage });
  h.click('play'); await flush();
  h.click('load-demo'); await flush();
  assert.ok(h.noteCalls.every(call => call.node.stopped));
  assert.equal(h.get('score-name').textContent, 'Two-chord demo');
  assert.equal(h.get('play-text').textContent, 'Play arrangement');
  assert.equal(h.get('clear-midi').hidden, true);
  assert.equal(storageValue(storage, 'arrangement').name, 'Keep my piece.mid');
  assert.equal(storage.operations.includes('write'), false);
  const nextVisit = await harness(t, { storage });
  assert.equal(nextVisit.get('score-name').textContent, 'Keep my piece');
  assert.equal(nextVisit.contexts.length, 0);
  assert.deepEqual(nextVisit.fetchCalls, ['instruments.json']);
});

for (const failure of ['network', 'http']) {
  test(`a ${failure} demo download failure is graceful and can be retried`, async t => {
    const h = await harness(t, failure === 'network' ? { demoFailure: true } : { demoOk: false });
    h.click('load-demo'); await flush();
    assert.match(h.status(), /Couldn’t load Two-chord demo/);
    assert.equal(h.get('play').disabled, false);
    assert.equal(h.get('score-name').textContent, LOVE_TITLE);
    assert.equal(h.contexts.length, 0);
    assert.equal(storageValue(h.storage, 'arrangement'), undefined);
    h.demo.failure = false;
    h.demo.ok = true;
    h.click('load-demo'); await flush();
    assert.equal(h.get('score-name').textContent, 'Two-chord demo');
    assert.equal(h.get('play').disabled, false);
    assert.equal(h.get('status').classList.contains('error'), false);
    assert.equal(h.noteCalls.length, 0);
  });
}

test('importing user MIDI defeats a slow automatic piano-score download', async t => {
  const pending = deferred();
  const h = await harness(t, { loveRead: () => pending.promise });
  assert.ok(h.fetchCalls.includes(LOVE_URL));
  await h.upload('New user piece.mid');
  pending.resolve(bundledLove()); await flush();
  assert.equal(h.get('score-name').textContent, 'New user piece');
  assert.equal(storageValue(h.storage, 'arrangement').name, 'New user piece.mid');
  assert.match(h.status(), /MIDI ready/);
  assert.equal(h.get('clear-midi').hidden, false);
});

test('clearing a saved MIDI defeats an in-flight explicit demo download', async t => {
  const storage = seededStorage({ arrangement: savedArrangement('Remove me.mid') });
  const h = await harness(t, { storage });
  const pending = deferred();
  h.demo.read = () => pending.promise;
  h.click('load-demo'); await flush();
  assert.equal(h.get('clear-midi').hidden, false);
  h.click('clear-midi'); await flush();
  pending.resolve(bundledDemo()); await flush();
  assert.equal(h.get('score-name').textContent, 'No MIDI loaded');
  assert.equal(h.get('play').disabled, true);
  assert.equal(storageValue(storage, 'arrangement'), undefined);
  assert.equal(h.get('clear-midi').hidden, true);
  assert.match(storageText(h), /removed/i);
});

test('a stale failed piano-score download cannot overwrite a successful import status', async t => {
  const pending = deferred();
  const h = await harness(t, { loveRead: () => pending.promise });
  await h.upload('Success.mid');
  pending.reject(new Error('Old piano-score download failed')); await flush();
  assert.equal(h.get('score-name').textContent, 'Success');
  assert.match(h.status(), /MIDI ready/);
  assert.equal(h.get('status').classList.contains('error'), false);
});

test('the included piano transcription loads by default and both score buttons are visible', async t => {
  const bytes = bundledLove();
  const midi = new Midi(bytes);
  assert.equal(bytes.byteLength, 8302);
  assert.equal(midi.tracks.length, 2);
  assert.deepEqual(midi.tracks.map(track => track.notes.length), [423, 96]);
  near(midi.duration, 116);
  const h = await harness(t);
  assert.equal(h.get('score-name').textContent, LOVE_TITLE);
  assert.match(h.get('score-meta').textContent, /^519 notes · 2 melodic parts · 1:56$/);
  assert.match(h.get('load-love-duty').textContent, /Load Love for Duty/i);
  assert.match(h.get('load-demo').textContent, /Load two.chord demo/i);
  assert.equal(h.get('load-love-duty').hidden, false);
  assert.equal(h.get('load-demo').hidden, false);
  assert.equal(h.contexts.length, 0);
  assert.equal(storageValue(h.storage, 'arrangement'), undefined);
  assert.equal(h.storage.operations.includes('write'), false);
  h.click('play'); await flush();
  assert.match(h.status(), /Love for Duty piano-score transcription/);
});

test('the Love for Duty button loads the piano score while preserving saved user MIDI', async t => {
  const storage = seededStorage({ arrangement: savedArrangement('My own saved.mid') });
  const h = await harness(t, { storage });
  h.click('load-love-duty'); await flush();
  assert.equal(h.get('score-name').textContent, LOVE_TITLE);
  assert.equal(h.get('play-text').textContent, 'Play arrangement');
  assert.equal(h.get('clear-midi').hidden, true);
  assert.equal(h.contexts.length, 0);
  assert.equal(storageValue(storage, 'arrangement').name, 'My own saved.mid');
  const nextVisit = await harness(t, { storage });
  assert.equal(nextVisit.get('score-name').textContent, 'My own saved');
  assert.deepEqual(nextVisit.fetchCalls, ['instruments.json']);
});

test('the latest bundled-score selection defeats an earlier delayed selection', async t => {
  const h = await harness(t);
  const pending = deferred();
  h.demo.read = () => pending.promise;
  h.click('load-demo'); await flush();
  h.click('load-love-duty'); await flush();
  pending.resolve(bundledDemo()); await flush();
  assert.equal(h.get('score-name').textContent, LOVE_TITLE);
  assert.equal(h.contexts.length, 0);
  assert.equal(storageValue(h.storage, 'arrangement'), undefined);
});
