'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const code = fs.readFileSync(path.join(root, 'catalogue.js'), 'utf8');
const MAX_BYTES = 15 * 1024 * 1024;
const PDF_URL = 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Example_score.pdf';
const SOURCE_URL = 'https://commons.wikimedia.org/wiki/File:Example_score.pdf';
const bytes = value => new TextEncoder().encode(value);
const pdfBytes = bytes('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF');
const flush = async () => {
  for (let count = 0; count < 24; count++) await Promise.resolve();
  await new Promise(resolve => setImmediate(resolve));
  for (let count = 0; count < 24; count++) await Promise.resolve();
};
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
function page(overrides = {}) {
  const metadata = {
    LicenseShortName: { value: 'Public domain' },
    Artist: { value: 'Example Composer' },
    Credit: { value: 'Example Archive, scan by Example Editor' },
    ...(overrides.metadata || {}),
  };
  return {
    pageid: 42, ns: 6, index: 1, title: 'File:Example_score.pdf',
    ...overrides.page,
    imageinfo: [{
      url: PDF_URL, descriptionurl: SOURCE_URL, mime: 'application/pdf',
      size: pdfBytes.length, pagecount: 2, ...overrides.info, extmetadata: metadata,
    }],
    ...(overrides.categories ? { categories: overrides.categories.map(title => ({ title })) } : {}),
  };
}
const result = (pages, extra = {}) => ({ query: { pages }, ...extra });
const jsonResponse = data => ({ ok: true, json: async () => data });
function pdfResponse(options = {}) {
  let index = 0;
  const stats = { reads: 0, cancelled: 0, released: 0 };
  const chunks = options.chunks || [pdfBytes];
  const reader = {
    async read() {
      stats.reads++;
      if (options.read) return options.read(index++, stats);
      return index < chunks.length ? { done: false, value: chunks[index++] } : { done: true };
    },
    async cancel() { stats.cancelled++; },
    releaseLock() { stats.released++; },
  };
  const headers = { 'content-type': 'application/pdf', ...options.headers };
  return {
    stats,
    response: {
      ok: options.ok !== false,
      headers: { get: key => headers[key.toLowerCase()] ?? null },
      body: options.noStream ? null : { getReader: () => reader },
    },
  };
}
function harness(t, options = {}) {
  const dom = new JSDOM(html, { url: 'https://example.test/medici/', runScripts: 'outside-only' });
  const w = dom.window, d = w.document;
  const requests = [], imports = [], scoreEvents = [], errors = [], workers = [], audio = [];
  w.Blob = Blob;
  w.File = File;
  w.AbortController = AbortController;
  w.WebAssembly = { instantiate() {} };
  if (!options.unsupported) {
    Object.defineProperty(w.crypto, 'subtle', { value: {} });
    w.Worker = class { constructor() { workers.push(this); } };
  }
  w.AudioContext = class { constructor() { audio.push(this); } };
  w.fetch = (url, init = {}) => {
    const request = { url: String(url), init };
    requests.push(request);
    if (!options.fetch) return Promise.reject(new Error('Unexpected network request'));
    return Promise.resolve(options.fetch(request, requests.length));
  };
  w.addEventListener('medici:import-pdf', event => imports.push(event.detail));
  w.addEventListener('medici:score-ready', event => scoreEvents.push(event.detail));
  w.addEventListener('error', event => { errors.push(event.error || event.message); event.preventDefault(); });
  w.eval(code + '\n//# sourceURL=catalogue.js');
  const get = id => d.getElementById(id);
  t.after(() => {
    w.dispatchEvent(new w.Event('pagehide'));
    w.close();
    assert.deepEqual(errors, [], 'Catalogue must not raise uncaught DOM errors');
  });
  return {
    w, d, get, requests, imports, scoreEvents, workers, audio, api: w.MediciCatalogue,
    async search(query = 'Example Composer') {
      get('catalogue-query').value = query;
      get('catalogue-form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
      await flush();
    },
    async use(index = 0) { d.querySelectorAll('.catalogue-use')[index].click(); await flush(); },
    status: () => get('catalogue-status').textContent,
  };
}

// All requests are mocked. Startup and typed queries must never contact Wikimedia.
test('catalogue is idle until an explicit nonempty search; startup creates no audio or OMR work', async t => {
  const h = harness(t);
  await flush();
  h.get('catalogue-query').value = 'Bach';
  h.get('catalogue-query').dispatchEvent(new h.w.Event('input', { bubbles: true }));
  await flush();
  assert.equal(h.requests.length, 0);
  await h.search('   ');
  assert.equal(h.requests.length, 0);
  assert.match(h.status(), /Enter a piece, composer or instrument/);
  assert.equal(h.d.activeElement.id, 'catalogue-query');
  assert.deepEqual(h.workers, []);
  assert.deepEqual(h.audio, []);
  assert.deepEqual(h.imports, []);
});

test('search uses an encoded fixed HTTPS API, strips query operators, and omits credentials/referrer', async t => {
  const h = harness(t, { fetch: () => jsonResponse(result([])) });
  await h.search('Für Elise & titles=Other #? "filemime:html"');
  assert.equal(h.requests.length, 1);
  const { url, init } = h.requests[0];
  const parsed = new URL(url);
  assert.equal(parsed.origin + parsed.pathname, 'https://commons.wikimedia.org/w/api.php');
  assert.equal(parsed.searchParams.get('action'), 'query');
  assert.equal(parsed.searchParams.get('origin'), '*');
  assert.equal(parsed.searchParams.get('gsrnamespace'), '6');
  assert.equal(parsed.searchParams.get('gsrlimit'), '20');
  assert.match(parsed.searchParams.get('gsrsearch'), /^filemime:pdf deepcat:"PDF files of sheet music" filesize:<15360 /);
  assert.match(parsed.searchParams.get('gsrsearch'), /Für Elise/);
  const searchPrefix = 'filemime:pdf deepcat:"PDF files of sheet music" filesize:<15360 ';
  assert.doesNotMatch(parsed.searchParams.get('gsrsearch').slice(searchPrefix.length), /[&=:#?"<>]/);
  assert.equal(parsed.searchParams.has('titles'), false);
  assert.equal(init.credentials, 'omit');
  assert.equal(init.referrerPolicy, 'no-referrer');
  assert.ok(init.signal instanceof AbortSignal);
  assert.equal(h.get('catalogue-form').hasAttribute('aria-busy'), false);
  assert.match(h.api.apiURL({ titles: 'File:A&B #?.pdf' }), /titles=File%3AA%26B\+%23%3F.pdf/);
});

test('suggestion buttons run an explicit search and leave recognition/playback untouched', async t => {
  const h = harness(t, { fetch: () => jsonResponse(result([page()])) });
  h.d.querySelector('[data-score-query="Bach"]').click();
  await flush();
  assert.equal(h.get('catalogue-query').value, 'Bach');
  assert.equal(h.requests.length, 1);
  assert.equal(h.d.querySelectorAll('.catalogue-result').length, 1);
  assert.deepEqual(h.imports, []);
  assert.deepEqual(h.workers, []);
  assert.deepEqual(h.audio, []);
  assert.deepEqual(h.scoreEvents, []);
});

test('trusted URL validation rejects scheme, host, credential, port and path confusion', t => {
  const { api } = harness(t);
  assert.equal(api.safeURL(PDF_URL + '?download=1#page=2', 'pdf'), PDF_URL);
  assert.equal(api.safeURL(SOURCE_URL, 'source'), SOURCE_URL);
  assert.equal(api.safeURL('https://creativecommons.org/licenses/by-sa/4.0/', 'license'), 'https://creativecommons.org/licenses/by-sa/4.0/');
  for (const url of [
    'http://upload.wikimedia.org/wikipedia/commons/a/ab/Example.pdf',
    'https://upload.wikimedia.org.evil.test/wikipedia/commons/a/ab/Example.pdf',
    'https://upload.wikimedia.org@evil.test/wikipedia/commons/a/ab/Example.pdf',
    'https://user:pass@upload.wikimedia.org/wikipedia/commons/a/ab/Example.pdf',
    'https://upload.wikimedia.org:444/wikipedia/commons/a/ab/Example.pdf',
    'https://upload.wikimedia.org/wikipedia/en/a/ab/Example.pdf',
    'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Example.pdf',
    'https://upload.wikimedia.org/wikipedia/commons/a/ab/Example.html',
    'data:application/pdf,%PDF-1.7', 'javascript:alert(1)',
  ]) assert.equal(api.safeURL(url, 'pdf'), '', url);
  for (const url of ['http://commons.wikimedia.org/wiki/File:Score.pdf', 'https://evil.test/wiki/File:Score.pdf', 'https://commons.wikimedia.org/w/index.php', 'javascript:alert(1)']) {
    assert.equal(api.safeURL(url, 'source'), '', url);
  }
  for (const url of ['http://creativecommons.org/licenses/by/4.0/', 'https://creativecommons.org.evil.test/licenses/by/4.0/', 'https://creativecommons.org/licenses/by-nc/4.0/', 'https://creativecommons.org/licenses/by-sa/4.0/deed.en', 'https://evil.test/']) {
    assert.equal(api.safeURL(url, 'license'), '', url);
  }
});

test('only explicitly supported public-domain and attribution licenses enter results', t => {
  const { api } = harness(t);
  for (const label of ['Public domain', 'CC0', 'CC Zero', 'CC BY 4.0', 'CC BY-SA 4.0', 'CC BY 3.0']) {
    const score = api.scoreFromPage(page({ metadata: { LicenseShortName: { value: label } } }));
    assert.ok(score, label);
    assert.match(score.licenseUrl, /^https:\/\/creativecommons\.org\//);
  }
  for (const label of ['', 'unknown', 'Copyrighted', 'Fair use', 'PD-US', 'CC BY-NC 4.0', 'CC BY-ND 4.0', 'CC BY-SA 4.0, CC BY 3.0', 'CC BY-SA 4.0 France']) {
    assert.equal(api.scoreFromPage(page({ metadata: { LicenseShortName: { value: label } } })), null, label);
  }
  assert.equal(api.scoreFromPage(page({ metadata: { LicenseShortName: { value: 'CC BY 4.0' }, Artist: { value: '' }, Credit: { value: '' } } })), null);
  assert.ok(api.scoreFromPage(page({ metadata: { LicenseShortName: { value: 'CC BY 4.0' }, Artist: { value: '' }, Credit: { value: 'Credit to Example Editor' } } })));
});

test('scores fail closed for wrong MIME, missing image data, unsafe URLs and unsupported sizes', t => {
  const { api } = harness(t);
  assert.equal(api.scoreFromPage(null), null);
  assert.equal(api.scoreFromPage({ title: 'File:Missing.pdf' }), null);
  for (const info of [
    { mime: 'text/html' }, { size: 0 }, { size: 7 }, { size: MAX_BYTES + 1 },
    { size: '100' }, { size: Infinity }, { url: 'https://evil.test/score.pdf' },
    { descriptionurl: 'javascript:alert(1)' },
  ]) assert.equal(api.scoreFromPage(page({ info })), null, JSON.stringify(info));
  assert.ok(api.scoreFromPage(page({ info: { size: MAX_BYTES } })));
  assert.equal(api.scoreFromPage(page({ info: { pagecount: '2' } })).pages, null);
});

test('hidden category preflight preserves modern arrangement CC terms and rejects conflicting/unsupported variants', t => {
  const { api } = harness(t);
  const score = api.scoreFromPage(page({ categories: ['Category:PD-old', 'Category:CC-BY-SA-4.0'] }), true);
  assert.equal(score.license, 'CC BY-SA 4.0');
  assert.equal(score.licenseUrl, 'https://creativecommons.org/licenses/by-sa/4.0/');
  assert.equal(api.scoreFromPage(page({ categories: ['Category:CC-Zero'] }), true).license, 'CC0 1.0');
  for (const categories of [
    ['Category:CC-BY-SA-4.0', 'Category:CC-BY-3.0'],
    ['Category:CC-BY-SA-4.0', 'Category:CC-Zero'],
    ['Category:CC-BY-SA-3.0-DE'], ['Category:CC-BY-NC-4.0'],
  ]) assert.equal(api.scoreFromPage(page({ categories }), true), null, categories.join(', '));
  assert.ok(api.scoreFromPage(page({ categories: ['Category:CC-BY-SA-4.0', 'Category:CC-BY-SA-4.0'] }), true));
});

test('HTML metadata becomes bounded plain text and results never insert active metadata markup', async t => {
  const malicious = page({
    page: { title: 'File:<img src=x onerror="window.pwned=1">Famous_<b>Score</b>.pdf' },
    metadata: {
      Artist: { value: '<script>window.pwned=2</script><b>Alice &amp; Bob</b><img src=x onerror="window.pwned=3">' },
      Credit: { value: '<iframe src="https://evil.test"></iframe><style>body{display:none}</style> Archive <a href="javascript:alert(1)">credit</a>' },
    },
  });
  const h = harness(t, { fetch: () => jsonResponse(result([malicious])) });
  await h.search();
  const item = h.d.querySelector('.catalogue-result');
  assert.equal(item.querySelector('h4').textContent, 'Famous Score');
  assert.equal(item.querySelector('.catalogue-credit').textContent, 'Alice & Bob');
  assert.equal(item.querySelectorAll('script,img,iframe,style,object').length, 0);
  assert.equal(h.w.pwned, undefined);
  assert.equal(h.api.plain('<script>x</script><style>x</style><object>x</object> A   &amp;  B ', 3), 'A &');
  assert.equal(h.api.plain('x'.repeat(1000), 20).length, 20);
  for (const anchor of item.querySelectorAll('a')) {
    assert.match(anchor.href, /^https:\/\/(commons|upload)\.wikimedia\.org\//);
    assert.equal(anchor.target, '_blank');
    assert.equal(anchor.rel, 'noopener noreferrer');
  }
});

test('source sanitization and exported attribution retain required creator, credit, links and ShareAlike notice', t => {
  const h = harness(t);
  const raw = h.api.scoreFromPage(page({ metadata: { LicenseShortName: { value: 'CC BY-SA 4.0' } } }));
  const source = h.api.sanitizeSource({ ...raw, title: '<b>Example</b>', creator: '<i>Creator</i>', credit: '<b>Archive</b>', unexpected: 'discard' });
  assert.equal(source.title, 'Example');
  assert.equal(source.creator, 'Creator');
  assert.equal(source.credit, 'Archive');
  assert.equal(source.unexpected, undefined);
  const text = h.api.attribution(source);
  for (const value of ['Creator', 'Archive', SOURCE_URL, PDF_URL, 'CC BY-SA 4.0', raw.licenseUrl, 'ShareAlike', 'experimental optical music recognition']) assert.ok(text.includes(value), value);
  for (const patch of [
    { provider: 'Untrusted' }, { pdfUrl: 'https://evil.test/test.pdf' },
    { sourceUrl: 'javascript:alert(1)' }, { licenseUrl: 'https://evil.test/license' },
    { license: 'CC BY-NC 4.0' },
  ]) assert.equal(h.api.sanitizeSource({ ...raw, ...patch }), null);
});

test('search filters unsupported entries, preserves API ranking and explains further results', async t => {
  const h = harness(t, { fetch: () => jsonResponse(result([
    page({ page: { title: 'File:Second.pdf', index: 2 } }),
    page({ page: { title: 'File:Rejected.pdf', index: 3 }, metadata: { LicenseShortName: { value: 'Fair use' } } }),
    page({ page: { title: 'File:First.pdf', index: 1 } }),
  ], { continue: { gsroffset: 20 } })) });
  await h.search();
  assert.deepEqual([...h.d.querySelectorAll('.catalogue-result h4')].map(node => node.textContent), ['First', 'Second']);
  assert.match(h.status(), /2 scores found/);
  assert.match(h.status(), /more specific search/);
  assert.match(h.d.querySelector('.catalogue-meta').textContent, /2 pages.*Public domain/);
});

test('empty results and HTTP/API failures give retryable user-facing states', async t => {
  let mode = 'empty';
  const h = harness(t, { fetch: () => mode === 'http' ? { ok: false } : jsonResponse(mode === 'api' ? { error: { code: 'bad-query' } } : result(mode === 'success' ? [page()] : [])) });
  await h.search();
  assert.match(h.status(), /No supported free PDFs found/);
  mode = 'http'; await h.search();
  assert.match(h.status(), /unavailable/);
  assert.equal(h.get('catalogue-status').classList.contains('error'), true);
  mode = 'api'; await h.search();
  assert.match(h.status(), /simpler title or composer/);
  mode = 'success'; await h.search();
  assert.match(h.status(), /1 score found/);
  assert.equal(h.get('catalogue-status').classList.contains('error'), false);
  assert.equal(h.get('catalogue-form').hasAttribute('aria-busy'), false);
});

test('a newer search aborts the first and suppresses stale successful responses', async t => {
  const first = deferred(), second = deferred();
  const h = harness(t, { fetch: (_, count) => count === 1 ? first.promise : second.promise });
  await h.search('Old search');
  assert.equal(h.get('catalogue-form').getAttribute('aria-busy'), 'true');
  await h.search('New search');
  assert.equal(h.requests[0].init.signal.aborted, true);
  second.resolve(jsonResponse(result([page({ page: { title: 'File:New_score.pdf' } })])));
  await flush();
  first.resolve(jsonResponse(result([page({ page: { title: 'File:Stale_score.pdf' } })])));
  await flush();
  assert.equal(h.d.querySelector('.catalogue-result h4').textContent, 'New score');
  assert.match(h.status(), /1 score found/);
  assert.equal(h.get('catalogue-form').hasAttribute('aria-busy'), false);
});

test('unsupported recognition leaves search/source links useful but disables import', async t => {
  const h = harness(t, { unsupported: true, fetch: () => jsonResponse(result([page()])) });
  await h.search();
  assert.equal(h.d.querySelector('.catalogue-use').disabled, true);
  assert.equal(h.d.querySelectorAll('.catalogue-actions a').length, 2);
  await h.use();
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.imports, []);
});

test('PDF download validates bytes, returns a PDF File and uses bounded streaming without credentials or redirects', async t => {
  const stream = pdfResponse({ chunks: [pdfBytes.subarray(0, 4), pdfBytes.subarray(4)] });
  const h = harness(t, { fetch: () => stream.response });
  const score = h.api.scoreFromPage(page());
  const progress = [];
  const file = await h.api.downloadPDF(score, new AbortController().signal, size => progress.push(size));
  assert.equal(file.name, 'Example score.pdf');
  assert.equal(file.type, 'application/pdf');
  assert.equal(file.size, pdfBytes.length);
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), pdfBytes);
  assert.deepEqual(progress, [4, pdfBytes.length]);
  assert.equal(h.requests[0].url, PDF_URL);
  assert.equal(h.requests[0].init.redirect, 'error');
  assert.equal(h.requests[0].init.credentials, 'omit');
  assert.equal(h.requests[0].init.referrerPolicy, 'no-referrer');
  assert.equal(stream.stats.released, 1);
});

test('download refuses unsafe URLs before fetching and refuses bad HTTP, MIME, header size or missing streaming support', async t => {
  let stream;
  const h = harness(t, { fetch: () => stream.response });
  const score = h.api.scoreFromPage(page());
  await assert.rejects(h.api.downloadPDF({ ...score, pdfUrl: 'https://evil.test/score.pdf' }, new AbortController().signal), /supported Wikimedia address/);
  assert.equal(h.requests.length, 0);
  for (const [options, message] of [
    [{ ok: false }, /could not be downloaded/],
    [{ headers: { 'content-type': 'text/html' } }, /did not return a PDF/],
    [{ headers: { 'content-length': String(MAX_BYTES + 1) } }, /over 15 MB/],
    [{ noStream: true }, /cannot safely download/],
    [{ chunks: [bytes('<html>Not a PDF</html>')] }, /not a valid PDF/],
  ]) {
    stream = pdfResponse(options);
    await assert.rejects(h.api.downloadPDF(score, new AbortController().signal), message);
  }
});

test('15 MB limit is enforced against actual streamed bytes even without or with a false length', async t => {
  const full = new Uint8Array(MAX_BYTES);
  full.set(pdfBytes);
  let stream = pdfResponse({ chunks: [full] });
  const h = harness(t, { fetch: () => stream.response });
  const score = h.api.scoreFromPage(page());
  const file = await h.api.downloadPDF(score, new AbortController().signal);
  assert.equal(file.size, MAX_BYTES);
  for (const headers of [{}, { 'content-length': '12' }]) {
    stream = pdfResponse({ chunks: [full, new Uint8Array([0])], headers });
    await assert.rejects(h.api.downloadPDF(score, new AbortController().signal), /over 15 MB/);
    assert.equal(stream.stats.cancelled, 1);
    assert.equal(stream.stats.released, 1);
    assert.equal(stream.stats.reads, 2);
  }
});

test('stream errors and cancellation stop the reader and release its lock', async t => {
  let stream = pdfResponse({ read: async () => { throw new Error('Connection lost'); } });
  const h = harness(t, { fetch: () => stream.response });
  const score = h.api.scoreFromPage(page());
  await assert.rejects(h.api.downloadPDF(score, new AbortController().signal), /Connection lost/);
  assert.equal(stream.stats.cancelled, 1);
  assert.equal(stream.stats.released, 1);
  const controller = new AbortController();
  stream = pdfResponse({ read: async () => { controller.abort(); return { done: false, value: pdfBytes }; } });
  await assert.rejects(h.api.downloadPDF(score, controller.signal), error => error.name === 'AbortError');
  assert.equal(stream.stats.cancelled, 1);
  assert.equal(stream.stats.released, 1);
  assert.equal(stream.stats.reads, 1);
});

test('import rechecks exact title and hidden license categories, then hands file and attribution to existing OMR', async t => {
  const stream = pdfResponse();
  const h = harness(t, { fetch: (request, count) => count === 1 ? jsonResponse(result([page()])) : count === 2 ? jsonResponse(result([page({ categories: ['Category:CC-BY-SA-4.0'] })])) : stream.response });
  await h.search();
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.imports, []);
  await h.use();
  assert.equal(h.requests.length, 3);
  const preflight = new URL(h.requests[1].url);
  assert.equal(preflight.searchParams.get('titles'), 'File:Example_score.pdf');
  assert.equal(preflight.searchParams.get('prop'), 'imageinfo|categories');
  assert.equal(preflight.searchParams.get('cllimit'), 'max');
  assert.equal(h.imports.length, 1);
  const { file, source } = h.imports[0];
  assert.equal(file.name, 'Example score.pdf');
  assert.equal(source.license, 'CC BY-SA 4.0');
  assert.equal(source.licenseUrl, 'https://creativecommons.org/licenses/by-sa/4.0/');
  assert.equal(source.creator, 'Example Composer');
  assert.equal(source.credit, 'Example Archive, scan by Example Editor');
  assert.equal(source.sourceUrl, SOURCE_URL);
  assert.equal(source.pdfUrl, PDF_URL);
  assert.equal(h.get('catalogue-cancel').hidden, true);
  assert.equal(h.d.querySelector('.catalogue-use').disabled, false);
  assert.match(h.status(), /Reading the notes on this device/);
  assert.deepEqual(h.workers, []);
  assert.deepEqual(h.audio, []);
  assert.deepEqual(h.scoreEvents, []);
});

test('incomplete or unsafe preflight categories fail closed before PDF download and allow retry', async t => {
  let mode = 'continued';
  const h = harness(t, { fetch: (_, count) => count === 1 ? jsonResponse(result([page()])) : jsonResponse(result([page({ categories: mode === 'regional' ? ['Category:CC-BY-SA-3.0-DE'] : [] })], mode === 'continued' ? { continue: { clcontinue: 'more' } } : {})) });
  await h.search();
  await h.use();
  assert.equal(h.requests.length, 2);
  assert.match(h.status(), /licence or file details need a closer look/);
  assert.deepEqual(h.imports, []);
  assert.equal(h.get('catalogue-cancel').hidden, true);
  assert.equal(h.d.querySelector('.catalogue-use').disabled, false);
  mode = 'regional';
  await h.use();
  assert.equal(h.requests.length, 3);
  assert.match(h.status(), /closer look/);
  assert.deepEqual(h.imports, []);
});

test('cancel during metadata preflight aborts it, preserves cancellation state and suppresses a late response', async t => {
  const pending = deferred();
  const h = harness(t, { fetch: (_, count) => count === 1 ? jsonResponse(result([page()])) : pending.promise });
  await h.search();
  await h.use();
  assert.equal(h.get('catalogue-cancel').hidden, false);
  assert.equal(h.d.querySelector('.catalogue-use').disabled, true);
  h.get('catalogue-cancel').click();
  assert.equal(h.requests[1].init.signal.aborted, true);
  pending.resolve(jsonResponse(result([page()])));
  await flush();
  assert.equal(h.requests.length, 2);
  assert.deepEqual(h.imports, []);
  assert.match(h.status(), /cancelled.*unchanged/);
  assert.equal(h.d.querySelector('.catalogue-use').disabled, false);
});

test('a cancelled PDF response cannot hand off a stale import and a repeated explicit import succeeds', async t => {
  const pending = deferred();
  let downloads = 0;
  const h = harness(t, { fetch: request => {
    if (request.url.startsWith('https://commons.wikimedia.org/')) return jsonResponse(result([page()]));
    return ++downloads === 1 ? pending.promise : pdfResponse().response;
  } });
  await h.search();
  await h.use();
  assert.equal(h.requests.length, 3);
  h.get('catalogue-cancel').click();
  assert.equal(h.requests[2].init.signal.aborted, true);
  pending.resolve(pdfResponse().response);
  await flush();
  assert.deepEqual(h.imports, []);
  assert.match(h.status(), /cancelled/);
  await h.use();
  assert.equal(h.imports.length, 1);
  assert.equal(downloads, 2);
});

test('new searches cancel imports and stale downloads do not overwrite their results', async t => {
  const pending = deferred();
  const h = harness(t, { fetch: (request, count) => {
    if (count === 1 || count === 2) return jsonResponse(result([page()]));
    if (count === 3) return pending.promise;
    return jsonResponse(result([page({ page: { title: 'File:New_piece.pdf' } })]));
  } });
  await h.search('First');
  await h.use();
  await h.search('Second');
  assert.equal(h.requests[2].init.signal.aborted, true);
  pending.resolve(pdfResponse().response);
  await flush();
  assert.deepEqual(h.imports, []);
  assert.equal(h.d.querySelector('.catalogue-result h4').textContent, 'New piece');
  assert.match(h.status(), /1 score found/);
});

test('a local PDF starting or page exit aborts pending searches before stale results render', async t => {
  const pending = [];
  const h = harness(t, { fetch: () => { const wait = deferred(); pending.push(wait); return wait.promise; } });
  await h.search('Before local upload');
  h.w.dispatchEvent(new h.w.Event('medici:pdf-started'));
  assert.equal(h.requests[0].init.signal.aborted, true);
  pending[0].resolve(jsonResponse(result([page()])));
  await flush();
  assert.equal(h.d.querySelectorAll('.catalogue-result').length, 0);
  assert.equal(h.get('catalogue-form').hasAttribute('aria-busy'), false);
  await h.search('Before exit');
  h.w.dispatchEvent(new h.w.Event('pagehide'));
  assert.equal(h.requests[1].init.signal.aborted, true);
  pending[1].resolve(jsonResponse(result([page()])));
  await flush();
  assert.equal(h.d.querySelectorAll('.catalogue-result').length, 0);
});

test('cancel at the final stream read or during magic-byte read cannot return a completed PDF', async t => {
  const finalRead = deferred(), controller = new AbortController();
  let stream = pdfResponse({ read: async index => index === 0 ? { done: false, value: pdfBytes } : finalRead.promise });
  const h = harness(t, { fetch: () => stream.response });
  const score = h.api.scoreFromPage(page());
  const downloading = h.api.downloadPDF(score, controller.signal);
  await flush();
  controller.abort();
  finalRead.resolve({ done: true });
  await assert.rejects(downloading, error => error.name === 'AbortError');
  assert.equal(stream.stats.released, 1);

  const headerRead = deferred(), headerController = new AbortController();
  h.w.Blob = class extends Blob {
    slice() { return { arrayBuffer: () => headerRead.promise }; }
  };
  stream = pdfResponse();
  const validating = h.api.downloadPDF(score, headerController.signal);
  await flush();
  headerController.abort();
  headerRead.resolve(pdfBytes.buffer);
  await assert.rejects(validating, error => error.name === 'AbortError');
});

test('PDF failures keep the original actionable error rather than becoming a timeout', async t => {
  const h = harness(t, { fetch: request => request.url.startsWith('https://commons.wikimedia.org/')
    ? jsonResponse(result([page()]))
    : pdfResponse({ chunks: [bytes('not a real PDF file')] }).response });
  await h.search();
  await h.use();
  assert.match(h.status(), /not a valid PDF/);
  assert.doesNotMatch(h.status(), /timed out/);
  assert.equal(h.get('catalogue-status').classList.contains('error'), true);
  assert.equal(h.get('catalogue-cancel').hidden, true);
  assert.equal(h.d.querySelector('.catalogue-use').disabled, false);
  assert.deepEqual(h.imports, []);
});

test('choosing even an invalid native upload immediately aborts pending catalogue search and import', async t => {
  const searchWait = deferred();
  const searching = harness(t, { fetch: () => searchWait.promise });
  await searching.search('Pending');
  Object.defineProperty(searching.get('sheet-pdf'), 'files', { configurable: true, value: [{ name: 'invalid.txt', size: 1 }] });
  searching.get('sheet-pdf').dispatchEvent(new searching.w.Event('change'));
  assert.equal(searching.requests[0].init.signal.aborted, true);
  searchWait.resolve(jsonResponse(result([page()])));
  await flush();
  assert.equal(searching.d.querySelectorAll('.catalogue-result').length, 0);
  assert.equal(searching.get('catalogue-form').hasAttribute('aria-busy'), false);

  const importWait = deferred();
  const importing = harness(t, { fetch: (_, count) => count === 1 ? jsonResponse(result([page()])) : importWait.promise });
  await importing.search();
  await importing.use();
  Object.defineProperty(importing.get('sheet-pdf'), 'files', { configurable: true, value: [{ name: 'too-big.pdf', size: MAX_BYTES + 1 }] });
  importing.get('sheet-pdf').dispatchEvent(new importing.w.Event('change'));
  assert.equal(importing.requests[1].init.signal.aborted, true);
  importWait.resolve(jsonResponse(result([page()])));
  await flush();
  assert.equal(importing.requests.length, 2);
  assert.deepEqual(importing.imports, []);
  assert.equal(importing.get('catalogue-cancel').hidden, true);
});

test('a rejected stale search cannot replace newer results with an error', async t => {
  const first = deferred();
  const h = harness(t, { fetch: (_, count) => count === 1 ? first.promise : jsonResponse(result([page()])) });
  await h.search('Old');
  await h.search('New');
  first.reject(new Error('Obsolete network failure'));
  await flush();
  assert.match(h.status(), /1 score found/);
  assert.doesNotMatch(h.status(), /Obsolete/);
  assert.equal(h.get('catalogue-status').classList.contains('error'), false);
  assert.equal(h.d.querySelectorAll('.catalogue-result').length, 1);
});
