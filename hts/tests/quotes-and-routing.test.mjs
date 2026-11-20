import {tickSize,adjacentPrice} from '../public/price-grid.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BAR_LIMIT, CandleHistory, PERIODS } from '../candles.mjs';
import { Market } from '../market.mjs';
import { isLocalHost, bufferEvent } from '../http-routes.mjs';
import { launch, stop, tempData, get, sleep } from './helpers.mjs';

test('KST candle buckets have exact OHLC, a bounded history and no synthetic gap bars', () => {
  const h = new CandleHistory();
  const midnight = Date.parse('2026-11-18T09:00:00+09:00');
  const record = (time, price) => h.record(time, [{ code: '005930', price }]);
  for (const [secs, v] of [[-20,90],[2,100],[5,110],[13,98],[40,103],[65,99],[190,108]]) record(midnight + secs * 1000, v);
  const series = h.books.get('005930');
  assert.deepEqual(series['1m'].slice(1), [
    [midnight,100,110,98,103], [midnight+60000,99,99,99,99], [midnight+180000,108,108,108,108],
  ]);
  assert.deepEqual(series['3m'].at(-2), [midnight,100,110,98,99]);
  for (const p of ['5m','30m','1h','1d']) assert.deepEqual(series[p].at(-1), [midnight,100,110,98,108]);
  record(midnight+6*86400000, 120);
  assert.equal(series['1d'].length, 3);
  for (let i = 1; i <= 140; i++) record(midnight+(6+i)*86400000, 120+i);
  for (const p of Object.keys(PERIODS)) assert.equal(series[p].length, BAR_LIMIT);
});

test('chart restart restores saved bars, replays committed ticks and omits off-time and order entries', async () => {
  const dir = await tempData('candles-recovery');
  const h = new CandleHistory();
  const base = Date.parse('2026-11-18T09:00:00+09:00');
  h.record(base, [{code:'005930',price:100}]);
  await h.save(dir, f => f());
  const journal = [
    {event:'tick',time:base,prices:{'005930':100}},
    {event:'order',time:base+1000,prices:{'005930':500}},
    {event:'tick',time:base+2000,prices:{'005930':103}},
    {event:'tick',time:base+4000,prices:{'005930':999}},
  ];
  await writeFile(path.join(dir,'ticks.jsonl'), journal.map(x=>JSON.stringify(x)).join('\n')+'\n');
  const reopened = new CandleHistory();
  await reopened.restore(dir,base+3000);
  assert.deepEqual(reopened.books.get('005930')['1d'], [[base,100,103,100,103]]);
  assert.ok(await readFile(path.join(dir,'candles.json'),'utf8'));
});

test('reopening a real server serves all six prior candle series before the first new tick', async t => {
  const dir = await tempData('candle-session');
  let server = await launch({port:18449, dataDir:dir, interval:50});
  t.after(() => stop(server));
  for (let attempt = 0; attempt < 100 && !(await get(server, '/api/health')).tick; attempt++) await sleep(30);
  await stop(server);
  const saved = JSON.parse(await readFile(path.join(dir, 'kospi10', 'candles.json'),'utf8'));
  server = await launch({port:18449, dataDir:dir, interval:60000});
  assert.equal((await get(server, '/api/health')).tick, 0);
  for (const period of Object.keys(PERIODS)) {
    const result = await get(server, '/api/candles?symbol=005930&period=' + period);
    assert.ok(result.bars.length > 0);
    assert.deepEqual(result.bars.slice(-saved.books['005930'][period].length), saved.books['005930'][period]);
    assert.equal(result.through, saved.through);
  }
});

test('quote capacity and limits use real per-issue shares and the tick size at each limit', () => {
  const market = new Market();
  const quotes = market.state().stocks;
  assert.equal(quotes.length,10);
  for (const s of quotes) {
    assert.ok(Number.isSafeInteger(s.shares) && s.shares > 0);
    assert.ok(Number.isSafeInteger(s.shares*s.price));
    assert.equal(s.upperLimit % tickSize(s.upperLimit),0);
    assert.equal(s.lowerLimit % tickSize(s.lowerLimit),0);
    assert.ok(s.upperLimit*100 <= s.prev*130 && adjacentPrice(s.upperLimit,1)*100 > s.prev*130);
    assert.ok(s.lowerLimit*100 >= s.prev*70 && adjacentPrice(s.lowerLimit,-1)*100 < s.prev*70);
  }
  const stock = market.getStock('005930');
  assert.equal(stock.shares,quotes.find(q=>q.code==='005930').shares);
  for (const price of [stock.upperLimit,stock.lowerLimit]) {
    stock.price = price;
    for (const side of ['buy','sell']) {
      market.makeBook(stock,side);
      for (const [p] of [...stock.asks,...stock.bids]) assert.ok(p>=stock.lowerLimit && p<=stock.upperLimit);
    }
  }
});

test('newest account state wins when an SSE stream drains after an order and a later tick', () => {
  const queue = new Map();
  for(const [type, payload] of [['tick',1],['orders',1],['account',2],['tick',3],['detail',3],['account',4]]) bufferEvent(queue,type,payload);
  assert.deepEqual([...queue],[['orders',1],['tick',3],['detail',3],['account',4]]);
});

test('routes distinguish methods, invalid content and unknown paths, including default HTTP port', async t => {
  assert.equal(isLocalHost('localhost',80),true);
  assert.equal(isLocalHost('127.0.0.1',5173),false);
  const server = await launch({port:18448,dataDir:await tempData('routes')});
  t.after(()=>stop(server));
  const request = (route, init) => fetch(server.url+route,init);
  const orders = await request('/api/orders');
  assert.equal(orders.status,405);
  assert.equal(orders.headers.get('Allow'),'POST');
  assert.equal((await request('/api/health',{method:'POST'})).status,405);
  assert.equal((await request('/missing',{method:'POST'})).status,404);
  assert.equal((await request('/api/orders',{method:'POST',body:'null'})).status,415);
  const jsonPost = body => ({method:'POST',headers:{'Content-Type':'application/json'},body});
  assert.equal((await request('/api/orders',jsonPost('null'))).status,400);
  assert.equal((await request('/api/orders',jsonPost('[]'))).status,400);
  assert.equal((await request('/api/candles?symbol=005930&period=other')).status,400);
});
