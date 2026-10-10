import test from 'node:test';
import assert from 'node:assert/strict';
import {
  summarizeLatency,
  mbps,
  csvCell,
  readPayload,
  loadRecords,
} from '../public/speed-metrics.js';

test('latency uses median and failure rate, not a minimum or packet loss', () => {
  assert.deepEqual(summarizeLatency([10, 30, null, 20, 40]), {
    latency: 25,
    jitter: 20,
    failure: 20,
  });
  assert.deepEqual(summarizeLatency([null, null]), {
    latency: null,
    jitter: null,
    failure: 100,
  });
  assert.deepEqual(summarizeLatency([5]), {
    latency: 5,
    jitter: null,
    failure: 0,
  });
});
test('download converts received bytes and seconds to decimal Mbps', () => {
  assert.equal(mbps(1000000, 2), 4);
  assert.equal(mbps(0, 1), 0);
  assert.equal(mbps(100, 0), null);
});
test('CSV labels cannot become formulas and quotes round-trip', () => {
  assert.equal(csvCell('=1+1'), '"\'=1+1"');
  assert.equal(csvCell('  =1+1'), '"\'  =1+1"');
  assert.equal(csvCell('a"b,c'), '"a""b,c"');
});
test('stream measurement verifies actual bytes without Content-Length', async () => {
  const r = new Response(new Uint8Array([1, 2, 3]), {
    headers: {
      'content-type': 'application/octet-stream',
      'x-network-bytes': '3',
    },
  });
  let read = 0;
  assert.equal(await readPayload(r, (n) => (read += n)), 3);
  assert.equal(read, 3);
  const truncated = new Response(new Uint8Array(2), {
    headers: {
      'content-type': 'application/octet-stream',
      'x-network-bytes': '3',
    },
  });
  await assert.rejects(
    readPayload(truncated, () => {}),
    /不完整/,
  );
  const wrong = new Response('<html>error</html>', {
    headers: { 'content-type': 'text/html', 'x-network-bytes': '18' },
  });
  await assert.rejects(
    readPayload(wrong, () => {}),
    /非下载/,
  );
});
test('corrupt or invalid saved history is ignored', () => {
  assert.deepEqual(loadRecords('broken'), []);
  assert.deepEqual(loadRecords('{"label":"not an array"}'), []);
  assert.deepEqual(loadRecords('[{"time":1,"label":"x"}]'), []);
  const valid = {
    time: 1,
    label: 'test',
    latency: 1,
    jitter: 0,
    speed: null,
    failure: 0,
    traffic: 0,
    colo: '',
    state: '已停止',
  };
  assert.deepEqual(loadRecords(JSON.stringify([valid])), [valid]);
});
