// Restricted fallback for content-script metadata requests blocked by CORS.
// Never accept media URLs, arbitrary headers, methods or request bodies here.
const metadataRequests = new Map();
function metadataTarget(message) {
  const url = new URL(String(message.url || ''));
  const apiPath = /^\/service\/(?:v1\/channels\/[a-zA-Z0-9_-]{1,80}\/(?:videos|clips)|v2\/videos\/[a-zA-Z0-9_-]{1,128}|v1\/play-info\/clip\/[a-zA-Z0-9_-]{1,128})$/;
  const neoPath = /^\/neonplayer\/vodplay\/v2\/playback\/[a-zA-Z0-9_-]{1,128}$/;
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash || url.href.length > 8192
      || !(url.hostname === 'api.chzzk.naver.com' && apiPath.test(url.pathname)
        || url.hostname === 'apis.naver.com' && neoPath.test(url.pathname))) throw new Error('허용되지 않은 영상 정보 요청입니다.');
  if (!['', 'application/dash+xml'].includes(message.accept || '')) throw new Error('허용되지 않은 영상 정보 요청 헤더입니다.');
  const stage = url.hostname === 'apis.naver.com' ? 'Neonplayer 재생 정보'
    : url.pathname.includes('/channels/') ? '목록 조회' : url.pathname.includes('/clip/') ? '클립 정보' : 'VOD 정보';
  return { url: url.href, stage, host: url.hostname };
}
function metadataKey(message, sender) {
  if (!isTrustedContentSender(sender) || !Number.isInteger(sender.tab.id) || sender.frameId !== 0 || !/^[a-zA-Z0-9_-]{1,80}$/.test(message.requestId || '')) throw new Error('유효하지 않은 영상 정보 요청입니다.');
  return `${sender.tab.id}:${sender.frameId || 0}:${message.requestId}`;
}
function cancelMetadata(message, sender) {
  metadataRequests.get(metadataKey(message, sender))?.abort();
  return { ok: true };
}
async function readMetadataText(response) {
  if (Number(response.headers.get('content-length')) > MAX_PLAYLIST_TEXT) {
    await response.body?.cancel(); throw new Error('영상 정보 응답 크기 제한 초과');
  }
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder(); let text = '', size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > MAX_PLAYLIST_TEXT) { await reader.cancel(); throw new Error('영상 정보 응답 크기 제한 초과'); }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally { reader.releaseLock(); }
}
async function fetchMetadata(message, sender) {
  const target = metadataTarget(message), key = metadataKey(message, sender);
  if (metadataRequests.has(key) || metadataRequests.size >= 16) throw new Error('영상 정보 요청이 많습니다. 잠시 후 다시 시도해 주세요.');
  const controller = new AbortController(); metadataRequests.set(key, controller);
  try {
    await ensureHeaderRules();
    for (let attempt = 0; attempt < 3; attempt++) {
      CdlCore.throwIfAborted(controller.signal);
      const request = new AbortController(), abort = () => request.abort();
      controller.signal.addEventListener('abort', abort, { once: true });
      let timedOut = false, retryDelay = 0;
      const timer = setTimeout(() => { timedOut = true; request.abort(); }, 20000);
      try {
        const response = await fetch(target.url, { method: 'GET', credentials: 'include', redirect: 'error',
          headers: message.accept ? { Accept: message.accept } : {}, signal: request.signal });
        if (!response.ok) {
          await response.body?.cancel();
          const error = new Error(`HTTP ${response.status}`); error.status = response.status;
          error.retryAfter = response.headers.get('retry-after'); throw error;
        }
        return { text: await readMetadataText(response) };
      } catch (error) {
        CdlCore.throwIfAborted(controller.signal);
        const retryable = timedOut || error.name === 'TypeError' || error.status === 429 || error.status >= 500;
        retryDelay = CdlCore.retryDelay(attempt, error.retryAfter);
        if (!retryable || attempt === 2 || retryDelay > 5000) {
          const detail = timedOut ? '응답 시간 초과' : error.name === 'TypeError'
            ? '네트워크 연결 실패 (Failed to fetch). 인터넷 연결, 사이트 접근 권한 또는 차단 설정을 확인해 주세요.' : CdlCore.safeError(error);
          throw new Error(`${target.stage} 요청 실패 (${target.host}): ${detail}`);
        }
      } finally { clearTimeout(timer); controller.signal.removeEventListener('abort', abort); }
      await CdlCore.sleep(retryDelay, controller.signal);
    }
  } finally { metadataRequests.delete(key); }
}
