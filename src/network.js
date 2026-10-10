const MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024;

function respond(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: {
      'cache-control': 'no-store, no-transform',
      'cdn-cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'x-network-test': '1',
      ...headers,
    },
  });
}

export function handleNetworkRequest(request, env, url) {
  if (env.NETWORK_TEST_ENABLED === 'false')
    return respond('Network test disabled', 404);
  if (request.method !== 'GET')
    return respond('Method not allowed', 405, { allow: 'GET' });
  const origin = request.headers.get('origin');
  if (
    (origin && origin !== url.origin) ||
    request.headers.get('sec-fetch-site') === 'cross-site'
  ) {
    return respond('Cross-site access denied', 403);
  }

  if (url.pathname === '/api/network/ping') {
    return respond(
      JSON.stringify({ ok: true, colo: request.cf?.colo || null }),
      200,
      {
        'content-type': 'application/json',
      },
    );
  }

  if (url.pathname === '/api/network/download') {
    const raw = url.searchParams.get('bytes') ?? '1048576';
    const size = Number(raw);
    if (
      !/^\d+$/.test(raw) ||
      !Number.isSafeInteger(size) ||
      size < 1 ||
      size > MAX_DOWNLOAD_BYTES
    ) {
      return respond(
        `bytes must be an integer between 1 and ${MAX_DOWNLOAD_BYTES}`,
        400,
      );
    }
    let remaining = size;
    const stream = new ReadableStream({
      pull(controller) {
        if (remaining <= 0) {
          controller.close();
          return;
        }
        // Bounded chunks avoid buffering an entire download or exceeding getRandomValues limits.
        const chunk = new Uint8Array(Math.min(65536, remaining));
        crypto.getRandomValues(chunk);
        remaining -= chunk.byteLength;
        controller.enqueue(chunk);
        if (remaining === 0) controller.close();
      },
      cancel() {
        remaining = 0;
      },
    });
    return respond(stream, 200, {
      'content-type': 'application/octet-stream',
      'content-encoding': 'identity',
      'x-network-bytes': String(size),
    });
  }

  return respond('Not found', 404);
}
