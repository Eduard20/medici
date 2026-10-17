/* Sheet Music Studio. PDF pages and recognized notes stay on this device. */
'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const label = name => name.replaceAll('_', ' ').replace(/^./, c => c.toUpperCase());
  const clock = seconds => `${Math.floor(Math.max(0, seconds) / 60)}:${String(Math.floor(Math.max(0, seconds) % 60)).padStart(2, '0')}`;
  const status = (message, error = false) => { $('status').textContent = message; $('status').classList.toggle('error', error); };
  const state = { context: null, gain: null, samples: new Map(), instrument: 'acoustic_grand_piano', score: null, notes: [], duration: 0, offset: 0, started: 0, playing: false, loading: false, speed: 1, transpose: 0, loop: false, next: 0, token: 0, active: new Set(), timer: null, previewTimer: null, previewing: false };
  let playbackAudioSession = null;
  let importToken = 0;
  let preferencesRevision = 0;
  let preferencesTimer = null;
  let databasePromise = null;
  let storageQueue = Promise.resolve();
  let knownInstruments = null;
  let view = 'library';
  let libraryEntries = [];
  let currentEntry = null;
  let libraryReady;
  const sessionEntries = new Map();
  const pendingRemovals = new Set();
  const scoreTitle = name => (typeof name === 'string' ? name : 'Saved score').replace(/\.midi?$/i, '');
  const entryId = () => window.crypto?.randomUUID?.() || `score-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  function setView(next, focus = false) {
    view = next;
    $('studio').dataset.view = next;
    const visible = {
      'library-intro': next === 'library', 'upload-score': next !== 'score',
      'saved-music': next === 'library', 'workspace-heading': next === 'score',
      'choose-sound': next === 'score', 'play-score': next === 'score'
    };
    for (const [id, show] of Object.entries(visible)) {
      $(id).hidden = !show;
      $(id).toggleAttribute('inert', !show);
    }
    $('conversion-title').hidden = next !== 'converting';
    // Upload options stay out of the keyboard order while only progress is shown.
    document.querySelectorAll('.sheet-upload, .sheet-options, .catalogue').forEach(element => element.toggleAttribute('inert', next === 'converting'));
    if (focus) {
      const target = $(next === 'score' ? 'choose-sound-title' : next === 'converting' ? 'conversion-title' : 'upload-title');
      target.focus({preventScroll: true});
      (next === 'score' ? $('workspace-heading') : target).scrollIntoView?.({block: 'start', behavior: 'auto'});
    }
  }
  function renderLibrary() {
    const entries = [...libraryEntries];
    for (const entry of sessionEntries.values()) if (!entries.some(saved => saved.id === entry.id)) entries.unshift({...entry, temporary: true});
    const shown = entries.filter(entry => !pendingRemovals.has(entry.id));
    $('saved-music-empty').hidden = shown.length > 0;
    $('saved-music-count').textContent = shown.length ? `${shown.length} ${shown.length === 1 ? 'piece' : 'pieces'}` : 'On this device';
    $('saved-music-list').replaceChildren(...shown.map(entry => {
      const item = document.createElement('div'); item.className = 'saved-piece';
      const open = document.createElement('button'); open.type = 'button'; open.className = 'saved-piece-open'; open.dataset.scoreId = entry.id;
      const icon = document.createElement('span'); icon.className = 'saved-piece-icon'; icon.textContent = '♫'; icon.setAttribute('aria-hidden', 'true');
      const copy = document.createElement('span'); copy.className = 'saved-piece-copy';
      const title = document.createElement('strong'); title.textContent = scoreTitle(entry.name || 'Saved score');
      const meta = document.createElement('small'); meta.textContent = entry.temporary ? 'This visit only · not saved' : 'Saved on this device';
      const arrow = document.createElement('span'); arrow.className = 'saved-piece-arrow'; arrow.textContent = '↗'; arrow.setAttribute('aria-hidden', 'true');
      copy.append(title, meta); open.append(icon, copy, arrow); open.addEventListener('click', () => openEntry(entry));
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'saved-piece-remove'; remove.textContent = '×'; remove.setAttribute('aria-label', `Remove ${scoreTitle(entry.name || 'saved score')}`); remove.addEventListener('click', () => removeEntry(entry));
      item.append(open, remove); return item;
    }));
  }
  function unpackLibrary(saved) {
    if (!saved) return [];
    const entries = [{...saved, id: saved.id || 'legacy-pdf-score'}, ...(Array.isArray(saved.entries) ? saved.entries : [])];
    const ids = new Set();
    return entries.map(entry => ({version: entry.version, id: entry.id || entryId(), name: entry.name, bytes: entry.bytes, savedAt: entry.savedAt, warning: entry.warning, source: window.MediciCatalogue?.sanitizeSource(entry.source) || null})).filter(entry => {
      if (ids.has(entry.id)) return false;
      ids.add(entry.id); return true;
    });
  }
  function changeLibrary(change) {
    const next = storageQueue.catch(() => {}).then(async () => {
      await libraryReady;
      const db = await database();
      const entries = await new Promise((resolve, reject) => {
        let transaction, updated, settled = false;
        const finish = error => {
          if (settled) return;
          settled = true; clearTimeout(timeout);
          error ? reject(error) : resolve(updated);
        };
        const timeout = setTimeout(() => {
          try { transaction?.abort(); } catch {}
          finish(new Error('Browser storage did not respond.'));
        }, 8000);
        try {
          // Read and update within one transaction, so another tab's saves are
          // preserved even when this tab's visible library is out of date.
          transaction = db.transaction('local', 'readwrite');
          const store = transaction.objectStore('local');
          const request = store.get('pdf-arrangement');
          request.onsuccess = () => {
            try {
              updated = change(unpackLibrary(request.result));
              if (updated.length) store.put({...updated[0], entries: updated.slice(1)}, 'pdf-arrangement');
              else store.delete('pdf-arrangement');
            } catch (error) { transaction.abort(); finish(error); }
          };
          transaction.oncomplete = () => finish();
          transaction.onerror = () => finish(transaction.error || new Error('Browser storage failed.'));
          transaction.onabort = () => finish(transaction.error || new Error('Browser storage was interrupted.'));
        } catch (error) { finish(error); }
      });
      libraryEntries = entries; renderLibrary();
    });
    storageQueue = next;
    return next;
  }
  function openEntry(entry) {
    try {
      if (entry.version !== 1 || typeof entry.name !== 'string' || !/\.midi?$/i.test(entry.name)) throw new Error('Unsupported saved score.');
      const midi = parseScore(entry.bytes);
      ++importToken;
      window.dispatchEvent(new Event('medici:cancel-pdf'));
      currentEntry = entry;
      showScore(midi, entry.name);
      $('score-recognition-note').textContent = entry.warning || 'Experimental recognition. Check the notes and timing against your sheet music.';
      status('Your saved score is ready. Choose a sound and press Play.');
      setView('score', true);
    } catch {
      storageStatus('Couldn’t open this saved score. Upload its PDF again, or use its remove button to delete the damaged copy.', true);
    }
  }
  $('back-to-library').addEventListener('click', () => { stop(false); stopPreview(); window.dispatchEvent(new Event('medici:cancel-pdf')); renderLibrary(); setView('library', true); });
  $('download-score').addEventListener('click', () => {
    if (!currentEntry?.bytes) return;
    const url = URL.createObjectURL(new Blob([currentEntry.bytes], {type: 'audio/midi'}));
    const link = document.createElement('a'); link.href = url; link.download = currentEntry.name; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  });
  // An inline sound library: small starting palette, searchable full catalog.
  const featuredInstruments = ['acoustic_grand_piano', 'acoustic_guitar_nylon', 'violin', 'cello', 'orchestral_harp', 'flute', 'choir_aahs', 'celesta'];
  let soundFamily = 'featured';
  const families = {
    keys: 'Piano & keys', strings: 'Strings', guitars: 'Guitar & bass', winds: 'Winds & brass',
    voices: 'Voices', synths: 'Synths', percussion: 'Percussion', effects: 'Sound effects'
  };
  const familyMembers = {
    keys: ['acoustic_grand_piano','bright_acoustic_piano','electric_grand_piano','honkytonk_piano','electric_piano_1','electric_piano_2','harpsichord','clavinet','celesta','drawbar_organ','percussive_organ','rock_organ','church_organ','reed_organ'],
    strings: ['violin','viola','cello','contrabass','fiddle','tremolo_strings','pizzicato_strings','orchestral_harp','string_ensemble_1','string_ensemble_2'],
    guitars: ['acoustic_guitar_nylon','acoustic_guitar_steel','electric_guitar_jazz','electric_guitar_clean','electric_guitar_muted','overdriven_guitar','distortion_guitar','guitar_harmonics','acoustic_bass','electric_bass_finger','electric_bass_pick','fretless_bass','slap_bass_1','slap_bass_2','banjo','sitar','shamisen','koto'],
    winds: ['accordion','tango_accordion','harmonica','trumpet','trombone','tuba','muted_trumpet','french_horn','brass_section','soprano_sax','alto_sax','tenor_sax','baritone_sax','oboe','english_horn','bassoon','clarinet','piccolo','flute','recorder','pan_flute','blown_bottle','shakuhachi','whistle','ocarina','bagpipe','shanai'],
    voices: ['choir_aahs','voice_oohs','synth_choir'],
    percussion: ['glockenspiel','music_box','vibraphone','marimba','xylophone','tubular_bells','dulcimer','timpani','tinkle_bell','agogo','steel_drums','woodblock','taiko_drum','melodic_tom','synth_drum','reverse_cymbal','kalimba'],
    effects: ['guitar_fret_noise','breath_noise','seashore','bird_tweet','telephone_ring','helicopter','applause','gunshot','orchestra_hit']
  };
  const soundNames = {
    acoustic_grand_piano: 'Grand piano', acoustic_guitar_nylon: 'Nylon guitar', acoustic_guitar_steel: 'Steel-string guitar',
    orchestral_harp: 'Harp', choir_aahs: 'Choir · aahs', voice_oohs: 'Voices · oohs', celesta: 'Celesta',
    honkytonk_piano: 'Honky-tonk piano', electric_bass_finger: 'Fingered electric bass', electric_bass_pick: 'Picked electric bass'
  };
  const soundMoods = {acoustic_grand_piano: 'Timeless & intimate', acoustic_guitar_nylon: 'Warm & earthy', violin: 'Lyrical & tender', cello: 'Deep & soulful', orchestral_harp: 'Light & flowing', flute: 'Airy & graceful', choir_aahs: 'Soft & celestial', celesta: 'Delicate & dreamlike'};
  const soundIcons = {
    keys: '<rect x="4" y="5" width="24" height="22" rx="2"/><path d="M10 5v22M16 5v22M22 5v22M9 5v12h3V5M20 5v12h3V5"/>',
    strings: '<path d="m21 3 7 2-1 7-7 7c3 3 1 7-2 9-5 3-14-6-11-11 2-3 6-5 9-2l7-7ZM9 25 24 7M15 21l-4-4M25 3l4 4"/>',
    guitars: '<path d="m22 3 5 5-8 9c4 6-1 12-6 12S3 24 3 19s6-10 12-6ZM9 23l3-3M14 17l3-3M22 4l4 4"/><circle cx="13" cy="19" r="3"/>',
    winds: '<path d="M7 27 27 7M4 24l4 4M24 4l4 4M11 22l-2-2M15 18l-2-2M19 14l-2-2M23 10l-2-2"/>',
    voices: '<path d="M11 14V8a5 5 0 0 1 10 0v6a5 5 0 0 1-10 0ZM7 13a9 9 0 0 0 18 0M16 22v6M11 28h10"/>',
    synths: '<path d="M3 16h4l3-9 5 20 5-22 4 11h5"/>',
    percussion: '<ellipse cx="16" cy="12" rx="11" ry="5"/><path d="M5 12v12c3 6 19 6 22 0V12M9 16l4 12 6-12 5 10M10 3l9 5M24 2l-4 7"/>',
    effects: '<path d="m16 3 3 9 10 4-10 3-3 10-3-10-10-3 10-4ZM26 3v5M24 5h5"/>'
  };
  const soundFamilyFor = name => Object.keys(familyMembers).find(family => familyMembers[family].includes(name)) || 'synths';
  const soundName = name => soundNames[name] || label(name).replace(/\bfx\b/i, 'FX').replace(/_/g, ' ');
  const iconMarkup = family => `<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${soundIcons[family]}</svg>`;
  const searchText = text => text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[_·-]/g, ' ').replace(/\s+/g, ' ').trim();
  function matchesSound(name, query) {
    const family = soundFamilyFor(name);
    const text = searchText(`${name} ${soundName(name)} ${families[family]} ${soundMoods[name] || ''} ${family === 'voices' ? 'choir voice' : ''} ${name.endsWith('_sax') ? 'saxophone' : ''}`);
    return query.split(' ').every(word => text.includes(word)) || text.replaceAll(' ', '').includes(query.replaceAll(' ', ''));
  }
  function syncInstrumentUI() {
    $('instrument-select').value = state.instrument;
    $('instrument-badge').textContent = label(state.instrument).replace('Acoustic grand ', '').toUpperCase();
    $('selected-instrument').textContent = soundName(state.instrument);
    const family = soundFamilyFor(state.instrument);
    $('selected-instrument-family').textContent = families[family];
    $('selected-instrument-icon').innerHTML = iconMarkup(family);
    document.querySelectorAll('[data-instrument]').forEach(button => {
      const active = button.dataset.instrument === state.instrument;
      button.classList.toggle('selected', active);
      button.setAttribute('aria-pressed', String(active));
      button.querySelector('.sound-check').textContent = active ? '✓' : '+';
    });
  }
  function renderInstruments() {
    const query = searchText($('instrument-search').value);
    const catalog = knownInstruments || featuredInstruments;
    let names = query ? catalog.filter(name => matchesSound(name, query)) : soundFamily === 'featured' ? featuredInstruments.filter(name => catalog.includes(name)) : soundFamily === 'all' ? catalog : catalog.filter(name => soundFamilyFor(name) === soundFamily);
    const grid = $('instrument-results');
    grid.replaceChildren(...names.map(name => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'instrument'; button.dataset.instrument = name;
      const icon = document.createElement('span'); icon.className = 'instrument-symbol'; icon.innerHTML = iconMarkup(soundFamilyFor(name));
      const copy = document.createElement('span'); copy.className = 'sound-copy';
      const title = document.createElement('strong'); title.textContent = soundName(name);
      const subtitle = document.createElement('small'); subtitle.textContent = soundMoods[name] || families[soundFamilyFor(name)];
      const check = document.createElement('span'); check.className = 'sound-check'; check.setAttribute('aria-hidden', 'true');
      copy.append(title, subtitle); button.append(icon, copy, check);
      button.addEventListener('click', () => selectInstrument(name));
      return button;
    }));
    grid.hidden = names.length === 0;
    $('instrument-empty').hidden = names.length !== 0;
    $('clear-instrument-search').hidden = !$('instrument-search').value;
    $('instrument-result-count').textContent = `${names.length} ${names.length === 1 ? 'sound' : 'sounds'}${query ? ' found across all instruments' : soundFamily === 'featured' ? ' chosen for this feeling' : soundFamily === 'all' ? ' to explore' : ' · ' + families[soundFamily]}`;
    document.querySelectorAll('[data-family]').forEach(button => button.setAttribute('aria-pressed', String(!query && button.dataset.family === soundFamily)));
    syncInstrumentUI();
  }
  $('instrument-search').addEventListener('input', renderInstruments);
  $('instrument-search').addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); $('instrument-search').value = ''; renderInstruments(); } });
  $('clear-instrument-search').addEventListener('click', () => { $('instrument-search').value = ''; renderInstruments(); $('instrument-search').focus(); });
  $('reset-instrument-search').addEventListener('click', () => { soundFamily = 'all'; $('instrument-search').value = ''; renderInstruments(); $('instrument-search').focus(); });
  document.querySelectorAll('[data-family]').forEach(button => button.addEventListener('click', () => {
    soundFamily = button.dataset.family; $('instrument-search').value = ''; renderInstruments();
    $('instrument-results').scrollTop = 0;
  }));
  $('instrument-select').replaceChildren(...featuredInstruments.map(name => new Option(label(name), name)));
  renderInstruments();
  const storageStatus = (message, error = false) => {
    $('storage-status').textContent = message;
    $('storage-status').classList.toggle('error', error);
  };
  function database() {
    if (!databasePromise) {
      databasePromise = new Promise((resolve, reject) => {
        if (!window.indexedDB) { reject(new Error('Browser storage is unavailable.')); return; }
        let settled = false;
        const fail = error => { if (!settled) { settled = true; clearTimeout(timeout); reject(error || new Error('Browser storage is unavailable.')); } };
        const timeout = setTimeout(() => fail(new Error('Browser storage did not respond.')), 8000);
        let request;
        try { request = indexedDB.open('medici-listening-room', 1); } catch (error) { fail(error); return; }
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains('local')) request.result.createObjectStore('local');
        };
        request.onerror = () => fail(request.error);
        request.onblocked = () => fail(new Error('Close other Medici tabs and try again.'));
        request.onsuccess = () => {
          if (settled) { request.result.close(); return; }
          settled = true; clearTimeout(timeout);
          const db = request.result;
          db.onversionchange = () => { db.close(); databasePromise = null; };
          resolve(db);
        };
      });
      databasePromise.catch(() => { databasePromise = null; });
    }
    return databasePromise;
  }
  async function stored(key, mode = 'readonly', value, remove = false) {
    const db = await database();
    return new Promise((resolve, reject) => {
      let transaction, result, settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true; clearTimeout(timeout);
        if (error) reject(error); else resolve(result);
      };
      const timeout = setTimeout(() => {
        try { transaction?.abort(); } catch {}
        finish(new Error('Browser storage did not respond.'));
      }, 8000);
      try {
        transaction = db.transaction('local', mode);
        const store = transaction.objectStore('local');
        const request = mode === 'readonly' ? store.get(key) : remove ? store.delete(key) : store.put(value, key);
        request.onsuccess = () => { result = request.result; };
        transaction.oncomplete = () => finish();
        transaction.onerror = () => finish(transaction.error || new Error('Browser storage failed.'));
        transaction.onabort = () => finish(transaction.error || new Error('Browser storage was interrupted.'));
      } catch (error) { finish(error); }
    });
  }
  function saveStored(key, value, remove = false) {
    const next = storageQueue.catch(() => {}).then(() => stored(key, 'readwrite', value, remove));
    storageQueue = next;
    return next;
  }
  function preferences() {
    return {version: 1, instrument: state.instrument, speed: state.speed, transpose: state.transpose,
      volume: Number($('volume').value), loop: state.loop};
  }
  function rememberPreferences() {
    preferencesRevision++;
    clearTimeout(preferencesTimer);
    preferencesTimer = setTimeout(() => {
      preferencesTimer = null;
      saveStored('preferences', preferences()).catch(() => {
        storageStatus('This browser could not remember your latest settings. Your current playback still works.', true);
      });
    }, 250);
  }
  function restorePreferences(saved) {
    if (!saved || saved.version !== 1) return;
    if (typeof saved.instrument === 'string' && /^[a-z][a-z_0-9]{0,60}$/.test(saved.instrument) && (!knownInstruments || knownInstruments.includes(saved.instrument))) {
      state.instrument = saved.instrument;
      // The complete catalog may arrive later; keep the selected value visible meanwhile.
      if (![...$('instrument-select').options].some(option => option.value === saved.instrument))
        $('instrument-select').add(new Option(label(saved.instrument), saved.instrument));
      syncInstrumentUI();
    }
    if (Number.isFinite(saved.speed) && saved.speed >= .5 && saved.speed <= 1.5) {
      state.speed = saved.speed; $('speed').value = saved.speed; $('speed-value').textContent = saved.speed.toFixed(2) + '×';
    }
    if ([...$('transpose').options].some(option => Number(option.value) === saved.transpose)) {
      state.transpose = saved.transpose; $('transpose').value = saved.transpose;
    }
    if (Number.isFinite(saved.volume) && saved.volume >= 0 && saved.volume <= 100) {
      $('volume').value = saved.volume; $('volume-value').textContent = saved.volume + '%';
      if (state.gain) state.gain.gain.setTargetAtTime(saved.volume / 100 * .65, state.context.currentTime, .02);
    }
    if (typeof saved.loop === 'boolean') { state.loop = saved.loop; $('loop').setAttribute('aria-pressed', String(saved.loop)); }
  }

  function setAudioSessionType(type) {
    try {
      // Web Audio defaults to ambient on iOS. Declare music playback so an
      // explicit Play/Preview can be heard even while Silent Mode is on.
      if (type === 'playback') playbackAudioSession = navigator.audioSession;
      if (playbackAudioSession) playbackAudioSession.type = type;
    } catch {
      // AudioSession is optional; unsupported browsers keep normal Web Audio.
    }
  }
  function audio() {
    setAudioSessionType('playback');
    if (!state.context) {
      const Context = window.AudioContext || window.webkitAudioContext;
      if (!Context) throw new Error('This browser does not support Web Audio. Try a current Chrome, Firefox, Safari, or Edge browser.');
      state.context = new Context(); state.gain = state.context.createGain();
      state.gain.gain.value = Number($('volume').value) / 100 * .65;
      state.gain.connect(state.context.destination);
    }
    return state.context.resume();
  }
  async function instrument(name) {
    if (!window.Soundfont) throw new Error('The instrument engine could not load. Refresh the page and try again.');
    if (!state.samples.has(name)) {
      const pending = Soundfont.instrument(state.context, name, {
        soundfont: 'FluidR3_GM', format: 'mp3', destination: state.gain,
        nameToUrl: n => `https://gleitz.github.io/midi-js-soundfonts/FluidR3_GM/${n}-mp3.js`,
      });
      state.samples.set(name, pending);
      pending.catch(() => state.samples.delete(name));
    }
    return state.samples.get(name);
  }
  function stopNodes() {
    for (const node of state.active) { try { node.stop(); } catch {} }
    state.active.clear();
    // Release the music category after pause, finish, cancellation, or leaving.
    setAudioSessionType('auto');
  }
  function stopPreview() {
    clearTimeout(state.previewTimer); state.previewing = false;
    if (!state.playing) stopNodes();
    $('preview').textContent = '♫ Preview sound';
  }
  function position() { return state.playing ? Math.min(state.duration, state.offset + (state.context.currentTime - state.started) * state.speed) : state.offset; }
  function updateTransport() {
    const pos = position(); $('current-time').textContent = clock(pos); $('total-time').textContent = clock(state.duration);
    $('seek').value = pos; $('play-text').textContent = state.loading ? 'Loading instrument…' : state.playing ? 'Pause' : 'Play score';
    $('play-icon').textContent = state.playing ? 'Ⅱ' : '▶';
    $('play').disabled = !state.notes.length || state.loading;
    $('restart').disabled = !$('seek').max || !state.notes.length;
    $('loop').disabled = !state.notes.length;
    $('seek').disabled = !state.notes.length;
  }
  function stop(reset = false) {
    const wasBusy = state.playing || state.loading;
    state.offset = reset ? 0 : position(); state.playing = false; state.loading = false; state.token++;
    clearInterval(state.timer); state.timer = null; stopNodes(); updateTransport();
    return wasBusy;
  }
  function noteOn(player, note, when, duration) {
    const pitch = note.midi + state.transpose;
    if (pitch < 0 || pitch > 127 || duration <= 0) return;
    const samplePitch = Math.max(21, Math.min(108, pitch));
    const node = player.play(samplePitch, when, {duration, cents: (pitch - samplePitch) * 100, gain: Math.min(.75, (note.velocity || .7) * .75), release: .12});
    if (!node) return;
    state.active.add(node);
    setTimeout(() => state.active.delete(node), Math.max(0, (when - state.context.currentTime + duration + 1) * 1000));
  }
  function schedule(player) {
    if (!state.playing) return;
    const pos = position(), horizon = pos + .15 * state.speed;
    while (state.next < state.notes.length && state.notes[state.next].time <= horizon) {
      const note = state.notes[state.next++];
      const end = note.time + note.duration;
      if (end > pos) noteOn(player, note, state.context.currentTime + Math.max(0, (note.time - pos) / state.speed), (end - Math.max(pos, note.time)) / state.speed);
    }
    updateTransport();
    if (pos >= state.duration) {
      stop(true);
      if (state.loop) play(); else status('Score finished. Play again or try another instrument.');
    }
  }
  async function play() {
    if (!state.notes.length || state.loading) return;
    if (state.playing) { stop(false); status('Paused.'); return; }
    stopPreview();
    const token = ++state.token; state.loading = true; updateTransport();
    status(`Loading ${label(state.instrument).toLowerCase()} samples…`);
    try {
      await audio(); const player = await instrument(state.instrument);
      if (token !== state.token) return;
      if (state.offset >= state.duration) state.offset = 0;
      state.started = state.context.currentTime; state.playing = true; state.loading = false;
      state.next = state.notes.findIndex(note => note.time + note.duration > state.offset);
      if (state.next < 0) state.next = state.notes.length;
      schedule(player); state.timer = setInterval(() => schedule(player), 30);
      status(`Playing your score with ${soundName(state.instrument).toLowerCase()}.`);
    } catch (err) {
      if (token !== state.token) return;
      stop(false); status(`Couldn’t load instrument samples. Check your internet connection and try again. ${String(err?.message || err).slice(0, 100)}`, true);
    }
  }
  async function preview() {
    if (state.previewing) { stopPreview(); state.token++; status('Preview stopped.'); return; }
    stop(false); stopPreview();
    state.previewing = true; $('preview').textContent = '■ Stop preview';
    const token = ++state.token;
    status(`Loading ${label(state.instrument).toLowerCase()} samples…`);
    try {
      await audio(); const player = await instrument(state.instrument);
      if (token !== state.token || !state.previewing) return;
      [60, 64, 67, 72, 67, 64, 60].forEach((midi, i) => noteOn(player, {midi,velocity:.7}, state.context.currentTime + .05 + i * .3, .38));
      status(`Previewing ${label(state.instrument).toLowerCase()}: a short C-major arpeggio, not your score.`);
      state.previewTimer = setTimeout(() => { stopPreview(); status('Preview finished. Press Play to hear your score in this sound.'); }, 2700);
    } catch (err) {
      if (token !== state.token) return;
      stopPreview(); status('Couldn’t load instrument samples. Check your connection, then try Preview sound again.', true);
    }
  }
  function selectInstrument(name) {
    const resume = state.playing || state.loading; stop(false); stopPreview(); state.instrument = name;
    syncInstrumentUI();
    status(`${label(name)} selected. ${state.notes.length ? 'Play your score or preview this sound.' : 'Preview its sound, or upload sheet music.'}`);
    rememberPreferences();
    if (resume) play();
  }
  $('instrument-select').addEventListener('change', event => selectInstrument(event.target.value));
  $('preview').addEventListener('click', preview); $('play').addEventListener('click', play);
  $('restart').addEventListener('click', () => { const resume = state.playing || state.loading; stop(true); stopPreview(); if (resume) play(); else status('Back at the beginning.'); });
  $('loop').addEventListener('click', () => { state.loop = !state.loop; $('loop').setAttribute('aria-pressed', String(state.loop)); status(state.loop ? 'Loop on.' : 'Loop off.'); rememberPreferences(); });
  let seeking = false, resumeAfterSeek = false;
  const beginSeek = () => { if (!seeking) { resumeAfterSeek = state.playing || state.loading; stop(false); stopPreview(); seeking = true; } };
  const endSeek = () => { if (!seeking) return; seeking = false; const resume = resumeAfterSeek; resumeAfterSeek = false; if (resume) play(); };
  $('seek').addEventListener('pointerdown', beginSeek);
  $('seek').addEventListener('input', event => { const pos = Number(event.target.value); beginSeek(); state.offset = pos; updateTransport(); });
  $('seek').addEventListener('change', endSeek);
  $('seek').addEventListener('pointerup', endSeek);
  $('seek').addEventListener('pointercancel', endSeek);
  $('seek').addEventListener('blur', endSeek);
  $('speed').addEventListener('input', event => { const resume = state.playing || state.loading; stop(false); stopPreview(); state.speed = Number(event.target.value); $('speed-value').textContent = state.speed.toFixed(2) + '×'; rememberPreferences(); if (resume) play(); });
  $('transpose').addEventListener('change', event => { const resume = state.playing || state.loading; stop(false); stopPreview(); state.transpose = Number(event.target.value); rememberPreferences(); if (resume) play(); });
  $('volume').addEventListener('input', event => { $('volume-value').textContent = event.target.value + '%'; if (state.gain) state.gain.gain.setTargetAtTime(Number(event.target.value) / 100 * .65, state.context.currentTime, .02); rememberPreferences(); });

  function loadPart() {
    stop(true); stopPreview();
    const selected = $('track').value;
    const tracks = selected === 'all' ? state.score.tracks.filter(track => !track.instrument.percussion) : [state.score.tracks[Number(selected)]];
    state.notes = tracks.flatMap(track => track.notes).filter(note => Number.isFinite(note.time) && Number.isFinite(note.duration) && note.duration > 0).sort((a, b) => a.time - b.time);
    state.duration = state.notes.reduce((max, note) => Math.max(max, note.time + note.duration), 0);
    $('seek').max = String(state.duration || 1);
    $('score-meta').textContent = `${state.notes.length.toLocaleString()} notes · ${tracks.length} melodic ${tracks.length === 1 ? 'part' : 'parts'} · ${clock(state.duration)}`;
    updateTransport();
  }
  $('track').addEventListener('change', () => { loadPart(); status('MIDI part selected. Ready to play.'); });
  function parseScore(bytes) {
    if (!window.Midi) throw new Error('MIDI parser could not load. Refresh the page.');
    if (!(bytes instanceof ArrayBuffer) || bytes.byteLength > 5 * 1024 * 1024) throw new Error('Use a MIDI file under 5 MB.');
    const midi = new Midi(bytes);
    const playable = midi.tracks.filter(track => !track.instrument.percussion && track.notes.length);
    const count = playable.reduce((sum, track) => sum + track.notes.length, 0);
    if (!count) throw new Error('This file has no melodic notes. Drum-only and empty MIDI files cannot be played in this studio.');
    if (count > 100000) throw new Error('This MIDI has too many notes. Use a shorter arrangement with fewer than 100,000 notes.');
    const duration = playable.reduce((max, track) => track.notes.reduce((end, note) => Math.max(end, note.time + note.duration), max), 0);
    if (!Number.isFinite(duration) || duration <= 0 || duration > 7200) throw new Error('Use a valid MIDI arrangement shorter than two hours.');
    return midi;
  }
  function showScore(midi, name) {
    state.score = midi;
    $('track').replaceChildren(new Option('All melodic parts', 'all'));
    midi.tracks.forEach((track, index) => { if (!track.instrument.percussion && track.notes.length) $('track').add(new Option(track.name || `Part ${index + 1} · ${track.instrument.name}`, String(index))); });
    $('track').disabled = false;
    $('score-name').textContent = scoreTitle(name);
    $('active-score-title').textContent = scoreTitle(name);
    $('clear-midi').hidden = false;
    renderSource(currentEntry?.source);
    loadPart();
  }
  function renderSource(source) {
    const container = $('score-source');
    if (!container) return;
    container.replaceChildren(); container.hidden = !source;
    if (!source) return;
    const credit = document.createElement('p'); credit.textContent = [source.creator,source.credit].filter(Boolean).join(' · ') || source.title;
    const links = document.createElement('div'); links.className = 'score-source-links';
    for (const [text,url] of [['Wikimedia source ↗',source.sourceUrl],[source.license+' ↗',source.licenseUrl],['Original PDF ↗',source.pdfUrl]]) {
      const link = document.createElement('a'); link.textContent = text; link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; links.append(link);
    }
    const note = document.createElement('p'); note.textContent = 'Source attribution is saved with this piece and included in exported MIDI metadata. Check source terms and local rights before sharing.';
    container.append(credit,links,note);
  }
  async function receiveScore(detail) {
    const token = ++importToken;
    try {
      if (!detail || typeof detail.name !== 'string' || !/\.midi?$/i.test(detail.name)) throw new Error('The recognized score has an invalid name.');
      const source = window.MediciCatalogue?.sanitizeSource(detail.source) || null;
      const midi = parseScore(detail.bytes);
      // Retain source/edition attribution even when the derived MIDI leaves the app.
      const attribution = source && window.MediciCatalogue.attribution(source);
      if (attribution && !midi.header.meta.some(item => item.text === attribution)) midi.header.meta.push({type:'text',ticks:0,text:attribution});
      const encoded = source ? midi.toArray() : null;
      const bytes = encoded ? encoded.buffer.slice(encoded.byteOffset,encoded.byteOffset+encoded.byteLength) : detail.bytes;
      detail.bytes = bytes;
      const entry = {version: 1, id: entryId(), name: detail.name, bytes, source, savedAt: Date.now(),
        warning: $('sheet-warnings').hidden ? 'Experimental recognition. Check the notes and timing against your sheet music.' : $('sheet-warnings').textContent};
      currentEntry = entry; sessionEntries.set(entry.id, entry);
      showScore(midi, detail.name);
      $('score-recognition-note').textContent = entry.warning;
      setView('score', true);
      status('Your score is ready. Choose a sound and press Play. Check the notes: recognition can make mistakes.');
      storageStatus('Saving your converted score privately in this browser…');
      renderLibrary();
      try {
        await changeLibrary(entries => [entry, ...entries.filter(item => item.id !== entry.id)]);
        sessionEntries.delete(entry.id); renderLibrary();
        if (token !== importToken) return;
        storageStatus('Score saved on this device, in this browser only. Nothing was uploaded.');
      } catch {
        if (token !== importToken) return;
        renderLibrary();
        storageStatus('Couldn’t save this score. You can play it for this visit. Your previous saved music is unchanged.', true);
      }
    } catch (error) {
      if (token !== importToken) return;
      const message = `Couldn’t read the converted score. ${String(error?.message || error).slice(0, 180)}`;
      status(message, true);
      // Keep the failure visible even when the player has not been revealed.
      if (view !== 'score') { $('sheet-status').textContent = message; $('sheet-status').classList.add('error'); setView('library', true); }
    }
  }
  window.addEventListener('medici:score-ready', event => receiveScore(event.detail));
  window.addEventListener('medici:pdf-started', () => { ++importToken; stop(false); stopPreview(); setView('converting', true); });
  window.addEventListener('medici:pdf-busy', event => {
    if (!event.detail?.busy && view === 'converting') { renderLibrary(); setView('library', true); }
  });
  async function restoreSaved() {
    const token = importToken, revision = preferencesRevision;
    stored('preferences').then(saved => {
      if (preferencesRevision === revision) restorePreferences(saved);
    }).catch(() => {});
    try {
      libraryEntries = unpackLibrary(await stored('pdf-arrangement'));
      renderLibrary();
      if (token !== importToken) return;
      if (!libraryEntries.length) { storageStatus('Your converted music stays in this browser. Nothing is uploaded.'); return; }
      // Prepare the most recent score silently, while the library stays on screen.
      // Opening a saved piece is the only way to reveal the player on a new visit.
      const saved = libraryEntries[0];
      currentEntry = saved;
      $('clear-midi').hidden = false;
      if (saved.version !== 1 || typeof saved.name !== 'string' || !/\.midi?$/i.test(saved.name)) throw new Error('Saved file is not a supported MIDI record.');
      showScore(parseScore(saved.bytes), saved.name);
      status('Your saved score is ready. Choose a sound and press Play.');
      storageStatus('Your saved music is ready. Open a piece to choose its sound.');
    } catch {
      if (token !== importToken) return;
      storageStatus('Couldn’t restore saved music. You can upload a PDF again. A damaged saved piece can be removed from the list.', true);
    }
  }
  async function removeEntry(entry) {
    if (!entry || pendingRemovals.has(entry.id)) return;
    const token = ++importToken;
    pendingRemovals.add(entry.id);
    window.dispatchEvent(new Event('medici:cancel-pdf'));
    if (currentEntry?.id === entry.id) {
      stop(true); stopPreview();
      state.score = null; state.notes = []; state.duration = 0; state.offset = 0;
      $('track').replaceChildren(new Option('All melodic parts', 'all')); $('track').disabled = true;
      $('score-name').textContent = 'Your music goes here'; $('score-meta').textContent = 'Upload sheet music to begin.';
      $('seek').max = '1'; updateTransport();
      status('Score removed from the player.');
    }
    renderLibrary(); setView('library', true);
    storageStatus('Removing the saved score…'); $('clear-midi').disabled = true;
    try {
      // Session-only music has no stored copy. Removing it must still work when
      // storage is unavailable. Wait for queued saves before deciding that.
      await storageQueue.catch(() => {});
      if (libraryEntries.some(item => item.id === entry.id) || !sessionEntries.has(entry.id))
        await changeLibrary(entries => entries.filter(item => item.id !== entry.id));
      if (currentEntry?.id === entry.id) currentEntry = null;
      sessionEntries.delete(entry.id);
      pendingRemovals.delete(entry.id); renderLibrary();
      if (token !== importToken) return;
      $('clear-midi').hidden = true;
      storageStatus('Saved score removed from this browser. Your other music and original PDF are unchanged.');
    } catch {
      pendingRemovals.delete(entry.id); renderLibrary();
      if (token !== importToken) return;
      storageStatus('Couldn’t remove the saved copy. Try its remove button again, or clear this site’s browser storage.', true);
    } finally { $('clear-midi').disabled = false; }
  }
  $('clear-midi').addEventListener('click', () => removeEntry(currentEntry));
  window.addEventListener('pagehide', () => {
    stop(false); stopPreview();
    if (preferencesTimer !== null) { clearTimeout(preferencesTimer); preferencesTimer = null; saveStored('preferences', preferences()).catch(() => {}); }
  });
  fetch('instruments.json').then(response => { if (!response.ok) throw new Error(); return response.json(); }).then(names => {
    knownInstruments = names;
    const select = $('instrument-select'); select.replaceChildren(...names.map(name => new Option(label(name), name)));
    if (!names.includes(state.instrument)) restorePreferences({version: 1, instrument: 'acoustic_grand_piano'});
    select.value = state.instrument;
    renderInstruments();
  }).catch(() => status('The full instrument list could not load. Featured instruments are still available.', true));
  updateTransport();
  setView('library');
  libraryReady = restoreSaved();
})();
