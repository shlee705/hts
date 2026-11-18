import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Market } from '../market.mjs';
import { get, launch, post, stop, tempData } from './helpers.mjs';

const order = { requestId: 'reconcile-order-123', code: '005930', side: 'buy', type: 'market', quantity: 1 };
const submit = (server, data) => post(server, '/api/orders', data);
const outcome = (server, id) => fetch(server.url + '/api/orders/requests/' + id);

test('a delayed HTTP acknowledgement and concurrent retries produce one durable outcome', async t => {
  const dataDir = await tempData('order-outcome');
  const preload = new URL('./fixtures/delay-order-write.mjs', import.meta.url).href;
  let server = await launch({ port: 18411, dataDir, interval: 60000,
    env: { HTS_ORDER_WAIT_MS: '5', NODE_OPTIONS: [process.env.NODE_OPTIONS, '--import=' + preload].filter(Boolean).join(' ') } });
  t.after(() => stop(server));
  const initial = await get(server);
  const started = Date.now();
  const first = await submit(server, order);
  assert.equal(first.status, 202);
  assert.deepEqual(first.data, { status: 'pending', requestId: order.requestId });
  const attempts = await Promise.all(Array.from({ length: 4 }, () => submit(server, order)));
  assert.ok(attempts.every(r => [200, 202].includes(r.status) && r.data.requestId === order.requestId));
  const result = await outcome(server, order.requestId);
  assert.equal(result.status, 200);
  const filled = await result.json();
  assert.equal(filled.filled, 1);
  assert.ok(filled.time >= started && filled.time >= initial.time);
  const account = await get(server);
  assert.equal(account.orders.length, 1);
  assert.equal(account.account.positions[0].quantity, 1);
  const rejected = { ...order, requestId: 'rejected-sell-123', side: 'sell', quantity: 2 };
  assert.ok([202, 400].includes((await submit(server, rejected)).status));
  assert.equal((await outcome(server, rejected.requestId)).status, 422);
  await stop(server);
  server = await launch({ port: 18411, dataDir, interval: 60000 });
  assert.equal((await submit(server, { ...order, price: 0 })).data.id, filled.id);
  assert.equal((await submit(server, { ...order, quantity: 2 })).status, 409);
  assert.equal((await outcome(server, 'no-accepted-order')).status, 404);
  await submit(server, { ...order, requestId: 'another-holding-123' });
  assert.equal((await submit(server, rejected)).status, 400);
  assert.equal((await outcome(server, rejected.requestId)).status, 422);
  assert.equal((await get(server)).account.positions[0].quantity, 2);
});

test('an evicted order is queryable and retryable after restarting with a full history', async t => {
  const dataDir = await tempData('order-archive');
  const m = new Market();
  const stock = m.getStock(order.code);
  for (let i = 0; i < 500; i++) {
    const resting = m.placeOrder({ ...order, requestId: 'archive-order-' + i, type: 'limit', price: stock.lowerLimit });
    m.cancelOrder(resting.id);
  }
  await writeFile(path.join(dataDir, 'market-state.json'), JSON.stringify(m.checkpoint('closed', Date.now())));
  let server = await launch({ port: 18412, dataDir, interval: 60000 });
  t.after(() => stop(server));
  assert.equal((await submit(server, order)).status, 200);
  const key = 'archive-order-0';
  assert.ok(!(await get(server)).orders.some(o => o.requestId === key));
  await stop(server);
  server = await launch({ port: 18412, dataDir, interval: 60000 });
  const original = (await (await outcome(server, key)).json());
  assert.equal(original.id, 'P000001');
  assert.equal(original.status, 'cancelled');
  const terms = { ...order, requestId: key, type: 'limit', price: stock.lowerLimit };
  assert.deepEqual((await submit(server, terms)).data, original);
  assert.equal((await submit(server, { ...terms, price: terms.price + stock.unit })).status, 409);
  assert.equal((await get(server)).account.positions[0].quantity, 1);
});

test('current-price liquidity is executable once, and resting-order cap permits immediate sales', () => {
  const m = new Market({ seed: 3 });
  const stock = m.getStock(order.code);
  stock.asks = [[stock.price, 1], [stock.price + stock.unit, 100]];
  const bought = m.placeOrder({ ...order, price: stock.price, type: 'limit' });
  assert.equal(bought.average, stock.price);
  assert.equal(m.detail(stock.code).asks[0][0], stock.price + stock.unit);
  for (let i = 0; i < 100; i++) {
    m.placeOrder({ ...order, requestId: 'resting-buy-' + i, price: stock.lowerLimit, type: 'limit' });
  }
  const sell = { ...order, side: 'sell', requestId: 'available-sell-123' };
  assert.throws(() => m.placeOrder({ ...sell, type: 'limit', price: stock.upperLimit }), /미체결 주문/);
  assert.equal(m.placeOrder(sell).filled, 1);
  assert.equal(m.orders.filter(o => o.status === 'open').length, 100);
});
