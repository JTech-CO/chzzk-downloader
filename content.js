// Chzzk Downloader v2.2.3 - Content Script

(function () {
  'use strict';
  if (document.getElementById('chzzk-dl-panel')) return;

  // API Endpoints
  const API = {
    videoList: (ch, page, size, sort, vType) =>
      `https://api.chzzk.naver.com/service/v1/channels/${ch}/videos?sortType=${sort || 'LATEST'}&pagingType=PAGE&page=${page || 0}&size=${size || 24}${vType ? `&videoType=${vType}` : ''}`,
    clipList: (ch, page, size, order, filter) =>
      `https://api.chzzk.naver.com/service/v1/channels/${ch}/clips?filterType=${filter || 'ALL'}&orderType=${order || 'POPULAR'}&page=${page || 0}&size=${size || 24}`,
    // VOD Info
    videoDetail: (videoNo) =>
      `https://api.chzzk.naver.com/service/v2/videos/${videoNo}`,
    // Playback DASH MPD (critical params: sid=2099, env=real)
    neonplayerV2: (videoId, inKey) =>
      `https://apis.naver.com/neonplayer/vodplay/v2/playback/${videoId}?key=${inKey}&sid=2099&env=real&lc=ko&cpl=ko`,
    // Clip detail → get videoId
    clipDetail: (clipId) =>
      `https://api.chzzk.naver.com/service/v1/play-info/clip/${clipId}`,
  };

  const ICONS = {
    download: '<svg viewBox="0 0 24 24"><path d="M12 2a1 1 0 011 1v10.586l3.293-3.293a1 1 0 111.414 1.414l-5 5a1 1 0 01-1.414 0l-5-5a1 1 0 111.414-1.414L11 13.586V3a1 1 0 011-1zM5 20a1 1 0 110 2H19a1 1 0 110-2H5z"/></svg>',
    empty: '<svg viewBox="0 0 24 24"><path d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14v-4zM3 6h10a2 2 0 012 2v8a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2z"/></svg>',
  };

  const PAGE_SIZE = 24;
  const MAX_SCAN_PAGES = 100;
  const SORT_LABELS = { latest: '최신순', oldest: '과거순', popular: '인기순' };
  let currentSection = null, currentChannelId = null;
  let items = [], panelOpen = false, downloadStates = {}, debugLog = '';
  let sortMode = 'latest', scanSeq = 0;
  let channelVodType = null;   // 'fast'(정식 VOD) | 'slow'(라이브 다시보기) | 'unknown' | null(미확인)
  let noticeDismissed = false; // 현재 채널에서 안내 배너를 닫았는지
  let noticeExpanded = false;  // 'inKey란?' 설명 펼침 여부

  function log(msg) {
    const d = new Date();
    const ts = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`;
    debugLog = `[${ts}] ${msg}\n` + debugLog.slice(0, 4000);
    const el = document.getElementById('cdl-debug');
    if (el) el.textContent = debugLog;
  }

  async function fetchJson(url) {
    const r = await fetch(url, { credentials: 'include' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  async function fetchText(url, headers = {}) {
    const r = await fetch(url, { credentials: 'include', headers });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
    return r.text();
  }

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
  async function resolveVodUrl(videoNo) {
    log(`[VOD] Step 1: /service/v2/videos/${videoNo}`);
    const detail = await fetchJson(API.videoDetail(videoNo));
    const c = detail.content;
    if (!c) throw new Error('영상 정보 없음 (content null)');

    const videoId = c.videoId;
    const inKey = c.inKey;
    
    // 업로드형 VOD: videoId + inKey → neonplayer DASH (최고화질, 클립과 동일한 검증 경로)
    if (videoId && inKey) {
      log(`[VOD] videoId=${videoId.slice(0, 16)}..., inKey 길이=${inKey.length}`);
      log(`[VOD] Step 2: neonplayer 호출 (DASH 우선)`);
      try {
        return await callNeonplayer(videoId, inKey);
      } catch (e) {
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
        return await callNeonplayer(videoId, '');
      } catch (e) {
        log(`[VOD] Strategy B 실패: ${e.message}`);
      }

      log('[VOD] Strategy C: neonplayer dummy key 시도');
      try {
        const url = API.neonplayerV2(videoId, videoId);
        const neoText = await fetchText(url);
        const trimmed = neoText.trim();
        if (trimmed.includes('<MPD')) return parseDashMpd(trimmed, url);
        if (trimmed.startsWith('#EXTM3U')) return { type: 'hls', url, masterText: trimmed };
      } catch (e) {
        log(`[VOD] Strategy C 실패: ${e.message}`);
      }
    }

    // 최후 폴백: 응답 JSON에서 직접 URL 정규식 스캔 (위 경로가 모두 실패한 예외 케이스)
    // cleanUrl로 중첩 JSON 이스케이프(특히 끝 백슬래시)를 정리해 토큰 깨짐을 방지한다.
    log('[VOD] Fallback: 응답 JSON에서 직접 URL 스캔');
    const jsonStr = JSON.stringify(c);
    const mp4Match = jsonStr.match(/"(https?:\/\/[^"]+\.mp4[^"]*)"/);
    if (mp4Match) { log('[VOD] 직접 MP4 URL 발견'); return { type: 'mp4', url: cleanUrl(mp4Match[1]) }; }
    const m3u8Match = jsonStr.match(/"(https?:\/\/[^"]+\.m3u8[^"]*)"/);
    if (m3u8Match) { log('[VOD] 직접 HLS URL 발견'); return { type: 'hls', url: cleanUrl(m3u8Match[1]) }; }

    throw new Error(`videoId/inKey 없음. adult=${c.adult}, blindType=${c.blindType}`);
  }

  // DASH MPD Parser: SegmentTemplate or BaseURL extraction
  function parseDashMpd(xml, mpdUrl) {
    const doc = new DOMParser().parseFromString(xml, 'text/xml');

    // Check for parser errors
    if (doc.querySelector('parsererror')) {
      throw new Error('MPD XML 파싱 오류');
    }

    const q = (parent, tag) => {
      const els = parent.getElementsByTagName(tag);
      return Array.from(els);
    };

    // Get MPD base URL (the URL directory of the MPD itself)
    const mpdBase = mpdUrl.split('?')[0].replace(/[^/]+$/, '');

    // Check BaseURL
    const topBaseEls = q(doc, 'BaseURL');
    let topBase = topBaseEls.length > 0 ? topBaseEls[0].textContent.trim() : '';
    if (topBase && !topBase.startsWith('http')) topBase = mpdBase + topBase;

    // Find all Periods
    const periods = q(doc, 'Period');
    const period = periods[0] || doc.documentElement;

    // Video AdaptationSets
    const adaptSets = q(period, 'AdaptationSet');
    let bestVideo = null;
    let bestBandwidth = 0;

    for (const adapt of adaptSets) {
      const mime = adapt.getAttribute('mimeType') || '';
      const contentType = adapt.getAttribute('contentType') || '';

      // Skip audio-only
      if (mime.startsWith('audio') || contentType === 'audio') continue;

      const reps = q(adapt, 'Representation');
      for (const rep of reps) {
        const bw = parseInt(rep.getAttribute('bandwidth') || '0');
        if (bw <= bestBandwidth) continue;

        // Try BaseURL first (simple case - direct file URL)
        const repBase = q(rep, 'BaseURL');
        if (repBase.length > 0) {
          let url = repBase[0].textContent.trim();
          if (!url.startsWith('http')) url = (topBase || mpdBase) + url;
          bestBandwidth = bw;
          bestVideo = { type: 'direct', url, bandwidth: bw };
          continue;
        }

        // Try SegmentTemplate (segmented delivery)
        const templates = q(rep, 'SegmentTemplate');
        const adaptTemplates = q(adapt, 'SegmentTemplate');
        const tmpl = templates[0] || adaptTemplates[0];

        if (tmpl) {
          const init = tmpl.getAttribute('initialization') || '';
          const media = tmpl.getAttribute('media') || '';
          const startNum = parseInt(tmpl.getAttribute('startNumber') || '1');
          const timescale = parseInt(tmpl.getAttribute('timescale') || '1');
          const repId = rep.getAttribute('id') || '';

          // Get segment timeline
          const timeline = q(tmpl, 'SegmentTimeline')[0];
          let segCount = 0;

          if (timeline) {
            const ss = q(timeline, 'S');
            for (const s of ss) {
              const r = parseInt(s.getAttribute('r') || '0');
              segCount += 1 + r;
            }
          } else {
            // Use duration-based calculation
            const segDur = parseInt(tmpl.getAttribute('duration') || '0');
            const mpdDur = doc.documentElement.getAttribute('mediaPresentationDuration') || '';
            const totalSec = parseDuration(mpdDur);
            if (segDur > 0 && totalSec > 0) {
              segCount = Math.ceil(totalSec * timescale / segDur);
            }
          }

          bestBandwidth = bw;
          bestVideo = {
            type: 'segments',
            init: resolveTemplate(init, repId, startNum, topBase || mpdBase),
            media: media,
            repId: repId,
            startNumber: startNum,
            segmentCount: segCount,
            baseUrl: topBase || mpdBase,
            bandwidth: bw,
          };
        }
      }
    }

    if (!bestVideo) {
      log('[DASH] 비디오 Representation 없음');
      throw new Error('DASH MPD에서 비디오 스트림을 찾을 수 없습니다.');
    }

    log(`[DASH] 최고화질: type=${bestVideo.type}, bw=${bestVideo.bandwidth}`);

    if (bestVideo.type === 'direct') {
      const u = bestVideo.url;
      log(`[DASH] 직접 URL: ${u.slice(0, 80)}`);
      const isHls = u.includes('.m3u8');
      return { type: isHls ? 'hls' : 'mp4', url: u };
    }

    if (bestVideo.type === 'segments') {
      log(`[DASH] 세그먼트: ${bestVideo.segmentCount}개, init=${bestVideo.init?.slice(0, 60)}`);
      return {
        type: 'dash_segments',
        init: bestVideo.init,
        mediaTemplate: bestVideo.media,
        repId: bestVideo.repId,
        startNumber: bestVideo.startNumber,
        segmentCount: bestVideo.segmentCount,
        baseUrl: bestVideo.baseUrl,
      };
    }

    throw new Error('DASH 파싱 결과 없음');
  }

  function resolveTemplate(template, repId, number, base) {
    let url = template
      .replace(/\$RepresentationID\$/g, repId)
      .replace(/\$Number\$/g, String(number))
      .replace(/\$Number%(\d+)d\$/g, (_, w) => String(number).padStart(parseInt(w), '0'))
      .replace(/\$Bandwidth\$/g, '')
      .replace(/\$Time\$/g, '');
    if (!url.startsWith('http')) url = base + url;
    return url;
  }

  function parseDuration(iso) {
    if (!iso) return 0;
    const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?/);
    if (!m) return 0;
    return (parseInt(m[1] || '0') * 3600) + (parseInt(m[2] || '0') * 60) + parseFloat(m[3] || '0');
  }

  // Clip Resolution
  async function resolveClipUrl(clipId) {
    log(`[CLIP] Step 1: /play-info/clip/${clipId}`);
    const text = await fetchText(API.clipDetail(clipId));

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
    if (mp4Match) { log('[CLIP] 직접 MP4 URL 발견'); return { type: 'mp4', url: mp4Match[1].replace(/\\\//g, '/') }; }
    const m3u8Match = jsonStr.match(/"(https?:\/\/[^"]+\.m3u8[^"]*)"/);
    if (m3u8Match) { log('[CLIP] 직접 HLS URL 발견'); return { type: 'hls', url: m3u8Match[1].replace(/\\\//g, '/') }; }

    // inKey direct call if exists
    if (c.videoId && c.inKey) {
      log(`[CLIP] ★ videoId + inKey 모두 존재 → neonplayer 직접 호출`);
      try {
        return await callNeonplayer(c.videoId, c.inKey);
      } catch (e) {
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
        const detail = await fetchJson(API.videoDetail(c.contentId));
        const dc = detail.content;
        if (dc?.inKey) {
          log(`[CLIP] inKey 획득 성공 (길이=${dc.inKey.length})`);
          // Use the videoId from clip (or from detail) + inKey
          const vid = dc.videoId || videoId;
          return await callNeonplayer(vid, dc.inKey);
        }
        log(`[CLIP] Strategy A: inKey 없음, keys=${dc ? Object.keys(dc).join(',') : 'null'}`);
      } catch (e) {
        log(`[CLIP] Strategy A 실패: ${e.message}`);
      }
    }

    // Strategy B: try neonplayer directly with videoId (no key)
    log('[CLIP] Strategy B: neonplayer key 없이 시도');
    try {
      return await callNeonplayer(videoId, '');
    } catch (e) {
      log(`[CLIP] Strategy B 실패: ${e.message}`);
    }

    // Strategy C: try neonplayer with videoId as both vid and key placeholder
    log('[CLIP] Strategy C: neonplayer dummy key 시도');
    try {
      const url = `https://apis.naver.com/neonplayer/vodplay/v2/playback/${videoId}?sid=2099&env=real&lc=ko&cpl=ko`;
      const neoText = await fetchText(url);
      const trimmed = neoText.trim();
      if (trimmed.includes('<MPD')) return parseDashMpd(trimmed, url);
      if (trimmed.startsWith('#EXTM3U')) return { type: 'hls', url, masterText: trimmed };
      log(`[CLIP] Strategy C 응답: ${trimmed.slice(0, 80)}`);
    } catch (e) {
      log(`[CLIP] Strategy C 실패: ${e.message}`);
    }

    throw new Error(`클립 URL 추출 실패. videoId=${videoId}, contentId=${c.contentId}`);
  }

  // Helper: call neonplayer and parse response
  async function callNeonplayer(videoId, inKey) {
    const url = API.neonplayerV2(videoId, inKey);
    log(`[NEO] ${url.slice(0, 80)}...`);
    const neoText = await fetchText(url, { Accept: 'application/dash+xml' });
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
      if (m) return { type: 'hls', url: m[1].replace(/\\\//g, '/') };
      const mp = s.match(/"(https?:\/\/[^"]+\.mp4[^"]*)"/);
      if (mp) return { type: 'mp4', url: mp[1].replace(/\\\//g, '/') };
    }
    throw new Error(`neonplayer 응답 형식 불명: ${trimmed.slice(0, 60)}`);
  }

  // Panel UI Creation
  const panel = document.createElement('div');
  panel.id = 'chzzk-dl-panel';
  panel.classList.add('cdl-hidden');
  panel.innerHTML = `
    <div id="chzzk-dl-body">
      <div class="cdl-header">${ICONS.download}<span class="cdl-header-title">Chzzk Downloader</span><span class="cdl-header-section" id="cdl-section-tag"></span></div>
      <div class="cdl-toolbar" id="cdl-sort-toolbar">
        <button class="cdl-sort-btn active" data-sort="latest">최신순</button>
        <button class="cdl-sort-btn" data-sort="oldest">과거순</button>
        <button class="cdl-sort-btn" data-sort="popular">인기순</button>
      </div>
      <div id="cdl-content"></div>
      <div class="cdl-footer" id="cdl-footer" style="display:none">
        <span id="cdl-item-count"></span>
        <div style="display:flex;gap:6px">
          <button class="cdl-btn" id="cdl-debug-toggle">로그</button>
          <button class="cdl-btn" id="cdl-copy-log" style="display:none">복사</button>
          <button class="cdl-btn cdl-btn-accent" id="cdl-refresh-btn">새로고침</button>
        </div>
      </div>
      <pre id="cdl-debug" style="display:none"></pre>
    </div>
    <div id="chzzk-dl-toggle">${ICONS.download}<span id="chzzk-dl-badge">0</span></div>
  `;
  document.body.appendChild(panel);

  const $ = id => document.getElementById(id);
  function updateSortButtons() {
    document.querySelectorAll('#chzzk-dl-panel .cdl-sort-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.sort === sortMode);
    });
  }

  document.querySelectorAll('#chzzk-dl-panel .cdl-sort-btn').forEach(btn => {
    btn.onclick = () => {
      const next = btn.dataset.sort;
      if (!SORT_LABELS[next] || next === sortMode) return;
      sortMode = next;
      items = sortItems(items);
      updateSortButtons();
      render();
    };
  });

  function setPanelVisible(visible) {
    panel.classList.toggle('cdl-hidden', !visible);
    if (!visible) {
      panelOpen = false;
      $('chzzk-dl-body').classList.remove('open');
    }
  }

  $('chzzk-dl-toggle').onclick = () => { panelOpen = !panelOpen; $('chzzk-dl-body').classList.toggle('open', panelOpen); };
  $('cdl-refresh-btn').onclick = () => scanPage();
  $('cdl-debug-toggle').onclick = () => {
    const d = $('cdl-debug');
    const copyBtn = $('cdl-copy-log');
    const contentEl = $('cdl-content');
    const isOpen = d.style.display !== 'none';
    d.style.display = isOpen ? 'none' : 'block';
    copyBtn.style.display = isOpen ? 'none' : 'inline-block';
    contentEl.style.maxHeight = isOpen ? '440px' : '200px';
    $('cdl-debug-toggle').textContent = isOpen ? '로그' : '로그 닫기';
  };
  $('cdl-copy-log').onclick = () => {
    navigator.clipboard.writeText(debugLog).then(() => {
      $('cdl-copy-log').textContent = '복사됨!';
      setTimeout(() => { $('cdl-copy-log').textContent = '복사'; }, 1500);
    });
  };

  // SPA URL Monitoring
  function parseUrl() {
    if (location.href.toLowerCase().includes('live')) return { section: null, channelId: null };

    const p = location.pathname;
    const v = p.match(/^\/([a-f0-9]{32})\/videos/);
    const c = p.match(/^\/([a-f0-9]{32})\/clips/);
    return v ? { section: 'videos', channelId: v[1] }
      : c ? { section: 'clips', channelId: c[1] }
        : { section: null, channelId: null };
  }

  function checkUrl() {
    const { section, channelId } = parseUrl();
    setPanelVisible(Boolean(section));

    if (section !== currentSection || channelId !== currentChannelId) {
      currentSection = section; currentChannelId = channelId;
      items = []; downloadStates = {};
      sortMode = 'latest'; scanSeq++;
      channelVodType = null; noticeDismissed = false; noticeExpanded = false;
      updateSortButtons();
      if (section) { $('cdl-section-tag').textContent = section === 'videos' ? 'VOD' : 'CLIP'; setTimeout(scanPage, 800); }
      else { $('cdl-section-tag').textContent = ''; }
      render();
    }
  }

  setInterval(checkUrl, 1000);
  const _push = history.pushState, _repl = history.replaceState;
  history.pushState = function () { _push.apply(this, arguments); setTimeout(checkUrl, 300); };
  history.replaceState = function () { _repl.apply(this, arguments); setTimeout(checkUrl, 300); };

  // Scanner
  async function scanPage() {
    if (!currentSection || !currentChannelId) return;
    const scanId = ++scanSeq;
    const scanSection = currentSection;
    const scanChannelId = currentChannelId;
    items = [];
    render();

    try {
      const fetched = await fetchAllItems(scanSection, scanChannelId);
      if (scanId !== scanSeq) return;
      items = sortItems(fetched);
    } catch (e) {
      if (scanId !== scanSeq) return;
      log(`[Scan] API 실패: ${e.message}`);
    }
    if (scanId !== scanSeq) return;
    
    // 항상 DOM과 병합하여 무한 스크롤로 추가된 항목도 반영
    scanDom();
    render();
    detectVodType();   // 채널 VOD 유형(빠름/느림) 판별 후 안내 배너 표시
  }

  async function fetchAllItems(section, channelId) {
    const p = new URLSearchParams(location.search);
    const all = [];
    const seen = new Set();
    let page = 0;

    while (page < MAX_SCAN_PAGES) {
      let data;
      try {
        data = section === 'videos'
          ? await fetchJson(API.videoList(channelId, page, PAGE_SIZE, p.get('sortType') || 'LATEST', p.get('videoType') || ''))
          : await fetchJson(API.clipList(channelId, page, PAGE_SIZE, p.get('orderType') || 'POPULAR', p.get('filterType') || 'ALL'));
      } catch (e) {
        if (page === 0) throw e;
        log(`[Scan] page=${page + 1} 로딩 실패, 이전 ${all.length}개로 표시: ${e.message}`);
        break;
      }

      const list = extractList(data);
      if (!list.length) break;

      let added = 0;
      for (const raw of list) {
        const item = section === 'videos' ? mapVideo(raw) : mapClip(raw);
        if (!item.id || seen.has(item.id)) continue;
        seen.add(item.id);
        all.push(item);
        added++;
      }

      log(`[Scan] ${section === 'videos' ? 'VOD' : 'CLIP'} API page=${page + 1}, +${added}, total=${all.length}`);
      if (list.length < PAGE_SIZE || added === 0) break;
      page++;
    }

    if (page >= MAX_SCAN_PAGES) log(`[Scan] 최대 ${MAX_SCAN_PAGES}페이지까지 로딩`);
    return all;
  }

  function extractList(data) {
    return data?.content?.data || data?.data || data?.content?.videos || data?.content?.clips || [];
  }

  function mapVideo(v) {
    return {
      id: String(v.videoNo || v.videoId || ''),
      type: 'video',
      title: v.videoTitle || v.title || '',
      thumbnail: v.thumbnailImageUrl || v.thumbnailUrl || '',
      duration: Number(v.duration || 0),
      views: Number(v.readCount || v.viewCount || 0),
      date: v.publishDate || v.createdDate || v.createdAt || '',
    };
  }

  function mapClip(c) {
    return {
      id: String(c.clipUID || c.clipId || c.clipNo || ''),
      type: 'clip',
      title: c.clipTitle || c.title || '',
      thumbnail: c.thumbnailImageUrl || c.thumbnailUrl || '',
      duration: Number(c.duration || 0),
      views: Number(c.readCount || c.viewCount || 0),
      date: c.createdDate || c.publishDate || c.createdAt || '',
    };
  }

  function mergeItems(base, extra) {
    const map = new Map();
    for (const item of base) map.set(item.id, item);
    for (const item of extra) {
      const prev = map.get(item.id);
      map.set(item.id, prev ? {
        ...prev,
        title: prev.title || item.title,
        thumbnail: prev.thumbnail || item.thumbnail,
        duration: prev.duration || item.duration,
        views: prev.views || item.views,
        date: prev.date || item.date,
      } : item);
    }
    return Array.from(map.values());
  }

  function sortItems(list) {
    const dir = sortMode === 'oldest' ? 1 : -1;
    return [...list].sort((a, b) => {
      if (sortMode === 'popular') {
        const views = (b.views || 0) - (a.views || 0);
        if (views) return views;
        return dateValue(b.date) - dateValue(a.date);
      }

      const date = (dateValue(a.date) - dateValue(b.date)) * dir;
      if (date) return date;
      return String(a.id).localeCompare(String(b.id)) * dir;
    });
  }

  function dateValue(d) {
    const t = Date.parse(d || '');
    return Number.isFinite(t) ? t : 0;
  }

  function scanDom() {
    const sel = currentSection === 'videos' ? 'a[href*="/video/"]' : 'a[href*="/clips/"]';
    const re = currentSection === 'videos' ? /\/video\/(\d+)/ : /\/clips\/([A-Za-z0-9_-]+)/;
    
    // 기존 API에서 가져온 항목들을 맵으로 구성하여 메타데이터 보존
    const existingMap = new Map(items.map(i => [i.id, i]));
    const found = [], seen = new Set();
    
    document.querySelectorAll(sel).forEach(link => {
      const m = link.href.match(re);
      if (!m || seen.has(m[1])) return; 
      seen.add(m[1]);
      
      const id = m[1];
      const apiItem = existingMap.get(id);
      
      const card = link.closest('[class*="card"]') || link;
      const img = card.querySelector('img');
      const t = card.querySelector('[class*="title"], h3, h4, p');
      
      found.push({ 
        id: id, 
        type: currentSection === 'videos' ? 'video' : 'clip', 
        title: apiItem?.title || t?.textContent?.trim() || id, 
        thumbnail: apiItem?.thumbnail || img?.src || '', 
        duration: apiItem?.duration || 0, 
        views: apiItem?.views || 0, 
        date: apiItem?.date || '' 
      });
    });
    
    if (found.length > 0) {
      const before = items.length;
      items = sortItems(mergeItems(items, found));
      log(`[Scan] DOM 스캔 완료: ${found.length}개 확인, +${items.length - before}개 추가`);
    }
  }

  // 채널의 VOD 유형 판별 — 정식 VOD(inKey/ABR_HLS)=빠름, 라이브 다시보기(NONE)=느림.
  // 목록 API엔 vodStatus가 없어 최신 영상 1건의 상세를 1회 호출(채널 고정 속성이라 대표값).
  async function detectVodType() {
    if (currentSection !== 'videos' || channelVodType !== null) return;
    const first = items.find(i => i.type === 'video');
    if (!first) return;
    try {
      const c = (await fetchJson(API.videoDetail(first.id))).content || {};
      if (c.inKey || c.vodStatus === 'ABR_HLS') channelVodType = 'fast';
      else if (c.vodStatus === 'NONE' || c.liveRewindPlaybackJson) channelVodType = 'slow';
      else channelVodType = 'unknown';
      log(`[Notice] 채널 VOD 유형=${channelVodType} (vodStatus=${c.vodStatus}, inKey=${c.inKey ? 'O' : 'X'})`);
      render();
    } catch (e) {
      log(`[Notice] VOD 유형 판별 실패: ${e.message}`); // null 유지 → 다음 스캔 때 재시도
    }
  }

  // 빠름/느림 안내 배너 HTML (+ 'inKey란?' 펼치기 설명)
  function renderNotice() {
    if (currentSection !== 'videos' || noticeDismissed) return '';
    if (channelVodType !== 'slow' && channelVodType !== 'fast') return '';
    const slow = channelVodType === 'slow';
    const cls = slow ? 'cdl-notice-warn' : 'cdl-notice-ok';
    const title = slow ? '이 채널 영상은 다운로드가 느릴 수 있어요' : '이 채널 영상은 비교적 빠르게 다운로드돼요';
    const body = slow
      ? '이 채널에는 inKey가 없어 다운로드가 느릴 수 있습니다. 다시보기가 완성된 하나의 영상이 아니라 수많은 조각들로 저장되어 있어 개별 다운로드 후 합성에 시간이 소요됩니다.'
      : '이 채널에는 inKey가 있어 다운로드가 비교적 빠릅니다. 다시보기가 완성된 하나의 영상으로 되어 있습니다.';
    const explain = "inKey는 완성 변환된 다시보기 영상을 재생할 때 쓰이는 키입니다. 스트리머가 다시보기를 정식 VOD로 저장하면 영상이 하나의 완성 파일로 변환되며 inKey가 생겨 빠르게 받을 수 있습니다. 저장하지 않으면 임시 '라이브 다시보기'(잘게 쪼갠 조각)로만 남아 inKey가 없고 느립니다. inKey 유무는 채널 규모가 아니라 방송의 다시보기 저장 방식에 따라 갈립니다.";
    return `<div class="cdl-notice ${cls}">
        <button class="cdl-notice-x" id="cdl-notice-close" title="닫기">×</button>
        <div class="cdl-notice-title">${title}</div>
        <div class="cdl-notice-body">${body}</div>
        <button class="cdl-notice-more" id="cdl-notice-more">${noticeExpanded ? 'inKey란? 접기' : 'inKey란?'}</button>
        ${noticeExpanded ? `<div class="cdl-notice-explain">${explain}</div>` : ''}
      </div>`;
  }

  // ---- Render ----
  function render() {
    updateSortButtons();
    const badge = $('chzzk-dl-badge');
    badge.textContent = items.length; badge.classList.toggle('visible', items.length > 0);
    $('cdl-footer').style.display = items.length > 0 ? 'flex' : 'none';
    $('cdl-item-count').textContent = `${items.length}개 항목 · ${SORT_LABELS[sortMode]}`;

    const content = $('cdl-content');
    if (!currentSection) {
      content.innerHTML = `<div class="cdl-empty">${ICONS.empty}<div class="cdl-empty-title">동영상/클립 탭으로 이동하세요</div><div class="cdl-empty-desc">스트리머 채널의 동영상 또는 클립 탭에서<br>다운로드 목록이 자동으로 나타납니다.</div></div>`;
      return;
    }
    if (items.length === 0) {
      content.innerHTML = `<div class="cdl-empty">${ICONS.empty}<div class="cdl-empty-title">목록 로딩 중...</div></div>`;
      return;
    }

    content.innerHTML = `${renderNotice()}<div class="cdl-grid">${items.map(item => {
      const ds = downloadStates[item.id];
      const active = ds && ds.status !== 'done' && ds.status !== 'error';
      const done = ds?.status === 'done';
      const err = ds?.status === 'error';
      return `
        <div class="cdl-tile ${active ? 'downloading' : ''} ${done ? 'done' : ''} ${err ? 'errored' : ''}"
             data-id="${item.id}" data-type="${item.type}" data-title="${esc(item.title)}">
          <div class="cdl-tile-thumb">
            ${item.thumbnail ? `<img src="${esc(item.thumbnail)}" alt="" loading="lazy"/>` : '<div class="cdl-tile-nothumb"></div>'}
            ${item.duration ? `<span class="cdl-tile-dur">${fmtDur(item.duration)}</span>` : ''}
            <div class="cdl-tile-overlay">
              ${active ? `<div class="cdl-prog"><div class="cdl-prog-bar"><div class="cdl-prog-fill" style="width:${ds.percent || 0}%"></div></div><span class="cdl-prog-txt">${esc(ds.message || '')}</span></div>`
          : done ? `<span class="cdl-prog-txt cdl-ok">✓ 완료</span>`
            : err ? `<span class="cdl-prog-txt cdl-err">✕ ${esc((ds.message || '오류').slice(0, 60))}</span>`
              : `<div class="cdl-tile-dlbtn">${ICONS.download}</div>`}
            </div>
          </div>
          <div class="cdl-tile-info">
            <div class="cdl-tile-title" title="${esc(item.title)}">${esc(item.title || item.id)}</div>
            <div class="cdl-tile-meta">${item.views ? fmtNum(item.views) + '회' : ''}${item.date ? ' · ' + fmtDate(item.date) : ''}</div>
          </div>
        </div>`;
    }).join('')}</div>`;

    const noticeClose = $('cdl-notice-close');
    if (noticeClose) noticeClose.onclick = () => { noticeDismissed = true; render(); };
    const noticeMore = $('cdl-notice-more');
    if (noticeMore) noticeMore.onclick = () => { noticeExpanded = !noticeExpanded; render(); };

    content.querySelectorAll('.cdl-tile').forEach(tile => {
      tile.onclick = () => {
        const { id, type, title } = tile.dataset;
        if (downloadStates[id] && downloadStates[id].status !== 'error') return;
        startDownload(id, type, title);
      };
    });
  }

  // ---- Download orchestration ----
  async function startDownload(id, type, title) {
    downloadStates[id] = { status: 'info', message: '스트림 분석 중...', percent: 0 };
    render();
    try {
      const r = type === 'video' ? await resolveVodUrl(id) : await resolveClipUrl(id);
      log(`[DL] 결과: type=${r.type}`);

      if (r.type === 'mp4') {
        downloadStates[id] = { status: 'info', message: 'MP4 다운로드...', percent: 0 }; render();
        chrome.runtime.sendMessage({ type: 'DOWNLOAD_DIRECT', url: r.url, filename: title || id, ext: '.mp4' }, res => {
          downloadStates[id] = res?.error ? { status: 'error', message: res.error } : { status: 'done', message: '완료' };
          render();
        });

      } else if (r.type === 'hls') {
        downloadStates[id] = { status: 'info', message: 'HLS 다운로드...', percent: 0 }; render();
        chrome.runtime.sendMessage({ type: 'DOWNLOAD_HLS', hlsUrl: r.url, masterText: r.masterText, title: title || id, itemId: id }, res => {
          if (res?.error) { downloadStates[id] = { status: 'error', message: res.error }; render(); }
        });

      } else if (r.type === 'dash_segments') {
        // Build segment URL list and send to background for parallel download
        downloadStates[id] = { status: 'info', message: `DASH ${r.segmentCount}개 세그먼트 준비...`, percent: 0 }; render();

        const segUrls = [];
        // Add init segment
        if (r.init) segUrls.push(r.init);
        // Build media segment URLs
        for (let i = 0; i < r.segmentCount; i++) {
          const num = r.startNumber + i;
          const url = resolveTemplate(r.mediaTemplate, r.repId, num, r.baseUrl);
          segUrls.push(url);
        }

        log(`[DL] DASH 세그먼트 ${segUrls.length}개 생성`);

        chrome.runtime.sendMessage({
          type: 'DOWNLOAD_SEGMENTS',
          segments: segUrls,
          title: title || id,
          itemId: id,
        }, res => {
          if (res?.error) { downloadStates[id] = { status: 'error', message: res.error }; render(); }
        });
      }
    } catch (e) {
      log(`[DL] 에러: ${e.message}`);
      downloadStates[id] = { status: 'error', message: e.message };
      render();
    }
  }

  // Progress Listener
  chrome.runtime.onMessage.addListener(msg => {
    if (msg.type === 'DOWNLOAD_PROGRESS') {
      downloadStates[msg.downloadId] = { status: msg.status, message: msg.message, percent: msg.percent || 0 };
      render();
    } else if (msg.type === 'CDL_LOG') {
      log(msg.msg);
    }
  });

  // ---- Utils ----
  function fmtDur(s) { if (!s) return ''; const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60); return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`; }
  function fmtNum(n) { return n >= 10000 ? (n / 10000).toFixed(1).replace(/\.0$/, '') + '만' : n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + '천' : String(n); }
  function fmtDate(d) { try { const dt = new Date(d); return `${dt.getMonth() + 1}/${dt.getDate()}` } catch { return '' } }
  function esc(s) { const e = document.createElement('span'); e.textContent = s; return e.innerHTML; }

  checkUrl();
})();
