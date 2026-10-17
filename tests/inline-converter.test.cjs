const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JSDOM}=require('jsdom');
const root=path.resolve(__dirname,'..');
const tick=()=>new Promise(r=>setTimeout(r,15));
function setup(options={}) {
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'fixtures/inline-pdf.html'),'utf8'),{url:'https://example.test/medici/',runScripts:'outside-only'});
 const w=dom.window,d=w.document,events=[],workers=[],readPages=[];let loads=0,parseCount=0,started=0,releaseDestroy;
 const destroyGate=options.holdDestroy?new Promise(r=>releaseDestroy=r):Promise.resolve();
 w.WebAssembly={instantiate:options.unsupported?undefined:function(){},Suspending:options.noJSPI?undefined:function(){},promising:options.noJSPI?undefined:function(){}};
 Object.defineProperty(w.crypto,'subtle',{value:{}});
 w.HTMLCanvasElement.prototype.toBlob=function(cb){cb({arrayBuffer:async()=>new w.ArrayBuffer(4)});};
 const page={getViewport:({scale})=>({width:595*scale,height:842*scale}),render:()=>({promise:Promise.resolve(),cancel(){}}),cleanup(){}};
 w.__loadPDF=async()=>{loads++;return {GlobalWorkerOptions:{},getDocument:()=>({promise:Promise.resolve({numPages:options.pages||2,getPage:async n=>{readPages.push(n);return page;}}),destroy:()=>destroyGate})};};
 w.Worker=class {
  constructor(){this.terminated=false;workers.push(this);}
  postMessage(data){if(options.throwPostMessage)throw new Error('Worker message failed');this.last=data;if(options.holdWorker)return;queueMicrotask(()=>{if(!this.terminated)this.onmessage?.({data:options.workerError?{type:'error',msg:'Test recognition error'}:data.type==='init'?{type:'ready'}:{type:'result',xml:'<score-partwise/>'}});});}
  terminate(){this.terminated=true;}
 };
 w.MediciMusicXML={parsePages:(pages,options)=>{parseCount=pages.length;return {bytes:new w.Uint8Array([77,84,104,100]),summary:{notes:8,tracks:1,pages:pages.length,tempo:options.tempo,warnings:[]}};}};
 w.addEventListener('medici:pdf-started',()=>started++);
 w.addEventListener('medici:score-ready',event=>events.push(event.detail));
 const code=fs.readFileSync(path.join(root,'inline-converter.js'),'utf8').replace("import(PDFJS + 'pdf.min.mjs')","window.__loadPDF()");
 w.eval(code);
 const select=(file={name:'score.pdf',size:100,slice:()=>({arrayBuffer:async()=>new TextEncoder().encode('%PDF-1.7').buffer}),arrayBuffer:async()=>new w.ArrayBuffer(8)})=>{
  Object.defineProperty(d.getElementById('sheet-pdf'),'files',{configurable:true,value:[file]});
  d.getElementById('sheet-pdf').dispatchEvent(new w.Event('change'));return file;
 };
 return {w,d,events,workers,readPages,select,loads:()=>loads,parseCount:()=>parseCount,started:()=>started,releaseDestroy:()=>releaseDestroy?.(),close:()=>dom.window.close()};
}
test('inline PDF unsupported state disables upload but leaves useful compatibility text',()=>{const t=setup({unsupported:true});assert.equal(t.d.getElementById('sheet-pdf').disabled,true);assert.match(t.d.getElementById('sheet-status').textContent,/WebAssembly, web workers/);t.select();assert.equal(t.loads(),0);t.close();});
test('browsers without JSPI can upload and complete the async recognition flow',async()=>{const t=setup({noJSPI:true});assert.equal(t.w.WebAssembly.Suspending,undefined);assert.equal(t.w.WebAssembly.promising,undefined);assert.equal(t.d.getElementById('sheet-pdf').disabled,false);t.select();await tick();assert.equal(t.events.length,1);assert.equal(t.workers[0].terminated,true);t.close();});
test('selecting PDF starts conversion automatically and emits MIDI without navigation',async()=>{const t=setup();t.select();assert.equal(t.started(),1);assert.equal(t.d.getElementById('sheet-cancel').hidden,false);await tick();assert.equal(t.events.length,1);assert.equal(t.events[0].name,'score · experimental.mid');assert.equal(t.events[0].bytes.byteLength,4);assert.deepEqual(t.readPages,[1,2]);assert.equal(t.parseCount(),2);assert.equal(t.w.location.href,'https://example.test/medici/');assert.match(t.d.getElementById('sheet-status').textContent,/Choose an instrument/);assert.equal(t.d.getElementById('sheet-cancel').hidden,true);assert.equal(t.d.getElementById('sheet-download').hidden,false);assert.equal(t.workers[0].terminated,true);t.close();});
test('default page selection caps long scores at three and explains the selection',async()=>{const t=setup({pages:8});t.select();await tick();assert.deepEqual(t.readPages,[1,2,3]);assert.match(t.events[0].name,/pages 1–3/);assert.match(t.d.getElementById('sheet-warnings').textContent,/Only pages 1–3 of 8/);t.close();});
test('advanced selection respects starting page, count and tempo',async()=>{const t=setup({pages:8});t.d.getElementById('sheet-first').value='4';t.d.getElementById('sheet-count').value='2';t.d.getElementById('sheet-tempo').value='120';t.select();await tick();assert.deepEqual(t.readPages,[4,5]);assert.equal(t.events[0].summary.tempo,120);t.close();});
test('invalid and oversized files fail before loading engine or dispatching a score',async()=>{const t=setup();t.select({name:'big.pdf',size:16*1024*1024});assert.match(t.d.getElementById('sheet-status').textContent,/under 15 MB/);t.select({name:'fake.pdf',size:10,slice:()=>({arrayBuffer:async()=>new Uint8Array([1,2]).buffer})});await tick();assert.match(t.d.getElementById('sheet-status').textContent,/not a PDF/);assert.equal(t.loads(),0);assert.equal(t.events.length,0);t.close();});
test('invalid advanced settings and out of range pages never initialize OMR',async()=>{const t=setup();t.d.getElementById('sheet-tempo').value='500';t.select();await tick();assert.equal(t.loads(),0);t.d.getElementById('sheet-tempo').value='100';t.d.getElementById('sheet-first').value='3';t.select();await tick();assert.match(t.d.getElementById('sheet-status').textContent,/earlier starting page/);assert.equal(t.workers.length,0);t.close();});
test('cancel during file read suppresses stale completion and permits retry',async()=>{const t=setup();let resolve;t.select({name:'wait.pdf',size:10,slice:()=>({arrayBuffer:()=>new Promise(r=>resolve=r)})});t.d.getElementById('sheet-cancel').click();resolve(new TextEncoder().encode('%PDF-1.7').buffer);await tick();assert.match(t.d.getElementById('sheet-status').textContent,/cancelled/);assert.equal(t.loads(),0);assert.equal(t.events.length,0);assert.equal(t.d.getElementById('sheet-retry').hidden,false);assert.equal(t.d.getElementById('sheet-pdf').disabled,false);t.close();});
test('another score cancels running recognition and terminates the worker',async()=>{const t=setup({holdWorker:true});t.select();await tick();assert.equal(t.workers.length,1);t.w.dispatchEvent(new t.w.Event('medici:cancel-pdf'));await tick();assert.equal(t.workers[0].terminated,true);assert.equal(t.events.length,0);assert.match(t.d.getElementById('sheet-status').textContent,/another score/);assert.equal(t.d.getElementById('sheet-cancel').hidden,true);t.close();});
test('recognition failure leaves retry available and does not replace music',async()=>{const t=setup({workerError:true});t.select();await tick();assert.equal(t.events.length,0);assert.match(t.d.getElementById('sheet-status').textContent,/Test recognition error/);assert.match(t.d.getElementById('sheet-status').textContent,/unchanged/);assert.equal(t.d.getElementById('sheet-retry').hidden,false);assert.equal(t.workers[0].terminated,true);t.close();});
test('repeated upload after success starts a fresh job and choosing another score clears old download',async()=>{const t=setup();t.select();await tick();t.select();await tick();assert.equal(t.events.length,2);assert.equal(t.workers.length,2);t.w.dispatchEvent(new t.w.Event('medici:cancel-pdf'));assert.equal(t.d.getElementById('sheet-download').hidden,true);assert.match(t.d.getElementById('sheet-status').textContent,/Choose a PDF/);t.close();});

test('cancel while PDF cleanup is pending suppresses a finished recognition result',async()=>{const t=setup({holdDestroy:true});t.select();await tick();assert.equal(t.events.length,0);t.w.dispatchEvent(new t.w.Event('medici:cancel-pdf'));t.releaseDestroy();await tick();assert.equal(t.events.length,0);assert.match(t.d.getElementById('sheet-status').textContent,/another score/);assert.equal(t.d.getElementById('sheet-download').hidden,true);t.select();await tick();assert.equal(t.events.length,1);t.close();});
test('synchronous worker message errors are cleaned up and allow retry',async()=>{const t=setup({throwPostMessage:true});t.select();await tick();assert.equal(t.events.length,0);assert.equal(t.workers[0].terminated,true);assert.match(t.d.getElementById('sheet-status').textContent,/Worker message failed/);assert.equal(t.d.getElementById('sheet-retry').hidden,false);t.close();});

test('catalogue import enters the same converter and preserves source through retry only',async()=>{
 const t=setup();
 const source={provider:'Wikimedia Commons',title:'Imported score',license:'Public domain'};
 t.w.MediciCatalogue={sanitizeSource:value=>value?.provider==='Wikimedia Commons'?value:null};
 const file={name:'Imported score.pdf',size:100,slice:()=>({arrayBuffer:async()=>new TextEncoder().encode('%PDF-1.7').buffer}),arrayBuffer:async()=>new t.w.ArrayBuffer(8)};
 t.w.dispatchEvent(new t.w.CustomEvent('medici:import-pdf',{detail:{file,source}}));
 await tick();assert.equal(t.events.length,1);assert.equal(t.events[0].source,source);assert.equal(t.started(),1);assert.equal(t.d.getElementById('sheet-retry').hidden,false);
 t.d.getElementById('sheet-retry').click();await tick();assert.equal(t.events.length,2);assert.equal(t.events[1].source,source);
 t.select();await tick();assert.equal(t.events.length,3);assert.equal(t.events[2].source,null);t.close();
});
