const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM} = require('jsdom');
const root = path.resolve(__dirname,'..');
function setup(supported = true) {
 const dom = new JSDOM(fs.readFileSync(path.join(root,'convert.html'),'utf8'),{url:'https://example.test/medici/convert.html',runScripts:'outside-only'});
 const w=dom.window;
 w.WebAssembly={Suspending:supported?function(){}:undefined,promising:supported?function(){}:undefined};
 w.Worker=function(){}; Object.defineProperty(w.crypto,'subtle',{value:{}});
 w.eval(fs.readFileSync(path.join(root,'converter.js'),'utf8'));
 return {w,d:w.document,close:()=>w.close()};
}
const tick=()=>new Promise(r=>setTimeout(r,20));
test('unsupported browsers disable PDF processing and explain player fallback',()=>{const t=setup(false);assert.equal(t.d.getElementById('pdf-start').disabled,true);assert.match(t.d.getElementById('pdf-status').textContent,/MIDI player still works/);t.close();});
test('no file and oversized file report exact input errors without downloads',async()=>{const t=setup();const start=t.d.getElementById('pdf-start');start.click();assert.match(t.d.getElementById('pdf-status').textContent,/Choose.*PDF first/);Object.defineProperty(t.d.getElementById('pdf-file'),'files',{value:[{name:'big.pdf',size:16*1024*1024}]});start.click();await tick();assert.match(t.d.getElementById('pdf-status').textContent,/under 15 MB/);assert.equal(start.disabled,false);t.close();});
test('invalid page range and tempo reject before reading PDF bytes',async()=>{const t=setup();Object.defineProperty(t.d.getElementById('pdf-file'),'files',{value:[{name:'score.pdf',size:10}]});t.d.getElementById('pdf-first').value='0';t.d.getElementById('pdf-start').click();await tick();assert.match(t.d.getElementById('pdf-status').textContent,/starting page from 1/);t.d.getElementById('pdf-first').value='1';t.d.getElementById('pdf-tempo').value='999';t.d.getElementById('pdf-start').click();await tick();assert.match(t.d.getElementById('pdf-status').textContent,/30–240/);t.close();});
test('non-PDF bytes are rejected and leave existing studio MIDI untouched',async()=>{const t=setup();Object.defineProperty(t.d.getElementById('pdf-file'),'files',{value:[{name:'fake.pdf',size:10,slice:()=>({arrayBuffer:async()=>new Uint8Array([1,2,3]).buffer})}]});t.d.getElementById('pdf-start').click();await tick();assert.match(t.d.getElementById('pdf-status').textContent,/not a PDF/);assert.match(t.d.getElementById('pdf-status').textContent,/saved MIDI was not changed/);assert.equal(t.d.getElementById('pdf-start').disabled,false);assert.equal(t.d.getElementById('pdf-result').hidden,true);t.close();});
test('cancel during pending file read resets UI and stale completion does nothing',async()=>{const t=setup();let done;Object.defineProperty(t.d.getElementById('pdf-file'),'files',{value:[{name:'wait.pdf',size:10,slice:()=>({arrayBuffer:()=>new Promise(r=>done=r)})}]});t.d.getElementById('pdf-start').click();assert.equal(t.d.getElementById('pdf-start').disabled,true);t.d.getElementById('pdf-cancel').click();assert.match(t.d.getElementById('pdf-status').textContent,/cancelled/);done(new Uint8Array([1,2,3]).buffer);await tick();assert.match(t.d.getElementById('pdf-status').textContent,/cancelled/);assert.equal(t.d.getElementById('pdf-start').disabled,false);t.close();});
