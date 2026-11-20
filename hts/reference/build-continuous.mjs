import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {gzipSync, gunzipSync} from 'node:zlib';
import {MINUTE, tradingDay} from '../calendar.mjs';
import {PERIODS, INDEX_CODE} from '../candles.mjs';
import {STOCKS, indexFromCap} from '../public/market-data.mjs';
import {roundPrice} from '../public/price-grid.mjs';

const source = new URL('./', import.meta.url);
const destination = new URL('kospi10/', source);
const start = Date.parse('2026-11-05T09:00:00+09:00');
const end = Date.parse('2026-11-18T15:30:00+09:00');
const index = [];
const daily = JSON.parse(await readFile(new URL('daily.json', source)));

async function unpack(file) {
  return JSON.parse(gunzipSync(await readFile(new URL(file, source))));
}

function aggregate(minutes, size) {
  if (size === 1) return minutes;
  const rows = [];
  for (const [time, open, high, low, close, , volume] of minutes) {
    const bucket = Math.floor(time / (size * MINUTE)) * size * MINUTE;
    const last = rows.at(-1);
    if (last?.[0] === bucket) {
      last[2] = Math.max(last[2], high);
      last[3] = Math.min(last[3], low);
      last[4] = close;
      last[6] += volume;
    } else rows.push([bucket, open, high, low, close, size === 1440 ? null : tradingDay(time), volume]);
  }
  return rows;
}

async function save(code, minutes) {
  const dir = new URL(code + '/', destination);
  await mkdir(dir, {recursive: true});
  for (const [period, size] of Object.entries(PERIODS)) {
    const rows = aggregate(minutes, size);
    if (period === '1d' && code !== INDEX_CODE) {
      const official = new Map(daily[code].map(([date, ...values]) => [Date.parse(date), values]));
      for (const row of rows) {
        const values = official.get(row[0]);
        if (values) row.splice(1, 6, ...values.slice(0, 4), null, values[4]);
      }
    }
    const temp = new URL(period + '.tmp', dir);
    await writeFile(temp, gzipSync(JSON.stringify(rows), {level: 3}));
    await rename(temp, new URL(period + '.json.gz', dir));
  }
}

for (const {code, shares} of STOCKS) {
  const actual = new Map((await unpack('minutes/' + code + '.json.gz')).map(row => [row[0], row]));
  const minutes = await unpack('continuous/' + code + '/1m.json.gz');
  if (minutes.length !== (end - start) / MINUTE + 1) throw Error('Incomplete history for ' + code);
  for (const [i, bar] of minutes.entries()) {
    const time = start + i * MINUTE;
    if (bar[0] !== time) throw Error('Misaligned minute for ' + code);
    const observed = actual.get(time);
    if (observed) bar.splice(1, 6, ...observed.slice(1, 5), tradingDay(time), observed[5]);
    else for (let field = 1; field <= 4; field++) bar[field] = roundPrice(bar[field]);
    const totals = index[i] ??= [time, 0, 0, 0, 0, tradingDay(time), 0];
    for (let field = 1; field <= 4; field++) totals[field] += bar[field] * shares;
    totals[6] += bar[6];
  }
  await save(code, minutes);
}
for (const bar of index) {
  for (let field = 1; field <= 4; field++) bar[field] = indexFromCap(bar[field]);
}
await save(INDEX_CODE, index);
console.log('Built %d minutes for %d stocks and %s.', index.length, STOCKS.length, INDEX_CODE);
