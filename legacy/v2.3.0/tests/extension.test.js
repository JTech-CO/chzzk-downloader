'use strict';
// Isolated Chromium profile: no user tabs, downloads, cookies or extension data are touched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const https = require('node:https');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
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
    const fixture = [Buffer.from('fixture initialization\n'), Buffer.from('first media segment\n'), Buffer.from('second media segment\n')];
    server = https.createServer({ key: fs.readFileSync(path.join(__dirname, 'fixtures/localhost-key.pem')), cert: fs.readFileSync(path.join(__dirname, 'fixtures/localhost-cert.pem')) }, (req, res) => {
      const index = Number(req.url.slice(1)); requests.push(index);
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
    assert.deepEqual(actual, Buffer.concat(fixture)); assert.deepEqual(requests.sort(), [0, 1, 2]);
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
    assert.equal(await page.getByRole('button', { name: '파일 보기', exact: true }).count(), 1);
    assert.deepEqual(errors, []);
  } finally {
    await context?.close();
    if (server) await new Promise(resolve => server.close(resolve));
    const resolved = path.resolve(profile), tempRoot = path.resolve(os.tmpdir()) + path.sep;
    assert.ok(resolved.startsWith(tempRoot) && path.basename(resolved).startsWith('cdl-extension-test-'));
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }
});
