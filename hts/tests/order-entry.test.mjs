import test from 'node:test';
import assert from 'node:assert/strict';
import { createQuoteFeed, createOrderEntry, fillableQuantity } from '../public/order-entry.mjs';

class TestStream extends EventTarget {
  close() { this.readyState = 2; }
  send(type, data) { this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data) })); }
}

test('order entry cannot use a stale quote, including A → B → A with late snapshots', () => {
  const streams = [], enabled = [], updates = [];
  let displayed, selected, delay;
  const feed = createQuoteFeed({
    open() { const stream = new TestStream(); streams.push(stream); return stream; },
    renderSnapshot(snapshot) {
      assert.equal(feed.ready(selected), false, 'orders must be disabled while the form is changing');
      displayed = [snapshot.detail.code, snapshot.price];
    },
    update: (event, data) => updates.push([event, data]),
    status(connected) { if (connected) enabled.push([...displayed]); },
    later(callback) { delay = callback; }, cancel() {},
  });
  const select = code => { selected = code; feed.connect(code); };
  select('A'); streams[0].send('state', { detail: { code: 'A' }, price: 10 });
  assert.equal(feed.ready('A'), true);
  select('B');
  assert.equal(feed.ready('A'), false); assert.equal(feed.ready('B'), false);
  streams[1].send('tick', { price: 90 });
  streams[0].send('state', { detail: { code: 'A' }, price: 11 });
  select('A');
  streams[0].send('state', { detail: { code: 'A' }, price: 12 });
  streams[1].send('state', { detail: { code: 'B' }, price: 90 });
  assert.equal(feed.ready('A'), false);
  streams[2].send('state', { detail: { code: 'A' }, price: 13 });
  assert.deepEqual(enabled, [['A', 10], ['A', 13]]);
  assert.deepEqual(updates, []);
  streams[2].close(); streams[2].onerror();
  assert.equal(feed.ready('A'), false);
  delay(); assert.equal(streams.length, 4);
  streams[3].send('state', { detail: { code: 'A' }, price: 14 });
  assert.deepEqual(enabled.at(-1), ['A', 14]);
});

function memoryStorage() {
  const map = new Map();
  return { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value), removeItem: key => map.delete(key) };
}

const order = { code: '005930', side: 'buy', type: 'limit', price: 205000, quantity: 1 };
test('delayed order blocks fresh IDs through symbol changes and reload, then recovers the committed result', async () => {
  const storage = memoryStorage(), sent = [], notices = [];
  let resolveSend;
  const config = {
    storage, uuid: () => 'order-from-this-tab', notify: event => notices.push(event),
    send(payload) { sent.push(payload); return new Promise(resolve => { resolveSend = resolve; }); },
    lookup: async id => ({ status: 200, data: { ...order, limit: order.price, id: 'P000001', requestId: id } }),
  };
  const first = createOrderEntry(config);
  const sending = first.submit(order);
  await first.submit({ ...order, code: '000660' });
  resolveSend({ status: 202, data: { status: 'pending', requestId: 'order-from-this-tab' } }); await sending;
  assert.ok(first.pending);
  const reloaded = createOrderEntry(config);
  await reloaded.submit(order);
  await reloaded.check();
  assert.deepEqual(sent, [{ ...order, requestId: 'order-from-this-tab' }]);
  assert.ok(notices.includes('accepted'));
  assert.equal(reloaded.pending, null);
  assert.equal(createOrderEntry(config).pending, null);
});

test('lost transport permits only an explicit retry of the original terms after a missing lookup', async () => {
  const sent = [], storage = memoryStorage();
  let unavailable = true;
  const entry = createOrderEntry({
    storage, uuid: () => 'order-for-missing-lookup', notify() {},
    async send(payload) {
      sent.push(structuredClone(payload));
      if (sent.length === 1) throw Error('connection lost');
      return { status: 200, data: { ...payload, limit: payload.price, id: 'P000002' } };
    },
    lookup: async () => ({ status: unavailable ? 503 : 404, data: {} }),
  });
  await entry.submit(order); await entry.check(); await entry.retry();
  assert.equal(sent.length, 1);
  unavailable = false;
  await entry.check(); await entry.submit({ ...order, side: 'sell' });
  assert.equal(entry.mayRetry, true); assert.equal(sent.length, 1);
  await entry.retry(); assert.deepEqual(sent[1], sent[0]); assert.equal(entry.pending, null);
});

test('a recorded rejection after a lost response unlocks the form without sending a second order', async () => {
  let count = 0, reason;
  const entry = createOrderEntry({
    storage: memoryStorage(), uuid: () => 'order-rejected-late',
    notify: (type, value) => { if (type === 'rejected') reason = value; },
    send: async () => { count++; throw Error('lost'); },
    lookup: async requestId => ({ status: 422, data: { status: 'rejected', error: '잔고 부족', requestId } }),
  });
  await entry.submit(order); await entry.check(); await entry.retry();
  assert.equal(count, 1); assert.equal(reason, '잔고 부족'); assert.equal(entry.pending, null);
});

test('market fill size respects zero, partial and exhausted depth', () => {
  const levels = [[1000, 0], [1010, 5], [1020, 3]];
  assert.equal(fillableQuantity(levels, 6), 6); assert.equal(fillableQuantity(levels, 20), 8);
  assert.equal(fillableQuantity([], 20), 0); assert.equal(fillableQuantity(levels, -1), 0);
});

test('lookup never confirms a different order with the same key as a successful fill', async () => {
  const notices = [];
  const entry = createOrderEntry({
    storage: memoryStorage(), uuid: () => 'same-id-different-order', notify: type => notices.push(type),
    send: async () => ({ status: 202, data: {} }),
    lookup: async requestId => ({ status: 200, data: { ...order, id: 'P000003', limit: order.price, quantity: 2, requestId } }),
  });
  await entry.submit(order); await entry.check();
  assert.ok(notices.includes('rejected')); assert.ok(!notices.includes('accepted'));
});
