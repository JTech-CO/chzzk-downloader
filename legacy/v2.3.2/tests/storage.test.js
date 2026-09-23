'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { harness, memoryStorage, makeJob } = require('./helpers');
const url = 'https://vod.pstatic.net/video.mp4?token=fixture';
const expected = Uint8Array.from({ length: 64 }, (_, i) => i);
const quotaError = () => new DOMException('Injected storage quota', 'QuotaExceededError');
const direct = id => makeJob(id, { type: 'DOWNLOAD_DIRECT', url });
function serveRanges(h) {
  const requested = [];
  h.fetch(async (_url, options) => {
    const [start, end] = options.headers.Range.slice(6).split('-').map(Number);
    requested.push([start, end]);
    return new Response(expected.slice(start, end + 1), { status: 206, headers: {
      'content-range': `bytes ${start}-${end}/64`, 'content-length': String(end - start + 1), etag: '"v1"',
    } });
  });
  return requested;
}
function injectQuota(storage, method, failAt = 1, onFailure) {
  const get = storage.directory.getFileHandle.bind(storage.directory); let calls = 0;
  storage.directory.getFileHandle = async (...args) => {
    const file = await get(...args);
    return { ...file, async createSyncAccessHandle() {
      if (method === 'open') throw quotaError();
      const handle = await file.createSyncAccessHandle();
      return { ...handle, [method](...values) {
        if (++calls >= failAt) { onFailure?.(); throw quotaError(); }
        return handle[method](...values);
      } };
    } };
  };
}
async function terminal(h, job) {
  await h.context.self.onmessage({ data: { type: 'START', requestId: 1, job } });
  for (let i = 0; i < 300; i++) {
    const result = h.events.find(event => ['error', 'cancelled', 'paused'].includes(event.patch.status));
    if (result) return result.patch;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error('Missing terminal job event');
}

test('reproduction: the old preflight rejects a new file despite an estimate twice its size', async () => {
  const h = harness({ smallRanges: true, sourceDirectory: path.resolve(__dirname, '../legacy/v2.3.2-before-storage-fix/src') });
  h.context.navigator.storage.estimate = async () => ({ quota: 128, usage: 0 });
  const requested = serveRanges(h);
  await assert.rejects(h.invoke('directDownload', direct('video-old-space')), /브라우저 임시 저장 공간이 부족합니다/);
  assert.deepEqual(requested, [[0, 0]]); assert.equal(h.rpcs.length, 0);
});

test('a new download does not require an arbitrary extra 64 MiB reserve', async () => {
  const h = harness({ smallRanges: true });
  h.context.navigator.storage.estimate = async () => ({ quota: 128, usage: 0 });
  serveRanges(h); await h.invoke('directDownload', direct('video-space'));
  assert.deepEqual([...h.storage.files.values()][0].data, expected);
  assert.deepEqual(h.rpcs.map(rpc => rpc.action), ['SAVE_FILE']);
});

test('an underestimated quota cannot block writable storage or disable parallel downloading', async () => {
  const h = harness({ smallRanges: true });
  h.context.navigator.storage.estimate = async () => ({ quota: 0, usage: 0 });
  serveRanges(h); await h.invoke('directDownload', direct('video-estimate'));
  assert.deepEqual([...h.storage.files.values()][0].data, expected);
  assert.deepEqual(h.rpcs.map(rpc => rpc.action), ['SAVE_FILE']);
  assert.equal(h.events.some(event => event.patch.status === 'error'), false);
});

test('missing, invalid or rejected storage estimates do not stop a valid download', async () => {
  for (const estimate of [undefined, async () => { throw new Error('Estimate unavailable'); }, async () => ({ quota: NaN, usage: -1 })]) {
    const h = harness({ smallRanges: true }); h.context.navigator.storage.estimate = estimate;
    serveRanges(h); await h.invoke('directDownload', direct('video-no-estimate'));
    assert.deepEqual([...h.storage.files.values()][0].data, expected);
    assert.equal(h.rpcs[0].action, 'SAVE_FILE');
  }
});

test('resuming a sparse file reuses its existing extent and only fetches missing ranges', async () => {
  const storage = memoryStorage(), name = 'cdl_video_sparse_1.mp4';
  const bytes = new Uint8Array(64); bytes.set(expected.slice(60), 60);
  storage.files.set(name, { data: bytes, locked: false });
  await storage.database.put('checkpoints', { id: 'video-sparse', kind: 'range', name, source: url.split('?')[0], totalBytes: 64,
    chunkBytes: 4, validator: { type: 'etag', value: '"v1"' }, completed: [15] });
  const h = harness({ smallRanges: true, storage }); h.context.navigator.storage.estimate = async () => ({ quota: 64, usage: 64 });
  const requested = serveRanges(h); await h.invoke('directDownload', direct('video-sparse'));
  assert.equal(requested.some(([start, end]) => start === 60 && end === 63), false);
  assert.deepEqual(storage.files.get(name).data, expected); assert.equal(storage.files.size, 1);
  assert.match(h.logs.map(log => log.message).join('\n'), /추가 파일 증가 0 B/);
});

test('an actual range write quota failure closes workers and switches once to native download', async () => {
  const storage = memoryStorage(); injectQuota(storage, 'write', 3);
  storage.files.set('unrelated.mp4', { data: Uint8Array.of(9), locked: false });
  const h = harness({ smallRanges: true, storage }); serveRanges(h);
  await h.invoke('directDownload', direct('video-quota'));
  assert.deepEqual(h.rpcs.map(rpc => rpc.action), ['NATIVE_DOWNLOAD']); assert.equal(h.rpcs[0].url, url);
  assert.deepEqual([...storage.files.keys()], ['unrelated.mp4']); assert.equal(storage.stores.checkpoints.size, 0);
  assert.equal(h.events.some(event => event.patch.status === 'done' || event.patch.status === 'error'), false);
  assert.equal(h.events.at(-1).patch.mode, 'native'); assert.equal(h.events.at(-1).patch.bytesReceived, 0);
});

test('quota failure while opening a new OPFS file falls back without leaving an untracked file', async () => {
  const storage = memoryStorage(); injectQuota(storage, 'open');
  const h = harness({ smallRanges: true, storage }); serveRanges(h);
  await h.invoke('directDownload', direct('video-open-quota'));
  assert.equal(storage.files.size, 0); assert.equal(h.rpcs[0].action, 'NATIVE_DOWNLOAD');
});

test('checkpoint quota failure cleans the new file even when no checkpoint could be persisted', async () => {
  const storage = memoryStorage(), put = storage.database.put;
  storage.database.put = async (store, value) => { if (store === 'checkpoints') throw quotaError(); return put(store, value); };
  const h = harness({ smallRanges: true, storage }); serveRanges(h);
  await h.invoke('directDownload', direct('video-db-quota'));
  assert.equal(storage.files.size, 0); assert.equal(storage.stores.checkpoints.size, 0);
  assert.deepEqual(h.rpcs.map(rpc => rpc.action), ['NATIVE_DOWNLOAD']);
});

test('quota failure while flushing never hands an incomplete local file to Chrome', async () => {
  const storage = memoryStorage(); injectQuota(storage, 'flush', 2);
  const h = harness({ smallRanges: true, storage }); serveRanges(h);
  await h.invoke('directDownload', direct('video-flush-quota'));
  assert.equal(storage.files.size, 0); assert.deepEqual(h.rpcs.map(rpc => rpc.action), ['NATIVE_DOWNLOAD']);
});

test('HTTP failures do not silently switch methods or discard the resumable checkpoint', async () => {
  const h = harness({ smallRanges: true });
  h.fetch(async (_url, options) => options.headers.Range === 'bytes=0-0'
    ? new Response(Uint8Array.of(0), { status: 206, headers: { 'content-range': 'bytes 0-0/64', etag: '"v1"' } })
    : new Response('Forbidden', { status: 403 }));
  await assert.rejects(h.invoke('directDownload', direct('video-http')), /403/);
  assert.equal(h.rpcs.length, 0); assert.ok(h.storage.stores.checkpoints.has('video-http'));
});

test('user cancellation during a quota failure cannot start another download', async () => {
  const storage = memoryStorage(), job = direct('video-cancel-quota');
  injectQuota(storage, 'write', 1, () => { job.userCancelled = true; job.ac.abort(); });
  const h = harness({ smallRanges: true, storage }); serveRanges(h);
  await assert.rejects(h.invoke('directDownload', job), { name: 'AbortError' }); assert.equal(h.rpcs.length, 0);
});

test('a failed native fallback is an error and is not retried or marked complete', async () => {
  const storage = memoryStorage(); injectQuota(storage, 'write');
  const h = harness({ smallRanges: true, storage }); serveRanges(h);
  const postMessage = h.context.postMessage;
  h.context.postMessage = data => {
    if (data.type !== 'RPC') return postMessage(data);
    h.rpcs.push(data);
    queueMicrotask(() => h.context.self.onmessage({ data: { type: 'RPC_RESULT', requestId: data.requestId, error: 'Native save refused' } }));
  };
  const result = await terminal(h, direct('video-native-failed'));
  assert.equal(result.status, 'error'); assert.match(result.message, /Native save refused/);
  assert.deepEqual(h.rpcs.map(rpc => rpc.action), ['NATIVE_DOWNLOAD']); assert.equal(storage.files.size, 0);
});

test('segmented streams still report a genuine quota error and clean their incomplete file', async () => {
  const storage = memoryStorage(); injectQuota(storage, 'write');
  const h = harness({ storage }); h.fetch(async () => new Response(Uint8Array.of(1, 2, 3, 4)));
  const result = await terminal(h, makeJob('video-segments-quota', { type: 'DOWNLOAD_SEGMENTS', segments: [url] }));
  assert.equal(result.status, 'error'); assert.match(result.message, /임시 저장 한도/);
  assert.equal(storage.files.size, 0); assert.equal(h.rpcs.length, 0);
});
