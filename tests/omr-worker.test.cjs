'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const workerSource = fs.readFileSync(path.join(__dirname, '../omr-worker.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

function harness({ jspi = false, createSession, recognise } = {}) {
  const events = [], imports = [], attempts = [], downloads = [], reads = [], files = new Map();
  const packages = [], pyodideOptions = [], recognitionCalls = [];
  let adapterRequests = 0;
  const navigator = { hardwareConcurrency: 8, gpu: { async requestAdapter() {
    adapterRequests++;
    return {};
  } } };
  const ort = {
    env: { wasm: {} },
    InferenceSession: { async create(bytes, options) {
      attempts.push({ bytes, providers: Array.from(options.executionProviders), optimization: options.graphOptimizationLevel });
      return createSession ? createSession(bytes, options, attempts.length) : { inputNames: ['input'], outputNames: ['output'] };
    } },
  };
  const run = (...args) => {
    recognitionCalls.push(args);
    return recognise ? recognise(...args) : Promise.resolve('<score-partwise/>');
  };
  // This deliberately fails if the worker reintroduces its former JSPI entrypoint.
  run.callPromising = () => { throw new Error('JSPI must not be used'); };
  const pyodide = {
    setStderr() {}, setStdout() {},
    async loadPackage(names) { packages.push(Array.from(names)); },
    unpackArchive() {}, runPython() {},
    pyimport(name) {
      assert.equal(name, 'runner');
      return { recognise: run, recognise_profiled: run };
    },
    FS: {
      mkdirTree() {},
      writeFile(name, bytes) { files.set(name, bytes); },
      readdir(directory) { return Array.from(files.keys()).filter(name => name.startsWith(directory + '/')).map(name => name.slice(directory.length + 1)); },
      unlink(name) { files.delete(name); },
    },
  };
  const modelData = new Uint8Array([1, 2, 3]);
  const self = { navigator, crossOriginIsolated: false, postMessage: event => events.push(plain(event)) };
  const context = vm.createContext({
    self, navigator, console, URL, URLSearchParams, Uint8Array, Float32Array, BigInt64Array, Int32Array,
    performance: { now: () => 0 }, location: { search: '' },
    WebAssembly: jspi ? { Suspending() {}, promising() {} } : {},
    async __import(url) {
      imports.push(url);
      if (/\/ort\.(?:wasm|webgpu)\.min\.mjs$/.test(url)) return ort;
      if (/\/pyodide\.mjs$/.test(url)) return { async loadPyodide(options) {
        pyodideOptions.push(plain(options));
        return pyodide;
      } };
      throw new Error('Unexpected import: ' + url);
    },
    async fetch(url) {
      // No real fetch or module import is available in this test context.
      assert.ok(['vendor/homr-async.zip', 'omr/onnxruntime.py', 'omr/runner.py'].includes(url), 'Unexpected fetch: ' + url);
      return { async arrayBuffer() { return new ArrayBuffer(0); }, async text() { return '# fake Python fixture'; } };
    },
    __modelBytes: async name => { reads.push(name); return modelData; },
    __downloadModel: async name => { downloads.push(name); },
  });
  // Node's native VM module hook requires a CLI flag. Redirect only the import
  // expression to a fixture hook; all init/session/recognition logic is real.
  assert.equal((workerSource.match(/\bimport\s*\(/g) || []).length, 2);
  vm.runInContext(workerSource.replace(/\bimport\s*\(/g, '__import(') + `
    modelBytes = __modelBytes;
    downloadModel = __downloadModel;
    globalThis.workerTest = {
      models: MODELS,
      setRuntime(value, gpu) { ort = value; useGpu = gpu; },
      state() { return {useGpu, onGpu: [...onGpu], sessions: sessions.length}; }
    };
  `, context, { filename: 'omr-worker.js' });
  return {
    context, self, ort, pyodide, events, imports, attempts, downloads, reads, files,
    packages, pyodideOptions, recognitionCalls, modelData,
    models: Array.from(context.workerTest.models),
    state: () => plain(context.workerTest.state()),
    setRuntime: gpu => context.workerTest.setRuntime(ort, gpu),
    adapterRequests: () => adapterRequests,
  };
}

test('worker retries failed WebGPU session initialization with WASM and reuses verified bytes', async () => {
  const h = harness({ createSession: async (_bytes, options) => {
    if (options.executionProviders.includes('webgpu')) throw new Error('GPU device unavailable');
    return { inputNames: ['input'], outputNames: ['output'] };
  } });
  h.setRuntime(true);
  const info = await h.self.omrOrt.create(h.models[0]);
  assert.equal(info.id, 0);
  assert.deepEqual(h.attempts.map(a => a.providers), [['webgpu', 'wasm'], ['wasm']]);
  assert.equal(h.attempts[0].bytes, h.attempts[1].bytes);
  assert.deepEqual(h.reads, [h.models[0]]);
  assert.deepEqual(h.state(), { useGpu: false, onGpu: [], sessions: 1 });
  assert.ok(h.events.some(e => /WebGPU model setup failed/.test(e.msg || '')));
  await h.self.omrOrt.create(h.models[0]);
  assert.equal(h.attempts.length, 2, 'an existing session is reused');
  await h.self.omrOrt.create(h.models[1]);
  assert.deepEqual(h.attempts[2].providers, ['wasm'], 'subsequent models stay off the failed GPU');
});

test('worker propagates non-GPU session initialization failure without retry or publishing metadata', async () => {
  const failure = new Error('WASM model failed');
  const h = harness({ createSession: async () => { throw failure; } });
  h.setRuntime(false);
  await assert.rejects(h.self.omrOrt.create(h.models[0]), error => error === failure);
  assert.deepEqual(h.attempts.map(a => a.providers), [['wasm']]);
  assert.throws(() => h.self.omrOrt.info(h.models[0]), /not ready/);
  assert.equal(h.state().sessions, 0);
});

test('worker propagates failure of the WASM retry after WebGPU initialization fails', async () => {
  const failure = new Error('WASM retry failed');
  const h = harness({ createSession: async (_bytes, _options, attempt) => {
    if (attempt === 1) throw new Error('GPU failed');
    throw failure;
  } });
  h.setRuntime(true);
  await assert.rejects(h.self.omrOrt.create(h.models[0]), error => error === failure);
  assert.deepEqual(h.attempts.map(a => a.providers), [['webgpu', 'wasm'], ['wasm']]);
  assert.throws(() => h.self.omrOrt.info(h.models[0]), /not ready/);
});

test('no-JSPI init uses plain WASM and explicit async Pyodide, and waits for every session before ready', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const h = harness({ createSession: async (_bytes, _options, attempt) => {
    if (attempt === 3) await gate;
    return { inputNames: ['input'], outputNames: ['output'] };
  } });
  const pending = h.self.onmessage({ data: { type: 'init' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.attempts.length, 3);
  assert.equal(h.events.some(e => e.type === 'ready'), false);
  assert.throws(() => h.self.omrOrt.info(h.models[2]), /not ready/);
  release();
  await pending;
  assert.ok(h.imports[0].endsWith('/ort.wasm.min.mjs'));
  assert.equal(h.imports.some(url => url.includes('webgpu')), false);
  assert.equal(h.adapterRequests(), 0);
  assert.equal(h.pyodideOptions[0].enableRunUntilComplete, false);
  assert.equal(h.ort.env.wasm.numThreads, 1);
  assert.deepEqual(h.downloads, h.models);
  assert.deepEqual(h.attempts.map(a => a.providers), [['wasm'], ['wasm'], ['wasm']]);
  assert.deepEqual(h.events.at(-1), { type: 'ready', gpu: false });
  assert.equal(h.self.omrOrt.info(h.models[2]).id, 2);
});

test('no-JSPI worker awaits ordinary recognition calls and cleans up the page', async () => {
  let destroyCalls = 0;
  const h = harness({ recognise: () => {
    const result = Promise.resolve('<score-partwise/>');
    result.destroy = () => { destroyCalls++; };
    return result;
  } });
  await h.self.onmessage({ data: { type: 'init' } });
  await h.self.onmessage({ data: { type: 'recognise', id: 7, image: new Uint8Array([1]).buffer, systems: '[]' } });
  assert.deepEqual(h.recognitionCalls, [['/tmp/page.png', '[]']]);
  assert.equal(destroyCalls, 1);
  assert.equal(h.files.has('/tmp/page.png'), false);
  assert.deepEqual(h.events.at(-1), { type: 'result', id: 7, xml: '<score-partwise/>', ms: 0 });
  assert.equal(h.events.some(e => e.type === 'error'), false);
});
