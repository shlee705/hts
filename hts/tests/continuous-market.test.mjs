import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {Market} from '../market.mjs';
import {tradingDay, MINUTE} from '../calendar.mjs';
import {daily, referenceBars} from '../reference-history.mjs';
import {get, launch, stop, tempData} from './helpers.mjs';

test('the frozen 14-calendar-day reference contains ten daily closes for all constituents and the index',async()=>{
  assert.equal(Object.keys(daily).length,101);
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
    const market=new Market({now:start});
    await writeFile(path.join(dataDir,'market-state.json'),JSON.stringify(market.checkpoint('closed')));
    const clock=path.join(dataDir,'clock.mjs');
    await writeFile(clock,'Date.now=()=>'+end);
    const server=await launch({dataDir,port:18477,interval:60000,env:{NODE_OPTIONS:'--import='+pathToFileURL(clock).href}});
    try{
      const result=[];
      for(const code of ['005930','KPI100']){
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
  const {referenceBars:sessionBars}=await import('../reference/session-history.mjs');
  for(const code of Object.keys(daily)){
    const bars=await referenceBars(code,'1m');
    const original=await sessionBars(code,'1m');
    let j=0;
    for(let i=0;i<bars.length;i++){
      const b=bars[i],prev=bars[i-1];
      if(prev) assert.equal(b[0],prev[0]+MINUTE);
      if(original[j]?.[0]===b[0]){
        if(i && original[j-1][0]<prev[0])assert.equal(prev[4],b[1]);
        assert.deepEqual(b,original[j++]);
      } else {
        assert.equal(b[1],prev[4]);
        assert.ok(b[3]>0 && b[3]<=Math.min(b[1],b[4]) && b[2]>=Math.max(b[1],b[4]));
        assert.ok(Number.isSafeInteger(b[6]) && b[6]>0);
      }
    }
    assert.equal(j,original.length);
    assert.equal(bars.at(-1)[4],daily[code].at(-1)[4]);
  }
});
