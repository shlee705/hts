import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { get, launch, stop, tempData } from './helpers.mjs';
import { INDEX_CODE } from '../candles.mjs';

const periods = ['1m', '3m', '5m', '30m', '1h'];
const codes = ['005930', INDEX_CODE];

async function streamedCandles(server) {
  const controller = new AbortController();
  try {
    const response = await fetch(server.url + '/api/events?symbol=005930', {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(6000)]),
    });
    assert.equal(response.status, 200);
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    const candles = {};
    while (!candles['005930'] || !candles[INDEX_CODE]) {
      const { value, done } = await reader.read();
      assert.ok(!done, 'expected live candles');
      buffer += value;
      const frames = buffer.split('\n\n');
      buffer = frames.pop();
      for (const frame of frames) {
        if (frame.startsWith('event: tick\ndata: ')) candles[INDEX_CODE] = JSON.parse(frame.slice(frame.indexOf('data: ') + 6)).indexCandles;
        if (frame.startsWith('event: detail\ndata: ')) candles['005930'] = JSON.parse(frame.slice(frame.indexOf('data: ') + 6)).candles;
      }
    }
    return candles;
  } finally { controller.abort(); }
}

test('stock and index keep continuous intraday candles on clean and crash restarts inside the same minute', { timeout: 20000 }, async t => {
  const dataDir = await tempData('session-boundary');
  const clock = path.join(dataDir, 'clock.mjs');
  // Only the forked test server and its worker see this clock. All three sessions
  // fit in the same clock minute regardless of when the test suite runs.
  await writeFile(clock, 'const start = Number(process.env.HTS_TEST_EPOCH); Date.now = () => start + Math.floor(performance.now());');
  const minute = Date.parse('2026-11-18T15:31:00+09:00');
  const open = seconds => launch({
    port: 18466, dataDir, interval: 120,
    env: { NODE_OPTIONS: '--import=' + pathToFileURL(clock).href, HTS_TEST_EPOCH: String(minute + seconds * 1000) },
  });
  let server = await open(5);
  t.after(() => stop(server));
  const first = await streamedCandles(server);
  await stop(server);
  const saved = JSON.parse(await readFile(path.join(dataDir, 'candles.json'), 'utf8'));
  const savedBooks = { '005930': saved.books['005930'], [INDEX_CODE]: saved.index.book };
  const sessionIds = [first['005930']['1m'][5]];
  assert.ok(Number.isSafeInteger(sessionIds[0]));

  for (const seconds of [20, 40]) {
    server = await open(seconds);
    const stream = await streamedCandles(server);
    const id = stream['005930']['1m'][5];
    assert.equal(id, sessionIds[0]);

    for (const code of codes) {
      for (const period of periods) {
        const { bars: allBars } = await get(server, '/api/candles?symbol=' + code + '&period=' + period);
        const bars=allBars.filter(b=>b[5]>=minute);
        assert.deepEqual(bars.map(bar => bar[5]), sessionIds, code + '/' + period);
        const old=savedBooks[code][period][0];
        assert.equal(bars[0][1],old[1]);
        assert.ok(bars[0][2]>=old[2] && bars[0][3]<=old[3] && bars[0][6]>old[6]);
        assert.ok(bars.every((bar, i) => !i || bar[0] > bars[i - 1][0]));
        assert.equal(stream[code][period][5], id);
        assert.equal(stream[code][period][0], bars.at(-1)[0]);
      }
      assert.equal((await get(server, '/api/candles?symbol=' + code + '&period=1d')).bars.length, 14);
    }
    if (seconds === 20) {
      const exit = once(server.child, 'exit');
      server.child.kill('SIGKILL');
      await exit;
    }
  }
});
