'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { harness, makeJob } = require('./helpers');
const sender = { id: 'test-extension', tab: { id: 1, url: 'https://chzzk.naver.com/' }, frameId: 0 };
const url = 'https://api.chzzk.naver.com/service/v2/videos/123';
const message = (id = 'request-1', extra = {}) => ({ type: 'FETCH_METADATA', requestId: id, url, accept: '', ...extra });
const fastTimers = (fn, ms) => setTimeout(fn, ms >= 10000 ? ms : 0);

test('metadata broker retries transient failures and preserves login credentials', async () => {
  const h = harness({ entry: 'background.js', timers: fastTimers }); let calls = 0;
  h.fetch(async (_url, options) => { calls++; assert.equal(options.credentials, 'include'); assert.equal(options.redirect, 'error'); if(calls < 3) throw new TypeError('Failed to fetch'); return new Response('{"content":{"inKey":null}}'); });
  const result = await h.invoke('fetchMetadata', message(), sender);
  assert.equal(calls, 3); assert.equal(JSON.parse(result.text).content.inKey, null);
});

test('metadata broker rejects arbitrary targets and invalid request options before fetching', async () => {
  const h = harness({ entry: 'background.js' }); let calls = 0; h.fetch(async () => { calls++; return new Response('{}'); });
  for(const bad of ['https://evil.example/video','https://api.chzzk.naver.com/private','https://apis.naver.com/other','https://api.chzzk.naver.com:444/service/v2/videos/123','https://user:pass@api.chzzk.naver.com/service/v2/videos/123']) {
    await assert.rejects(h.invoke('fetchMetadata',message('bad',{url:bad}),sender));
  }
  await assert.rejects(h.invoke('fetchMetadata', message('bad',{accept:'application/unknown'}), sender));
  assert.equal(calls,0);
});

test('metadata HTTP authorization errors are not retried or exposed as Failed to fetch', async () => {
  const h = harness({ entry: 'background.js', timers: fastTimers }); let calls=0;
  h.fetch(async()=>{calls++;return new Response('secret',{status:403});});
  await assert.rejects(h.invoke('fetchMetadata',message(),sender), /HTTP 403/);assert.equal(calls,1);
});

test('metadata failures identify the request stage and omit signed URL parameters', async () => {
  const h=harness({entry:'background.js',timers:fastTimers});h.fetch(async()=>{throw new TypeError('Failed to fetch');});
  await assert.rejects(h.invoke('fetchMetadata', message('neo',{url:'https://apis.naver.com/neonplayer/vodplay/v2/playback/fixture?key=SECRET',accept:'application/dash+xml'}),sender),error=> /Neonplayer/.test(error.message)&&/apis.naver.com/.test(error.message)&&!error.message.includes('SECRET'));
});

test('metadata cancellation is scoped to the requesting tab and terminates fetch', async () => {
  const h=harness({entry:'background.js'});let entered;const started=new Promise(r=>entered=r);
  h.fetch(async(_url,options)=>{entered();return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('Stopped','AbortError'))));});
  const pending=h.invoke('fetchMetadata',message(),sender);const rejection=assert.rejects(pending,{name:'AbortError'});await started;
  h.invoke('cancelMetadata',message(),{...sender,tab:{...sender.tab,id:2}});
  assert.equal(h.evaluate('metadataRequests.size'),1);
  h.invoke('cancelMetadata',message(),sender);await rejection;assert.equal(h.evaluate('metadataRequests.size'),0);
});

test('oversized metadata is rejected before creating an extension message', async()=>{
  const h=harness({entry:'background.js'});h.fetch(async()=>new Response('{}',{headers:{'content-length':String(21*1024**2)}}));
  await assert.rejects(h.invoke('fetchMetadata',message(),sender), /크기/);
});

test('MP4 probe retries a network failure before parallel transfer', async()=>{
  const h=harness({smallRanges:true,timers:fastTimers});let calls=0;
  h.fetch(async()=>{calls++;if(calls===1)throw new TypeError('Failed to fetch');return new Response(Uint8Array.of(0),{status:206,headers:{'content-range':'bytes 0-0/64',etag:'"v1"'}});});
  const probe=await h.invoke('probeDirectRange','https://vod.pstatic.net/fixture.mp4',new AbortController().signal);
  assert.equal(probe.supported,true);assert.equal(calls,2);
});

test('a failed MP4 network probe switches once to native without claiming completion', async()=>{
  const h=harness({smallRanges:true,timers:fastTimers});let calls=0;h.fetch(async()=>{calls++;throw new TypeError('Failed to fetch');});
  const url='https://vod.pstatic.net/fixture.mp4?token=secret';await h.invoke('directDownload',makeJob('probe',{url}));
  assert.equal(calls,3);assert.deepEqual(h.rpcs.map(r=>r.action),['NATIVE_DOWNLOAD']);assert.equal(h.rpcs[0].url,url);assert.ok(!h.events.some(e=>e.patch.status==='done'));
});

test('MP4 probe authorization errors do not trigger native fallback', async()=>{
  const h=harness({timers:fastTimers});h.fetch(async()=>new Response('',{status:403}));
  await assert.rejects(h.invoke('directDownload',makeJob('denied',{url:'https://vod.pstatic.net/fixture.mp4'})),/HTTP 403/);assert.equal(h.rpcs.length,0);
});

test('HLS fetch failures report their phase without URL tokens',async()=>{
  const h=harness({timers:fastTimers});h.fetch(async()=>{throw new TypeError('Failed to fetch');});
  await assert.rejects(h.invoke('fetchHlsText','https://light-slit.akamaized.net/chzzk/fixture.m3u8?token=SECRET',new AbortController().signal,'omit'),error=>/HLS 재생목록/.test(error.message)&&/light-slit.akamaized.net/.test(error.message)&&!error.message.includes('SECRET'));
});

test('content requests keep the successful page path and do not bypass HTTP 403', async () => {
  const h = harness({ entry: 'media-resolver.js' });
  h.fetch(async (_url, options) => { assert.equal(options.credentials, 'include'); return new Response('{"content":{}}'); });
  await h.context.CdlMedia.fetchJson(url);
  h.fetch(async () => new Response('', { status: 403 }));
  await assert.rejects(h.context.CdlMedia.fetchJson(url), /VOD 정보.*HTTP 403/);
  assert.equal(h.calls.length, 0);
});

test('content fallback preserves cancellation and reports an invalidated extension', async () => {
  const h = harness({ entry: 'media-resolver.js' });
  h.fetch(async () => { throw new TypeError('Failed to fetch'); });
  const messages = []; let started;
  const ready = new Promise(resolve => { started = resolve; });
  h.chrome.runtime.sendMessage = message => { messages.push(message); started(); return new Promise(() => {}); };
  const controller = new AbortController();
  const pending = h.context.CdlMedia.fetchJson(url, controller.signal);
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await ready; controller.abort(); await rejected;
  assert.deepEqual(messages.map(message => message.type), ['FETCH_METADATA', 'CANCEL_METADATA']);
  assert.equal(messages[0].requestId, messages[1].requestId);
  h.chrome.runtime.sendMessage = () => { throw new Error('Extension context invalidated'); };
  await assert.rejects(h.context.CdlMedia.fetchJson(url), /새로고침/);
});

test('metadata rejects an unauthorized sender or subframe, and bounds streamed bodies', async () => {
  const h = harness({ entry: 'background.js' }); let calls = 0, cancelled = false;
  h.fetch(async () => {
    calls++;
    return new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(1024 ** 2)); }, cancel() { cancelled = true; } }));
  });
  for (const bad of [{ ...sender, id: 'other' }, { ...sender, frameId: 1 }, { ...sender, tab: { id: 1, url: 'https://evil.example' } }]) {
    await assert.rejects(h.invoke('fetchMetadata', message(), bad), /유효하지/);
  }
  assert.equal(calls, 0);
  await assert.rejects(h.invoke('fetchMetadata', message(), sender), /크기/);
  assert.equal(calls, 1); assert.equal(cancelled, true); assert.equal(h.evaluate('metadataRequests.size'), 0);
});

test('cancelling an MP4 probe cannot start native downloading', async () => {
  const h = harness({ timers: fastTimers }), job = makeJob('cancel-probe', { url: 'https://vod.pstatic.net/fixture.mp4' });
  h.fetch(async () => { job.ac.abort(); throw new TypeError('Failed to fetch'); });
  await assert.rejects(h.invoke('directDownload', job), { name: 'AbortError' });
  assert.equal(h.rpcs.length, 0);
});

test('MP4 server errors exhaust retries without native fallback or ignoring Retry-After', async () => {
  const h = harness({ timers: fastTimers }); let calls = 0;
  h.fetch(async () => { calls++; return new Response('', { status: 503 }); });
  await assert.rejects(h.invoke('directDownload', makeJob('server-probe', { url: 'https://vod.pstatic.net/fixture.mp4' })), /HTTP 503/);
  assert.equal(calls, 3); assert.equal(h.rpcs.length, 0);
  calls = 0;
  h.fetch(async () => { calls++; return new Response('', { status: 429, headers: { 'retry-after': '60' } }); });
  await assert.rejects(h.invoke('directDownload', makeJob('limited-probe', { url: 'https://vod.pstatic.net/fixture.mp4' })), /HTTP 429/);
  assert.equal(calls, 1); assert.equal(h.rpcs.length, 0);
});
