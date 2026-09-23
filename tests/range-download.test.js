'use strict';
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { harness } = require('./helpers');
const h = harness();
const context = h.context;
const invoke = h.invoke;
let fetchImpl = async () => { throw new Error('Unexpected fetch'); };
h.fetch((...args) => fetchImpl(...args));

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test('Content-Range parser accepts only exact byte ranges', () => {
  const parsed = invoke('parseContentRange', 'bytes 10-19/100');
  assert.deepEqual(
    { start: parsed.start, end: parsed.end, total: parsed.total },
    { start: 10, end: 19, total: 100 }
  );
  assert.equal(invoke('parseContentRange', 'bytes */100'), null);
  assert.equal(invoke('parseContentRange', 'bytes 10-100/100'), null);
  assert.equal(invoke('parseContentRange', 'items 0-1/2'), null);
});

test('direct MP4 plan is contiguous, non-overlapping, and complete', () => {
  const chunk = 16 * 1024 * 1024;
  const totalBytes = chunk * 2 + 7;
  const plan = invoke('buildDirectRangeSegments', {
    url: 'https://vod.pstatic.net/video.mp4',
    totalBytes,
    validator: { type: 'etag', value: '"v1"' },
  });

  assert.equal(plan.length, 3);
  assert.equal(plan[0].range, `0-${chunk - 1}`);
  assert.equal(plan[1].range, `${chunk}-${chunk * 2 - 1}`);
  assert.equal(plan[2].range, `${chunk * 2}-${totalBytes - 1}`);

  let next = 0;
  for (const segment of plan) {
    const [start, end] = segment.range.split('-').map(Number);
    assert.equal(start, next);
    assert.ok(end >= start);
    assert.equal(segment.totalBytes, totalBytes);
    next = end + 1;
  }
  assert.equal(next, totalBytes);
});

test('Range probe captures total size and strong validator', async () => {
  let requestedRange = null;
  fetchImpl = async (_url, options) => {
    requestedRange = options.headers.Range;
    return new Response(Uint8Array.of(7), {
      status: 206,
      headers: {
        'content-range': 'bytes 0-0/123456789',
        'content-length': '1',
        etag: '"file-v1"',
      },
    });
  };

  const probe = await invoke(
    'probeDirectRange',
    'https://vod.pstatic.net/video.mp4',
    new AbortController().signal
  );
  assert.equal(requestedRange, 'bytes=0-0');
  assert.equal(probe.supported, true);
  assert.equal(probe.totalBytes, 123456789);
  assert.equal(probe.validator.type, 'etag');
  assert.equal(probe.validator.value, '"file-v1"');
});

test('Range probe cancels a full-file response before fallback', async () => {
  let cancelled = 0;
  fetchImpl = async () => ({
    status: 200,
    url: 'https://vod.pstatic.net/video.mp4',
    headers: new Headers(),
    body: { cancel: async () => { cancelled++; } },
  });

  const probe = await invoke(
    'probeDirectRange',
    'https://vod.pstatic.net/video.mp4',
    new AbortController().signal
  );
  assert.equal(probe.supported, false);
  assert.equal(cancelled, 1);
});

test('Range response validates boundaries, total size, and validator', () => {
  const response = {
    headers: new Headers({
      'content-range': 'bytes 20-29/100',
      etag: '"v1"',
    }),
  };
  assert.doesNotThrow(() => invoke(
    'validateDirectRangeResponse',
    response,
    '20-29',
    100,
    { type: 'etag', value: '"v1"' }
  ));
  assert.throws(
    () => invoke('validateDirectRangeResponse', response, '20-29', 101, null),
    /Content-Range/
  );
  assert.throws(
    () => invoke(
      'validateDirectRangeResponse',
      response,
      '20-29',
      100,
      { type: 'etag', value: '"v2"' }
    ),
    /식별자가 변경/
  );
});

test('Range fetch retries transient server errors and preserves bytes', async () => {
  let calls = 0;
  fetchImpl = async () => {
    calls++;
    if (calls === 1) return new Response('busy', { status: 503 });
    return new Response(Uint8Array.from([1, 2, 3, 4]), {
      status: 206,
      headers: {
        'content-range': 'bytes 0-3/10',
        'content-length': '4',
        etag: '"v1"',
      },
    });
  };

  const result = await invoke(
    'fetchSeg',
    {
      url: 'https://vod.pstatic.net/video.mp4',
      range: '0-3',
      totalBytes: 10,
      validator: { type: 'etag', value: '"v1"' },
    },
    new AbortController().signal,
    'include'
  );
  assert.equal(calls, 2);
  assert.deepEqual(Array.from(new Uint8Array(result)), [1, 2, 3, 4]);
});

test('Range body larger than requested is rejected', async () => {
  fetchImpl = async () => new Response(Uint8Array.from([1, 2, 3, 4, 5]), {
    status: 206,
    headers: {
      'content-range': 'bytes 0-3/10',
      'content-length': '5',
    },
  });

  await assert.rejects(
    () => invoke(
      'fetchSeg',
      {
        url: 'https://vod.pstatic.net/video.mp4',
        range: '0-3',
        totalBytes: 10,
      },
      new AbortController().signal,
      'include'
    ),
    /Range 크기 불일치/
  );
});

test('Range fetch retries a truncated response body', async () => {
  let calls = 0;
  fetchImpl = async () => {
    calls++;
    const bytes = calls === 1 ? [1, 2, 3] : [1, 2, 3, 4];
    return new Response(Uint8Array.from(bytes), {
      status: 206,
      headers: {
        'content-range': 'bytes 0-3/10',
        'content-length': '4',
      },
    });
  };

  const result = await invoke(
    'fetchSeg',
    {
      url: 'https://vod.pstatic.net/video.mp4',
      range: '0-3',
      totalBytes: 10,
    },
    new AbortController().signal,
    'include'
  );
  assert.equal(calls, 2);
  assert.deepEqual(Array.from(new Uint8Array(result)), [1, 2, 3, 4]);
});

test('worker pool obeys the requested concurrency cap', async () => {
  context.__activeFetches = 0;
  context.__maxFetches = 0;
  vm.runInContext(`
    fetchSeg = async function () {
      __activeFetches++;
      __maxFetches = Math.max(__maxFetches, __activeFetches);
      await Promise.resolve();
      __activeFetches--;
      return new ArrayBuffer(1);
    };
  `, context);

  const completed = [];
  await invoke(
    'runWorkerPool',
    Array.from({ length: 12 }, (_, i) => String(i)),
    'include',
    new AbortController(),
    async (index) => { completed.push(index); },
    null,
    3
  );

  assert.equal(context.__maxFetches, 3);
  assert.equal(completed.length, 12);
  assert.deepEqual([...completed].sort((a, b) => a - b), Array.from({ length: 12 }, (_, i) => i));
});

(async () => {
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`ok - ${name}`);
    } catch (error) {
      failed++;
      console.error(`not ok - ${name}`);
      console.error(error);
    }
  }

  if (failed) {
    console.error(`\n${failed} test(s) failed`);
    process.exitCode = 1;
  } else {
    console.log(`\n${tests.length} tests passed`);
  }
})();