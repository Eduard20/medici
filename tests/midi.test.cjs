'use strict';

// Run from the app directory with: node --test tests/midi.test.cjs
// No npm install is needed: these tests exercise the shipped UMD bundle.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Midi, Track, Header } = require('../vendor/midi.js');

const EPSILON = 1e-9;
const near = (actual, expected, message) => {
  assert.ok(Math.abs(actual - expected) < EPSILON,
    message || `Expected ${actual} to be approximately ${expected}`);
};
const roundTrip = (midi) => new Midi(midi.toArray());
const nonPercussionNotes = (midi) => midi.tracks
  .filter((track) => !track.instrument.percussion)
  .flatMap((track) => track.notes);

function makeMelodicFixture() {
  const midi = new Midi();
  midi.header.name = 'Medici test score';
  midi.header.setTempo(120);
  midi.header.timeSignatures.push({ ticks: 0, timeSignature: [4, 4] });
  midi.header.update();

  const piano = midi.addTrack();
  piano.name = 'Piano';
  piano.channel = 0;
  piano.instrument.number = 0;
  piano.addNote({ midi: 60, ticks: 0, durationTicks: 480, velocity: 100 / 127 });
  piano.addNote({ midi: 64, ticks: 0, durationTicks: 240, velocity: 80 / 127 });
  piano.addNote({ midi: 67, ticks: 480, durationTicks: 960, velocity: 1 });

  const violin = midi.addTrack();
  violin.name = 'Violin';
  violin.channel = 1;
  violin.instrument.number = 40;
  violin.addNote({ midi: 72, ticks: 240, durationTicks: 480, velocity: 90 / 127 });
  return midi;
}

test('the bundled Node export exposes the expected constructors', () => {
  assert.equal(typeof Midi, 'function');
  assert.equal(typeof Track, 'function');
  assert.equal(typeof Header, 'function');
});

test('imports a small independently specified format-0 MIDI byte fixture', () => {
  // PPQ 480, tempo 120 BPM, C4 at tick 0, note-off at tick 480.
  // This fixed fixture does not depend on the library\'s own encoder.
  const bytes = Uint8Array.from(Buffer.from(
    '4d546864000000060000000101e0' +
    '4d54726b00000014' +
    '00ff510307a12000903c648360803c0000ff2f00',
    'hex',
  ));
  const midi = new Midi(bytes);

  assert.equal(midi.header.ppq, 480);
  assert.equal(midi.tracks.length, 1);
  assert.equal(midi.tracks[0].notes.length, 1);
  const note = midi.tracks[0].notes[0];
  assert.equal(note.midi, 60);
  assert.equal(note.name, 'C4');
  assert.equal(note.ticks, 0);
  assert.equal(note.durationTicks, 480);
  near(note.time, 0);
  near(note.duration, 0.5);
  near(note.velocity, 100 / 127);
  near(midi.duration, 0.5);
});

test('imports generated multitrack MIDI with pitch, timing, names, and programs intact', () => {
  const midi = roundTrip(makeMelodicFixture());

  assert.equal(midi.header.name, 'Medici test score');
  assert.equal(midi.header.ppq, 480);
  assert.deepEqual(midi.header.timeSignatures[0].timeSignature, [4, 4]);
  assert.equal(midi.tracks.length, 2);
  const [piano, violin] = midi.tracks;
  assert.equal(piano.name, 'Piano');
  assert.equal(piano.instrument.number, 0);
  assert.equal(piano.instrument.percussion, false);
  assert.equal(violin.name, 'Violin');
  assert.equal(violin.instrument.number, 40);
  assert.equal(violin.channel, 1);
  assert.deepEqual(piano.notes.map(({ midi, ticks, durationTicks }) =>
    ({ midi, ticks, durationTicks })), [
    { midi: 60, ticks: 0, durationTicks: 480 },
    { midi: 64, ticks: 0, durationTicks: 240 },
    { midi: 67, ticks: 480, durationTicks: 960 },
  ]);
  assert.deepEqual(violin.notes.map((note) => note.midi), [72]);
  near(violin.notes[0].time, 0.25);
  near(violin.notes[0].duration, 0.5);
  near(piano.notes[0].velocity, 100 / 127);
  near(midi.duration, 1.5);
});

test('parses the explicit tempo and converts beat ticks to seconds', () => {
  const source = new Midi();
  source.header.setTempo(90);
  source.addTrack().addNote({ midi: 60, ticks: 480, durationTicks: 960 });
  const midi = roundTrip(source);

  assert.equal(midi.header.tempos.length, 1);
  // Standard MIDI stores integer microseconds per beat, so 90 BPM is rounded.
  assert.ok(Math.abs(midi.header.tempos[0].bpm - 90) < 0.001);
  const beatSeconds = 60 / midi.header.tempos[0].bpm;
  near(midi.tracks[0].notes[0].time, beatSeconds);
  near(midi.tracks[0].notes[0].duration, beatSeconds * 2);
});

test('honors a tempo map, including a note spanning a tempo change', () => {
  const source = new Midi();
  source.header.tempos = [{ ticks: 0, bpm: 120 }, { ticks: 480, bpm: 60 }];
  source.header.update();
  const track = source.addTrack();
  track.addNote({ midi: 60, ticks: 0, durationTicks: 480 });
  track.addNote({ midi: 64, ticks: 240, durationTicks: 480 });
  track.addNote({ midi: 67, ticks: 480, durationTicks: 960 });
  const midi = roundTrip(source);

  assert.deepEqual(midi.header.tempos.map(({ ticks, bpm }) => ({ ticks, bpm })),
    [{ ticks: 0, bpm: 120 }, { ticks: 480, bpm: 60 }]);
  const [before, across, after] = midi.tracks[0].notes;
  near(before.time, 0);
  near(before.duration, 0.5);
  near(across.time, 0.25);
  near(across.duration, 0.75);
  near(after.time, 0.5);
  near(after.duration, 2);
  near(midi.duration, 2.5);
});

test('uses the MIDI default of 120 BPM when there are no tempo events', () => {
  const source = new Midi();
  source.addTrack().addNote({ midi: 60, ticks: 480, durationTicks: 480 });
  const midi = roundTrip(source);

  assert.equal(midi.header.tempos.length, 0);
  near(midi.tracks[0].notes[0].time, 0.5);
  near(midi.tracks[0].notes[0].duration, 0.5);
});

test('rejects non-MIDI and empty byte input (including non-Error throws)', () => {
  for (const input of [new Uint8Array(), Uint8Array.from([0, 1, 2]),
    Uint8Array.from(Buffer.from('This is not a MIDI file'))]) {
    assert.throws(() => new Midi(input),
      (error) => /Bad MIDI file/.test(String(error)),
      'Malformed bytes should not be accepted as a score');
  }
});

test('rejects a MIDI file truncated inside the header', () => {
  const bytes = makeMelodicFixture().toArray().slice(0, 10);
  assert.throws(() => new Midi(bytes));
});

test('a valid empty score imports with no notes and a non-finite vendor duration', () => {
  const source = new Midi();
  source.header.setTempo(120);
  const midi = roundTrip(source);

  assert.equal(midi.tracks.length, 0);
  assert.deepEqual(nonPercussionNotes(midi), []);
  // @tonejs/midi 2.0.28 uses Math.max over its tracks. The app must reject an
  // empty note set before using this value for playback or rendering.
  assert.equal(midi.duration, -Infinity);
  assert.equal(Number.isFinite(midi.duration), false);
});

test('a metadata/control-only track does not create playable notes', () => {
  const source = new Midi();
  const track = source.addTrack();
  track.name = 'No note events';
  track.addCC({ number: 7, ticks: 0, value: 0.8 });
  const midi = roundTrip(source);

  assert.equal(midi.tracks.length, 1);
  assert.equal(midi.tracks[0].name, 'No note events');
  assert.equal(midi.tracks[0].notes.length, 0);
  assert.equal(midi.tracks[0].controlChanges[7].length, 1);
  assert.deepEqual(nonPercussionNotes(midi), []);
  assert.equal(midi.duration, 0);
});

test('percussion classification uses MIDI channel 10 and supports filtering drums', () => {
  const source = makeMelodicFixture();
  const drums = source.addTrack();
  drums.name = 'Drums';
  drums.channel = 9; // MIDI channels are zero-indexed in this library.
  drums.instrument.number = 0; // A piano program must not override the drum channel.
  drums.addNote({ midi: 36, ticks: 0, durationTicks: 120 });
  drums.addNote({ midi: 42, ticks: 240, durationTicks: 120 });
  const midi = roundTrip(source);

  assert.equal(midi.tracks.length, 3);
  assert.deepEqual(midi.tracks.map((track) => track.instrument.percussion),
    [false, false, true]);
  assert.equal(midi.tracks.flatMap((track) => track.notes).length, 6);
  const filtered = nonPercussionNotes(midi);
  assert.equal(filtered.length, 4);
  assert.deepEqual(filtered.map((note) => note.midi).sort((a, b) => a - b),
    [60, 64, 67, 72]);
});

test('a percussion-only file yields no melodic notes after filtering', () => {
  const source = new Midi();
  const drums = source.addTrack();
  drums.channel = 9;
  drums.addNote({ midi: 36, ticks: 0, durationTicks: 120 });
  const midi = roundTrip(source);

  assert.equal(midi.tracks[0].notes.length, 1);
  assert.equal(midi.tracks[0].instrument.percussion, true);
  assert.deepEqual(nonPercussionNotes(midi), []);
});
