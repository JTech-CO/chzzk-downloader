'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const root = path.join(__dirname, '..');
function memoryStorage() {
  const files = new Map(), stores = { jobs: new Map(), checkpoints: new Map() };
  let flushes = 0;
  const directory = {
    async getFileHandle(name, { create = false } = {}) {
      if (!files.has(name)) {
        if (!create) throw new DOMException('Missing file', 'NotFoundError');
        files.set(name, { data: new Uint8Array(), locked: false });
      }
      const file = files.get(name);
      return { async createSyncAccessHandle() {
        if (file.locked) throw new DOMException('Already locked', 'NoModificationAllowedError');
        file.locked = true; let closed = false;
        function check() { if (closed) throw new Error('Handle closed'); }
        return {
          write(bytes, { at = 0 } = {}) {
            check(); if (at + bytes.byteLength > file.data.byteLength) { const next = new Uint8Array(at + bytes.byteLength); next.set(file.data); file.data = next; }
            file.data.set(bytes, at); return bytes.byteLength;
          },
          getSize() { check(); return file.data.length; },
          truncate(size) { check(); const data = new Uint8Array(size); data.set(file.data.subarray(0, size)); file.data = data; },
          flush() { check(); flushes++; },
          close() { closed = true; file.locked = false; },
        };
      }, async getFile() { return new Blob([file.data]); } };
    },
    async removeEntry(name) { if (files.get(name)?.locked) throw new Error('File is locked'); files.delete(name); },
  };
  const database = {
    async get(store, id) { const value = stores[store].get(id); return value ? structuredClone(value) : undefined; },
    async all(store) { return [...stores[store].values()].map(value => structuredClone(value)); },
    async put(store, value) { stores[store].set(value.id, structuredClone(value)); },
    async delete(store, id) { stores[store].delete(id); },
  };
  return { files, stores, directory, database, get flushes() { return flushes; } };
}
function harness({ entry = 'download-engine.js', storage = memoryStorage(), smallRanges = false, chrome: chromeOverrides, timers } = {}) {
  const events = [], rpcs = [], calls = [], loaded = new Set();
  let fetchImpl = async () => { throw new Error('Unexpected fetch'); }, nextDownload = 1;
  const downloads = new Map(), listeners = [];
  const chrome = chromeOverrides || {
    runtime: { id: 'test-extension', lastError: null, getURL: value => 'chrome-extension://test-extension/' + value,
      onInstalled: { addListener() {} }, onMessage: { addListener(fn) { listeners.push(fn); } }, getContexts: async () => [],
      sendMessage: async message => { calls.push(message); return { result: message.type === 'SNAPSHOT' ? [] : { ok: true } }; },
    },
    declarativeNetRequest: { updateDynamicRules: async () => {} },
    tabs: { sendMessage: async (_tab, value) => { events.push(value); } },
    offscreen: { createDocument: async () => {} },
    downloads: {
      download(options, callback) { const id = nextDownload++; downloads.set(id, { id, state: 'in_progress', bytesReceived: 0, totalBytes: 100, url: options.url }); callback(id); },
      search: async ({ id }) => downloads.has(id) ? [{ ...downloads.get(id) }] : [],
      cancel: async id => { if (downloads.has(id)) downloads.get(id).state = 'interrupted'; },
      pause: async id => { downloads.get(id).paused = true; },
      resume: async id => { downloads.get(id).paused = false; downloads.get(id).state = 'in_progress'; },
      onChanged: { addListener(fn) { listeners.push(fn); } }, show() {},
    },
  };
  const context = vm.createContext({ console, URL, Blob, AbortController, DOMException, ArrayBuffer, DataView, Uint8Array,
    TextEncoder, TextDecoder, Headers, Response, ReadableStream, structuredClone, crypto: crypto.webcrypto,
    setTimeout: timers || setTimeout, clearTimeout, self: {},
    navigator: { storage: { getDirectory: async () => storage.directory, estimate: async () => ({ quota: 1e12, usage: 0 }) } }, chrome,
    fetch: (...args) => fetchImpl(...args),
    postMessage(data) {
      if (data.type === 'EVENT') events.push(data);
      if (data.type === 'RPC') { rpcs.push(data); queueMicrotask(() => context.self.onmessage({ data: { type: 'RPC_RESULT', requestId: data.requestId, result: { downloadId: 1 } } })); }
    },
    importScripts(...files) { for (const file of files) load(file); },
  });
  function load(file) {
    if (loaded.has(file)) return;
    loaded.add(file);
    let source = fs.readFileSync(path.join(root, file), 'utf8');
    if (smallRanges && file === 'media-plan.js') source = source.replace('const DIRECT_RANGE_CHUNK_BYTES = 16 * 1024 * 1024;', 'const DIRECT_RANGE_CHUNK_BYTES = 4;').replace('const DIRECT_RANGE_MIN_BYTES = 256 * 1024 * 1024;', 'const DIRECT_RANGE_MIN_BYTES = 1;');
    vm.runInContext(source, context, { filename: file });
    if (file === 'download-core.js') Object.assign(context.CdlCore.db, storage.database);
  }
  load('download-core.js'); load(entry);
  function invoke(name, ...args) { context.__args = args; return vm.runInContext(`${name}(...__args)`, context); }
  return { context, invoke, storage, events, rpcs, calls, downloads, chrome, listeners,
    fetch(fn) { fetchImpl = fn; }, evaluate(source) { return vm.runInContext(source, context); } };
}
function makeJob(id = 'video-test', extra = {}) { return { id, generation: 'test-generation', title: 'test', itemId: id, itemKind: 'video', ac: new AbortController(), lastEvent: {}, ...extra }; }
module.exports = { harness, memoryStorage, makeJob };
