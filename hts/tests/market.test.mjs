import test from 'node:test';
import assert from 'node:assert/strict';
import { Market, INITIAL_CASH } from '../market.mjs';
import { STOCKS } from '../public/market-data.mjs';
const make = () => new Market({ seed: 100, now: 1000000 });
let request = 0;
const buy = (m, extra = {}) => m.placeOrder({ code: '005930', side: 'buy', type: 'market', quantity: 1, requestId: `test-request-${request++}`, ...extra });
test('exactly 100 distinct real KOSPI symbols start at hardcoded closing prices', () => {
  const m = make(); assert.equal(STOCKS.length, 100); assert.equal(new Set(STOCKS.map(s => s.code)).size, 100);
  for (const s of m.stocks) { assert.equal(s.price, STOCKS.find(q => q.code === s.code).close); assert.equal(s.prev, s.price); assert.equal(s.history.length, 1); assert.equal(s.volume, 0); }
});
test('same seed and tick sequence reproduce prices, books and volumes', () => {
  const a = make(), b = make(); for (let i = 0; i < 500; i++) { a.step(); b.step(); }
  assert.deepEqual(a.state(), b.state()); const c = new Market({ seed: 101, now: 1000000 }); c.step(); assert.notEqual(a.getStock('005930').price, c.getStock('005930').price);
});
test('history and trades remain bounded over 300,000 symbol updates', () => {
  const m = make(); for (let i = 0; i < 3000; i++) m.step();
  for (const s of m.stocks) {
    assert.equal(s.history.length, 180); assert.equal(s.trades.length, 30); assert.ok(s.price >= s.prev * .7 && s.price <= s.prev * 1.3); assert.ok(s.volume > 0);
    for (const [p, q] of s.asks) { assert.ok(p >= s.price && p <= s.upperLimit); assert.ok(q > 0); }
    for (const [p, q] of s.bids) { assert.ok(p <= s.price && p >= s.lowerLimit); assert.ok(q > 0); }
    if (s.asks.length && s.bids.length) assert.equal(s.asks[0][0] - s.bids[0][0], s.unit);
    const latestSide = s.trades[0].side;
    assert.equal((latestSide === 'buy' ? s.asks : s.bids)[0][0], s.price);
  }
});
test('market buy/sell debit and credit actual execution prices, reject overselling', () => {
  const m = make(), s = m.getStock('005930'), ask = s.asks[0][0], bid = s.bids[0][0];
  const order = buy(m, { quantity: 2 }); assert.equal(order.filled, 2); assert.equal(m.cash, INITIAL_CASH - ask * 2);
  assert.equal(m.holdings.get(s.code).average, ask);
  assert.throws(() => buy(m, { side: 'sell', quantity: 3 }), /수량이 부족/);
  buy(m, { side: 'sell', quantity: 2 }); assert.equal(m.cash, INITIAL_CASH + (bid - ask) * 2); assert.equal(m.holdings.size, 0); assert.equal(m.realized, (bid - ask) * 2);
});
test('buy cash and sell shares are reserved and restored on cancellation', () => {
  const m = make(), s = m.getStock('005930');
  const limit = buy(m, { type: 'limit', price: Math.ceil(s.prev * .7 / s.unit) * s.unit, quantity: 10 }); assert.equal(limit.status, 'open');
  assert.equal(m.availableCash(), INITIAL_CASH - limit.limit * 10);
  m.cancelOrder(limit.id); assert.equal(m.availableCash(), INITIAL_CASH); assert.throws(() => m.cancelOrder(limit.id));
  buy(m, { quantity: 10 }); const sell = buy(m, { side: 'sell', type: 'limit', price: Math.floor(s.prev * 1.3 / s.unit) * s.unit, quantity: 8 });
  assert.equal(m.availableShares(s.code), 2); assert.throws(() => buy(m, { side: 'sell', quantity: 3 }));
  m.cancelOrder(sell.id); assert.equal(m.availableShares(s.code), 10);
});
test('partial fills consume liquidity and limit remainder fills only when price crosses', () => {
  const m = make(), s = m.getStock('005930'); s.asks = [[s.price + s.unit, 2]];
  const order = buy(m, { type: 'limit', price: s.price + s.unit, quantity: 5 });
  assert.equal(order.status, 'partial'); assert.equal(order.filled, 2); assert.equal(order.remaining, 3);
  s.asks = [[s.price + 2 * s.unit, 100]]; m.match(order); assert.equal(order.remaining, 3);
  s.asks = [[s.price, 3]]; m.match(order); assert.equal(order.status, 'filled'); assert.equal(m.holdings.get(s.code).quantity, 5);
});
test('market remainder rests at the daily limit and duplicate request does not execute twice', () => {
  const m = make(), s = m.getStock('005930'); s.asks = [[s.price + s.unit, 1]];
  const a = buy(m, { quantity: 4, requestId: 'idempotent-123' }); assert.equal(a.status, 'partial'); assert.equal(a.filled, 1); assert.equal(m.availableCash(), m.cash-3*s.upperLimit);
  const b = buy(m, { quantity: 4, requestId: 'idempotent-123' }); assert.equal(a.id, b.id); assert.equal(m.holdings.get(s.code).quantity, 1);
});
test('invalid and unaffordable orders leave the account unchanged', () => {
  const m = make();
  for (const extra of [{ quantity: -1 }, { quantity: 0 }, { quantity: 1.5 }, { quantity: Infinity }, { quantity: 1000000 }, { code: 'UNKNOWN' }, { side: 'short' }, { type: 'other' }, { type: 'limit', price: 1.5 }]) assert.throws(() => buy(m, extra));
  assert.equal(m.cash, INITIAL_CASH); assert.equal(m.orders.length, 0);
});
test('restart uses the last current price as close, preserves account, preserves open orders', () => {
  const m = make(); m.step(); buy(m, { quantity: 2 }); buy(m, { type: 'limit', price: 145000, quantity: 1 });
  const saved = m.checkpoint('closed'), restarted = new Market({ seed: 100, previous: saved, now: 3000000 });
  for (const s of restarted.stocks) assert.equal(s.price, m.getStock(s.code).price);
  assert.equal(restarted.cash, m.cash); assert.equal(restarted.holdings.get('005930').quantity, 2);
  assert.deepEqual(restarted.orders, m.orders); assert.equal(restarted.tick, 0);
});
test('limit prices clamp before execution, reservation and request replay', () => {
  const m = make(), stock = m.getStock('005930');
  for (const [price,limit] of [[stock.lowerLimit-1,stock.lowerLimit],[stock.upperLimit+1,stock.upperLimit]]) {
    const requestId='clamp-price-'+price;
    const order=buy(m,{type:'limit',price,requestId});
    assert.equal(order.limit,limit);
    assert.equal(buy(m,{type:'limit',price,requestId}),order);
    assert.equal(buy(m,{type:'limit',price:limit,requestId}),order);
  }
  assert.equal(m.orders.length,2);
  assert.equal(m.holdings.get(stock.code).quantity,1);
  assert.equal(m.availableCash(),m.cash-stock.lowerLimit);
});
test('both market sweeps keep the remainder on the correct side through restart and fill on new liquidity',async()=>{
  const {validateCheckpoint}=await import('../checkpoint.mjs');
  for(const side of ['buy','sell']){
    const m=make(),s=m.getStock('005930'),buying=side==='buy',limit=buying?s.upperLimit:s.lowerLimit;
    m.cash=10_000_000_000;
    if(!buying)m.holdings.set(s.code,{code:s.code,quantity:8000,average:s.price});
    const levels=buying?'asks':'bids',queue=buying?'bids':'asks';
    const last=s.price+(buying?1:-1)*s.unit;
    s[levels]=[[s.price,2],[last,3]];
    const request={code:s.code,type:'market',side,requestId:'sweep-test-'+side,quantity:8000};
    const order=m.placeOrder(request);
    assert.equal(order.filled,5);assert.equal(order.remaining,7995);
    assert.equal(s.price,last);assert.equal(order.limit,limit);
    assert.deepEqual(m.detail(s.code)[queue][0],[limit,7995]);
    const checkpoint=m.checkpoint('closed');validateCheckpoint(checkpoint);
    const restored=new Market({previous:checkpoint,now:m.time});
    assert.equal(restored.placeOrder(request).remaining,7995);
    restored.step();
    const updated=restored.orders.at(-1);
    assert.equal(restored.getStock(s.code).price,limit);
    assert.ok(updated.remaining>0 && updated.remaining<7995);
    assert.deepEqual(restored.detail(s.code)[queue][0],[limit,updated.remaining]);
    restored.cancelOrder(updated.id);
    assert.equal(restored.availableCash(),restored.cash);
    assert.equal(restored.availableShares(s.code),restored.holdings.get(s.code)?.quantity??0);
  }
});
test('Samsung round-trip consumes hidden prices to the ceiling and then to the sell limit',()=>{
  const m=make(), s=m.getStock('005930');
  s.price=200000; s.lowerLimit=140000; s.upperLimit=240000;
  m.makeBook(s);
  m.cash=1_000_000_000_000;
  m.holdings.set(s.code,{code:s.code,quantity:1_000_000,average:s.price});
  const purchase=buy(m,{quantity:1_000_000});
  assert.equal(s.price,240000);
  if(purchase.remaining)m.cancelOrder(purchase.id);
  const before=m.detail(s.code);
  assert.equal(before.bids.length,10);
  assert.equal(before.bids[0][0],240000-s.unit);
  const visible=before.bids.reduce((n,l)=>n+l[1],0);
  const request={code:s.code,type:'limit',price:190000,quantity:1_000_000,side:'sell',requestId:'deep-limit-sweep'};
  const sale=m.placeOrder(request);
  assert.ok(sale.filled>visible);
  assert.ok(sale.remaining>0);
  assert.equal(s.price,190000);
  assert.ok(sale.average>190000);
  assert.equal(m.prints.at(-1)[1],190000);
  for(let i=1;i<m.prints.length;i++)assert.equal(m.prints[i-1][1]-m.prints[i][1],s.unit);
  assert.equal(m.detail(s.code).bids[0][0],190000-s.unit);
  assert.equal(m.detail(s.code).asks[0][0],190000);
  assert.equal(m.placeOrder(request).filled,sale.filled);
  const restored=new Market({previous:m.checkpoint('closed')});
  assert.deepEqual(restored.detail(s.code).bids,m.detail(s.code).bids);
  assert.equal(restored.orders.at(-1).remaining,sale.remaining);
});
test('after a 116493-share Samsung sale reaches 193000, subsequent quotes track the last fill',()=>{
  const m=make(), s=m.getStock('005930');
  s.price=s.upperLimit=247300; s.lowerLimit=133300; s.unit=100;
  s.dynamics.anchor=s.dynamics.latent=s.price;
  m.makeBook(s);
  m.holdings.set(s.code,{code:s.code,quantity:116493,average:246806});
  const sale=m.placeOrder({code:s.code,type:'limit',side:'sell',quantity:116493,price:193000,requestId:'price-impact-replay'});
  assert.equal(s.price,193000);
  assert.equal(s.dynamics.anchor,193000);
  assert.ok(sale.remaining>0);
  for(let i=0;i<30;i++){
    m.step();
    assert.ok(Math.abs(s.price-193000)<=400);
    const {asks,bids}=m.detail(s.code);
    assert.ok(Math.abs(asks[0][0]-193000)<=500 && Math.abs(bids[0][0]-193000)<=500);
  }
});
