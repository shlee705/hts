import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { STOCKS } from './public/market-data.mjs';
import { allowedMethods, isLocalHost, bufferEvent } from './http-routes.mjs';
import { INDEX_CODE, PERIODS } from './candles.mjs';
import { validateOrderInput } from './market.mjs';
const here = fileURLToPath(new URL('.', import.meta.url));
const option = (name, fallback) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; };
const port = Number(option('--port', process.env.PORT || 5173));
const interval = Number(option('--tick-ms', process.env.TICK_MS || 1000));
const seed = Number(option('--seed', process.env.SEED || 20261116));
const orderWaitMs = Number(process.env.HTS_ORDER_WAIT_MS ?? 10000);
if (!Number.isInteger(orderWaitMs) || orderWaitMs < 0 || orderWaitMs > 60000) throw Error('Invalid HTS_ORDER_WAIT_MS (0–60000).');
const dataDir = path.resolve(option('--data-dir', process.env.HTS_DATA_DIR || path.join(here, 'data')));
if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isInteger(interval) || interval < 50 || interval > 60000 || !Number.isInteger(seed) || seed < 0 || seed > 4294967295) throw Error('Invalid --port, --tick-ms (50–60000), or --seed.');
const codes = new Set(STOCKS.map(s => s.code));
const clients = new Set(), pending = new Map(), files = new Map();
const loop = monitorEventLoopDelay({ resolution: 10 }); loop.enable();
let worker, ready = false, stopping = false, requestNumber = 0, sentBytes = 0, coalesced = 0, metrics = {}, tick = 0, connecting = 0;
for (const [file, type] of [['index.html', 'text/html'], ['account.html', 'text/html'], ['account.mjs', 'text/javascript'], ['cash.html', 'text/html'], ['cash.mjs', 'text/javascript'], ['order-entry.mjs', 'text/javascript'], ['candle-chart.mjs', 'text/javascript'], ['chart-navigation.mjs', 'text/javascript'], ['app.mjs', 'text/javascript'], ['style.css', 'text/css'], ['market-data.mjs', 'text/javascript'], ['favicon.svg', 'image/svg+xml']]) {
  files.set('/' + file, { body: await readFile(path.join(here, 'public', file)), type: type + '; charset=utf-8' });
}
files.set('/', files.get('/index.html'));
files.set('/account', files.get('/account.html'));
files.set('/cash', files.get('/cash.html'));
function json(res, status, value, serialized=false) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(serialized ? value : JSON.stringify(value)); }
function ask(method, args = {}) {
  const unavailable = message => Object.assign(new Error(message), { status: 503 });
  if (!ready || stopping) return Promise.reject(unavailable('시세 서버가 준비 중입니다.'));
  if (pending.size >= 256) return Promise.reject(unavailable('요청이 많습니다. 잠시 후 다시 시도하세요.'));
  return new Promise((resolve, reject) => {
    const request = ++requestNumber;
    const deadline = () => {
      // The work remains queued even if the client stops waiting. Keep the
      // slot until completion so the admission limit counts unfinished work.
      if (method === 'order') resolve({ status: 'pending', requestId: args.body.requestId });
      else reject(unavailable('요청 처리 시간이 초과되었습니다.'));
    };
    const timeout = setTimeout(deadline, method === 'order' ? orderWaitMs : 10000);
    pending.set(request, { resolve, reject, timeout });
    worker.postMessage({ type: 'request', request, method, ...args });
    if (method === 'order' && orderWaitMs === 0) deadline();
  });
}
function subscribeSymbols() { if (!stopping) worker?.postMessage({ type: 'symbols', symbols: [...new Set([...clients].map(c => c.code))] }); }
function frame(event, data) { return `event: ${event}\ndata: ${data}\n\n`; }
function send(c, event, payload, fallback = payload) {
  if (c.res.destroyed) return;
  if (c.blocked) { coalesced += bufferEvent(c.queue, event, fallback); return; }
  sentBytes += Buffer.byteLength(payload); c.blocked = !c.res.write(payload);
  if (c.blocked) c.blockedAt = Date.now();
}
function flush(c) {
  c.blocked = false;
  for (const [event, payload] of c.queue) { c.queue.delete(event); send(c, event, payload); if (c.blocked) break; }
}
async function body(req) {
  const invalid = (message, status) => Object.assign(new Error(message), { status });
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') throw invalid('JSON 요청이 필요합니다.', 415);
  if (req.headers.origin && req.headers.origin !== new URL(`http://${req.headers.host}`).origin) throw invalid('허용하지 않는 요청 출처입니다.', 403);
  let length = 0; const chunks = [];
  for await (const chunk of req) { length += chunk.length; if (length > 8192) throw invalid('요청 본문이 너무 큽니다.', 413); chunks.push(chunk); }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw invalid('JSON 형식이 올바르지 않습니다.', 400); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('JSON 객체가 필요합니다.', 400);
  return value;
}
const server = http.createServer(async (req, res) => {
  try {
    const host = req.headers.host;
    if (!isLocalHost(host, port)) return json(res, 403, { error: 'Local access only.' });
    const url = new URL(req.url, `http://${host}`);
    const methods = allowedMethods(url.pathname, files);
    if (!methods) return json(res, 404, { error: 'Not found' });
    if (!methods.includes(req.method)) {
      res.setHeader('Allow', methods.join(', '));
      return json(res, 405, { error: 'Method not allowed' });
    }
    if (url.pathname === '/api/health') return json(res, ready && !stopping ? 200 : 503, { ready, tick, interval, clients: clients.size, pending: pending.size, memoryMB: +(process.memoryUsage().rss / 1048576).toFixed(1), eventLoopP99Ms: +(loop.percentile(99) / 1e6).toFixed(2), sentBytes, coalesced, ...metrics });
    if (!ready || stopping) return json(res, 503, { error: '시세 서버가 준비 중입니다.' });
    if (url.pathname === '/api/cash') {
      if (req.method === 'GET') return json(res, 200, await ask('cash'));
      return json(res, 200, await ask('adjustCash', { body: await body(req) }));
    }
    if (url.pathname === '/api/candles') {
      const code = url.searchParams.get('symbol'), period = url.searchParams.get('period');
      if ((!codes.has(code) && code !== INDEX_CODE) || !Object.hasOwn(PERIODS, period)) return json(res, 400, { error: '종목과 봉 주기를 확인하세요.' });
      return json(res, 200, await ask('candles', { code, period }), true);
    }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      const code = url.searchParams.get('symbol') || '005930';
      if (!codes.has(code)) return json(res, 400, { error: '존재하지 않는 종목입니다.' });
      return json(res, 200, { ...await ask('state', { code }), interval });
    }
    if (req.method === 'GET' && url.pathname === '/api/events') {
      const code = url.searchParams.get('symbol') || '005930';
      if (!codes.has(code)) return json(res, 400, { error: '존재하지 않는 종목입니다.' });
      if (clients.size + connecting >= 200) return json(res, 503, { error: '최대 동시 연결 수를 초과했습니다.' });
      connecting++; let state;
      try { state = await ask('state', { code }); } finally { connecting--; }
      if (res.destroyed) return;
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.flushHeaders(); req.socket.setNoDelay(true); req.socket.setTimeout(0);
      const c = { res, code, blocked: false, blockedAt: 0, queue: new Map() };
      send(c, 'state', frame('state', JSON.stringify({ ...state, interval })));
      clients.add(c); subscribeSymbols();
      res.on('drain', () => flush(c));
      res.on('close', () => { clients.delete(c); c.queue.clear(); subscribeSymbols(); }); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/orders') {
      const input = await body(req);
      // A pending response must always contain a valid ID for reconciliation.
      validateOrderInput(input);
      const result = await ask('order', { body: input, receivedAt: Date.now() });
      if (result.status === 'pending') res.setHeader('Location', '/api/orders/requests/' + input.requestId);
      return json(res, result.status === 'pending' ? 202 : 200, result);
    }
    const lookup = /^\/api\/orders\/requests\/([a-zA-Z0-9-]{8,80})$/.exec(url.pathname);
    if (req.method === 'GET' && lookup) {
      try { return json(res, 200, await ask('orderByRequest', { requestId: lookup[1] })); }
      catch (error) {
        if (error.status === 422) return json(res, 422, { status: 'rejected', requestId: lookup[1], error: error.message });
        throw error;
      }
    }
    if (req.method === 'POST' && /^\/api\/orders\/P\d+\/cancel$/.test(url.pathname)) { await body(req); return json(res, 200, await ask('cancel', { id: url.pathname.split('/')[3] })); }
    if (req.method === 'GET' || req.method === 'HEAD') {
      const file = files.get(url.pathname);
      if (!file) return json(res, 404, { error: 'Not found' });
      res.writeHead(200, { 'Content-Type': file.type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'" });
      res.end(req.method === 'HEAD' ? undefined : file.body); return;
    }
    json(res, 405, { error: 'Method not allowed' });
  } catch (error) { if (!res.headersSent) json(res, error.status ?? 500, { error: error.message }); else res.end(); }
});
server.headersTimeout = 10000; server.requestTimeout = 15000; server.maxHeadersCount = 40;
const heartbeat = setInterval(() => {
  for (const c of clients) {
    if (c.blocked && Date.now() - c.blockedAt > 10000) c.res.destroy();
    else if (!c.blocked) c.res.write(': heartbeat\n\n');
  }
}, 5000); heartbeat.unref();
function shutdown() {
  if (stopping) return; stopping = true; ready = false; clearInterval(heartbeat);
  for (const c of clients) { c.res.write(frame('closing', '{}')); c.res.end(); }
  server.close(); server.closeIdleConnections();
  if (worker) worker.postMessage({ type: 'stop' });
}
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
function disconnectLauncher() {
  if (process.connected) process.disconnect();
}
process.on('message', message => { if (message === 'shutdown') shutdown(); });
server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `Port ${port} is in use. Use --port ${port + 1}.` : error.message); process.exitCode = 1; shutdown(); if (!worker) disconnectLauncher(); });
server.listen(port, '127.0.0.1', () => {
  worker = new Worker(new URL('./market-worker.mjs', import.meta.url), { workerData: { dataDir, seed, interval } });
  worker.on('message', message => {
    if (message.type === 'ready') {
      ready = true;
      console.log(`\n  PULSE · KOSPI ${STOCKS.length}종목 HTS\n  Local: http://localhost:${port}\n  Tick: ${interval} ms · Seed: ${seed}\n  Data: ${message.dataDir}\n  ${message.migration ?? (message.recovered ? 'Recovered market checkpoint.' : 'Market ready.')}\n  Ctrl+C: save checkpoint and stop.\n`);
      process.send?.({ type: 'ready', port });
    } else if (message.type === 'response') {
      const p = pending.get(message.request); if (!p) return;
      clearTimeout(p.timeout); pending.delete(message.request);
      if (message.error) p.reject(Object.assign(new Error(message.error), { status: message.status ?? 500 }));
      else p.resolve(message.result);
    } else if (message.type === 'tick') {
      metrics = message.metrics;
      if (message.json) tick = JSON.parse(message.json).tick;
      const common = message.json ? frame('tick', message.json) : null;
      const account = message.accountJson ? frame('account', message.accountJson) : null;
      const details = new Map(Object.entries(message.details).map(([code, value]) => [code, frame('detail', value)]));
      const orders = message.ordersJson ? frame('orders', message.ordersJson) : null;
      const ordersReset = message.ordersResetJson ? frame('orders', message.ordersResetJson) : null;
      for (const c of clients) {
        if (common) send(c, 'tick', common);
        if (account) send(c, 'account', account);
        if (details.has(c.code)) send(c, 'detail', details.get(c.code));
        if (orders) send(c, 'orders', orders, ordersReset);
      }
    } else if (message.type === 'stopped') {
      console.log(`Market checkpoint saved: ${message.closedAt}`); worker.unref(); loop.disable(); disconnectLauncher();
    } else if (message.type === 'fatal') { console.error('Market stopped:', message.message); process.exitCode = 1; shutdown(); }
  });
  worker.on('error', error => { console.error(error.message); process.exitCode = 1; ready = false; shutdown(); });
  worker.on('exit', code => {
    if (!stopping) { console.error(`Market worker exited (${code}).`); process.exitCode = 1; shutdown(); }
    for (const p of pending.values()) { clearTimeout(p.timeout); p.reject(Object.assign(Error('시세 서버가 종료되었습니다.'), { status: 503 })); } pending.clear();
    loop.disable(); disconnectLauncher();
  });
});
