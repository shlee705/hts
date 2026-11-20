import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {Market, INITIAL_CASH} from '../market.mjs';
import {OrderArchive} from '../order-archive.mjs';
import {cutoff, referenceBars} from '../reference-history.mjs';
import {INDEX_CODE, PERIODS} from '../candles.mjs';
import {adjacentPrice, validPrice, priceLimits} from '../public/price-grid.mjs';
import {STOCKS, referenceCap} from '../public/market-data.mjs';
import {get, launch, post, stop, tempData} from './helpers.mjs';

test('each adjacent quote crosses the tier boundary in both directions', () => {
  const market = new Market();
  const stock = market.getStock('005930');
  for (const [below, at, above] of [[1999,2000,2005], [4995,5000,5010], [19990,20000,20050],
    [49950,50000,50100], [199900,200000,200500], [499500,500000,501000]]) {
    stock.price = at;
    Object.assign(stock, priceLimits(at));
    for (const side of ['buy', 'sell']) {
      market.makeBook(stock, side);
      assert.deepEqual([stock.bids[0][0], stock.asks[0][0]], side === 'buy' ? [below, at] : [at, above]);
      for (const [rows, direction] of [[stock.asks, 1], [stock.bids, -1]]) {
        for (const [i, [price]] of rows.entries()) {
          assert.ok(validPrice(price));
          if (i) assert.equal(price, adjacentPrice(rows[i-1][0], direction));
        }
      }
    }
  }
  assert.deepEqual(priceLimits(199900), {lowerLimit:140000, upperLimit:259500});
  for (const side of ['buy', 'sell']) {
    const m = new Market();
    m.holdings.set(stock.code, {code:stock.code, quantity:3, average:194700});
    const order = {code:stock.code, type:'limit', side, quantity:1};
    for (const price of [200000,200500]) {
      assert.equal(m.placeOrder({...order, price, requestId:'valid-price-'+price}).limit,price);
    }
    assert.throws(() => m.placeOrder({...order,price:200100,requestId:'invalid-price'}), /500원 단위/);
  }
});

test('KPI10 uses all ten aligned minutes and derives every higher interval from them', async () => {
  const market = new Market();
  assert.equal(referenceCap,2154794661977560);
  market.getStock('005930').price = 194800;
  market.updateIndex();
  assert.equal(market.index().value.toFixed(2), '1000.27');
  const closing = market.index().value;
  market.rollDay(market.day + 86400000);
  assert.equal(market.index().previousClose, closing);
  assert.equal(market.index().changeRate, 0);

  const minutes = await referenceBars(INDEX_CODE,'1m');
  const stocks = await Promise.all(STOCKS.map(s => referenceBars(s.code,'1m')));
  for (const [i, bar] of minutes.entries()) {
    assert.equal(bar[6], stocks.reduce((sum, rows) => sum + rows[i][6], 0));
    for (let field = 1; field <= 4; field++) {
      const cap = stocks.reduce((sum, rows, j) => sum + rows[i][field] * STOCKS[j].shares, 0);
      assert.ok(Math.abs(bar[field] - 1000 * (cap / referenceCap)) < 1e-10);
    }
  }
  assert.deepEqual(minutes.at(-1), [cutoff,1000,1000,1000,1000,Date.parse('2026-11-18'),22154]);
  for (const [period, size] of Object.entries(PERIODS)) {
    if (size === 1) continue;
    let i = 0;
    for (const [start, o, h, l, c, , v] of await referenceBars(INDEX_CODE,period)) {
      const first = i;
      while (i < minutes.length && minutes[i][0] < start + size * 60000) i++;
      const rows = minutes.slice(first,i);
      assert.equal(start, Math.floor(rows[0][0] / (size*60000)) * size*60000);
      assert.deepEqual([o,h,l,c,v], [rows[0][1],Math.max(...rows.map(b=>b[2])),
        Math.min(...rows.map(b=>b[3])),rows.at(-1)[4],rows.reduce((sum,b)=>sum+b[6],0)]);
    }
    assert.equal(i, minutes.length);
  }
});

test('migration preserves the original files and copies only a compatible account with its receipts', async () => {
  for (const excluded of ['none','holding','order','archive']) {
    const root = await tempData('transition-'+excluded);
    const old = new Market();
    const placed = old.placeOrder({code:'005930',type:'market',side:'buy',quantity:2,requestId:'legacy-filled'});
    old.placeOrder({code:'005930',type:'limit',side:'buy',price:old.getStock('005930').lowerLimit,
      quantity:1,requestId:'legacy-resting'});
    const state = old.checkpoint('closed');
    state.prices['402340'] = 709000;
    const removed = '402340';
    if (excluded === 'holding') state.account.holdings[0].code = removed;
    if (excluded === 'order') state.account.orders[0].code = removed;
    const archived = {...placed, code:excluded === 'archive' ? removed : placed.code, requestId:'legacy-archive'};
    const archive = new OrderArchive(root, operation => operation());
    await archive.save(archived.requestId,{order:archived});
    const receiptBytes = await readFile(archive.file(archived.requestId),'utf8');
    const file = path.join(root,'market-state.json');
    const bytes = JSON.stringify(state);
    await writeFile(file,bytes);
    const options = {port:18479, dataDir:root, interval:60000};
    let server = await launch(options);
    try {
      const current = await get(server);
      assert.equal(current.stocks.length,10);
      assert.equal(current.account.cash, excluded === 'none' ? state.account.cash : INITIAL_CASH);
      assert.equal(current.orders.length, excluded === 'none' ? 2 : 0);
      const response = await fetch(server.url+'/api/orders/requests/legacy-archive');
      assert.equal(response.status, excluded === 'none' ? 200 : 404);
      if (excluded === 'none') {
        assert.deepEqual(await response.json(), archived);
        assert.deepEqual(current.orders.toReversed(), state.account.orders);
      }
      assert.equal((await fetch(server.url+'/api/candles?symbol=KPI100')).status,400);
      assert.equal((await post(server,'/api/orders',{code:'KPI10',type:'market',side:'buy',quantity:1,requestId:'index-is-not-stock'})).status,400);
      await post(server,'/api/cash',{direction:'deposit',amount:123,revision:0,requestId:'after-migration'});
      await stop(server);
      server = await launch(options);
      assert.equal((await get(server)).account.cash, current.account.cash+123);
      assert.equal(await readFile(file,'utf8'), bytes);
      assert.equal(await readFile(archive.file(archived.requestId),'utf8'), receiptBytes);
    } finally { await stop(server); }
  }
});
