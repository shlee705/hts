import {mkdir,readFile,readdir,rename,writeFile} from 'node:fs/promises';
import {gzipSync,gunzipSync} from 'node:zlib';
import path from 'node:path';
import {tradingDay} from './calendar.mjs';
import {INDEX_CODE} from './candles.mjs';
import {referenceBars,referenceJSON} from './reference-history.mjs';
export class DayArchive {
  constructor(dir){this.dir=path.join(dir,'chart-days');this.cache=new Map();this.days=[];}
  async open(){await mkdir(this.dir,{recursive:true});this.days=(await readdir(this.dir)).filter(n=>/^\d{13}\.gz$/.test(n)).sort();}
  async seal(day,history){
    const books=Object.fromEntries([...history.books,[INDEX_CODE,history.indexBook]].map(([code,book])=>[code,Object.fromEntries(Object.entries(book).map(([period,bars])=>[period,bars.filter(b=>tradingDay(b[0])===day)]))]));
    const name=day+'.gz', dest=path.join(this.dir,name);
    await writeFile(dest+'.tmp',gzipSync(JSON.stringify(books),{level:1}));await rename(dest+'.tmp',dest);
    if(!this.days.includes(name))this.days.push(name);this.cache.clear();
  }
  async serialize(history,code,period) {
    if (this.days.length) return JSON.stringify(await this.series(history,code,period));
    const {bars,through} = history.series(code,period);
    const frozen = await referenceJSON(code,period);
    // Reference files contain arrays of flat numeric tuples. Splice the live suffix
    // directly when only the final reference bucket can overlap the current session.
    const lastStart = frozen.lastIndexOf('[');
    const last = JSON.parse(frozen.slice(lastStart,-1));
    const firstLive = bars[0]?.[0] ?? Infinity;
    if (firstLive < last[0]) return JSON.stringify(await this.series(history,code,period));
    const end = firstLive === last[0] ? lastStart-1 : frozen.length-1;
    const prefix = frozen.slice(0,end);
    const joined = bars.length ? prefix + (end>1 ? ',' : '') + JSON.stringify(bars).slice(1) : frozen;
    return '{"code":'+JSON.stringify(code)+',"period":'+JSON.stringify(period)+',"through":'+through+',"bars":'+joined+'}';
  }
  async series(history,code,period){
    const key=code+'/'+period;
    let prefix=this.cache.get(key);
    if(!prefix){
      prefix=[...await referenceBars(code,period)];
      for(const name of this.days){
        const b=JSON.parse(gunzipSync(await readFile(path.join(this.dir,name))))[code]?.[period]??[];
        prefix=joinBars(prefix,b);
      }
      if(this.cache.size>=6)this.cache.delete(this.cache.keys().next().value);
      this.cache.set(key,prefix);
    }
    const live=history.series(code,period);
    return {...live,bars:joinBars(prefix,live.bars)};
  }
}
function joinBars(prefix,tail){
  if(!tail.length)return prefix;
  if(!prefix.length||prefix.at(-1)[0]<tail[0][0])return prefix.concat(tail);
  const joined=new Map(prefix.map(b=>[b[0],b]));
  for(const b of tail)joined.set(b[0],b);
  return [...joined.values()].sort((a,b)=>a[0]-b[0]);
}
