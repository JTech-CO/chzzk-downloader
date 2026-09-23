// Chzzk Downloader v2.3.3 - durable jobs and browser download coordination.
importScripts('download-core.js', 'media-plan.js', 'metadata-network.js');
// This is the loaded code version; the manifest may already have been replaced on disk.
const RUNTIME_VERSION = '2.3.3';
const { db, active: activeStatuses, terminal: terminalStatuses, safeError } = CdlCore;
const jobs = new Map(), subscribers = new Set(), nativeSamples = new Map();
let creatingOffscreen, recovery, persistChain = Promise.resolve();
const ready = db.all('jobs').then(records => { for (const record of records) jobs.set(record.id, record); });
async function installHeaderRules() {
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [1, 2],
    addRules: ['naver.com', 'pstatic.net'].map((domain, index) => ({ id: index + 1, priority: 1,
      action: { type: 'modifyHeaders', requestHeaders: [
        { header: 'Referer', operation: 'set', value: 'https://chzzk.naver.com/' },
        { header: 'Origin', operation: 'set', value: 'https://chzzk.naver.com' },
      ] }, condition: { initiatorDomains: [chrome.runtime.id], urlFilter: `||${domain}/`, resourceTypes: ['xmlhttprequest'] },
    })),
  });
}
let headerRulesTask;
function ensureHeaderRules() {
  if (!headerRulesTask) headerRulesTask = installHeaderRules().catch(error => { headerRulesTask = null; throw error; });
  return headerRulesTask;
}
chrome.runtime.onInstalled.addListener(() => { ensureHeaderRules().catch(console.error); });
ensureHeaderRules().catch(console.error);
function broadcast(job) {
  for (const tabId of subscribers) chrome.tabs.sendMessage(tabId, { type: 'JOB_UPDATED', job }).catch(() => subscribers.delete(tabId));
}
function persist(job) {
  const snapshot = structuredClone(job);
  const next = persistChain.catch(() => {}).then(() => db.put('jobs', snapshot));
  persistChain = next; return next;
}
async function updateJob(id, patch, generation) {
  await ready;
  const previous = jobs.get(id);
  if (!previous || (generation && previous.generation !== generation)) return null;
  const job = { ...previous, ...patch, updatedAt: Date.now() };
  jobs.set(id, job); broadcast(job); await persist(job); return job;
}
async function hasOffscreen() {
  if (chrome.runtime.getContexts) return (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [chrome.runtime.getURL('offscreen.html')] })).length > 0;
  return (await clients.matchAll()).some(client => client.url === chrome.runtime.getURL('offscreen.html'));
}
async function ensureOffscreen() {
  if (creatingOffscreen) return creatingOffscreen;
  creatingOffscreen = (async () => {
    if (await hasOffscreen()) return;
    await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['BLOBS', 'WORKERS'],
      justification: '영상 조각을 전용 워커에서 받아 임시 파일에 기록하고 완성 파일의 저장 주소를 만듭니다.' });
  })();
  try { await creatingOffscreen; } finally { creatingOffscreen = null; }
}
async function engine(type, payload = {}) {
  await ensureOffscreen();
  const result = await chrome.runtime.sendMessage({ target: 'offscreen', type, ...payload });
  if (!result || result.error) throw new Error(result?.error || '다운로드 실행부가 응답하지 않습니다.');
  return result.result;
}
async function cleanup(jobId) {
  await engine('CLEANUP', { jobId });
  if (jobs.has(jobId)) await updateJob(jobId, { hasLocalFile: false, tempName: null, resumable: false });
}
function jobId(kind, id) { return `${kind === 'clip' ? 'clip' : 'video'}-${normalizeItemId(id)}`; }
async function startJob(message) {
  await ensureHeaderRules();
  await recoverOnce();
  const payload = message.type === 'DOWNLOAD_DIRECT' ? validateDirectMessage(message)
    : message.type === 'DOWNLOAD_HLS' ? validateHlsMessage(message) : validateSegmentsMessage(message);
  const itemKind = message.itemKind === 'clip' ? 'clip' : 'video';
  const id = jobId(itemKind, payload.itemId), previous = jobs.get(id);
  if (previous && activeStatuses.has(previous.status)) return { job: previous };
  const title = String(message.title || message.filename || payload.itemId).slice(0, 500);
  const job = { id, itemId: payload.itemId, itemKind, title,
    thumbnail: typeof message.thumbnail === 'string' ? message.thumbnail.slice(0, 3000) : '',
    generation: crypto.randomUUID(), status: 'queued', message: '다운로드 대기 중',
    createdAt: previous?.createdAt || Date.now(), updatedAt: Date.now(),
    percent: 0, bytesReceived: 0, totalBytes: null, speedBps: 0, etaSeconds: null,
    resumable: false, hasLocalFile: false, mode: null, downloadId: null,
  };
  jobs.set(id, job); broadcast(job); await persist(job);
  if (jobs.get(id)?.status !== 'queued') return { job: jobs.get(id) };
  try { await engine('START', { job: { ...job, ...payload, title, type: message.type } }); }
  catch (error) { await updateJob(id, { status: 'error', message: safeError(error) }, job.generation); throw error; }
  return { job: jobs.get(id) };
}
async function downloadInBrowser(message) {
  await ready;
  const job = jobs.get(message.jobId);
  if (!job || job.generation !== message.generation || !activeStatuses.has(job.status) || job.status === 'stopping') throw new Error('중지되었거나 만료된 저장 요청입니다.');
  const local = message.type === 'SAVE_FILE';
  const url = local ? String(message.url || '') : assertSafeHttpsUrl(message.url, '다운로드 URL');
  if (local && (!url.startsWith(`blob:chrome-extension://${chrome.runtime.id}/`) || !/^cdl_[a-zA-Z0-9_-]+_\d+\.mp4$/.test(message.name || ''))) throw new Error('유효하지 않은 임시 파일 저장 요청입니다.');
  await updateJob(job.id, { status: local ? 'saving' : 'downloading',
    message: local ? '다운로드 폴더에 저장하는 중' : '브라우저가 파일을 받는 중',
    mode: local ? job.mode : 'native', hasLocalFile: local, tempName: local ? message.name : null,
    ...(local ? { percent: 100, speedBps: 0, etaSeconds: null } : {}),
  }, job.generation);
  const downloadId = await new Promise((resolve, reject) => {
    chrome.downloads.download({ url, filename: sanitize(job.title) + '.mp4' }, id => {
      if (chrome.runtime.lastError || id === undefined) reject(new Error(chrome.runtime.lastError?.message || '파일 저장을 시작하지 못했습니다.'));
      else resolve(id);
    });
  });
  const current = jobs.get(job.id);
  if (!current || current.generation !== job.generation || current.status === 'stopping' || terminalStatuses.has(current.status)) {
    await chrome.downloads.cancel(downloadId).catch(() => {}); throw new Error('작업을 중지했습니다.');
  }
  await updateJob(job.id, { downloadId }, job.generation);
  await refreshNativeJob(jobs.get(job.id));
  return { downloadId };
}
async function refreshNativeJob(job) {
  if (job.downloadId == null) return;
  const [item] = await chrome.downloads.search({ id: job.downloadId });
  const current = jobs.get(job.id);
  if (!current || current.generation !== job.generation || current.downloadId !== job.downloadId) return;
  if (current.status === "done" && item?.state !== "complete") return;
  job = current;
  if (!item) {
    if (activeStatuses.has(job.status)) await updateJob(job.id, { status: 'interrupted', message: '브라우저 다운로드 기록을 찾을 수 없습니다.' }, job.generation);
    return;
  }
  if (item.state === 'complete') {
    await updateJob(job.id, { status: 'done', message: '파일 저장 완료', percent: 100, speedBps: 0, etaSeconds: 0,
      bytesReceived: Math.max(0, item.totalBytes), totalBytes: Math.max(0, item.totalBytes) }, job.generation);
    if (job.hasLocalFile) await cleanup(job.id).catch(error => console.warn('Temporary cleanup deferred:', safeError(error)));
    return;
  }
  if (item.state === 'interrupted' || item.paused) {
    await updateJob(job.id, { status: item.paused || job.status === 'stopping' ? 'paused' : 'interrupted',
      message: item.paused ? '다운로드를 일시 중지했습니다.' : `저장 중단: ${item.error || '브라우저에서 중단됨'}`,
      resumable: Boolean(item.canResume || job.hasLocalFile), canResumeNative: Boolean(item.canResume || item.paused), speedBps: 0, etaSeconds: null }, job.generation);
    return;
  }
  if (job.status === 'stopping') return;
  const now = Date.now(), last = nativeSamples.get(job.downloadId);
  const speedBps = last && now > last.time ? Math.max(0, item.bytesReceived - last.bytes) * 1000 / (now - last.time) : 0;
  nativeSamples.set(job.downloadId, { time: now, bytes: item.bytesReceived });
  const totalBytes = item.totalBytes > 0 ? item.totalBytes : null;
  await updateJob(job.id, { status: job.hasLocalFile ? 'saving' : 'downloading',
    message: job.hasLocalFile ? '다운로드 폴더에 저장하는 중' : '브라우저가 파일을 받는 중',
    ...(job.hasLocalFile ? {} : { bytesReceived: item.bytesReceived, totalBytes, speedBps,
      percent: totalBytes ? Math.floor(item.bytesReceived / totalBytes * 100) : 0,
      etaSeconds: totalBytes && speedBps ? Math.max(0, (totalBytes - item.bytesReceived) / speedBps) : null }),
  }, job.generation);
}
async function reconcileJobs() {
  await ready;
  const live = await hasOffscreen() ? await engine('SNAPSHOT') : [];
  const current = new Map(live.map(job => [job.id, job]));
  for (const job of [...jobs.values()]) {
    if (!activeStatuses.has(job.status)) continue;
    if (job.downloadId != null) { await refreshNativeJob(job); continue; }
    const running = current.get(job.id);
    if (running?.generation === job.generation) { const { id, generation, ...patch } = running; await updateJob(id, patch, generation); continue; }
    const checkpoint = await db.get('checkpoints', job.id);
    await updateJob(job.id, { status: 'interrupted', message: '브라우저 실행이 중단됐습니다. 작업을 다시 시작해 주세요.',
      resumable: Boolean(job.hasLocalFile || checkpoint?.kind === 'range' && checkpoint.validator?.value && checkpoint.completed?.length), speedBps: 0, etaSeconds: null }, job.generation);
  }
}
async function recoverOnce() {
  await ready;
  if (!recovery) recovery = reconcileJobs().catch(error => { recovery = null; throw error; });
  await recovery;
}
async function getJobs() {
  await recoverOnce();
  await Promise.all([...jobs.values()].filter(job => job.downloadId != null && activeStatuses.has(job.status)).map(refreshNativeJob));
  return { jobs: [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt),
    runtime: { protocol: 1, version: RUNTIME_VERSION, manifestVersion: chrome.runtime.getManifest?.()?.version || null } };
}
async function cancelJob(id) {
  await ready;
  const job = jobs.get(id);
  if (!job || !activeStatuses.has(job.status)) return { ok: true };
  await updateJob(id, { status: 'stopping', message: '작업을 중지하는 중' }, job.generation);
  if (job.downloadId != null) {
    try { await chrome.downloads.pause(job.downloadId); }
    catch (_) { await chrome.downloads.cancel(job.downloadId).catch(() => {}); }
    await refreshNativeJob(jobs.get(id));
  } else {
    const result = await engine('CANCEL', { jobId: id });
    if (result.found === false && jobs.get(id)?.status === 'stopping') await updateJob(id, {
      status: job.hasLocalFile ? 'paused' : 'cancelled', message: '작업을 중지했습니다.',
      resumable: Boolean(job.hasLocalFile), speedBps: 0, etaSeconds: null,
    }, job.generation);
  }
  return { ok: true };
}
async function retryJob(id) {
  await ready;
  const job = jobs.get(id);
  if (!job) throw new Error('작업을 찾을 수 없습니다.');
  if (activeStatuses.has(job.status)) return { job };
  if (job.downloadId != null && job.canResumeNative) {
    try {
      await chrome.downloads.resume(job.downloadId);
      await updateJob(id, { status: job.hasLocalFile ? 'saving' : 'downloading', message: '다운로드를 계속하는 중' });
      return { job: jobs.get(id) };
    } catch (_) { /* Refresh the playback URL if Chrome can no longer resume it. */ }
  }
  if (job.hasLocalFile && job.tempName) {
    const generation = crypto.randomUUID();
    await updateJob(id, { generation, downloadId: null, status: 'saving', message: '받아 둔 파일을 다시 저장하는 중' });
    try { await engine('SAVE_EXISTING', { jobId: id, generation, name: job.tempName }); }
    catch (error) { await updateJob(id, { status: 'error', message: safeError(error) }, generation); throw error; }
    return { job: jobs.get(id) };
  }
  return { resolve: true, job };
}
async function removeJob(id) {
  await ready;
  const job = jobs.get(id);
  if (!job) return { ok: true };
  if (activeStatuses.has(job.status)) throw new Error('먼저 작업을 중지해 주세요.');
  if (job.downloadId != null && job.status !== 'done') await chrome.downloads.cancel(job.downloadId).catch(() => {});
  await engine('CLEANUP', { jobId: id });
  await persistChain.catch(() => {}); await db.delete('jobs', id); jobs.delete(id);
  for (const tabId of subscribers) chrome.tabs.sendMessage(tabId, { type: 'JOB_REMOVED', jobId: id }).catch(() => {});
  return { ok: true };
}
chrome.downloads.onChanged.addListener(delta => {
  if (!delta.state && !delta.paused && !delta.error) return;
  ready.then(async () => {
    const job = [...jobs.values()].find(job => job.downloadId === delta.id);
    if (job) await refreshNativeJob(job);
  }).catch(console.error);
});
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target === 'offscreen') return false;
  const offscreen = sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL('offscreen.html');
  const content = isTrustedContentSender(sender);
  if (!offscreen && !content) { sendResponse({ error: '허용되지 않은 메시지 발신자입니다.' }); return false; }
  if (content && Number.isInteger(sender.tab.id)) subscribers.add(sender.tab.id);
  (async () => {
    if (offscreen) {
      if (message.type === 'SAVE_FILE' || message.type === 'NATIVE_DOWNLOAD') return downloadInBrowser(message);
      if (message.type === 'ENGINE_EVENT') {
        await ready;
        const previous = jobs.get(message.jobId);
        if (!previous || previous.generation !== message.generation || terminalStatuses.has(previous.status)) return { ok: true };
        if (previous.status === 'stopping' && !terminalStatuses.has(message.patch.status)) return { ok: true };
        await updateJob(message.jobId, message.patch, message.generation); return { ok: true };
      }
      if (message.type === 'ENGINE_LOG') {
        for (const tabId of subscribers) chrome.tabs.sendMessage(tabId, { type: 'CDL_LOG', msg: `[다운로드] ${message.message}` }).catch(() => {});
        return { ok: true };
      }
      if (message.type === 'ENGINE_FAILED') { recovery = null; await reconcileJobs(); return { ok: true }; }
      throw new Error('알 수 없는 실행부 메시지입니다.');
    }
    if (message.type === 'FETCH_METADATA') return fetchMetadata(message, sender);
    if (message.type === 'CANCEL_METADATA') return cancelMetadata(message, sender);
    if (['DOWNLOAD_DIRECT', 'DOWNLOAD_HLS', 'DOWNLOAD_SEGMENTS'].includes(message.type)) return startJob(message);
    if (message.type === 'GET_JOBS') return getJobs();
    if (message.type === 'CANCEL_JOB') return cancelJob(String(message.jobId));
    if (message.type === 'RETRY_JOB') return retryJob(String(message.jobId));
    if (message.type === 'REMOVE_JOB') return removeJob(String(message.jobId));
    if (message.type === 'SHOW_FILE') {
      await ready; const job = jobs.get(String(message.jobId));
      if (job?.status === 'done' && job.downloadId != null) { chrome.downloads.show(job.downloadId); return { ok: true }; }
      throw new Error('완료된 파일을 찾을 수 없습니다.');
    }
    throw new Error('알 수 없는 메시지입니다.');
  })().then(sendResponse, error => sendResponse({ error: safeError(error) }));
  return true;
});
