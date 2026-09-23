'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { harness } = require('./helpers');
const root = path.resolve(__dirname, '..');
const mpd = fs.readFileSync(path.join(__dirname, 'fixtures/neonplayer-mixed.mpd'), 'utf8');
const full = 'https://fixture.pstatic.net/full.mp4?token=fixture';
const preview = 'https://a01-g-naver-vod.akamaized.net/glive/c/read/v2/VOD_ALPHA/glive/other/trailer.mp4?token=fixture';
const splitOnly = '<MPD><Period><AdaptationSet mimeType="video/mp4"><Representation bandwidth="8000000" codecs="avc1.64002a"><BaseURL>https://fixture.pstatic.net/silent.mp4</BaseURL></Representation></AdaptationSet><AdaptationSet mimeType="audio/mp4"><Representation codecs="mp4a.40.2"/></AdaptationSet></Period></MPD>';
let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });

async function mount({ archived = false, xml = mpd, status = 200, content = {} } = {}) {
  const context = await browser.newContext(), page = await context.newPage();
  const source = archived ? path.join(root, 'legacy/v2.3.0') : path.join(root, 'src');
  await page.addScriptTag({ path: path.join(source, 'dash-parser.js') });
  await page.addScriptTag({ path: path.join(source, 'media-resolver.js') });
  await page.evaluate(({ xml, status, content }) => {
    window.calls = []; window.logs = [];
    CdlMedia.setLogger(message => logs.push(message));
    window.fetch = async (url, options) => {
      calls.push({ url, accept: options.headers.Accept });
      const detail = new URL(url).pathname.startsWith('/service/v2/videos/');
      return new Response(detail ? JSON.stringify({ content }) : xml, { status: detail ? 200 : status });
    };
  }, { xml, status, content: { videoId: 'fixture-video', inKey: 'fixture+key&', prevVideo: { trailerUrl: preview }, nextVideo: { trailerUrl: preview }, ...content } });
  return { page, context };
}

test('reproduction: v2.3.0 rejects muxed VOD with optional audio and then selects a neighbouring preview', async () => {
  const { page, context } = await mount({ archived: true });
  try {
    const plan = await page.evaluate(() => CdlMedia.resolveVodUrl('123'));
    assert.equal(plan.url, preview);
    assert.match((await page.evaluate(() => logs)).join('\n'), /별도 오디오 트랙/);
    assert.throws(() => harness({ entry: 'background.js' }).invoke('validateDirectMessage', { url: plan.url }), /허용된 치지직 미디어 도메인/);
  } finally { await context.close(); }
});

test('inKey VOD chooses the highest-quality muxed MP4 despite optional audio and higher-bitrate silent video', async () => {
  const { page, context } = await mount();
  try {
    const plan = await page.evaluate(() => CdlMedia.resolveVodUrl('123'));
    assert.equal(plan.type, 'mp4'); assert.equal(plan.url, full); assert.equal(plan.bandwidth, 8180000);
    const calls = await page.evaluate(() => window.calls);
    assert.equal(calls.length, 2); assert.equal(new URL(calls[1].url).searchParams.get('key'), 'fixture+key&');
    assert.equal(calls[1].accept, 'application/dash+xml');
    assert.equal(harness({ entry: 'background.js' }).invoke('validateDirectMessage', { url: plan.url }).url, full);
  } finally { await context.close(); }
});

test('muxed codecs can be inherited, and optional audio order does not affect selection', async () => {
  const { page, context } = await mount();
  try {
    const xml = '<MPD><Period><AdaptationSet contentType="audio"><Representation/></AdaptationSet><AdaptationSet mimeType="video/mp4" codecs=" avc1.64002a, mp4a.40.2 "><Representation bandwidth="8"><BaseURL>https://fixture.pstatic.net/full.mp4</BaseURL></Representation></AdaptationSet></Period></MPD>';
    assert.equal((await page.evaluate(xml => CdlDash.parse(xml, 'https://apis.naver.com/fixture.mpd'), xml)).url, full.split('?')[0]);
  } finally { await context.close(); }
});

test('separate video and audio still fail when no muxed representation is available', async () => {
  const { page, context } = await mount();
  try {
    for (const xml of [splitOnly, splitOnly.replace(' codecs="avc1.64002a"', '')]) {
      await assert.rejects(page.evaluate(xml => CdlDash.parse(xml, 'https://apis.naver.com/fixture.mpd'), xml), /별도 오디오 트랙/);
    }
  } finally { await context.close(); }
});

test('unsupported playback preserves its real error and never falls back to current or neighbouring trailers', async () => {
  const { page, context } = await mount({ xml: splitOnly, content: { trailerUrl: 'https://fixture.pstatic.net/current-preview.mp4', prevVideo: { trailerUrl: 'https://fixture.pstatic.net/previous-preview.mp4' } } });
  try {
    await assert.rejects(page.evaluate(() => CdlMedia.resolveVodUrl('123')), /별도 오디오 트랙/);
    assert.equal((await page.evaluate(() => calls)).length, 2);
  } finally { await context.close(); }
});

test('neonplayer HTTP errors are preserved rather than disguised as a preview domain failure', async () => {
  const { page, context } = await mount({ status: 403 });
  try { await assert.rejects(page.evaluate(() => CdlMedia.resolveVodUrl('123')), /HTTP 403/); }
  finally { await context.close(); }
});

test('only explicit current-video playback URL fields are considered as direct fallback', async () => {
  for (const [field, url, type] of [['videoUrl', full, 'mp4'], ['playbackUrl', 'https://fixture.pstatic.net/current.m3u8?token=fixture', 'hls']]) {
    const { page, context } = await mount({ content: { videoId: null, inKey: null, [field]: url } });
    try { assert.deepEqual(await page.evaluate(() => CdlMedia.resolveVodUrl('123')), { type, url }); }
    finally { await context.close(); }
  }
});

test('current-video rewind HLS remains a valid fallback when neonplayer fails', async () => {
  const url = 'https://light-slit.akamaized.net/chzzk/fixture/media.m3u8?token=fixture';
  const { page, context } = await mount({ status: 503, content: { liveRewindPlaybackJson: JSON.stringify({ media: [{ protocol: 'HLS', path: url }] }) } });
  try { assert.deepEqual(await page.evaluate(() => CdlMedia.resolveVodUrl('123')), { type: 'hls', url }); }
  finally { await context.close(); }
});
