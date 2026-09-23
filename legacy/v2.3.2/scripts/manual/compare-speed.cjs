'use strict';
// Read-only comparison: production sources are loaded unchanged. Only the new
// VM test harness scales direct-Range sizes to 4 bytes to isolate scheduling.
// Network, disk and browser saving are mocked; these are NOT CDN speed figures.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { harness, makeJob, memoryStorage } = require('../../tests/helpers');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, 'test-results');
fs.mkdirSync(output, { recursive: true });
const currentVersion = JSON.parse(fs.readFileSync(path.join(root, 'src/manifest.json'), 'utf8')).version;
const url = 'https://vod.pstatic.net/comparison.mp4';
const count = 32, chunk = 4, total = count * chunk;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const rounded = value => Math.round(value * 10) / 10;
async function transfer(version, stalled, repeat) {
  const old = version === '2.2.6';
  const h = harness({ ...(old ? { entry: 'legacy/v2.2.6/background.js' } : { smallRanges: true }) });
  let active = 0, peak = 0, completed = 0, firstDone = false, issuedBeforeFirst = 0;
  const requests = [], written = new Uint8Array(total); let offset = 0;
  h.fetch(async (_url, options) => {
    const [start, end] = options.headers.Range.slice(6).split('-').map(Number);
    const probe = start === 0 && end === 0;
    if (!probe) {
      const index = start / chunk; requests.push(index);
      if (!firstDone) issuedBeforeFirst++;
      active++; peak = Math.max(peak, active);
      await pause(stalled && index === 0 ? 500 : 40);
      active--; completed++; if (index === 0) firstDone = true;
    }
    return new Response(Uint8Array.from({ length: end - start + 1 }, (_, i) => start + i), {
      status: 206, headers: { 'content-range': `bytes ${start}-${end}/${total}`, 'content-length': String(end - start + 1), etag: '"fixture-v1"' },
    });
  });
  const start = performance.now();
  if (old) {
    h.evaluate('deliverDownload = async () => {};');
    const probe = await h.invoke('probeDirectRange', url, new AbortController().signal);
    const segments = Array.from({ length: count }, (_, i) => ({ url, range: `${i * chunk}-${(i + 1) * chunk - 1}`, totalBytes: total, validator: probe.validator }));
    const stream = { root: { removeEntry: async () => {} }, name: 'fixture', fh: {}, writable: {
      async write(buffer) { written.set(new Uint8Array(buffer), offset); offset += buffer.byteLength; }, async close() {}, async abort() {},
    } };
    await h.invoke('downloadStreaming', segments, 'fixture', 'fixture', null, 'include', new AbortController(), stream, null,
      { concurrency: 8, expectedTotalBytes: total, byteProgress: true });
  } else {
    await h.invoke('directDownload', makeJob('video-fixture', { type: 'DOWNLOAD_DIRECT', url }));
    written.set([...h.storage.files.values()][0].data);
  }
  const elapsedMs = rounded(performance.now() - start);
  assert.deepEqual(written, Uint8Array.from({ length: total }, (_, i) => i));
  assert.equal(completed, count);
  return { version, scenario: stalled ? 'first-range-500ms' : 'uniform-40ms', repeat, elapsedMs, peak, issuedBeforeFirst, requests: requests.length };
}
async function resumeComparison() {
  const storage = memoryStorage(), h = harness({ smallRanges: true, storage });
  const job = makeJob('video-resume', { type: 'DOWNLOAD_DIRECT', url });
  const response = (start, end) => new Response(Uint8Array.from({ length: end - start + 1 }, (_, i) => start + i), {
    status: 206, headers: { 'content-range': `bytes ${start}-${end}/${total}`, 'content-length': String(end - start + 1), etag: '"fixture-v1"' },
  });
  h.fetch(async (_url, options) => {
    const [start, end] = options.headers.Range.slice(6).split('-').map(Number);
    if (start >= total / 2) await new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true }));
    return response(start, end);
  });
  const running = h.invoke('directDownload', job); const stopped = assert.rejects(running);
  while (![...storage.files.values()].some(file => file.data.length >= total / 2)) await pause(1);
  job.ac.abort(); await stopped;
  const checkpoint = await storage.database.get('checkpoints', job.id);
  assert.equal(checkpoint.completed.length, 16);
  const restarted = harness({ smallRanges: true, storage }), requested = [];
  restarted.fetch(async (_url, options) => { const [start, end] = options.headers.Range.slice(6).split('-').map(Number); if (end > start) requested.push(start / chunk); return response(start, end); });
  await restarted.invoke('directDownload', makeJob(job.id, { type: 'DOWNLOAD_DIRECT', url }));
  assert.deepEqual(requested.sort((a, b) => a - b), Array.from({ length: 16 }, (_, i) => i + 16));
  assert.deepEqual([...storage.files.values()][0].data, Uint8Array.from({ length: total }, (_, i) => i));
  return { completedBeforeStop: 16, totalRanges: 32, rangesRequestedAfterRestart: requested.length, reused: 16 };
}
async function uiComparison(browser, version, repeat) {
  const old = version === '2.2.6', directory = old ? path.join(root, 'legacy/v2.2.6') : path.join(root, 'src');
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }));
  const page = await context.newPage();
  try {
    await page.goto(`https://chzzk.naver.com/${'a'.repeat(32)}/videos`);
    await page.addStyleTag({ path: path.join(directory, 'content.css') });
    await page.evaluate(() => {
      window.metrics = { start: 0, calls: 0, firstMs: null };
      window.chrome = { runtime: { onMessage: { addListener() {} }, sendMessage(_message, callback) { const result = { jobs: [] }; if (callback) callback(result); return Promise.resolve(result); } } };
      window.fetch = async url => {
        const parsed = new URL(url);
        if (!parsed.pathname.endsWith('/videos')) return new Response(JSON.stringify({ content: {} }));
        metrics.calls++;
        await new Promise(resolve => setTimeout(resolve, 20));
        const page = Number(parsed.searchParams.get('page'));
        const data = Array.from({ length: Math.min(24, Math.max(0, 2400 - page * 24)) }, (_, i) => ({
          videoNo: 10000 - page * 24 - i, videoTitle: `테스트 영상 ${page * 24 + i}`, duration: 3600,
          publishDate: new Date(Date.UTC(2026, 8, 20) - (page * 24 + i) * 86400000).toISOString(), readCount: 100,
        }));
        return new Response(JSON.stringify({ content: { data } }));
      };
      const observer = new MutationObserver(() => {
        if (metrics.firstMs == null && document.querySelector('.cdl-tile,.cdl-card')) {
          observer.disconnect(); requestAnimationFrame(() => { metrics.firstMs = performance.now() - metrics.start; });
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });
    if (!old) {
      await page.addScriptTag({ path: path.join(directory, 'dash-parser.js') });
      await page.addScriptTag({ path: path.join(directory, 'media-resolver.js') });
    }
    await page.evaluate(source => { metrics.start = performance.now(); (0, eval)(source); document.getElementById('chzzk-dl-toggle').click(); }, fs.readFileSync(path.join(directory, 'content.js'), 'utf8'));
    await page.waitForFunction(() => metrics.firstMs != null);
    const result = await page.evaluate(() => ({ firstMs: metrics.firstMs, apiCalls: metrics.calls, cardNodes: document.querySelectorAll('.cdl-tile,.cdl-card').length }));
    return { version, repeat, ...result, firstMs: rounded(result.firstMs) };
  } finally { await context.close(); }
}
(async () => {
  const network = [];
  // Alternate order to reduce process warmup/order bias. No overlap between runs.
  for (let repeat = 1; repeat <= 3; repeat++) for (const stalled of [false, true]) for (const version of repeat % 2 ? ['2.2.6', currentVersion] : [currentVersion, '2.2.6']) {
    const result = await transfer(version, stalled, repeat); network.push(result); console.log(JSON.stringify(result));
  }
  const resume = await resumeComparison(); console.log(JSON.stringify({ resume }));
  const ui = [], browser = await chromium.launch({ headless: true });
  try {
    for (let repeat = 1; repeat <= 3; repeat++) for (const version of repeat % 2 ? ['2.2.6', currentVersion] : [currentVersion, '2.2.6']) {
      const result = await uiComparison(browser, version, repeat); ui.push(result); console.log(JSON.stringify({ ui: result }));
    }
  } finally { await browser.close(); }
  const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const summary = {};
  for (const scenario of ['uniform-40ms', 'first-range-500ms']) for (const version of ['2.2.6', currentVersion]) summary[scenario + ':' + version] = median(network.filter(row => row.scenario === scenario && row.version === version).map(row => row.elapsedMs));
  for (const version of ['2.2.6', currentVersion]) summary['ui-first:' + version] = median(ui.filter(row => row.version === version).map(row => row.firstMs));
  const report = { date: new Date().toISOString(), environment: { node: process.version, platform: process.platform },
    conditions: { network: 'Mock fetch and memory-backed OPFS; 32 x 4-byte ranges; 40 ms response latency; optional first range 500 ms; saves mocked; no CDN or real disk throughput', ui: 'Actual headless Chromium, unchanged UI source, empty host page; 2400 items; 24/page; mock fetch delay 20ms/page; first-card animation frame; 1280x900 viewport', repeats: 3 }, summary, network, resume, ui };
  fs.writeFileSync(path.join(output, 'speed-comparison.json'), JSON.stringify(report, null, 2));
  console.log('SUMMARY', JSON.stringify(summary));
})().catch(error => { console.error(error); process.exitCode = 1; });
