import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { once } from 'node:events';
import path from 'node:path';
import { launch, stop, get, post, tempData, sleep } from './helpers.mjs';
test('server synchronizes clients, persists orders and closes/reopens at last prices', { timeout: 30000 }, async t => {
  const dataDir = await tempData('lifecycle'); let server = await launch({ port: 18371, dataDir, interval: 50 });
  t.after(async () => { await stop(server); });
  const a = await get(server); assert.equal(a.stocks.length, 100);
  assert.equal(a.index.name, 'KOSPI 100'); assert.equal(a.index.constituents, 100);
  await sleep(180); const b = await get(server); assert.ok(b.tick > a.tick);
  const controller = new AbortController(); const response = await fetch(server.url + '/api/events?symbol=000660', { signal: controller.signal });
  const reader = response.body.getReader(); const initial = new TextDecoder().decode((await reader.read()).value);
  assert.match(initial, /"index":\{"name":"KOSPI 100"/);
  assert.match(initial, /event: state/); assert.match(initial, /"code":"000660"/); controller.abort();
  const payload = { code: '005930', side: 'buy', type: 'market', quantity: 3, requestId: 'http-duplicate-123' };
  const orders = await Promise.all(Array.from({ length: 8 }, () => post(server, '/api/orders', payload)));
  assert.ok(orders.every(o => o.status === 200)); assert.equal(new Set(orders.map(o => o.data.id)).size, 1);
  const state = await get(server); assert.equal(state.account.positions[0].quantity, 3);
  assert.equal((await post(server, '/api/orders', { ...payload, requestId: 'invalid-order-123', quantity: -2 })).status, 400);
  assert.equal((await fetch(server.url + '/api/state?symbol=invalid')).status, 400);
  assert.equal((await fetch(server.url + '/data/market-state.json')).status, 404);
  assert.equal((await fetch(server.url + '/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://example.com' }, body: JSON.stringify(payload) })).status, 403);
  await stop(server);
  const saved = JSON.parse(await readFile(path.join(dataDir, 'market-state.json'), 'utf8')); assert.equal(saved.status, 'closed');
  await assert.rejects(readFile(path.join(dataDir, 'last-close.json')), {code:'ENOENT'});
  const stable = await readFile(path.join(dataDir, 'ticks.jsonl'), 'utf8'); await sleep(100); assert.equal(await readFile(path.join(dataDir, 'ticks.jsonl'), 'utf8'), stable);
  server = await launch({ port: 18371, dataDir, interval: 10000 });
  const next = await get(server); for (const s of next.stocks) { assert.equal(s.price, saved.prices[s.code]); assert.equal(s.prev, saved.dayStats[s.code].prev); }
  assert.equal(next.index.previousClose, saved.index.previousClose); assert.equal(next.index.change, saved.index.change);
  assert.equal(next.account.positions[0].quantity, 3);
});
test('unclean process termination recovers last checkpoint, with no offline ticks', { timeout: 20000 }, async t => {
  const dataDir = await tempData('crash'); let server = await launch({ port: 18372, dataDir, interval: 50 });
  t.after(async () => { await stop(server); });
  await sleep(220); const ended = once(server.child, 'exit'); server.child.kill('SIGKILL'); await ended;
  const checkpoint = JSON.parse(await readFile(path.join(dataDir, 'market-state.json'), 'utf8')); assert.equal(checkpoint.status, 'running');
  await sleep(120); server = await launch({ port: 18372, dataDir, interval: 10000 });
  const state = await get(server); assert.equal(state.tick, 0);
  for (const s of state.stocks) assert.equal(s.price, checkpoint.prices[s.code]); assert.match(server.output(), /Recovered/);
});
test('single-writer lock protects a shared data folder and broken state is not silently reset', { timeout: 20000 }, async t => {
  const dataDir = await tempData('lock'); const server = await launch({ port: 18373, dataDir }); t.after(() => stop(server));
  await assert.rejects(launch({ port: 18374, dataDir }), /이미 실행/);
  const broken = await tempData('corrupt'); await writeFile(path.join(broken, 'market-state.json'), '{broken');
  await assert.rejects(launch({ port: 18375, dataDir: broken }));
  assert.equal(await readFile(path.join(broken, 'market-state.json'), 'utf8'), '{broken');
});
test('permanent disk write failure stops the server and preserves the prior checkpoint', { timeout: 15000 }, async t => {
  const dataDir = await tempData('disk-failure'); const server = await launch({ port: 18376, dataDir, interval: 10000 });
  t.after(async () => { if (server.child.exitCode === null && server.child.signalCode === null) server.child.kill(); });
  const checkpoint = await readFile(path.join(dataDir, 'market-state.json'), 'utf8');
  await mkdir(path.join(dataDir, 'market-state.json.tmp'));
  const ended = once(server.child, 'exit');
  const response = await post(server, '/api/orders', { code: '005930', side: 'buy', type: 'market', quantity: 1, requestId: 'disk-failure-123' });
  assert.equal(response.status, 503); const [code] = await ended; assert.equal(code, 1);
  assert.equal(await readFile(path.join(dataDir, 'market-state.json'), 'utf8'), checkpoint);
});
