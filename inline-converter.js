/* Medici inline PDF recognition. AGPL-3.0. Uses the same verified Partsong/homr worker as convert.html. */
'use strict';
(() => {
  const $ = id => document.getElementById(id);
  if (!$('inline-pdf')) return;
  const PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.4.299/build/';
  const supported = typeof WebAssembly.Suspending === 'function' && typeof WebAssembly.promising === 'function' && !!window.Worker && !!window.crypto?.subtle;
  let libPromise, current = null, output = null, sourceName = '', selectedFile = null;
  const say = (message, error = false) => { $('sheet-status').textContent = message; $('sheet-status').classList.toggle('error', error); };
  const check = job => { if (job.cancelled || current !== job) throw new Error('Cancelled'); };
  function busy(value) {
    for (const id of ['sheet-pdf','sheet-first','sheet-count','sheet-tempo','sheet-retry']) $(id).disabled = value || !supported;
    $('sheet-clear-cache').disabled = value;
    $('inline-pdf').classList.toggle('is-busy',value);
    $('inline-pdf').classList.toggle('is-unsupported',!supported);
    $('sheet-cancel').hidden = !value;
    $('sheet-progress').hidden = !value;
    $('sheet-retry').hidden = value || !selectedFile || !supported;
  }
  function clearResult() { output = null; $('sheet-download').hidden = true; $('sheet-warnings').hidden = true; }
  function cancel(message = 'Conversion cancelled. Your current music is unchanged.') {
    if (!current) return;
    const job = current; current = null; job.cancelled = true;
    job.worker?.terminate(); job.reject?.(new Error('Cancelled')); job.render?.cancel();
    Promise.resolve(job.pdf?.destroy()).catch(() => {});
    busy(false); say(message);
  }
  async function pdfLibrary() {
    if (!libPromise) libPromise = import(PDFJS + 'pdf.min.mjs').then(lib => { lib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.mjs'; return lib; }).catch(error => { libPromise = null; throw error; });
    return libPromise;
  }
  function callWorker(job,payload,expected) {
    return new Promise((resolve,reject) => {
      let settled = false;
      const finish = (error,data) => {
        if (settled) return; settled = true; clearTimeout(timeout); job.reject = null;
        job.worker.onmessage = null; job.worker.onerror = null;
        error ? reject(error) : resolve(data);
      };
      const timeout = setTimeout(() => finish(new Error('Recognition took too long. Try one simpler page.')),10*60*1000);
      job.reject = error => finish(error);
      job.worker.onerror = event => finish(new Error(event.message || 'Recognition stopped. This device may have run out of memory.'));
      job.worker.onmessage = ({data}) => {
        if (job.cancelled || current !== job) return;
        if (data.type === 'error') {finish(new Error(data.msg));return;}
        if (data.type === expected) {finish(null,data);return;}
        if (data.type === 'progress' && data.stage === 'python') say('Preparing the note reader… Your PDF stays on this device.');
        if (data.type === 'progress' && data.stage === 'download') {
          job.downloads[data.name] = data.loaded;
          const loaded = Object.values(job.downloads).reduce((a,b) => a+b,0);
          const percent = Math.min(100,Math.round(loaded/data.total*100));
          $('sheet-progress').value = percent;
          say(`Downloading the note reader: ${percent}% (${Math.round(loaded/1e6)} / 157 MB of models). This is saved for next time when possible.`);
        }
        if (data.type === 'progress' && data.stage === 'retry') say('Download interrupted. Retrying with the pieces already downloaded…');
        if (data.type === 'log') {
          const lines = $('sheet-log').textContent.split('\n').slice(-14);
          lines.push(String(data.msg).slice(0,500)); $('sheet-log').textContent = lines.join('\n');
        }
      };
      try {job.worker.postMessage(payload,payload.image ? [payload.image] : []);} catch(error) {finish(error);}
    });
  }
  async function convert(file) {
    if (!supported || current || !file) return;
    selectedFile = file; clearResult();
    if (file.size > 15*1024*1024) {busy(false);say('Choose a PDF under 15 MB. Export a smaller selection of pages first.',true);return;}
    const first = Number($('sheet-first').value), choice = $('sheet-count').value, requested = Number(choice), tempo = Number($('sheet-tempo').value);
    if (!Number.isInteger(first) || first<1 || first>500 || (choice!=='auto' && (!Number.isInteger(requested)||requested<1||requested>3)) || !Number.isInteger(tempo)||tempo<30||tempo>240) {
      busy(false);say('Choose a starting page from 1–500, up to 3 pages, and a tempo from 30–240 BPM.',true);return;
    }
    const job = {cancelled:false,downloads:{}}; current = job;
    busy(true); $('sheet-log').textContent = ''; $('sheet-progress').removeAttribute('value');
    say('Opening your sheet music…');
    window.dispatchEvent(new Event('medici:pdf-started'));
    try {
      const head = new Uint8Array(await file.slice(0,1024).arrayBuffer()); check(job);
      if (!String.fromCharCode(...head).includes('%PDF-')) throw new Error('This is not a PDF. Choose printed sheet music saved as a PDF.');
      const lib = await pdfLibrary(); check(job);
      const bytes = new Uint8Array(await file.arrayBuffer()); check(job);
      job.pdf = lib.getDocument({data:bytes,isEvalSupported:false,maxImageSize:16000000,canvasMaxAreaInBytes:64000000});
      job.pdf.onPassword = () => {job.pdf.destroy();};
      const doc = await job.pdf.promise; check(job);
      if (first>doc.numPages) throw new Error(`This PDF has ${doc.numPages} pages. Choose an earlier starting page.`);
      const count = choice==='auto' ? Math.min(3,doc.numPages-first+1) : requested;
      if (first+count-1>doc.numPages) throw new Error(`The selection goes past page ${doc.numPages}. Reduce the page count.`);
      say('Preparing the note reader… First use downloads about 200–250 MB. Keep this tab open.');
      job.worker = new Worker('omr-worker.js',{type:'module'});
      await callWorker(job,{type:'init'},'ready'); check(job);
      const pages = [];
      for (let index=0;index<count;index++) {
        const number = first+index; check(job);
        say(`Preparing page ${number} (${index+1} of ${count})…`); $('sheet-progress').removeAttribute('value');
        const page = await doc.getPage(number); check(job);
        const base = page.getViewport({scale:1});
        const scale = Math.min(2480/base.width,3508/Math.max(base.width,base.height));
        const viewport = page.getViewport({scale});
        const canvas = document.createElement('canvas'); canvas.width=Math.round(viewport.width); canvas.height=Math.round(viewport.height);
        try {
          job.render = page.render({canvas,viewport,background:'#ffffff'}); await job.render.promise; check(job);
          const blob = await new Promise(resolve => canvas.toBlob(resolve,'image/png')); check(job);
          if (!blob) throw new Error('This device could not render the page. Try a smaller PDF.');
          const image = await blob.arrayBuffer(); check(job);
          say(`Reading notes on page ${number} (${index+1} of ${count})… This can take a few minutes.`);
          const result = await callWorker(job,{type:'recognise',id:index+1,image},'result'); check(job);
          if (!result.xml) throw new Error(`No music was recognized on page ${number}.`);
          pages.push(result.xml);
        } finally {canvas.width=0;canvas.height=0;page.cleanup();job.render=null;}
      }
      const name = file.name.replace(/\.pdf$/i,'').slice(0,120)+(first>1||count<doc.numPages ? ` · pages ${first}–${first+count-1}` : '');
      const result = window.MediciMusicXML.parsePages(pages,{tempo,title:name}); check(job);
      job.ready = {result,name,first,count,total:doc.numPages};
    } catch(error) {
      if (!job.cancelled && current===job) {clearResult();say(`Couldn’t read this PDF. ${String(error.message||error).slice(0,240)} Your current music is unchanged.`,true);}
    } finally {
      job.worker?.terminate(); await Promise.resolve(job.pdf?.destroy()).catch(() => {});
      if (current===job) {current=null;busy(false);}
    }
    if (job.ready && !job.cancelled) {
      const {result,name,first,count,total} = job.ready;
      sourceName = name; output = result;
      $('sheet-warnings').textContent = ['Experimental recognition: check the notes and timing against your score.',count<total ? `Only pages ${first}–${first+count-1} of ${total} were read.` : '',...(result.summary.warnings||[])].filter(Boolean).join(' ');
      $('sheet-warnings').hidden = false; $('sheet-download').hidden = false;
      say(`${result.summary.notes} notes are ready. Choose an instrument and press Play below.`);
      // The studio owns parsing, persistence and transport; this UI never autoplays or navigates.
      const midiBytes = result.bytes.buffer.slice(result.bytes.byteOffset,result.bytes.byteOffset+result.bytes.byteLength);
      window.dispatchEvent(new CustomEvent('medici:score-ready',{detail:{bytes:midiBytes,name:sourceName+' · experimental.mid',summary:result.summary}}));
    }
  }
  $('sheet-pdf').addEventListener('change',() => {
    const file = $('sheet-pdf').files[0];
    // Clearing the native input permits choosing the same PDF again after cancel/failure.
    $('sheet-pdf').value = '';
    if (file) convert(file);
  });
  $('sheet-retry').addEventListener('click',() => convert(selectedFile));
  $('sheet-cancel').addEventListener('click',() => cancel());
  window.addEventListener('medici:cancel-pdf',() => {
    if (current) cancel('Conversion cancelled because you chose another score.');
    else say(supported ? 'Choose a PDF to read its notes.' : 'PDF recognition needs a supported desktop browser.');
    clearResult();
  });
  window.addEventListener('pagehide',() => cancel());
  $('sheet-download').addEventListener('click',() => {
    if (!output) return;
    const url=URL.createObjectURL(new Blob([output.bytes],{type:'audio/midi'}));
    const link=document.createElement('a');link.href=url;link.download=sourceName+' · experimental.mid';link.click();
    setTimeout(() => URL.revokeObjectURL(url),60000);
  });
  $('sheet-clear-cache').addEventListener('click',async () => {
    if (current) return;
    try {await caches.delete('medici-omr-models-v1');say('Recognition models cleared. Your saved music is unchanged.');}
    catch {say('Could not clear the recognition cache. Browser settings can clear site data.',true);}
  });
  busy(false);
  if (!supported) say('PDF recognition is unavailable in this browser. Try current desktop Chrome or Edge. iPhone/iPad needs WebAssembly JSPI (Safari 27+); phone conversion is not yet tested. Your saved music can still play.',true);
})();
