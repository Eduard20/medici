/* Wikimedia Commons score search. No keys, proxy, uploads or automatic downloads. */
'use strict';
(() => {
  const API = 'https://commons.wikimedia.org/w/api.php';
  const MAX_BYTES = 15 * 1024 * 1024;
  const $ = id => document.getElementById(id);
  function plain(value, limit = 500) {
    // Parse in an inert document, then insert only text nodes into the live page.
    const doc = new DOMParser().parseFromString(String(value || '').slice(0, 20000), 'text/html');
    doc.querySelectorAll('script,style,iframe,object').forEach(node => node.remove());
    return (doc.body.textContent || '').replace(/\s+/g, ' ').trim().slice(0, limit);
  }
  function safeURL(value, kind) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password || url.port) return '';
      if (kind === 'pdf' && url.hostname === 'upload.wikimedia.org' && /^\/wikipedia\/commons\/[a-f0-9]\/[a-f0-9]{2}\/[^/]+\.pdf$/i.test(url.pathname)) {
        url.search = ''; url.hash = ''; return url.href;
      }
      if (kind === 'source' && url.hostname === 'commons.wikimedia.org' && url.pathname.startsWith('/wiki/File:')) return url.href;
      if (kind === 'license' && url.hostname === 'creativecommons.org' && /^\/(licenses\/(by|by-sa)\/[1-4]\.0|publicdomain\/(zero|mark)\/1\.0)\/?$/.test(url.pathname)) return url.href;
    } catch {}
    return '';
  }
  function licenseFor(info, categories) {
    const metadata = info.extmetadata || {};
    const name = plain(metadata.LicenseShortName?.value, 80);
    let license = '', licenseUrl = '';
    if (/^(Public domain|CC0|CC Zero)$/i.test(name)) {
      license = /^Public domain$/i.test(name) ? 'Public domain' : 'CC0 1.0';
      licenseUrl = license === 'Public domain' ? 'https://creativecommons.org/publicdomain/mark/1.0/' : 'https://creativecommons.org/publicdomain/zero/1.0/';
    } else {
      const match = name.match(/^CC BY(-SA)? ([1-4]\.0)$/i);
      if (match) { license = `CC BY${match[1] ? '-SA' : ''} ${match[2]}`; licenseUrl = `https://creativecommons.org/licenses/${match[1] ? 'by-sa' : 'by'}/${match[2]}/`; }
    }
    if (!license) return null;
    // A modern arrangement can be CC-licensed even when the composition's
    // Public domain label wins in imageinfo. Inspect actual hidden categories.
    if (categories) {
      const cc = categories.map(item => String(item.title || '')).filter(title => /^Category:CC-(BY|Zero)/i.test(title));
      const recognized = [];
      for (const title of cc) {
        if (title === 'Category:CC-Zero') { recognized.push({license:'CC0 1.0',licenseUrl:'https://creativecommons.org/publicdomain/zero/1.0/'}); continue; }
        const match = title.match(/^Category:CC-BY(-SA)?-([1-4]\.0)$/);
        if (!match) return null; // Regional/unknown terms require source-page review.
        recognized.push({license:`CC BY${match[1] || ''} ${match[2]}`,licenseUrl:`https://creativecommons.org/licenses/${match[1] ? 'by-sa' : 'by'}/${match[2]}/`});
      }
      const distinct = [...new Map(recognized.map(item => [item.license,item])).values()];
      if (distinct.length > 1) return null;
      if (distinct.length) ({license,licenseUrl} = distinct[0]);
    }
    const creator = plain(metadata.Artist?.value || metadata.Author?.value, 1200);
    const credit = plain(metadata.Credit?.value, 1200);
    if (/^CC BY/.test(license) && !creator && !credit) return null;
    return {license,licenseUrl,creator,credit};
  }
  function scoreFromPage(page, checkCategories = false) {
    const info = page?.imageinfo?.[0];
    if (!info || info.mime !== 'application/pdf' || !Number.isFinite(info.size) || info.size < 8 || info.size > MAX_BYTES) return null;
    const pdfUrl = safeURL(info.url,'pdf'), sourceUrl = safeURL(info.descriptionurl,'source');
    const rights = licenseFor(info, checkCategories ? (page.categories || []) : null);
    if (!pdfUrl || !sourceUrl || !rights) return null;
    return {provider:'Wikimedia Commons',fileTitle:String(page.title || '').slice(0,500),title:plain(String(page.title || '').replace(/^File:/,'').replace(/\.pdf$/i,'').replaceAll('_',' '),220),pdfUrl,sourceUrl,...rights,size:info.size,pages:Number.isInteger(info.pagecount) && info.pagecount>0 ? info.pagecount : null};
  }
  function sanitizeSource(source) {
    if (!source || source.provider !== 'Wikimedia Commons') return null;
    const pdfUrl = safeURL(source.pdfUrl,'pdf'), sourceUrl = safeURL(source.sourceUrl,'source'), licenseUrl = safeURL(source.licenseUrl,'license');
    if (!pdfUrl || !sourceUrl || !licenseUrl || !/^(Public domain|CC0 1\.0|CC BY(?:-SA)? [1-4]\.0)$/.test(source.license)) return null;
    return {provider:'Wikimedia Commons',title:plain(source.title,220),creator:plain(source.creator,1200),credit:plain(source.credit,1200),license:source.license,licenseUrl,sourceUrl,pdfUrl};
  }
  function attribution(source) {
    return [`Source: ${source.title} (Wikimedia Commons)`,source.creator && `Creator: ${source.creator}`,source.credit && `Credit: ${source.credit}`,`Source page: ${source.sourceUrl}`,`PDF: ${source.pdfUrl}`,`Source license: ${source.license} — ${source.licenseUrl}`,'MIDI derived by experimental optical music recognition in Sheet Music Studio. Notes and timing may differ from the source.','Check the source page and applicable local rights before reuse. Retain required attribution; ShareAlike terms apply where applicable.'].filter(Boolean).join('\n');
  }
  function apiURL(params) {
    return API + '?' + new URLSearchParams({action:'query',format:'json',formatversion:'2',origin:'*',...params});
  }
  async function json(url, signal) {
    const response = await fetch(url,{signal,credentials:'omit',referrerPolicy:'no-referrer'});
    if (!response.ok) throw new Error('Wikimedia search is unavailable. Try again shortly.');
    const data = await response.json();
    if (data.error) throw new Error('Wikimedia could not complete this search. Try a simpler title or composer.');
    return data;
  }
  async function downloadPDF(score, signal, progress) {
    const url = safeURL(score.pdfUrl,'pdf');
    if (!url) throw new Error('This PDF is not from a supported Wikimedia address.');
    const response = await fetch(url,{signal,credentials:'omit',referrerPolicy:'no-referrer',redirect:'error'});
    if (!response.ok) throw new Error('The score could not be downloaded. Try again or open its source page.');
    const type = (response.headers.get('content-type') || '').split(';')[0].trim();
    if (type !== 'application/pdf' && type !== 'application/octet-stream') throw new Error('The source did not return a PDF.');
    if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('This PDF is over 15 MB. Choose a smaller score.');
    if (!response.body?.getReader) throw new Error('This browser cannot safely download a score here. Open the source PDF and upload it instead.');
    const reader = response.body.getReader(), chunks = []; let size = 0;
    try {
      while (true) {
        if (signal.aborted) throw new DOMException('Cancelled','AbortError');
        const {done,value} = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) throw new Error('This PDF is over 15 MB. Choose a smaller score.');
        chunks.push(value); progress?.(size);
      }
    } catch(error) { await reader.cancel().catch(() => {}); throw error; }
    finally { reader.releaseLock(); }
    if (signal.aborted) throw new DOMException('Cancelled','AbortError');
    const blob = new Blob(chunks,{type:'application/pdf'});
    const head = new Uint8Array(await blob.slice(0,1024).arrayBuffer());
    if (!String.fromCharCode(...head).includes('%PDF-')) throw new Error('The downloaded file is not a valid PDF.');
    if (signal.aborted) throw new DOMException('Cancelled','AbortError');
    return new File([blob],score.title.slice(0,120)+'.pdf',{type:'application/pdf'});
  }
  window.MediciCatalogue = {plain,safeURL,scoreFromPage,sanitizeSource,attribution,downloadPDF,apiURL};
  if (!$('catalogue-form')) return;
  let searchJob = null, importJob = null;
  const supported = typeof WebAssembly === 'object' && typeof WebAssembly.instantiate === 'function' && !!window.Worker && !!window.crypto?.subtle;
  const say = (message,error = false) => { $('catalogue-status').textContent = message; $('catalogue-status').classList.toggle('error',error); };
  function stopImport(message) {
    if (!importJob) return;
    importJob.abort(); importJob = null;
    $('catalogue-cancel').hidden = true;
    document.querySelectorAll('.catalogue-use').forEach(button => button.disabled = !supported);
    if (message) say(message);
  }
  function link(label,url) {
    const a = document.createElement('a'); a.textContent = label; a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; return a;
  }
  function render(scores) {
    $('catalogue-results').replaceChildren(...scores.map(score => {
      const item = document.createElement('li'); item.className = 'catalogue-result';
      const title = document.createElement('h4'); title.textContent = score.title;
      const credit = document.createElement('p'); credit.className = 'catalogue-credit'; credit.textContent = score.creator || score.credit || 'See source for creator details';
      const meta = document.createElement('p'); meta.className = 'catalogue-meta'; meta.textContent = `${score.pages ? `${score.pages} ${score.pages === 1 ? 'page' : 'pages'} · ` : ''}${score.size < 1024*1024 ? Math.ceil(score.size/1024)+' KB' : (score.size/1024/1024).toFixed(1)+' MB'} · Listed as ${score.license}`;
      const actions = document.createElement('div'); actions.className = 'catalogue-actions';
      const use = document.createElement('button'); use.type = 'button'; use.className = 'button secondary catalogue-use'; use.textContent = 'Use this score'; use.disabled = !supported; use.addEventListener('click',() => importScore(score));
      actions.append(use,link('Source & licence ↗',score.sourceUrl),link('Open PDF ↗',score.pdfUrl));
      item.append(title,credit,meta,actions); return item;
    }));
  }
  async function search() {
    const query = $('catalogue-query').value.trim().slice(0,120);
    if (!query) { say('Enter a piece, composer or instrument.'); $('catalogue-query').focus(); return; }
    searchJob?.abort(); stopImport();
    const job = new AbortController(); searchJob = job;
    const timeout = setTimeout(() => job.abort(),30000);
    $('catalogue-form').setAttribute('aria-busy','true'); render([]); say('Searching free sheet music…');
    try {
      // Keep the scope fixed. Punctuation is not interpreted as search operators.
      const words = query.replace(/[^\p{L}\p{N}\s'-]/gu,' ').trim();
      const data = await json(apiURL({generator:'search',gsrsearch:'filemime:pdf deepcat:"PDF files of sheet music" filesize:<15360 '+words,gsrnamespace:'6',gsrlimit:'20',prop:'imageinfo',iiprop:'url|mime|extmetadata|size',iiextmetadatalanguage:'en'}),job.signal);
      if (searchJob !== job || job.signal.aborted) return;
      const scores = (data.query?.pages || []).sort((a,b) => (a.index||0)-(b.index||0)).map(page => scoreFromPage(page)).filter(Boolean);
      render(scores); say(scores.length ? `${scores.length} ${scores.length === 1 ? 'score' : 'scores'} found. Select one to download and read up to 3 pages.${data.continue ? ' Try a more specific search to narrow the results.' : ''}` : 'No supported free PDFs found. Try a composer, a shorter title, or another spelling. You can always upload a PDF.');
    } catch(error) {
      if (searchJob === job) say(job.signal.aborted ? 'Search timed out. Please try again.' : error.message,true);
    } finally {
      clearTimeout(timeout);
      if (searchJob === job) { searchJob = null; $('catalogue-form').removeAttribute('aria-busy'); }
    }
  }
  async function importScore(candidate) {
    if (importJob || !supported) return;
    const job = new AbortController(); importJob = job;
    const timeout = setTimeout(() => job.abort(),60000);
    $('catalogue-cancel').hidden = false;
    document.querySelectorAll('.catalogue-use').forEach(button => button.disabled = true);
    say('Checking the score and its source licence…');
    try {
      // Check all actual categories immediately before downloading. imageinfo's
      // flattened license field can omit a modern arrangement's CC license.
      const data = await json(apiURL({titles:candidate.fileTitle,prop:'imageinfo|categories',cllimit:'max',iiprop:'url|mime|extmetadata|size',iiextmetadatalanguage:'en'}),job.signal);
      if (importJob !== job || job.signal.aborted) return;
      const score = !data.continue && scoreFromPage(data.query?.pages?.[0],true);
      if (!score) throw new Error('This edition’s licence or file details need a closer look. Please use “Source & licence” to review it.');
      say(`Downloading ${score.title}…`);
      const file = await downloadPDF(score,job.signal,bytes => { if (importJob === job) say(`Downloading score… ${Math.ceil(bytes/1024)} KB`); });
      if (importJob !== job || job.signal.aborted) return;
      importJob = null; $('catalogue-cancel').hidden = true;
      document.querySelectorAll('.catalogue-use').forEach(button => button.disabled = !supported);
      say(`Downloaded from Wikimedia Commons · ${score.license}. Reading the notes on this device…`);
      window.dispatchEvent(new CustomEvent('medici:import-pdf',{detail:{file,source:sanitizeSource(score)}}));
    } catch(error) {
      if (importJob === job) { const timedOut = job.signal.aborted; stopImport(); say(timedOut ? 'Download timed out. Please try again.' : error.message,true); }
    } finally { clearTimeout(timeout); }
  }
  $('catalogue-form').addEventListener('submit',event => { event.preventDefault(); search(); });
  document.querySelectorAll('[data-score-query]').forEach(button => button.addEventListener('click',() => { $('catalogue-query').value = button.dataset.scoreQuery; search(); }));
  $('catalogue-cancel').addEventListener('click',() => stopImport('Download cancelled. Your music is unchanged.'));
  function cancelCatalogue() { const pending = importJob || searchJob; stopImport(); searchJob?.abort(); searchJob = null; $('catalogue-form').removeAttribute('aria-busy'); if (pending) say('Search or download cancelled. Your music is unchanged.'); }
  $('sheet-pdf')?.addEventListener('change',cancelCatalogue);
  window.addEventListener('medici:cancel-pdf',cancelCatalogue);
  window.addEventListener('medici:pdf-started',() => { stopImport(); searchJob?.abort(); searchJob = null; $('catalogue-form').removeAttribute('aria-busy'); });
  window.addEventListener('pagehide',() => { searchJob?.abort(); searchJob = null; stopImport(); });
})();
