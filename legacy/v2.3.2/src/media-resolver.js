// Chzzk API and playback resolution; UI-independent.
(function () {
  "use strict";
  let logger = () => {};
  const log = message => logger(message);
  const API = {
    videoList: (ch, page, size, sort, vType) =>
      `https://api.chzzk.naver.com/service/v1/channels/${ch}/videos?sortType=${encodeURIComponent(sort || 'LATEST')}&pagingType=PAGE&page=${page || 0}&size=${size || 24}${vType ? `&videoType=${encodeURIComponent(vType)}` : ''}`,
    clipList: (ch, page, size, order, filter) =>
      `https://api.chzzk.naver.com/service/v1/channels/${ch}/clips?filterType=${encodeURIComponent(filter || 'ALL')}&orderType=${encodeURIComponent(order || 'POPULAR')}&page=${page || 0}&size=${size || 24}`,
    // VOD Info
    videoDetail: (videoNo) =>
      `https://api.chzzk.naver.com/service/v2/videos/${videoNo}`,
    // Playback DASH MPD (critical params: sid=2099, env=real)
    neonplayerV2: (videoId, inKey) =>
      `https://apis.naver.com/neonplayer/vodplay/v2/playback/${videoId}?key=${encodeURIComponent(inKey)}&sid=2099&env=real&lc=ko&cpl=ko`,
    // Clip detail → get videoId
    clipDetail: (clipId) =>
      `https://api.chzzk.naver.com/service/v1/play-info/clip/${clipId}`,
  };

  async function request(url, format, headers, signal) {
    if (signal?.aborted) throw new DOMException('중지됨', 'AbortError');
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 30000);
    try {
      const response = await fetch(url, { credentials: 'include', headers, signal: controller.signal });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return await response[format]();
    } catch (error) {
      if (timedOut) throw new Error('영상 정보 요청 시간이 초과됐습니다. 다시 시도해 주세요.');
      throw error;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  async function fetchJson(url, signal) { return request(url, 'json', {}, signal); }
  async function fetchText(url, headers = {}, signal) { return request(url, 'text', headers, signal); }

  // 중첩 JSON을 정규식으로 긁을 때 끝에 딸려오는 이스케이프 백슬래시(\)와
  // &, \/ 를 정리한다. 특히 끝 백슬래시는 URL 파서가 /로 바꿔 토큰을 깨뜨린다(→403).
  function cleanUrl(u) {
    return u.replace(/\\u0026/g, '&').replace(/\\\//g, '/').replace(/\\+$/, '');
  }

  // 라이브 다시보기(REPLAY) VOD는 inKey가 없고, 재생 정보가 liveRewindPlaybackJson
  // (응답에 문자열로 중첩된 JSON)에 담긴다. 정규식으로 긁으면 토큰이 깨지므로 파싱해서 꺼낸다.
  function extractPlaybackHls(c) {
    const raw = c.liveRewindPlaybackJson || c.livePlaybackJson;
    if (!raw) return null;
    try {
      const pb = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const hls = (pb.media || []).find(m => /HLS/i.test(m.protocol || m.mediaId || ''));
      return hls && hls.path ? hls.path : null;
    } catch (e) {
      log(`[VOD] playbackJson 파싱 실패: ${e.message}`);
      return null;
    }
  }

  // VOD Resolution: videoNo -> videoDetail -> videoId+inKey -> neonplayer -> DASH
  async function resolveVodUrl(videoNo, signal) {
    log(`[VOD] Step 1: /service/v2/videos/${videoNo}`);
    const detail = await fetchJson(API.videoDetail(videoNo), signal);
    const c = detail.content;
    if (!c) throw new Error('영상 정보 없음 (content null)');

    const videoId = c.videoId;
    const inKey = c.inKey;
    let playbackError;
    
    // 업로드형 VOD: videoId + inKey → neonplayer DASH (최고화질, 클립과 동일한 검증 경로)
    if (videoId && inKey) {
      log(`[VOD] videoId=${videoId.slice(0, 16)}..., inKey 길이=${inKey.length}`);
      log(`[VOD] Step 2: neonplayer 호출 (DASH 우선)`);
      try {
        return await callNeonplayer(videoId, inKey, signal);
      } catch (e) {
        if (signal?.aborted || e.name === 'AbortError') throw e;
        playbackError = e;
        log(`[VOD] neonplayer 실패: ${e.message}, 다른 전략 시도`);
      }
    }

    // 라이브 다시보기(REPLAY) VOD: inKey가 없고 liveRewindPlaybackJson에 토큰 HLS가 들어있다.
    const rewindHls = extractPlaybackHls(c);
    if (rewindHls) {
      log(`[VOD] liveRewindPlaybackJson에서 HLS 추출 (REPLAY)`);
      return { type: 'hls', url: rewindHls };
    }

    if (videoId && !inKey) {
      log(`[VOD] inKey 없음 (videoId=${videoId}). Strategy B: neonplayer key 없이 시도`);
      try {
        return await callNeonplayer(videoId, '', signal);
      } catch (e) {
        if (signal?.aborted || e.name === 'AbortError') throw e;
        playbackError = e;
        log(`[VOD] Strategy B 실패: ${e.message}`);
      }

      log('[VOD] Strategy C: neonplayer dummy key 시도');
      try {
        const url = API.neonplayerV2(videoId, videoId);
        const neoText = await fetchText(url, {}, signal);
        const trimmed = neoText.trim();
        if (trimmed.includes('<MPD')) return parseDashMpd(trimmed, url);
        if (trimmed.startsWith('#EXTM3U')) return { type: 'hls', url, masterText: trimmed };
      } catch (e) {
        if (signal?.aborted || e.name === 'AbortError') throw e;
        playbackError = e;
        log(`[VOD] Strategy C 실패: ${e.message}`);
      }
    }

    // Only explicit playback fields of this VOD can be used as a fallback.
    // A recursive scan also finds prevVideo/nextVideo.trailerUrl: another video.
    for (const value of [c.videoUrl, c.downloadUrl, c.playbackUrl]) {
      if (typeof value !== 'string') continue;
      const url = cleanUrl(value);
      try {
        const parsed = new URL(url);
        if (!['https:', 'http:'].includes(parsed.protocol)) continue;
        if (/\.mp4$/i.test(parsed.pathname)) return { type: 'mp4', url };
        if (/\.m3u8$/i.test(parsed.pathname)) return { type: 'hls', url };
      } catch (_) { /* Ignore malformed playback fields. */ }
    }
    if (playbackError) throw playbackError;
    throw new Error('다운로드할 수 있는 본편 재생 정보가 없습니다.');
  }

  // DASH MPD Parser: SegmentTemplate or BaseURL extraction
  function parseDashMpd(xml, url) { return globalThis.CdlDash.parse(xml, url); }

  // Clip Resolution
  async function resolveClipUrl(clipId, signal) {
    log(`[CLIP] Step 1: /play-info/clip/${clipId}`);
    const text = await fetchText(API.clipDetail(clipId), {}, signal);

    let data;
    try { data = JSON.parse(text); } catch {
      throw new Error(`클립 API 응답 파싱 실패: ${text.slice(0, 80)}`);
    }

    const c = data.content;
    if (!c) throw new Error('클립 content 없음');
    log(`[CLIP] content keys: ${Object.keys(c).join(',')}`);
    log(`[CLIP] videoId=${c.videoId}, contentId=${c.contentId}, vodStatus=${c.vodStatus}`);

    // 1. Quick scan for any direct URL in response
    const jsonStr = JSON.stringify(c);
    const mp4Match = jsonStr.match(/"(https?:\/\/[^"]+\.mp4[^"]*)"/);
    if (mp4Match) { log('[CLIP] 직접 MP4 URL 발견'); return { type: 'mp4', url: cleanUrl(mp4Match[1]) }; }
    const m3u8Match = jsonStr.match(/"(https?:\/\/[^"]+\.m3u8[^"]*)"/);
    if (m3u8Match) { log('[CLIP] 직접 HLS URL 발견'); return { type: 'hls', url: cleanUrl(m3u8Match[1]) }; }

    // inKey direct call if exists
    if (c.videoId && c.inKey) {
      log(`[CLIP] ★ videoId + inKey 모두 존재 → neonplayer 직접 호출`);
      try {
        return await callNeonplayer(c.videoId, c.inKey, signal);
      } catch (e) {
        if (signal?.aborted || e.name === 'AbortError') throw e;
        log(`[CLIP] 직접 호출 실패: ${e.message}`);
      }
    }

    // Fallbacks (contentId -> videoDetail or direct videoId)
    const videoId = c.videoId;
    if (!videoId) throw new Error('클립에 videoId 없음');

    // Strategy A: contentId → videoDetail → inKey
    if (c.contentId) {
      log(`[CLIP] Strategy A: contentId(${c.contentId})를 videoNo로 videoDetail 호출`);
      try {
        const detail = await fetchJson(API.videoDetail(c.contentId), signal);
        const dc = detail.content;
        if (dc?.inKey) {
          log(`[CLIP] inKey 획득 성공 (길이=${dc.inKey.length})`);
          // Use the videoId from clip (or from detail) + inKey
          const vid = dc.videoId || videoId;
          return await callNeonplayer(vid, dc.inKey, signal);
        }
        log(`[CLIP] Strategy A: inKey 없음, keys=${dc ? Object.keys(dc).join(',') : 'null'}`);
      } catch (e) {
        if (signal?.aborted || e.name === 'AbortError') throw e;
        log(`[CLIP] Strategy A 실패: ${e.message}`);
      }
    }

    // Strategy B: try neonplayer directly with videoId (no key)
    log('[CLIP] Strategy B: neonplayer key 없이 시도');
    try {
      return await callNeonplayer(videoId, '', signal);
    } catch (e) {
        if (signal?.aborted || e.name === 'AbortError') throw e;
      log(`[CLIP] Strategy B 실패: ${e.message}`);
    }

    // Strategy C: try neonplayer with videoId as both vid and key placeholder
    log('[CLIP] Strategy C: neonplayer dummy key 시도');
    try {
      const url = `https://apis.naver.com/neonplayer/vodplay/v2/playback/${videoId}?sid=2099&env=real&lc=ko&cpl=ko`;
      const neoText = await fetchText(url, {}, signal);
      const trimmed = neoText.trim();
      if (trimmed.includes('<MPD')) return parseDashMpd(trimmed, url);
      if (trimmed.startsWith('#EXTM3U')) return { type: 'hls', url, masterText: trimmed };
      log(`[CLIP] Strategy C 응답: ${trimmed.slice(0, 80)}`);
    } catch (e) {
        if (signal?.aborted || e.name === 'AbortError') throw e;
      log(`[CLIP] Strategy C 실패: ${e.message}`);
    }

    throw new Error(`클립 URL 추출 실패. videoId=${videoId}, contentId=${c.contentId}`);
  }

  // Helper: call neonplayer and parse response
  async function callNeonplayer(videoId, inKey, signal) {
    const url = API.neonplayerV2(videoId, inKey);
    log(`[NEO] ${url.slice(0, 80)}...`);
    const neoText = await fetchText(url, { Accept: 'application/dash+xml' }, signal);
    const trimmed = neoText.trim();
    log(`[NEO] 응답 길이=${trimmed.length}, 시작="${trimmed.slice(0, 40)}"`);
    if (trimmed.includes('<MPD') || trimmed.startsWith('<?xml')) {
      return parseDashMpd(trimmed, url);
    }
    if (trimmed.startsWith('#EXTM3U')) {
      return { type: 'hls', url, masterText: trimmed };
    }
    if (trimmed.startsWith('{')) {
      const json = JSON.parse(trimmed);
      const s = JSON.stringify(json);
      const m = s.match(/"(https?:\/\/[^"]+\.m3u8[^"]*)"/);
      if (m) return { type: 'hls', url: cleanUrl(m[1]) };
      const mp = s.match(/"(https?:\/\/[^"]+\.mp4[^"]*)"/);
      if (mp) return { type: 'mp4', url: cleanUrl(mp[1]) };
    }
    throw new Error(`neonplayer 응답 형식 불명: ${trimmed.slice(0, 60)}`);
  }


  globalThis.CdlMedia = { API, fetchJson, resolveVodUrl, resolveClipUrl, parseDashMpd, setLogger(fn) { logger = fn; } };
})();
