// Original fMP4 duration, timeline and seek-index handling, preserved from v2.2.6.
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
