import {readFile} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {STOCKS} from './public/market-data.mjs';
const source = JSON.parse(await readFile(new URL('./reference/daily.json', import.meta.url)));
export const daily = Object.fromEntries(STOCKS.map(({code}) => [code, source[code]]));
export const cutoff = Date.parse('2026-11-18T15:30:00+09:00');

export async function referenceJSON(code,period) {
  const file = new URL('./reference/kospi10/'+code+'/'+period+'.json.gz',import.meta.url);
  return gunzipSync(await readFile(file)).toString();
}

export async function referenceBars(code,period) {
  return JSON.parse(await referenceJSON(code,period));
}
