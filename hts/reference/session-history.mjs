import {readFile} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {MINUTE} from '../calendar.mjs';
import {seededRandom, tickSize} from '../market.mjs';
import {PERIODS} from '../candles.mjs';
import {MARKET_DATA} from '../public/market-data.mjs';
const root = new URL('./', import.meta.url);
export const daily = JSON.parse(await readFile(new URL('daily.json', root)));
export const cutoff = Date.parse(MARKET_DATA.asOf+'T15:30:00+09:00');
const cache = new Map();
const intradayPeriods = Object.entries(PERIODS).filter(([period])=>period!=='1d');
function merge(rows, incoming) {
  const last=rows.at(-1);
  if(last?.[0]!==incoming[0]) {rows.push(incoming);return;}
  last[2]=Math.max(last[2],incoming[2]);last[3]=Math.min(last[3],incoming[3]);last[4]=incoming[4];last[6]+=incoming[6];
}
async function prepare(symbol) {
  const raw=JSON.parse(gunzipSync(await readFile(new URL('minutes/'+symbol+'.json.gz',root))));
  const known=new Map(raw.map(r=>[r[0],r]));
  const books=Object.fromEntries(Object.keys(PERIODS).map(p=>[p,[]]));
  for (const [date,o,h,l,c,v] of daily[symbol]) {
    const day=Date.parse(date+'T00:00:00+09:00'), start=day+540*MINUTE, close=start+390*MINUTE;
    books['1d'].push([start,o,h,l,c,null,v]);
    const rand=seededRandom((day/1000)^parseInt(symbol,36));
    const realVolume=raw.reduce((sum,r)=>sum+(r[0]>=start&&r[0]<=close?r[5]:0),0);
    let missing=0, remaining=Math.max(0,v-realVolume), price=o, nextKnown=start;
    for(let t=start;t<close;t+=MINUTE) if(!known.has(t))missing++;
    for(let t=start;t<=close;t+=MINUTE) {
      let row=known.get(t);
      if(!row){
        if(t===close)break;
        if(nextKnown<=t){nextKnown=t+MINUTE;while(nextKnown<close&&!known.has(nextKnown))nextKnown+=MINUTE;}
        const target=known.get(nextKnown)?.[1]??c;
        const unit=tickSize(price);
        const round=p=>Math.min(h,Math.max(l,Math.round(p/unit)*unit));
        const steps=(nextKnown-t)/MINUTE;
        const finish=steps===1?target:round(price+(target-price)/steps+(rand()-.5)*price*.0009);
        const volume=missing===1?remaining:Math.min(remaining,Math.round(remaining/missing*(.5+rand())));
        row=[t,price,Math.max(price,finish),Math.min(price,finish),finish,volume]; remaining-=volume;missing--;
      }
      price=row[4];
      for(const [p,n] of intradayPeriods){
        const bucket=start+Math.floor((Math.min(t,close-MINUTE)-start)/(n*MINUTE))*n*MINUTE;
        merge(books[p],[bucket,...row.slice(1,5),start,row[5]]);
      }
    }
  }
  return books;
}
export async function referenceBars(code,period) {
  if (!cache.has(code)) {
    if(cache.size>=3)cache.delete(cache.keys().next().value);
    const pending=prepare(code);cache.set(code,pending);
    pending.catch(()=>{if(cache.get(code)===pending)cache.delete(code)});
  }
  return (await cache.get(code))[period];
}
