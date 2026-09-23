'use strict';
// Isolated Chromium profile: no user tabs, downloads, cookies or extension data are touched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const https = require('node:https');
const { createHash } = require('node:crypto');
const hash = data => createHash('sha256').update(data).digest('hex');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..', 'dist');
async function until(read, check, label) {
  for (let i = 0; i < 150; i++) { const value = await read(); if (check(value)) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`Timed out: ${label}; last value: ${JSON.stringify(await read())}`);
}
test('real extension: offscreen worker → OPFS → browser save → durable completion and cleanup', { timeout: 60000 }, async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cdl-extension-test-'));
  const downloads = path.join(profile, 'test-downloads'); fs.mkdirSync(downloads);
  fs.mkdirSync(path.join(profile, 'Default'));
  fs.writeFileSync(path.join(profile, 'Default', 'Preferences'), JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false, directory_upgrade: true } }));
  let context, server;
  const errors = [], requests = [];
  try {
    const fixture = [Buffer.from('fixture initialization\n'), Buffer.from('first media segment\n'), Buffer.from('second media segment\n'), Buffer.alloc(Math.round(1.2 * 1024 ** 2), 0x41), Buffer.alloc(Math.round(4.2 * 1024 ** 2), 0x42), Buffer.alloc(3 * 1024 ** 2, 0x43)];
    server = https.createServer({ key: fs.readFileSync(path.join(__dirname, 'fixtures/localhost-key.pem')), cert: fs.readFileSync(path.join(__dirname, 'fixtures/localhost-cert.pem')) }, (req, res) => {
      const index = Number(new URL(req.url, 'https://fixture.pstatic.net').pathname.slice(1)); requests.push(index);
      if (!fixture[index]) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': fixture[index].length, 'access-control-allow-origin': req.headers.origin || '*', 'access-control-allow-credentials': 'true' }); res.end(fixture[index]);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    context = await chromium.launchPersistentContext(profile, { executablePath: chromium.executablePath(), headless: true,
      args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`, '--host-resolver-rules=MAP fixture.pstatic.net 127.0.0.1', '--no-proxy-server', '--ignore-certificate-errors'], acceptDownloads: true });
    context.on('weberror', error => errors.push(error.error().message));
    let page = context.pages()[0] || await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'default', eventsEnabled: true });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const result = await worker.evaluate(port => startJob({ type: 'DOWNLOAD_SEGMENTS', itemId: 'fixture', itemKind: 'video', title: 'integration fixture', segments: [0, 1, 2].map(i => `https://fixture.pstatic.net:${port}/${i}`) }), port);
    assert.ok(result.job);
    const job = await until(() => worker.evaluate(async () => (await getJobs()).jobs.find(job => job.id === 'video-fixture')), job => job?.status === 'done', 'download completion');
    assert.equal(job.mode, 'dash');
    await until(() => worker.evaluate(async () => (await getJobs()).jobs[0]), job => job.hasLocalFile === false, 'temporary file cleanup');
    const [saved] = await worker.evaluate(id => chrome.downloads.search({ id }), job.downloadId);
    assert.equal(path.dirname(saved.filename), downloads);
    assert.equal(path.basename(saved.filename), 'integration fixture.mp4');
    const actual = fs.readFileSync(saved.filename);
    assert.deepEqual(actual, Buffer.concat(fixture.slice(0, 3))); assert.deepEqual(requests.sort(), [0, 1, 2]);
    const durable = await worker.evaluate(async () => ({ job: await CdlCore.db.get('jobs', 'video-fixture'), checkpoint: await CdlCore.db.get('checkpoints', 'video-fixture'), contexts: await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }) }));
    assert.equal(durable.job.status, 'done'); assert.equal(durable.checkpoint, undefined); assert.equal(durable.contexts.length, 1);
    await worker.evaluate(port => startJob({ type: 'DOWNLOAD_DIRECT', itemId: 'native-fixture', itemKind: 'clip', title: 'native fixture', url: `https://fixture.pstatic.net:${port}/1` }), port);
    const native = await until(() => worker.evaluate(async () => (await getJobs()).jobs.find(job => job.id === 'clip-native-fixture')), job => job?.status === 'done', 'native download completion');
    assert.equal(native.mode, 'native');
    const [nativeFile] = await worker.evaluate(id => chrome.downloads.search({ id }), native.downloadId);
    assert.equal(path.dirname(nativeFile.filename), downloads); assert.equal(path.basename(nativeFile.filename), 'native fixture.mp4');
    assert.deepEqual(fs.readFileSync(nativeFile.filename), fixture[1]);
    await worker.evaluate(() => removeJob('clip-native-fixture'));
    assert.ok(fs.existsSync(nativeFile.filename), 'removing a job must not delete its saved file');
    // Reproduce the user's two small inKey clips through the real content script,
    // resolver, MPD parser, native download path and onChanged completion events.
    const clips = [{ id: 'fixture-a', title: 'inKey clip A', index: 3 }, { id: 'fixture-b', title: 'inKey clip B', index: 4 }];
    const vod = { id: '123456', title: 'inKey VOD with optional audio', index: 5 };
    const vodMpd = fs.readFileSync(path.join(__dirname, 'fixtures/neonplayer-mixed.mpd'), 'utf8').replace('https://fixture.pstatic.net/full.mp4', `https://fixture.pstatic.net:${port}/5`);
    const cors = { 'access-control-allow-origin': 'https://chzzk.naver.com', 'access-control-allow-credentials': 'true' };
    await context.route('https://chzzk.naver.com/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }));
    await context.route('https://api.chzzk.naver.com/**', route => {
      const pathname = new URL(route.request().url()).pathname;
      const clip = clips.find(value => pathname.endsWith('/play-info/clip/' + value.id));
      const content = pathname.endsWith('/videos/' + vod.id)
        ? { videoId: 'fixture-vod', inKey: 'fixture-key', prevVideo: { trailerUrl: 'https://a01-g-naver-vod.akamaized.net/glive/other/trailer.mp4' } }
        : pathname.endsWith('/videos') ? { data: [{ videoNo: vod.id, videoTitle: vod.title }] }
        : clip ? { videoId: clip.id, inKey: 'fixture-key', contentId: clip.id, vodStatus: 'ABR_HLS' }
        : { data: clips.map(value => ({ clipUID: value.id, clipTitle: value.title })) };
      return route.fulfill({ headers: cors, json: { content } });
    });
    let playbackCalls = 0;
    await context.route('https://apis.naver.com/**', route => {
      const url = new URL(route.request().url()), clip = clips.find(value => url.pathname.endsWith('/' + value.id));
      assert.equal(url.searchParams.get('key'), 'fixture-key'); playbackCalls++;
      if (url.pathname.endsWith('/fixture-vod')) return route.fulfill({ headers: cors, contentType: 'application/dash+xml', body: vodMpd });
      assert.ok(clip);
      return route.fulfill({ headers: cors, contentType: 'application/dash+xml', body: `<?xml version="1.0"?><MPD><Period><AdaptationSet><Representation id="muxed" bandwidth="1000000"><BaseURL>https://fixture.pstatic.net:${port}/${clip.index}</BaseURL></Representation></AdaptationSet></Period></MPD>` });
    });
    await page.goto(`https://chzzk.naver.com/${'a'.repeat(32)}/clips`);
    await page.locator('#chzzk-dl-toggle').click();
    for (const clip of clips) await page.locator(`[data-item-id="clip-${clip.id}"] button`).click();
    await page.locator('#cdl-jobs-tab').click();
    for (const clip of clips) {
      await page.locator(`[data-job-id="clip-${clip.id}"][data-status="done"]`).waitFor();
      const savedJob = await worker.evaluate(async id => (await getJobs()).jobs.find(job => job.id === id), 'clip-' + clip.id);
      assert.equal(savedJob.mode, 'native');
      const [download] = await worker.evaluate(id => chrome.downloads.search({ id }), savedJob.downloadId);
      assert.equal(download.state, 'complete'); assert.equal(path.dirname(download.filename), downloads);
      assert.equal(path.basename(download.filename), clip.title + '.mp4');
      assert.equal(hash(fs.readFileSync(download.filename)), hash(fixture[clip.index]));
    }
    await page.goto(`https://chzzk.naver.com/${'a'.repeat(32)}/videos`);
    await page.locator('#chzzk-dl-toggle').click();
    await page.locator(`[data-item-id="video-${vod.id}"] button`).click();
    await page.locator('#cdl-jobs-tab').click();
    await page.locator(`[data-job-id="video-${vod.id}"][data-status="done"]`).waitFor();
    const vodJob = await worker.evaluate(async id => (await getJobs()).jobs.find(job => job.id === id), 'video-' + vod.id);
    const [vodFile] = await worker.evaluate(id => chrome.downloads.search({ id }), vodJob.downloadId);
    assert.equal(vodJob.mode, 'native'); assert.equal(vodFile.state, 'complete');
    assert.equal(path.basename(vodFile.filename), vod.title + '.mp4'); assert.equal(path.dirname(vodFile.filename), downloads);
    assert.equal(hash(fs.readFileSync(vodFile.filename)), hash(fixture[vod.index]));
    assert.equal(playbackCalls, 3);
    assert.equal(await page.locator('#cdl-connection').isHidden(), true);
    assert.equal(await page.locator('.cdl-job[data-status="error"], .cdl-job[data-status="unconfirmed"]').count(), 0);
    await page.locator('#cdl-log-toggle').click();
    const log = await page.locator('#cdl-debug').innerText();
    assert.doesNotMatch(log, /알 수 없는 메시지|Cannot read properties|설치 확인/);
    assert.match(log, /화면 v2\.3\.2 \/ 실행부 v2\.3\.2 \/ 설치 v2\.3\.2/);
    // Restart the browser with this test-only profile. The first real content
    // message must restore jobs from IndexedDB with no in-memory worker state.
    await context.close();
    context = await chromium.launchPersistentContext(profile, { executablePath: chromium.executablePath(), headless: true,
      args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`], acceptDownloads: true });
    context.on('weberror', error => errors.push(error.error().message));
    page = context.pages()[0] || await context.newPage();
    await context.route('https://chzzk.naver.com/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }));
    await context.route('https://api.chzzk.naver.com/**', route => route.fulfill({ json: { content: { data: [] } } }));
    await page.goto(`https://chzzk.naver.com/${'a'.repeat(32)}/videos`);
    await page.locator('#chzzk-dl-toggle').click(); await page.locator('#cdl-jobs-tab').click();
    await page.getByText('integration fixture', { exact: true }).waitFor();
    assert.equal(await page.locator('[data-job-id="video-fixture"]').getByRole('button', { name: '파일 보기', exact: true }).count(), 1);
    assert.deepEqual(errors, []);
  } catch (error) {
    console.error('test failed', error);
    try { for (const worker of context?.serviceWorkers() || []) console.error('jobs on failure', await Promise.race([worker.evaluate(async () => (await getJobs()).jobs), new Promise((_,reject) => setTimeout(() => reject(new Error('diagnostics timeout')), 2000))])); } catch (_) {}
    throw error;
  } finally {
    await context?.close();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    const resolved = path.resolve(profile), tempRoot = path.resolve(os.tmpdir()) + path.sep;
    assert.ok(resolved.startsWith(tempRoot) && path.basename(resolved).startsWith('cdl-extension-test-'));
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }
});
