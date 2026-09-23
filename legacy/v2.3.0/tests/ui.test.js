'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'test-results');
let browser;
before(async () => { fs.mkdirSync(output, { recursive: true }); browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });
const channel = 'a'.repeat(32);
async function mount({ section = 'videos', count = 48, error = false, viewport = { width: 1280, height: 900 } } = {}) {
  const context = await browser.newContext({ viewport });
  await context.route('**/*', async route => {
    if (route.request().resourceType() === 'image') return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#243e51"/><circle cx="490" cy="75" r="140" fill="#34695f"/><path d="M0 360 200 100 440 360" fill="#436c8f"/></svg>' });
    return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="ko"><head><meta charset="utf-8"></head><body style="margin:0;background:#101215;color:#65707c;font-family:sans-serif"><main style="padding:48px"><h1>채널 영상 목록</h1><p>Chzzk Downloader · 검증용 예시 데이터</p></main></body></html>' });
  });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`https://chzzk.naver.com/${channel}/${section}`);
  await page.addScriptTag({ path: path.join(root, 'dash-parser.js') });
  await page.addScriptTag({ path: path.join(root, 'media-resolver.js') });
  await page.evaluate(({ count, error }) => {
    const listeners = [], jobs = new Map();
    window.fixture = { calls: [], pages: [], count, fail: error, jobs, emit(job) { jobs.set(job.id, job); for (const listener of listeners) listener({ type: 'JOB_UPDATED', job }); } };
    window.chrome = { runtime: {
      onMessage: { addListener(fn) { listeners.push(fn); } },
      async sendMessage(message) {
        fixture.calls.push(message);
        if (message.type === 'GET_JOBS') return { jobs: [...jobs.values()] };
        if (message.type.startsWith('DOWNLOAD_')) {
          const job = { ...message, id: `${message.itemKind}-${message.itemId}`, generation: 'fixture', status: 'downloading', createdAt: Date.now(), updatedAt: Date.now(), percent: 0 };
          fixture.emit(job); return { job };
        }
        if (message.type === 'REMOVE_JOB') { jobs.delete(message.jobId); for (const fn of listeners) fn({ type: 'JOB_REMOVED', jobId: message.jobId }); }
        return { ok: true };
      },
    } };
    CdlMedia.fetchJson = async url => {
      const u = new URL(url), page = Number(u.searchParams.get('page')); fixture.pages.push(page);
      if (fixture.fail) throw new Error('HTTP 503');
      const clip = u.pathname.endsWith('/clips');
      return { content: { data: Array.from({ length: Math.min(24, Math.max(0, fixture.count - page * 24)) }, (_, offset) => {
        const index = page * 24 + offset;
        return { videoNo: 100000 - index, clipUID: `clip-${100000 - index}`,
          videoTitle: index === 0 ? '오늘의 "하이라이트" <img src=x onerror=alert(1)> & 이야기' : ['주말 게임 방송 — 새로운 모험을 시작합니다', '시청자와 함께하는 즐거운 하루', '다시 보고 싶은 순간들'][index % 3] + ` · ${index + 1}`,
          thumbnailImageUrl: `https://fixture.pstatic.net/thumb-${index}.svg`, duration: clip ? 59 : 13665, readCount: 27501 - index, publishDate: new Date(Date.UTC(2026, 8, 20) - index * 86400000).toISOString() };
      }) } };
    };
    CdlMedia.resolveVodUrl = CdlMedia.resolveClipUrl = async () => ({ type: 'mp4', url: 'https://fixture.pstatic.net/video.mp4' });
  }, { count, error });
  await page.addStyleTag({ path: path.join(root, 'content.css') });
  await page.addScriptTag({ path: path.join(root, 'content.js') });
  await page.locator('#chzzk-dl-toggle').click();
  await page.waitForFunction(() => !document.getElementById('cdl-item-count').textContent.includes('불러오는 중'));
  return { page, context, errors };
}

test('first page is visible without scanning all pages; titles remain literal and progress preserves unrelated cards', async () => {
  const { page, context, errors } = await mount();
  try {
    await page.locator('.cdl-card').first().waitFor();
    assert.deepEqual(await page.evaluate(() => fixture.pages), [0]);
    assert.equal(await page.locator('#cdl-item-count').innerText(), '24개');
    assert.match(await page.locator('.cdl-card-title').first().innerText(), /"하이라이트" <img/);
    assert.equal(await page.locator('.cdl-card-title img').count(), 0);
    await page.evaluate(() => { window.otherCard = document.querySelectorAll('.cdl-card')[1]; });
    await page.locator('.cdl-card').first().getByRole('button').click();
    await page.waitForFunction(() => fixture.calls.some(call => call.type === 'DOWNLOAD_DIRECT'), null, { timeout: 3000 }).catch(async error => { console.error(await page.evaluate(() => ({ calls: fixture.calls, feedback: document.getElementById('cdl-feedback').textContent, jobs: [...fixture.jobs.values()] })), errors); throw error; });
    const request = await page.evaluate(() => fixture.calls.find(call => call.type === 'DOWNLOAD_DIRECT'));
    assert.equal(request.title, '오늘의 "하이라이트" <img src=x onerror=alert(1)> & 이야기');
    await page.evaluate(() => { const job = [...fixture.jobs.values()][0]; fixture.emit({ ...job, percent: 51, updatedAt: Date.now() + 100 }); });
    await page.waitForFunction(() => document.querySelector('.cdl-card-status').textContent === '51%');
    assert.equal(await page.evaluate(() => otherCard === document.querySelectorAll('.cdl-card')[1]), true);
    await page.locator('.cdl-card-title').first().evaluate(node => { node.textContent = '오늘의 \"하이라이트\" & 이야기'; });
    await page.locator('#cdl-shell').screenshot({ path: path.join(output, 'ui-vod.png') });
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('2,400 catalog entries keep a bounded DOM and remain searchable at the end', async () => {
  const { page, context } = await mount({ count: 2400 });
  try {
    // Start the real bulk-load handler without scrolling through all pages.
    await page.locator('#cdl-load-all').evaluate(node => node.click());
    await page.waitForFunction(() => document.getElementById('cdl-item-count').textContent === '2400개' && document.getElementById('cdl-sort-hint').hidden, { timeout: 30000 });
    assert.ok(await page.locator('.cdl-card').count() < 20);
    await page.locator('#cdl-content').evaluate(node => { node.scrollTop = node.scrollHeight; });
    await page.waitForFunction(() => [...document.querySelectorAll('.cdl-card-title')].some(node => node.textContent.endsWith('· 2400')));
    assert.ok(await page.locator('.cdl-card').count() < 20);
    await page.locator('#cdl-search').fill('· 2400');
    await page.waitForFunction(() => document.querySelectorAll('.cdl-card').length === 1);
    assert.match(await page.locator('#cdl-item-count').innerText(), /^1개 검색됨 \/ 2400개$/);
  } finally { await context.close(); }
});

test('download states show correct actions, speed and remaining time; keyboard navigation works', async () => {
  const { page, context } = await mount();
  try {
    await page.evaluate(() => {
      const shared = { itemKind: 'video', generation: 'fixture', createdAt: Date.now(), updatedAt: Date.now() };
      fixture.emit({ ...shared, id: 'video-active', title: '주말 방송 전체 다시보기', status: 'downloading', message: '영상 데이터를 받는 중', percent: 42, bytesReceived: 2.1 * 1024 ** 3, totalBytes: 5 * 1024 ** 3, speedBps: 18 * 1024 ** 2, etaSeconds: 168 });
      fixture.emit({ ...shared, id: 'video-paused', title: '어제의 긴 방송 · 중지한 작업', status: 'paused', message: '중지됨 · 받은 구간에서 이어받을 수 있습니다.', resumable: true, bytesReceived: 1.2 * 1024 ** 3 });
      fixture.emit({ ...shared, id: 'clip-done', title: '다시 보고 싶은 하이라이트', status: 'done', message: '파일 저장 완료', totalBytes: 48 * 1024 ** 2, bytesReceived: 48 * 1024 ** 2 });
    });
    await page.locator('#cdl-browse-tab').focus(); await page.keyboard.press('ArrowRight');
    await page.getByRole('button', { name: '이어받기', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '중지', exact: true }).count(), 1);
    assert.equal(await page.getByRole('button', { name: '이어받기', exact: true }).count(), 1);
    assert.equal(await page.getByRole('button', { name: '파일 보기', exact: true }).count(), 1);
    assert.match(await page.locator('.cdl-job-metrics').first().innerText(), /18.0 MiB\/s.*3분/);
    await page.locator('#cdl-shell').screenshot({ path: path.join(output, 'ui-downloads.png') });
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#cdl-shell').isHidden(), true);
    assert.equal(await page.locator('#chzzk-dl-toggle').evaluate(node => node === document.activeElement), true);
  } finally { await context.close(); }
});

test('clip grid and small viewports stay inside the viewport with usable controls', async () => {
  const { page, context } = await mount({ section: 'clips' });
  try {
    await page.locator('.cdl-clips .cdl-card').first().waitFor();
    const a = await page.locator('.cdl-card').nth(0).boundingBox(), b = await page.locator('.cdl-card').nth(1).boundingBox();
    assert.equal(a.y, b.y); assert.ok(b.x > a.x);
    await page.locator('.cdl-card-title').first().evaluate(node => { node.textContent = '오늘의 하이라이트 & 이야기'; });
    await page.locator('#cdl-shell').screenshot({ path: path.join(output, 'ui-clips.png') });
    for (const viewport of [{ width: 400, height: 600 }, { width: 683, height: 384 }]) {
      await page.setViewportSize(viewport);
      const box = await page.locator('#cdl-shell').boundingBox();
      assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height);
      const sizes = await page.locator('#cdl-shell').evaluate(node => ({ width: node.clientWidth, scroll: node.scrollWidth, padding: getComputedStyle(node.querySelector('.cdl-header')).paddingTop }));
      assert.ok(sizes.scroll <= sizes.width); assert.notEqual(sizes.padding, '0px');
      if (viewport.width === 400) await page.screenshot({ path: path.join(output, 'ui-small.png') });
    }
  } finally { await context.close(); }
});

test('empty and failed catalog responses are distinct and route query changes trigger a fresh load', async () => {
  const { page, context } = await mount({ count: 0 });
  try {
    assert.equal(await page.locator('#cdl-empty').innerText(), '표시할 영상이 없습니다.');
    await page.evaluate(() => { fixture.fail = true; history.pushState({}, '', '?videoType=REPLAY'); dispatchEvent(new PopStateEvent('popstate')); });
    await page.waitForFunction(() => document.getElementById('cdl-empty').textContent.includes('HTTP 503'));
    assert.equal(await page.evaluate(() => fixture.pages.length), 2);
    await page.evaluate(() => { history.pushState({}, '', location.pathname.replace('/videos', '/live')); dispatchEvent(new PopStateEvent('popstate')); });
    assert.equal(await page.locator('#chzzk-dl-panel').isHidden(), true);
  } finally { await context.close(); }
});

test('DASH resolves BaseURL, padded Number, Time/Bandwidth and bounded repeats; unsupported streams fail clearly', async () => {
  const page = await browser.newPage();
  try {
    await page.addScriptTag({ path: path.join(root, 'dash-parser.js') });
    const parse = xml => page.evaluate(xml => CdlDash.parse(xml, 'https://vod.pstatic.net/root/manifest.mpd'), xml);
    assert.equal((await parse('<MPD><Period><AdaptationSet><Representation bandwidth="3"><BaseURL>../video.mp4</BaseURL></Representation></AdaptationSet></Period></MPD>')).url, 'https://vod.pstatic.net/video.mp4');
    const plan = await parse('<MPD mediaPresentationDuration="PT6S"><BaseURL>media/</BaseURL><Period><AdaptationSet><SegmentTemplate timescale="10" initialization="init-$RepresentationID$.mp4" media="$Bandwidth$-$Time$-$Number%03d$.m4s" startNumber="4"><SegmentTimeline><S t="0" d="20" r="-1"/></SegmentTimeline></SegmentTemplate><Representation id="hi" bandwidth="800"/></AdaptationSet></Period></MPD>');
    assert.deepEqual(plan.segments, ['init-hi.mp4', '800-0-004.m4s', '800-20-005.m4s', '800-40-006.m4s'].map(part => 'https://vod.pstatic.net/root/media/' + part));
    for (const [xml, error] of [
      ['<MPD><Period/><Period/></MPD>', '여러 타임라인'],
      ['<MPD><Period><AdaptationSet><Representation mimeType="audio/mp4"><BaseURL>a.mp4</BaseURL></Representation></AdaptationSet><AdaptationSet><Representation><BaseURL>v.mp4</BaseURL></Representation></AdaptationSet></Period></MPD>', '별도 오디오'],
      ['<MPD xmlns:d="urn:mpeg:dash:schema:mpd:2011"><Period><d:ContentProtection/></Period></MPD>', '보호된'],
      ['<MPD><Period><ContentProtection/></Period></MPD>', '보호된'],
      ['<MPD mediaPresentationDuration="PT2S"><Period><AdaptationSet contentType="audio"/><AdaptationSet><Representation><SegmentTemplate duration="1" initialization="i" media="$Number$"/></Representation></AdaptationSet></Period></MPD>', '별도 오디오'],
      ['<MPD mediaPresentationDuration="PT999999S"><Period><AdaptationSet><Representation><SegmentTemplate duration="1" initialization="i" media="$Number$"/></Representation></AdaptationSet></Period></MPD>', '길이'],
    ]) await assert.rejects(parse(xml), new RegExp(error));
  } finally { await page.close(); }
});
