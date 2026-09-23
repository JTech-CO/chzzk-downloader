'use strict';
// Real OPFS quota enforcement in an isolated Chromium profile. Only the test
// copy's Range sizes and advisory estimate are adjusted; file APIs are unchanged.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');
const { runtimeFiles, dist } = require('../scripts/build.cjs');
const MiB = 1024 ** 2;
const hash = data => createHash('sha256').update(data).digest('hex');
async function until(read, check, label) {
  for (let i = 0; i < 150; i++) {
    const value = await read();
    if (check(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}; last value: ${JSON.stringify(await read())}`);
}

test('real storage: low estimates allow parallel save; actual OPFS quota falls back to native with identical bytes', { timeout: 60000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cdl-storage-test-'));
  const extension = path.join(directory, 'extension'), profile = path.join(directory, 'profile'), downloads = path.join(directory, 'downloads');
  for (const relative of runtimeFiles) {
    const target = path.join(extension, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(path.join(dist, relative), target);
  }
  const planPath = path.join(extension, 'media-plan.js');
  let plan = fs.readFileSync(planPath, 'utf8');
  for (const [before, after] of [
    ['const DIRECT_RANGE_MIN_BYTES = 256 * 1024 * 1024;', 'const DIRECT_RANGE_MIN_BYTES = 1 * 1024 * 1024;'],
    ['const DIRECT_RANGE_CHUNK_BYTES = 16 * 1024 * 1024;', 'const DIRECT_RANGE_CHUNK_BYTES = 256 * 1024;'],
  ]) { assert.ok(plan.includes(before)); plan = plan.replace(before, after); }
  fs.writeFileSync(planPath, plan);
  // Chromium may mask estimate() independently of the CDP-enforced quota. Fix
  // only the advisory estimate so the old extra 64 MiB preflight would reject.
  const enginePath = path.join(extension, 'download-engine.js');
  fs.writeFileSync(enginePath, 'navigator.storage.estimate = async () => ({ quota: 8 * 1024 ** 2, usage: 0 });\n' + fs.readFileSync(enginePath, 'utf8'));
  fs.mkdirSync(downloads); fs.mkdirSync(path.join(profile, 'Default'), { recursive: true });
  fs.writeFileSync(path.join(profile, 'Default', 'Preferences'), JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false, directory_upgrade: true } }));
  const fixture = Buffer.alloc(6 * MiB);
  for (let i = 0; i < fixture.length; i++) fixture[i] = (i * 31 + (i >>> 16)) & 255;
  const requests = [], errors = [];
  let context, server, worker;
  try {
    server = https.createServer({ key: fs.readFileSync(path.join(__dirname, 'fixtures/localhost-key.pem')), cert: fs.readFileSync(path.join(__dirname, 'fixtures/localhost-cert.pem')) }, (req, res) => {
      const url = new URL(req.url, 'https://fixture.pstatic.net');
      requests.push({ path: url.pathname, range: req.headers.range || null });
      const headers = { 'content-type': 'video/mp4', 'access-control-allow-origin': req.headers.origin || '*',
        'access-control-allow-credentials': 'true', 'access-control-expose-headers': 'Content-Range, ETag', 'accept-ranges': 'bytes', etag: '"storage-fixture-v1"' };
      if (url.searchParams.get('token') !== 'fixture') { res.writeHead(403); res.end(); return; }
      const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
      if (range) {
        const start = Number(range[1]), end = Number(range[2]);
        if (start > end || end >= fixture.length) { res.writeHead(416); res.end(); return; }
        const bytes = fixture.subarray(start, end + 1);
        res.writeHead(206, { ...headers, 'content-length': bytes.length, 'content-range': `bytes ${start}-${end}/${fixture.length}` }); res.end(bytes);
      } else { res.writeHead(200, { ...headers, 'content-length': fixture.length }); res.end(fixture); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    context = await chromium.launchPersistentContext(profile, { executablePath: chromium.executablePath(), headless: true, acceptDownloads: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--host-resolver-rules=MAP fixture.pstatic.net 127.0.0.1', '--no-proxy-server', '--ignore-certificate-errors'] });
    context.on('weberror', error => errors.push(error.error().message));
    const page = context.pages()[0] || await context.newPage(), cdp = await context.newCDPSession(page);
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'default', eventsEnabled: true });
    worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const origin = worker.url().replace(/\/background\.js$/, '');
    await worker.evaluate(async () => {
      await ready;
      globalThis.storageTestMessages = [];
      chrome.runtime.onMessage.addListener(message => {
        if (['ENGINE_LOG', 'ENGINE_EVENT'].includes(message.type)) storageTestMessages.push(message);
        return false;
      });
    });
    const port = server.address().port;
    for (const [id, quotaSize, mode] of [['low-estimate', 64 * MiB, 'parallel-range'], ['actual-quota', 3 * MiB, 'native']]) {
      await cdp.send('Storage.overrideQuotaForOrigin', { origin, quotaSize });
      const quota = await cdp.send('Storage.getUsageAndQuota', { origin });
      assert.equal(quota.overrideActive, true); assert.equal(quota.quota, quotaSize);
      const started = await worker.evaluate(({ id, port }) => startJob({ type: 'DOWNLOAD_DIRECT', itemId: id, itemKind: 'video', title: id,
        url: `https://fixture.pstatic.net:${port}/${id}.mp4?token=fixture` }), { id, port });
      assert.ok(started.job);
      const job = await until(() => worker.evaluate(async id => (await getJobs()).jobs.find(job => job.id === 'video-' + id), id),
        job => ['done', 'error', 'interrupted', 'cancelled'].includes(job?.status), id + ' completion');
      assert.equal(job.status, 'done', job.message); assert.equal(job.mode, mode);
      await until(() => worker.evaluate(id => CdlCore.db.get('checkpoints', 'video-' + id), id), checkpoint => !checkpoint, id + ' checkpoint cleanup');
      const [saved] = await worker.evaluate(id => chrome.downloads.search({ id }), job.downloadId);
      assert.equal(saved.state, 'complete'); assert.equal(path.dirname(saved.filename), downloads);
      assert.equal(path.basename(saved.filename), id + '.mp4'); assert.equal(hash(fs.readFileSync(saved.filename)), hash(fixture));
      const messages = await worker.evaluate(id => storageTestMessages.filter(message => message.jobId === 'video-' + id), id);
      const logs = messages.filter(message => message.type === 'ENGINE_LOG').map(message => message.message).join('\n');
      assert.equal(messages.some(message => message.patch?.status === 'error'), false);
      const transfers = requests.filter(request => request.path === `/${id}.mp4`);
      assert.ok(transfers.some(request => request.range && request.range !== 'bytes=0-0'), 'real Range transfer started');
      if (mode === 'native') {
        assert.match(logs, /실제 임시 저장 한도.*기본 다운로드로 전환/);
        assert.equal(transfers.filter(request => !request.range).length, 1, 'exactly one native restart');
      } else { assert.match(logs, /추정 한도 8\.0 MiB/); assert.equal(transfers.filter(request => !request.range).length, 0); }
      const remaining = await worker.evaluate(async () => { const root = await navigator.storage.getDirectory(); const names = []; for await (const name of root.keys()) names.push(name); return names; });
      assert.deepEqual(remaining, []);
      t.diagnostic(`${id}: quota ${quotaSize / MiB} MiB, ${mode}, saved 6 MiB with matching SHA-256, no remaining temporary files`);
    }
    assert.deepEqual(errors, []);
  } catch (error) {
    if (worker) try { console.error('storage diagnostics', await worker.evaluate(async () => ({ jobs: (await getJobs()).jobs, logs: storageTestMessages.filter(message => message.type === 'ENGINE_LOG') }))); } catch (_) {}
    throw error;
  } finally {
    await context?.close();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    const resolved = path.resolve(directory), tempRoot = path.resolve(os.tmpdir()) + path.sep;
    assert.ok(resolved.startsWith(tempRoot) && path.basename(resolved).startsWith('cdl-storage-test-'));
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }
});
