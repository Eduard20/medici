/* Medici listening room. No imported MIDI content is transmitted. */
'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const label = name => name.replaceAll('_', ' ').replace(/^./, c => c.toUpperCase());
  const clock = seconds => `${Math.floor(Math.max(0, seconds) / 60)}:${String(Math.floor(Math.max(0, seconds) % 60)).padStart(2, '0')}`;
  const status = (message, error = false) => { $('status').textContent = message; $('status').classList.toggle('error', error); };
  const state = { context: null, gain: null, samples: new Map(), instrument: 'acoustic_grand_piano', score: null, notes: [], duration: 0, offset: 0, started: 0, playing: false, loading: false, speed: 1, transpose: 0, loop: false, next: 0, token: 0, active: new Set(), timer: null, previewTimer: null, previewing: false };
  let youtube = null;
  let youtubeLoad = false;
  let importToken = 0;
  let preferencesRevision = 0;
  let preferencesTimer = null;
  let databasePromise = null;
  let storageQueue = Promise.resolve();
  let knownInstruments = null;
  let arrangementKind = 'imported';
  const bundledScores = {
    love: {url: 'assets/love-for-duty-piano.mid', name: 'Love for Duty · piano score', description: 'Paolo Buonvino · transcription from your piano score. Steady tempo, not the original recording.'},
    demo: {url: 'assets/two-chord-demo.mid', name: 'Two-chord demo', description: 'C major → A minor · 4 seconds. From your code, not “Love For Duty”.'}
  };
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
      $('instrument-select').value = saved.instrument;
      $('instrument-badge').textContent = label(saved.instrument).replace('Acoustic grand ', '').toUpperCase();
      document.querySelectorAll('[data-instrument]').forEach(button => {
        const active = button.dataset.instrument === saved.instrument;
        button.classList.toggle('selected', active); button.setAttribute('aria-pressed', String(active));
      });
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

  function pauseOriginal() {
    if (youtube && typeof youtube.pauseVideo === 'function') youtube.pauseVideo();
  }
  function loadOriginal() {
    stop(false); stopPreview();
    if (youtubeLoad) { youtube?.playVideo?.(); return; }
    youtubeLoad = true;
    $('video-placeholder').hidden = true;
    $('youtube-player').hidden = false;
    const frame = document.createElement('iframe');
    frame.id = 'youtube-player'; frame.title = 'Love For Duty · Paolo Buonvino · official recording';
    frame.src = `https://www.youtube-nocookie.com/embed/QVOhsRnkLZA?autoplay=1&enablejsapi=1&playsinline=1&origin=${encodeURIComponent(location.origin)}`;
    frame.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
    frame.allowFullscreen = true; frame.referrerPolicy = 'strict-origin-when-cross-origin';
    $('youtube-player').replaceWith(frame);
    window.onYouTubeIframeAPIReady = () => {
      youtube = new YT.Player('youtube-player', {events: {
        onStateChange(event) { if (event.data === 1) { stop(false); stopPreview(); } },
        onError() { $('video-status').hidden = false; $('video-status').textContent = 'YouTube could not play this recording here. Use “Open on YouTube” beside the player.'; }
      }});
    };
    const script = document.createElement('script'); script.src = 'https://www.youtube.com/iframe_api';
    script.onerror = () => { $('video-status').hidden = false; $('video-status').textContent = 'If playback is unavailable here, use “Open on YouTube”.'; };
    document.head.append(script);
  }
  $('load-video').addEventListener('click', loadOriginal);
  $('listen-link').addEventListener('click', loadOriginal);

  function audio() {
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
  }
  function stopPreview() {
    clearTimeout(state.previewTimer); state.previewing = false;
    if (!state.playing) stopNodes();
    $('preview').textContent = '♫ Preview sound';
  }
  function position() { return state.playing ? Math.min(state.duration, state.offset + (state.context.currentTime - state.started) * state.speed) : state.offset; }
  function updateTransport() {
    const pos = position(); $('current-time').textContent = clock(pos); $('total-time').textContent = clock(state.duration);
    $('seek').value = pos; $('play-text').textContent = state.loading ? 'Loading instrument…' : state.playing ? 'Pause' : 'Play arrangement';
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
      if (state.loop) play(); else status('Arrangement finished. Play again or try another instrument.');
    }
  }
  async function play() {
    if (!state.notes.length || state.loading) return;
    if (state.playing) { stop(false); status('Paused.'); return; }
    stopPreview(); pauseOriginal();
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
      status(`Playing ${label(state.instrument).toLowerCase()} · ${arrangementKind === 'demo' ? 'two-chord demo, not Love For Duty' : arrangementKind === 'love' ? 'Love for Duty piano-score transcription' : 'imported MIDI arrangement'}.`);
    } catch (err) {
      if (token !== state.token) return;
      stop(false); status(`Couldn’t load instrument samples. Check your internet connection and try again. ${String(err?.message || err).slice(0, 100)}`, true);
    }
  }
  async function preview() {
    if (state.previewing) { stopPreview(); state.token++; status('Preview stopped.'); return; }
    stop(false); pauseOriginal(); stopPreview();
    state.previewing = true; $('preview').textContent = '■ Stop preview';
    const token = ++state.token;
    status(`Loading ${label(state.instrument).toLowerCase()} samples…`);
    try {
      await audio(); const player = await instrument(state.instrument);
      if (token !== state.token || !state.previewing) return;
      [60, 64, 67, 72, 67, 64, 60].forEach((midi, i) => noteOn(player, {midi,velocity:.7}, state.context.currentTime + .05 + i * .3, .38));
      status(`Previewing ${label(state.instrument).toLowerCase()}: a short C-major arpeggio, not “Love For Duty”.`);
      state.previewTimer = setTimeout(() => { stopPreview(); status('Preview finished. Import a MIDI arrangement to play its notes.'); }, 2700);
    } catch (err) {
      if (token !== state.token) return;
      stopPreview(); status('Couldn’t load instrument samples. Check your connection, then try Preview sound again.', true);
    }
  }
  function selectInstrument(name) {
    const resume = state.playing || state.loading; stop(false); stopPreview(); state.instrument = name;
    $('instrument-select').value = name; $('instrument-badge').textContent = label(name).replace('Acoustic grand ', '').toUpperCase();
    document.querySelectorAll('[data-instrument]').forEach(button => {
      const active = button.dataset.instrument === name; button.classList.toggle('selected', active); button.setAttribute('aria-pressed', String(active));
    });
    status(`${label(name)} selected. ${state.notes.length ? 'Play your arrangement or preview this sound.' : 'Preview its sound, or load a MIDI arrangement.'}`);
    rememberPreferences();
    if (resume) play();
  }
  document.querySelectorAll('[data-instrument]').forEach(button => button.addEventListener('click', () => selectInstrument(button.dataset.instrument)));
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
  function showScore(midi, name, restored = false) {
    arrangementKind = 'imported';
    state.score = midi;
    $('track').replaceChildren(new Option('All melodic parts', 'all'));
    midi.tracks.forEach((track, index) => { if (!track.instrument.percussion && track.notes.length) $('track').add(new Option(track.name || `Part ${index + 1} · ${track.instrument.name}`, String(index))); });
    $('track').disabled = false;
    $('score-name').textContent = name.replace(/\.midi?$/i, '');
    $('file-title').textContent = name;
    $('file-description').textContent = restored ? 'Restored from this browser. Ready whenever you are.' : 'Loaded locally. Choose another file any time.';
    $('clear-midi').hidden = false;
    loadPart();
  }
  async function loadBundled(kind, expectedToken) {
    const token = expectedToken === undefined ? ++importToken : expectedToken;
    if (token !== importToken) return;
    stop(false); stopPreview();
    const score = bundledScores[kind];
    status(`Loading ${score.name}…`);
    try {
      const response = await fetch(score.url);
      if (!response.ok) throw new Error('Arrangement file unavailable.');
      const bytes = await response.arrayBuffer();
      if (token !== importToken) return;
      const midi = parseScore(bytes);
      showScore(midi, score.name);
      arrangementKind = kind;
      $('file-description').textContent = score.description;
      $('clear-midi').hidden = true;
      status(`${score.name} ready. Choose an instrument and press Play arrangement.`);
      storageStatus('Included arrangement loaded without an upload. Your saved MIDI, if any, has not been replaced.');
    } catch {
      if (token !== importToken) return;
      status(`Couldn’t load ${score.name}. Check your connection and try its Load button again.`, true);
    }
  }
  $('load-demo').addEventListener('click', () => loadBundled('demo'));
  $('load-love-duty').addEventListener('click', () => loadBundled('love'));
  async function importFile(file) {
    if (!file) return;
    const token = ++importToken;
    if (!/\.midi?$/i.test(file.name)) { status('Choose a .mid or .midi file. MP3 and other recordings cannot be imported.', true); return; }
    if (file.size > 5 * 1024 * 1024) { status('This file is too large. Choose a MIDI file under 5 MB.', true); return; }
    stop(false); stopPreview();
    try {
      const bytes = await file.arrayBuffer();
      if (token !== importToken) return;
      const midi = parseScore(bytes);
      showScore(midi, file.name);
      status('MIDI ready. Choose an instrument and press Play arrangement. Drum tracks are excluded.');
      storageStatus('Saving privately in this browser…');
      try {
        await saveStored('arrangement', {version: 1, name: file.name, bytes});
        if (token !== importToken) return;
        $('file-description').textContent = 'Saved in this browser. It will be here next visit.';
        storageStatus('Saved on this device, in this browser only. Nothing was uploaded.');
      } catch {
        if (token !== importToken) return;
        storageStatus('Couldn’t save this MIDI. You can play it for this visit. A previously saved file may return on reload.', true);
      }
    } catch (error) { if (token !== importToken) return; status(`Couldn’t import this MIDI. ${String(error?.message || error).slice(0, 180)}`, true); }
  }
  async function restoreSaved() {
    const token = importToken, revision = preferencesRevision;
    const preferencesRead = stored('preferences').then(saved => {
      if (preferencesRevision === revision) restorePreferences(saved);
    }).catch(() => {});
    try {
      const saved = await stored('arrangement');
      if (token !== importToken) return;
      if (!saved) { await loadBundled('love', token); return; }
      $('clear-midi').hidden = false;
      if (saved.version !== 1 || typeof saved.name !== 'string' || !/\.midi?$/i.test(saved.name)) throw new Error('Saved file is not a supported MIDI record.');
      const midi = parseScore(saved.bytes);
      if (token !== importToken) return;
      showScore(midi, saved.name, true);
      status('Your saved MIDI is ready. Choose an instrument and press Play arrangement.');
      storageStatus('Restored from this browser. Nothing was uploaded.');
    } catch {
      if (token !== importToken) return;
      storageStatus('Couldn’t restore saved MIDI. You can still import and play a file. If a saved file is damaged, remove it and import again.', true);
    }
    await preferencesRead;
  }
  $('clear-midi').addEventListener('click', async () => {
    const token = ++importToken;
    stop(true); stopPreview();
    state.score = null; state.notes = []; state.duration = 0; state.offset = 0;
    $('track').replaceChildren(new Option('All melodic parts', 'all')); $('track').disabled = true;
    $('score-name').textContent = 'No MIDI loaded'; $('score-meta').textContent = 'Choose a file to begin.';
    $('file-title').textContent = 'Your arrangement starts here.';
    $('file-description').textContent = 'Choose a MIDI file once. Keep it privately in this browser.';
    $('seek').max = '1'; updateTransport();
    status('Arrangement removed from the player.'); storageStatus('Removing the saved MIDI…');
    $('clear-midi').disabled = true;
    try {
      await saveStored('arrangement', undefined, true);
      if (token !== importToken) return;
      $('clear-midi').hidden = true;
      storageStatus('Saved MIDI removed from this browser. Your original file is unchanged.');
    } catch {
      if (token !== importToken) return;
      storageStatus('Couldn’t remove the saved copy. Try Remove saved MIDI again, or clear this site’s browser storage.', true);
    } finally { $('clear-midi').disabled = false; }
  });
  $('midi-file').addEventListener('change', event => { importFile(event.target.files[0]); event.target.value = ''; });
  const drop = $('file-zone');
  ['dragenter', 'dragover'].forEach(type => drop.addEventListener(type, event => { event.preventDefault(); drop.classList.add('dragging'); }));
  ['dragleave', 'drop'].forEach(type => drop.addEventListener(type, event => { event.preventDefault(); drop.classList.remove('dragging'); }));
  drop.addEventListener('drop', event => importFile(event.dataTransfer.files[0]));
  document.addEventListener('dragover', event => event.preventDefault());
  document.addEventListener('drop', event => event.preventDefault());
  window.addEventListener('pagehide', () => {
    stop(false); stopPreview();
    if (preferencesTimer !== null) { clearTimeout(preferencesTimer); preferencesTimer = null; saveStored('preferences', preferences()).catch(() => {}); }
  });
  fetch('instruments.json').then(response => { if (!response.ok) throw new Error(); return response.json(); }).then(names => {
    knownInstruments = names;
    const select = $('instrument-select'); select.replaceChildren(...names.map(name => new Option(label(name), name)));
    if (!names.includes(state.instrument)) restorePreferences({version: 1, instrument: 'acoustic_grand_piano'});
    select.value = state.instrument;
  }).catch(() => status('The full instrument list could not load. Featured instruments are still available.', true));
  updateTransport();
  restoreSaved();
})();
