// Chzzk Downloader v2.2.5 - Background Script (MP4, HLS, DASH, OPFS streaming)
const active = new Map();

// 동적 우회 규칙 설정 (백그라운드 통신 중 Naver/Pstatic 요청에만 국한)
function installHeaderRules() {
  chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [1, 2],
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
          initiatorDomains: [chrome.runtime.id],
          urlFilter: '||naver.com/',
          resourceTypes: ['xmlhttprequest']
        }
      },
      {
        id: 2,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'Referer', operation: 'set', value: 'https://chzzk.naver.com/' },
            { header: 'Origin', operation: 'set', value: 'https://chzzk.naver.com' }
          ]
        },
        condition: {
          initiatorDomains: [chrome.runtime.id],
          urlFilter: '||pstatic.net/',
          resourceTypes: ['xmlhttprequest']
        }
      }
    ]
  });
}

chrome.runtime.onInstalled.addListener(installHeaderRules);
installHeaderRules();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return false;

  if (!isTrustedContentSender(sender)) {
    sendResponse({ error: '허용되지 않은 메시지 발신자입니다.' });
    return false;
  }

  const tabId = sender.tab?.id;

  if (msg.type === 'DOWNLOAD_DIRECT') {
    let payload;
    try { payload = validateDirectMessage(msg); } catch (e) { sendResponse({ error: e.message }); return false; }
    const fn = sanitize(payload.filename) + '.mp4';
    chrome.downloads.download({ url: payload.url, filename: fn }, id => {
      sendResponse(chrome.runtime.lastError ? { error: chrome.runtime.lastError.message } : { status: 'started', downloadId: id });
    });
    return true;
  }

  if (msg.type === 'DOWNLOAD_HLS') {
    let payload;
    try { payload = validateHlsMessage(msg); } catch (e) { sendResponse({ error: e.message }); return false; }
    hlsDownload(payload.masterText, payload.hlsUrl, payload.title, payload.itemId, tabId).then(sendResponse).catch(e => sendResponse({ error: e.message }));
    return true;
  }

  if (msg.type === 'DOWNLOAD_SEGMENTS') {
    let payload;
    try { payload = validateSegmentsMessage(msg); } catch (e) { sendResponse({ error: e.message }); return false; }
    segmentDownload(payload.segments, payload.title, payload.itemId, tabId).then(sendResponse).catch(e => sendResponse({ error: e.message }));
    return true;
  }

  if (msg.type === 'CANCEL_DOWNLOAD') {
    const itemId = normalizeItemId(msg.itemId);
    const c = active.get(itemId); if (c) c.abort(); active.delete(itemId);
    sendResponse({ ok: true });
    return false;
  }

  sendResponse({ error: '알 수 없는 메시지 타입입니다.' });
  return false;
});

const CONCURRENT = 8;            // 동시 워커 수. CDN이 클라이언트당 ~5 req/s로 제한 → 더 올려도 무의미(측정 확인),
                                //  과도하면 연결 거부. 8이면 레이트 캡을 채우고도 남음.
const STREAM_THRESHOLD = 800;   // 세그먼트가 이 개수를 넘으면 OPFS 디스크 스트리밍(메모리 폭증 방지)
const MAX_SEGMENT_BYTES = 256 * 1024 * 1024; // Range 무시/전체 파일 응답으로 인한 과도한 메모리 사용 방지
const MAX_SEGMENT_COUNT = 120000; // 10~12시간 장시간 VOD는 허용하되 비정상 메시지는 차단
const MAX_PLAYLIST_TEXT = 20 * 1024 * 1024;
const CHZZK_HLS_CDN_HOSTS = new Set([
  'light-slit.akamaized.net',
  'ex-nlive-slitvod-streaming.navercdn.com',
]);

function isTrustedContentSender(sender) {
  if (sender?.id !== chrome.runtime.id) return false;
  try {
    const u = new URL(sender.tab?.url || '');
    return u.origin === 'https://chzzk.naver.com';
  } catch (_) {
    return false;
  }
}

function validateDirectMessage(msg) {
  return {
    url: assertSafeHttpsUrl(msg.url, '다운로드 URL'),
    filename: typeof msg.filename === 'string' ? msg.filename : 'chzzk',
  };
}

function validateHlsMessage(msg) {
  const masterText = msg.masterText == null ? null : String(msg.masterText);
  if (masterText && masterText.length > MAX_PLAYLIST_TEXT) throw new Error('HLS 플레이리스트가 비정상적으로 큽니다.');
  return {
    hlsUrl: assertSafeHttpsUrl(msg.hlsUrl, 'HLS URL'),
    masterText,
    title: typeof msg.title === 'string' ? msg.title : 'chzzk',
    itemId: normalizeItemId(msg.itemId),
  };
}

function validateSegmentsMessage(msg) {
  if (!Array.isArray(msg.segments) || msg.segments.length === 0) throw new Error('세그먼트 목록이 없습니다.');
  if (msg.segments.length > MAX_SEGMENT_COUNT) throw new Error('세그먼트 수가 비정상적으로 많습니다.');
  return {
    segments: msg.segments.map(normalizeSegment),
    title: typeof msg.title === 'string' ? msg.title : 'chzzk',
    itemId: normalizeItemId(msg.itemId),
  };
}

function normalizeSegment(seg) {
  if (typeof seg === 'string') return assertSafeHttpsUrl(seg, '세그먼트 URL');
  if (!seg || typeof seg !== 'object') throw new Error('세그먼트 형식이 올바르지 않습니다.');
  const url = assertSafeHttpsUrl(seg.url, '세그먼트 URL');
  const range = seg.range == null ? null : String(seg.range);
  if (range && !/^\d+-\d+$/.test(range)) throw new Error('세그먼트 Range 형식이 올바르지 않습니다.');
  return range ? { url, range } : url;
}

function normalizeItemId(value) {
  return String(value || 'chzzk').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80) || 'chzzk';
}

function assertSafeHttpsUrl(value, label) {
  let u;
  try {
    u = new URL(String(value || ''));
  } catch (_) {
    throw new Error(`${label} 형식이 올바르지 않습니다.`);
  }

  if (u.protocol !== 'https:') throw new Error(`${label}은 HTTPS만 허용됩니다.`);
  if (isPrivateHost(u.hostname)) throw new Error(`${label}에 로컬/사설망 주소는 허용되지 않습니다.`);
  if (!isAllowedMediaUrl(u)) throw new Error(label + '은 허용된 치지직 미디어 도메인만 사용할 수 있습니다.');
  u.username = '';
  u.password = '';
  return u.href;
}

function isAllowedMediaUrl(url) {
  const h = String(url.hostname || '').toLowerCase().replace(/\.$/, '');
  if (h === 'naver.com' || h.endsWith('.naver.com') || h === 'pstatic.net' || h.endsWith('.pstatic.net')) {
    return true;
  }

  // 치지직 공식 API가 라이브 다시보기 HLS에 사용하는 외부 CDN만 허용한다.
  // Akamai/Navercdn의 다른 콘텐츠를 범용 프록시처럼 가져오지 못하도록 경로도 제한한다.
  return CHZZK_HLS_CDN_HOSTS.has(h) && url.pathname.startsWith('/chzzk/');
}

function isPrivateHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h || h === 'localhost' || h.endsWith('.local')) return true;
  if (h === '::1' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const a = Number(m[1]), b = Number(m[2]);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

function opfsAvailable() {
  return typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.getDirectory === 'function';
}

// 세그먼트 다운로드 라우터
// - 큰 영상(> STREAM_THRESHOLD) + OPFS 지원: 디스크 스트리밍(메모리 고정)
// - 그 외: 기존 검증된 메모리 경로
// creds: DASH(클립)는 'include'(기존), 라이브 다시보기 HLS는 'omit'(URL 토큰 인증)
async function segmentDownload(segments, title, itemId, tabId, creds = 'include', existingController = null, finalizer = null) {
  itemId = normalizeItemId(itemId);
  if (!existingController && active.has(itemId)) throw new Error('이미 진행 중인 다운로드입니다.');

  const ac = existingController || new AbortController();
  active.set(itemId, ac);
  try {
    if (!segments || segments.length === 0) throw new Error('세그먼트 없음');
    validateSegmentPlan(segments);

    if (segments.length > STREAM_THRESHOLD) {
      if (!opfsAvailable()) {
        throw new Error('대용량 영상은 안전한 디스크 스트리밍(OPFS)이 필요합니다. 브라우저를 최신 버전으로 업데이트해 주세요.');
      }
      let stream = null;
      try {
        stream = await openOpfsStream(itemId);          // OPFS 준비(setup) 단계
      } catch (e) {
        throw new Error('대용량 영상 임시 저장소를 준비하지 못했습니다: ' + e.message);
      }
      if (stream) return await downloadStreaming(segments, title, itemId, tabId, creds, ac, stream, finalizer);
    }

    return await downloadToMemory(segments, title, itemId, tabId, creds, ac, finalizer);
  } catch (e) {
    prog(tabId, itemId, 'error', e.message);
    throw e;
  } finally {
    if (active.get(itemId) === ac) active.delete(itemId);
  }
}

// 세그먼트 1개 fetch — 일시적 실패(429/5xx/네트워크 블립)는 백오프 재시도.
// 수만 개 세그먼트 다운로드에서 1개 실패로 전체가 죽지 않도록 하는 안전장치.
async function fetchSeg(segment, signal, creds, attempts = 4) {
  const url = typeof segment === 'string' ? segment : segment?.url;
  const range = typeof segment === 'string' ? null : segment?.range;
  const expectedRangeBytes = range ? rangeLength(range) : null;
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
      if (range && r.status !== 206) {
        throw new Error(`Range 응답 오류: HTTP ${r.status}. 전체 파일 응답 가능성이 있어 중단 (${url.slice(-30)})`);
      }
      const len = parseInt(r.headers.get('content-length') || '0', 10);
      if (Number.isFinite(len) && len > 0) {
        if (expectedRangeBytes && len > expectedRangeBytes + 1024) {
          throw new Error(`Range 크기 불일치: ${len}B > ${expectedRangeBytes}B (${url.slice(-30)})`);
        }
        if (len > MAX_SEGMENT_BYTES) {
          throw new Error(`세그먼트 크기 비정상: ${(len / 1024 / 1024).toFixed(1)}MB (${url.slice(-30)})`);
        }
      }
      if (r.ok) {
        assertSafeHttpsUrl(r.url || url, '세그먼트 응답 URL');
        return await readResponseBuffer(r, expectedRangeBytes);
      }
      // 영구 오류(429/5xx 제외)는 try 밖이라 즉시 전파 — 재시도 안 함
      if (r.status !== 429 && r.status < 500) throw new Error(`HTTP ${r.status} ${url.slice(-30)}`);
      lastErr = new Error(`HTTP ${r.status}`);                // 429/5xx → 재시도
    }
    if (a < attempts - 1) await new Promise(res => setTimeout(res, 500 * (a + 1))); // 0.5s,1s,1.5s 백오프
  }
  throw new Error(`세그먼트 ${attempts}회 실패: ${lastErr?.message || ''} ${url.slice(-30)}`);
}

function rangeLength(range) {
  const m = String(range || '').match(/^(\d+)-(\d+)$/);
  if (!m) return null;
  const start = Number(m[1]);
  const end = Number(m[2]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return end - start + 1;
}

async function readResponseBuffer(response, expectedBytes) {
  const maxBytes = expectedBytes ? expectedBytes + 1024 : MAX_SEGMENT_BYTES;

  if (!response.body || typeof response.body.getReader !== 'function') {
    const buf = await response.arrayBuffer();
    assertBufferSize(buf.byteLength, expectedBytes, maxBytes);
    return buf;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch (_) {}
      throw new Error(`응답 크기 제한 초과: ${(total / 1024 / 1024).toFixed(1)}MB`);
    }
    chunks.push(value);
  }

  assertBufferSize(total, expectedBytes, maxBytes);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}

function assertBufferSize(actualBytes, expectedBytes, maxBytes) {
  if (actualBytes > maxBytes) {
    throw new Error(`응답 크기 제한 초과: ${(actualBytes / 1024 / 1024).toFixed(1)}MB`);
  }
  if (expectedBytes && actualBytes !== expectedBytes) {
    throw new Error(`Range 크기 불일치: ${actualBytes}B != ${expectedBytes}B`);
  }
}

function validateSegmentPlan(segments) {
  const fullUrlCounts = new Map();
  for (const seg of segments) {
    const url = typeof seg === 'string' ? seg : seg?.url;
    const range = typeof seg === 'string' ? null : seg?.range;
    if (!url || range) continue;
    const count = (fullUrlCounts.get(url) || 0) + 1;
    fullUrlCounts.set(url, count);
    if (count > 3 && segments.length > 10) {
      throw new Error('동일한 비-Range 세그먼트 URL이 반복되어 전체 파일 중복 다운로드 위험이 있어 중단했습니다.');
    }
  }
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
async function downloadToMemory(segments, title, itemId, tabId, creds, ac, finalizer) {
  const total = segments.length;
  const chunks = new Array(total);                     // 인덱스로 순서 보존
  const step = Math.max(1, Math.floor(total / 200));
  const t0 = Date.now();
  let done = 0;

  prog(tabId, itemId, 'downloading', `0/${total}`, 0);
  await runWorkerPool(segments, creds, ac, (i, buf) => {
    chunks[i] = finalizer ? finalizer.transform(i, buf) : buf;
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

  prog(tabId, itemId, 'merging', '재생 시간 및 탐색 정보 생성 중...');
  let fileOffset = 0n;
  if (finalizer) {
    for (let i = 0; i < chunks.length; i++) {
      finalizer.record(i, chunks[i], fileOffset);
      fileOffset += BigInt(chunks[i].byteLength);
    }
  }
  const trailer = finalizer ? finalizer.buildTrailer() : null;
  if (trailer) dlog(tabId, '[mp4] 탐색 인덱스 생성 (' + trailer.byteLength + 'B)');
  const blob = new Blob(trailer ? [...chunks, trailer] : chunks, { type: 'video/mp4' });
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
async function downloadStreaming(segments, title, itemId, tabId, creds, ac, stream, finalizer) {
  const { root, name, fh, writable } = stream;
  const total = segments.length;
  const step = Math.max(1, Math.floor(total / 200));
  const MAX_AHEAD = 12;                                // 기록 프런티어보다 최대 12개까지만 선행 → Windows 장시간 VOD 메모리 압박 완화
  const buffer = new Map();                            // index -> ArrayBuffer (다운로드 완료, 기록 대기)
  const waiters = [];
  const t0 = Date.now();
  let writeIndex = 0, writing = false, writeMs = 0;    // writeMs: 디스크 쓰기에 든 누적 시간(병목 판별용)
  let fileOffset = 0n;

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
        if (finalizer) finalizer.record(writeIndex, buf, fileOffset);
        await writable.write(buf);
        fileOffset += BigInt(buf.byteLength);
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
      async (i, buf) => { buffer.set(i, finalizer ? finalizer.transform(i, buf) : buf); await flush(); },
      waitForSpace
    );
    await flush();                                     // 잔여분 기록
    const trailer = finalizer ? finalizer.buildTrailer() : null;
    if (trailer) {
      prog(tabId, itemId, 'merging', '재생 시간 및 탐색 정보 생성 중...');
      await writable.write(trailer);
      dlog(tabId, '[mp4] 탐색 인덱스 생성 (' + trailer.byteLength + 'B)');
    }
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

// fMP4 초기화 세그먼트의 duration을 채우고 조각 탐색 인덱스(mfra)를 생성한다.
// HLS 조각 자체는 재인코딩하지 않아 10~12시간 영상에서도 메모리 사용량이 일정하다.
const MP4_CONTAINER_BOXES = new Set(['moov', 'trak', 'mdia', 'mvex']);

function createFragmentedMp4Finalizer(durationSeconds, initIndexes, buildSeekIndex) {
  const initSet = new Set(initIndexes);
  const trackEntries = new Map();
  const trackTimescales = new Map();
  const timelineOrigin = { seconds: null };

  return {
    transform(index, buffer) {
      if (initSet.has(index)) {
        patchFragmentedMp4Duration(buffer, durationSeconds);
        for (const [trackId, timescale] of readTrackTimescales(buffer)) {
          trackTimescales.set(trackId, timescale);
        }
      }
      return buffer;
    },

    record(index, buffer, fileOffset) {
      if (initSet.has(index)) return;
      const entries = rebaseFragmentChunk(
        buffer,
        fileOffset,
        trackTimescales,
        timelineOrigin,
        buildSeekIndex
      );
      for (const entry of entries) {
        if (!trackEntries.has(entry.trackId)) trackEntries.set(entry.trackId, []);
        trackEntries.get(entry.trackId).push(entry);
      }
    },

    buildTrailer() {
      return buildMfraBox(trackEntries);
    },
  };
}
function patchFragmentedMp4Duration(buffer, durationSeconds) {
  if (!(buffer instanceof ArrayBuffer) || !Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0;
  const view = new DataView(buffer);
  const top = listMp4Boxes(view, 0, view.byteLength);
  const moov = top.find(box => box.type === 'moov');
  if (!moov) return 0;

  const boxes = [];
  collectMp4Boxes(view, moov.dataStart, moov.end, boxes);
  const mvhd = boxes.find(box => box.type === 'mvhd');
  if (!mvhd) return 0;

  const movieTimescale = readMp4Timescale(view, mvhd);
  if (!movieTimescale) return 0;

  let patched = 0;
  if (writeMp4BoxDuration(view, mvhd, movieTimescale, durationSeconds, 16, 24)) patched++;

  for (const box of boxes) {
    if (box.type === 'tkhd') {
      if (writeMp4BoxDuration(view, box, movieTimescale, durationSeconds, 20, 28)) patched++;
    } else if (box.type === 'mdhd') {
      const mediaTimescale = readMp4Timescale(view, box);
      if (mediaTimescale && writeMp4BoxDuration(view, box, mediaTimescale, durationSeconds, 16, 24)) patched++;
    } else if (box.type === 'mehd') {
      if (writeMp4BoxDuration(view, box, movieTimescale, durationSeconds, 4, 4)) patched++;
    }
  }

  return patched;
}

function readMp4Timescale(view, box) {
  if (box.dataStart + 4 > box.end) return 0;
  const version = view.getUint8(box.dataStart);
  const offset = box.dataStart + (version === 1 ? 20 : 12);
  return offset + 4 <= box.end ? view.getUint32(offset) : 0;
}

function writeMp4BoxDuration(view, box, timescale, seconds, version0Offset, version1Offset) {
  if (box.dataStart + 4 > box.end || !Number.isFinite(timescale) || timescale <= 0) return false;
  const version = view.getUint8(box.dataStart);
  const offset = box.dataStart + (version === 1 ? version1Offset : version0Offset);
  const bytes = version === 1 ? 8 : 4;
  if (offset + bytes > box.end) return false;

  const unitsNumber = Math.max(1, Math.round(seconds * timescale));
  if (!Number.isSafeInteger(unitsNumber)) return false;
  const units = BigInt(unitsNumber);

  if (version === 1) {
    writeUint64(view, offset, units);
  } else {
    view.setUint32(offset, Number(units > 0xffffffffn ? 0xffffffffn : units));
  }
  return true;
}

function readTrackTimescales(buffer) {
  const result = new Map();
  if (!(buffer instanceof ArrayBuffer)) return result;
  const view = new DataView(buffer);
  const moov = listMp4Boxes(view, 0, view.byteLength).find(box => box.type === 'moov');
  if (!moov) return result;

  const traks = listMp4Boxes(view, moov.dataStart, moov.end).filter(box => box.type === 'trak');
  for (const trak of traks) {
    const children = listMp4Boxes(view, trak.dataStart, trak.end);
    const tkhd = children.find(box => box.type === 'tkhd');
    const mdia = children.find(box => box.type === 'mdia');
    if (!tkhd || !mdia || tkhd.dataStart + 16 > tkhd.end) continue;

    const tkhdVersion = view.getUint8(tkhd.dataStart);
    const trackIdOffset = tkhd.dataStart + (tkhdVersion === 1 ? 20 : 12);
    if (trackIdOffset + 4 > tkhd.end) continue;
    const trackId = view.getUint32(trackIdOffset);

    const mdhd = listMp4Boxes(view, mdia.dataStart, mdia.end).find(box => box.type === 'mdhd');
    const timescale = mdhd ? readMp4Timescale(view, mdhd) : 0;
    if (trackId && timescale) result.set(trackId, timescale);
  }
  return result;
}

function rebaseFragmentChunk(buffer, fileOffset, trackTimescales, timelineOrigin, buildSeekIndex) {
  if (!(buffer instanceof ArrayBuffer)) return [];
  const view = new DataView(buffer);
  const moofs = listMp4Boxes(view, 0, view.byteLength).filter(box => box.type === 'moof');
  if (!moofs.length) return [];

  const fragmentTracks = moofs.map(moof => {
    const trafs = listMp4Boxes(view, moof.dataStart, moof.end).filter(box => box.type === 'traf');
    const tracks = [];

    for (let i = 0; i < trafs.length; i++) {
      const children = listMp4Boxes(view, trafs[i].dataStart, trafs[i].end);
      const tfhd = children.find(box => box.type === 'tfhd');
      const tfdt = children.find(box => box.type === 'tfdt');
      if (!tfhd || !tfdt || tfhd.dataStart + 8 > tfhd.end || tfdt.dataStart + 8 > tfdt.end) continue;

      const trackId = view.getUint32(tfhd.dataStart + 4);
      const version = view.getUint8(tfdt.dataStart);
      const timeOffset = tfdt.dataStart + 4;
      const timeBytes = version === 1 ? 8 : 4;
      if (!trackId || i >= 255 || timeOffset + timeBytes > tfdt.end) continue;

      tracks.push({
        trackId,
        version,
        timeOffset,
        time: version === 1
          ? readUint64(view, timeOffset)
          : BigInt(view.getUint32(timeOffset)),
        trafNumber: i + 1,
      });
    }
    return { moof, tracks };
  });

  if (timelineOrigin.seconds === null) {
    const candidates = fragmentTracks[0].tracks
      .map(track => {
        const timescale = trackTimescales.get(track.trackId);
        return timescale ? Number(track.time) / timescale : Number.NaN;
      })
      .filter(Number.isFinite);
    timelineOrigin.seconds = candidates.length ? Math.min(...candidates) : 0;
  }

  const indexEntries = [];
  for (let moofIndex = 0; moofIndex < fragmentTracks.length; moofIndex++) {
    const fragment = fragmentTracks[moofIndex];
    for (const track of fragment.tracks) {
      const timescale = trackTimescales.get(track.trackId);
      let rebasedTime = track.time;

      if (timescale && timelineOrigin.seconds > 0) {
        const shift = BigInt(Math.round(timelineOrigin.seconds * timescale));
        rebasedTime = track.time > shift ? track.time - shift : 0n;
        if (track.version === 1) {
          writeUint64(view, track.timeOffset, rebasedTime);
        } else {
          view.setUint32(track.timeOffset, Number(rebasedTime > 0xffffffffn ? 0xffffffffn : rebasedTime));
        }
      }

      if (buildSeekIndex && moofIndex === 0) {
        indexEntries.push({
          trackId: track.trackId,
          time: rebasedTime,
          moofOffset: fileOffset + BigInt(fragment.moof.offset),
          trafNumber: track.trafNumber,
        });
      }
    }
  }

  return indexEntries;
}
function buildMfraBox(trackEntries) {
  const tfraBoxes = [];
  for (const [trackId, entries] of [...trackEntries.entries()].sort((a, b) => a[0] - b[0])) {
    if (!entries.length) continue;
    const size = 24 + entries.length * 19;
    if (size > 0xffffffff) return null;

    const bytes = new Uint8Array(size);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, size);
    writeMp4Type(bytes, 4, 'tfra');
    view.setUint8(8, 1);                      // version 1: 64-bit time/offset
    view.setUint32(12, trackId);
    view.setUint32(16, 0);                    // traf/trun/sample number는 각각 1 byte
    view.setUint32(20, entries.length);

    let offset = 24;
    for (const entry of entries) {
      writeUint64(view, offset, entry.time);
      writeUint64(view, offset + 8, entry.moofOffset);
      view.setUint8(offset + 16, entry.trafNumber);
      view.setUint8(offset + 17, 1);
      view.setUint8(offset + 18, 1);
      offset += 19;
    }
    tfraBoxes.push(bytes);
  }

  if (!tfraBoxes.length) return null;
  const totalSize = 8 + tfraBoxes.reduce((sum, box) => sum + box.byteLength, 0) + 16;
  if (totalSize > 0xffffffff) return null;

  const out = new Uint8Array(totalSize);
  const view = new DataView(out.buffer);
  view.setUint32(0, totalSize);
  writeMp4Type(out, 4, 'mfra');

  let offset = 8;
  for (const box of tfraBoxes) {
    out.set(box, offset);
    offset += box.byteLength;
  }

  view.setUint32(offset, 16);
  writeMp4Type(out, offset + 4, 'mfro');
  view.setUint32(offset + 8, 0);
  view.setUint32(offset + 12, totalSize);
  return out.buffer;
}

function collectMp4Boxes(view, start, end, result) {
  for (const box of listMp4Boxes(view, start, end)) {
    result.push(box);
    if (MP4_CONTAINER_BOXES.has(box.type)) {
      collectMp4Boxes(view, box.dataStart, box.end, result);
    }
  }
}

function listMp4Boxes(view, start, end) {
  const boxes = [];
  let offset = start;
  while (offset + 8 <= end) {
    let size = view.getUint32(offset);
    const type = readMp4Type(view, offset + 4);
    let headerSize = 8;

    if (size === 1) {
      if (offset + 16 > end) break;
      size = readUint64Number(view, offset + 8);
      headerSize = 16;
    } else if (size === 0) {
      size = end - offset;
    }

    if (!Number.isSafeInteger(size) || size < headerSize || offset + size > end) break;
    boxes.push({ type, offset, dataStart: offset + headerSize, end: offset + size });
    offset += size;
  }
  return boxes;
}

function readMp4Type(view, offset) {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3)
  );
}

function writeMp4Type(bytes, offset, type) {
  for (let i = 0; i < 4; i++) bytes[offset + i] = type.charCodeAt(i);
}

function readUint64(view, offset) {
  return (BigInt(view.getUint32(offset)) << 32n) | BigInt(view.getUint32(offset + 4));
}

function readUint64Number(view, offset) {
  const value = readUint64(view, offset);
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : Number.NaN;
}

function writeUint64(view, offset, value) {
  view.setUint32(offset, Number((value >> 32n) & 0xffffffffn));
  view.setUint32(offset + 4, Number(value & 0xffffffffn));
}
// HLS Parser & Download
async function hlsDownload(masterText, masterUrl, title, itemId, tabId) {
  itemId = normalizeItemId(itemId);
  if (active.has(itemId)) throw new Error('이미 진행 중인 다운로드입니다.');
  const ac = new AbortController();
  active.set(itemId, ac);
  // 라이브 다시보기 HLS는 URL의 hdnts/hdntl 토큰으로 인증된다. 쿠키가 필요 없을 뿐 아니라,
  // CDN이 ACAO:* 로 응답하므로 credentials:'include'로 쿠키를 동봉하면 자격증명 CORS 규칙
  // 위반으로 'Failed to fetch'가 난다. 따라서 omit으로 토큰만 사용한다.
  const creds = 'omit';
  const t0 = Date.now();
  try {
    prog(tabId, itemId, 'info', 'HLS 분석 중...');
    dlog(tabId, 'HLS 분석 시작 (master ' + (masterText ? '내장' : 'fetch') + ')');

    let master = masterText;
    if (!master) master = await fetchHlsText(masterUrl, ac.signal, creds);
    dlog(tabId, 'master 확보 +' + (Date.now() - t0) + 'ms (len=' + master.length + ')');

    let plUrl = masterUrl;
    if (master.includes('#EXT-X-STREAM-INF')) {
      let best = 0;
      const lines = master.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
          const bw = parseInt((lines[i].match(/BANDWIDTH=(\d+)/) || [])[1] || '0');
          const next = lines[i + 1]?.trim();
          if (bw > best && next && !next.startsWith('#')) {
            best = bw;
            plUrl = resolve(masterUrl, next);
          }
        }
      }
    }

    const media = master.includes('#EXTINF') ? master : await fetchHlsText(plUrl, ac.signal, creds);
    dlog(tabId, 'variant playlist 확보 +' + (Date.now() - t0) + 'ms (len=' + media.length + ')');
    const parsed = parseHlsMediaPlaylist(media, plUrl);
    const segs = parsed.segments.map(normalizeSegment);
    if (!segs.length) throw new Error('HLS 세그먼트 없음');

    const finalizer = parsed.initIndexes.length && parsed.durationSeconds > 0
      ? createFragmentedMp4Finalizer(parsed.durationSeconds, parsed.initIndexes, parsed.independentSegments)
      : null;

    dlog(
      tabId,
      '세그먼트 파싱 완료 +' + (Date.now() - t0) + 'ms (' + segs.length +
      '개, init=' + parsed.initIndexes.length + '개, duration=' +
      parsed.durationSeconds.toFixed(3) + 's) → 다운로드 시작'
    );

    return segmentDownload(segs, title, itemId, tabId, creds, ac, finalizer);
  } catch (e) {
    prog(tabId, itemId, 'error', e.message);
    throw e;
  } finally {
    if (active.get(itemId) === ac) active.delete(itemId);
  }
}

async function fetchHlsText(url, signal, creds) {
  const safeUrl = assertSafeHttpsUrl(url, 'HLS 재생목록 URL');
  const response = await fetch(safeUrl, { signal, credentials: creds });
  if (!response.ok) throw new Error('HLS 재생목록 HTTP ' + response.status);
  assertSafeHttpsUrl(response.url || safeUrl, 'HLS 재생목록 응답 URL');
  const text = await response.text();
  if (text.length > MAX_PLAYLIST_TEXT) throw new Error('HLS 플레이리스트가 비정상적으로 큽니다.');
  return text;
}

function parseHlsMediaPlaylist(text, playlistUrl) {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const segments = [];
  const initIndexes = [];
  const seenMaps = new Set();
  const byteRangeEnds = new Map();
  let pendingByteRange = null;
  let durationSeconds = 0;

  for (const line of lines) {
    const upper = line.toUpperCase();

    if (upper.startsWith('#EXT-X-MAP:')) {
      const attrs = parseHlsAttrs(line);
      if (!attrs.URI) continue;
      const entry = makeHlsEntry(resolve(playlistUrl, attrs.URI), attrs.BYTERANGE, byteRangeEnds);
      const key = hlsEntryKey(entry);
      if (!seenMaps.has(key)) {
        initIndexes.push(segments.length);
        segments.push(entry);
        seenMaps.add(key);
      }
      continue;
    }

    if (upper.startsWith('#EXT-X-BYTERANGE:')) {
      pendingByteRange = line.slice(line.indexOf(':') + 1).trim();
      continue;
    }

    if (upper.startsWith('#EXTINF:')) {
      const duration = parseFloat(line.slice(line.indexOf(':') + 1));
      if (Number.isFinite(duration) && duration > 0) durationSeconds += duration;
      continue;
    }

    if (line.startsWith('#')) continue;

    const url = resolve(playlistUrl, line);
    segments.push(makeHlsEntry(url, pendingByteRange, byteRangeEnds));
    pendingByteRange = null;
  }

  return {
    segments,
    initIndexes,
    durationSeconds,
    independentSegments: lines.some(line => line.toUpperCase() === '#EXT-X-INDEPENDENT-SEGMENTS'),
  };
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
