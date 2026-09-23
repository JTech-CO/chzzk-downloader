// A bounded DASH plan parser. Unsupported stream layouts fail before downloading.
(function () {
  'use strict';
  const children = (node, name) => Array.from(node.children || []).filter(child => child.localName === name);
  function duration(value) {
    const match = String(value || '').match(/^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/);
    return match ? Number(match[1] || 0) * 86400 + Number(match[2] || 0) * 3600 + Number(match[3] || 0) * 60 + Number(match[4] || 0) : 0;
  }
  function base(node, inherited) {
    const value = children(node, 'BaseURL')[0]?.textContent.trim();
    return value ? new URL(value, inherited).href : inherited;
  }
  function expand(template, values, inherited) {
    const literal = '\u0001';
    let url = template.replace(/\$\$/g, literal).replace(/\$(RepresentationID|Number|Time|Bandwidth)(?:%0?(\d+)d)?\$/g, (_, key, width) => {
      const value = values[key];
      if (value == null) throw new Error(`DASH ${key} 값을 확인할 수 없습니다.`);
      return width ? String(value).padStart(Math.min(20, Number(width)), '0') : String(value);
    });
    if (/\$[^$]+\$/.test(url)) throw new Error('지원되지 않는 DASH 템플릿입니다.');
    return new URL(url.replaceAll(literal, '$'), inherited).href;
  }
  function hasMuxedCodecs(rep, set) {
    const codecs = (rep.getAttribute('codecs') || set.getAttribute('codecs') || '').split(',').map(value => value.trim());
    return codecs.some(value => /^(?:avc[1-4]|hvc1|hev1|vp08|vp09|av01|dvh1|dvhe)(?:\.|$)/i.test(value))
      && codecs.some(value => /^(?:mp4a|ac-3|ec-3|opus|vorbis|flac)(?:\.|$)/i.test(value));
  }
  function parse(xml, url) {
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    if (doc.querySelector('parsererror') || doc.documentElement.localName !== 'MPD') throw new Error('MPD XML 파싱 오류');
    if (doc.getElementsByTagNameNS('*', 'ContentProtection').length) throw new Error('보호된 DASH 스트림은 지원하지 않습니다.');
    const mpd = doc.documentElement, periods = children(mpd, 'Period');
    if (periods.length > 1) throw new Error('여러 타임라인으로 구성된 DASH는 아직 지원하지 않습니다.');
    const period = periods[0] || mpd;
    const seconds = duration(period.getAttribute('duration')) || duration(mpd.getAttribute('mediaPresentationDuration'));
    const periodBase = base(period, base(mpd, url)), sets = children(period, 'AdaptationSet');
    const isAudio = node => (node.getAttribute('mimeType') || '').startsWith('audio') || node.getAttribute('contentType') === 'audio';
    const hasSeparateAudio = sets.some(set => isAudio(set) || children(set, 'Representation').some(isAudio));
    const candidates = [];
    for (const set of sets) {
      if ((set.getAttribute('mimeType') || '').startsWith('audio') || set.getAttribute('contentType') === 'audio') continue;
      for (const rep of children(set, 'Representation')) {
        if (isAudio(rep)) continue;
        // Neonplayer also lists optional audio beside complete, muxed MP4 files.
        // Keep only self-contained A/V choices when separate audio is present.
        if (hasSeparateAudio && !hasMuxedCodecs(rep, set)) continue;
        candidates.push({ rep, set, bandwidth: Number(rep.getAttribute('bandwidth') || 0) });
      }
    }
    if (hasSeparateAudio && !candidates.length) throw new Error('별도 오디오 트랙을 사용하는 DASH는 아직 지원하지 않습니다.');
    candidates.sort((a, b) => b.bandwidth - a.bandwidth);
    let lastError;
    for (const candidate of candidates) {
      try {
        const { rep, set, bandwidth } = candidate;
        const representationBase = base(rep, base(set, periodBase));
        const inherited = children(set, 'SegmentTemplate')[0], own = children(rep, 'SegmentTemplate')[0];
        if (!inherited && !own) {
          if (!children(rep, 'BaseURL').length && !children(set, 'BaseURL').length && representationBase === url) throw new Error('DASH 파일 주소가 없습니다.');
          if (children(rep, 'SegmentList').length || children(set, 'SegmentList').length) throw new Error('SegmentList DASH는 아직 지원하지 않습니다.');
          return { type: /\.m3u8(?:\?|$)/i.test(representationBase) ? 'hls' : 'mp4', url: representationBase, bandwidth };
        }
        const attribute = name => own?.getAttribute(name) ?? inherited?.getAttribute(name);
        const timescale = Number(attribute('timescale') || 1), start = Number(attribute('startNumber') || 1);
        const initialization = attribute('initialization'), template = attribute('media');
        if (!initialization || !template || timescale <= 0 || !Number.isSafeInteger(start)) throw new Error('DASH 초기화 정보 또는 템플릿이 올바르지 않습니다.');
        const timeline = children(own || {}, 'SegmentTimeline')[0] || children(inherited || {}, 'SegmentTimeline')[0];
        const times = [];
        if (timeline) {
          const entries = children(timeline, 'S'); let time = 0;
          for (let i = 0; i < entries.length; i++) {
            const entry = entries[i], step = Number(entry.getAttribute('d')), repeats = Number(entry.getAttribute('r') || 0);
            if (entry.hasAttribute('t')) time = Number(entry.getAttribute('t'));
            if (![step, repeats, time].every(Number.isSafeInteger) || step <= 0 || time < 0 || repeats < -1) throw new Error('DASH 타임라인이 올바르지 않습니다.');
            let count = repeats + 1;
            if (repeats === -1) {
              const next = entries[i + 1];
              const end = next?.hasAttribute('t') ? Number(next.getAttribute('t')) : seconds * timescale + Number(attribute('presentationTimeOffset') || 0);
              if (!Number.isFinite(end) || end <= time) throw new Error('DASH 반복 구간의 끝을 확인할 수 없습니다.');
              count = Math.ceil((end - time) / step);
            }
            if (times.length + count > 119999) throw new Error('DASH 세그먼트 수 제한 초과');
            for (let j = 0; j < count; j++) { times.push(time); time += step; }
          }
        } else {
          const step = Number(attribute('duration')), count = Math.ceil(seconds * timescale / step);
          if (!(step > 0) || !Number.isSafeInteger(count) || count < 1 || count > 119999) throw new Error('DASH 영상 길이를 확인할 수 없습니다.');
          for (let i = 0; i < count; i++) times.push(i * step + Number(attribute('presentationTimeOffset') || 0));
        }
        if (!times.length) throw new Error('DASH 세그먼트가 없습니다.');
        const values = { RepresentationID: rep.getAttribute('id') || '', Bandwidth: bandwidth, Number: start, Time: times[0] };
        const segments = [expand(initialization, values, representationBase)];
        times.forEach((time, i) => segments.push(expand(template, { ...values, Number: start + i, Time: time }, representationBase)));
        return { type: 'dash_segments', segments, segmentCount: times.length, bandwidth };
      } catch (error) { lastError = error; }
    }
    throw lastError || new Error('DASH MPD에서 영상 스트림을 찾을 수 없습니다.');
  }
  globalThis.CdlDash = { parse };
})();
