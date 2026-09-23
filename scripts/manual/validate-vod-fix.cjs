'use strict';
// Manual, read-only check of public playback metadata. Never stores signed URLs.
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { harness } = require('../../tests/helpers');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, 'test-results');
fs.mkdirSync(output, { recursive: true });
const channel = '72a070a5c8437b0c3c196880a054ae48';
const validation = harness({ entry: 'background.js' });
function request(url, { headers = {}, range = false, limit = 10 * 1024 ** 2 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://chzzk.naver.com/', ...headers } }, res => {
      if (range && res.statusCode !== 206) { res.destroy(); reject(new Error('Range HTTP ' + res.statusCode)); return; }
      const chunks = []; let size = 0;
      res.on('data', data => { size += data.length; if (size > limit) { res.destroy(); reject(new Error('Response exceeds check limit')); } else chunks.push(data); });
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, data: Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.setTimeout(20000, () => req.destroy(new Error('Request timeout')));
  });
}
async function json(url) { const response = await request(url); assert.equal(response.status, 200); return JSON.parse(response.data.toString()); }
async function resolve(page, content, xml, videoNo) {
  return page.evaluate(async ({ content, xml, videoNo }) => {
    window.fetch = async url => new Response(new URL(url).pathname.startsWith('/service/v2/videos/') ? JSON.stringify({ content }) : xml);
    return CdlMedia.resolveVodUrl(String(videoNo));
  }, { content, xml, videoNo });
}
(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const oldPage = await browser.newPage(), page = await browser.newPage();
    for (const [target, folder] of [[oldPage, 'legacy/v2.3.0'], [page, 'src']]) {
      for (const file of ['dash-parser.js', 'media-resolver.js']) await target.addScriptTag({ path: path.join(root, folder, file) });
    }
    const list = await json(`https://api.chzzk.naver.com/service/v1/channels/${channel}/videos?sortType=LATEST&pagingType=PAGE&page=0&size=24`);
    const results = [];
    for (const video of list.content.data) {
      const { content } = await json('https://api.chzzk.naver.com/service/v2/videos/' + video.videoNo);
      assert.ok(content.videoId && content.inKey);
      const playback = await request(`https://apis.naver.com/neonplayer/vodplay/v2/playback/${content.videoId}?key=${encodeURIComponent(content.inKey)}&sid=2099&env=real&lc=ko&cpl=ko`, { headers: { Accept: 'application/dash+xml' } });
      assert.equal(playback.status, 200);
      const xml = playback.data.toString();
      const oldPlan = await resolve(oldPage, content, xml, video.videoNo);
      const plan = await resolve(page, content, xml, video.videoNo);
      const previewUrls = [content.trailerUrl, content.prevVideo?.trailerUrl, content.nextVideo?.trailerUrl].filter(Boolean);
      assert.ok(previewUrls.includes(oldPlan.url), 'old resolver must reproduce preview selection');
      assert.throws(() => validation.invoke('validateDirectMessage', { url: oldPlan.url }), /허용된 치지직 미디어 도메인/);
      assert.ok(!previewUrls.includes(plan.url)); assert.equal(plan.type, 'mp4');
      validation.invoke('validateDirectMessage', { url: plan.url });
      const entry = { videoNo: video.videoNo, hasInKey: true, old: { selectedPreview: true, host: new URL(oldPlan.url).hostname, rejected: true }, current: { type: plan.type, host: new URL(plan.url).hostname, bandwidth: plan.bandwidth, accepted: true } };
      if (results.length < 2) {
        const sample = await request(plan.url, { headers: { Range: 'bytes=0-65535' }, range: true, limit: 65536 });
        assert.equal(sample.data.length, 65536);
        const total = Number(sample.headers['content-range'].split('/')[1]);
        validation.invoke('validateDirectRangeResponse', new Response(sample.data, { status: sample.status, headers: sample.headers }), '0-65535', total);
        assert.equal(sample.data.toString('ascii', 4, 8), 'ftyp');
        entry.sample = { httpStatus: sample.status, bytes: sample.data.length, totalBytes: total, contentRangeValid: true, startsWithMp4: true };
      }
      results.push(entry); console.log(JSON.stringify(entry));
    }
    const report = { checkedAt: new Date().toISOString(), channel, baseline: '2.3.0', current: JSON.parse(fs.readFileSync(path.join(root, 'src/manifest.json'), 'utf8')).version, results, scope: 'Public live API metadata and two 64 KiB Range samples; no complete production VOD download or speed measurement.' };
    fs.writeFileSync(path.join(output, 'vod-fix-validation.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(`Checked ${results.length} public VODs; no inKey or signed URL was written to the report.`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error.message.replace(/https?:\/\/\S+/g, '[URL]')); process.exitCode = 1; });
