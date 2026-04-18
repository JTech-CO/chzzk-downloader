// Chzzk Downloader v2.1 - Background Script (MP4, HLS, DASH)
const active = new Map();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  if (msg.type === 'DOWNLOAD_DIRECT') {
    const fn = sanitize(msg.filename) + (msg.ext || '.mp4');
    chrome.downloads.download({ url: msg.url, filename: fn }, id => {
      sendResponse(chrome.runtime.lastError ? { error: chrome.runtime.lastError.message } : { status: 'started', downloadId: id });
    });
    return true;
  }

  if (msg.type === 'DOWNLOAD_HLS') {
    hlsDownload(msg.hlsUrl, msg.title, msg.itemId, tabId).then(sendResponse).catch(e => sendResponse({ error: e.message }));
    return true;
  }

  if (msg.type === 'DOWNLOAD_SEGMENTS') {
    segmentDownload(msg.segments, msg.title, msg.itemId, tabId).then(sendResponse).catch(e => sendResponse({ error: e.message }));
    return true;
  }

  if (msg.type === 'CANCEL_DOWNLOAD') {
    const c = active.get(msg.itemId); if (c) c.abort(); active.delete(msg.itemId);
    sendResponse({ ok: true });
  }
});

// DASH Segment Parallel Download (6 concurrent)
async function segmentDownload(segments, title, itemId, tabId) {
  const ac = new AbortController();
  active.set(itemId, ac);
  try {
    if (!segments || segments.length === 0) throw new Error('세그먼트 없음');

    prog(tabId, itemId, 'downloading', `0/${segments.length}`, 0);

    const CONCURRENT = 6;
    const chunks = [];
    let done = 0;

    for (let i = 0; i < segments.length; i += CONCURRENT) {
      if (ac.signal.aborted) throw new Error('취소됨');
      const batch = segments.slice(i, i + CONCURRENT);
      const results = await Promise.all(
        batch.map(url =>
          fetch(url, { signal: ac.signal })
            .then(r => {
              if (!r.ok) throw new Error(`${r.status} ${url.slice(-30)}`);
              return r.arrayBuffer();
            })
        )
      );
      chunks.push(...results);
      done += results.length;
      const pct = Math.round(done / segments.length * 100);
      prog(tabId, itemId, 'downloading', `${done}/${segments.length} (${pct}%)`, pct);
    }

    prog(tabId, itemId, 'merging', '파일 병합 중...');
    const blob = new Blob(chunks, { type: 'video/mp4' });
    const url = URL.createObjectURL(blob);
    chrome.downloads.download({ url, filename: sanitize(title) + '.mp4' }, () => {
      setTimeout(() => URL.revokeObjectURL(url), 120000);
    });
    prog(tabId, itemId, 'done', '다운로드 시작됨');
    return { status: 'started' };
  } catch (e) {
    prog(tabId, itemId, 'error', e.message);
    throw e;
  } finally {
    active.delete(itemId);
  }
}

// HLS Parser & Download
async function hlsDownload(masterUrl, title, itemId, tabId) {
  const ac = new AbortController();
  active.set(itemId, ac);
  try {
    prog(tabId, itemId, 'info', 'HLS 분석 중...');
    const master = await fetch(masterUrl, { signal: ac.signal }).then(r => { if (!r.ok) throw new Error(`${r.status}`); return r.text(); });

    let plUrl = masterUrl;
    if (master.includes('#EXT-X-STREAM-INF')) {
      let best = 0;
      const lines = master.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
          const bw = parseInt((lines[i].match(/BANDWIDTH=(\d+)/) || [])[1] || '0');
          const next = lines[i + 1]?.trim();
          if (bw > best && next && !next.startsWith('#')) { best = bw; plUrl = resolve(masterUrl, next); }
        }
      }
    }

    const media = master.includes('#EXTINF') ? master : await fetch(plUrl, { signal: ac.signal }).then(r => r.text());
    const segs = media.split('\n').filter(l => l.trim() && !l.trim().startsWith('#')).map(l => resolve(plUrl, l.trim()));
    if (!segs.length) throw new Error('HLS 세그먼트 없음');

    return segmentDownload(segs, title, itemId, tabId);
  } catch (e) {
    prog(tabId, itemId, 'error', e.message);
    throw e;
  } finally {
    active.delete(itemId);
  }
}

function resolve(base, rel) { if (rel.startsWith('http')) return rel; try { return new URL(rel, base).href; } catch { return base.replace(/[^/]+$/, '') + rel; } }
function sanitize(n) {
  const name = (n || 'chzzk')
    .replace(/[\x00-\x1f\x7f]/g, '')      // 제어 문자 제거
    .replace(/[\\/:*?"<>|]/g, '')          // Windows 금지 특수문자 제거
    .replace(/\s+/g, ' ')                  // 연속 공백 단일화
    .trim()                                // 앞뒤 공백 제거
    .replace(/^\.+|\.+$/g, '')            // 앞뒤 점(.) 제거
    .slice(0, 200);                        // 최대 200자
  return name || 'chzzk';                 // 모두 제거된 경우 기본값
}
function prog(tabId, id, status, message, percent) {
  if (!tabId) return;
  chrome.tabs.sendMessage(tabId, { type: 'DOWNLOAD_PROGRESS', downloadId: String(id), status, message, percent: percent ?? null }).catch(() => {});
}
