import {
  summarizeLatency,
  mbps,
  csvCell,
  readPayload,
  loadRecords,
} from './speed-metrics.js';

(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const KEY = 'cloudflaresub.network.v1';
  let controller = null;
  let records = [];
  let persistent = true;
  try {
    records = loadRecords(localStorage.getItem(KEY));
  } catch {
    persistent = false;
  }
  const format = (value) => (Number.isFinite(value) ? value.toFixed(2) : '—');
  function persist() {
    try {
      localStorage.setItem(KEY, JSON.stringify(records));
    } catch {
      persistent = false;
    }
  }
  function render() {
    const key = $('sort').value;
    const sorted = [...records].sort((a, b) =>
      key === 'latency'
        ? (a.latency ?? Infinity) - (b.latency ?? Infinity)
        : key === 'speed'
          ? (b.speed ?? -Infinity) - (a.speed ?? -Infinity)
          : b.time - a.time,
    );
    $('records').replaceChildren();
    for (const r of sorted) {
      const row = document.createElement('tr');
      for (const value of [
        r.label,
        new Date(r.time).toLocaleString(),
        format(r.latency),
        format(r.jitter),
        format(r.speed),
        format(r.failure) + '%',
        format(r.traffic),
        r.colo || '未知',
        r.state || '未知',
      ]) {
        const cell = document.createElement('td');
        cell.textContent = value;
        row.append(cell);
      }
      $('records').append(row);
    }
    $('empty').hidden = records.length > 0;
    $('export').disabled = $('clear').disabled = records.length === 0;
    const eligible = records.filter(
      (r) =>
        r.state === '完成' && Number.isFinite(r.latency) && r.failure === 0,
    );
    if (eligible.length) {
      const fastest = [...eligible].sort((a, b) => a.latency - b.latency)[0];
      $('summary').textContent =
        '完整且无失败记录中，最低中位延迟：' +
        fastest.label +
        '（' +
        format(fastest.latency) +
        ' ms）。不同时间的结果仅供参考。';
    } else $('summary').textContent = '';
  }
  async function transfer(path, parent, timeout, progress) {
    const child = new AbortController();
    const relay = () => child.abort(parent.reason);
    parent.addEventListener('abort', relay, { once: true });
    if (parent.aborted) relay();
    const timer = setTimeout(() => child.abort(new Error('请求超时')), timeout);
    const start = performance.now();
    try {
      const response = await fetch(
        path +
          (path.includes('?') ? '&' : '?') +
          'nonce=' +
          crypto.randomUUID(),
        { signal: child.signal, cache: 'no-store', credentials: 'same-origin' },
      );
      if (!response.ok || response.headers.get('x-network-test') !== '1')
        throw new Error(
          '测速接口不可用（HTTP ' + response.status + '），请检查部署与路由',
        );
      if (!progress) {
        const data = await response.json();
        return { ms: performance.now() - start, data };
      }
      const bytes = await readPayload(response, progress);
      return { ms: performance.now() - start, bytes };
    } finally {
      clearTimeout(timer);
      parent.removeEventListener('abort', relay);
    }
  }
  async function run() {
    if (controller) return;
    controller = new AbortController();
    const signal = controller.signal;
    const label = $('label').value.trim() || '未命名线路';
    const budget = Number($('budget').value) * 1048576;
    const result = {
      label,
      time: Date.now(),
      latency: null,
      jitter: null,
      speed: null,
      failure: null,
      traffic: 0,
      colo: '',
      state: '未完成',
    };
    let received = 0,
      lastRequestError = '';
    const onBytes = (n) => {
      received += n;
      result.traffic = received / 1048576;
    };
    for (const id of ['start', 'label', 'budget']) $(id).disabled = true;
    $('stop').disabled = false;
    for (const id of ['latency', 'jitter', 'speed', 'failure'])
      $(id).textContent = '—';
    $('progress').value = 0;
    $('status').textContent = '正在预热连接…';
    $('detail').textContent = '测量本站线路，请保持页面在前台。';
    try {
      try {
        await transfer('/api/network/ping', signal, 5000);
      } catch (e) {
        if (signal.aborted) throw e;
      }
      const samples = [];
      for (let i = 0; i < 8; i++) {
        if (signal.aborted) throw new Error('已停止');
        $('status').textContent = '正在测量请求延迟 ' + (i + 1) + '/8';
        try {
          const ping = await transfer('/api/network/ping', signal, 5000);
          samples.push(ping.ms);
          result.colo = ping.data.colo || result.colo;
        } catch (e) {
          if (signal.aborted) throw e;
          samples.push(null);
          lastRequestError = e.message;
        }
        $('progress').value = ((i + 1) / 8) * 30;
      }
      const valid = samples.filter(Number.isFinite);
      Object.assign(result, summarizeLatency(samples));
      $('latency').textContent = format(result.latency);
      $('jitter').textContent = format(result.jitter);
      $('failure').textContent = format(result.failure);
      if (valid.length < 3)
        throw new Error(
          '成功响应少于 3 次，暂不进行下载测试。' + lastRequestError,
        );
      $('status').textContent = '下载预热（1 MiB）…';
      await transfer(
        '/api/network/download?bytes=1048576',
        signal,
        15000,
        onBytes,
      );
      const warmBytes = received;
      const start = performance.now();
      let measured = 0;
      do {
        if (signal.aborted) throw new Error('已停止');
        const size = Math.min(4 * 1048576, budget - received);
        $('status').textContent = '正在测量下载速度…';
        await transfer(
          '/api/network/download?bytes=' + size,
          signal,
          20000,
          (n) => {
            onBytes(n);
            measured += n;
            const elapsed = (performance.now() - start) / 1000;
            $('speed').textContent = format(mbps(measured, elapsed));
            $('detail').textContent =
              '已接收 ' +
              format(received / 1048576) +
              ' / ' +
              budget / 1048576 +
              ' MiB；下载测量 ' +
              elapsed.toFixed(1) +
              ' 秒。';
            $('progress').value =
              30 + 70 * Math.min(1, Math.max(received / budget, elapsed / 8));
          },
        );
      } while (received < budget && performance.now() - start < 8000);
      const seconds = (performance.now() - start) / 1000;
      result.speed = mbps(received - warmBytes, seconds);
      result.state = '完成';
      $('speed').textContent = format(result.speed);
      $('progress').value = 100;
      $('status').textContent = '测速完成';
      $('detail').textContent =
        '下载 ' +
        format(result.speed / 8) +
        ' MB/s；测量 ' +
        seconds.toFixed(2) +
        ' 秒；含预热共 ' +
        format(result.traffic) +
        ' MiB。' +
        (seconds < 3 ? '短时样本，建议提高流量上限后复测。' : '') +
        ' 接入机房：' +
        (result.colo || '未知');
    } catch (e) {
      result.speed = null;
      $('speed').textContent = '—';
      result.state = signal.aborted ? '已停止' : '未完成';
      $('status').textContent = signal.aborted
        ? '测速已停止'
        : e.message || '测速失败，请重试';
      $('detail').textContent =
        '已接收 ' +
        format(result.traffic) +
        ' MiB；未完成的下载不参与速度比较。';
    } finally {
      records.unshift(result);
      records = records.slice(0, 50);
      persist();
      render();
      if (!persistent)
        $('detail').textContent +=
          ' 浏览器未允许本地存储，本次记录仅在当前页面保留。';
      controller = null;
      for (const id of ['start', 'label', 'budget']) $(id).disabled = false;
      $('stop').disabled = true;
    }
  }
  $('start').addEventListener('click', run);
  $('stop').addEventListener('click', () => controller?.abort());
  $('sort').addEventListener('change', render);
  $('clear').addEventListener('click', () => {
    records = [];
    persist();
    render();
  });
  $('export').addEventListener('click', () => {
    const rows = [
      [
        '备注',
        '时间',
        '请求延迟(ms)',
        '请求抖动(ms)',
        '下载(Mbps)',
        '请求失败率(%)',
        '接收流量(MiB)',
        '接入机房',
        '状态',
      ],
      ...records.map((r) => [
        r.label,
        new Date(r.time).toISOString(),
        r.latency,
        r.jitter,
        r.speed,
        r.failure,
        r.traffic,
        r.colo,
        r.state,
      ]),
    ];
    const url = URL.createObjectURL(
      new Blob(
        ['\ufeff' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n')],
        { type: 'text/csv;charset=utf-8' },
      ),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = 'network-results.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  render();
})();
