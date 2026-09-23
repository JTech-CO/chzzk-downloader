// Validated media plans shared by the service worker and download worker.
const CONCURRENT = 8; // Shared request scheduler enforces the global cap.
const MAX_SEGMENT_BYTES = 256 * 1024 * 1024; // Range 무시/전체 파일 응답으로 인한 과도한 메모리 사용 방지
const MAX_SEGMENT_COUNT = 120000; // 10~12시간 장시간 VOD는 허용하되 비정상 메시지는 차단
const MAX_PLAYLIST_TEXT = 20 * 1024 * 1024;
const DIRECT_RANGE_CHUNK_BYTES = 16 * 1024 * 1024;
const DIRECT_RANGE_MIN_BYTES = 256 * 1024 * 1024;
const DIRECT_RANGE_CONCURRENT = 8;
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
    itemId: normalizeItemId(msg.itemId),
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

function buildDirectRangeSegments(probe) {
  const count = Math.ceil(probe.totalBytes / DIRECT_RANGE_CHUNK_BYTES);
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_SEGMENT_COUNT) {
    throw new Error('파일 크기에 따른 Range 조각 수가 허용 범위를 벗어났습니다.');
  }

  const segments = new Array(count);
  for (let i = 0; i < count; i++) {
    const start = i * DIRECT_RANGE_CHUNK_BYTES;
    const end = Math.min(probe.totalBytes - 1, start + DIRECT_RANGE_CHUNK_BYTES - 1);
    segments[i] = {
      url: probe.url,
      range: `${start}-${end}`,
      totalBytes: probe.totalBytes,
      validator: probe.validator,
    };
  }
  return segments;
}

function rangeLength(range) {
  const m = String(range || '').match(/^(\d+)-(\d+)$/);
  if (!m) return null;
  const start = Number(m[1]);
  const end = Number(m[2]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return end - start + 1;
}

function parseContentRange(value) {
  const m = String(value || '').match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i);
  if (!m || m[3] === '*') return null;
  const start = Number(m[1]);
  const end = Number(m[2]);
  const total = Number(m[3]);
  if (![start, end, total].every(Number.isSafeInteger) || start < 0 || end < start || total <= end) return null;
  return { start, end, total };
}

function validateDirectRangeResponse(response, range, expectedTotalBytes, validator) {
  const requested = String(range).match(/^(\d+)-(\d+)$/);
  const contentRange = parseContentRange(response.headers.get('content-range'));
  if (!requested || !contentRange) throw new Error('Range 응답에 유효한 Content-Range가 없습니다.');

  const start = Number(requested[1]);
  const end = Number(requested[2]);
  if (contentRange.start !== start || contentRange.end !== end || contentRange.total !== expectedTotalBytes) {
    throw new Error(`Content-Range 불일치: ${contentRange.start}-${contentRange.end}/${contentRange.total}`);
  }

  if (validator?.type && validator?.value) {
    const current = response.headers.get(validator.type);
    if (current !== validator.value) {
      throw new Error('다운로드 중 원본 파일 식별자가 변경되어 안전하게 중단했습니다.');
    }
  }
}

function normalizeConcurrency(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 16 ? n : CONCURRENT;
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
    if (upper.startsWith('#EXT-X-KEY:') && parseHlsAttrs(line).METHOD !== 'NONE') throw new Error('암호화된 HLS는 지원하지 않습니다.');
    if (upper === '#EXT-X-DISCONTINUITY' || upper === '#EXT-X-GAP') throw new Error('타임라인이 끊기거나 누락된 HLS는 지원하지 않습니다.');

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
  if (!/^\d+(?:@\d+)?$/.test(value)) throw new Error('HLS 바이트 범위 형식이 올바르지 않습니다.');
  const [lenRaw, offsetRaw] = value.split('@');
  const length = Number(lenRaw);
  if (!Number.isSafeInteger(length) || length <= 0) throw new Error('HLS 바이트 범위 길이가 올바르지 않습니다.');
  const start = offsetRaw !== undefined ? Number(offsetRaw)
    : Number.isSafeInteger(previousEnd) ? previousEnd + 1 : NaN;
  if (!Number.isSafeInteger(start) || start < 0) throw new Error('HLS 바이트 범위 위치가 올바르지 않습니다.');
  const end = start + (length - 1);
  if (!Number.isSafeInteger(end)) throw new Error('HLS 바이트 범위 크기 제한 초과');
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
