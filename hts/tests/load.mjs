import http from 'node:http';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import { STOCKS } from '../public/market-data.mjs';
import { launch, stop, get, post, tempData, sleep } from './helpers.mjs';
const duration = Math.max(5, Number(process.env.BENCH_SECONDS || 30));
const clientCount = Math.min(150, Number(process.env.BENCH_CLIENTS || 100));
const server = await launch({ port: 18380, dataDir: await tempData('load'), interval: 50 });
const requests = [], responses = [], reads = [], writes = [], samples = [];
let received = 0, tickEvents = 0, errors = 0, orderId = 0, retries = 0, run = true, firstError;
const readCounts = { state: 0, candles: 0, cash: 0, orderLookup: 0 };
function recordError(error) { errors++; firstError ??= error.message; }
function stream(i, paused = false) {
  return new Promise((resolve, reject) => {
    const req = http.get(server.url + `/api/events?symbol=${STOCKS[i % STOCKS.length].code}`, res => {
      if (res.statusCode !== 200) return reject(Error(`SSE status ${res.statusCode}`));
      responses.push(res);
      if (paused) res.pause();
      else res.on('data', chunk => { received += chunk.length; tickEvents += (chunk.toString().match(/event: tick\n/g) || []).length; });
      resolve(req);
    });
    req.on('error', error => { if (run) reject(error); }); requests.push(req);
  });
}
function quantile(values, p) { const sorted = [...values].sort((a, b) => a - b); return +sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]?.toFixed(2) || 0; }
try {
  await Promise.all(Array.from({ length: clientCount }, (_, i) => stream(i)));
  await stream(0, true);
  const before = await get(server, '/api/health'); const start = performance.now();
  const initialCash = await get(server, '/api/cash');
  let expectedCash = initialCash.cash;
  console.log(`Load: ${clientCount} active SSE clients + 1 stalled client, 100 symbols / 50ms, ${duration}s, real disk writes.`);
  const readers = ['state', 'state', 'candles', 'cash'].map(name => (async () => {
    while (run) {
      const began = performance.now();
      try {
        const code = STOCKS[readCounts.candles % STOCKS.length].code;
        const route = name === 'candles' ? '/api/candles?period=1m&symbol=' + code : '/api/' + name;
        const data = await get(server, route);
        if (name === 'candles') {
          assert.equal(data.code, code); assert.equal(data.period, '1m'); assert.ok(Array.isArray(data.bars));
          for (const [, open, high, low, close] of data.bars) {
            assert.ok(low > 0 && low <= Math.min(open, close) && high >= Math.max(open, close), 'Invalid candle OHLC');
          }
        } else if (name === 'cash') {
          assert.ok(Number.isSafeInteger(data.cash) && data.available <= data.cash && data.available >= 0);
        } else assert.equal(data.stocks.length, 10);
        readCounts[name]++; reads.push(performance.now() - began);
      } catch (error) { recordError(error); }
      await sleep(40);
    }
  })());
  // Two independent deposit intents start from one revision. Exactly one can commit.
  const transfers = await Promise.all(['a', 'b'].map(suffix => post(server, '/api/cash', {
    direction: 'deposit', amount: 1000, revision: initialCash.revision, requestId: 'bench-cash-' + suffix,
  })));
  assert.deepEqual(transfers.map(r => r.status).sort(), [200, 409]);
  expectedCash += 1000;
  const writer = (async () => {
    while (run) {
      for (const side of ['buy', 'sell']) {
        const sequence = ++orderId;
        const payload = { code: '035420', side, type: 'market', quantity: 1, requestId: 'benchmark-' + sequence };
        const copies = sequence % 8 === 1 ? 2 : 1;
        try {
          const answers = await Promise.all(Array.from({ length: copies }, async () => {
            const began = performance.now(), response = await post(server, '/api/orders', payload);
            writes.push(performance.now() - began);
            assert.equal(response.status, 200, response.data.error);
            return response.data;
          }));
          const executed = answers[0];
          assert.equal(Number(executed.id.slice(1)), sequence, 'Order counter skipped a logical request');
          assert.equal(executed.filled, 1); assert.equal(executed.status, 'filled');
          expectedCash += (side === 'buy' ? -1 : 1) * executed.average;
          if (copies === 2) {
            assert.equal(answers[1].id, executed.id, 'Concurrent duplicate returned a different order');
            retries++;
            const began = performance.now();
            const lookup = await get(server, '/api/orders/requests/' + payload.requestId);
            assert.deepEqual(lookup, executed); readCounts.orderLookup++; reads.push(performance.now() - began);
          }
        } catch (error) { recordError(error); }
      }
      await sleep(60);
    }
  })();
  for (let sec = 0; sec < duration; sec++) {
    await sleep(1000); samples.push(await get(server, '/api/health'));
    if ((sec + 1) % 5 === 0) console.log(`${sec + 1}s · ${samples.at(-1).clients} clients · ${samples.at(-1).memoryMB} MB RSS · order p95 ${quantile(writes, .95)}ms`);
  }
  run = false; await Promise.all([...readers, writer]);
  const seconds = (performance.now() - start) / 1000, after = await get(server, '/api/health');
  const terminal = await get(server);
  assert.equal(errors, 0, firstError);
  assert.equal(terminal.account.positions.length, 0, 'Every completed buy/sell pair must leave zero holdings');
  assert.equal(terminal.account.cash, expectedCash, 'Ending cash must equal cash flows from unique fills and one deposit');
  assert.equal(terminal.account.available, expectedCash);
  assert.equal(terminal.orders.length, Math.min(500, orderId));
  assert.equal(new Set(terminal.orders.map(o => o.requestId)).size, terminal.orders.length);
  assert.ok(terminal.orders.every(o => o.status === 'filled' && o.remaining === 0));
  assert.ok(retries > 0 && Object.values(readCounts).every(n => n > 0));
  for (const req of requests) req.destroy(); for (const res of responses) res.destroy();
  await sleep(250); const cleaned = await get(server, '/api/health');
  const report = {
    measuredAt: new Date().toISOString(), node: process.version, platform: `${os.platform()} ${os.arch()}`, cpu: os.cpus()[0].model,
    durationSeconds: +seconds.toFixed(2), clients: clientCount, stalledClients: 1, symbols: 100, tickIntervalMs: 50,
    actualTicksPerSecond: +((after.tick - before.tick) / seconds).toFixed(2), quoteUpdatesPerSecond: +((after.tick - before.tick) * 100 / seconds).toFixed(0),
    receivedMB: +(received / 1048576).toFixed(2), deliveredTickEvents: tickEvents,
    readRequests: reads.length, readP50Ms: quantile(reads, .5), readP95Ms: quantile(reads, .95), readP99Ms: quantile(reads, .99),
    orderRequests: writes.length, orderP50Ms: quantile(writes, .5), orderP95Ms: quantile(writes, .95), orderP99Ms: quantile(writes, .99),
    logicalOrders: orderId, verifiedDuplicateRequests: retries, readCounts, endingCash: terminal.account.cash, endingPositions: terminal.account.positions.length, cashRevisionConflicts: 1,
    rssStartMB: before.memoryMB, rssEndMB: after.memoryMB, rssPeakMB: Math.max(before.memoryMB, after.memoryMB, ...samples.map(s => s.memoryMB)), eventLoopP99Ms: after.eventLoopP99Ms,
    tickWorkP95Ms: quantile(samples.map(s => s.workMs), .95), diskPersistP95Ms: quantile(samples.map(s => s.persistMs), .95),
    coalescedEvents: after.coalesced, fileLockRetries: after.fileRetries, remainingClientsAfterDisconnect: cleaned.clients, pendingAfterDisconnect: cleaned.pending, errors,
  };
  await stop(server);
  const output = fileURLToPath(new URL('../qa/', import.meta.url)); await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'load-report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
  assert.equal(errors, 0); assert.equal(cleaned.clients, 0); assert.equal(cleaned.pending, 0);
  assert.ok(report.actualTicksPerSecond >= 15, 'Must sustain >= 15 ticks/s at 50ms target');
  assert.ok(report.orderP99Ms < 500, 'Order p99 must stay under 500ms');
  assert.ok(report.readP99Ms < 500, 'Read p99 must stay under 500ms');
  assert.ok(report.rssPeakMB < 512, 'RSS must stay below 512 MB');
  console.log('PASS: throughput, latency, bounded memory, and connection cleanup budgets.');
} catch (error) { console.error(server.output()); throw error; }
finally { run = false; for (const req of requests) req.destroy(); for (const res of responses) res.destroy(); await stop(server); }
