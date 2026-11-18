import {mkdir, writeFile, rename} from 'node:fs/promises';
import {gzipSync} from 'node:zlib';
import {daily, referenceBars, cutoff} from './session-history.mjs';
import {MINUTE, tradingDay} from '../calendar.mjs';
import {seededRandom, tickSize} from '../market.mjs';
import {INDEX_CODE, PERIODS} from '../candles.mjs';

const root = new URL('./continuous/', import.meta.url);
await mkdir(root, {recursive:true});
let total = 0;
for (const code of Object.keys(daily)) {
  const source = await referenceBars(code,'1m');
  const minutes = [];
  const index = code === INDEX_CODE;
  function fill(left, end, target, nextVolume) {
    const count = (end - left[0]) / MINUTE - 1;
    const random = seededRandom(Math.floor(left[0]/MINUTE) ^ parseInt(code,36));
    let open = left[4], latent = open;
    const volume = Math.max(1,(left[6]+nextVolume)/20);
    const round = price => {
      const unit = index ? 0.01 : tickSize(price);
      return Number((Math.max(unit,Math.round(price/unit)*unit)).toFixed(2));
    };
    for (let i=1; i<=count; i++) {
      const remaining = count-i+1;
      const trend = left[4]+(target-left[4])*i/count;
      latent += (target-latent)/remaining + (trend-latent)*0.04 +
        (random()-.5)*open*.001*Math.sqrt((remaining-1)/remaining);
      const close = remaining===1 ? target : round(latent);
      const time = left[0]+i*MINUTE;
      minutes.push([time,open,Math.max(open,close,round(Math.max(open,close)*(1+random()*.0003))),
        Math.min(open,close,round(Math.min(open,close)*(1-random()*.0003))),close,
        tradingDay(time),Math.max(1,Math.round(volume*(0.3+random()*1.4)))]);
      open=close;
    }
    total+=count;
  }
  for (const bar of source) {
    const last = minutes.at(-1);
    if (last && bar[0]>last[0]+MINUTE) fill(last,bar[0],bar[1],bar[6]);
    minutes.push(bar);
  }
  const last=minutes.at(-1);
  if(last[0]<cutoff) fill(last,cutoff+MINUTE,daily[code].at(-1)[4],last[6]);
  const dir=new URL(code+'/',root);
  await mkdir(dir,{recursive:true});
  for(const [period,size] of Object.entries(PERIODS)){
    let rows=minutes;
    if(size!==1){
      rows=[];
      for(const [time,o,h,l,c,,v] of minutes){
        const start=Math.floor(time/(size*MINUTE))*size*MINUTE;
        const prev=rows.at(-1);
        if(prev?.[0]===start){
          prev[2]=Math.max(prev[2],h);prev[3]=Math.min(prev[3],l);prev[4]=c;prev[6]+=v;
        } else rows.push([start,o,h,l,c,size===1440?null:tradingDay(start),v]);
      }
      if(period==='1d'){
        // Preserve published exchange daily candles; add daily bars on missing dates.
        const official=new Map((await referenceBars(code,period)).map(b=>[b[0],b]));
        rows=rows.map(b=>official.get(b[0])??b);
      }
    }
    const dest=new URL(period+'.json.gz',dir),tmp=new URL(period+'.tmp',dir);
    await writeFile(tmp,gzipSync(JSON.stringify(rows),{level:3}));
    await rename(tmp,dest);
  }
}
console.log('Stored additional minutes:',total,'series:',Object.keys(daily).length);
