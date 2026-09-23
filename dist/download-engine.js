// Runs in a dedicated worker owned by the offscreen document, independently of SW restarts.
importScripts('download-core.js', 'media-plan.js', 'mp4.js');
const { MiB, db, throwIfAborted, sleep, safeError, SpeedMeter, RequestScheduler } = CdlCore;
const network = new RequestScheduler({ limit: 8, initial: 4 });
const jobs = new Map(), queue = [], pendingRpc = new Map();
const MAX_ACTIVE_JOBS = 2;
const REORDER_BUDGET = 64 * MiB;
let runningJobs = 0, rpcSequence = 0;

function rpc(type, payload) {
  const requestId = ++rpcSequence;
  return new Promise((resolve, reject) => {
    pendingRpc.set(requestId, { resolve, reject });
    postMessage({ type: 'RPC', requestId, action: type, ...payload });
  });
}
function event(job, patch) {
  job.lastEvent = { ...job.lastEvent, ...patch };
  postMessage({ type: 'EVENT', jobId: job.id, generation: job.generation, patch });
}
function log(job, message) { postMessage({ type: 'LOG', jobId: job.id, message }); }
function makeProgress(job, totalBytes, totalSegments, initialBytes = 0, initialSegments = 0) {
  const meter = new SpeedMeter();
  const inFlight = new Map();
  let written = initialBytes, done = initialSegments, lastTime = 0, received = 0;
  meter.update(0);
  const update = (force = false) => {
    const now = Date.now();
    if (!force && now - lastTime < 300) return;
    lastTime = now;
    const bytesReceived = written + [...inFlight.values()].reduce((a, b) => a + b, 0);
    const speedBps = meter.update(received);
    event(job, {
      status: 'downloading', message: '영상 데이터를 받는 중',
      bytesReceived, writtenBytes: written, totalBytes, completedSegments: done, totalSegments,
      percent: totalBytes ? Math.min(100, Math.floor(bytesReceived / totalBytes * 100)) : Math.floor(done / totalSegments * 100),
      speedBps, etaSeconds: totalBytes && speedBps > 0 ? Math.max(0, (totalBytes - bytesReceived) / speedBps) : null,
      resumable: job.mode === 'parallel-range' && Boolean(job.validator), mode: job.mode,
    });
  };
  return {
    receiving(index, bytes) {
      const previous = inFlight.get(index) || 0;
      if (bytes > previous) received += bytes - previous;
      inFlight.set(index, bytes); update();
    },
    complete(index, bytes) { inFlight.delete(index); written += bytes; done++; update(done === totalSegments); },
    clear(index) { inFlight.delete(index); update(); },
    update,
  };
}

async function fetchResponse(url, options, signal, headerTimeout = 30000) {
  throwIfAborted(signal);
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, headerTimeout);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return {
      response, controller,
      cleanup() { clearTimeout(timer); signal?.removeEventListener('abort', abort); },
    };
  } catch (error) {
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
    throwIfAborted(signal);
    if (timedOut) throw new DOMException('서버 응답 시간 초과', 'TimeoutError');
    throw error;
  }
}
async function cancelResponseBody(response) { try { await response.body?.cancel(); } catch (_) {} }
async function readResponseBuffer(response, expectedBytes, onBytes, controller, limit = MAX_SEGMENT_BYTES) {
  const maxBytes = expectedBytes || limit;
  if (expectedBytes > limit) throw new Error('세그먼트 크기 제한 초과');
  if (!response.body?.getReader) {
    const bytes = await response.arrayBuffer();
    assertBufferSize(bytes.byteLength, expectedBytes, maxBytes);
    onBytes?.(bytes.byteLength); return bytes;
  }
  const reader = response.body.getReader();
  const fixed = expectedBytes ? new Uint8Array(expectedBytes) : null;
  const chunks = [];
  let size = 0, timer, stalled = false;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { stalled = true; controller?.abort(); reader.cancel().catch(() => {}); }, 30000);
  };
  try {
    while (true) {
      arm(); const { done, value } = await reader.read(); clearTimeout(timer);
      if (stalled) throw new DOMException('데이터 수신이 30초 동안 멈췄습니다.', 'TimeoutError');
      if (done) break;
      if (!value) continue;
      if (size + value.byteLength > maxBytes) { await reader.cancel(); throw new Error('응답 크기 제한 초과'); }
      if (fixed) fixed.set(value, size); else chunks.push(value);
      size += value.byteLength; onBytes?.(size);
    }
    assertBufferSize(size, expectedBytes, maxBytes);
    if (fixed) return fixed.buffer;
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result.buffer;
  } finally { clearTimeout(timer); reader.releaseLock(); }
}
function assertBufferSize(actual, expected, max) {
  if (actual > max) throw new Error('응답 크기 제한 초과');
  if (expected != null && actual !== expected) throw new Error(`Range 크기 불일치: ${actual}B != ${expected}B`);
}
function isRetryableBodyError(error) {
  return ['TypeError', 'AbortError', 'TimeoutError'].includes(error?.name)
    || /network|fetch|terminated|connection|body stream|Range 크기 불일치: \d+B !=/i.test(error?.message || '');
}
async function fetchSeg(segment, signal, creds, attempts = 4, onBytes, stage = '영상 조각') {
  const url = assertSafeHttpsUrl(typeof segment === 'string' ? segment : segment.url, '세그먼트 URL');
  const range = typeof segment === 'string' ? null : segment.range;
  const expected = range ? rangeLength(range) : null;
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    throwIfAborted(signal); onBytes?.(0);
    const release = await network.acquire(url, signal);
    let result, status = 0, size = 0, retryAfter = null;
    try {
      result = await fetchResponse(url, { credentials: creds, ...(range ? { headers: { Range: `bytes=${range}` } } : {}) }, signal);
      const response = result.response;
      status = response.status; retryAfter = response.headers.get('retry-after');
      assertSafeHttpsUrl(response.url || url, '세그먼트 응답 URL');
      if (status === 429 || status >= 500) {
        await cancelResponseBody(response);
        lastError = new Error(`HTTP ${status}`);
      } else {
        if (range && status !== 206) { await cancelResponseBody(response); throw new Error(`Range 응답 오류: HTTP ${status}`); }
        if (!response.ok) { await cancelResponseBody(response); throw new Error(`HTTP ${status}`); }
        const declared = Number(response.headers.get('content-length'));
        if (declared > MAX_SEGMENT_BYTES || (expected && declared > expected)) {
          await cancelResponseBody(response); throw new Error('Range 크기 불일치 또는 세그먼트 크기 제한 초과');
        }
        if (range && segment.totalBytes) validateDirectRangeResponse(response, range, segment.totalBytes, segment.validator);
        const bytes = await readResponseBuffer(response, expected, onBytes, result.controller);
        size = bytes.byteLength; return bytes;
      }
    } catch (error) {
      throwIfAborted(signal);
      if (!isRetryableBodyError(error)) { if (result) await cancelResponseBody(result.response); throw new Error(`${stage} 요청 실패 (${new URL(url).hostname}): ${safeError(error)}`); }
      lastError = error; status = 0;
    } finally { result?.cleanup(); release(size, status); }
    if (attempt < attempts - 1) await sleep(CdlCore.retryDelay(attempt, retryAfter), signal);
  }
  throw new Error(`${stage} 요청 ${attempts}회 실패 (${new URL(url).hostname}): ${safeError(lastError)}`);
}
async function probeDirectRange(url, signal) {
  const safeUrl = assertSafeHttpsUrl(url, '다운로드 URL');
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await probeDirectRangeOnce(safeUrl, signal); }
    catch (error) {
      throwIfAborted(signal);
      const networkError = ['TypeError', 'TimeoutError'].includes(error.name);
      const retryable = networkError || error.status === 429 || error.status >= 500;
      const delay = CdlCore.retryDelay(attempt, error.retryAfter);
      if (!retryable || delay > 5000) throw new Error('MP4 사전 확인 실패 (' + new URL(safeUrl).hostname + '): ' + safeError(error));
      if (attempt === 2) {
        if (networkError) return { supported: false, url: safeUrl, reason: 'network' };
        throw new Error('MP4 사전 확인 실패 (' + new URL(safeUrl).hostname + '): ' + safeError(error));
      }
      await sleep(delay, signal);
    }
  }
}
async function probeDirectRangeOnce(url, signal) {
  const safeUrl = assertSafeHttpsUrl(url, '다운로드 URL');
  const release = await network.acquire(safeUrl, signal);
  let result;
  try {
    result = await fetchResponse(safeUrl, { credentials: 'include', headers: { Range: 'bytes=0-0' } }, signal);
    const response = result.response;
    const finalUrl = assertSafeHttpsUrl(response.url || safeUrl, '다운로드 응답 URL');
    const range = parseContentRange(response.headers.get('content-range'));
    if (response.status !== 206 || !range || range.start !== 0 || range.end !== 0) {
      await cancelResponseBody(response);
      if (response.status >= 400 && response.status !== 416) { const error = new Error(`사전 확인 HTTP ${response.status}`); error.status = response.status; error.retryAfter = response.headers.get('retry-after'); throw error; }
      return { supported: false, url: finalUrl, reason: `HTTP ${response.status}` };
    }
    await readResponseBuffer(response, 1, null, result.controller);
    const etag = response.headers.get('etag'), modified = response.headers.get('last-modified');
    const validator = etag && !/^W\//i.test(etag) ? { type: 'etag', value: etag }
      : modified ? { type: 'last-modified', value: modified } : null;
    return { supported: true, url: finalUrl, totalBytes: range.total, validator };
  } finally { result?.cleanup(); release(1, result?.response.status || 0); }
}
// Wait for all cancelled workers before closing/removing their output file.
async function runWorkerPool(segments, creds, ac, onChunk, waitBeforeFetch, concurrency = CONCURRENT, onBytes) {
  let next = 0, firstError;
  const worker = async () => {
    try {
      while (next < segments.length) {
        throwIfAborted(ac.signal);
        const i = next++;
        if (waitBeforeFetch) await waitBeforeFetch(i);
        throwIfAborted(ac.signal);
        const bytes = await fetchSeg(segments[i], ac.signal, creds, 4, size => onBytes?.(i, size));
        throwIfAborted(ac.signal);
        await onChunk(i, bytes);
      }
    } catch (error) { if (!firstError) firstError = error; ac.abort(); }
  };
  await Promise.all(Array.from({ length: Math.min(normalizeConcurrency(concurrency), segments.length) }, worker));
  if (firstError) throw firstError;
  throwIfAborted(ac.signal);
}
function validFileName(name) { return /^cdl_[a-zA-Z0-9_-]+_\d+\.mp4$/.test(String(name || '')); }
async function removeTemporaryFile(name) {
  if (!validFileName(name)) return;
  const root = await navigator.storage.getDirectory();
  try { await root.removeEntry(name); } catch (error) { if (error.name !== 'NotFoundError') throw error; }
}
async function removeCheckpoint(id) {
  const checkpoint = await db.get('checkpoints', id);
  await removeTemporaryFile(checkpoint?.name);
  await db.delete('checkpoints', id);
}
async function openFile(job, checkpoint = null) {
  const root = await navigator.storage.getDirectory();
  const name = checkpoint?.name || `cdl_${job.id.replace(/[^a-zA-Z0-9_-]/g, '')}_${Date.now()}.mp4`;
  if (!validFileName(name)) throw new Error('임시 파일 이름이 올바르지 않습니다.');
  const file = await root.getFileHandle(name, { create: !checkpoint });
  try {
    if (typeof file.createSyncAccessHandle !== 'function') throw new Error('디스크 스트리밍을 지원하는 최신 Chrome/Whale이 필요합니다.');
    const handle = await file.createSyncAccessHandle();
    job.writerOpen = true;
    return { name, handle, close() { if (job.writerOpen) { handle.close(); job.writerOpen = false; } } };
  } catch (error) {
    // A newly created file has no checkpoint yet. Do not leave it untracked.
    if (!checkpoint) await removeTemporaryFile(name).catch(() => {});
    throw error;
  }
}
function writeAt(handle, buffer, position) {
  const bytes = new Uint8Array(buffer);
  let written = 0;
  while (written < bytes.byteLength) {
    const count = handle.write(bytes.subarray(written), { at: position + written });
    if (!count) throw new Error('디스크에 데이터를 기록하지 못했습니다.');
    written += count;
  }
}
function isStorageQuotaError(error) { return error?.name === 'QuotaExceededError'; }
function storageSize(bytes) { return bytes < MiB ? Math.ceil(bytes) + ' B' : (bytes / MiB).toFixed(1) + ' MiB'; }
async function reportStorageEstimate(job, totalBytes, fileBytes) {
  if (typeof navigator.storage.estimate !== 'function') return;
  // Estimates are advisory. Existing file extent is already included in usage,
  // including sparse ranges; only actual writes can establish a quota failure.
  try {
    const { quota, usage } = await navigator.storage.estimate();
    if (![quota, usage].every(value => Number.isFinite(value) && value >= 0)) return;
    const growth = Math.max(0, totalBytes - fileBytes), available = Math.max(0, quota - usage);
    log(job, '[저장소] 추정 한도 ' + storageSize(quota) + ', 사용 ' + storageSize(usage)
      + ', 기존 파일 ' + storageSize(fileBytes) + ', 추가 파일 증가 ' + storageSize(growth)
      + (available < growth ? ' · 추정 여유가 작아 실제 기록을 시도합니다.' : ''));
  } catch (_) { log(job, '[저장소] 용량 추정치를 조회하지 못해 실제 기록을 시도합니다.'); }
}
async function downloadNatively(job, probe, storageFallback = false) {
  // A range failure aborts its own worker pool. Only user cancellation prevents
  // the fallback after that pool has drained and released its output handle.
  if (job.userCancelled) throw CdlCore.abortError();
  if (!storageFallback) throwIfAborted(job.ac.signal);
  job.mode = 'native'; job.validator = null;
  event(job, { status: 'downloading', message: '브라우저가 파일을 받는 중', mode: 'native',
    bytesReceived: 0, writtenBytes: 0, totalBytes: probe.totalBytes || null,
    completedSegments: 0, totalSegments: 0, percent: 0, speedBps: 0, etaSeconds: null, resumable: false });
  await rpc('NATIVE_DOWNLOAD', { jobId: job.id, generation: job.generation, url: probe.url, filename: sanitize(job.title) + '.mp4' });
}
async function directDownload(job) {
  const { signal } = job.ac;
  event(job, { status: 'info', message: '파일 크기와 다운로드 방식을 확인하는 중', percent: 0 });
  const probe = await probeDirectRange(job.url, signal);
  throwIfAborted(signal);
  if (probe.reason === 'network') log(job, '[MP4 사전 확인] 연결 재시도 후에도 실패해 브라우저 기본 다운로드로 전환합니다.');
  if (!probe.supported || probe.totalBytes < DIRECT_RANGE_MIN_BYTES) return downloadNatively(job, probe);
  const output = {};
  let name;
  try { name = await downloadDirectRanges(job, probe, output); }
  catch (error) {
    if (!isStorageQuotaError(error)) throw error;
    // Clean this job only, even if the first checkpoint could not be persisted.
    await removeTemporaryFile(output.name);
    await removeCheckpoint(job.id);
    if (job.userCancelled) throw CdlCore.abortError();
    log(job, '[저장소] 실제 임시 저장 한도에 도달해 브라우저 기본 다운로드로 전환합니다. 파일을 처음부터 다시 받습니다.');
    return downloadNatively(job, probe, true);
  }
  // A failure during the final browser save must never start a second transfer.
  await deliverDownload(job, name);
}
async function downloadDirectRanges(job, probe, output) {
  job.mode = 'parallel-range'; job.validator = probe.validator;
  const segments = buildDirectRangeSegments(probe);
  let checkpoint = await db.get('checkpoints', job.id), file, completed = new Set();
  if (CdlCore.resumableCheckpoint(checkpoint, probe, DIRECT_RANGE_CHUNK_BYTES) && validFileName(checkpoint.name)
      && Array.isArray(checkpoint.completed) && checkpoint.completed.every(i => Number.isInteger(i) && i >= 0 && i < segments.length)) {
    try {
      file = await openFile(job, checkpoint);
      completed = new Set(checkpoint.completed);
      const size = file.handle.getSize();
      if (size > probe.totalBytes || [...completed].some(i => Number(segments[i].range.split('-')[1]) >= size)) {
        throw new Error('임시 파일 검증 실패');
      }
    } catch (error) {
      file?.close(); file = null; completed.clear();
      if (isStorageQuotaError(error)) throw error;
    }
  }
  if (!file) {
    await removeCheckpoint(job.id);
    file = await openFile(job);
    checkpoint = { id: job.id, kind: 'range', name: file.name, source: CdlCore.sourceKey(probe.url),
      validator: probe.validator, totalBytes: probe.totalBytes, chunkBytes: DIRECT_RANGE_CHUNK_BYTES, completed: [] };
  }
  output.name = file.name;
  const completedBytes = () => [...completed].reduce((sum, i) => sum + rangeLength(segments[i].range), 0);
  let checkpointWrites = Promise.resolve();
  const save = () => {
    checkpointWrites = checkpointWrites.then(async () => {
      file.handle.flush();
      await db.put('checkpoints', { ...checkpoint, completed: [...completed], updatedAt: Date.now() });
    });
    return checkpointWrites;
  };
  const progress = makeProgress(job, probe.totalBytes, segments.length, completedBytes(), completed.size);
  const remaining = segments.map((segment, index) => ({ ...segment, index })).filter(segment => !completed.has(segment.index));
  try {
    await reportStorageEstimate(job, probe.totalBytes, file.handle.getSize());
    throwIfAborted(job.ac.signal);
    await save();
    log(job, `MP4 ${segments.length}개 구간, ${completed.size}개 복원, 전체 요청 상한 8개`);
    progress.update(true);
    await runWorkerPool(remaining, 'include', job.ac, async (i, buffer) => {
      const segment = remaining[i];
      writeAt(file.handle, buffer, Number(segment.range.split('-')[0]));
      completed.add(segment.index);
      progress.complete(i, buffer.byteLength);
      if (completed.size % 8 === 0) await save();
    }, null, CONCURRENT, (i, size) => progress.receiving(i, size));
    if (completed.size !== segments.length || completedBytes() !== probe.totalBytes) throw new Error('완성 파일 크기 불일치');
    file.handle.truncate(probe.totalBytes); await save();
  } catch (error) {
    try { await save(); } catch (_) {}
    throw error;
  } finally { await checkpointWrites.catch(() => {}); file.close(); }
  return file.name;
}
async function downloadStreaming(job, segments, creds, finalizer = null) {
  if (!segments.length || segments.length > MAX_SEGMENT_COUNT) throw new Error('세그먼트 수가 허용 범위를 벗어났습니다.');
  validateSegmentPlan(segments);
  await removeCheckpoint(job.id);
  const file = await openFile(job);
  const buffer = new Map(), waiters = new Set(), reservations = new Map();
  let writeIndex = 0, offset = 0, bufferedBytes = 0, reservedBytes = 0, averageBytes = 2 * MiB;
  const progress = makeProgress(job, null, segments.length);
  const wake = () => { for (const resolve of waiters) resolve(); waiters.clear(); };
  job.ac.signal.addEventListener('abort', wake);
  const waitForSpace = async i => {
    while ((bufferedBytes + reservedBytes >= REORDER_BUDGET || i >= writeIndex + 128) && i !== writeIndex) {
      throwIfAborted(job.ac.signal);
      await new Promise(resolve => waiters.add(resolve));
    }
    throwIfAborted(job.ac.signal);
    const estimate = typeof segments[i] === 'object' && segments[i].range ? rangeLength(segments[i].range) : averageBytes;
    reservations.set(i, estimate); reservedBytes += estimate;
  };
  try {
    await db.put('checkpoints', { id: job.id, kind: 'segments', name: file.name, updatedAt: Date.now() });
    progress.update(true);
    await runWorkerPool(segments, creds, job.ac, (i, bytes) => {
      reservedBytes -= reservations.get(i) || 0; reservations.delete(i);
      averageBytes = averageBytes * 0.8 + bytes.byteLength * 0.2;
      buffer.set(i, finalizer ? finalizer.transform(i, bytes) : bytes); bufferedBytes += bytes.byteLength;
      while (buffer.has(writeIndex)) {
        const chunk = buffer.get(writeIndex); buffer.delete(writeIndex); bufferedBytes -= chunk.byteLength;
        if (finalizer) finalizer.record(writeIndex, chunk, BigInt(offset));
        writeAt(file.handle, chunk, offset); offset += chunk.byteLength;
        progress.complete(writeIndex, chunk.byteLength); writeIndex++;
      }
      wake();
    }, waitForSpace, CONCURRENT, (i, size) => progress.receiving(i, size));
    if (writeIndex !== segments.length) throw new Error('일부 영상 조각이 누락됐습니다.');
    event(job, { status: 'merging', message: '재생 시간과 탐색 정보를 마무리하는 중', percent: 100 });
    const trailer = finalizer?.buildTrailer();
    if (trailer) { writeAt(file.handle, trailer, offset); offset += trailer.byteLength; }
    file.handle.truncate(offset); file.handle.flush();
  } catch (error) {
    file.close();
    await removeTemporaryFile(file.name).catch(() => {});
    await removeCheckpoint(job.id).catch(() => {});
    throw error;
  } finally { file.close(); job.ac.signal.removeEventListener('abort', wake); wake(); buffer.clear(); }
  throwIfAborted(job.ac.signal);
  await deliverDownload(job, file.name);
}
async function fetchHlsText(url, signal, creds) {
  // Use the same retry/timeout/global concurrency policy as media requests.
  const bytes = await fetchSeg(assertSafeHttpsUrl(url, 'HLS 재생목록 URL'), signal, creds, 4, null, 'HLS 재생목록');
  if (bytes.byteLength > MAX_PLAYLIST_TEXT) throw new Error('HLS 재생목록이 비정상적으로 큽니다.');
  return new TextDecoder().decode(bytes);
}
async function hlsDownload(job) {
  event(job, { status: 'info', message: '영상 조각 목록을 확인하는 중', percent: 0 });
  const master = job.masterText || await fetchHlsText(job.hlsUrl, job.ac.signal, 'omit');
  let media = master, mediaUrl = job.hlsUrl;
  if (master.includes('#EXT-X-STREAM-INF')) {
    const lines = master.split(/\r?\n/).map(line => line.trim());
    let selected = null;
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
      const attrs = parseHlsAttrs(lines[i]);
      if (lines[i + 1] && !lines[i + 1].startsWith('#') && (!selected || Number(attrs.BANDWIDTH) > selected.bandwidth)) {
        selected = { attrs, bandwidth: Number(attrs.BANDWIDTH) || 0, url: resolve(job.hlsUrl, lines[i + 1]) };
      }
    }
    if (!selected) throw new Error('지원되는 HLS 영상 스트림이 없습니다.');
    if (selected.attrs.AUDIO && lines.some(line => {
      if (!line.startsWith('#EXT-X-MEDIA:')) return false;
      const attrs = parseHlsAttrs(line);
      return attrs.TYPE === 'AUDIO' && attrs['GROUP-ID'] === selected.attrs.AUDIO && attrs.URI;
    })) throw new Error('별도 오디오 트랙을 사용하는 HLS는 아직 지원하지 않습니다.');
    mediaUrl = selected.url; media = await fetchHlsText(mediaUrl, job.ac.signal, 'omit');
  }
  const parsed = parseHlsMediaPlaylist(media, mediaUrl);
  if (!parsed.initIndexes.length) throw new Error('이 HLS의 영상 형식은 지원하지 않습니다. fMP4 초기화 정보가 필요합니다.');
  const independent = parsed.independentSegments || /^#EXT-X-INDEPENDENT-SEGMENTS\s*$/m.test(master);
  const finalizer = createFragmentedMp4Finalizer(parsed.durationSeconds, parsed.initIndexes, independent);
  job.mode = 'hls';
  log(job, `HLS ${parsed.segments.length}개 조각, ${Math.round(parsed.durationSeconds)}초`);
  await downloadStreaming(job, parsed.segments.map(normalizeSegment), 'omit', finalizer);
}
async function deliverDownload(job, name) {
  throwIfAborted(job.ac.signal);
  event(job, { status: 'saving', message: '다운로드 폴더에 저장하는 중', percent: 100, speedBps: 0, etaSeconds: null });
  await rpc('SAVE_FILE', { jobId: job.id, generation: job.generation, name, filename: sanitize(job.title) + '.mp4' });
}
async function execute(job) {
  try {
    if (job.type === 'DOWNLOAD_DIRECT') await directDownload(job);
    else if (job.type === 'DOWNLOAD_HLS') await hlsDownload(job);
    else { job.mode = 'dash'; await downloadStreaming(job, job.segments, 'include'); }
  } catch (error) {
    const checkpoint = await db.get('checkpoints', job.id).catch(() => null);
    const resumable = Boolean(checkpoint?.kind === 'range' && checkpoint.validator?.value && checkpoint.completed?.length);
    const cancelled = error.name === 'AbortError' || job.userCancelled;
    event(job, { status: cancelled ? (resumable ? 'paused' : 'cancelled') : 'error',
      message: cancelled ? (resumable ? '중지됨 · 받은 구간에서 이어받을 수 있습니다.' : '작업을 중지했습니다.') : isStorageQuotaError(error)
        ? '브라우저의 임시 저장 한도에 도달했습니다. 완료·중지된 작업을 정리한 뒤 다시 시도해 주세요.' : safeError(error),
      resumable, speedBps: 0, etaSeconds: null });
  } finally { jobs.delete(job.id); runningJobs--; drainJobs(); }
}
function drainJobs() {
  while (queue.length && runningJobs < MAX_ACTIVE_JOBS) {
    const job = queue.shift();
    if (!jobs.has(job.id)) continue;
    runningJobs++; execute(job);
  }
}
self.onmessage = async ({ data }) => {
  if (data.type === 'RPC_RESULT') {
    const pending = pendingRpc.get(data.requestId); if (!pending) return;
    pendingRpc.delete(data.requestId);
    if (data.error) pending.reject(new Error(data.error)); else pending.resolve(data.result);
    return;
  }
  try {
    let result;
    if (data.type === 'START') {
      if (jobs.has(data.job.id)) throw new Error('이미 진행 중인 작업입니다.');
      const job = { ...data.job, ac: new AbortController(), lastEvent: { status: 'queued', message: '다운로드 대기 중' } };
      jobs.set(job.id, job); queue.push(job); event(job, job.lastEvent); drainJobs(); result = { ok: true };
    } else if (data.type === 'CANCEL') {
      const job = jobs.get(data.jobId);
      if (job) {
        job.userCancelled = true; job.ac.abort();
        const index = queue.indexOf(job);
        if (index >= 0) { queue.splice(index, 1); jobs.delete(job.id); event(job, { status: 'cancelled', message: '대기 작업을 취소했습니다.' }); }
      }
      result = { ok: true, found: Boolean(job) };
    } else if (data.type === 'CLEANUP') {
      if (jobs.get(data.jobId)?.writerOpen) throw new Error('기록 중인 파일은 정리할 수 없습니다.');
      await removeCheckpoint(data.jobId); result = { ok: true };
    } else if (data.type === 'SNAPSHOT') {
      result = [...jobs.values()].map(job => ({ id: job.id, generation: job.generation, ...job.lastEvent }));
    } else throw new Error('알 수 없는 작업 명령입니다.');
    postMessage({ type: 'REPLY', requestId: data.requestId, result });
  } catch (error) { postMessage({ type: 'REPLY', requestId: data.requestId, error: safeError(error) }); }
};
