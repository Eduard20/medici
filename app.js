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
      status(`Playing ${label(state.instrument).toLowerCase()} · imported MIDI arrangement.`);
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
    if (resume) play();
  }
  document.querySelectorAll('[data-instrument]').forEach(button => button.addEventListener('click', () => selectInstrument(button.dataset.instrument)));
  $('instrument-select').addEventListener('change', event => selectInstrument(event.target.value));
  $('preview').addEventListener('click', preview); $('play').addEventListener('click', play);
  $('restart').addEventListener('click', () => { const resume = state.playing || state.loading; stop(true); stopPreview(); if (resume) play(); else status('Back at the beginning.'); });
  $('loop').addEventListener('click', () => { state.loop = !state.loop; $('loop').setAttribute('aria-pressed', String(state.loop)); status(state.loop ? 'Loop on.' : 'Loop off.'); });
  let seeking = false, resumeAfterSeek = false;
  const beginSeek = () => { if (!seeking) { resumeAfterSeek = state.playing || state.loading; stop(false); stopPreview(); seeking = true; } };
  const endSeek = () => { if (!seeking) return; seeking = false; const resume = resumeAfterSeek; resumeAfterSeek = false; if (resume) play(); };
  $('seek').addEventListener('pointerdown', beginSeek);
  $('seek').addEventListener('input', event => { const pos = Number(event.target.value); beginSeek(); state.offset = pos; updateTransport(); });
  $('seek').addEventListener('change', endSeek);
  $('seek').addEventListener('pointerup', endSeek);
  $('seek').addEventListener('pointercancel', endSeek);
  $('seek').addEventListener('blur', endSeek);
  $('speed').addEventListener('input', event => { const resume = state.playing || state.loading; stop(false); stopPreview(); state.speed = Number(event.target.value); $('speed-value').textContent = state.speed.toFixed(2) + '×'; if (resume) play(); });
  $('transpose').addEventListener('change', event => { const resume = state.playing || state.loading; stop(false); stopPreview(); state.transpose = Number(event.target.value); if (resume) play(); });
  $('volume').addEventListener('input', event => { $('volume-value').textContent = event.target.value + '%'; if (state.gain) state.gain.gain.setTargetAtTime(Number(event.target.value) / 100 * .65, state.context.currentTime, .02); });

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
  async function importFile(file) {
    if (!file) return;
    const token = ++importToken;
    if (!/\.midi?$/i.test(file.name)) { status('Choose a .mid or .midi file. MP3 and other recordings cannot be imported.', true); return; }
    if (file.size > 5 * 1024 * 1024) { status('This file is too large. Choose a MIDI file under 5 MB.', true); return; }
    stop(false); stopPreview();
    try {
      if (!window.Midi) throw new Error('MIDI parser could not load. Refresh the page.');
      const bytes = await file.arrayBuffer();
      if (token !== importToken) return;
      const midi = new Midi(bytes);
      const playable = midi.tracks.filter(track => !track.instrument.percussion && track.notes.length);
      const count = playable.reduce((sum, track) => sum + track.notes.length, 0);
      if (!count) throw new Error('This file has no melodic notes. Drum-only and empty MIDI files cannot be played in this studio.');
      if (count > 100000) throw new Error('This MIDI has too many notes. Use a shorter arrangement with fewer than 100,000 notes.');
      const duration = playable.reduce((max, track) => track.notes.reduce((end, note) => Math.max(end, note.time + note.duration), max), 0);
      if (!Number.isFinite(duration) || duration <= 0 || duration > 7200) throw new Error('Use a valid MIDI arrangement shorter than two hours.');
      state.score = midi;
      $('track').replaceChildren(new Option('All melodic parts', 'all'));
      midi.tracks.forEach((track, index) => { if (!track.instrument.percussion && track.notes.length) $('track').add(new Option(track.name || `Part ${index + 1} · ${track.instrument.name}`, String(index))); });
      $('track').disabled = false;
      $('score-name').textContent = file.name.replace(/\.midi?$/i, '');
      $('file-title').textContent = file.name;
      $('file-description').textContent = 'Loaded locally. Choose another file any time.';
      loadPart(); status('MIDI ready. Choose an instrument and press Play arrangement. Drum tracks are excluded.');
    } catch (error) { if (token !== importToken) return; status(`Couldn’t import this MIDI. ${String(error?.message || error).slice(0, 180)}`, true); }
  }
  $('midi-file').addEventListener('change', event => { importFile(event.target.files[0]); event.target.value = ''; });
  const drop = $('file-zone');
  ['dragenter', 'dragover'].forEach(type => drop.addEventListener(type, event => { event.preventDefault(); drop.classList.add('dragging'); }));
  ['dragleave', 'drop'].forEach(type => drop.addEventListener(type, event => { event.preventDefault(); drop.classList.remove('dragging'); }));
  drop.addEventListener('drop', event => importFile(event.dataTransfer.files[0]));
  document.addEventListener('dragover', event => event.preventDefault());
  document.addEventListener('drop', event => event.preventDefault());
  window.addEventListener('pagehide', () => { stop(false); stopPreview(); });
  fetch('instruments.json').then(response => { if (!response.ok) throw new Error(); return response.json(); }).then(names => {
    const select = $('instrument-select'); select.replaceChildren(...names.map(name => new Option(label(name), name))); select.value = state.instrument;
  }).catch(() => status('The full instrument list could not load. Featured instruments are still available.', true));
  updateTransport();
})();
