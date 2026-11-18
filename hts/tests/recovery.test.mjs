import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Market } from '../market.mjs';
import { validateCheckpoint } from '../checkpoint.mjs';
import { tempData, launch, stop, get, post } from './helpers.mjs';

test('two simultaneous recoveries leave one writer and preserve the acknowledged order', { timeout: 25000 }, async t => {
  const dataDir = await tempData('race-recovery');
  const prior = await launch({ port: 18441, dataDir, interval: 60000 });
  t.after(() => stop(prior));
  const buy = await post(prior, '/api/orders', { code: '005930', side: 'buy', type: 'market', quantity: 1, requestId: 'recovery-one-buy' });
  assert.equal(buy.status, 200);
  const exit = once(prior.child, 'exit');
  prior.child.kill('SIGKILL');
  await exit;
  const attempts = await Promise.allSettled([18441, 18442].map(port => launch({ port, dataDir, interval: 60000 })));
  const winners = attempts.filter(r => r.status === 'fulfilled').map(r => r.value);
  for (const winner of winners) t.after(() => stop(winner));
  assert.equal(winners.length, 1, JSON.stringify(attempts.map(r => r.reason?.message)));
  assert.match(attempts.find(r => r.status === 'rejected').reason.message, /이미 실행/);
  const state = await get(winners[0]);
  assert.equal(state.account.positions[0].quantity, 1);
  await stop(winners[0]);
  const closed = JSON.parse(await readFile(path.join(dataDir, 'market-state.json'), 'utf8'));
  assert.equal(closed.status, 'closed');
  assert.equal(closed.account.orders.length, 1);
});

function withReservations() {
  const market = new Market();
  const buy = { code: '005930', side: 'buy', type: 'market', quantity: 3, requestId: 'restore-buy' };
  market.placeOrder(buy);
  const stock = market.getStock(buy.code);
  market.placeOrder({ ...buy, side: 'sell', type: 'limit', quantity: 2, price: stock.asks.at(-1)[0], requestId: 'restore-sell' });
  return market.checkpoint('running');
}

test('valid JSON with inconsistent order, inventory or cash fields is rejected before recovery', async () => {
  const valid = withReservations();
  validateCheckpoint(valid);
  const malformed = [
    s => { s.account.holdings[0].code = 'unknown'; },
    s => { s.account.holdings[0].quantity = 1; }, // 2 shares already reserved
    s => { s.account.cash = -1; },
    s => { delete s.account.nextOrderId; },
    s => { s.account.nextOrderId = 1; },
    s => { s.account.orders[1].id = s.account.orders[0].id; },
    s => { s.account.orders[1].remaining = 1; },
    s => { s.account.orders[1].status = 'filled'; },
    s => { s.account.cashRevision = 1; },
  ];
  for (const change of malformed) {
    const copy = structuredClone(valid);
    change(copy);
    assert.throws(() => validateCheckpoint(copy), /저장된 시세/);
  }
  const dataDir = await tempData('bad-account');
  const file = path.join(dataDir, 'market-state.json');
  const invalid = structuredClone(valid);
  delete invalid.account.nextOrderId;
  const bytes = JSON.stringify(invalid);
  await writeFile(file, bytes);
  await assert.rejects(launch({ port: 18443, dataDir }), /저장된 시세/);
  assert.equal(await readFile(file, 'utf8'), bytes);
  // A corrected historical checkpoint with no cash operation metadata reopens.
  await writeFile(file, JSON.stringify(valid));
  const server = await launch({ port: 18443, dataDir, interval: 60000 });
  try { assert.equal((await get(server)).account.positions[0].available, 1); }
  finally { await stop(server); }
});
