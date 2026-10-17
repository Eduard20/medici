/* SPDX-License-Identifier: AGPL-3.0-or-later */
/* MusicXML timing uses quarter-note units until the final MIDI tick conversion. */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./vendor/midi.js').Midi, root);
  } else {
    root.MediciMusicXML = factory(null, root);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (NodeMidi, root) {
  'use strict';

  const LIMITS = Object.freeze({ pages: 100, characters: 16 * 1024 * 1024, parts: 64,
    tracks: 128, measures: 20000, notes: 100000, quarterNotes: 500000 });
  const EPSILON = 1e-7;
  const PITCHES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const elements = node => Array.from(node.children || []).filter(child => child.nodeType === 1);
  const named = (node, name) => elements(node).filter(child => child.localName === name);
  const first = (node, name) => named(node, name)[0];
  const value = (node, name) => {
    const child = first(node, name);
    return child ? child.textContent.trim() : null;
  };
  const fail = message => { throw new Error(`MusicXML: ${message}`); };
  function number(text, label, { minimum = 0, maximum = 10000000, integer = false } = {}) {
    if (text === null || text === '' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) fail(`${label} is missing or invalid.`);
    const result = Number(text);
    if (!Number.isFinite(result) || result < minimum || result > maximum || (integer && !Number.isInteger(result))) fail(`${label} is out of range.`);
    return result;
  }
  function positive(text, label) {
    const result = number(text, label);
    if (result <= 0) fail(`${label} must be greater than zero.`);
    return result;
  }
  function meterFrom(time) {
    if (first(time, 'senza-misura')) return null;
    const beats = named(time, 'beats');
    const types = named(time, 'beat-type');
    if (!beats.length || beats.length !== types.length) fail('A time signature is incomplete.');
    let denominator = 1;
    const pairs = beats.map((beat, i) => {
      const numerator = beat.textContent.trim().split('+').reduce((sum, item) =>
        sum + number(item.trim(), 'Time-signature beats', { minimum: 1, maximum: 255, integer: true }), 0);
      const base = number(types[i].textContent.trim(), 'Time-signature beat type', { minimum: 1, maximum: 128, integer: true });
      if ((base & (base - 1)) !== 0) fail('Time-signature beat type must be a power of two.');
      denominator = Math.max(denominator, base);
      return [numerator, base];
    });
    const numerator = pairs.reduce((sum, pair) => sum + pair[0] * denominator / pair[1], 0);
    if (numerator > 255) fail('Time signature has too many beats.');
    return [numerator, denominator];
  }
  const meterLength = meter => meter ? meter[0] * 4 / meter[1] : 0;
  const sameMeter = (a, b) => a && b && a[0] === b[0] && a[1] === b[1];

  function parsePages(xmlStrings, options = {}) {
    if (!Array.isArray(xmlStrings) || !xmlStrings.length) fail('Provide at least one MusicXML page.');
    if (xmlStrings.length > LIMITS.pages) fail(`At most ${LIMITS.pages} pages can be converted at once.`);
    if (xmlStrings.some(xml => typeof xml !== 'string' || !xml.trim())) fail('A MusicXML page is empty.');
    if (xmlStrings.reduce((sum, xml) => sum + xml.length, 0) > LIMITS.characters) fail('MusicXML input is too large.');
    // Reject obviously oversized scores before constructing an XML DOM. The
    // parsed-note limit below is also authoritative for unusual namespace syntax.
    if (xmlStrings.reduce((sum, xml) => sum + (xml.match(/<(?:[A-Za-z_][\w.-]*:)?note(?:\s|>)/g) || []).length, 0) > LIMITS.notes) fail('The score contains too many notes.');
    const tempo = number(String(options.tempo === undefined ? 100 : options.tempo), 'Tempo', { minimum: 20, maximum: 400 });
    const Parser = options.DOMParser || root.DOMParser;
    if (!Parser) fail('This browser does not provide an XML parser.');
    const Midi = options.Midi || NodeMidi || root.Midi;
    if (typeof Midi !== 'function') fail('The MIDI library has not loaded.');
    const warnings = new Set();
    const warn = text => warnings.add(text);
    const partStates = new Map();
    const tracks = new Map();
    const events = [];
    let globalOffset = 0;
    let inputNoteCount = 0;
    let totalMeasures = 0;
    let title = options.title ? String(options.title).slice(0, 200) : '';

    function getTrack(state, staff) {
      const key = `${state.key}\u0000${staff}`;
      if (!tracks.has(key)) {
        if (tracks.size >= LIMITS.tracks) fail('The score contains too many staves.');
        tracks.set(key, { state, staff, notes: [], ties: new Map() });
      }
      return tracks.get(key);
    }

    function parseMeasure(measure, state, context) {
      let cursor = 0;
      let extent = 0;
      let anchor = null;
      let meter = state.meter;
      const notes = [];
      const meters = [];
      const implicit = measure.getAttribute('implicit') === 'yes' || measure.getAttribute('number') === '0';
      const readDuration = (element, label) => {
        if (!state.divisions) fail(`${context}: divisions must be declared before a duration.`);
        return positive(value(element, 'duration'), `${context}: ${label}`) / state.divisions;
      };
      for (const child of elements(measure)) {
        const kind = child.localName;
        if (kind === 'attributes') {
          const divisions = value(child, 'divisions');
          if (divisions !== null) state.divisions = positive(divisions, `${context}: divisions`);
          const staves = value(child, 'staves');
          if (staves !== null) state.staves = Math.max(state.staves, number(staves, 'Staves', { minimum: 1, maximum: 64, integer: true }));
          for (const time of named(child, 'time')) {
            const signature = meterFrom(time);
            if (time.getAttribute('number') && meters.length && !sameMeter(signature, meters[0].signature)) warn('Different staff time signatures use the longest measure; the MIDI meter follows the first staff.');
            if (!time.getAttribute('number') || time.getAttribute('number') === '1' || !state.meter) {
              state.meter = signature;
              if (cursor < EPSILON) meter = signature;
              else warn('Mid-measure time changes are retained in MIDI; measure alignment may need review.');
              if (signature) meters.push({ offset: cursor, signature });
            }
          }
          for (const transpose of named(child, 'transpose')) {
            const staff = transpose.getAttribute('number') || '*';
            const chromatic = number(value(transpose, 'chromatic'), 'Chromatic transpose', { minimum: -96, maximum: 96, integer: true });
            const octaveText = value(transpose, 'octave-change');
            const octave = octaveText === null ? 0 : number(octaveText, 'Octave transpose', { minimum: -8, maximum: 8, integer: true });
            state.transpose.set(staff, chromatic + 12 * octave);
            if (first(transpose, 'double')) warn('Doubling transpositions are not expanded.');
          }
        } else if (kind === 'backup' || kind === 'forward') {
          const duration = readDuration(child, `${kind} duration`);
          cursor += kind === 'backup' ? -duration : duration;
          if (cursor < -EPSILON) fail(`${context}: backup moves before the start of the measure.`);
          cursor = Math.max(0, cursor);
          extent = Math.max(extent, cursor);
          anchor = null;
        } else if (kind === 'note') {
          if (++inputNoteCount > LIMITS.notes) fail('The score contains too many notes.');
          const rest = first(child, 'rest');
          const pitch = first(child, 'pitch');
          const grace = first(child, 'grace');
          const chord = first(child, 'chord');
          const voice = value(child, 'voice') || '1';
          const staffText = value(child, 'staff');
          const staff = staffText === null ? 1 : number(staffText, 'Staff number', { minimum: 1, maximum: 64, integer: true });
          state.staves = Math.max(state.staves, staff);
          let midiPitch;
          if (rest && pitch) fail(`${context}: a note cannot be both a rest and a pitch.`);
          if (!rest) {
            if (!pitch || named(child, 'pitch').length !== 1) fail(`${context}: a note is missing a supported pitched note.`);
            const step = value(pitch, 'step');
            if (!Object.prototype.hasOwnProperty.call(PITCHES, step)) fail(`${context}: invalid note pitch.`);
            const octave = number(value(pitch, 'octave'), 'Pitch octave', { minimum: -1, maximum: 9, integer: true });
            const alterText = value(pitch, 'alter');
            const alter = alterText === null ? 0 : number(alterText, 'Pitch alteration (whole semitones required)', { minimum: -12, maximum: 12, integer: true });
            const transpose = state.transpose.has(String(staff)) ? state.transpose.get(String(staff)) : state.transpose.get('*') || 0;
            midiPitch = 12 * (octave + 1) + PITCHES[step] + alter + transpose;
            if (!Number.isInteger(midiPitch) || midiPitch < 0 || midiPitch > 127) fail(`${context}: note pitch is outside the MIDI range.`);
          }
          if (grace) {
            warn('Grace notes are omitted; check ornaments against the score.');
            continue;
          }
          let duration;
          if (rest && rest.getAttribute('measure') === 'yes' && value(child, 'duration') === null && meter) {
            duration = meterLength(meter);
            warn('A whole-measure rest without a duration was filled using the time signature.');
          } else duration = readDuration(child, 'note duration');
          let offset = cursor;
          if (chord) {
            if (rest || !anchor || anchor.rest || anchor.voice !== voice) fail(`${context}: a chord note has no preceding note in its voice.`);
            offset = anchor.offset;
            if (duration > anchor.duration + EPSILON) warn('A chord tone is longer than its leading note; check the recognized rhythm.');
          } else {
            anchor = { offset, duration, voice, rest: !!rest };
            cursor += duration;
          }
          extent = Math.max(extent, offset + duration, cursor);
          if (!rest) {
            if (first(child, 'cue')) warn('Cue notes are included as written.');
            const tieTypes = new Set(named(child, 'tie').map(tie => tie.getAttribute('type')));
            for (const notations of named(child, 'notations')) {
              for (const tied of named(notations, 'tied')) tieTypes.add(tied.getAttribute('type'));
            }
            notes.push({ offset, duration, midi: midiPitch, staff, voice,
              startTie: tieTypes.has('start') || tieTypes.has('continue'),
              stopTie: tieTypes.has('stop') || tieTypes.has('continue') });
          }
        }
        if (!Number.isFinite(extent) || extent > LIMITS.quarterNotes) fail(`${context}: measure duration is too large.`);
      }
      return { extent, meter, meters, notes, implicit };
    }

    xmlStrings.forEach((xml, pageIndex) => {
      // Browser DOMParser does not fetch external DTDs. Reject entity declarations
      // and internal subsets rather than allowing untrusted entity expansion.
      if (/<!ENTITY\b/i.test(xml) || /<!DOCTYPE\s[^>]*\[/i.test(xml)) fail('XML entity declarations and internal DTD subsets are not supported.');
      const document = new Parser().parseFromString(xml, 'application/xml');
      const all = Array.from(document.getElementsByTagName('*'));
      if (all.some(element => element.localName === 'parsererror')) fail(`Page ${pageIndex + 1} contains malformed XML.`);
      const score = document.documentElement;
      if (!score || score.localName !== 'score-partwise') fail(`Page ${pageIndex + 1} must be score-partwise MusicXML.`);
      if (!title) {
        const work = first(score, 'work');
        title = (value(score, 'movement-title') || (work && value(work, 'work-title')) || '').slice(0, 200);
      }
      if (all.some(element => ['repeat', 'ending', 'segno', 'coda', 'multiple-rest'].includes(element.localName) ||
          (element.localName === 'sound' && ['dacapo', 'dalsegno', 'tocoda', 'fine'].some(attribute => element.hasAttribute(attribute))))) {
        warn('Repeats, endings, navigation marks, and multi-measure rest shortcuts are not expanded; playback follows written measure order.');
      }
      if (all.some(element => element.localName === 'dynamics' || (element.localName === 'sound' && element.hasAttribute('dynamics')))) warn('Dynamics are not interpreted; all notes use a steady velocity.');
      if (all.some(element => element.localName === 'metronome' || (element.localName === 'sound' && element.hasAttribute('tempo')))) warn('Printed tempo markings are replaced by the selected conversion tempo.');
      if (all.some(element => ['pedal', 'wedge', 'ornaments', 'octave-shift'].includes(element.localName))) warn('Pedal, expressive markings, ornaments, and octave-shift directions are not interpreted.');
      const list = first(score, 'part-list');
      const definitions = new Map();
      if (list) for (const definition of named(list, 'score-part')) {
        const id = definition.getAttribute('id');
        if (definitions.has(id)) fail(`Page ${pageIndex + 1} has duplicate part definitions.`);
        definitions.set(id, definition);
      }
      const parts = named(score, 'part');
      if (!parts.length || parts.length > LIMITS.parts) fail(`Page ${pageIndex + 1} has no parts or too many parts.`);
      const namesSeen = new Map();
      const idsSeen = new Set();
      const parsedParts = parts.map((part, partIndex) => {
        const id = part.getAttribute('id');
        if (!id || idsSeen.has(id)) fail(`Page ${pageIndex + 1} has a missing or duplicate part ID.`);
        idsSeen.add(id);
        const definition = definitions.get(id);
        const partName = definition && value(definition, 'part-name');
        const displayName = partName || `Part ${partIndex + 1}`;
        const occurrence = (namesSeen.get(displayName) || 0) + 1;
        namesSeen.set(displayName, occurrence);
        // OMR exporters often generate fresh random part IDs on every page.
        // Names + occurrence preserve the same named instruments across pages.
        const key = `${displayName}\u0000${occurrence}`;
        let state = partStates.get(key);
        if (!state) {
          if (partStates.size >= LIMITS.parts) fail('The score contains too many distinct parts.');
          state = { key, name: displayName, divisions: null, meter: null, staves: 1, transpose: new Map(), program: 0 };
          const instrument = definition && first(definition, 'midi-instrument');
          const program = instrument && value(instrument, 'midi-program');
          if (program !== null && program !== undefined) state.program = number(program, 'MIDI program', { minimum: 1, maximum: 128, integer: true }) - 1;
          if (pageIndex) warn('Part names or layout change between pages; unmatched parts are kept as separate tracks.');
          partStates.set(key, state);
        }
        const measures = named(part, 'measure');
        if (!measures.length) fail(`Page ${pageIndex + 1}, ${displayName} has no measures.`);
        if (measures.length > LIMITS.measures) fail('The score contains too many measures.');
        return { state, measures: measures.map((measure, measureIndex) => parseMeasure(measure, state,
          `Page ${pageIndex + 1}, ${displayName}, measure ${measureIndex + 1}`)) };
      });
      const count = Math.max(...parsedParts.map(part => part.measures.length));
      totalMeasures += count;
      if (totalMeasures > LIMITS.measures) fail('The score contains too many measures.');
      if (parsedParts.some(part => part.measures.length !== count)) warn('Parts have different measure counts; measures are aligned by position and missing trailing measures are silent.');
      for (let index = 0; index < count; index++) {
        const present = parsedParts.map(part => part.measures[index]).filter(Boolean);
        const extent = Math.max(0, ...present.map(measure => measure.extent));
        const nominal = Math.max(0, ...present.map(measure => meterLength(measure.meter)));
        const implicit = present.some(measure => measure.implicit);
        const length = implicit ? (extent || nominal) : Math.max(extent, nominal);
        if (length <= 0) fail(`Page ${pageIndex + 1}, measure ${index + 1} has no usable duration.`);
        if (!implicit && nominal && extent > nominal + EPSILON) warn('An overfull measure was kept at its written duration; check the recognized rhythm.');
        const signatures = present.filter(measure => measure.meter).map(measure => measure.meter);
        if (signatures.some(signature => !sameMeter(signature, signatures[0]))) warn('Parts have different time signatures; alignment uses the longest measure and MIDI follows the first part.');
        const meterSource = present.find(measure => measure.meters.length);
        if (meterSource) for (const event of meterSource.meters) events.push({ offset: globalOffset + event.offset, signature: event.signature });
        for (const part of parsedParts) {
          const measure = part.measures[index];
          if (!measure) continue;
          for (const note of measure.notes) {
            const track = getTrack(part.state, note.staff);
            const start = globalOffset + note.offset;
            const tieKey = `${note.voice}\u0000${note.midi}`;
            const previous = track.ties.get(tieKey);
            let output;
            if (note.stopTie && previous && Math.abs(previous.start + previous.duration - start) < EPSILON) {
              previous.duration += note.duration;
              output = previous;
              track.ties.delete(tieKey);
            } else {
              if (note.stopTie) warn('An unmatched or interrupted tie was played as a separate note.');
              if (previous) {
                warn('An unmatched or interrupted tie was played as a separate note.');
                track.ties.delete(tieKey);
              }
              output = { start, duration: note.duration, midi: note.midi };
              track.notes.push(output);
            }
            if (note.startTie) track.ties.set(tieKey, output);
          }
        }
        globalOffset += length;
        if (globalOffset > LIMITS.quarterNotes) fail('The score is too long to convert safely.');
      }
    });

    if (!tracks.size) fail('No playable pitched notes were recognized.');
    const midi = new Midi();
    midi.header.name = title || 'Converted score';
    midi.header.setTempo(tempo);
    let previousMeter = null;
    for (const event of events) {
      if (!sameMeter(previousMeter, event.signature)) {
        midi.header.timeSignatures.push({ ticks: Math.round(event.offset * midi.header.ppq), timeSignature: event.signature });
        previousMeter = event.signature;
      }
    }
    if (!midi.header.timeSignatures.length || midi.header.timeSignatures[0].ticks !== 0) midi.header.timeSignatures.unshift({ ticks: 0, timeSignature: [4, 4] });
    midi.header.update();
    if (tracks.size > 15) warn('More than 15 melodic staves share MIDI channels; separate track names are preserved.');
    let noteCount = 0;
    let trackIndex = 0;
    for (const data of tracks.values()) {
      const track = midi.addTrack();
      const channel = trackIndex++ % 15;
      track.channel = channel >= 9 ? channel + 1 : channel;
      track.name = data.state.name + (data.state.staves > 1 ? ` · staff ${data.staff}` : '');
      track.instrument.number = data.state.program;
      for (const note of data.notes) {
        const ticks = Math.round(note.start * midi.header.ppq);
        const end = Math.round((note.start + note.duration) * midi.header.ppq);
        const durationTicks = Math.max(1, end - ticks);
        if (Math.abs(ticks / midi.header.ppq - note.start) > EPSILON || Math.abs(durationTicks / midi.header.ppq - note.duration) > EPSILON) warn('Some rhythms were rounded to the nearest MIDI tick.');
        track.addNote({ midi: note.midi, ticks, durationTicks, velocity: 0.8 });
        noteCount++;
      }
      track.endOfTrackTicks = Math.max(Math.round(globalOffset * midi.header.ppq), track.durationTicks);
      // The bundled encoder ignores endOfTrackTicks. A silent all-notes-off
      // event preserves final rests without manufacturing a sounding note.
      track.addCC({ number: 123, value: 0, ticks: track.endOfTrackTicks });
      if (data.ties.size) warn('Some ties have no ending note; their written duration was retained.');
    }
    const bytes = midi.toArray();
    return { bytes, midi, summary: { pages: xmlStrings.length, parts: partStates.size, tracks: tracks.size,
      notes: noteCount, measures: totalMeasures, tempo, durationSeconds: globalOffset * 60 / tempo,
      warnings: Array.from(warnings) } };
  }

  return Object.freeze({ parsePages, LIMITS });
});
