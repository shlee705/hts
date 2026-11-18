import {readFile} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
export {daily, cutoff} from './reference/session-history.mjs';

export async function referenceJSON(code,period) {
  const file = new URL('./reference/continuous/'+code+'/'+period+'.json.gz',import.meta.url);
  return gunzipSync(await readFile(file)).toString();
}

export async function referenceBars(code,period) {
  return JSON.parse(await referenceJSON(code,period));
}
