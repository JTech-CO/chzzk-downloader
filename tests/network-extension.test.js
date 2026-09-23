'use strict';
// Real HTTPS/CORS and extension messaging, with synthetic media only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const root = path.resolve(__dirname, '..');
const channel = 'a'.repeat(32);
const videos = [{ id: '101', title: 'inKey VOD' }, { id: '102', title: 'rewind VOD' }, { id: '103', title: 'probe fallback VOD' }];
const clip = { id: 'clip-1', title: 'inKey clip' };
function box(type, data) {
  const result = Buffer.alloc(8 + data.length); result.writeUInt32BE(result.length); result.write(type, 4); data.copy(result, 8); return result;
}
async function scenario(archived) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cdl-network-test-'));
  const downloads = path.join(profile, 'downloads'); fs.mkdirSync(downloads);
  fs.mkdirSync(path.join(profile, 'Default'));
  fs.writeFileSync(path.join(profile, 'Default/Preferences'), JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false } }));
  let context, server;
  const calls = [], errors = [], consoleErrors = [];
  // Minimal box fixtures exercise the transfer/finalizer, not codec playback.
  const mvhd = Buffer.alloc(20); mvhd.writeUInt32BE(1000, 12);
  const init = Buffer.concat([box('ftyp', Buffer.from('isom0000')), box('moov', box('mvhd', mvhd))]);
  const segment = box('mdat', Buffer.from('synthetic media payload'));
  const expectedInit = Buffer.from(init); expectedInit.writeUInt32BE(2000, expectedInit.length - 4);
  const direct = Buffer.alloc(32 * 1024, 0x42);
  try {
    server = https.createServer({ key: fs.readFileSync(path.join(__dirname, 'fixtures/localhost-key.pem')), cert: fs.readFileSync(path.join(__dirname, 'fixtures/localhost-cert.pem')) }, (req, res) => {
      const url = new URL(req.url, 'https://' + req.headers.host);
      calls.push({ host: url.hostname, path: url.pathname, range: req.headers.range });
      const reply = (body, type = 'application/json', cors = false) => {
        res.writeHead(200, { 'content-type': type, 'content-length': Buffer.byteLength(body), ...(cors ? { 'access-control-allow-origin': 'https://chzzk.naver.com', 'access-control-allow-credentials': 'true' } : {}) }); res.end(body);
      };
      if (url.hostname === 'api.chzzk.naver.com') {
        // Only catalog calls have CORS. Actual playback info lacks ACAO.
        if (url.pathname.endsWith('/videos') || url.pathname.endsWith('/clips')) {
          const data = url.pathname.endsWith('/videos') ? videos.map(v => ({ videoNo: v.id, videoTitle: v.title })) : [{ clipUID: clip.id, clipTitle: clip.title }];
          return reply(JSON.stringify({ content: { data } }), 'application/json', true);
        }
        const rewind = url.pathname.endsWith('/102');
        return reply(JSON.stringify({ content: rewind ? { videoId: 'rewind', liveRewindPlaybackJson: JSON.stringify({ media: [{ protocol: 'HLS', path: 'https://fixture.pstatic.net/media.m3u8' }] }) } : { videoId: url.pathname.split('/').pop(), inKey: 'fixture-key' } }));
      }
      if (url.hostname === 'apis.naver.com') {
        const filename = url.pathname.endsWith('/103') ? 'probe.mp4' : 'direct.mp4';
        return reply(`<MPD><Period><AdaptationSet><Representation><BaseURL>https://fixture.pstatic.net/${filename}</BaseURL></Representation></AdaptationSet></Period></MPD>`, 'application/dash+xml');
      }
      if (url.pathname === '/probe.mp4' && req.headers.range) { req.socket.destroy(); return; }
      if (url.pathname === '/direct.mp4' || url.pathname === '/probe.mp4') return reply(direct, 'video/mp4');
      if (url.pathname === '/media.m3u8') return reply('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2,\nseg.m4s\n#EXT-X-ENDLIST', 'application/vnd.apple.mpegurl');
      if (url.pathname === '/init.mp4') return reply(init, 'video/mp4');
      if (url.pathname === '/seg.m4s') return reply(segment, 'video/mp4');
      res.writeHead(404); res.end();
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const extension = path.join(root, archived ? 'legacy/v2.3.2/dist' : 'dist');
    const mapping = ['api.chzzk.naver.com', 'apis.naver.com', 'fixture.pstatic.net'].map(host => `MAP ${host} 127.0.0.1:${port}`).join(',');
    context = await chromium.launchPersistentContext(profile, { executablePath: chromium.executablePath(), headless: true, acceptDownloads: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, `--host-resolver-rules=${mapping}`, '--no-proxy-server', '--ignore-certificate-errors'] });
    // Permit the loopback fixture only; leave browser CORS enforcement enabled.
    await context.grantPermissions(['local-network-access'], { origin: 'https://chzzk.naver.com' });
    context.on('weberror', event => errors.push(event.error().message));
    const page = context.pages()[0]; page.setDefaultTimeout(15000);
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    const cdp = await context.newCDPSession(page);
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'default', eventsEnabled: true });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    await context.route('https://chzzk.naver.com/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' }));
    for (const [kind, items] of [['videos', videos], ['clips', [clip]]]) {
      await page.goto(`https://chzzk.naver.com/${channel}/${kind}`);
      await page.locator('#chzzk-dl-toggle').click();
      for (const item of items) {
        const id = (kind === 'videos' ? 'video-' : 'clip-') + item.id;
        await page.locator('#cdl-browse-tab').click();
        await page.locator(`[data-item-id="${id}"] button`).click();
        await page.locator('#cdl-jobs-tab').click();
        await page.locator(`[data-job-id="${id}"][data-status="${archived ? 'error' : 'done'}"]`).waitFor();
        if (archived) {
          assert.match(await page.locator(`[data-job-id="${id}"]`).innerText(), /Failed to fetch/);
        } else {
          const job = await worker.evaluate(async id => (await getJobs()).jobs.find(job => job.id === id), id);
          const [saved] = await worker.evaluate(id => chrome.downloads.search({ id }), job.downloadId);
          assert.equal(saved.state, 'complete'); assert.equal(path.dirname(saved.filename), downloads);
          assert.equal(job.mode, item.id === '102' ? 'hls' : 'native');
          assert.equal(sha(fs.readFileSync(saved.filename)), sha(item.id === '102' ? Buffer.concat([expectedInit, segment]) : direct));
        }
      }
    }
    if (archived) {
      assert.equal(await worker.evaluate(async () => (await getJobs()).jobs.length), 0);
      assert.equal(calls.some(call => call.host === 'apis.naver.com'), false);
    } else {
      assert.ok(calls.filter(call => call.path === '/probe.mp4' && call.range).length >= 3);
      assert.equal(calls.filter(call => call.path === '/probe.mp4' && !call.range).length, 1);
      assert.equal(await worker.evaluate(() => metadataRequests.size), 0);
      // Page requests still fail, proving extension permissions did not disable CORS.
      const failure = await page.evaluate(async () => { try { await fetch('https://api.chzzk.naver.com/service/v2/videos/101'); return null; } catch (error) { return error.message; } });
      assert.match(failure, /Failed to fetch/);
    }
    assert.ok(consoleErrors.some(error => /No 'Access-Control-Allow-Origin' header/.test(error)), 'the fixture must fail CORS, not loopback permission checks');
    assert.equal(consoleErrors.some(error => /Permission was denied/.test(error)), false);
    assert.deepEqual(errors, []);
  } catch (error) {
    console.error({ archived, calls, consoleErrors });
    throw error;
  } finally {
    await context?.close();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    const resolved = path.resolve(profile);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('cdl-network-test-'));
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }
}
test('v2.3.2 reproduction: CORS stops inKey VOD, rewind VOD and clip before download', { timeout: 60000 }, () => scenario(true));
test('v2.3.3: real metadata CORS fallback, rewind HLS saving and failed MP4 probe recovery', { timeout: 90000 }, () => scenario(false));
