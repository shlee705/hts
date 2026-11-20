import {mkdir, writeFile, rename} from 'node:fs/promises';
import {gzipSync} from 'node:zlib';
import {daily, referenceBars, cutoff} from './session-history.mjs';
import {MINUTE, tradingDay} from '../calendar.mjs';
import {seededRandom, tickSize} from '../market.mjs';
import {PERIODS} from '../candles.mjs';
import {STOCKS, INDEX_CODE, constituentIndex} from '../public/market-data.mjs';

const root = new URL('./continuous/', import.meta.url);
await mkdir(root, {recursive:true});

async function stockMinutes(code) {
  const source = await referenceBars(code,'1m');
  const minutes = [];
  function fill(left, end, target, nextVolume) {
    const count = (end - left[0]) / MINUTE - 1;
    const random = seededRandom(Math.floor(left[0]/MINUTE) ^ parseInt(code,36));
    let open = left[4], latent = open;
    const volume = Math.max(1,(left[6]+nextVolume)/20);
    const round = price => {
      const unit = tickSize(price);
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
  }
  for (const bar of source) {
    const last = minutes.at(-1);
    if (last && bar[0]>last[0]+MINUTE) fill(last,bar[0],bar[1],bar[6]);
    minutes.push(bar);
  }
  const last=minutes.at(-1);
  if(last[0]<cutoff) fill(last,cutoff+MINUTE,daily[code].at(-1)[4],last[6]);
  return minutes;
}

function aggregate(minutes, size) {
  if (size === 1) return minutes;
  const rows = [];
  for (const [time,open,high,low,close,,volume] of minutes) {
    const start = Math.floor(time/(size*MINUTE))*size*MINUTE;
    const previous = rows.at(-1);
    if (previous?.[0] === start) {
      previous[2] = Math.max(previous[2],high);
      previous[3] = Math.min(previous[3],low);
      previous[4] = close;
      previous[6] += volume;
    } else {
      rows.push([start,open,high,low,close,size===1440?null:tradingDay(start),volume]);
    }
  }
  return rows;
}

async function storeSeries(code,minutes,officialDays) {
  const dir = new URL(code+'/',root);
  await mkdir(dir,{recursive:true});
  let days;
  for (const [period,size] of Object.entries(PERIODS)) {
    let rows = aggregate(minutes,size);
    if (period === '1d') {
      if (officialDays) rows = rows.map(bar => officialDays.get(bar[0]) ?? bar);
      days = rows;
    }
    const dest = new URL(period+'.json.gz',dir), tmp = new URL(period+'.tmp',dir);
    await writeFile(tmp,gzipSync(JSON.stringify(rows),{level:3}));
    await rename(tmp,dest);
  }
  return days;
}

const series = [];
for (const {code} of STOCKS) {
  const minutes = await stockMinutes(code);
  const exchangeDays = new Map((await referenceBars(code,'1d')).map(bar => [bar[0],bar]));
  await storeSeries(code,minutes,exchangeDays);
  series.push(minutes);
}

// Historical trade ordering inside a minute is unavailable. The weighted member
// highs/lows bound that minute's index; longer periods use the minute extrema.
if (series.some(minutes => minutes.length !== series[0].length))
  throw Error('Constituent minute coverage differs.');
const indexMinutes = series[0].map(([time], row) => {
  const members = series.map(minutes => minutes[row]);
  if (members.some(bar => bar[0] !== time)) throw Error('Constituent timestamps differ at '+time);
  const ohlc = [1,2,3,4].map(field => constituentIndex((stock,i) => members[i][field]));
  const volume = members.reduce((sum,bar) => sum + bar[6], 0);
  return [time,...ohlc,tradingDay(time),volume];
});
const indexDays = await storeSeries(INDEX_CODE,indexMinutes);
const sessionDates = new Set(daily[STOCKS[0].code].map(row => row[0]));
const indexDaily = indexDays.map(([time,o,h,l,c,,v]) => [new Date(time).toISOString().slice(0,10),o,h,l,c,v]);
const source = Object.fromEntries(STOCKS.map(({code}) => [code,daily[code]]));
source[INDEX_CODE] = indexDaily.filter(([date]) => sessionDates.has(date));
const dailyFile = new URL('./daily.json',import.meta.url), dailyTemp = new URL('./daily.tmp',import.meta.url);
await writeFile(dailyTemp,JSON.stringify(source));
await rename(dailyTemp,dailyFile);
console.log('Built '+STOCKS.length+' constituent series and '+indexMinutes.length+' index minute bars.');
