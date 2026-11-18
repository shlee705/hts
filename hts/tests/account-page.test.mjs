import test from 'node:test';
import assert from 'node:assert/strict';
import { launch, stop, tempData, post } from './helpers.mjs';

test('trading, account and cash have independent entry points and a single active navigation link', async t => {
  const server = await launch({ port: 18413, dataDir: await tempData('page-routes'), interval: 60000 });
  t.after(() => stop(server));
  for (const [route, panel, script] of [
    ['/', 'order-form', 'app.mjs'], ['/account?tab=open', 'account-panel', 'account.mjs'], ['/cash', 'cash-form', 'cash.mjs'],
  ]) {
    const response = await fetch(server.url + route);
    assert.equal(response.status, 200);
    const html = await response.text();
    const path = route.split('?')[0];
    assert.ok(html.includes('id="' + panel + '"'));
    assert.equal(['order-form', 'account-panel', 'cash-form'].filter(id => html.includes('id="' + id + '"')).length, 1);
    const nav = html.match(/<nav\b[^>]*>(.*?)<\/nav>/s)[1];
    assert.deepEqual([...nav.matchAll(/href="([^"]+)"/g)].map(hit => hit[1]), ['/', '/account', '/cash']);
    assert.ok(nav.includes('href="' + path + '" class="active" aria-current="page"'));
    assert.equal([...nav.matchAll(/aria-current=/g)].length, 1);
    assert.ok(html.includes('src="/' + script + '"'));
    assert.equal((await fetch(server.url + '/' + script)).status, 200);
  }
  // The standalone account page observes the same live state as a trading tab.
  const ac = new AbortController();
  t.after(() => ac.abort());
  const stream = await fetch(server.url + '/api/events?symbol=005930', { signal: AbortSignal.any([ac.signal, AbortSignal.timeout(10000)]) });
  const reader = stream.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  async function nextEvent(type) {
    for (;;) {
      const i = buffer.indexOf('\n\n');
      if (i < 0) {
        const { value, done } = await reader.read();
        assert.ok(!done, 'Account feed closed before ' + type);
        buffer += value; continue;
      }
      const message = buffer.slice(0, i); buffer = buffer.slice(i + 2);
      if (message.startsWith('event: ' + type + '\n')) return JSON.parse(message.slice(message.indexOf('data: ') + 6));
    }
  }
  try {
    const initial = await nextEvent('state'), s = initial.stocks.find(q => q.code === '005930');
    const placed = await post(server, '/api/orders', { code: s.code, side: 'buy', type: 'limit', quantity: 1, price: s.lowerLimit, requestId: 'account-open-order' });
    assert.equal(placed.status, 200);
    const reserved = await nextEvent('account');
    assert.equal(reserved.available, initial.account.available - s.lowerLimit);
    const change = await nextEvent('orders');
    assert.equal(change.updates[0].status, 'open');
    assert.equal((await post(server, '/api/orders/' + placed.data.id + '/cancel', {})).status, 200);
    assert.equal((await nextEvent('account')).available, initial.account.available);
    assert.equal((await nextEvent('orders')).updates[0].status, 'cancelled');
  } finally { ac.abort(); }
});
