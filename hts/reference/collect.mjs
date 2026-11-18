import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {gzipSync} from 'node:zlib';
const root=new URL('./',import.meta.url);
const members=JSON.parse(await readFile(new URL('constituents.json',root)));
const get=async url=>{for(let n=0;;n++){try{const r=await fetch(url,{signal:AbortSignal.timeout(25000)});if(!r.ok)throw Error(r.status+' '+url);return await r.json()}catch(e){if(n===2)throw e}}};
const date=s=>Date.parse(s+'T00:00:00+09:00')/1000;
const per=86400;
const first=date('2026-11-05'),end=date('2026-11-19');
const dayKey=t=>new Date(t+32400000).toISOString().slice(0,10);
const daily={},list=[],failures=[];let cursor=0;
function valid(r){return r.every(Number.isFinite)&&r[3]>0&&r[2]>=Math.max(r[1],r[4])&&r[3]<=Math.min(r[1],r[4])&&r[5]>=0}
async function yahoo(code,a,b,interval){
 const u='https://query1.finance.yahoo.com/v8/finance/chart/'+code+'.KS?interval='+interval+'&period1='+a+'&period2='+b;
 const j=(await get(u)).chart.result?.[0];if(!j)throw Error(code+' empty result');const q=j.indicators.quote[0];
 return (j.timestamp||[]).map((t,i)=>[t*1000,q.open[i],q.high[i],q.low[i],q.close[i],q.volume[i]]).filter(valid);
}
async function naver(code,kind,tf){
const j=await get('https://api.stock.naver.com/chart/domestic/'+kind+'/'+code+'/'+tf+'?startDateTime=202611050900&endDateTime=202611181530');
return j.map(x=>{const d=x.localDateTime||x.localDate;const t=Date.parse(d.slice(0,4)+'-'+d.slice(4,6)+'-'+d.slice(6,8)+'T'+(d.slice(8,10)||'00')+':'+(d.slice(10,12)||'00')+':00+09:00');return [t,x.openPrice,x.highPrice,x.lowPrice,x.currentPrice??x.closePrice,x.accumulatedTradingVolume]}).filter(valid);
}
async function run(){
while(cursor<=members.data.length){const i=cursor++;const m=members.data[i];const code=m?.d[0]??'KPI100';
try{
let days,minutes=[];
if(m){days=await yahoo(code,first,end,'1d'); for(let a=first;a<end;a+=6*per){try{minutes.push(...await yahoo(code,a,Math.min(end,a+6*per),'1m'))}catch{}}
if(minutes.length===0)minutes=await naver(code,'item','minute');
const basic=await get('https://m.stock.naver.com/api/stock/'+code+'/basic');
list[i]={code,name:basic.stockName,shares:Math.round(m.d[2]),rank:i+1,close:days.at(-1)?.[4]};
}else{days=await naver(code,'index','day');minutes=await naver(code,'index','minute')}
if(days.length!==10)throw Error('daily count '+days.length);
daily[code]=days.map(([t,...v])=>[dayKey(t),...v]);
const within=minutes.filter(([t])=>{const k=(t+32400000)%86400000;return k>=32400000&&k<=55800000&&t>=first*1000&&t<end*1000});
await mkdir(new URL('minutes/',root),{recursive:true});await writeFile(new URL('minutes/'+code+'.json.gz',root),gzipSync(JSON.stringify(within)));
}catch(e){failures.push([code,e.message])}}
}
await Promise.all(Array.from({length:5},run));console.log('collected',Object.keys(daily).length,'failures',failures);
await writeFile(new URL('daily.json',root),JSON.stringify(daily));await writeFile(new URL('members.json',root),JSON.stringify(list));
