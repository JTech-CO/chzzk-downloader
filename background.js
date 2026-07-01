// Chzzk Downloader v2.2.3 - Background Script (MP4, HLS, DASH, OPFS streaming)
const active = new Map();

// 동적 우회 규칙 설정 (백그라운드 통신에만 국한시켜 content.js CORS 방해 원천 차단)
chrome.runtime.onInstalled.addListener(() => {
  chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [1],
    addRules: [
      {
        id: 1,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'Referer', operation: 'set', value: 'https://chzzk.naver.com/' },
            { header: 'Origin', operation: 'set', value: 'https://chzzk.naver.com' }
          ]
        },
        condition: {
          initiatorDomains: [chrome.runtime.id]
        }
      }
    ]
  });
});

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
    hlsDownload(msg.masterText, msg.hlsUrl, msg.title, msg.itemId, tabId).then(sendResponse).catch(e => sendResponse({ error: e.message }));
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

const CONCURRENT = 8;            // 동시 워커 수. CDN이 클라이언트당 ~5 req/s로 제한 → 더 올려도 무의미(측정 확인),
                                //  과도하면 연결 거부. 8이면 레이트 캡을 채우고도 남음.
const STREAM_THRESHOLD = 800;   // 세그먼트가 이 개수를 넘으면 OPFS 디스크 스트리밍(메모리 폭증 방지)

function opfsAvailable() {
  return typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.getDirectory === 'function';
}

// 세그먼트 다운로드 라우터
// - 큰 영상(> STREAM_THRESHOLD) + OPFS 지원: 디스크 스트리밍(메모리 고정)
// - 그 외: 기존 검증된 메모리 경로
// creds: DASH(클립)는 'include'(기존), 라이브 다시보기 HLS는 'omit'(URL 토큰 인증)
async function segmentDownload(segments, title, itemId, tabId, creds = 'include') {
  const ac = new AbortController();
  active.set(itemId, ac);
  try {
    if (!segments || segments.length === 0) throw new Error('세그먼트 없음');

    if (segments.length > STREAM_THRESHOLD && opfsAvailable()) {
      let stream = null;
      try {
        stream = await openOpfsStream(itemId);          // OPFS 준비(setup) 단계
      } catch (e) {
        // setup 실패(미지원/쿼터 등)일 때만 메모리로 폴백 — 이 시점엔 받은 게 없어 재다운로드 안전
        prog(tabId, itemId, 'info', '디스크 스트리밍 불가, 메모리 모드로 진행...');
      }
      if (stream) return await downloadStreaming(segments, title, itemId, tabId, creds, ac, stream);
    }

    return await downloadToMemory(segments, title, itemId, tabId, creds, ac);
  } catch (e) {
    prog(tabId, itemId, 'error', e.message);
    throw e;
  } finally {
    active.delete(itemId);
  }
}

// 세그먼트 1개 fetch — 일시적 실패(429/5xx/네트워크 블립)는 백오프 재시도.
// 수만 개 세그먼트 다운로드에서 1개 실패로 전체가 죽지 않도록 하는 안전장치.
async function fetchSeg(segment, signal, creds, attempts = 4) {
  const url = typeof segment === 'string' ? segment : segment?.url;
  const range = typeof segment === 'string' ? null : segment?.range;
  if (!url) throw new Error('세그먼트 URL 없음');

  let lastErr;
  for (let a = 0; a < attempts; a++) {
    if (signal.aborted) throw new Error('취소됨');
    let r = null;
    try {
      const opt = { signal, credentials: creds };
      if (range) opt.headers = { Range: `bytes=${range}` };
      r = await fetch(url, opt);                              // 네트워크 오류만 여기서 catch
    } catch (e) {
      if (signal.aborted || e.name === 'AbortError') throw new Error('취소됨');
      lastErr = e;                                            // 네트워크 블립 → 재시도
    }
    if (r) {
      if (r.ok) return await r.arrayBuffer();
      // 영구 오류(429/5xx 제외)는 try 밖이라 즉시 전파 — 재시도 안 함
      if (r.status !== 429 && r.status < 500) throw new Error(`HTTP ${r.status} ${url.slice(-30)}`);
      lastErr = new Error(`HTTP ${r.status}`);                // 429/5xx → 재시도
    }
    if (a < attempts - 1) await new Promise(res => setTimeout(res, 500 * (a + 1))); // 0.5s,1s,1.5s 백오프
  }
  throw new Error(`세그먼트 ${attempts}회 실패: ${lastErr?.message || ''} ${url.slice(-30)}`);
}

// 공통 워커 풀 (슬라이딩 윈도우: 배치 배리어 없이 항상 CONCURRENT개 유지)
// onChunk(i, arrayBuffer)는 세그먼트 1개 완료 시 호출. waitBeforeFetch(i)로 백프레셔 가능.
async function runWorkerPool(segments, creds, ac, onChunk, waitBeforeFetch) {
  const total = segments.length;
  let next = 0;
  async function worker() {
    while (next < total) {
      if (ac.signal.aborted) throw new Error('취소됨');
      const i = next++;
      if (waitBeforeFetch) await waitBeforeFetch(i);
      const buf = await fetchSeg(segments[i], ac.signal, creds);
      await onChunk(i, buf);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENT, total) }, () =>
      worker().catch(e => { ac.abort(); throw e; })
    )
  );
}

// 메모리 경로 — 모든 청크를 모아 한 번에 Blob 병합 (짧은 영상용)
async function downloadToMemory(segments, title, itemId, tabId, creds, ac) {
  const total = segments.length;
  const chunks = new Array(total);                     // 인덱스로 순서 보존
  const step = Math.max(1, Math.floor(total / 200));
  const t0 = Date.now();
  let done = 0;

  prog(tabId, itemId, 'downloading', `0/${total}`, 0);
  await runWorkerPool(segments, creds, ac, (i, buf) => {
    chunks[i] = buf;
    done++;
    if (done % step === 0 || done === total) {
      const pct = Math.round(done / total * 100);
      prog(tabId, itemId, 'downloading', `${done}/${total} (${pct}%)`, pct);
      if (done % (step * 20) === 0 || done === total) {
        const sec = (Date.now() - t0) / 1000;
        dlog(tabId, `[mem] ${done}/${total} +${sec.toFixed(0)}s (${(done / sec).toFixed(1)} seg/s)`);
      }
    }
  });

  prog(tabId, itemId, 'merging', '파일 병합 중...');
  const blob = new Blob(chunks, { type: 'video/mp4' });
  await deliverDownload(title, { blob }, tabId, itemId);
  prog(tabId, itemId, 'done', '다운로드 시작됨');
  return { status: 'started' };
}

async function openOpfsStream(itemId) {
  const root = await navigator.storage.getDirectory();
  const name = `cdl_${String(itemId).replace(/[^a-zA-Z0-9_-]/g, '')}_${Date.now()}.mp4`;
  const fh = await root.getFileHandle(name, { create: true });
  const writable = await fh.createWritable();          // 디스크 임시파일에 기록(메모리 X), close 시 확정
  return { root, name, fh, writable };
}

// 디스크 스트리밍 경로 — 재정렬 버퍼로 순서를 맞추며 OPFS에 순차 기록 (메모리 고정)
async function downloadStreaming(segments, title, itemId, tabId, creds, ac, stream) {
  const { root, name, fh, writable } = stream;
  const total = segments.length;
  const step = Math.max(1, Math.floor(total / 200));
  const MAX_AHEAD = 32;                                // 기록 프런티어보다 최대 32개까지만 선행 → 메모리 ~64MB
  const buffer = new Map();                            // index -> ArrayBuffer (다운로드 완료, 기록 대기)
  const waiters = [];
  const t0 = Date.now();
  let writeIndex = 0, writing = false, writeMs = 0;    // writeMs: 디스크 쓰기에 든 누적 시간(병목 판별용)

  const wakeAll = () => { const ws = waiters.splice(0); for (const r of ws) r(); };
  const waitForSpace = async (i) => {
    while (i >= writeIndex + MAX_AHEAD && !ac.signal.aborted) {
      await new Promise(res => waiters.push(res));
    }
  };
  // 기록은 항상 1개씩 직렬로(writing 플래그). writeIndex부터 연속으로 모인 만큼 디스크에 흘려보낸다.
  const flush = async () => {
    if (writing) return;
    writing = true;
    try {
      while (buffer.has(writeIndex)) {
        const buf = buffer.get(writeIndex);
        buffer.delete(writeIndex);
        const tw = Date.now();
        await writable.write(buf);
        writeMs += Date.now() - tw;
        writeIndex++;
        if (writeIndex % step === 0 || writeIndex === total) {
          const pct = Math.round(writeIndex / total * 100);
          prog(tabId, itemId, 'downloading', `${writeIndex}/${total} (${pct}%)`, pct);
        }
        if (writeIndex === 10 || writeIndex % (step * 5) === 0 || writeIndex === total) {
          const sec = (Date.now() - t0) / 1000;
          dlog(tabId, `[stream] ${writeIndex}/${total} +${sec.toFixed(0)}s (${(writeIndex / sec).toFixed(1)} seg/s, write누적 ${(writeMs / 1000).toFixed(1)}s)`);
        }
        wakeAll();                                     // 공간 확보 → 대기 중인 워커 깨움
      }
    } finally {
      writing = false;
    }
  };

  prog(tabId, itemId, 'downloading', `0/${total}`, 0);
  try {
    await runWorkerPool(
      segments, creds, ac,
      async (i, buf) => { buffer.set(i, buf); await flush(); },
      waitForSpace
    );
    await flush();                                     // 잔여분 기록
    await writable.close();
  } catch (e) {
    wakeAll();                                         // 대기 워커 해제
    try { await writable.abort(); } catch (_) {}
    try { await root.removeEntry(name); } catch (_) {}
    throw e;
  }

  // 디스크 파일을 그대로 다운로드에 전달 (메모리로 다시 안 올림)
  prog(tabId, itemId, 'merging', '파일 저장 중...');
  await deliverDownload(title, { root, name, fh }, tabId, itemId);
  prog(tabId, itemId, 'done', '다운로드 시작됨');
  return { status: 'started' };
}

// ---- 완성 파일 전달 (chrome.downloads) ----
// MV3 서비스워커 일부 환경은 URL.createObjectURL이 없어("URL.createObjectURL is not a function")
// blob URL을 만들 수 없다. 이 경우 offscreen 문서(DOM 컨텍스트)에서 URL을 생성해 우회한다.
function canCreateObjectUrlInSW() {
  return typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function';
}

async function deliverDownload(title, src, tabId, itemId) {
  const filename = sanitize(title) + '.mp4';

  // 1) SW에서 createObjectURL이 되는 환경 → 기존 경로 그대로
  if (canCreateObjectUrlInSW()) {
    let url, cleanup;
    if (src.blob) {
      url = URL.createObjectURL(src.blob);
      cleanup = () => { try { URL.revokeObjectURL(url); } catch (_) {} };
    } else {
      const file = await src.fh.getFile();
      url = URL.createObjectURL(file);
      cleanup = () => { try { URL.revokeObjectURL(url); } catch (_) {} src.root.removeEntry(src.name).catch(() => {}); };
    }
    downloadAndCleanup(url, filename, cleanup);
    return;
  }

  // 2) createObjectURL 미지원 → offscreen 경유 (반드시 OPFS 파일 필요)
  let root = src.root, name = src.name;
  if (src.blob) {
    // 메모리 Blob은 offscreen이 못 받으므로 OPFS에 먼저 기록
    root = await navigator.storage.getDirectory();
    name = `cdl_dl_${String(itemId).replace(/[^a-zA-Z0-9_-]/g, '')}_${Date.now()}.mp4`;
    const fh = await root.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(src.blob);
    await w.close();
  }
  const url = await offscreenCreateUrl(name);
  const cleanup = () => { offscreenRevokeUrl(url); if (root) root.removeEntry(name).catch(() => {}); };
  downloadAndCleanup(url, filename, cleanup);
}

function downloadAndCleanup(url, filename, cleanup) {
  chrome.downloads.download({ url, filename }, (id) => {
    if (chrome.runtime.lastError || id === undefined) { cleanup(); return; }
    const onChanged = (delta) => {
      if (delta.id !== id || !delta.state) return;
      const s = delta.state.current;
      if (s === 'complete' || s === 'interrupted') {
        chrome.downloads.onChanged.removeListener(onChanged);
        cleanup();                                     // 복사 완료/중단 후에만 정리
      }
    };
    chrome.downloads.onChanged.addListener(onChanged);
  });
}

async function ensureOffscreen() {
  if (!chrome.offscreen) throw new Error('이 브라우저는 offscreen 미지원 (크롬/웨일 업데이트 필요)');
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['BLOBS'],
      justification: '대용량 영상 파일 저장을 위한 blob URL 생성',
    });
  } catch (_) { /* 이미 생성됨 → 무시 */ }
}

async function offscreenCreateUrl(name) {
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'OFFSCREEN_CREATE_URL', name });
  if (!res || res.error || !res.url) throw new Error('offscreen URL 생성 실패: ' + (res && res.error ? res.error : '응답 없음'));
  return res.url;
}

function offscreenRevokeUrl(url) {
  chrome.runtime.sendMessage({ target: 'offscreen', type: 'OFFSCREEN_REVOKE_URL', url }).catch(() => {});
}

// HLS Parser & Download
async function hlsDownload(masterText, masterUrl, title, itemId, tabId) {
  const ac = new AbortController();
  active.set(itemId, ac);
  // 라이브 다시보기 HLS는 URL의 hdnts/hdntl 토큰으로 인증된다. 쿠키가 필요 없을 뿐 아니라,
  // CDN이 ACAO:* 로 응답하므로 credentials:'include'로 쿠키를 동봉하면 자격증명 CORS 규칙
  // 위반으로 'Failed to fetch'가 난다. 따라서 omit으로 토큰만 사용한다.
  const creds = 'omit';
  const t0 = Date.now();
  try {
    prog(tabId, itemId, 'info', 'HLS 분석 중...');
    dlog(tabId, `HLS 분석 시작 (master ${masterText ? '내장' : 'fetch'})`);

    let master = masterText;
    if (!master) {
      master = await fetch(masterUrl, { signal: ac.signal, credentials: creds }).then(r => { if (!r.ok) throw new Error(`${r.status}`); return r.text(); });
    }
    dlog(tabId, `master 확보 +${Date.now() - t0}ms (len=${master.length})`);

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

    const media = master.includes('#EXTINF') ? master : await fetch(plUrl, { signal: ac.signal, credentials: creds }).then(r => { if (!r.ok) throw new Error(`${r.status}`); return r.text(); });
    dlog(tabId, `variant playlist 확보 +${Date.now() - t0}ms (len=${media.length})`);
    const parsed = parseHlsMediaPlaylist(media, plUrl);
    const segs = parsed.segments;
    if (!segs.length) throw new Error('HLS 세그먼트 없음');
    dlog(tabId, `세그먼트 파싱 완료 +${Date.now() - t0}ms (${segs.length}개, init=${parsed.initCount}개) → 다운로드 시작`);

    return segmentDownload(segs, title, itemId, tabId, creds);
  } catch (e) {
    prog(tabId, itemId, 'error', e.message);
    throw e;
  } finally {
    active.delete(itemId);
  }
}

function parseHlsMediaPlaylist(text, playlistUrl) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const segments = [];
  const seenMaps = new Set();
  const byteRangeEnds = new Map();
  let pendingByteRange = null;
  let initCount = 0;

  for (const line of lines) {
    const upper = line.toUpperCase();

    if (upper.startsWith('#EXT-X-MAP:')) {
      const attrs = parseHlsAttrs(line);
      if (!attrs.URI) continue;
      const entry = makeHlsEntry(resolve(playlistUrl, attrs.URI), attrs.BYTERANGE, byteRangeEnds);
      const key = hlsEntryKey(entry);
      if (!seenMaps.has(key)) {
        segments.push(entry);
        seenMaps.add(key);
        initCount++;
      }
      continue;
    }

    if (upper.startsWith('#EXT-X-BYTERANGE:')) {
      pendingByteRange = line.slice(line.indexOf(':') + 1).trim();
      continue;
    }

    if (line.startsWith('#')) continue;

    const url = resolve(playlistUrl, line);
    segments.push(makeHlsEntry(url, pendingByteRange, byteRangeEnds));
    pendingByteRange = null;
  }

  return { segments, initCount };
}

function parseHlsAttrs(line) {
  const body = line.includes(':') ? line.slice(line.indexOf(':') + 1) : line;
  const attrs = {};
  body.replace(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/gi, (_, key, value) => {
    attrs[key.toUpperCase()] = value.startsWith('"') && value.endsWith('"')
      ? value.slice(1, -1)
      : value;
    return '';
  });
  return attrs;
}

function makeHlsEntry(url, byteRange, byteRangeEnds) {
  const range = parseHlsByteRange(byteRange, byteRangeEnds.get(url));
  if (!range) return url;
  byteRangeEnds.set(url, range.end);
  return { url, range: range.header };
}

function parseHlsByteRange(value, previousEnd) {
  if (!value) return null;
  const [lenRaw, offsetRaw] = value.split('@');
  const length = parseInt(lenRaw, 10);
  if (!Number.isFinite(length) || length <= 0) return null;

  const start = offsetRaw !== undefined
    ? parseInt(offsetRaw, 10)
    : Number.isFinite(previousEnd) ? previousEnd + 1 : 0;
  if (!Number.isFinite(start) || start < 0) return null;

  const end = start + length - 1;
  return { header: `${start}-${end}`, end };
}

function hlsEntryKey(entry) {
  return typeof entry === 'string' ? entry : `${entry.url}#${entry.range || ''}`;
}

function resolve(base, rel) { if (rel.startsWith('http')) return rel; try { return new URL(rel, base).href; } catch { return base.replace(/[^/]+$/, '') + rel; } }
function sanitize(n) {
  const name = (n || 'chzzk')
    .replace(/[\x00-\x1f\x7f]/g, '')      // 제어 문자 제거
    .replace(/[\\/:*?"<>|~#@%&]/g, '')          // Windows 금지 특수문자 제거
    .replace(/\s+/g, ' ')                  // 연속 공백 단일화
    .trim()                                // 앞뒤 공백 제거
    .replace(/^\.+|\.+$/g, '')            // 앞뒤 점(.) 제거
    .slice(0, 200);                        // 최대 200자
  return name || 'chzzk';                 // 모두 제거된 경우 기본값
}
function prog(tabId, id, status, message, percent) {
  if (!tabId) return;
  chrome.tabs.sendMessage(tabId, { type: 'DOWNLOAD_PROGRESS', downloadId: String(id), status, message, percent: percent ?? null }).catch(() => { });
}
// 디버그 로그를 content.js 패널로 전달 (단계별 소요시간 계측용)
function dlog(tabId, msg) {
  if (!tabId) return;
  chrome.tabs.sendMessage(tabId, { type: 'CDL_LOG', msg: '[BG] ' + msg }).catch(() => { });
}

// 시작 시, 이전에 중단(SW 종료 등)된 OPFS 임시파일(cdl_*)을 정리해 디스크 누수 방지
(async () => {
  try {
    if (!opfsAvailable()) return;
    const root = await navigator.storage.getDirectory();
    for await (const [n, h] of root.entries()) {
      if (h.kind === 'file' && n.startsWith('cdl_')) { try { await root.removeEntry(n); } catch (_) {} }
    }
  } catch (_) {}
})();
