'use strict';
const { chromium } = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { Midi } = require('../vendor/midi.js');
const root = path.resolve(__dirname, '..');
const server = http.createServer((req, res) => {
  const file = path.resolve(root, '.' + decodeURIComponent(req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0]));
  if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  try { const data = fs.readFileSync(file); res.setHeader('Content-Type', {'.html':'text/html','.css':'text/css','.js':'text/javascript','.json':'application/json','.svg':'image/svg+xml'}[path.extname(file)] || 'application/octet-stream'); res.end(data); }
  catch { res.writeHead(404).end(); }
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({headless:true, ...(process.env.CHROMIUM_PATH ? {executablePath:process.env.CHROMIUM_PATH} : {}), args:['--no-sandbox']});
  try {
    const page = await browser.newPage({viewport:{width:1440,height:1000}});
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`, {waitUntil:'networkidle'});
    await page.waitForFunction(() => document.querySelector('#instrument-select').options.length === 128);
    assert.equal(await page.locator('#play').isDisabled(), true);
    assert.equal(await page.locator('iframe, #midi-file, #load-demo, #load-love-duty').count(), 0);
    assert.equal(await page.locator('[data-instrument]').count(), 8);
    await page.locator('[data-family="strings"]').click();
    assert.equal(await page.locator('[data-instrument="violin"]').count(), 1);
    await page.locator('#instrument-search').fill('  SAXOPHONE ');
    assert.equal(await page.locator('[data-instrument]').count(), 4);
    await page.locator('[data-instrument="alto_sax"]').press('Enter');
    assert.equal(await page.locator('#instrument-badge').innerText(), 'ALTO SAX');
    await page.locator('#instrument-search').fill('unknown qqq');
    assert.equal(await page.locator('#instrument-empty').isVisible(), true);
    await page.locator('#reset-instrument-search').click();
    assert.equal(await page.locator('[data-instrument]').count(), 128);
    await page.locator('[data-family="featured"]').click();
    await page.locator('[data-instrument="violin"]').press('Space');
    assert.equal(await page.locator('#instrument-select').inputValue(), 'violin');
    await page.locator('#preview').click();
    await page.waitForFunction(() => /Previewing|Couldn.t/.test(document.querySelector('#status').textContent), {}, {timeout:60000});
    assert.match(await page.locator('#status').innerText(), /^Previewing/);
    await page.locator('#preview').click();
    if (process.env.PDF_FIXTURE) {
      await page.locator('#sheet-pdf').setInputFiles(path.resolve(process.env.PDF_FIXTURE));
      await page.waitForFunction(() => !document.querySelector('#play').disabled || document.querySelector('#sheet-status').classList.contains('error'), {}, {timeout:15*60*1000});
      assert.equal(await page.locator('#play').isDisabled(), false, await page.locator('#sheet-status').innerText());
      assert.equal(await page.url(), `http://127.0.0.1:${server.address().port}/`);
    } else {
      const midi = new Midi(); midi.header.setTempo(100);
      midi.addTrack().addNote({midi:60,time:0,duration:4,velocity:.7}).addNote({midi:64,time:4,duration:4,velocity:.7});
      await page.evaluate(bytes => window.dispatchEvent(new CustomEvent('medici:score-ready', {detail:{name:'Browser QA score.mid',bytes:Uint8Array.from(bytes).buffer}})), [...midi.toArray()]);
      console.log('OMR skipped: set PDF_FIXTURE for a real PDF recognition pass. Player uses a generated test score.');
    }
    await page.locator('#play').click();
    await page.waitForFunction(() => document.querySelector('#play-text').textContent === 'Pause');
    await page.waitForTimeout(1100);
    assert.notEqual(await page.locator('#current-time').innerText(), '0:00');
    await page.locator('#play').click();
    await page.locator('#loop').click();
    assert.equal(await page.locator('#loop').getAttribute('aria-pressed'), 'true');
    await page.locator('#restart').click();
    assert.equal(await page.locator('#current-time').innerText(), '0:00');
    await page.locator('.playback-settings summary').click();
    await page.locator('#transpose').selectOption('2');
    const title = await page.locator('#score-name').innerText();
    await page.screenshot({path:path.join(root,'../sheet-studio-desktop.png'),fullPage:true});
    await page.reload({waitUntil:'networkidle'});
    await page.waitForFunction(expected => document.querySelector('#score-name').textContent === expected, title);
    assert.equal(await page.locator('#play-text').innerText(), 'Play score');
    assert.equal(await page.locator('#selected-instrument').innerText(), 'Violin');
    for (const width of [320,390,768]) {
      await page.setViewportSize({width,height:844});
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Overflow at ${width}px`);
    }
    await page.setViewportSize({width:390,height:844});
    await page.screenshot({path:path.join(root,'../sheet-studio-mobile.png'),fullPage:true});
    await page.locator('#clear-midi').click();
    await page.waitForFunction(() => document.querySelector('#clear-midi').hidden);
    await page.reload({waitUntil:'networkidle'});
    assert.equal(await page.locator('#play').isDisabled(), true);
    assert.deepEqual(errors, []);
    console.log('PASS: 128 sounds, search/families/reset, keyboard selection, real sample preview/playback, controls, storage/restore/clear and 320–1440px layout.');
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); server.close(); process.exitCode=1; });
