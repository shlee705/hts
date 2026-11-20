import {gunzipSync} from 'node:zlib';
import {validPrice} from '../public/price-grid.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {Market} from '../market.mjs';
import {tradingDay, MINUTE} from '../calendar.mjs';
import {daily, referenceBars} from '../reference-history.mjs';
import {get, launch, stop, tempData} from './helpers.mjs';

test('the frozen 14-calendar-day reference contains ten daily closes for all constituents',async()=>{
  assert.equal(Object.keys(daily).length,10);
  for(const [code,rows] of Object.entries(daily)){
    assert.equal(rows.length,10);
    assert.equal(rows[0][0],'2026-11-05');
    assert.equal(rows.at(-1)[0],'2026-11-18');
    const bars=await referenceBars(code,'1d');
    assert.equal(bars.length,14);
    const byDate=new Map(bars.map(bar=>[new Date(bar[0]).toISOString().slice(0,10),bar]));
    for(const [date,o,h,l,c] of rows)assert.deepEqual(byDate.get(date).slice(1,5),[o,h,l,c]);
  }
});

test('offline replay on Saturday crosses 09:00 KST and reproduces stock and index OHLCV',async()=>{
  const start=Date.parse('2026-11-21T08:57:00+09:00');
  const end=start+6*MINUTE;
  const expected=[];
  for(let i=0;i<2;i++){
    const dataDir=await tempData('weekend-seed');
    await mkdir(path.join(dataDir, 'kospi10'));
    const market=new Market({now:start});
    await writeFile(path.join(dataDir, 'kospi10', 'market-state.json'),JSON.stringify(market.checkpoint('closed')));
    const clock=path.join(dataDir,'clock.mjs');
    await writeFile(clock,'Date.now=()=>'+end);
    const server=await launch({dataDir,port:18477,interval:60000,env:{NODE_OPTIONS:'--import='+pathToFileURL(clock).href}});
    try{
      const result=[];
      for(const code of ['005930','KPI10']){
        const bars=(await get(server,'/api/candles?symbol='+code+'&period=1m')).bars.filter(b=>b[0]>start);
        assert.equal(bars.length,5);
        assert.ok(bars.every((b,j)=>b[0]===start+(j+1)*MINUTE && b[6]>0));
        const days=(await get(server,'/api/candles?symbol='+code+'&period=1d')).bars.slice(-2);
        assert.deepEqual(days.map(b=>b[0]),[tradingDay(start),tradingDay(end)]);
        assert.equal(days[1][6],bars.slice(2).reduce((n,b)=>n+b[6],0));
        result.push(bars,days);
      }
      if(i)assert.deepEqual(result,expected);else expected.push(...result);
    }finally{await stop(server);}
  }
});
test('stored history preserves session minutes and bridges every overnight and weekend gap',async()=>{
  for(const code of Object.keys(daily)){
    const bars=await referenceBars(code,'1m');
    const raw=JSON.parse(gunzipSync(await readFile(new URL('../reference/minutes/'+code+'.json.gz',import.meta.url))));
    const observed=new Map(raw.map(row=>[row[0],row]));
    assert.equal(bars.length,19111);
    for(const [i,bar] of bars.entries()){
      if(i) assert.equal(bar[0],bars[i-1][0]+MINUTE);
      const minute=observed.get(bar[0]);
      if(minute) assert.deepEqual([...bar.slice(0,5),bar[6]],minute);
      else assert.ok(bar.slice(1,5).every(validPrice));
    }
    assert.equal(bars.at(-1)[4],daily[code].at(-1)[4]);
  }
});
