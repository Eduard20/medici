const { chromium } = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { Midi } = require('../vendor/midi.js');
const root = path.resolve(__dirname, '..');
const server = http.createServer((req, res) => {
  let file = path.join(root, decodeURIComponent(req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0]));
  if (!file.startsWith(root + '/')) { res.writeHead(403).end(); return; }
  try { const data = fs.readFileSync(file); res.setHeader('Content-Type', {'.html':'text/html','.css':'text/css','.js':'text/javascript','.json':'application/json','.svg':'image/svg+xml'}[path.extname(file)] || 'application/octet-stream'); res.end(data); }
  catch { res.writeHead(404).end(); }
});
(async()=>{
 await new Promise(resolve=>server.listen(8765,'127.0.0.1',resolve));
 const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH ? {executablePath:process.env.CHROMIUM_PATH} : {}),args:['--no-sandbox']});
 try {
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 const errors=[]; page.on('pageerror',error=>errors.push(error.message));
 await page.goto('http://127.0.0.1:8765/', {waitUntil:'networkidle'});
 await page.screenshot({path:path.join(root,'../medici-desktop.png'),fullPage:true});
 assert.equal(await page.locator('h1').innerText(),'Love\nfor Duty.');
 assert.equal(await page.locator('#play').isDisabled(),true);
 assert.equal(await page.locator('#instrument-select option').count(),128);
 await page.locator('[data-instrument="violin"]').click();
 assert.equal(await page.locator('[data-instrument="violin"]').getAttribute('aria-pressed'),'true');
 assert.equal(await page.locator('#instrument-select').inputValue(),'violin');
 await page.locator('#preview').click();
 await page.waitForFunction(()=>/Previewing|Couldn.t/.test(document.querySelector('#status').textContent),{},{timeout:30000});
 const previewStatus=await page.locator('#status').innerText();
 console.log('SAMPLE PREVIEW:',previewStatus);
 assert.ok(previewStatus.startsWith('Previewing'),previewStatus);
 await page.locator('#preview').click();
 const midi=new Midi(); midi.header.setTempo(100); let track=midi.addTrack(); track.name='Test melody';
 track.addNote({midi:60,time:0,duration:3,velocity:.7}).addNote({midi:64,time:3,duration:3,velocity:.7}).addNote({midi:67,time:6,duration:3,velocity:.7});
 const drum=midi.addTrack(); drum.channel=9; drum.addNote({midi:36,time:0,duration:1,velocity:1});
 await page.locator('#midi-file').setInputFiles({name:'local-test.mid',mimeType:'audio/midi',buffer:Buffer.from(midi.toArray())});
 await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('MIDI ready'));
 assert.equal(await page.locator('#play').isDisabled(),false);
 assert.match(await page.locator('#score-meta').innerText(),/^3 notes/);
 await page.locator('#play').click();
 await page.waitForFunction(()=>document.querySelector('#play-text').textContent==='Pause');
 await page.waitForTimeout(1200);
 assert.notEqual(await page.locator('#current-time').innerText(),'0:00');
 await page.locator('#play').click();
 assert.equal(await page.locator('#play-text').innerText(),'Play arrangement');
 await page.locator('#loop').click(); assert.equal(await page.locator('#loop').getAttribute('aria-pressed'),'true');
 await page.locator('#restart').click(); assert.equal(await page.locator('#current-time').innerText(),'0:00');
 await page.locator('#instrument-select').selectOption('acoustic_guitar_nylon');
 await page.locator('#play').click(); await page.waitForFunction(()=>document.querySelector('#play-text').textContent==='Pause',{}, {timeout:30000});
 await page.locator('#play').click();
 await page.locator('#midi-file').setInputFiles({name:'bad.mid',mimeType:'audio/midi',buffer:Buffer.from('not midi')});
 await page.waitForFunction(()=>document.querySelector('#status').classList.contains('error'));
 assert.match(await page.locator('#status').innerText(),/Couldn’t import/);
 assert.equal(await page.locator('#score-name').innerText(),'local-test');
 await page.locator('#midi-file').setInputFiles({name:'recording.mp3',mimeType:'audio/mpeg',buffer:Buffer.from('fake')});
 await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('MP3'));
 await page.locator('#load-video').click();
 assert.match(await page.locator('#youtube-player').getAttribute('src'),/youtube-nocookie.com\/embed\/QVOhsRnkLZA/);
 assert.equal(await page.locator('#youtube-player').isVisible(),true);
 await page.setViewportSize({width:390,height:844});
 await page.reload({waitUntil:'networkidle'});
 await page.screenshot({path:path.join(root,'../medici-mobile.png'),fullPage:true});
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'mobile horizontal overflow');
 assert.deepEqual(errors,[]);
 console.log('PASS: desktop/mobile layout, 128 instruments, real sample load, local MIDI import, percussion filtering, playback, pause/restart/loop, instrument switching, malformed MIDI, non-MIDI, and official embed URL.');
 } finally {await browser.close();server.close();}
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
