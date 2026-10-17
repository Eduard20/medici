'use strict';

// Minimal asynchronous IndexedDB/localStorage doubles for DOM integration tests.
// Transactions on the same database are ordered, writes commit atomically, and
// structured-cloned binary data is returned in the consuming window's realm.
const assert = require('node:assert/strict');
function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}
function clone(value, window) {
  if (value === undefined || value === null || typeof value !== 'object') return value;
  if (Object.prototype.toString.call(value) === '[object ArrayBuffer]') {
    return window.Uint8Array.from(new Uint8Array(value)).buffer;
  }
  if (ArrayBuffer.isView(value)) {
    const bytes = window.Uint8Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    return value instanceof DataView ? new window.DataView(bytes.buffer) : bytes;
  }
  if (Array.isArray(value)) return Array.from(value, item => clone(item, window));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item, window)]));
}
function createStorage() {
  const databases = new Map(), local = new Map(), operations = [];
  const holds = new Map(), failures = new Map(), permanentFailures = new Map();
  const event = target => ({ target, preventDefault() {}, stopPropagation() {} });
  const errorFor = (window, name) => new window.DOMException(`Simulated storage ${name}`, name);
  async function run(operation, window, action) {
    operations.push(operation);
    const hold = holds.get(operation)?.shift();
    if (hold) { hold.reached.resolve(); await hold.released.promise; }
    const failure = failures.get(operation)?.shift() || permanentFailures.get(operation);
    if (failure) throw errorFor(window, failure);
    return action();
  }
  const control = {
    databases, local, operations,
    seed(databaseName, storeName, entries) {
      let database = databases.get(databaseName);
      if (!database) {
        database = { name: databaseName, version: 1, stores: new Map(), tail: Promise.resolve() };
        databases.set(databaseName, database);
      }
      database.stores.set(storeName, { keyPath: undefined, records: new Map(entries) });
      return control;
    },
    holdNext(operation) {
      const hold = { reached: deferred(), released: deferred() };
      if (!holds.has(operation)) holds.set(operation, []);
      holds.get(operation).push(hold);
      return { reached: hold.reached.promise, release: () => hold.released.resolve() };
    },
    failNext(operation, name = 'QuotaExceededError') {
      if (!failures.has(operation)) failures.set(operation, []);
      failures.get(operation).push(name);
    },
    failAlways(operation, name = 'SecurityError') { permanentFailures.set(operation, name); },
    allow(operation) { permanentFailures.delete(operation); },
    records() {
      return [...databases.entries()].flatMap(([database, db]) =>
        [...db.stores.entries()].flatMap(([store, table]) =>
          [...table.records.entries()].map(([key, value]) => ({ database, store, key, value }))));
    },
    install(window, { unavailable = false, localUnavailable = false } = {}) {
      Object.defineProperty(window, 'localStorage', { configurable: true, value: {
        get length() { return local.size; },
        key(index) { return [...local.keys()][index] || null; },
        getItem(key) {
          if (localUnavailable) throw errorFor(window, 'SecurityError');
          return local.has(String(key)) ? local.get(String(key)) : null;
        },
        setItem(key, value) {
          if (localUnavailable) throw errorFor(window, 'SecurityError');
          local.set(String(key), String(value));
        },
        removeItem(key) {
          if (localUnavailable) throw errorFor(window, 'SecurityError');
          local.delete(String(key));
        },
        clear() { local.clear(); },
      } });
      if (unavailable) {
        Object.defineProperty(window, 'indexedDB', { configurable: true, value: undefined });
        return;
      }
      function connection(database) {
        return {
          name: database.name,
          version: database.version,
          objectStoreNames: { contains: name => database.stores.has(name) },
          createObjectStore(name, options = {}) {
            assert.equal(database.stores.has(name), false, `Store ${name} already exists`);
            const table = { keyPath: options.keyPath, records: new Map() };
            database.stores.set(name, table);
            return table;
          },
          close() {},
          transaction(names, mode = 'readonly') {
            const requested = Array.isArray(names) ? names : [names];
            for (const name of requested) assert.ok(database.stores.has(name), `Missing store ${name}`);
            const requests = [], done = deferred(), before = database.tail;
            let aborted = false, completed = false;
            database.tail = done.promise;
            const transaction = {
              error: null,
              abort() {
                if (completed || aborted) return;
                aborted = true;
                transaction.error = errorFor(window, 'AbortError');
                queueMicrotask(() => transaction.onabort?.(event(transaction)));
                done.resolve();
              },
              objectStore(name) {
                assert.ok(requested.includes(name), `Store ${name} is outside transaction scope`);
                const request = (operation, value, key) => {
                  if (operation !== 'read') assert.equal(mode, 'readwrite');
                  const result = { result: undefined, error: null };
                  requests.push({ operation, name, value, key, request: result });
                  return result;
                };
                return {
                  get: key => request('read', null, key),
                  put: (value, key) => request('write', value, key),
                  delete: key => request('delete', null, key),
                  clear: () => request('clear'),
                };
              },
            };
            queueMicrotask(async () => {
              await before;
              const staged = new Map(requested.map(name =>
                [name, new Map(database.stores.get(name).records)]));
              try {
                for (let index = 0; index < requests.length && !aborted; index++) {
                  const item = requests[index];
                  try {
                    const result = await run(item.operation, window, () => {
                      const records = staged.get(item.name);
                      if (item.operation === 'read') return clone(records.get(item.key), window);
                      if (item.operation === 'write') {
                        const key = item.key ?? item.value[database.stores.get(item.name).keyPath];
                        if (key === undefined) throw errorFor(window, 'DataError');
                        records.set(key, clone(item.value, globalThis));
                        return key;
                      }
                      if (item.operation === 'delete') records.delete(item.key);
                      if (item.operation === 'clear') records.clear();
                    });
                    if (aborted) break;
                    item.request.result = result;
                    item.request.onsuccess?.(event(item.request));
                  } catch (error) {
                    item.request.error = error;
                    item.request.onerror?.(event(item.request));
                    throw error;
                  }
                }
                if (aborted) return;
                if (mode === 'readwrite') {
                  for (const [name, records] of staged) database.stores.get(name).records = records;
                }
                completed = true;
                transaction.oncomplete?.(event(transaction));
              } catch (error) {
                transaction.error = error;
                transaction.onerror?.(event(transaction));
                transaction.onabort?.(event(transaction));
              } finally { done.resolve(); }
            });
            return transaction;
          },
        };
      }
      Object.defineProperty(window, 'indexedDB', { configurable: true, value: {
        open(name, version = 1) {
          const request = { result: undefined, error: null };
          queueMicrotask(async () => {
            try {
              await run('open', window, () => {
                let database = databases.get(name);
                const oldVersion = database?.version || 0;
                if (!database) {
                  database = { name, version, stores: new Map(), tail: Promise.resolve() };
                  databases.set(name, database);
                }
                if (version < database.version) throw errorFor(window, 'VersionError');
                database.version = version;
                request.result = connection(database);
                if (version > oldVersion) request.onupgradeneeded?.({ ...event(request), oldVersion, newVersion: version });
              });
              request.onsuccess?.(event(request));
            } catch (error) {
              request.error = error;
              request.onerror?.(event(request));
            }
          });
          return request;
        },
      } });
    },
  };
  return control;
}
module.exports = { createStorage };
