import test from 'node:test';
import assert from 'node:assert/strict';
import { Market, PRICE_MODEL, EVENT_TYPES } from '../market.mjs';

const quietMarket = (seed = 42, tickMs = 1000) => {
  const market = new Market({ seed, tickMs, now: 0 });
  for (const stock of market.stocks) stock.dynamics.nextEventAt = Infinity;
  return market;
};
test('quiet prices stay near their anchor with much smaller tick movement', () => {
  const market = quietMarket(); let moves = 0, samples = 0;
  for (let tick = 0; tick < 1200; tick++) {
    const previous = market.stocks.map(s => s.price); market.step();
    market.stocks.forEach((s, i) => {
      const movement = Math.abs(s.price - previous[i]) / s.unit;
      assert.ok(movement <= 1); moves += movement; samples++;
      assert.ok(Math.abs(s.price - s.prev) <= Math.max(s.unit, s.prev * PRICE_MODEL.normalBandRatio) + s.unit / 2);
    });
  }
  assert.equal(market.recentEvents.length, 0);
  assert.ok(moves / samples < .35, `Mean movement ${moves / samples} ticks`);
  assert.ok(moves > 0);
});
test('fast feeds keep comparable volatility and do not accelerate event clocks', () => {
  const slow = quietMarket(42, 1000), fast = quietMarket(42, 50);
  let slowSpread = 0, fastSpread = 0;
  for (let i = 0; i < 60; i++) {
    slow.step(); for (let j = 0; j < 20; j++) fast.step();
    slowSpread += slow.stocks.reduce((n, s) => n + Math.abs(s.price - s.prev) / s.unit, 0);
    fastSpread += fast.stocks.reduce((n, s) => n + Math.abs(s.price - s.prev) / s.unit, 0);
  }
  assert.equal(fast.elapsedMs, slow.elapsedMs); assert.equal(fast.time, slow.time);
  assert.ok(fastSpread / slowSpread > .4 && fastSpread / slowSpread < 2, `Spread ratio ${fastSpread / slowSpread}`);
  const scheduled = new Market({ seed: 42, tickMs: 50, now: 0 });
  for (let i = 0; i < 800; i++) scheduled.step();
  assert.equal(scheduled.recentEvents.length, 0); assert.equal(scheduled.elapsedMs, 40000);
});
test('all four event classes gradually move prices in the intended direction and settle', () => {
  for (const [index, roll] of [.1, .5, .85, .95].entries()) {
    const market = quietMarket(), stock = market.getStock('005930'), initial = stock.price;
    market.eventRandom = () => roll; market.startEvent(stock);
    const event = stock.dynamics.event, definition = EVENT_TYPES[index];
    assert.equal(event.type, definition.type); assert.equal(stock.price, initial);
    assert.ok(Math.abs(event.impact) >= definition.impact[0] && Math.abs(event.impact) <= definition.impact[1]);
    market.step(); assert.ok(Math.abs(stock.dynamics.anchor - initial) < Math.abs(event.target - initial) / 10);
    while (market.elapsedMs < event.durationMs + 15000) market.step();
    assert.equal(stock.dynamics.event, null); assert.equal(stock.dynamics.anchor, event.target);
    assert.ok((stock.price - initial) * definition.direction > 0);
    assert.ok(Math.abs(stock.price - event.target) <= Math.max(stock.unit, event.target * PRICE_MODEL.normalBandRatio) + stock.unit / 2);
    const anchor = stock.dynamics.anchor; for (let i = 0; i < 15; i++) market.step();
    assert.equal(stock.dynamics.anchor, anchor);
  }
});
test('scheduled events are reproducible, periodic, mixed and bounded', () => {
  const a = new Market({ seed: 45, now: 0 }), b = new Market({ seed: 45, now: 0 });
  const types = new Set(), previousByCode = new Map(); let eventCount = 0;
  for (let i = 0; i < 4000; i++) {
    a.step(); b.step(); assert.deepEqual(a.tickEvents, b.tickEvents);
    for (const event of a.tickEvents) {
      types.add(event.type); eventCount++;
      const last = previousByCode.get(event.code);
      if (last) assert.ok(event.elapsedStart - last.elapsedStart >= last.durationMs + PRICE_MODEL.eventGapMs[0]);
      else assert.ok(event.elapsedStart >= PRICE_MODEL.firstEventMs[0] && event.elapsedStart <= PRICE_MODEL.firstEventMs[1] + 1000);
      previousByCode.set(event.code, event);
    }
  }
  assert.equal(types.size, 4); assert.ok(eventCount > 200); assert.equal(a.recentEvents.length, PRICE_MODEL.recentEventLimit);
  assert.deepEqual(a.state(), b.state()); assert.deepEqual(a.checkpoint().simulation, b.checkpoint().simulation);
});
test('KOSPI 10 matches its formula and retains its level across restarts', () => {
  const market = quietMarket(); const base=market.index().value; assert.equal(base,1000);
  const stock = market.stocks[0]; stock.price = stock.close * 1.1; market.updateIndex();
  assert.ok(Math.abs(market.index().value - base*(1+.1*stock.close*stock.shares/market.stocks.reduce((n,s)=>n+s.close*s.shares,0))) < 1e-9);
  for (const s of market.stocks) s.price = s.close * 1.01;
  market.updateIndex(); assert.ok(Math.abs(market.index().value - base*1.01) < 1e-9);
  assert.ok(Math.abs(market.index().changeRate - 1) < 1e-9); assert.equal(market.index().low, base);
  const restart = new Market({ previous: market.checkpoint('closed'), now: 60000 });
  assert.equal(restart.index().value, market.index().value); assert.equal(restart.index().previousClose, base);
  assert.equal(restart.index().change, market.index().change); assert.equal(restart.recentEvents.length, 0);
});
