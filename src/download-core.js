// Shared, side-effect-free download helpers for Chzzk Downloader.
(function (root) {
  'use strict';
  const MiB = 1024 * 1024;
  const terminal = new Set(['done', 'error', 'cancelled', 'paused', 'interrupted']);
  const active = new Set(['queued', 'info', 'downloading', 'merging', 'saving', 'stopping']);
  function abortError() { return new DOMException('작업을 중지했습니다.', 'AbortError'); }
  function throwIfAborted(signal) { if (signal?.aborted) throw abortError(); }
  function sleep(ms, signal) {
    throwIfAborted(signal);
    return new Promise((resolve, reject) => {
      const finish = () => { signal?.removeEventListener('abort', abort); resolve(); };
      const timer = setTimeout(finish, ms);
      const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(abortError()); };
      signal?.addEventListener('abort', abort, { once: true });
    });
  }
  function retryDelay(attempt, retryAfter, now = Date.now(), random = Math.random()) {
    let requested = 0;
    if (retryAfter) {
      requested = /^\d+(\.\d+)?$/.test(retryAfter.trim())
        ? Number(retryAfter) * 1000 : Math.max(0, Date.parse(retryAfter) - now);
    }
    const backoff = Math.min(15000, 500 * 2 ** attempt) * (0.75 + random * 0.5);
    return Math.min(120000, Math.max(backoff, Number.isFinite(requested) ? requested : 0));
  }
  function safeError(error) {
    return String(error?.message || error || '알 수 없는 오류')
      .replace(/https?:\/\/[^\s)]+/g, value => {
        try { const u = new URL(value); return u.origin + u.pathname; } catch (_) { return '[URL]'; }
      }).slice(0, 350);
  }
  function sourceKey(url) { const u = new URL(url); return u.origin + u.pathname; }
  function resumableCheckpoint(checkpoint, probe, chunkBytes) {
    return Boolean(checkpoint && checkpoint.kind === 'range' && probe.validator?.value
      && checkpoint.source === sourceKey(probe.url)
      && checkpoint.totalBytes === probe.totalBytes
      && checkpoint.chunkBytes === chunkBytes
      && checkpoint.validator?.type === probe.validator.type
      && checkpoint.validator?.value === probe.validator.value);
  }
  class SpeedMeter {
    constructor(now = () => Date.now()) { this.now = now; this.samples = []; }
    update(bytes) {
      const time = this.now();
      this.samples.push({ time, bytes });
      while (this.samples.length > 2 && this.samples[1].time < time - 5000) this.samples.shift();
      const first = this.samples[0];
      return time > first.time ? Math.max(0, bytes - first.bytes) * 1000 / (time - first.time) : 0;
    }
  }
  // One budget shared by every job. Retry backoff never occupies a network slot.
  class RequestScheduler {
    constructor({ limit = 8, initial = 4, now = () => Date.now() } = {}) {
      this.limit = limit; this.initial = initial; this.now = now;
      this.running = 0; this.hosts = new Map(); this.waiting = [];
    }
    host(key) {
      if (!this.hosts.has(key)) this.hosts.set(key, {
        running: 0, limit: Math.min(this.limit, this.initial), success: 0,
        bytes: 0, started: this.now(), previousRate: 0, cooldown: 0,
      });
      return this.hosts.get(key);
    }
    acquire(url, signal) {
      throwIfAborted(signal);
      const key = new URL(url).host;
      return new Promise((resolve, reject) => {
        const entry = { key, signal, resolve, reject };
        entry.abort = () => {
          const index = this.waiting.indexOf(entry);
          if (index >= 0) this.waiting.splice(index, 1);
          reject(abortError());
        };
        signal?.addEventListener('abort', entry.abort, { once: true });
        this.waiting.push(entry); this.drain();
      });
    }
    drain() {
      for (let i = 0; i < this.waiting.length && this.running < this.limit;) {
        const entry = this.waiting[i], host = this.host(entry.key);
        if (host.running >= host.limit) { i++; continue; }
        this.waiting.splice(i, 1);
        entry.signal?.removeEventListener('abort', entry.abort);
        if (entry.signal?.aborted) { entry.reject(abortError()); continue; }
        this.running++; host.running++;
        let released = false;
        entry.resolve((bytes = 0, status = 200) => {
          if (released) return;
          released = true; this.running--; host.running--;
          this.observe(host, bytes, status); this.drain();
        });
      }
    }
    observe(host, bytes, status) {
      const now = this.now();
      if (status === 429 || status >= 500 || status === 0) {
        host.limit = Math.max(2, Math.floor(host.limit / 2));
        host.cooldown = now + 10000; host.success = 0; host.bytes = 0; host.started = now;
        return;
      }
      host.success++; host.bytes += bytes;
      if (host.success < host.limit || now - host.started < 1500) return;
      const rate = host.bytes * 1000 / Math.max(1, now - host.started);
      if (now >= host.cooldown) {
        if (!host.previousRate || rate >= host.previousRate * 0.95) host.limit = Math.min(this.limit, host.limit + 1);
        else if (rate < host.previousRate * 0.7) host.limit = Math.max(2, host.limit - 1);
      }
      host.previousRate = rate; host.started = now; host.success = 0; host.bytes = 0;
    }
  }
  // An awaitable database API: writes resolve only after the transaction commits.
  let database;
  const db = {
    async open() {
      if (!database) database = new Promise((resolve, reject) => {
        const request = indexedDB.open('chzzk-downloader', 1);
        request.onupgradeneeded = () => {
          for (const name of ['jobs', 'checkpoints']) {
            if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, { keyPath: 'id' });
          }
        };
        request.onsuccess = () => {
          const value = request.result;
          value.onversionchange = () => { value.close(); database = null; };
          resolve(value);
        };
        request.onerror = () => { database = null; reject(request.error); };
      });
      return database;
    },
    async request(store, operation, value) {
      const database = await this.open();
      return new Promise((resolve, reject) => {
        const transaction = database.transaction(store, ['get', 'getAll'].includes(operation) ? 'readonly' : 'readwrite');
        const request = transaction.objectStore(store)[operation](value);
        let result;
        request.onsuccess = () => { result = request.result; };
        transaction.oncomplete = () => resolve(result);
        transaction.onabort = transaction.onerror = () => reject(transaction.error || request.error || new Error('작업 기록 저장 실패'));
      });
    },
    get(store, id) { return this.request(store, 'get', id); },
    all(store) { return this.request(store, 'getAll'); },
    put(store, value) { return this.request(store, 'put', value); },
    delete(store, id) { return this.request(store, 'delete', id); },
  };
  const core = { MiB, terminal, active, abortError, throwIfAborted, sleep, retryDelay, safeError,
    sourceKey, resumableCheckpoint, SpeedMeter, RequestScheduler, db };
  root.CdlCore = core;
  if (typeof module === 'object' && module.exports) module.exports = core;
})(globalThis);
