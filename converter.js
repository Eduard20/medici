/* Medici PDF recognition UI. AGPL-3.0. PDFs and recognized notes stay in this browser. */
'use strict';
(() => {
  const $ = id => document.getElementById(id);
  if (!$('pdf-converter')) return;
  const MAX_BYTES = 15 * 1024 * 1024;
  const PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.4.299/build/';
  let libPromise, current = null, output = null, xmlPages = null, sourceName = '', serial = 0;
  const supported = typeof WebAssembly.Suspending === 'function' && typeof WebAssembly.promising === 'function' && !!window.Worker && !!window.crypto?.subtle;
  const say = (message, error = false) => { $('pdf-status').textContent = message; $('pdf-status').classList.toggle('error', error); };
  function busy(value) {
    for (const id of ['pdf-file', 'pdf-first', 'pdf-count', 'pdf-tempo', 'pdf-start', 'pdf-clear-cache']) $(id).disabled = value || !supported;
    $('pdf-cancel').hidden = !value;
    $('pdf-progress').hidden = !value;
  }
  function clearResult() { output = null; xmlPages = null; $('pdf-result').hidden = true; }
  function cancel(message = 'Conversion cancelled. Your saved MIDI was not changed.') {
    serial++;
    if (current) { current.cancelled = true; current.worker?.terminate(); current.reject?.(new Error('Cancelled')); current.render?.cancel(); current.pdf?.destroy(); current = null; }
    busy(false); say(message);
  }
  const check = job => { if (job.cancelled || current !== job) throw new Error('Cancelled'); };
  async function pdfLibrary() {
    if (!libPromise) libPromise = import(PDFJS + 'pdf.min.mjs').then(lib => { lib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.mjs'; return lib; }).catch(error => { libPromise = null; throw error; });
    return libPromise;
  }
  function callWorker(job, payload, expected) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Recognition took too long. Cancelled to protect this device. Try one simpler page.')), 10 * 60 * 1000);
      const finish = (error, data) => { clearTimeout(timeout); job.reject = null; job.worker.onmessage = null; error ? reject(error) : resolve(data); };
      job.reject = error => finish(error);
      job.worker.onerror = event => finish(new Error(event.message || 'The recognition worker stopped. This device may have run out of memory.'));
      job.worker.onmessage = ({data}) => {
        if (data.type === 'error') { finish(new Error(data.msg)); return; }
        if (data.type === expected) { finish(null, data); return; }
        if (data.type === 'progress' && data.stage === 'python') say('Loading the local recognition engine… Keep this tab open.');
        if (data.type === 'progress' && data.stage === 'download') {
          job.downloads[data.name] = data.loaded;
          const loaded = Object.values(job.downloads).reduce((a,b) => a+b,0);
          const percent = Math.min(100, Math.round(loaded / data.total * 100));
          $('pdf-progress').value = percent;
          say(`Downloading recognition models: ${percent}% (${Math.round(loaded / 1e6)} / 157 MB). Your PDF stays here.`);
        }
        if (data.type === 'progress' && data.stage === 'retry') say('Model download interrupted. Retrying; downloaded pieces are kept when storage is available.');
        if (data.type === 'log') {
          const lines = $('pdf-log').textContent.split('\n').slice(-14);
          lines.push(String(data.msg).slice(0, 500)); $('pdf-log').textContent = lines.join('\n');
        }
      };
      job.worker.postMessage(payload, payload.image ? [payload.image] : []);
    });
  }
  function makeResult() {
    const tempo = Number($('pdf-tempo').value);
    if (!Number.isInteger(tempo) || tempo < 30 || tempo > 240) throw new Error('Choose a tempo from 30–240 BPM.');
    output = window.MediciMusicXML.parsePages(xmlPages, {tempo: Number($('pdf-tempo').value), title: sourceName});
    const s = output.summary;
    $('pdf-summary').textContent = `${s.notes} recognized notes · ${s.tracks} tracks · ${s.pages} page${s.pages === 1 ? '' : 's'} · ${Math.round(s.durationSeconds)} seconds at ${s.tempo} BPM`;
    $('pdf-warnings').textContent = ['Automatic recognition can miss notes, accidentals, rhythms, or staves. Compare the result with your score before relying on it.', ...(s.warnings || [])].join(' ');
    $('pdf-result').hidden = false;
  }
  async function convert() {
    const file = $('pdf-file').files[0];
    if (!file) { say('Choose a sheet-music PDF first.', true); return; }
    if (file.size > MAX_BYTES) { say('Choose a PDF under 15 MB. You can export a smaller selection of pages first.', true); return; }
    const first = Number($('pdf-first').value), count = Number($('pdf-count').value), tempo = Number($('pdf-tempo').value);
    if (!Number.isInteger(first) || first < 1 || first > 500 || !Number.isInteger(count) || count < 1 || count > 3 || !Number.isInteger(tempo) || tempo < 30 || tempo > 240) { say('Choose a starting page from 1–500, 1–3 pages, and a tempo from 30–240 BPM.', true); return; }
    clearResult(); busy(true); $('pdf-log').textContent = ''; $('pdf-progress').removeAttribute('value');
    const job = {id: ++serial, cancelled: false, downloads: {}}; current = job;
    try {
      const head = new Uint8Array(await file.slice(0,1024).arrayBuffer()); check(job);
      if (!String.fromCharCode(...head).includes('%PDF-')) throw new Error('This is not a PDF. Choose printed sheet music saved as a PDF.');
      say('Opening your PDF locally…');
      const lib = await pdfLibrary(); check(job);
      job.pdf = lib.getDocument({data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false, maxImageSize: 16000000, canvasMaxAreaInBytes: 64000000});
      job.pdf.onPassword = () => { job.pdf.destroy(); };
      const doc = await job.pdf.promise; check(job);
      if (first > doc.numPages) throw new Error(`This PDF has ${doc.numPages} pages. Choose an earlier starting page.`);
      if (first + count - 1 > doc.numPages) throw new Error(`The selection goes past page ${doc.numPages}. Reduce the page count.`);
      say('Loading recognition engine and models. First use downloads about 200–250 MB. This can take a few minutes.');
      job.worker = new Worker('omr-worker.js', {type:'module'});
      await callWorker(job,{type:'init'},'ready'); check(job);
      const pages = [];
      for (let index = 0; index < count; index++) {
        check(job); const number = first + index;
        say(`Rendering page ${number} of your PDF…`); $('pdf-progress').removeAttribute('value');
        const page = await doc.getPage(number); check(job);
        const base = page.getViewport({scale:1});
        const scale = Math.min(2480 / base.width, 3508 / Math.max(base.width,base.height));
        const viewport = page.getViewport({scale});
        const canvas = document.createElement('canvas'); canvas.width = Math.round(viewport.width); canvas.height = Math.round(viewport.height);
        try {
          job.render = page.render({canvas,viewport,background:'#ffffff'}); await job.render.promise; check(job);
          const blob = await new Promise(resolve => canvas.toBlob(resolve,'image/png')); check(job);
          if (!blob) throw new Error('This device could not render the page. Try a smaller PDF.');
          const image = await blob.arrayBuffer(); check(job);
          say(`Recognizing page ${number} (${index + 1} of ${count})… This may take several minutes. Keep this tab open.`);
          const result = await callWorker(job,{type:'recognise',id:index + 1,image},'result'); check(job);
          if (!result.xml) throw new Error(`No music was recognized on page ${number}.`);
          pages.push(result.xml);
        } finally { canvas.width = 0; canvas.height = 0; page.cleanup(); job.render = null; }
      }
      sourceName = file.name.replace(/\.pdf$/i,'').slice(0,120) + (first > 1 || count < doc.numPages ? ` · pages ${first}–${first + count - 1}` : '');
      xmlPages = pages; makeResult(); say('Experimental MIDI is ready to check. Download it or use it in the instrument studio.');
    } catch (error) {
      if (!job.cancelled) say(`Couldn’t convert this PDF. ${String(error.message || error).slice(0,300)} Your saved MIDI was not changed.`,true);
    } finally {
      job.worker?.terminate(); await job.pdf?.destroy().catch(() => {});
      if (current === job) {current = null; busy(false);}
    }
  }
  async function saveToStudio() {
    if (!output) return;
    $('pdf-use').disabled = true;
    const bytes = output.bytes.buffer.slice(output.bytes.byteOffset, output.bytes.byteOffset + output.bytes.byteLength);
    try {
      if (!window.indexedDB) throw new Error('Browser storage is unavailable.');
      await new Promise((resolve,reject) => {
        let settled = false, db, tx;
        const timeout = setTimeout(() => { try { tx?.abort(); } catch {} settled = true; db?.close(); reject(new Error('Browser storage did not respond.')); },8000);
        const finish = error => {if (settled) return; settled = true; clearTimeout(timeout); db?.close(); error ? reject(error) : resolve();};
        const request = indexedDB.open('medici-listening-room',1);
        request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('local')) request.result.createObjectStore('local'); };
        request.onerror = () => finish(request.error);
        request.onblocked = () => finish(new Error('Close other Medici tabs and try again.'));
        request.onsuccess = () => {
          db = request.result; if (settled) {db.close(); return;}
          try {
            tx = db.transaction('local','readwrite');
            tx.objectStore('local').put({version:1,name:sourceName + ' · experimental.mid',bytes},'arrangement');
            tx.oncomplete = () => finish(); tx.onerror = () => finish(tx.error); tx.onabort = () => finish(tx.error || new Error('Save interrupted.'));
          } catch(error) {finish(error);}
        };
      });
      location.href = './#studio';
    } catch(error) {say(`Couldn’t save to the studio: ${String(error.message || error).slice(0,160)} Download the MIDI and import it manually.`,true);}
    finally {$('pdf-use').disabled = false;}
  }
  $('pdf-clear-cache').addEventListener('click',async () => {
    if (current) return;
    try { await caches.delete('medici-omr-models-v1'); say('Recognition model cache cleared. Your saved MIDI is unchanged.'); }
    catch { say('Could not clear the recognition cache. You can clear site data in browser settings.',true); }
  });
  $('pdf-start').addEventListener('click',convert);
  $('pdf-cancel').addEventListener('click',() => cancel());
  $('pdf-file').addEventListener('change',() => {clearResult(); say('PDF selected. Start with one page to check the result.');});
  $('pdf-tempo').addEventListener('change',() => {if (xmlPages) {try {makeResult();} catch(error){output = null; $('pdf-result').hidden = true; say(error.message,true);}}});
  $('pdf-download').addEventListener('click',() => {
    if (!output) return;
    const url = URL.createObjectURL(new Blob([output.bytes],{type:'audio/midi'}));
    const link = document.createElement('a'); link.href = url; link.download = sourceName + ' · experimental.mid'; link.click();
    setTimeout(() => URL.revokeObjectURL(url),60000);
  });
  $('pdf-use').addEventListener('click',saveToStudio);
  window.addEventListener('pagehide',() => {if (current) cancel();});
  if (!supported) { busy(false); say('This browser cannot run the local recognition engine. Try an up-to-date Chrome or Edge. iPhone/iPad browsers need WebAssembly JSPI support (Safari 27 or newer); those devices are not yet tested. The MIDI player still works.',true); }
  else say('Ready. Choose a clear, printed sheet-music PDF. Start with one page.');
})();
