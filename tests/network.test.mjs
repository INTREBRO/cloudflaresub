import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
const request = (path, options) =>
  new Request('https://sub.example.com' + path, options);
const env = { ASSETS: { fetch: async () => new Response('original asset') } };
test('ping is uncached and identifies an actual measurement response', async () => {
  const response = await worker.fetch(request('/api/network/ping'), env);
  assert.equal(response.headers.get('x-network-test'), '1');
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.equal((await response.json()).ok, true);
});
test('download produces the exact requested bytes and prevents compression', async () => {
  const response = await worker.fetch(
    request('/api/network/download?bytes=131079'),
    env,
  );
  assert.equal(
    response.headers.get('content-type'),
    'application/octet-stream',
  );
  assert.equal(response.headers.get('content-encoding'), 'identity');
  assert.equal(response.headers.get('x-network-bytes'), '131079');
  assert.equal((await response.arrayBuffer()).byteLength, 131079);
});
test('invalid and oversized payloads are rejected before streaming', async () => {
  for (const value of ['0', '-1', '1.5', 'NaN', '8388609']) {
    assert.equal(
      (await worker.fetch(request('/api/network/download?bytes=' + value), env))
        .status,
      400,
    );
  }
});
test('cross-site calls and writes are rejected for new endpoints', async () => {
  assert.equal(
    (
      await worker.fetch(
        request('/api/network/download?bytes=1', {
          headers: { Origin: 'https://other.example' },
        }),
        env,
      )
    ).status,
    403,
  );
  assert.equal(
    (await worker.fetch(request('/api/network/ping', { method: 'POST' }), env))
      .status,
    405,
  );
});
test('existing assets and invalid subscription requests retain their behavior', async () => {
  assert.equal(
    await (await worker.fetch(request('/logo.svg'), env)).text(),
    'original asset',
  );
  const response = await worker.fetch(
    request('/api/generate', { method: 'POST', body: '{}' }),
    env,
  );
  assert.equal(response.status, 400);
});

test('disabling network tests leaves subscription and assets routes available', async () => {
  const disabled = { ...env, NETWORK_TEST_ENABLED: 'false' };
  assert.equal((await worker.fetch(request('/api/network/ping'), disabled)).status, 404);
  assert.equal((await worker.fetch(request('/api/network/download?bytes=1'), disabled)).status, 404);
  assert.equal(await (await worker.fetch(request('/logo.svg'), disabled)).text(), 'original asset');
  assert.equal((await worker.fetch(request('/api/generate', { method: 'POST', body: '{}' }), disabled)).status, 400);
});

test('unknown network paths do not fall through to the SPA', async () => {
  assert.equal((await worker.fetch(request('/api/network/unknown'), env)).status, 404);
  assert.equal((await worker.fetch(request('/api/network/ping', { method: 'OPTIONS' }), env)).status, 405);
  assert.equal((await worker.fetch(request('/api/network/ping', { headers: { 'sec-fetch-site': 'cross-site' } }), env)).status, 403);
});
test('existing generation, KV storage and raw export still work', async () => {
  const data = new Map();
  const bindings = {
    ...env,
    SUB_ACCESS_TOKEN: 'test-only',
    SUB_STORE: {
      get: async (key) => data.get(key),
      put: async (key, value) => data.set(key, value),
    },
  };
  const response = await worker.fetch(
    request('/api/generate', {
      method: 'POST',
      body: JSON.stringify({
        nodeLinks:
          'vless://11111111-1111-4111-8111-111111111111@origin.example:443?security=tls&type=ws&host=origin.example&sni=origin.example#sample',
        preferredIps: '192.0.2.1:2083',
        keepOriginalHost: true,
      }),
    }),
    bindings,
  );
  const body = await response.json();
  assert.equal(body.counts.outputNodes, 1);
  assert.equal(body.preview[0].host, 'origin.example');
  const result = await worker.fetch(new Request(body.urls.raw), bindings);
  assert.match(atob(await result.text()), /@192\.0\.2\.1:2083/);
  assert.equal(
    (await worker.fetch(request('/sub/' + body.shortId), bindings)).status,
    403,
  );
});
