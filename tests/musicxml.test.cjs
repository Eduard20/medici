'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
let JSDOM;
try { ({ JSDOM } = require('jsdom')); }
catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
  ({ JSDOM } = require(path.join(__dirname, '../../.testdeps/node_modules/jsdom')));
}
const { Midi } = require('../vendor/midi.js');
const { parsePages, LIMITS } = require('../musicxml-midi.js');
const dom = new JSDOM('');
const DOMParser = dom.window.DOMParser;
const convert = (pages, options = {}) => parsePages(Array.isArray(pages) ? pages : [pages], { DOMParser, ...options });
const decode = result => new Midi(result.bytes);
const attrs = (divisions = 1, meter = '<beats>4</beats><beat-type>4</beat-type>', extra = '') =>
  `<attributes><divisions>${divisions}</divisions>${meter ? `<time>${meter}</time>` : ''}${extra}</attributes>`;
const note = (step = 'C', duration = 1, extra = '', pitchExtra = '', octave = 4) =>
  `<note>${extra}<pitch><step>${step}</step>${pitchExtra}<octave>${octave}</octave></pitch><duration>${duration}</duration></note>`;
const rest = duration => `<note><rest/><duration>${duration}</duration></note>`;
const measure = (body, extra = '') => `<measure ${extra}>${body}</measure>`;
const score = (body, { id = 'P1', name = 'Piano', preamble = '', definition = '', title = '' } = {}) =>
  `${preamble}<score-partwise version="4.0">${title}<part-list><score-part id="${id}"><part-name>${name}</part-name>${definition}</score-part></part-list><part id="${id}">${body}</part></score-partwise>`;
const notes = result => decode(result).tracks.flatMap(track => track.notes).map(({ midi, ticks, durationTicks }) => ({ midi, ticks, durationTicks }));

test('exports a standalone browser UMD API using the bundled Midi global', () => {
  const browser = new JSDOM('', { runScripts: 'outside-only' });
  browser.window.eval(fs.readFileSync(path.join(__dirname, '../vendor/midi.js'), 'utf8'));
  browser.window.eval(fs.readFileSync(path.join(__dirname, '../musicxml-midi.js'), 'utf8'));
  const result = browser.window.MediciMusicXML.parsePages([score(measure(attrs() + note()))]);
  assert.equal(result.summary.notes, 1);
  assert.equal(result.bytes.constructor.name, 'Uint8Array');
  assert.equal(new Midi(result.bytes).tracks[0].notes[0].midi, 60);
  browser.window.close();
});

test('uses 100 BPM by default, preserves title, names, program and trailing rest', () => {
  const result = convert(score(measure(attrs() + note() + rest(3)), {
    name: 'Violin', title: '<work><work-title>Little &amp; Large</work-title></work>',
    definition: '<midi-instrument id="I1"><midi-program>41</midi-program></midi-instrument>',
  }));
  const midi = decode(result);
  assert.equal(result.summary.tempo, 100);
  assert.equal(result.summary.durationSeconds, 2.4);
  assert.equal(midi.header.tempos[0].bpm, 100);
  assert.equal(midi.header.name, 'Little & Large');
  assert.equal(midi.tracks[0].name, 'Violin');
  assert.equal(midi.tracks[0].instrument.number, 40);
  assert.equal(midi.tracks[0].endOfTrackTicks, 1920);
  assert.deepEqual(result.summary.warnings, []);
});

test('retains same-onset chord tones, rests, pitch alterations, octaves, and divisions', () => {
  const result = convert(score(measure(attrs(8) + note('C', 8, '', '<alter>1</alter>') +
    note('E', 8, '<chord/>', '<alter>-1</alter>') + rest(4) + note('B', 4, '', '', 5))));
  assert.deepEqual(notes(result), [
    { midi: 61, ticks: 0, durationTicks: 480 },
    { midi: 63, ticks: 0, durationTicks: 480 },
    { midi: 83, ticks: 720, durationTicks: 240 },
  ]);
});

test('aligns simultaneous parts to common bar boundaries despite rests and short bars', () => {
  const xml = `<score-partwise><part-list><score-part id="P1"><part-name>Flute</part-name></score-part><score-part id="P2"><part-name>Cello</part-name></score-part></part-list>
    <part id="P1">${measure(attrs() + note('C'))}${measure(note('D'))}</part>
    <part id="P2">${measure(attrs(2) + rest(6) + note('C', 2, '', '', 3))}${measure(note('E', 2))}</part></score-partwise>`;
  const result = convert(xml);
  const midi = decode(result);
  assert.equal(result.summary.parts, 2);
  assert.deepEqual(midi.tracks.map(track => track.name), ['Flute', 'Cello']);
  assert.deepEqual(midi.tracks[0].notes.map(note => note.ticks), [0, 1920]);
  assert.deepEqual(midi.tracks[1].notes.map(note => note.ticks), [1440, 1920]);
});

test('keeps staff tracks with backup/forward and multiple voices on the same measure clock', () => {
  const result = convert(score(measure(attrs(1, undefined, '<staves>2</staves>') +
    note('C', 4, '<voice>1</voice><staff>1</staff>') + '<backup><duration>4</duration></backup>' +
    note('C', 2, '<voice>2</voice><staff>2</staff>', '', 3) + '<forward><duration>1</duration></forward>' +
    note('G', 1, '<voice>2</voice><staff>2</staff>', '', 3)) + measure(note('E', 1, '<staff>1</staff>'))));
  const midi = decode(result);
  assert.deepEqual(midi.tracks.map(track => track.name), ['Piano · staff 1', 'Piano · staff 2']);
  assert.deepEqual(midi.tracks[1].notes.map(note => note.ticks), [0, 1440]);
  assert.equal(midi.tracks[0].notes[1].ticks, 1920);
  assert.deepEqual(midi.tracks.map(track => track.channel), [0, 1]);
});

test('appends pages while matching OMR parts with newly generated IDs', () => {
  const result = convert([
    score(measure(attrs() + note('C', 4)), { id: 'random-123' }),
    score(measure(attrs() + rest(1) + note('D', 3)), { id: 'random-456' }),
  ], { tempo: 120, title: 'User title' });
  assert.equal(result.summary.pages, 2);
  assert.equal(result.summary.tracks, 1);
  assert.equal(result.summary.parts, 1);
  assert.equal(result.summary.measures, 2);
  assert.equal(decode(result).header.name, 'User title');
  assert.deepEqual(notes(result).map(note => note.ticks), [0, 2400]);
  assert.equal(result.summary.durationSeconds, 4);
});

test('inherits divisions and meter at a page boundary', () => {
  const result = convert([
    score(measure(attrs(2, '<beats>3</beats><beat-type>4</beat-type>') + note('C', 6))),
    score(measure(note('D', 6))),
  ]);
  assert.deepEqual(notes(result).map(note => [note.ticks, note.durationTicks]), [[0, 1440], [1440, 1440]]);
});

test('coalesces ties across measures and pages including tied-notation equivalents', () => {
  const result = convert([
    score(measure(attrs() + note('C', 4, '<tie type="start"/><notations><tied type="start"/></notations>'))),
    score(measure(attrs() + note('C', 4, '<tie type="stop"/><tie type="start"/>')) +
      measure(note('C', 1, '<notations><tied type="stop"/></notations>') + rest(3))),
  ]);
  assert.deepEqual(notes(result), [{ midi: 60, ticks: 0, durationTicks: 4320 }]);
  assert.equal(result.summary.notes, 1);
  assert.equal(result.summary.warnings.length, 0);
});

test('keeps ties for independent voices distinct and warns for unmatched ties', () => {
  const result = convert(score(measure(attrs() + note('C', 4, '<voice>1</voice><tie type="start"/>') +
    '<backup><duration>4</duration></backup>' + note('C', 4, '<voice>2</voice><tie type="stop"/>')) +
    measure(note('C', 4, '<voice>1</voice><tie type="stop"/>'))));
  assert.deepEqual(notes(result).map(note => note.durationTicks).sort((a, b) => a - b), [1920, 3840]);
  assert.match(result.summary.warnings.join(' '), /unmatched or interrupted tie/);
});

test('honors pickups, additive signatures, changing meter, and tuplets from durations', () => {
  const result = convert(score(
    measure(attrs(3, '<beats>3+2</beats><beat-type>8</beat-type>') + note('C', 3), 'implicit="yes"') +
    measure(note('D', 1) + note('E', 1) + note('F', 1)) +
    measure(attrs(3, '<beats>3</beats><beat-type>4</beat-type>') + note('G', 9))));
  assert.deepEqual(notes(result).map(note => note.ticks), [0, 480, 640, 800, 1680]);
  const signatures = decode(result).header.timeSignatures;
  assert.deepEqual(signatures.map(event => [event.ticks, event.timeSignature]), [[0, [5, 8]], [1680, [3, 4]]]);
});

test('combines mixed beat groups using a common denominator', () => {
  const result = convert(score(measure(attrs(2, '<beats>2</beats><beat-type>4</beat-type><beats>3</beats><beat-type>8</beat-type>') + note('C', 7))));
  assert.deepEqual(decode(result).header.timeSignatures[0].timeSignature, [7, 8]);
});

test('retains overfull bar duration and aligns the next measure safely', () => {
  const result = convert(score(measure(attrs() + note('C', 5)) + measure(note('D'))));
  assert.equal(notes(result)[1].ticks, 2400);
  assert.match(result.summary.warnings.join(' '), /overfull measure/);
});

test('does not invent full-bar padding if the score never declares a meter', () => {
  const result = convert(score(measure(attrs(1, '') + note()) + measure(note('D'))));
  assert.equal(notes(result)[1].ticks, 480);
  assert.deepEqual(decode(result).header.timeSignatures[0].timeSignature, [4, 4]);
});

test('supports whole-measure rests without a duration when the meter is known', () => {
  const result = convert(score(measure(attrs() + '<note><rest measure="yes"/></note>') + measure(note())));
  assert.equal(notes(result)[0].ticks, 1920);
  assert.match(result.summary.warnings.join(' '), /whole-measure rest/);
});

test('reads namespaces and common public MusicXML DTDs without external fetches', () => {
  const xml = score(measure(attrs() + note()), { preamble: '<?xml version="1.0"?><!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">' })
    .replace('<score-partwise version="4.0">', '<score-partwise xmlns="http://www.musicxml.org/ns/musicxml" version="4.0">');
  assert.equal(convert(xml).summary.notes, 1);
});

test('applies chromatic and octave transposition', () => {
  const result = convert(score(measure(attrs(1, undefined, '<transpose><diatonic>-1</diatonic><chromatic>-2</chromatic><octave-change>-1</octave-change></transpose>') + note('C'))));
  assert.equal(notes(result)[0].midi, 46);
});

test('warns about unsupported repeats, dynamics, tempo marks, and grace notes', () => {
  const result = convert(score(measure(attrs() + '<direction><direction-type><dynamics><f/></dynamics><metronome><beat-unit>quarter</beat-unit><per-minute>70</per-minute></metronome></direction-type><sound tempo="70" dynamics="90"/></direction>' +
    '<note><grace/><pitch><step>D</step><octave>4</octave></pitch></note>' + note() + '<barline><repeat direction="backward"/></barline>')));
  assert.equal(result.summary.notes, 1);
  for (const term of ['Repeats', 'Dynamics', 'tempo markings', 'Grace notes']) assert.ok(result.summary.warnings.some(warning => warning.includes(term)));
  assert.equal(decode(result).header.tempos[0].bpm, 100);
});

test('rejects empty, malformed, non-partwise, and entity-expanding XML', () => {
  for (const pages of [[], [''], ['<score-partwise>'], ['<score-timewise/>'], ['<!DOCTYPE score-partwise [<!ENTITY x "x">]><score-partwise/>']]) {
    assert.throws(() => convert(pages), /MusicXML:/);
  }
  assert.throws(() => convert(score(measure(attrs() + rest(4)))), /No playable pitched notes/);
});

test('rejects invalid pitches, durations, divisions, chords, staff numbers, and backups', () => {
  const invalid = [
    attrs() + note('H'),
    attrs() + note('C', 0),
    attrs() + note('C', -1),
    attrs() + note('C', 'NaN'),
    attrs(0) + note(),
    attrs() + note('C', 1, '<chord/>'),
    attrs() + note('C', 1, '<staff>0</staff>'),
    attrs() + note('C', 1, '', '<alter>0.5</alter>'),
    attrs() + note('G', 1, '', '<alter>1</alter>', 9),
    attrs() + '<backup><duration>1</duration></backup>' + note(),
    attrs() + '<note><pitch><step>C</step><octave>4</octave></pitch></note>',
    note(),
  ];
  for (const body of invalid) assert.throws(() => convert(score(measure(body))), /MusicXML:/, body);
});

test('enforces page, tempo, note, and duration safety bounds', () => {
  assert.throws(() => convert(Array(LIMITS.pages + 1).fill('<score-partwise/>')), /At most/);
  for (const tempo of [0, -10, 500, Infinity, 'largo']) assert.throws(() => convert(score(measure(attrs() + note())), { tempo }), /Tempo/);
  assert.throws(() => convert(score(measure(attrs() + note('C', LIMITS.quarterNotes + 1)))), /duration is too large/);
  assert.throws(() => convert(score(measure(attrs() + note().repeat(LIMITS.notes + 1)))), /too many notes|too large/);
});
