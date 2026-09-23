// Chzzk Downloader v2.3.2 - progressive catalog and keyed download views.
(function () {
  'use strict';
  if (document.getElementById('chzzk-dl-panel')) return;
  const UI_VERSION = '2.3.2';
  const media = globalThis.CdlMedia;
  const ACTIVE = new Set(['queued', 'info', 'downloading', 'merging', 'saving', 'stopping']);
  const labels = { queued: '대기 중', info: '정보 확인 중', downloading: '다운로드 중', merging: '마무리 중', saving: '파일 저장 중', stopping: '중지 중', paused: '일시 중지', cancelled: '중지됨', interrupted: '중단됨', error: '오류', unconfirmed: '완료 확인 필요', done: '저장 완료' };
  const icons = {
    download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 3v12m-4-4 4 4 4-4M4 16v4h16v-4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" stroke-linecap="round"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2 6M20 4v7h-7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };
  const panel = document.createElement('div'); panel.id = 'chzzk-dl-panel'; panel.hidden = true;
  // Remote titles and URLs are assigned through DOM properties, never parsed as markup.
  panel.innerHTML = `
    <section class="cdl-shell" id="cdl-shell" role="dialog" aria-label="Chzzk Downloader" hidden>
      <header class="cdl-header"><span class="cdl-brand-icon">${icons.download}</span><div class="cdl-brand"><strong>Chzzk Downloader</strong><span>영상과 클립을 내 컴퓨터에</span></div><button class="cdl-icon-button" id="cdl-close" aria-label="다운로더 닫기">${icons.close}</button></header>
      <div class="cdl-tabs" role="tablist" aria-label="다운로더 메뉴"><button role="tab" id="cdl-browse-tab" aria-controls="cdl-browse" aria-selected="true">영상 목록</button><button role="tab" id="cdl-jobs-tab" aria-controls="cdl-jobs" aria-selected="false" tabindex="-1">다운로드 <span id="cdl-job-count">0</span></button></div>
      <div id="cdl-connection" role="status" hidden></div>
      <section id="cdl-browse" class="cdl-tab-panel" role="tabpanel" aria-labelledby="cdl-browse-tab">
        <div class="cdl-controls"><input id="cdl-search" type="search" aria-label="영상 제목 검색" placeholder="불러온 영상에서 제목 검색"><select id="cdl-sort" aria-label="영상 정렬"><option value="latest">최신순</option><option value="oldest">과거순</option><option value="popular">인기순</option></select><button class="cdl-icon-button" id="cdl-refresh" aria-label="목록 새로고침" title="목록 새로고침">${icons.refresh}</button></div>
        <div class="cdl-catalog-meta"><span id="cdl-item-count" role="status"></span><span id="cdl-sort-hint">불러온 목록 기준</span></div>
        <button class="cdl-active-summary" id="cdl-active-summary" hidden></button>
        <div id="cdl-content" class="cdl-scroll"><div id="cdl-empty" class="cdl-empty" role="status"></div><div id="cdl-spacer-top" aria-hidden="true"></div><div id="cdl-grid"></div><div id="cdl-spacer-bottom" aria-hidden="true"></div><div class="cdl-load-actions" id="cdl-load-actions"><button class="cdl-button" id="cdl-load-more">더 불러오기</button><button class="cdl-text-button" id="cdl-load-all">전체 불러오기</button></div></div>
      </section>
      <section id="cdl-jobs" class="cdl-tab-panel" role="tabpanel" aria-labelledby="cdl-jobs-tab" hidden><div class="cdl-jobs-hint">받는 중인 작업과 저장 결과를 확인하세요.</div><div id="cdl-job-list" class="cdl-scroll"></div></section>
      <div id="cdl-feedback" role="status" hidden></div>
      <footer class="cdl-footer"><span>v${UI_VERSION}</span><div><button id="cdl-copy-log" class="cdl-text-button" hidden>로그 복사</button><button id="cdl-log-toggle" class="cdl-text-button" aria-expanded="false">진단 로그</button></div></footer>
      <pre id="cdl-debug" hidden></pre>
    </section>
    <button id="chzzk-dl-toggle" aria-label="다운로더 열기" aria-expanded="false" aria-controls="cdl-shell">${icons.download}<span id="chzzk-dl-badge" hidden></span></button>`;
  document.body.appendChild(panel);
  const $ = id => panel.querySelector('#' + id);
  const state = { route: null, open: false, tab: 'browse', items: [], view: [], page: 0, more: true, loading: false, error: '', sort: 'latest', search: '', all: false };
  const jobs = new Map(), resolving = new Map(), itemNodes = new Map(), jobNodes = new Map(), cache = new Map(), dirtyJobs = new Set();
  let routeKey = '', scanToken = 0, scanAbort, windowKey = '', frame = 0, dirtyCatalog = true, dirtyJobList = true, logText = '', syncTask = null;
  let connectionReady = false, connectionBlocked = false, connectionMessage = '', lastSyncError = '', versionLogged = false;
  function text(node, value) { const next = String(value ?? ''); if (node.textContent !== next) node.textContent = next; }
  function element(tag, className, value) { const node = document.createElement(tag); if (className) node.className = className; if (value != null) node.textContent = value; return node; }
  function button(label, className, action) { const node = element('button', className || 'cdl-button', label); node.type = 'button'; node.onclick = action; return node; }
  function idFor(item) { return `${item.type === 'clip' ? 'clip' : 'video'}-${item.id}`; }
  function log(message) {
    const clean = String(message).replace(/https?:\/\/[^\s]+/g, value => { try { const u = new URL(value); return u.origin + u.pathname; } catch (_) { return '[URL]'; } });
    logText = `[${new Date().toLocaleTimeString('ko-KR', { hour12: false })}] ${clean}\n${logText}`.slice(0, 12000);
    if (!$('cdl-debug').hidden) text($('cdl-debug'), logText);
  }
  media.setLogger(log);
  function feedback(message) { text($('cdl-feedback'), message); $('cdl-feedback').hidden = !message; }
  function installedVersion() { try { return chrome.runtime.getManifest?.()?.version || '확인 불가'; } catch (_) { return '확인 불가'; } }
  function connectionIssue(reason) {
    if (connectionBlocked) return;
    connectionBlocked = true; connectionReady = false;
    connectionMessage = '확장 프로그램 업데이트가 완전히 적용되지 않았습니다. 확장 프로그램 관리에서 새로고침한 뒤 이 치지직 페이지도 새로고침해 주세요.';
    text($('cdl-connection'), connectionMessage); $('cdl-connection').hidden = false;
    log(`[설치 확인] 화면 v${UI_VERSION} / 설치 v${installedVersion()} · ${reason} · ${connectionMessage}`);
    for (const id of itemNodes.keys()) dirtyJobs.add(id);
    schedule();
  }
  async function send(message) {
    if (connectionBlocked) throw new Error(connectionMessage);
    let response;
    try { response = await chrome.runtime.sendMessage(message); }
    catch (error) {
      if (/Extension context invalidated/i.test(error.message)) connectionIssue('페이지의 확장 프로그램 연결이 만료됐습니다.');
      throw new Error(connectionBlocked ? connectionMessage : error.message);
    }
    if (message.type === 'GET_JOBS' && /알 수 없는 메시지/.test(response?.error || '')) {
      connectionIssue('실행부가 작업 상태 조회를 지원하지 않습니다.');
      throw new Error(connectionMessage);
    }
    if (!response || response.error) throw new Error(response?.error || '확장프로그램 연결이 끊겼습니다. 페이지를 새로고침해 주세요.');
    return response;
  }
  function isJobRecord(job) { return job && typeof job.id === 'string' && typeof job.status === 'string'; }
  async function ensureConnection() {
    if (!connectionReady && !connectionBlocked) await syncJobs();
    if (!connectionReady || connectionBlocked) throw new Error(connectionMessage || lastSyncError || '다운로드 연결을 확인하지 못했습니다. 다시 시도해 주세요.');
  }
  function schedule() { if (!frame) frame = requestAnimationFrame(flush); }
  function flush() {
    frame = 0;
    const active = [...jobs.values()].filter(job => ACTIVE.has(job.status));
    text($('cdl-job-count'), jobs.size); text($('chzzk-dl-badge'), active.length); $('chzzk-dl-badge').hidden = !active.length;
    text($('cdl-active-summary'), `${active.length}개 작업 진행 중 · 다운로드 보기 →`); $('cdl-active-summary').hidden = !active.length;
    if (!state.open) return;
    if (state.tab === 'browse' && dirtyCatalog) { renderCatalog(); dirtyCatalog = false; }
    if (state.tab === 'jobs' && dirtyJobList) { renderJobList(); dirtyJobList = false; }
    for (const id of dirtyJobs) {
      const card = itemNodes.get(id); if (card) updateCard(card);
      const row = jobNodes.get(id); if (row) updateJobRow(row, jobs.get(id));
    }
    dirtyJobs.clear();
  }
  function setOpen(open) {
    state.open = open; $('cdl-shell').hidden = !open;
    $('chzzk-dl-toggle').setAttribute('aria-expanded', String(open));
    $('chzzk-dl-toggle').setAttribute('aria-label', open ? '다운로더 닫기' : '다운로더 열기');
    if (open) { dirtyCatalog = dirtyJobList = true; schedule(); syncJobs(); } else state.all = false;
  }
  function setTab(tab) {
    state.tab = tab;
    for (const name of ['browse', 'jobs']) {
      $(`cdl-${name}`).hidden = name !== tab;
      const node = $(`cdl-${name}-tab`); node.setAttribute('aria-selected', String(name === tab)); node.tabIndex = name === tab ? 0 : -1;
    }
    dirtyCatalog = dirtyJobList = true; schedule();
  }
  $('chzzk-dl-toggle').onclick = () => setOpen(!state.open);
  $('cdl-close').onclick = () => { setOpen(false); $('chzzk-dl-toggle').focus(); };
  $('cdl-browse-tab').onclick = () => setTab('browse'); $('cdl-jobs-tab').onclick = () => setTab('jobs');
  $('cdl-active-summary').onclick = () => setTab('jobs');
  panel.addEventListener('keydown', event => {
    if (event.key === 'Escape' && state.open) { event.stopPropagation(); setOpen(false); $('chzzk-dl-toggle').focus(); }
    if (event.target.getAttribute('role') === 'tab' && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); setTab(event.key === 'Home' ? 'browse' : event.key === 'End' ? 'jobs' : state.tab === 'browse' ? 'jobs' : 'browse'); $(`cdl-${state.tab}-tab`).focus();
    }
  });
  $('cdl-search').oninput = event => { state.search = event.target.value.toLocaleLowerCase(); updateView(true); };
  $('cdl-sort').onchange = event => { state.sort = event.target.value; updateView(true); };
  $('cdl-refresh').onclick = () => loadRoute(true);
  $('cdl-load-more').onclick = () => loadNext();
  $('cdl-load-all').onclick = async () => {
    if (state.all) { state.all = false; catalogChanged(); return; }
    state.all = true;
    while (state.all && state.more && state.open && !state.loading) {
      await loadNext(); if (state.error) break;
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    state.all = false; catalogChanged();
  };
  $('cdl-content').onscroll = () => {
    catalogChanged(); const node = $('cdl-content');
    if (node.scrollHeight - node.scrollTop - node.clientHeight < 180 && state.more && !state.loading && !state.error && !state.all) loadNext();
  };
  $('cdl-log-toggle').onclick = () => {
    const visible = $('cdl-debug').hidden; $('cdl-debug').hidden = !visible; $('cdl-copy-log').hidden = !visible;
    $('cdl-log-toggle').setAttribute('aria-expanded', String(visible));
    text($('cdl-log-toggle'), visible ? '로그 닫기' : '진단 로그'); if (visible) text($('cdl-debug'), logText); catalogChanged();
  };
  $('cdl-copy-log').onclick = () => navigator.clipboard.writeText(logText).then(() => feedback('진단 로그를 복사했습니다.'), () => feedback('로그 복사 권한을 확인해 주세요.'));
  function currentRoute() {
    const match = location.pathname.match(/^\/([a-f0-9]{32})\/(videos|clips)(?:\/|$)/);
    return match ? { channel: match[1], section: match[2], search: location.search } : null;
  }
  function checkRoute() {
    const route = currentRoute(), key = route ? `${route.channel}/${route.section}${route.search}` : '';
    panel.hidden = !route;
    if (key === routeKey) return;
    routeKey = key; state.route = route; scanToken++; scanAbort?.abort(); state.all = false;
    if (!route) { setOpen(false); return; }
    text($('cdl-browse-tab'), route.section === 'clips' ? '클립 목록' : 'VOD 목록');
    state.sort = 'latest'; state.search = ''; $('cdl-search').value = ''; $('cdl-sort').value = 'latest'; loadRoute(false); syncJobs();
  }
  function catalogChanged() { dirtyCatalog = true; schedule(); }
  function mapItem(raw, type) {
    const date = raw.publishDate || raw.createdDate || raw.createdAt || '';
    return { id: String(type === 'clip' ? raw.clipUID || raw.clipId || raw.clipNo || '' : raw.videoNo || raw.videoId || ''), type,
      title: raw.videoTitle || raw.clipTitle || raw.title || '', thumbnail: raw.thumbnailImageUrl || raw.thumbnailUrl || '',
      duration: Number(raw.duration || 0), views: Number(raw.readCount || raw.viewCount || 0), date, timestamp: Date.parse(date) || 0 };
  }
  function mergeItems(extra) {
    const existing = new Map(state.items.map(item => [item.id, item]));
    for (const item of extra) if (item.id) existing.set(item.id, item);
    const added = existing.size - state.items.length; state.items = [...existing.values()]; return added;
  }
  function scanDom() {
    if (!state.route) return;
    const clip = state.route.section === 'clips', regex = clip ? /\/clips\/([A-Za-z0-9_-]+)/ : /\/video\/(\d+)/;
    const existing = new Set(state.items.map(item => item.id)), extra = [];
    for (const link of document.querySelectorAll(clip ? 'a[href*="/clips/"]' : 'a[href*="/video/"]')) {
      const match = link.href.match(regex); if (!match || existing.has(match[1]) || panel.contains(link)) continue;
      const card = link.closest('[class*="card"]') || link;
      extra.push({ id: match[1], type: clip ? 'clip' : 'video', title: card.querySelector('[class*="title"],h3,h4,p')?.textContent?.trim() || match[1], thumbnail: card.querySelector('img')?.src || '', duration: 0, views: 0, date: '', timestamp: 0 }); existing.add(match[1]);
    }
    mergeItems(extra);
  }
  async function loadRoute(refresh) {
    if (!state.route) return;
    scanAbort?.abort(); scanAbort = new AbortController(); const token = ++scanToken;
    state.loading = false; state.error = ''; state.page = 0; state.more = true; state.all = false;
    const saved = cache.get(routeKey);
    if (!refresh && saved && Date.now() - saved.time < 120000) {
      state.items = saved.items.slice(); state.page = saved.page; state.more = saved.more; updateView(true); return;
    }
    state.items = []; scanDom(); updateView(true); await loadNext(token);
  }
  async function loadNext(token = scanToken) {
    if (!state.route || state.loading || !state.more || token !== scanToken) return;
    const route = state.route, page = state.page, signal = scanAbort.signal, key = routeKey;
    state.loading = true; state.error = ''; catalogChanged();
    try {
      const params = new URLSearchParams(route.search);
      const url = route.section === 'videos' ? media.API.videoList(route.channel, page, 24, params.get('sortType') || 'LATEST', params.get('videoType') || '')
        : media.API.clipList(route.channel, page, 24, params.get('orderType') || 'POPULAR', params.get('filterType') || 'ALL');
      const response = await media.fetchJson(url, signal); if (token !== scanToken) return;
      const list = response?.content?.data || response?.data || response?.content?.videos || response?.content?.clips;
      if (!Array.isArray(list)) throw new Error('목록 응답 형식이 변경됐거나 접근할 수 없습니다.');
      const added = mergeItems(list.map(raw => mapItem(raw, route.section === 'clips' ? 'clip' : 'video')));
      state.page++; state.more = list.length >= 24 && (page === 0 || added > 0);
      cache.set(key, { items: state.items.slice(), page: state.page, more: state.more, time: Date.now() });
      if (cache.size > 10) cache.delete(cache.keys().next().value);
      log(`목록 ${state.page}페이지 · ${state.items.length}개`); updateView(false);
    } catch (error) {
      if (token !== scanToken || error.name === 'AbortError') return;
      state.error = error.message; log(`목록 조회 실패: ${error.message}`);
      if (!state.items.length) { scanDom(); updateView(false); }
    } finally { if (token === scanToken) { state.loading = false; catalogChanged(); } }
  }
  function updateView(resetScroll) {
    const direction = state.sort === 'oldest' ? 1 : -1;
    state.view = state.items.filter(item => !state.search || item.title.toLocaleLowerCase().includes(state.search)).sort((a, b) => {
      if (state.sort === 'popular' && a.views !== b.views) return b.views - a.views;
      return (a.timestamp - b.timestamp) * direction || String(a.id).localeCompare(String(b.id), undefined, { numeric: true }) * direction;
    });
    if (resetScroll) $('cdl-content').scrollTop = 0; windowKey = ''; catalogChanged();
  }
  function makeCard(item) {
    const node = element('article', 'cdl-card'); node.dataset.itemId = idFor(item);
    const thumb = element('div', 'cdl-thumb');
    if (/^https?:\/\//.test(item.thumbnail)) { const image = element('img'); image.src = item.thumbnail; image.alt = ''; image.loading = 'lazy'; image.decoding = 'async'; image.onerror = () => image.remove(); thumb.append(image); }
    else thumb.append(element('span', 'cdl-thumb-placeholder', state.route.section === 'clips' ? 'CLIP' : 'VOD'));
    if (item.duration) thumb.append(element('span', 'cdl-duration', formatDuration(item.duration)));
    const info = element('div', 'cdl-card-info'), title = element('div', 'cdl-card-title', item.title || item.id); title.title = item.title;
    info.append(title, element('div', 'cdl-card-meta', [item.date ? formatDate(item.date) : '', item.views ? `${formatCount(item.views)}회` : ''].filter(Boolean).join(' · ')));
    const action = button('다운로드', 'cdl-button cdl-primary', () => startDownload(item)); action.setAttribute('aria-label', `${item.title || item.id} 다운로드`);
    const status = element('span', 'cdl-card-status'), actions = element('div', 'cdl-card-actions'); actions.append(status, action); node.append(thumb, info, actions);
    const result = { node, item, action, status }; updateCard(result); return result;
  }
  function updateCard(card) {
    const job = jobs.get(idFor(card.item)); card.action.disabled = connectionBlocked || Boolean(job && ACTIVE.has(job.status));
    text(card.action, connectionBlocked ? '설치 확인 필요' : job && ACTIVE.has(job.status) ? labels[job.status] : job?.status === 'done' ? '다시 받기' : '다운로드');
    text(card.status, job?.status === 'done' ? '✓ 저장 완료' : job && ACTIVE.has(job.status) ? (job.percent ? `${job.percent}%` : '') : '');
  }
  function renderCatalog() {
    text($('cdl-item-count'), state.search ? `${state.view.length}개 검색됨 / ${state.items.length}개` : `${state.items.length}개${state.loading ? ' · 불러오는 중' : ''}`);
    $('cdl-sort-hint').hidden = !state.more; $('cdl-refresh').disabled = state.loading;
    const empty = $('cdl-empty'); empty.hidden = state.view.length > 0 && !state.error;
    if (!empty.hidden) text(empty, state.error ? `${state.items.length ? '일부 목록만 표시 중입니다. ' : ''}${state.error}` : state.loading ? '영상 목록을 불러오는 중…' : state.search ? '검색 결과가 없습니다.' : '표시할 영상이 없습니다.');
    const clip = state.route?.section === 'clips', columns = clip ? 2 : 1, rowHeight = clip ? 254 : 136;
    const scroll = $('cdl-content'), totalRows = Math.ceil(state.view.length / columns);
    const firstRow = Math.max(0, Math.floor(scroll.scrollTop / rowHeight) - 3);
    const lastRow = Math.min(totalRows, firstRow + Math.ceil((scroll.clientHeight || 400) / rowHeight) + 7);
    const visible = state.view.slice(firstRow * columns, lastRow * columns), nextKey = (clip ? 'clips:' : 'videos:') + visible.map(item => idFor(item)).join(',');
    $('cdl-grid').className = clip ? 'cdl-grid cdl-clips' : 'cdl-grid cdl-videos';
    $('cdl-spacer-top').style.height = `${Math.min(firstRow, totalRows) * rowHeight}px`;
    $('cdl-spacer-bottom').style.height = `${Math.max(0, totalRows - lastRow) * rowHeight}px`;
    if (nextKey !== windowKey) {
      const fragment = document.createDocumentFragment(), keep = new Set();
      for (const item of visible) {
        const id = idFor(item); keep.add(id); let card = itemNodes.get(id);
        if (!card || card.item !== item) { card = makeCard(item); itemNodes.set(id, card); } fragment.append(card.node);
      }
      $('cdl-grid').replaceChildren(fragment); for (const id of itemNodes.keys()) if (!keep.has(id)) itemNodes.delete(id); windowKey = nextKey;
    }
    $('cdl-load-actions').hidden = !state.more; $('cdl-load-more').disabled = state.loading || state.all;
    text($('cdl-load-more'), state.loading ? '불러오는 중…' : state.error ? '목록 다시 시도' : '더 불러오기'); text($('cdl-load-all'), state.all ? '불러오기 중지' : '전체 불러오기');
  }
  function makeJobRow(job) {
    const node = element('article', 'cdl-job'); node.dataset.jobId = job.id;
    const title = element('div', 'cdl-job-title', job.title); title.title = job.title;
    const badge = element('span', 'cdl-job-badge'), head = element('div', 'cdl-job-head'); head.append(title, badge);
    const progress = element('progress', 'cdl-progress'); progress.max = 100; progress.setAttribute('aria-label', `${job.title} 다운로드 진행률`);
    const message = element('div', 'cdl-job-message'), metrics = element('div', 'cdl-job-metrics'), actions = element('div', 'cdl-job-actions');
    const stop = button('중지', 'cdl-button', () => runAction(() => cancel(job.id)));
    const retryButton = button('다시 시도', 'cdl-button cdl-primary', () => runAction(() => retry(job.id)));
    const show = button('파일 보기', 'cdl-button', () => runAction(() => send({ type: 'SHOW_FILE', jobId: job.id })));
    const remove = button('목록에서 지우기', 'cdl-text-button', () => runAction(async () => {
      if (jobs.get(job.id)?.localOnly) { jobs.delete(job.id); dirtyJobList = true; dirtyJobs.add(job.id); schedule(); }
      else await send({ type: 'REMOVE_JOB', jobId: job.id });
    }));
    remove.title = '저장 완료된 파일은 삭제하지 않습니다. 중지된 작업의 임시 데이터는 정리합니다.';
    actions.append(stop, retryButton, show, remove); node.append(head, message, progress, metrics, actions);
    const row = { node, title, badge, progress, message, metrics, stop, retry: retryButton, show, remove }; updateJobRow(row, job); return row;
  }
  function updateJobRow(row, job) {
    if (!job) return;
    const active = ACTIVE.has(job.status); row.node.dataset.status = job.status;
    text(row.badge, labels[job.status] || job.status); text(row.message, job.message || '');
    row.progress.value = job.percent || 0; row.progress.hidden = !active || job.status === 'info' || job.status === 'queued';
    const parts = [];
    if (job.bytesReceived) parts.push(`${formatBytes(job.bytesReceived)}${job.totalBytes ? ' / ' + formatBytes(job.totalBytes) : ''}`);
    if (active && job.speedBps > 0) parts.push(`${formatBytes(job.speedBps)}/s`);
    if (active && job.etaSeconds > 0) parts.push(`약 ${formatEta(job.etaSeconds)} 남음`);
    if (!job.totalBytes && job.totalSegments) parts.push(`${job.completedSegments || 0}/${job.totalSegments} 조각`);
    text(row.metrics, parts.join(' · ')); row.stop.hidden = !active; row.stop.disabled = job.status === 'stopping';
    row.retry.hidden = active || job.status === 'done' || job.status === 'unconfirmed'; text(row.retry, job.hasLocalFile ? '다시 저장' : job.resumable ? '이어받기' : '다시 시도');
    row.show.hidden = job.status !== 'done'; row.remove.hidden = active;
  }
  function renderJobList() {
    const fragment = document.createDocumentFragment();
    if (!jobs.size) fragment.append(element('div', 'cdl-empty', '진행 중인 다운로드가 없습니다. 영상 목록에서 다운로드를 눌러 주세요.'));
    for (const job of [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt)) {
      let row = jobNodes.get(job.id); if (!row) { row = makeJobRow(job); jobNodes.set(job.id, row); } else updateJobRow(row, job); fragment.append(row.node);
    }
    for (const id of jobNodes.keys()) if (!jobs.has(id)) jobNodes.delete(id); $('cdl-job-list').replaceChildren(fragment);
  }
  function receiveJob(job) { const previous = jobs.get(job.id); if (previous && previous.updatedAt > job.updatedAt) return; const fresh = !jobs.has(job.id); jobs.set(job.id, job); dirtyJobs.add(job.id); if (fresh) dirtyJobList = true; schedule(); }
  function syncJobs() {
    if (connectionBlocked) return Promise.resolve();
    if (syncTask) return syncTask;
    syncTask = (async () => {
      try {
        const result = await send({ type: 'GET_JOBS' });
        if (!Array.isArray(result.jobs) || !result.jobs.every(isJobRecord) || (result.runtime && result.runtime.protocol !== 1)) {
          connectionIssue('실행부의 작업 상태 응답 형식이 화면과 일치하지 않습니다.'); return;
        }
        connectionReady = true; lastSyncError = '';
        if (!versionLogged) {
          log(`[구성] 화면 v${UI_VERSION} / 실행부 ${result.runtime?.version ? 'v' + result.runtime.version : '작업 상태 지원 (버전 정보 없음)'} / 설치 v${result.runtime?.manifestVersion || installedVersion()}`);
          versionLogged = true;
        }
        const known = new Set(result.jobs.map(job => job.id));
        for (const [id, job] of jobs) if (!known.has(id) && !job.localOnly && !resolving.has(id)) { jobs.delete(id); dirtyJobs.add(id); dirtyJobList = true; }
        for (const job of result.jobs) if (!resolving.has(job.id)) receiveJob(job);
        schedule();
      } catch (error) {
        if (!connectionBlocked && lastSyncError !== error.message) log('[작업 목록 확인] ' + error.message);
        lastSyncError = error.message;
      }
    })().finally(() => { syncTask = null; });
    return syncTask;
  }
  async function runAction(action) { feedback(''); try { return await action(); } catch (error) { feedback(error.message); log(error.message); } }
  async function cancel(id) { const controller = resolving.get(id); if (controller) controller.abort(); else return send({ type: 'CANCEL_JOB', jobId: id }); }
  async function retry(id) {
    const current = jobs.get(id);
    if (current?.localOnly) return startDownload({ id: current.itemId, type: current.itemKind, title: current.title, thumbnail: current.thumbnail });
    const result = await send({ type: 'RETRY_JOB', jobId: id });
    if (result.resolve) { const job = result.job; await startDownload({ id: job.itemId, type: job.itemKind, title: job.title, thumbnail: job.thumbnail }); }
    else if (result.job) receiveJob(result.job);
  }
  async function startDownload(item) {
    const id = idFor(item); if (resolving.has(id) || ACTIVE.has(jobs.get(id)?.status)) return;
    try { await ensureConnection(); } catch (error) { if (!connectionBlocked) feedback(error.message); return; }
    if (resolving.has(id) || ACTIVE.has(jobs.get(id)?.status)) return;
    const controller = new AbortController(); resolving.set(id, controller); feedback('');
    receiveJob({ id, itemId: item.id, itemKind: item.type, title: item.title, thumbnail: item.thumbnail, createdAt: Date.now(), status: 'info', message: '영상 정보를 확인하는 중', percent: 0, localOnly: true });
    try {
      const result = item.type === 'video' ? await media.resolveVodUrl(item.id, controller.signal) : await media.resolveClipUrl(item.id, controller.signal);
      if (controller.signal.aborted) throw new DOMException('중지됨', 'AbortError');
      const common = { itemId: item.id, itemKind: item.type, title: item.title || item.id, filename: item.title || item.id, thumbnail: item.thumbnail };
      let payload;
      if (result.type === 'mp4') payload = { type: 'DOWNLOAD_DIRECT', url: result.url };
      else if (result.type === 'hls') payload = { type: 'DOWNLOAD_HLS', hlsUrl: result.url, masterText: result.masterText };
      else if (result.type === 'dash_segments') {
        if (result.segmentCount > 120000) throw new Error('DASH 세그먼트 수가 올바르지 않습니다.');
        const segments = result.segments;
        if (!Array.isArray(segments)) throw new Error('DASH 다운로드 계획을 확인할 수 없습니다.');
        if (!segments.length || segments.length > 120000) throw new Error('DASH 세그먼트 수가 올바르지 않습니다.'); payload = { type: 'DOWNLOAD_SEGMENTS', segments };
      } else throw new Error('지원되지 않는 영상 형식입니다.');
      const response = await send({ ...common, ...payload });
      if (!isJobRecord(response.job)) {
        // A previous backend can start the file and return {status:'started'}.
        // Missing tracking information does not establish success or failure.
        receiveJob({ ...jobs.get(id), status: 'unconfirmed', message: '파일 저장 상태를 확인할 수 없습니다. 브라우저 다운로드 목록에서 완료 여부를 확인해 주세요.', localOnly: true });
        connectionIssue('다운로드 요청에 작업 상태 정보가 없는 응답이 왔습니다.'); return;
      }
      receiveJob(response.job);
      if (controller.signal.aborted) await send({ type: 'CANCEL_JOB', jobId: id });
    } catch (error) {
      receiveJob({ ...jobs.get(id), status: error.name === 'AbortError' ? 'cancelled' : 'error', message: error.name === 'AbortError' ? '작업을 중지했습니다.' : error.message, localOnly: !jobs.get(id)?.generation });
      if (error.name !== 'AbortError') feedback(error.message);
    } finally { resolving.delete(id); }
  }
  chrome.runtime.onMessage.addListener(message => {
    if (message.type === 'JOB_UPDATED') receiveJob(message.job);
    else if (message.type === 'JOB_REMOVED') { jobs.delete(message.jobId); dirtyJobs.add(message.jobId); dirtyJobList = true; schedule(); }
    else if (message.type === 'CDL_LOG') log(message.msg);
  });
  function formatDuration(seconds) { const value = Math.floor(seconds); return value >= 3600 ? `${Math.floor(value / 3600)}:${String(Math.floor(value % 3600 / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}` : `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`; }
  function formatCount(value) { return value >= 10000 ? `${(value / 10000).toFixed(1).replace(/\.0$/, '')}만` : value.toLocaleString('ko-KR'); }
  function formatDate(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, '0')}.${String(date.getDate()).padStart(2, '0')}`; }
  function formatBytes(value) { return value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(2)} GiB` : value >= 1024 ** 2 ? `${(value / 1024 ** 2).toFixed(1)} MiB` : `${Math.max(0, value / 1024).toFixed(0)} KiB`; }
  function formatEta(seconds) { return seconds >= 3600 ? `${Math.floor(seconds / 3600)}시간 ${Math.ceil(seconds % 3600 / 60)}분` : seconds >= 60 ? `${Math.ceil(seconds / 60)}분` : `${Math.ceil(seconds)}초`; }
  window.addEventListener('popstate', checkRoute); window.addEventListener('resize', catalogChanged);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { checkRoute(); syncJobs(); } });
  setInterval(() => { if (!document.hidden) checkRoute(); }, 1000);
  setInterval(() => { if (state.open && !document.hidden && [...jobs.values()].some(job => ACTIVE.has(job.status))) syncJobs(); }, 2000);
  checkRoute();
})();
