import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CandleHistory, INDEX_CODE, PERIODS } from '../candles.mjs';
import { STOCKS } from '../public/market-data.mjs';
import { get, launch, stop, tempData } from './helpers.mjs';

const periods = Object.keys(PERIODS);

test('migrates v1 stock and index candles across recorded opens and retains earlier snapshot-only history', async () => {
  const dir = await tempData('legacy-sessions'), base = Date.parse('2026-11-18T10:00:00+09:00');
  const rows = [
    ['tick', -7200000, 80], // Snapshot-only candle predating the oldest journal
    ['tick', 1000, 99],     // A rotated initial session, with an incomplete logged range
    ['tick', 2000, 100], ['open', 30000], ['tick', 31000, 114],
    ['tick', 62000, 115], ['recover-open', 65000], ['tick', 66000, 105],
    ['open', 70000], ['recover-open', 72000], ['tick', 73000, 109],
  ].map(([event, offset, price]) => ({event, time:base+offset, ...(price ? {prices:{'005930':price}, index:{value:price+0.25}} : {})}));
  const legacy = new CandleHistory();
  for (const r of rows.filter(r=>r.event === 'tick')) legacy.record(r.time,[{code:'005930',price:r.prices['005930']}],r.index.value);
  const checkpoint = {version:1,through:legacy.through,books:Object.fromEntries(legacy.books),
    index:{book:legacy.indexBook,through:legacy.indexThrough}};
  await writeFile(path.join(dir,'candles.json'),JSON.stringify(checkpoint));
  const lines = part => part.map(r=>JSON.stringify(r)).join('\n')+'\n';
  await writeFile(path.join(dir,'ticks.1.jsonl'),lines(rows.slice(2,7)));
  await writeFile(path.join(dir,'ticks.jsonl'),lines(rows.slice(7)));
  const h = new CandleHistory();
  await h.restore(dir,legacy.through);
  for (const [code, extra] of [['005930',0],[INDEX_CODE,0.25]]) {
    const candles = h.series(code,'1m').bars;
    assert.deepEqual(candles[0], [base-7200000,80+extra,80+extra,80+extra,80+extra]);
    assert.deepEqual(candles[1], [base,99+extra,114+extra,99+extra,114+extra]);
    assert.deepEqual(candles.slice(2).map(b=>[b[0]-base,b[4],b[5]-base]),[
      [60000,115+extra,30000],[65000,105+extra,65000],[72000,109+extra,72000],
    ]);
    assert.deepEqual(h.series(code,'1d').bars,legacy.series(code,'1d').bars);
  }
  await h.save(dir,f=>f());
  assert.equal(JSON.parse(await readFile(path.join(dir,'candles.json'),'utf8')).version,2);
  // After the former open rows rotate away, each new-format tick can still
  // identify its session while recovering from the last candle snapshot.
  await writeFile(path.join(dir,'ticks.1.jsonl'),'');
  await writeFile(path.join(dir,'ticks.jsonl'),lines([{event:'tick', time:base+74000, sessionStart:base+72000,
    prices:{'005930':120}, index:{value:120.25}}]));
  const recovered = new CandleHistory();
  await recovered.restore(dir,base+74000);
  assert.deepEqual(recovered.latest('005930')['1m'], [base+72000,109,120,109,120,base+72000]);
  assert.deepEqual(recovered.latest(INDEX_CODE)['1m'], [base+72000,109.25,120.25,109.25,120.25,base+72000]);
  assert.deepEqual(recovered.latest('005930')['1h'], [base,99,120,99,120]);
  assert.deepEqual(recovered.latest(INDEX_CODE)['1h'], [base,99.25,120.25,99.25,120.25]);
});

test('old stock-only snapshot backfills fractional index OHLC across KST days from committed ticks', async () => {
  const dir = await tempData('legacy-index');
  const midnight = Date.parse('2026-11-18T09:00:00+09:00');
  const stock = new CandleHistory();
  stock.record(midnight, [{code:'005930', price:11000}]);
  const books = Object.fromEntries(stock.books);
  await writeFile(path.join(dir,'candles.json'), JSON.stringify({version:1, through:midnight, books}));
  const prices = Object.fromEntries(STOCKS.map(s => [s.code, s.close]));
  const ticks = [
    {event:'tick', time:midnight-1, prices},
    {event:'tick', time:midnight, prices, index:{value:1000.1134}},
    {event:'order', time:midnight+1, prices, index:{value:9999}},
    {event:'tick', time:midnight+2, prices, index:{value:999.3312}},
    {event:'tick', time:midnight+3, prices, index:{value:1000.9821}},
    {event:'tick', time:midnight+4, prices, index:{value:1000.7055}},
    {event:'tick', time:midnight+5, prices, index:{value:2345}},
  ];
  await writeFile(path.join(dir,'ticks.1.jsonl'), ticks.slice(0,2).map(x=>JSON.stringify(x)).join('\n')+'\n');
  await writeFile(path.join(dir,'ticks.jsonl'), ticks.slice(2).map(x=>JSON.stringify(x)).join('\n')+'\n');
  const migrated = new CandleHistory();
  await migrated.restore(dir,midnight+4);
  for (const period of periods) {
    const {bars,through} = migrated.series(INDEX_CODE,period);
    assert.equal(through,midnight+4);
    assert.equal(bars.length,2);
    assert.deepEqual(bars[0].slice(1),[1000,1000,1000,1000]);
    assert.deepEqual(bars[1],[midnight,1000.1134,1000.9821,999.3312,1000.7055]);
  }
  assert.equal(migrated.series('005930','1m').bars[0][1],11000);
  await migrated.save(dir, f=>f());
  // The snapshot must carry exact intrabar highs and lows even after journal rotation.
  await writeFile(path.join(dir,'ticks.jsonl'),'');
  await writeFile(path.join(dir,'ticks.1.jsonl'),'');
  const restarted = new CandleHistory();
  await restarted.restore(dir,midnight+10000);
  assert.deepEqual(restarted.indexBook,migrated.indexBook);
  assert.equal(restarted.indexThrough,midnight+4);
});

async function nextTick(url) {
  const controller = new AbortController();
  const timeout = setTimeout(()=>controller.abort(),5000);
  try {
    const response = await fetch(url+'/api/events',{signal:controller.signal});
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let frames = '';
    while (true) {
      const {value,done} = await reader.read();
      if (done) throw Error('시세 스트림 종료');
      frames += decoder.decode(value,{stream:true});
      let end;
      while ((end=frames.indexOf('\n\n')) >= 0) {
        const frame = frames.slice(0,end);
        frames = frames.slice(end+2);
        if (frame.startsWith('event: tick\ndata: ')) return JSON.parse(frame.slice(frame.indexOf('data: ')+6));
      }
    }
  } finally { clearTimeout(timeout); controller.abort(); }
}

test('live index bars match the streamed index and all six periods survive server restart', async t => {
  const dir = await tempData('index-chart');
  let server = await launch({port:18462,dataDir:dir,interval:50});
  t.after(()=> stop(server));
  const tick = await nextTick(server.url);
  for (const period of periods) assert.equal(tick.indexCandles[period][4],tick.index.value);
  assert.equal((await fetch(server.url+'/api/state?symbol='+INDEX_CODE)).status,400);
  await stop(server);
  const saved = JSON.parse(await readFile(path.join(dir,'kospi10','candles.json'),'utf8'));
  server = await launch({port:18462,dataDir:dir,interval:60000});
  for (const period of periods) {
    const result = await get(server,'/api/candles?symbol='+INDEX_CODE+'&period='+period);
    assert.deepEqual(result.bars.slice(-saved.index.book[period].length),saved.index.book[period]);
    assert.equal(result.through,saved.index.through);
    assert.ok(result.bars.length);
  }
});
