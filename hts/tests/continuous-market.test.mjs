import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {Market} from '../market.mjs';
import {tradingDay, MINUTE} from '../calendar.mjs';
import {daily, referenceBars} from '../reference-history.mjs';
import {STOCKS, MARKET_DATA, INDEX_CODE} from '../public/market-data.mjs';
import {roundTick, tickSize} from '../public/tick-size.mjs';
import {PERIODS} from '../candles.mjs';
import {get, launch, stop, tempData} from './helpers.mjs';

test('the frozen 14-calendar-day reference contains ten daily closes for all constituents and the index',async()=>{
  assert.equal(STOCKS.length,10);
  assert.deepEqual(Object.keys(daily).sort(),[...STOCKS.map(s=>s.code),INDEX_CODE].sort());
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
      for(const code of ['005930',INDEX_CODE]){
        const bars=(await get(server,'/api/candles?symbol='+code+'&period=1m')).bars.filter(b=>b[0]>start);
        assert.equal(bars.length,5);
        assert.ok(bars.every((b,j)=>b[0]===start+(j+1)*MINUTE && b[6]>0));
        if(code!==INDEX_CODE)for(const bar of bars){
          for(const price of bar.slice(1,5))assert.equal(price%tickSize(price),0);
        }
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
  for(const {code} of STOCKS){
    const bars=await referenceBars(code,'1m');
    const original=await sessionBars(code,'1m');
    const raw=JSON.parse(gunzipSync(await readFile(new URL('../reference/minutes/'+code+'.json.gz',import.meta.url))));
    const observed=new Map(raw.map(row=>[row[0],row]));
    let j=0;
    for(let i=0;i<bars.length;i++){
      const b=bars[i],prev=bars[i-1];
      if(prev) assert.equal(b[0],prev[0]+MINUTE);
      // A provider print at 15:30 merges into the 15:29 candle.
      const close=tradingDay(b[0])+390*MINUTE;
      const mergedClosingPrint=b[0]===close-MINUTE && observed.has(close);
      const observation=b[0]<close && observed.get(b[0]);
      if(observation && !mergedClosingPrint){
        assert.deepEqual(b.slice(1,5),observation.slice(1,5));
      }else if(!observation && !mergedClosingPrint){
        for(const price of b.slice(1,5))assert.equal(price%tickSize(price),0,`${code} at ${b[0]}: ${price}`);
      }
      if(original[j]?.[0]===b[0]){
        if(i && original[j-1][0]<prev[0])assert.equal(prev[4],roundTick(b[1]));
        assert.deepEqual(b,original[j++]);
      } else {
        assert.equal(b[1],roundTick(prev[4]));
        assert.ok(b[3]>0 && b[3]<=Math.min(b[1],b[4]) && b[2]>=Math.max(b[1],b[4]));
        assert.ok(Number.isSafeInteger(b[6]) && b[6]>0);
      }
    }
    assert.equal(j,original.length);
    assert.equal(bars.at(-1)[4],daily[code].at(-1)[4]);
  }
});

test('all six reference index periods derive from the ten constituent minute bars',async()=>{
  const series=await Promise.all(STOCKS.map(stock=>referenceBars(stock.code,'1m')));
  const index=await referenceBars(INDEX_CODE,'1m');
  const referenceCap=STOCKS.reduce((sum,s)=>sum+s.close*s.shares,0);
  assert.ok(series.every(rows=>rows.length===index.length));
  for(let i=0; i<index.length; i++){
    const basket=series.map(rows=>rows[i]);
    assert.ok(basket.every(bar=>bar[0]===index[i][0]));
    for(const field of [1,2,3,4]){
      const cap=basket.reduce((sum,bar,j)=>sum+bar[field]*STOCKS[j].shares,0);
      assert.ok(Math.abs(index[i][field]-MARKET_DATA.indexClose*cap/referenceCap)<1e-9);
    }
    assert.equal(index[i][6],basket.reduce((sum,bar)=>sum+bar[6],0));
  }
  assert.equal(index.at(-1)[4],1000);
  for(const [period,minutes] of Object.entries(PERIODS)){
    if(period==='1m')continue;
    const bars=await referenceBars(INDEX_CODE,period);
    const span=minutes*MINUTE;
    let i=0;
    for(const [start,open,high,low,close,,volume] of bars){
      const first=i;
      assert.equal(start,Math.floor(index[i][0]/span)*span);
      while(i<index.length && index[i][0]<start+span)i++;
      const group=index.slice(first,i);
      assert.equal(open,group[0][1]);
      assert.equal(high,Math.max(...group.map(b=>b[2])));
      assert.equal(low,Math.min(...group.map(b=>b[3])));
      assert.equal(close,group.at(-1)[4]);
      assert.equal(volume,group.reduce((sum,b)=>sum+b[6],0));
    }
    assert.equal(i,index.length);
  }
});
