export function summarizeLatency(samples) {
  const valid = samples.filter(Number.isFinite).sort((a, b) => a - b);
  const count = valid.length;
  const differences = [];
  for (let i = 1; i < samples.length; i++) {
    if (Number.isFinite(samples[i - 1]) && Number.isFinite(samples[i])) {
      differences.push(Math.abs(samples[i] - samples[i - 1]));
    }
  }
  return {
    latency: count
      ? (valid[Math.floor((count - 1) / 2)] + valid[Math.floor(count / 2)]) / 2
      : null,
    jitter: differences.length
      ? differences.reduce((a, b) => a + b, 0) / differences.length
      : null,
    failure: samples.length
      ? ((samples.length - count) / samples.length) * 100
      : null,
  };
}

export function mbps(bytes, seconds) {
  return seconds > 0 && bytes >= 0 ? (bytes * 8) / seconds / 1e6 : null;
}

export function csvCell(value) {
  let text = String(value ?? '');
  if (/^[\s]*[=+@\-]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}

export async function readPayload(response, onBytes) {
  if (response.headers.get('content-type') !== 'application/octet-stream') {
    throw new Error('测速端返回了非下载内容');
  }
  // Workers can omit Content-Length for streamed bodies. Use the bounded payload contract.
  const expected = Number(response.headers.get('x-network-bytes'));
  if (!Number.isSafeInteger(expected) || expected < 1 || expected > 8388608) {
    throw new Error('下载长度无效');
  }
  const reader = response.body.getReader();
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      onBytes(value.byteLength);
      if (bytes > expected) throw new Error('下载长度超出预期');
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* A failed connection is already closed. */
    }
    reader.releaseLock();
  }
  if (bytes !== expected) throw new Error('下载数据不完整，请重试');
  return bytes;
}

export function loadRecords(text) {
  try {
    const saved = JSON.parse(text || '[]');
    if (!Array.isArray(saved)) return [];
    return saved
      .filter(
        (record) =>
          record &&
          typeof record.label === 'string' &&
          record.label.length <= 80 &&
          Number.isFinite(record.time) &&
          !Number.isNaN(new Date(record.time).getTime()) &&
          ['完成', '未完成', '已停止'].includes(record.state) &&
          typeof record.colo === 'string' &&
          record.colo.length <= 20 &&
          ['latency', 'jitter', 'speed', 'failure', 'traffic'].every(
            (key) =>
              record[key] === null ||
              (Number.isFinite(record[key]) && record[key] >= 0),
          ) &&
          (record.failure === null || record.failure <= 100),
      )
      .slice(0, 50);
  } catch {
    return [];
  }
}
