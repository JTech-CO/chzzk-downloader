'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { harness, memoryStorage, makeJob } = require('./helpers');
const core = require('../src/download-core');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(condition) { for (let i = 0; i < 300; i++) { if (condition()) return; await new Promise(r => setTimeout(r, 2)); } throw new Error('Condition timed out'); }
function rangeResponse(start, end, total = 64, etag = '"v1"') {
  return new Response(Uint8Array.from({ length: end - start + 1 }, (_, i) => (start + i) % 256), {
    status: 206, headers: { 'content-range': `bytes ${start}-${end}/${total}`, 'content-length': String(end - start + 1), etag },
  });
}
function rangeOf(options) { return options.headers.Range.slice(6).split('-').map(Number); }
const direct = id => makeJob(id, { type: 'DOWNLOAD_DIRECT', url: 'https://vod.pstatic.net/video.mp4' });

test('Retry-After seconds/date is respected and exponential retries have bounded jitter', () => {
  assert.equal(core.retryDelay(0, '8', 0, 0), 8000);
  assert.equal(core.retryDelay(0, new Date(10000).toUTCString(), 0, 0), 10000);
  assert.equal(core.retryDelay(2, null, 0, 0), 1500);
  assert.equal(core.retryDelay(2, null, 0, 1), 2500);
});
test('shared scheduler caps requests across jobs and removes cancelled queued requests', async () => {
  const pool = new core.RequestScheduler({ limit: 4, initial: 2 });
  const ac = new AbortController();
  const releases = await Promise.all([pool.acquire('https://a.test/1'), pool.acquire('https://a.test/2'), pool.acquire('https://b.test/1'), pool.acquire('https://b.test/2')]);
  assert.equal(pool.running, 4);
  const blocked = pool.acquire('https://a.test/3', ac.signal); ac.abort();
  await assert.rejects(blocked, { name: 'AbortError' });
  assert.equal(pool.waiting.length, 0); releases.forEach(release => release()); assert.equal(pool.running, 0);
});
test('429 reduces a host concurrency cap without exceeding the global limit', async () => {
  const pool = new core.RequestScheduler({ limit: 8, initial: 8 });
  const release = await pool.acquire('https://a.test/'); release(0, 429);
  assert.equal(pool.host('a.test').limit, 4);
});
test('direct MP4 continues requesting beyond a stalled first range and preserves every byte', async () => {
  const h = harness({ smallRanges: true }); let releaseFirst;
  const requested = [];
  h.fetch(async (_url, options) => {
    const [start, end] = rangeOf(options); requested.push([start, end]);
    if (start === 0 && end === 3) await new Promise(resolve => { releaseFirst = resolve; });
    return rangeResponse(start, end);
  });
  const work = h.invoke('directDownload', direct('video-order'));
  await until(() => requested.length > 9);
  assert.ok(requested.some(([start]) => start >= 32));
  assert.equal(h.rpcs.length, 0); releaseFirst(); await work;
  const file = [...h.storage.files.values()][0];
  assert.deepEqual([...file.data], Array.from({ length: 64 }, (_, i) => i));
  assert.equal(h.rpcs[0].action, 'SAVE_FILE'); assert.ok(h.storage.flushes > 0);
  assert.equal(h.events.some(event => event.patch.status === 'done'), false);
});
test('aborted direct MP4 resumes only missing verified ranges after worker restart', async () => {
  const storage = memoryStorage(), h = harness({ smallRanges: true, storage }), job = direct('video-resume');
  h.fetch(async (_url, options) => {
    const [start, end] = rangeOf(options);
    if (start >= 16) await new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
    return rangeResponse(start, end);
  });
  const work = h.invoke('directDownload', job); const failed = assert.rejects(work, { name: 'AbortError' });
  try { await until(() => [...storage.files.values()].some(file => file.data.length >= 16)); await tick(); } finally { job.ac.abort(); }
  await failed;
  const checkpoint = await storage.database.get('checkpoints', job.id);
  assert.ok(checkpoint.completed.length > 0);
  const restored = harness({ smallRanges: true, storage }), requested = [];
  restored.fetch(async (_url, options) => { const [start, end] = rangeOf(options); requested.push(`${start}-${end}`); return rangeResponse(start, end); });
  await restored.invoke('directDownload', direct(job.id));
  for (const index of checkpoint.completed) assert.equal(requested.includes(`${index * 4}-${index * 4 + 3}`), false);
  assert.deepEqual([...storage.files.values()][0].data, Uint8Array.from({ length: 64 }, (_, i) => i));
});
test('resume is refused if size, validator or source changes', () => {
  const checkpoint = { kind: 'range', source: 'https://vod.pstatic.net/video.mp4', totalBytes: 64, chunkBytes: 4, validator: { type: 'etag', value: '"a"' } };
  const probe = { url: checkpoint.source + '?token=refreshed', totalBytes: 64, validator: checkpoint.validator };
  assert.equal(core.resumableCheckpoint(checkpoint, probe, 4), true);
  for (const change of [{ totalBytes: 65 }, { validator: { type: 'etag', value: '"b"' } }, { validator: null }, { url: 'https://other.pstatic.net/video.mp4' }]) assert.equal(core.resumableCheckpoint(checkpoint, { ...probe, ...change }, 4), false);
});
test('small segmented downloads write in order to disk instead of accumulating a whole Blob', async () => {
  const h = harness();
  h.evaluate('fetchSeg = async segment => { for(let i=0;i<4-Number(segment);i++) await Promise.resolve(); return Uint8Array.of(Number(segment)).buffer; };');
  const job = makeJob('video-segments', { mode: 'dash' });
  await h.invoke('downloadStreaming', job, ['0', '1', '2', '3'], 'include');
  assert.deepEqual([...h.storage.files.values()][0].data, Uint8Array.from([0, 1, 2, 3]));
  assert.equal(h.rpcs[0].action, 'SAVE_FILE');
});
test('segmented failure cancels siblings and removes the incomplete output', async () => {
  const h = harness();
  h.evaluate('fetchSeg = async (segment, signal) => { if(segment === "bad") throw new Error("broken segment"); await new Promise((resolve,reject)=>{ const t=setTimeout(resolve,10); signal.addEventListener("abort",()=>{clearTimeout(t);reject(new DOMException("Aborted","AbortError"));},{once:true}); }); return Uint8Array.of(1).buffer; };');
  await assert.rejects(h.invoke('downloadStreaming', makeJob(), ['slow', 'bad'], 'include'), /broken segment/);
  assert.equal(h.storage.files.size, 0); assert.equal(h.storage.stores.checkpoints.size, 0); assert.equal(h.rpcs.length, 0);
});
test('HLS jobs stay registered until they finish and cancellation reaches their controller', async () => {
  const h = harness();
  h.evaluate('hlsDownload = async job => { await new Promise((resolve,reject)=> job.ac.signal.addEventListener("abort",()=>reject(new DOMException("Aborted","AbortError")),{once:true})); };');
  await h.context.self.onmessage({ data: { type: 'START', requestId: 1, job: { id: 'video-hls', generation: 'a', type: 'DOWNLOAD_HLS', title: 'test' } } });
  assert.equal(h.evaluate('jobs.has("video-hls")'), true);
  await h.context.self.onmessage({ data: { type: 'CANCEL', requestId: 2, jobId: 'video-hls' } });
  await until(() => !h.evaluate('jobs.has("video-hls")'));
  assert.equal(h.events.at(-1).patch.status, 'cancelled');
});
test('HLS master independent-segment tag reaches the MP4 finalizer', async () => {
  const h = harness();
  h.evaluate('fetchHlsText = async () => "#EXTM3U\\n#EXT-X-MAP:URI=\\"init.mp4\\"\\n#EXTINF:2,\\nseg.m4s\\n#EXT-X-ENDLIST"; createFragmentedMp4Finalizer = (duration,indexes,independent) => ({independent}); downloadStreaming = async(job,segs,creds,finalizer) => {globalThis.resultFlag=finalizer.independent;};');
  await h.invoke('hlsDownload', makeJob('video-hls', { hlsUrl: 'https://vod.pstatic.net/master.m3u8', masterText: '#EXTM3U\n#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-STREAM-INF:BANDWIDTH=10\nmedia.m3u8' }));
  assert.equal(h.context.resultFlag, true);
});
test('HLS encrypted, discontinuous and malformed byte-range plans fail before transfer', () => {
  const h = harness();
  for (const tag of ['#EXT-X-KEY:METHOD=AES-128,URI="key"', '#EXT-X-DISCONTINUITY', '#EXT-X-BYTERANGE:abc@0']) {
    assert.throws(() => h.invoke('parseHlsMediaPlaylist', `#EXTM3U\n${tag}\n#EXTINF:2,\na.m4s`, 'https://vod.pstatic.net/list.m3u8'));
  }
});
test('browser download initiation is not completion; complete is durable', async () => {
  const h = harness({ entry: 'background.js' });
  const { job } = await h.invoke('startJob', { type: 'DOWNLOAD_DIRECT', itemId: '1', itemKind: 'video', filename: 'quoted "title"', url: 'https://vod.pstatic.net/a.mp4' });
  const { downloadId } = await h.invoke('downloadInBrowser', { type: 'NATIVE_DOWNLOAD', jobId: job.id, generation: job.generation, url: 'https://vod.pstatic.net/a.mp4' });
  assert.equal(h.evaluate('jobs.get("video-1").status'), 'downloading');
  h.downloads.get(downloadId).state = 'complete';
  await h.invoke('refreshNativeJob', h.evaluate('jobs.get("video-1")'));
  assert.equal((await h.storage.database.get('jobs', 'video-1')).status, 'done');
});
test('browser save failure never reports done and retains a local completed file for retry', async () => {
  const h = harness({ entry: 'background.js' });
  const { job } = await h.invoke('startJob', { type: 'DOWNLOAD_DIRECT', itemId: '2', filename: 'test', url: 'https://vod.pstatic.net/a.mp4' });
  h.chrome.downloads.download = (_options, callback) => { h.chrome.runtime.lastError = { message: 'Disk full' }; callback(undefined); h.chrome.runtime.lastError = null; };
  await assert.rejects(h.invoke('downloadInBrowser', { type: 'SAVE_FILE', jobId: job.id, generation: job.generation, url: 'blob:chrome-extension://test-extension/value', name: 'cdl_video-2_123.mp4' }), /Disk full/);
  const record = await h.storage.database.get('jobs', job.id);
  assert.notEqual(record.status, 'done'); assert.equal(record.hasLocalFile, true);
});
test('service worker restart recovers durable interrupted jobs without deleting their checkpoint', async () => {
  const storage = memoryStorage(), h = harness({ entry: 'background.js', storage });
  const { job } = await h.invoke('startJob', { type: 'DOWNLOAD_DIRECT', itemId: '3', filename: 'test', url: 'https://vod.pstatic.net/a.mp4' });
  await storage.database.put('checkpoints', { id: job.id, kind: 'range', validator: { type: 'etag', value: '"v1"' }, completed: [0] });
  const restart = harness({ entry: 'background.js', storage });
  const result = await restart.invoke('getJobs');
  assert.equal(result.jobs[0].status, 'interrupted'); assert.equal(result.jobs[0].resumable, true); assert.equal(storage.stores.checkpoints.size, 1);
});
test('untrusted media and non-Chzzk senders are rejected', () => {
  const h = harness();
  for (const url of ['http://vod.pstatic.net/a', 'https://127.0.0.1/a', 'https://example.com/a', 'https://light-slit.akamaized.net/other/a']) assert.throws(() => h.invoke('assertSafeHttpsUrl', url, 'URL'));
  assert.equal(h.invoke('isTrustedContentSender', { id: 'test-extension', tab: { url: 'https://chzzk.naver.com.evil.test/' } }), false);
});

test('a stopped job absent from the worker cannot stay stuck in stopping', async () => {
  const h = harness({ entry: 'background.js' });
  await h.evaluate('ready');
  h.evaluate("engine = async () => ({ ok: true, found: false }); jobs.set('video-early', { id: 'video-early', generation: 'g', status: 'queued' });");
  await h.invoke('cancelJob', 'video-early');
  assert.equal(h.evaluate("jobs.get('video-early').status"), 'cancelled');
});
test('HLS byte ranges reject ambiguous offsets, suffixes and unsafe arithmetic', () => {
  const h = harness();
  for (const value of ['4x@0', '4@0@2', '4', '9007199254740991@2']) assert.throws(() => h.invoke('parseHlsByteRange', value));
  assert.equal(h.invoke('parseHlsByteRange', '4', 3).header, '4-7');
});

test('runtime diagnostics report the loaded backend version independently from the manifest', async () => {
  const h = harness({ entry: 'background.js' });
  h.chrome.runtime.getManifest = () => ({ version: '9.0.0' });
  const result = await h.invoke('getJobs');
  assert.equal(result.runtime.version, '2.3.3');
  assert.equal(result.runtime.manifestVersion, '9.0.0');
  assert.equal(result.runtime.protocol, 1);
});
