'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');
const { harness } = require('./helpers');
const root = path.resolve(__dirname, '..');
let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });

async function mount({ archived = false, mode = 'legacy' } = {}) {
  const legacy = harness({ entry: 'legacy/v2.2.6/background.js' });
  legacy.fetch(async () => new Response(Uint8Array.of(1, 2, 3, 4), { status: 200 }));
  const context = await browser.newContext();
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }));
  const page = await context.newPage(), calls = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.exposeFunction('runtimeBridge', message => {
    calls.push(message);
    if (['ack-without-job', 'save-error'].includes(mode) && message.type === 'GET_JOBS') return { jobs: [] };
    if (mode === 'save-error' && message.type.startsWith('DOWNLOAD_')) return { error: '파일을 저장할 수 없습니다.' };
    return new Promise(resolve => legacy.listeners[0](message, { id: legacy.chrome.runtime.id, tab: { id: 1, url: `https://chzzk.naver.com/${'a'.repeat(32)}/clips` } }, resolve));
  });
  await page.goto(`https://chzzk.naver.com/${'a'.repeat(32)}/clips`);
  const source = archived ? path.join(root, 'legacy/v2.3.0') : path.join(root, 'src');
  await page.addScriptTag({ path: path.join(source, 'dash-parser.js') });
  await page.addScriptTag({ path: path.join(source, 'media-resolver.js') });
  await page.evaluate(() => {
    window.chrome = { runtime: { getManifest: () => ({ version: '2.3.2' }), onMessage: { addListener() {} }, sendMessage: message => runtimeBridge(message) } };
    CdlMedia.fetchJson = async () => ({ content: { data: [{ clipUID: 'test-clip', clipTitle: '정상 저장되는 클립' }] } });
    CdlMedia.resolveClipUrl = async () => ({ type: 'mp4', url: 'https://vod.pstatic.net/fixture.mp4' });
  });
  await page.addStyleTag({ path: path.join(source, 'content.css') });
  await page.addScriptTag({ path: path.join(source, 'content.js') });
  await page.locator('#chzzk-dl-toggle').click();
  await page.locator('.cdl-card').first().waitFor();
  return { page, context, legacy, calls, errors };
}

test('reproduction: v2.3.0 UI with v2.2.6 backend starts a download but shows an error', async () => {
  const { page, context, legacy, calls, errors } = await mount({ archived: true });
  try {
    await page.locator('.cdl-card button').click();
    await page.locator('#cdl-jobs-tab').click();
    await page.locator('.cdl-job[data-status="error"]').waitFor();
    assert.equal(legacy.downloads.size, 1);
    assert.match(await page.locator('.cdl-job-message').innerText(), /Cannot read properties of undefined/);
    await page.locator('#cdl-log-toggle').click();
    assert.match(await page.locator('#cdl-debug').innerText(), /알 수 없는 메시지 타입입니다/);
    assert.ok(calls.some(message => message.type === 'GET_JOBS'));
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('legacy backend is identified once before downloads, without repeated polling or failed job records', async () => {
  const { page, context, legacy, calls, errors } = await mount();
  try {
    await page.locator('#cdl-connection').waitFor({ state: 'visible' });
    assert.match(await page.locator('#cdl-connection').innerText(), /확장 프로그램.*새로고침/);
    assert.equal(await page.locator('.cdl-card button').isDisabled(), true);
    const count = calls.filter(message => message.type === 'GET_JOBS').length;
    await page.locator('#cdl-close').click(); await page.locator('#chzzk-dl-toggle').click();
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.locator('#cdl-log-toggle').click();
    assert.equal(calls.filter(message => message.type === 'GET_JOBS').length, count);
    assert.equal((await page.locator('#cdl-debug').innerText()).match(/\[설치 확인\]/g)?.length, 1);
    assert.equal(legacy.downloads.size, 0);
    await page.locator('#cdl-jobs-tab').click();
    assert.equal(await page.locator('.cdl-job[data-status="error"]').count(), 0);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('a legacy started acknowledgement is displayed as unconfirmed, never as failed or complete', async () => {
  const { page, context, legacy, errors } = await mount({ mode: 'ack-without-job' });
  try {
    await page.locator('.cdl-card button').click();
    await page.locator('#cdl-jobs-tab').click();
    await page.locator('.cdl-job[data-status="unconfirmed"]').waitFor();
    assert.equal(legacy.downloads.size, 1);
    assert.match(await page.locator('.cdl-job-message').innerText(), /브라우저 다운로드 목록/);
    assert.equal(await page.locator('.cdl-job[data-status="error"],.cdl-job[data-status="done"]').count(), 0);
    assert.equal(await page.getByRole('button', { name: '다시 시도', exact: true }).count(), 0);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('an explicit download failure is still reported as an error', async () => {
  const { page, context, errors } = await mount({ mode: 'save-error' });
  try {
    await page.locator('.cdl-card button').click(); await page.locator('#cdl-jobs-tab').click();
    await page.locator('.cdl-job[data-status="error"]').waitFor();
    assert.equal(await page.locator('.cdl-job-message').innerText(), '파일을 저장할 수 없습니다.');
    assert.equal(await page.locator('#cdl-connection').isHidden(), true);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});
