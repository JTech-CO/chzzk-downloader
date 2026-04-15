// Chzzk Downloader v2.1.1 - Content Script

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

  let currentSection = null, currentChannelId = null;
  let items = [], panelOpen = false, downloadStates = {}, debugLog = '';

  function log(msg) {
    debugLog = msg + '\n' + debugLog.slice(0, 3000);
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

  // VOD Resolution: videoNo -> videoDetail -> videoId+inKey -> neonplayer -> DASH
  async function resolveVodUrl(videoNo) {
    log(`[VOD] Step 1: /service/v2/videos/${videoNo}`);
    const detail = await fetchJson(API.videoDetail(videoNo));
    const c = detail.content;
    if (!c) throw new Error('영상 정보 없음 (content null)');

    const videoId = c.videoId;
    const inKey = c.inKey;
    if (!videoId || !inKey) throw new Error(`videoId/inKey 없음. adult=${c.adult}, blindType=${c.blindType}`);

    log(`[VOD] videoId=${videoId.slice(0, 16)}..., inKey 길이=${inKey?.length}`);
    log(`[VOD] Step 2: neonplayer 호출`);

    try {
      return await callNeonplayer(videoId, inKey);
    } catch (e) {
      throw new Error(`VOD neonplayer 실패: ${e.message}`);
    }
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
      if (trimmed.startsWith('#EXTM3U')) return { type: 'hls', url };
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
      return { type: 'hls', url };
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
  panel.innerHTML = `
    <div id="chzzk-dl-body">
      <div class="cdl-header">${ICONS.download}<span class="cdl-header-title">Chzzk Downloader</span><span class="cdl-header-section" id="cdl-section-tag"></span></div>
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
    const p = location.pathname;
    const v = p.match(/^\/([a-f0-9]{32})\/videos/);
    const c = p.match(/^\/([a-f0-9]{32})\/clips/);
    return v ? { section: 'videos', channelId: v[1] }
      : c ? { section: 'clips', channelId: c[1] }
        : { section: null, channelId: null };
  }

  function checkUrl() {
    const { section, channelId } = parseUrl();
    if (section !== currentSection || channelId !== currentChannelId) {
      currentSection = section; currentChannelId = channelId;
      items = []; downloadStates = {};
      if (section) { $('cdl-section-tag').textContent = section === 'videos' ? 'VOD' : 'CLIP'; setTimeout(scanPage, 800); }
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
    try {
      const p = new URLSearchParams(location.search);
      if (currentSection === 'videos') {
        const data = await fetchJson(API.videoList(currentChannelId, Math.max(0, parseInt(p.get('page') || '1') - 1), 24, p.get('sortType') || 'LATEST', p.get('videoType') || ''));
        const list = data?.content?.data || data?.data || [];
        log(`[Scan] VOD ${list.length}개`);
        items = list.map(v => ({ id: String(v.videoNo), type: 'video', title: v.videoTitle || '', thumbnail: v.thumbnailImageUrl || '', duration: v.duration || 0, views: v.readCount || 0, date: v.publishDate || '' }));
      } else {
        const data = await fetchJson(API.clipList(currentChannelId, 0, 24, p.get('orderType') || 'POPULAR', p.get('filterType') || 'ALL'));
        const list = data?.content?.data || data?.data || [];
        log(`[Scan] CLIP ${list.length}개`);
        items = list.map(c => ({ id: c.clipUID || c.clipId || '', type: 'clip', title: c.clipTitle || '', thumbnail: c.thumbnailImageUrl || '', duration: c.duration || 0, views: c.readCount || 0, date: c.createdDate || '' }));
      }
    } catch (e) {
      log(`[Scan] API 실패: ${e.message}, DOM 폴백`);
      scanDom();
    }
    if (items.length === 0) { log('[Scan] 0건 → DOM 폴백'); scanDom(); }
    render();
  }

  function scanDom() {
    const sel = currentSection === 'videos' ? 'a[href*="/video/"]' : 'a[href*="/clips/"]';
    const re = currentSection === 'videos' ? /\/video\/(\d+)/ : /\/clips\/([A-Za-z0-9_-]+)/;
    const found = [], seen = new Set();
    document.querySelectorAll(sel).forEach(link => {
      const m = link.href.match(re);
      if (!m || seen.has(m[1])) return; seen.add(m[1]);
      const card = link.closest('[class*="card"]') || link;
      const img = card.querySelector('img');
      const t = card.querySelector('[class*="title"], h3, h4, p');
      found.push({ id: m[1], type: currentSection === 'videos' ? 'video' : 'clip', title: t?.textContent?.trim() || m[1], thumbnail: img?.src || '', duration: 0, views: 0, date: '' });
    });
    if (found.length > 0) items = found;
  }

  // ---- Render ----
  function render() {
    const badge = $('chzzk-dl-badge');
    badge.textContent = items.length; badge.classList.toggle('visible', items.length > 0);
    $('cdl-footer').style.display = items.length > 0 ? 'flex' : 'none';
    $('cdl-item-count').textContent = `${items.length}개 항목`;

    const content = $('cdl-content');
    if (!currentSection) {
      content.innerHTML = `<div class="cdl-empty">${ICONS.empty}<div class="cdl-empty-title">동영상/클립 탭으로 이동하세요</div><div class="cdl-empty-desc">스트리머 채널의 동영상 또는 클립 탭에서<br>다운로드 목록이 자동으로 나타납니다.</div></div>`;
      return;
    }
    if (items.length === 0) {
      content.innerHTML = `<div class="cdl-empty">${ICONS.empty}<div class="cdl-empty-title">목록 로딩 중...</div></div>`;
      return;
    }

    content.innerHTML = `<div class="cdl-grid">${items.map(item => {
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
        chrome.runtime.sendMessage({ type: 'DOWNLOAD_HLS', hlsUrl: r.url, title: title || id, itemId: id }, res => {
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
    }
  });

  // ---- Utils ----
  function fmtDur(s) { if (!s) return ''; const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60); return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`; }
  function fmtNum(n) { return n >= 10000 ? (n / 10000).toFixed(1).replace(/\.0$/, '') + '만' : n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + '천' : String(n); }
  function fmtDate(d) { try { const dt = new Date(d); return `${dt.getMonth() + 1}/${dt.getDate()}` } catch { return '' } }
  function esc(s) { const e = document.createElement('span'); e.textContent = s; return e.innerHTML; }

  checkUrl();
})();
