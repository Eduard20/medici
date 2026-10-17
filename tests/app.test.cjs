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
  w.fetch = async url => {
    fetchCalls.push(url);
    if (url === 'instruments.json') {
      if (options.catalogFailure) throw new Error('Catalog offline');
      return { ok: true, json: async () => catalog };
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
  const acceptScore = async (name, bytes = fixture()) => {
    const browserBytes = w.Uint8Array.from(new Uint8Array(bytes)).buffer;
    w.dispatchEvent(new w.CustomEvent('medici:score-ready', {
      detail: { bytes: browserBytes, name, summary: {} },
    }));
    await flush();
    return browserBytes;
  };
  t.after(() => {
    w.dispatchEvent(new w.Event('pagehide'));
    w.close();
    assert.deepEqual(errors, [], 'The app should not raise uncaught DOM errors');
  });
  await flush();
  return {
    w, get, change, acceptScore, advance, noteCalls, instrumentCalls, contexts, fetchCalls, storage,
    click: id => get(id).click(),
    choose: name => w.document.querySelector(`[data-instrument="${name}"]`).click(),
    status: () => get('status').textContent,
    deferInstrument(name) { const wait = deferred(); waits.set(name, wait); return {
      resolve: () => { waits.delete(name); wait.resolve(playerFor(name)); },
      reject: error => { waits.delete(name); wait.reject(error); },
    }; },
  };
}

test('initial state has a complete sound library and no score or audio until a PDF is converted', async t => {
  const h = await harness(t);
  assert.equal(catalog.length, 128);
  assert.equal(catalog.includes('percussion'), false);
  assert.equal(h.get('instrument-select').options.length, catalog.length);
  assert.equal(h.get('instrument-select').value, 'acoustic_grand_piano');
  for (const id of ['play', 'restart', 'loop', 'seek', 'track']) assert.equal(h.get(id).disabled, true);
  assert.equal(h.get('preview').disabled, false, 'Sounds can still be auditioned before converting a PDF');
  assert.equal(h.get('clear-midi').hidden, true);
  assert.equal(h.contexts.length, 0, 'Audio is not created before a gesture');
  assert.equal(h.instrumentCalls.length, 0, 'No samples are loaded on startup');
  assert.equal(h.w.document.querySelector('iframe'), null);
  for (const id of ['load-video', 'listen-link', 'load-love-duty', 'load-demo', 'midi-file', 'file-zone']) {
    assert.equal(h.get(id), null, `The removed ${id} UI must not return`);
  }
  assert.deepEqual(h.fetchCalls, ['instruments.json']);
});

test('featured cards and catalog bridge synchronize badges and selection', async t => {
  const h = await harness(t);
  h.choose('violin');
  assert.equal(h.get('instrument-select').value, 'violin');
  assert.equal(h.get('instrument-badge').textContent, 'VIOLIN');
  assert.equal(h.w.document.querySelector('[data-instrument="violin"]').getAttribute('aria-pressed'), 'true');
  assert.equal(h.w.document.querySelector('[data-instrument="acoustic_grand_piano"]').getAttribute('aria-pressed'), 'false');
  h.change('instrument-select', 'flute');
  assert.equal(h.get('instrument-badge').textContent, 'FLUTE');
  assert.equal(h.w.document.querySelectorAll('[data-instrument].selected').length, 1);
  assert.match(h.status(), /Flute selected/);
});

test('preview plays an explicitly labeled arpeggio and can be stopped', async t => {
  const h = await harness(t);
  h.choose('acoustic_guitar_nylon');
  h.click('preview');
  await flush();
  assert.deepEqual(h.noteCalls.map(call => call.pitch), [60, 64, 67, 72, 67, 64, 60]);
  assert.ok(h.noteCalls.every(call => call.instrument === 'acoustic_guitar_nylon'));
  assert.match(h.status(), /short C.major arpeggio/i);
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

test('a converted PDF score exposes melodic parts, excludes drums, and enables transport', async t => {
  const h = await harness(t);
  await h.acceptScore('My arrangement.mid');
  assert.equal(h.get('score-name').textContent, 'My arrangement');
  assert.match(h.get('score-meta').textContent, /^4 notes · 2 melodic parts · 0:04$/);
  assert.equal(h.get('track').options.length, 3);
  assert.equal(h.get('seek').max, '4');
  assert.equal(h.get('total-time').textContent, '0:04');
  for (const id of ['play', 'restart', 'loop', 'seek', 'track']) assert.equal(h.get(id).disabled, false);
  assert.match(h.status(), /score is ready/i);
  assert.deepEqual(h.fetchCalls, ['instruments.json'], 'Converted note data is never uploaded');
  assert.equal(h.contexts.length, 0);
});

test('track selection plays only the selected melodic part', async t => {
  const h = await harness(t);
  await h.acceptScore('parts.midi');
  h.change('track', '1');
  assert.match(h.get('score-meta').textContent, /^1 notes · 1 melodic part · 0:04$/);
  h.click('play'); await flush();
  assert.deepEqual(h.noteCalls.map(call => call.pitch), [48]);
  h.advance(1500);
  assert.deepEqual(h.noteCalls.map(call => call.pitch), [48]);
});

test('play, pause, and resume retain position and stop previously scheduled notes', async t => {
  const h = await harness(t);
  await h.acceptScore('transport.mid');
  h.click('play'); await flush();
  assert.equal(h.get('play-text').textContent, 'Pause');
  assert.deepEqual(h.noteCalls.map(call => call.pitch), [60, 48]);
  h.advance(1250);
  h.click('play');
  assert.equal(h.get('play-text').textContent, 'Play score');
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
  await h.acceptScore('seek.mid');
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
  await h.acceptScore('settings.mid');
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
  await h.acceptScore('loop.mid');
  h.click('play'); await flush();
  h.advance(4050);
  assert.equal(h.get('play-text').textContent, 'Play score');
  assert.match(h.status(), /Score finished/);
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

test('malformed, empty, and drum-only conversion output show useful errors without enabling playback', async t => {
  const h = await harness(t);
  await h.acceptScore('broken.mid', Uint8Array.from([1, 2, 3]).buffer);
  assert.match(h.status(), /couldn.t|invalid|bad/i);
  await h.acceptScore('empty.mid', fixture({ empty: true }));
  assert.match(h.status(), /no melodic notes/);
  await h.acceptScore('drums.mid', fixture({ drumsOnly: true }));
  assert.match(h.status(), /no melodic notes/);
  assert.equal(h.get('status').classList.contains('error'), true);
  assert.equal(h.get('play').disabled, true);
  assert.equal(h.contexts.length, 0);
});

test('oversized conversion output is rejected without enabling playback or persistence', async t => {
  const h = await harness(t);
  await h.acceptScore('too-big.mid', new ArrayBuffer(5 * 1024 * 1024 + 1));
  assert.match(h.status(), /under 5 MB|too large/i);
  assert.equal(h.get('play').disabled, true);
  assert.equal(storageValue(h.storage, 'pdf-arrangement'), undefined);
});

test('failed conversion preserves the previous score and a valid conversion clears the error', async t => {
  const h = await harness(t);
  await h.acceptScore('first.mid');
  h.click('play'); await flush();
  h.w.dispatchEvent(new h.w.Event('medici:pdf-started'));
  await h.acceptScore('bad.mid', Uint8Array.from([0]).buffer);
  assert.equal(h.get('score-name').textContent, 'first');
  assert.equal(h.get('play').disabled, false);
  assert.equal(h.get('play-text').textContent, 'Play score');
  assert.ok(h.noteCalls.every(call => call.node.stopped));
  await h.acceptScore('second.mid');
  assert.equal(h.get('score-name').textContent, 'second');
  assert.equal(h.get('status').classList.contains('error'), false);
  assert.match(h.status(), /score is ready/i);
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
  await h.acceptScore('race.mid');
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
  assert.match(h.status(), /Playing your score with cello/);
});

test('switching instrument while playing resumes at the same position', async t => {
  const h = await harness(t);
  await h.acceptScore('switch.mid');
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
  await h.acceptScore('retry.mid');
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
  assert.equal(h.get('instrument-select').options.length, 8);
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



test('dragging seek through multiple positions resumes once at the final position', async t => {
  const h = await harness(t);
  await h.acceptScore('drag.mid');
  h.click('play'); await flush();
  h.get('seek').dispatchEvent(new h.w.Event('pointerdown'));
  h.change('seek', 0.7, 'input');
  h.change('seek', 1.8, 'input');
  h.change('seek', 2.5, 'input');
  assert.equal(h.get('play-text').textContent, 'Play score');
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
  await h.acceptScore('pending.mid');
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
  await h.acceptScore('extremes.mid', bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
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
  await h.acceptScore('missing-sample.mid');
  h.click('play'); await flush();
  h.click('play');
  assert.equal(h.status(), 'Paused.');
});

for (const action of ['restart', 'seek']) {
  test(`${action} cancels a pending preview and restores its button`, async t => {
    const h = await harness(t);
    await h.acceptScore('preview-interaction.mid');
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


test('an arrangement longer than two hours is rejected without replacing valid content', async t => {
  const h = await harness(t);
  await h.acceptScore('valid.mid');
  const score = new Midi();
  score.header.setTempo(120);
  score.addTrack().addNote({ midi: 60, time: 0, duration: 7201 });
  const bytes = score.toArray();
  await h.acceptScore('too-long.mid', bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  assert.match(h.status(), /shorter than two hours/);
  assert.equal(h.get('score-name').textContent, 'valid');
  assert.equal(h.get('play').disabled, false);
});

const DB_NAME = 'medici-listening-room';
const STORE_NAME = 'local';
const savedArrangement = (name = 'Saved arrangement.mid', bytes = fixture()) => ({ version: 1, name, bytes, source: 'pdf' });
const savedPreferences = overrides => ({
  version: 1, instrument: 'cello', speed: 1.25, transpose: -2, volume: 45, loop: true, ...overrides,
});
const storageValue = (storage, key) => storage.records().find(record =>
  record.database === DB_NAME && record.store === STORE_NAME && record.key === key)?.value;
function seededStorage(entries) {
  return createStorage().seed(DB_NAME, STORE_NAME, Object.entries(entries));
}
const storageText = h => h.get('storage-status').textContent;

test('conversion output is saved as private PDF score bytes without transmitting them', async t => {
  const h = await harness(t);
  const bytes = fixture();
  await h.acceptScore('Keep this.mid', bytes);
  await flush();
  const saved = storageValue(h.storage, 'pdf-arrangement');
  assert.ok(saved, 'A valid conversion should create a persisted PDF score');
  assert.equal(saved.version, 1);
  assert.equal(saved.name, 'Keep this.mid');
  assert.deepEqual(new Uint8Array(saved.bytes), new Uint8Array(bytes));
  assert.match(storageText(h), /saved|remembered|stored/i);
  assert.equal(h.get('clear-midi').hidden, false);
  assert.deepEqual(h.fetchCalls, ['instruments.json']);
});

test('reloading restores a converted PDF score at the beginning without autoplay or sample downloads', async t => {
  const first = await harness(t);
  await first.acceptScore('Returning.mid');
  first.click('play'); await flush();
  first.advance(1250);
  first.click('play');
  const second = await harness(t, { storage: first.storage });
  assert.equal(second.get('score-name').textContent, 'Returning');
  assert.equal(second.get('play').disabled, false);
  assert.equal(second.get('play-text').textContent, 'Play score');
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
    'pdf-arrangement': savedArrangement(),
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
  assert.equal(h.get('play-text').textContent, 'Play score');
});

test('changed preferences are persisted and survive the next visit', async t => {
  const first = await harness(t);
  await first.acceptScore('Preferences.mid');
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

test('unavailable IndexedDB does not prevent a newly converted score from playing', async t => {
  const h = await harness(t, { noStorage: true });
  await h.acceptScore('Temporary.mid');
  assert.equal(h.get('score-name').textContent, 'Temporary');
  assert.equal(h.get('play').disabled, false);
  assert.match(storageText(h), /unavailable|couldn.t|cannot|can.t|not saved/i);
  h.click('play'); await flush();
  assert.equal(h.get('play-text').textContent, 'Pause');
  assert.ok(h.noteCalls.length > 0);
});

test('denied database opening is reported without breaking score conversion or preview', async t => {
  const storage = createStorage();
  storage.failAlways('open', 'SecurityError');
  const h = await harness(t, { storage });
  await h.acceptScore('Denied storage.mid');
  assert.equal(h.get('play').disabled, false);
  assert.equal(storageValue(storage, 'pdf-arrangement'), undefined);
  assert.match(storageText(h), /unavailable|couldn.t|cannot|can.t|not saved/i);
  h.click('preview'); await flush();
  assert.equal(h.noteCalls.length, 7);
});

test('quota failure keeps the new score playable and warns the previous saved score remains', async t => {
  const storage = seededStorage({ 'pdf-arrangement': savedArrangement('Old saved.mid') });
  const h = await harness(t, { storage });
  storage.failNext('write', 'QuotaExceededError');
  await h.acceptScore('New temporary.mid');
  assert.equal(h.get('score-name').textContent, 'New temporary');
  assert.equal(h.get('play').disabled, false);
  assert.equal(storageValue(storage, 'pdf-arrangement').name, 'Old saved.mid');
  assert.match(storageText(h), /couldn.t|cannot|can.t|not saved/i);
  assert.match(storageText(h), /previous|old|earlier/i);
  h.click('play'); await flush();
  assert.equal(h.get('play-text').textContent, 'Pause');
  const nextVisit = await harness(t, { storage });
  assert.equal(nextVisit.get('score-name').textContent, 'Old saved');
});

test('corrupt saved PDF score is rejected, can be removed, and does not autoplay', async t => {
  const storage = seededStorage({ 'pdf-arrangement': savedArrangement('Corrupt.mid', Uint8Array.from([1, 2, 3]).buffer) });
  const h = await harness(t, { storage });
  assert.equal(h.get('play').disabled, true);
  assert.equal(h.get('score-name').textContent, 'Your music goes here');
  assert.equal(h.contexts.length, 0);
  assert.equal(h.get('clear-midi').hidden, false);
  assert.match(storageText(h), /couldn.t|cannot|can.t|invalid|corrupt/i);
  h.click('clear-midi'); await flush();
  assert.equal(storageValue(storage, 'pdf-arrangement'), undefined);
  await h.acceptScore('Recovered.mid');
  assert.equal(h.get('score-name').textContent, 'Recovered');
  assert.equal(h.get('play').disabled, false);
});

test('clear stops playback, removes only the saved PDF score, and prevents later restore', async t => {
  const storage = seededStorage({ 'pdf-arrangement': savedArrangement(), preferences: savedPreferences() });
  const h = await harness(t, { storage });
  h.click('play'); await flush();
  assert.ok(h.noteCalls.length > 0);
  h.click('clear-midi'); await flush();
  assert.ok(h.noteCalls.every(call => call.node.stopped));
  assert.equal(h.get('score-name').textContent, 'Your music goes here');
  assert.equal(h.get('play').disabled, true);
  assert.equal(h.get('track').disabled, true);
  assert.equal(h.get('clear-midi').hidden, true);
  assert.equal(storageValue(storage, 'pdf-arrangement'), undefined);
  assert.equal(storageValue(storage, 'preferences').instrument, 'cello');
  const nextVisit = await harness(t, { storage });
  assert.equal(nextVisit.get('play').disabled, true);
  assert.equal(nextVisit.get('instrument-select').value, 'cello');
  assert.equal(nextVisit.noteCalls.length, 0);
});

test('failed deletion is explicit and can be retried instead of falsely claiming removal', async t => {
  const storage = seededStorage({ 'pdf-arrangement': savedArrangement() });
  const h = await harness(t, { storage });
  storage.failNext('delete', 'UnknownError');
  h.click('clear-midi'); await flush();
  assert.equal(h.get('score-name').textContent, 'Your music goes here');
  assert.equal(h.get('play').disabled, true);
  assert.ok(storageValue(storage, 'pdf-arrangement'));
  assert.equal(h.get('clear-midi').hidden, false);
  assert.match(storageText(h), /couldn.t|cannot|can.t|failed|not removed/i);
  h.click('clear-midi'); await flush();
  assert.equal(storageValue(storage, 'pdf-arrangement'), undefined);
  assert.equal(h.get('clear-midi').hidden, true);
});

test('a new conversion wins over a delayed startup restore and is saved for next visit', async t => {
  const storage = seededStorage({ 'pdf-arrangement': savedArrangement('Old restore.mid') });
  const pending = storage.holdNext('read');
  const h = await harness(t, { storage });
  await pending.reached;
  await h.acceptScore('New import.mid');
  assert.equal(h.get('score-name').textContent, 'New import');
  pending.release(); await flush();
  assert.equal(h.get('score-name').textContent, 'New import');
  assert.equal(storageValue(storage, 'pdf-arrangement').name, 'New import.mid');
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

test('clear during a pending save cannot resurrect the converted score after the save finishes', async t => {
  const h = await harness(t);
  const pending = h.storage.holdNext('write');
  await h.acceptScore('Pending save.mid');
  await pending.reached;
  assert.equal(h.get('clear-midi').hidden, false);
  h.click('clear-midi');
  assert.equal(h.get('score-name').textContent, 'Your music goes here');
  pending.release(); await flush();
  assert.equal(h.get('score-name').textContent, 'Your music goes here');
  assert.equal(storageValue(h.storage, 'pdf-arrangement'), undefined);
  assert.equal(h.get('clear-midi').hidden, true);
  const nextVisit = await harness(t, { storage: h.storage });
  assert.equal(nextVisit.get('play').disabled, true);
});

test('conversion during pending clear remains visible and is saved after deletion', async t => {
  const storage = seededStorage({ 'pdf-arrangement': savedArrangement('Old before clear.mid') });
  const h = await harness(t, { storage });
  const pending = storage.holdNext('delete');
  h.click('clear-midi'); await flush();
  await pending.reached;
  await h.acceptScore('New after clear.mid');
  assert.equal(h.get('score-name').textContent, 'New after clear');
  pending.release(); await flush();
  assert.equal(h.get('score-name').textContent, 'New after clear');
  assert.equal(h.get('play').disabled, false);
  assert.equal(h.get('clear-midi').hidden, false);
  assert.equal(storageValue(storage, 'pdf-arrangement').name, 'New after clear.mid');
  assert.match(storageText(h), /saved|remembered|stored/i);
});

test('the newest conversion remains saved when an earlier score write is delayed', async t => {
  const h = await harness(t);
  const pending = h.storage.holdNext('write');
  await h.acceptScore('Earlier.mid');
  await pending.reached;
  await h.acceptScore('Newest.mid');
  pending.release(); await flush();
  assert.equal(h.get('score-name').textContent, 'Newest');
  assert.equal(storageValue(h.storage, 'pdf-arrangement').name, 'Newest.mid');
});

test('a blocked database open times out while the converted score stays usable', async t => {
  const storage = createStorage();
  const pending = storage.holdNext('open');
  const h = await harness(t, { storage });
  await pending.reached;
  await h.acceptScore('Offline storage.mid');
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

test('timed-out save is aborted and cannot replace the old saved PDF score later', async t => {
  const storage = seededStorage({ 'pdf-arrangement': savedArrangement('Preserved.mid') });
  const h = await harness(t, { storage });
  const pending = storage.holdNext('write');
  await h.acceptScore('Timed out.mid');
  await pending.reached;
  h.advance(8001); await flush();
  assert.equal(h.get('score-name').textContent, 'Timed out');
  assert.equal(h.get('play').disabled, false);
  assert.match(storageText(h), /couldn.t|cannot|can.t|not saved/i);
  assert.equal(storageValue(storage, 'pdf-arrangement').name, 'Preserved.mid');
  pending.release(); await flush();
  assert.equal(storageValue(storage, 'pdf-arrangement').name, 'Preserved.mid');
  await h.acceptScore('Retry succeeded.mid');
  assert.equal(storageValue(storage, 'pdf-arrangement').name, 'Retry succeeded.mid');
});

// Inline instrument-library integration tests. Exercise the real rendered cards
// and events so search, filtering, playback, and persistence share one selection.
const featuredInstrumentIds = [
  'acoustic_grand_piano', 'acoustic_guitar_nylon', 'violin', 'cello',
  'orchestral_harp', 'flute', 'choir_aahs', 'celesta',
];
const instrumentCards = h => Array.from(h.get('instrument-results').querySelectorAll('button[data-instrument]'));
const instrumentIds = h => instrumentCards(h).map(button => button.dataset.instrument);
const familyButton = (h, family) => h.w.document.querySelector(`button[data-family="${family}"]`);
const chooseFamily = (h, family) => {
  const button = familyButton(h, family);
  assert.ok(button, `The ${family} family should be discoverable`);
  button.click();
};
const searchInstruments = (h, query) => h.change('instrument-search', query, 'input');
function assertInstrumentSelection(h, id) {
  assert.equal(h.get('instrument-select').value, id);
  for (const card of instrumentCards(h)) {
    const selected = card.dataset.instrument === id;
    assert.equal(card.getAttribute('aria-pressed'), String(selected), `Pressed state for ${card.dataset.instrument}`);
    assert.equal(card.classList.contains('selected'), selected, `Visible selection for ${card.dataset.instrument}`);
  }
}
function assertResultCount(h, count) {
  assert.equal(instrumentCards(h).length, count);
  assert.match(h.get('instrument-result-count').textContent, new RegExp(`\\b${count}\\b`));
}

test('inline picker starts with eight useful sounds and exposes every catalog instrument', async t => {
  const h = await harness(t);
  assert.deepEqual(instrumentIds(h), featuredInstrumentIds);
  assertResultCount(h, 8);
  assert.equal(familyButton(h, 'featured').getAttribute('aria-pressed'), 'true');
  assertInstrumentSelection(h, 'acoustic_grand_piano');
  assert.match(h.get('selected-instrument').textContent, /piano/i);
  assert.equal(h.get('instrument-empty').hidden, true);
  assert.equal(h.get('instrument-select').hidden, true, 'The compatibility select is not the primary picker');
  chooseFamily(h, 'all');
  const allIds = instrumentIds(h);
  assertResultCount(h, 128);
  assert.equal(new Set(allIds).size, 128, 'The library should not duplicate sound cards');
  assert.deepEqual(allIds.slice().sort(), catalog.slice().sort());
  assert.equal(familyButton(h, 'all').getAttribute('aria-pressed'), 'true');
  assert.equal(familyButton(h, 'featured').getAttribute('aria-pressed'), 'false');
  assert.equal(h.contexts.length, 0);
  assert.equal(h.instrumentCalls.length, 0, 'Browsing the library must not download samples');
});

test('family filters partition all 128 catalog sounds and keep exactly one active filter', async t => {
  const h = await harness(t);
  const representatives = {
    keys: ['acoustic_grand_piano', 'church_organ', 'harpsichord'],
    strings: ['violin', 'cello', 'orchestral_harp'],
    guitars: ['acoustic_guitar_nylon', 'electric_guitar_clean', 'electric_bass_finger'],
    winds: ['flute', 'alto_sax', 'trumpet'],
    voices: ['choir_aahs', 'voice_oohs', 'synth_choir'],
    synths: ['lead_1_square', 'pad_2_warm', 'synth_bass_1'],
    percussion: ['timpani', 'taiko_drum', 'woodblock'],
    effects: ['bird_tweet', 'telephone_ring', 'applause'],
  };
  const seen = [];
  for (const [family, expected] of Object.entries(representatives)) {
    chooseFamily(h, family);
    const ids = instrumentIds(h);
    assert.ok(ids.length > 0, `${family} must not be empty`);
    for (const id of expected) assert.ok(ids.includes(id), `${family} should contain ${id}`);
    assertResultCount(h, ids.length);
    const pressed = Array.from(h.w.document.querySelectorAll('button[data-family][aria-pressed="true"]'));
    assert.equal(pressed.length, 1, 'Only the current family is pressed');
    assert.equal(pressed[0].dataset.family, family);
    assertInstrumentSelection(h, 'acoustic_grand_piano');
    seen.push(...ids);
  }
  assert.equal(seen.length, 128, 'Every sound belongs to exactly one browse family');
  assert.equal(new Set(seen).size, 128, 'Family filters should not repeat the same catalog sound');
  assert.deepEqual(seen.slice().sort(), catalog.slice().sort());
  assert.equal(h.contexts.length, 0);
});

test('search looks across the catalog even when a different family is selected', async t => {
  const h = await harness(t);
  chooseFamily(h, 'strings');
  assert.equal(instrumentIds(h).includes('trumpet'), false);
  searchInstruments(h, 'trumpet');
  assert.deepEqual(instrumentIds(h).slice().sort(), ['muted_trumpet', 'trumpet']);
  assertResultCount(h, 2);
  assert.equal(h.get('instrument-empty').hidden, true);
  assertInstrumentSelection(h, 'acoustic_grand_piano');
  assert.equal(h.get('clear-instrument-search').hidden, false);
  h.click('clear-instrument-search');
  assert.equal(h.get('instrument-search').value, '');
  assert.equal(familyButton(h, 'strings').getAttribute('aria-pressed'), 'true');
  assert.ok(instrumentIds(h).includes('violin'));
  assert.equal(instrumentIds(h).includes('trumpet'), false);
  assert.equal(h.w.document.activeElement, h.get('instrument-search'), 'Clearing keeps typing convenient');
});

test('search normalizes case and repeated spaces and finds friendly aliases', async t => {
  const h = await harness(t);
  searchInstruments(h, '  GRAND    PIANO  ');
  assert.deepEqual(instrumentIds(h).slice().sort(), ['acoustic_grand_piano', 'electric_grand_piano']);
  searchInstruments(h, '  NYLON    GUITAR  ');
  assert.deepEqual(instrumentIds(h), ['acoustic_guitar_nylon']);
  searchInstruments(h, 'saxophone');
  assert.deepEqual(instrumentIds(h).slice().sort(), ['alto_sax', 'baritone_sax', 'soprano_sax', 'tenor_sax']);
  for (const query of ['honky tonk', 'HÓNKY-TONK', 'honkytonk']) {
    searchInstruments(h, query);
    assert.deepEqual(instrumentIds(h), ['honkytonk_piano'], `Normalized alias: ${query}`);
  }
  searchInstruments(h, 'acoustic_guitar_nylon');
  assert.deepEqual(instrumentIds(h), ['acoustic_guitar_nylon']);
  searchInstruments(h, '   ');
  assert.deepEqual(instrumentIds(h), featuredInstrumentIds, 'Whitespace alone behaves like an empty search');
  assert.equal(h.get('instrument-empty').hidden, true);
});

test('an unmatched search announces zero results and reset restores a useful picker without changing sound', async t => {
  const h = await harness(t);
  h.choose('cello');
  chooseFamily(h, 'winds');
  searchInstruments(h, 'no-such-sound-48319');
  assertResultCount(h, 0);
  assert.equal(h.get('instrument-empty').hidden, false);
  assert.match(h.get('instrument-empty').textContent, /no|try|search/i);
  assertInstrumentSelection(h, 'cello');
  assert.match(h.get('selected-instrument').textContent, /cello/i);
  h.click('reset-instrument-search');
  assert.equal(h.get('instrument-search').value, '');
  assert.equal(h.get('instrument-empty').hidden, true);
  assert.equal(familyButton(h, 'all').getAttribute('aria-pressed'), 'true');
  assertResultCount(h, 128);
  assertInstrumentSelection(h, 'cello');
  assert.equal(h.w.document.activeElement, h.get('instrument-search'));
  assert.equal(h.contexts.length, 0);
});

test('a search-result card synchronizes selection, full friendly label, and the transport badge', async t => {
  const h = await harness(t);
  searchInstruments(h, 'nylon guitar');
  h.choose('acoustic_guitar_nylon');
  assertInstrumentSelection(h, 'acoustic_guitar_nylon');
  assert.match(h.get('selected-instrument').textContent, /nylon/i);
  assert.match(h.get('selected-instrument').textContent, /guitar/i);
  assert.doesNotMatch(h.get('selected-instrument').textContent, /_/);
  assert.match(h.get('instrument-badge').textContent, /GUITAR/);
  h.click('clear-instrument-search');
  assertInstrumentSelection(h, 'acoustic_guitar_nylon');
  h.change('instrument-select', 'flute');
  assertInstrumentSelection(h, 'flute');
  assert.match(h.get('selected-instrument').textContent, /flute/i);
  assert.equal(h.get('instrument-badge').textContent, 'FLUTE');
  assert.equal(h.instrumentCalls.length, 0, 'Selecting a card without playback should not load sound');
});

test('the selected instrument survives filters and reappears active when its card returns', async t => {
  const h = await harness(t);
  h.choose('violin');
  const selectedText = h.get('selected-instrument').textContent;
  chooseFamily(h, 'winds');
  assert.equal(instrumentCards(h).filter(card => card.getAttribute('aria-pressed') === 'true').length, 0);
  assert.equal(h.get('selected-instrument').textContent, selectedText);
  assertInstrumentSelection(h, 'violin');
  searchInstruments(h, 'piano');
  assertInstrumentSelection(h, 'violin');
  assert.equal(h.get('selected-instrument').textContent, selectedText);
  h.click('clear-instrument-search');
  chooseFamily(h, 'strings');
  assertInstrumentSelection(h, 'violin');
  assert.equal(h.w.document.querySelector('[data-instrument="violin"]').getAttribute('aria-pressed'), 'true');
  assert.equal(h.get('instrument-badge').textContent, 'VIOLIN');
});

test('browsing during playback is silent and choosing a new search result resumes at the same position', async t => {
  const h = await harness(t);
  await h.acceptScore('Picker playback.mid');
  h.click('play'); await flush();
  h.advance(1500);
  const before = h.noteCalls.length;
  const originalNodes = h.noteCalls.map(call => call.node);
  chooseFamily(h, 'winds');
  searchInstruments(h, 'alto');
  assert.equal(h.get('play-text').textContent, 'Pause');
  assert.equal(h.noteCalls.length, before);
  assert.ok(originalNodes.every(node => !node.stopped), 'Browsing must not interrupt playback');
  assertInstrumentSelection(h, 'acoustic_grand_piano');
  h.choose('alto_sax'); await flush();
  assertInstrumentSelection(h, 'alto_sax');
  assert.equal(h.get('play-text').textContent, 'Pause');
  near(Number(h.get('seek').value), 1.5);
  assert.ok(originalNodes.every(node => node.stopped));
  const newNotes = h.noteCalls.slice(before);
  assert.ok(newNotes.length > 0);
  assert.ok(newNotes.every(call => call.instrument === 'alto_sax'));
  assert.match(h.get('selected-instrument').textContent, /alto/i);
  assert.match(h.get('instrument-badge').textContent, /ALTO/);
});

test('browsing preserves a running preview and selecting a result stops it before the next preview', async t => {
  const h = await harness(t);
  h.click('preview'); await flush();
  const previous = h.noteCalls.slice();
  assert.equal(previous.length, 7);
  chooseFamily(h, 'winds');
  searchInstruments(h, 'alto');
  assert.match(h.get('preview').textContent, /Stop preview/);
  assert.ok(previous.every(call => !call.node.stopped));
  h.choose('alto_sax'); await flush();
  assert.ok(previous.every(call => call.node.stopped));
  assert.match(h.get('preview').textContent, /Preview sound/);
  assert.equal(h.noteCalls.length, 7, 'Choosing a card does not automatically preview it');
  assertInstrumentSelection(h, 'alto_sax');
  h.click('preview'); await flush();
  assert.equal(h.noteCalls.length, 14);
  assert.ok(h.noteCalls.slice(7).every(call => call.instrument === 'alto_sax'));
  assert.match(h.get('preview').textContent, /Stop preview/);
});

test('search-result selection defeats a stale pending preview sample download', async t => {
  const h = await harness(t);
  const pending = h.deferInstrument('acoustic_grand_piano');
  h.click('preview'); await flush();
  searchInstruments(h, 'soprano');
  h.choose('soprano_sax');
  h.click('preview'); await flush();
  assert.equal(h.noteCalls.length, 7);
  assert.ok(h.noteCalls.every(call => call.instrument === 'soprano_sax'));
  pending.resolve(); await flush();
  assert.equal(h.noteCalls.length, 7, 'Old samples must not start an obsolete preview');
  assertInstrumentSelection(h, 'soprano_sax');
  assert.match(h.get('preview').textContent, /Stop preview/);
});

test('a saved nonfeatured instrument restores the new picker label and later renders as selected', async t => {
  const h = await harness(t, { storage: seededStorage({
    preferences: savedPreferences({ instrument: 'oboe' }),
  }) });
  assertInstrumentSelection(h, 'oboe');
  assert.match(h.get('selected-instrument').textContent, /oboe/i);
  assert.equal(h.get('instrument-badge').textContent, 'OBOE');
  assert.equal(instrumentIds(h).includes('oboe'), false, 'Restoring a sound need not change the featured filter');
  searchInstruments(h, 'oboe');
  assert.deepEqual(instrumentIds(h), ['oboe']);
  assertInstrumentSelection(h, 'oboe');
  assert.equal(instrumentCards(h)[0].getAttribute('aria-pressed'), 'true');
  assert.equal(h.contexts.length, 0);
  assert.equal(h.instrumentCalls.length, 0);
});

test('choosing a newly rendered result persists its sound and restores its friendly label next visit', async t => {
  const first = await harness(t);
  searchInstruments(first, 'tubular');
  first.choose('tubular_bells');
  const selectedLabel = first.get('selected-instrument').textContent;
  first.advance(251); await flush();
  assert.equal(storageValue(first.storage, 'preferences').instrument, 'tubular_bells');
  const nextVisit = await harness(t, { storage: first.storage });
  assertInstrumentSelection(nextVisit, 'tubular_bells');
  assert.equal(nextVisit.get('selected-instrument').textContent, selectedLabel);
  chooseFamily(nextVisit, 'all');
  assertInstrumentSelection(nextVisit, 'tubular_bells');
  assert.equal(nextVisit.w.document.querySelector('[data-instrument="tubular_bells"]').getAttribute('aria-pressed'), 'true');
  assert.equal(nextVisit.contexts.length, 0);
  assert.equal(nextVisit.instrumentCalls.length, 0);
});

test('picker controls have native keyboard semantics, labels, live feedback, and stable card focus', async t => {
  const h = await harness(t);
  const search = h.get('instrument-search');
  assert.equal(search.tagName, 'INPUT');
  assert.ok(search.labels.length > 0 || search.getAttribute('aria-label') || search.getAttribute('aria-labelledby'),
    'Search needs an accessible name beyond its placeholder');
  const count = h.get('instrument-result-count');
  assert.ok(count.getAttribute('aria-live') === 'polite' || count.getAttribute('role') === 'status',
    'Changes to result count must be announced');
  const controls = [...instrumentCards(h), ...h.w.document.querySelectorAll('[data-family]'),
    h.get('clear-instrument-search'), h.get('reset-instrument-search')];
  for (const button of controls) {
    assert.equal(button.tagName, 'BUTTON', 'Native buttons provide Enter and Space activation');
    assert.equal(button.type, 'button', 'Picker buttons cannot accidentally submit forms');
    assert.equal(button.tabIndex, 0);
    assert.equal(button.disabled, false);
    assert.ok(button.textContent.trim() || button.getAttribute('aria-label'), 'Every button needs an accessible name');
  }
  const violin = h.w.document.querySelector('[data-instrument="violin"]');
  violin.focus();
  assert.equal(h.w.document.activeElement, violin);
  violin.click();
  assert.equal(h.w.document.activeElement, violin, 'Selecting must not discard the focused native card');
  assertInstrumentSelection(h, 'violin');
  assert.equal(violin.getAttribute('aria-pressed'), 'true');
});

test('choosing a family exits global search and restores that family without changing the selected sound', async t => {
  const h = await harness(t);
  chooseFamily(h, 'strings');
  const stringIds = instrumentIds(h);
  searchInstruments(h, 'trumpet');
  assert.ok(instrumentIds(h).includes('trumpet'));
  chooseFamily(h, 'strings');
  assert.equal(h.get('instrument-search').value, '');
  assert.deepEqual(instrumentIds(h), stringIds);
  assertInstrumentSelection(h, 'acoustic_grand_piano');
  assert.equal(h.get('instrument-empty').hidden, true);
  assert.equal(familyButton(h, 'strings').getAttribute('aria-pressed'), 'true');
});

test('catalog failure leaves all eight starter sounds selectable through the inline picker', async t => {
  const h = await harness(t, { catalogFailure: true });
  assert.deepEqual(instrumentIds(h), featuredInstrumentIds);
  assertResultCount(h, 8);
  chooseFamily(h, 'all');
  assertResultCount(h, 8);
  assert.deepEqual(instrumentIds(h).slice().sort(), featuredInstrumentIds.slice().sort());
  searchInstruments(h, 'harp');
  assert.deepEqual(instrumentIds(h), ['orchestral_harp']);
  h.choose('orchestral_harp');
  assertInstrumentSelection(h, 'orchestral_harp');
  assert.match(h.get('selected-instrument').textContent, /harp/i);
  h.click('preview'); await flush();
  assert.equal(h.noteCalls.length, 7);
  assert.ok(h.noteCalls.every(call => call.instrument === 'orchestral_harp'));
});

test('legacy arrangements never auto-load and clearing a PDF score preserves unrelated stored data', async t => {
  const legacy = savedArrangement('Legacy song.mid');
  const storage = seededStorage({ arrangement: legacy, preferences: savedPreferences({ instrument: 'violin' }) });
  const h = await harness(t, { storage });
  assert.equal(h.get('play').disabled, true);
  assert.equal(h.get('score-name').textContent, 'Your music goes here');
  assert.equal(h.get('clear-midi').hidden, true);
  assertInstrumentSelection(h, 'violin');
  assert.deepEqual(h.fetchCalls, ['instruments.json']);
  assert.equal(h.contexts.length, 0);
  assert.equal(storageValue(storage, 'pdf-arrangement'), undefined);
  await h.acceptScore('My PDF.mid');
  assert.equal(storageValue(storage, 'pdf-arrangement').name, 'My PDF.mid');
  assert.equal(storageValue(storage, 'arrangement').name, 'Legacy song.mid');
  let cancelEvents = 0;
  h.w.addEventListener('medici:cancel-pdf', () => cancelEvents++);
  h.click('clear-midi'); await flush();
  assert.equal(cancelEvents, 1, 'Removing a score also cancels an in-flight PDF conversion');
  assert.equal(storageValue(storage, 'pdf-arrangement'), undefined);
  assert.equal(storageValue(storage, 'arrangement').name, 'Legacy song.mid');
  assert.equal(storageValue(storage, 'preferences').instrument, 'violin');
  const nextVisit = await harness(t, { storage });
  assert.equal(nextVisit.get('play').disabled, true);
  assert.equal(nextVisit.get('score-name').textContent, 'Your music goes here');
});

test('starting another PDF stops playback and retains the last usable score while recognition runs', async t => {
  const h = await harness(t);
  await h.acceptScore('First score.mid');
  h.click('play'); await flush();
  h.advance(1250);
  h.w.dispatchEvent(new h.w.Event('medici:pdf-started'));
  assert.equal(h.get('play-text').textContent, 'Play score');
  near(Number(h.get('seek').value), 1.25);
  assert.ok(h.noteCalls.every(call => call.node.stopped));
  assert.equal(h.get('score-name').textContent, 'First score');
  assert.equal(storageValue(h.storage, 'pdf-arrangement').name, 'First score.mid');
  await h.acceptScore('Second score.mid');
  assert.equal(h.get('score-name').textContent, 'Second score');
  assert.equal(h.get('play-text').textContent, 'Play score');
  near(Number(h.get('seek').value), 0);
  assert.equal(storageValue(h.storage, 'pdf-arrangement').name, 'Second score.mid');
});

test('starting PDF recognition cancels pending preview audio without stale playback', async t => {
  const h = await harness(t);
  const pending = h.deferInstrument('acoustic_grand_piano');
  h.click('preview'); await flush();
  h.w.dispatchEvent(new h.w.Event('medici:pdf-started'));
  pending.resolve(); await flush();
  assert.equal(h.noteCalls.length, 0);
  assert.match(h.get('preview').textContent, /Preview sound/);
  h.click('preview'); await flush();
  assert.equal(h.noteCalls.length, 7, 'The next preview should work normally');
});

test('starting a new PDF defeats delayed saved-score restoration before conversion finishes', async t => {
  const storage = seededStorage({ 'pdf-arrangement': savedArrangement('Old PDF.mid') });
  const pending = storage.holdNext('read');
  const h = await harness(t, { storage });
  await pending.reached;
  h.w.dispatchEvent(new h.w.Event('medici:pdf-started'));
  pending.release(); await flush();
  assert.equal(h.get('play').disabled, true);
  assert.equal(h.get('score-name').textContent, 'Your music goes here');
  assert.equal(h.noteCalls.length, 0);
  await h.acceptScore('Current PDF.mid');
  assert.equal(h.get('score-name').textContent, 'Current PDF');
  assert.equal(storageValue(storage, 'pdf-arrangement').name, 'Current PDF.mid');
});

test('invalid conversion event payloads cannot enable playback or overwrite a saved score', async t => {
  const h = await harness(t);
  await h.acceptScore('Known good.mid');
  for (const detail of [undefined, {}, { name: 'recording.mp3', bytes: h.w.Uint8Array.from(new Uint8Array(fixture())).buffer },
    { name: 'broken.mid', bytes: 'not a buffer' }]) {
    h.w.dispatchEvent(new h.w.CustomEvent('medici:score-ready', { detail }));
    await flush();
    assert.equal(h.get('status').classList.contains('error'), true);
    assert.equal(h.get('score-name').textContent, 'Known good');
    assert.equal(storageValue(h.storage, 'pdf-arrangement').name, 'Known good.mid');
  }
  assert.equal(h.instrumentCalls.length, 0);
});

// Joined frontend test: only PDF rasterization and the recognition worker are
// mocked. Real MusicXML conversion, event delivery, MIDI parsing, storage, and
// transport all run together against the shipped index.html.
function installInlineConversion(h, { holdRecognition = false } = {}) {
  const { w } = h;
  const workers = [];
  const xml = '<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>' +
    '<part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>' +
    '<note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration></note>' +
    '<note><pitch><step>E</step><octave>4</octave></pitch><duration>2</duration></note></measure></part></score-partwise>';
  w.WebAssembly = { instantiate() {} };
  Object.defineProperty(w.crypto, 'subtle', { value: {}, configurable: true });
  w.HTMLCanvasElement.prototype.toBlob = function (callback) {
    callback({ arrayBuffer: async () => new w.ArrayBuffer(4) });
  };
  const page = {
    getViewport: ({ scale }) => ({ width: 595 * scale, height: 842 * scale }),
    render: () => ({ promise: Promise.resolve(), cancel() {} }),
    cleanup() {},
  };
  w.__testPDFLibrary = async () => ({
    GlobalWorkerOptions: {},
    getDocument: () => ({
      promise: Promise.resolve({ numPages: 1, getPage: async () => page }),
      destroy: async () => {},
    }),
  });
  w.Worker = class {
    constructor() { this.terminated = false; this.recognitionCallback = null; workers.push(this); }
    postMessage(message) {
      const deliver = () => this.onmessage?.({ data: message.type === 'init' ? { type: 'ready' } : { type: 'result', xml } });
      if (message.type === 'recognise' && holdRecognition) this.recognitionCallback = deliver;
      else Promise.resolve().then(() => { if (!this.terminated) deliver(); });
    }
    terminate() { this.terminated = true; }
  };
  w.eval(fs.readFileSync(path.join(root, 'musicxml-midi.js'), 'utf8'));
  const inlineSource = fs.readFileSync(path.join(root, 'inline-converter.js'), 'utf8');
  const importStatement = "import(PDFJS + 'pdf.min.mjs')";
  assert.ok(inlineSource.includes(importStatement), 'The joined test must replace only the external PDF library import');
  w.eval(inlineSource.replace(importStatement, 'window.__testPDFLibrary()'));
  return {
    workers,
    async select(name = 'Two notes.pdf') {
      const pdfBytes = w.Uint8Array.from(new TextEncoder().encode('%PDF-1.7 test fixture')).buffer;
      const file = new w.File([pdfBytes], name, { type: 'application/pdf' });
      Object.defineProperty(file, 'slice', { value: () => ({ arrayBuffer: async () => pdfBytes }) });
      Object.defineProperty(file, 'arrayBuffer', { value: async () => pdfBytes });
      Object.defineProperty(h.get('sheet-pdf'), 'files', { configurable: true, value: [file] });
      h.get('sheet-pdf').dispatchEvent(new w.Event('change', { bubbles: true }));
      await flush(); await flush();
    },
  };
}

test('PDF selection reaches the sound picker, real note conversion, persistence, and playback without navigation or autoplay', async t => {
  const h = await harness(t);
  const inline = installInlineConversion(h);
  h.choose('violin');
  h.change('sheet-tempo', 120);
  await inline.select();
  assert.equal(h.get('score-name').textContent, 'Two notes · experimental');
  assert.equal(h.get('score-meta').textContent, '2 notes · 1 melodic part · 0:02');
  assert.equal(h.get('play').disabled, false);
  assert.equal(h.get('play-text').textContent, 'Play score');
  assertInstrumentSelection(h, 'violin');
  assert.equal(h.contexts.length, 0);
  assert.equal(h.instrumentCalls.length, 0);
  assert.equal(h.get('sheet-download').hidden, false);
  assert.equal(h.get('sheet-cancel').hidden, true);
  assert.equal(inline.workers[0].terminated, true);
  assert.equal(h.w.location.href, 'https://medici.example/');
  const saved = storageValue(h.storage, 'pdf-arrangement');
  assert.equal(saved.name, 'Two notes · experimental.mid');
  assert.deepEqual(new Midi(saved.bytes).tracks[0].notes.map(note => note.midi), [60, 64]);
  assert.deepEqual(h.fetchCalls, ['instruments.json'], 'PDF and recognized notes must not be transmitted');
  h.click('play'); await flush();
  assert.equal(h.get('play-text').textContent, 'Pause');
  assert.equal(h.noteCalls[0].instrument, 'violin');
  assert.equal(h.noteCalls[0].pitch, 60);
  h.advance(1100);
  assert.deepEqual(h.noteCalls.map(call => call.pitch), [60, 64]);
  h.click('clear-midi'); await flush();
  assert.equal(h.get('play').disabled, true);
  assert.equal(h.get('sheet-download').hidden, true);
  assert.equal(storageValue(h.storage, 'pdf-arrangement'), undefined);
});

test('clearing the current score cancels inline recognition and prevents its late result from restoring audio or storage', async t => {
  const h = await harness(t);
  await h.acceptScore('Current score.mid');
  const inline = installInlineConversion(h, { holdRecognition: true });
  await inline.select('Replacement.pdf');
  assert.equal(h.get('sheet-cancel').hidden, false);
  assert.equal(h.get('score-name').textContent, 'Current score');
  assert.ok(inline.workers[0].recognitionCallback, 'Recognition should be pending');
  const lateMessage = inline.workers[0].onmessage;
  h.click('clear-midi'); await flush();
  assert.equal(inline.workers[0].terminated, true);
  lateMessage({ data: { type: 'result', xml: '<score-partwise/>' } });
  inline.workers[0].recognitionCallback();
  await flush();
  assert.equal(h.get('score-name').textContent, 'Your music goes here');
  assert.equal(h.get('play').disabled, true);
  assert.equal(h.get('sheet-download').hidden, true);
  assert.equal(h.get('sheet-cancel').hidden, true);
  assert.equal(storageValue(h.storage, 'pdf-arrangement'), undefined);
  assert.equal(h.noteCalls.length, 0);
});

