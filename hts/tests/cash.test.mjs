import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { mkdir, readFile, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { launch, stop, get, post, tempData } from './helpers.mjs';

async function* sseFrames(body) {
  let pending = '';
  for await (const chunk of body.pipeThrough(new TextDecoderStream())) {
    pending += chunk;
    let end;
    while ((end = pending.indexOf('\n\n')) !== -1) {
      const frame = pending.slice(0, end);
      pending = pending.slice(end + 2);
      const match = /^event: (\w+)\ndata: (.+)$/s.exec(frame);
      if (match) yield { type: match[1], data: JSON.parse(match[2]) };
    }
  }
}

const transfer = (requestId, revision, amount, direction = 'deposit') => ({ requestId, revision, amount, direction });

test('cash updates appear on the live feed, are committed before OK and do not repeat on restart', { timeout: 20000 }, async t => {
  const dataDir = await tempData('cash-restart');
  const options = { port: 18451, dataDir, interval: 60000 };
  let server = await launch(options);
  t.after(() => stop(server));
  const form = await fetch(server.url + '/cash');
  assert.equal(form.status, 200);
  assert.match(await form.text(), /id="cash-form"/);
  const initial = await get(server, '/api/cash');
  const controller = new AbortController();
  const response = await fetch(server.url + '/api/events', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]) });
  const frames = sseFrames(response.body);
  const deposit = transfer('deposit-restart', initial.revision, 10000);
  try {
    assert.equal((await frames.next()).value.type, 'state');
    const result = await post(server, '/api/cash', deposit);
    assert.equal(result.status, 200);
    assert.equal(result.data.ok, true);
    assert.equal(result.data.cash, initial.cash + deposit.amount);
    const saved = JSON.parse(await readFile(path.join(dataDir, 'kospi10', 'market-state.json'), 'utf8'));
    assert.equal(saved.account.cash, result.data.cash);
    assert.equal(saved.account.cashRevision, initial.revision + 1);
    assert.equal(saved.account.lastCashOperation.requestId, deposit.requestId);
    const live = (await frames.next()).value;
    assert.equal(live.type, 'account');
    assert.equal(live.data.cash, saved.account.cash);
    assert.equal(live.data.available, result.data.available);
  } finally {
    await frames.return();
    controller.abort();
  }
  await stop(server);
  server = await launch(options);
  const restored = await get(server, '/api/cash');
  assert.equal(restored.cash, initial.cash + deposit.amount);
  assert.equal(restored.revision, initial.revision + 1);
  const retry = await post(server, '/api/cash', deposit);
  assert.equal(retry.data.ok, true);
  assert.deepEqual(await get(server, '/api/cash'), restored);
  assert.equal((await post(server, '/api/cash', { ...deposit, amount: 1 })).status, 409);
  assert.deepEqual(await get(server, '/api/cash'), restored);
});

test('withdrawals respect reservations, validate input and serialize transfers from the same revision', async t => {
  const dataDir = await tempData('cash-reservations');
  const server = await launch({ port: 18452, dataDir, interval: 60000 });
  t.after(() => stop(server));
  const symbol = (await get(server)).stocks[0];
  const reserve = await post(server, '/api/orders', { code: symbol.code, side: 'buy', type: 'limit', price: symbol.lowerLimit, quantity: 2, requestId: 'cash-reservation-test' });
  assert.equal(reserve.data.status, 'open');
  const before = await get(server, '/api/cash');
  assert.equal(before.cash - before.available, symbol.lowerLimit * 2);
  for (const amount of [0, -1, 0.5, '10', before.available + 1, before.cash + 1]) {
    const invalid = await post(server, '/api/cash', transfer('cash-not-applied', before.revision, amount, 'withdraw'));
    assert.equal(invalid.status, 400);
    assert.deepEqual(await get(server, '/api/cash'), before);
  }
  const response = await Promise.all(['cash-winner-a','cash-winner-b'].map(id =>
    post(server, '/api/cash', transfer(id, before.revision, before.available, 'withdraw'))));
  assert.deepEqual(response.map(r => r.status).sort(), [200, 409]);
  const after = await get(server, '/api/cash');
  assert.equal(after.available, 0);
  assert.equal(after.cash, before.cash - before.available);
  assert.equal(after.revision, before.revision + 1);
});

test('failed cash persistence returns 503 and restart recovers the last confirmed balance', { timeout: 20000 }, async t => {
  const dataDir = await tempData('cash-disk-error');
  const options = { port: 18453, dataDir, interval: 60000 };
  let server = await launch(options);
  t.after(() => stop(server));
  const good = await post(server, '/api/cash', transfer('cash-disk-good', 0, 5000));
  assert.equal(good.data.ok, true);
  const checkpointPath = path.join(dataDir, 'kospi10', 'market-state.json');
  const durable = await readFile(checkpointPath, 'utf8');
  // An empty test directory at the staging path makes the next file write fail.
  const obstruction = checkpointPath + '.tmp';
  await mkdir(obstruction);
  const exit = once(server.child, 'exit');
  const failed = await post(server, '/api/cash', transfer('cash-disk-failed', 1, 900));
  assert.equal(failed.status, 503);
  assert.notEqual(failed.data.ok, true);
  assert.equal((await exit)[0], 1);
  assert.equal(await readFile(checkpointPath, 'utf8'), durable);
  await rmdir(obstruction);
  server = await launch(options);
  const recovered = await get(server, '/api/cash');
  assert.equal(recovered.cash, good.data.cash);
  assert.equal(recovered.revision, good.data.revision);
  assert.equal(recovered.lastOperation.requestId, 'cash-disk-good');
});
