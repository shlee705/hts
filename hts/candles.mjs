import { open, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { STOCKS, MARKET_DATA, indexFromCap } from './public/market-data.mjs';

export const PERIODS = Object.freeze({ '1m': 1, '3m': 3, '5m': 5, '30m': 30, '1h': 60, '1d': 1440 });
export const BAR_LIMIT = 100;
export const INDEX_CODE = MARKET_DATA.indexCode;
const kstOffset = 9 * 60 * 60000;
const periods = Object.entries(PERIODS);
const emptyBook = () => Object.fromEntries(periods.map(([period]) => [period, []]));
const bucketStart = (time, minutes) => {
  const span = minutes * 60000;
  if(minutes===1440)return Math.floor(time/span)*span;
  return Math.floor((time + kstOffset) / span) * span - kstOffset;
};

function updateBook(book, starts, price, previousThrough, volume, cap) {
  for (const [period, start, session, bucket] of starts) {
    const bars = book[period];
    const bar = bars.at(-1);
    // A legacy aggregate with incomplete journal coverage can already include
    // the active session. Preserve it through the rest of that clock bucket.
    const continuingLegacy = session !== undefined && session <= previousThrough &&
      bar?.[5] === undefined && bar?.[0] === bucket && start === session;
    if (bar?.[0] === start || continuingLegacy) {
      bar[2] = Math.max(bar[2], price);
      bar[3] = Math.min(bar[3], price);
      bar[4] = price;
      if(volume!==undefined)bar[6]=(bar[6]??0)+volume;
    } else {
      if (bars.length >= cap) bars.shift();
      const next = [start, price, price, price, price];
      if (session !== undefined) next.push(session);
      if(volume!==undefined){next[5]=session??null;next[6]=volume;}
      bars.push(next);
    }
  }
}

function validBook(book, validPrice, cap) {
  return book && periods.every(([period]) => Array.isArray(book[period]) && book[period].length <= cap &&
    book[period].every(bar => Array.isArray(bar) &&
      (bar.length === 7 && Number.isSafeInteger(bar[6]) && bar[6]>=0 || bar.length === 5 || (period !== '1d' && bar.length === 6 && Number.isSafeInteger(bar[5]) && bar[5] <= bar[0])) &&
      Number.isSafeInteger(bar[0]) && bar.slice(1, 5).every(value => validPrice(value) && value > 0)));
}

function historicalIndex(row) {
  if (Number.isFinite(row.index?.value) && row.index.value > 0) return row.index.value;
  // Journals predating the index still include all constituent prices.
  let cap = 0;
  for (const stock of STOCKS) {
    const price = row.prices?.[stock.code];
    if (!Number.isSafeInteger(price) || price < 1) return undefined;
    cap += price * stock.shares;
  }
  return indexFromCap(cap);
}

// Tick rows include the session on new servers. For earlier journals the open
// event establishes it, including when the next tick is in another log file.
async function* committedTicks(dir, until) {
  let session, firstEvent;
  for (const name of ['ticks.3.jsonl', 'ticks.2.jsonl', 'ticks.1.jsonl', 'ticks.jsonl']) {
    let handle;
    try { handle = await open(path.join(dir, name), 'r'); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    try {
      for await (const line of handle.readLines()) {
        let row;
        try { row = JSON.parse(line); } catch { continue; } // An incomplete final journal row is possible.
        if (row.time > until) continue;
        firstEvent ??= row.event;
        if (row.event === 'open' || row.event === 'recover-open') session = row.time;
        if (row.event !== 'tick' && !(row.event === 'order' && row.prints?.length)) continue;
        const time = row.quoteTime ?? row.time;
        if (time <= until) yield { row, time, session: row.sessionStart ?? session,
          initialOpen: firstEvent === 'open' || firstEvent === 'recover-open' };
      }
    } finally { await handle.close(); }
  }
}

const historicalQuotes = row => Object.entries(row.prices).map(([code, price]) => ({ code, price }));

// A v1 snapshot may reach further back than the rotating journal. Split an old
// bucket using recorded ticks only if they cover its OHLC. A partially retained
// first bucket keeps its original aggregate instead of guessing its session.
function migrateBook(book, replayed, firstTick, initialOpen) {
  for (const [period, minutes] of periods) {
    if (period === '1d') continue;
    const groups = new Map();
    for (const bar of replayed[period]) {
      const key = bucketStart(bar[0], minutes);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(bar);
    }
    const initialBucket = bucketStart(firstTick, minutes);
    book[period] = book[period].flatMap(original => {
      const parts = groups.get(original[0]);
      if (!parts?.some(bar => bar[5] !== undefined)) return [original];
      if (original[0] === initialBucket && !initialOpen) return [original];
      // When the 100-bar replay buffer itself rolled over, its earliest
      // surviving fragments already define the beginning of retained history.
      const replay = replayed[period];
      const rolled = replay.length === BAR_LIMIT && parts[0] === replay[0] && original[0] > initialBucket;
      const covered = parts[0][1] === original[1] && parts.at(-1)[4] === original[4] &&
        Math.max(...parts.map(bar => bar[2])) === original[2] && Math.min(...parts.map(bar => bar[3])) === original[3];
      return covered || rolled ? parts : [original];
    }).slice(-BAR_LIMIT);
  }
}

// Tuple fields: start time, open, high, low, close, optional intraday session opening.
export class CandleHistory {
  constructor(cap=BAR_LIMIT) {
    this.cap=cap;
    this.through = 0;
    this.books = new Map(STOCKS.map(({ code }) => [code, emptyBook()]));
    this.indexBook = emptyBook();
    this.indexThrough = 0;
  }
  record(time, quotes, indexValue, sessionStart, indexVolume) {
    if (!Number.isSafeInteger(time)) return;
    const starts = periods.map(([period, minutes]) => {
      const start = bucketStart(time, minutes);
      if (period === '1d' || sessionStart === undefined) return [period, start];
      return [period, Math.max(start, sessionStart), sessionStart, start];
    });
    if (time > this.through) {
      for (const { code, price, quantity } of quotes) {
        const book = this.books.get(code);
        if (book && Number.isSafeInteger(price) && price > 0) updateBook(book, starts, price, this.through, quantity,this.cap);
      }
      this.through = time;
    }
    if (time > this.indexThrough && Number.isFinite(indexValue) && indexValue > 0) {
      updateBook(this.indexBook, starts, indexValue, this.indexThrough,indexVolume,this.cap);
      this.indexThrough = time;
    }
  }
  mergeRestartBars(sessionFor) {
    // These three legacy opens were recorded on 18 Nov 2026 after 20:00 KST.
    const obsolete = new Set([
      Date.parse('2026-11-18T20:34:58.441+09:00'),
      Date.parse('2026-11-18T20:38:29.445+09:00'),
      Date.parse('2026-11-18T20:47:51.713+09:00'),
    ]);
    let changed = false;
    for (const book of [...this.books.values(), this.indexBook]) {
      for (const [period, minutes] of periods) {
        if (period === '1d' || !book[period].some(bar => obsolete.has(bar[5]))) continue;
        const merged = [];
        for (const bar of book[period]) {
          if (obsolete.has(bar[5])) {
            bar[5] = sessionFor(bar[0]);
            bar[0] = Math.max(bucketStart(bar[0], minutes), bar[5]);
          }
          const last = merged.at(-1);
          if (last && last[0] === bar[0]) {
            last[2] = Math.max(last[2], bar[2]);
            last[3] = Math.min(last[3], bar[3]);
            last[4] = bar[4];
            last[6] = (last[6] ?? 0) + (bar[6] ?? 0);
          } else merged.push(bar);
        }
        book[period] = merged;
        changed = true;
      }
    }
    return changed;
  }
  latest(code) {
    const book = code === INDEX_CODE ? this.indexBook : this.books.get(code);
    return Object.fromEntries(Object.entries(book).map(([period, bars]) => [period, bars.at(-1)]));
  }
  series(code, period) {
    const isIndex = code === INDEX_CODE;
    return {code, period, bars: (isIndex ? this.indexBook : this.books.get(code))[period], through: isIndex ? this.indexThrough : this.through};
  }
  async restore(dir, until) {
    if (!until) return;
    let legacy = false;
    try {
      const saved = JSON.parse(await readFile(path.join(dir, 'candles.json'), 'utf8'));
      if (saved.through <= until && (saved.version === 1 || saved.version === 2)) {
        legacy = saved.version === 1;
        for (const code of this.books.keys()) {
          const book = saved.books[code];
          if (!validBook(book, Number.isSafeInteger,this.cap)) throw Error('봉차트 저장 형식이 올바르지 않습니다.');
          this.books.set(code, book);
        }
        this.through = saved.through;
        if (saved.index) {
          if (!validBook(saved.index.book, Number.isFinite,this.cap) || !Number.isSafeInteger(saved.index.through) ||
              saved.index.through < 0 || saved.index.through > saved.through) throw Error('지수 봉차트 저장 형식이 올바르지 않습니다.');
          this.indexBook = saved.index.book;
          this.indexThrough = saved.index.through;
        }
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (legacy) {
      const replay = new CandleHistory();
      let firstTick, initialOpen;
      for await (const tick of committedTicks(dir, until)) {
        if (tick.time > this.through) continue;
        firstTick ??= tick.time;
        initialOpen ??= tick.initialOpen;
        replay.record(tick.time, historicalQuotes(tick.row),
          tick.time <= this.indexThrough ? historicalIndex(tick.row) : undefined, tick.session);
      }
      if (firstTick !== undefined) {
        for (const [code, book] of this.books) migrateBook(book, replay.books.get(code), firstTick, initialOpen);
        migrateBook(this.indexBook, replay.indexBook, firstTick, initialOpen);
      }
    }
    for await (const {row, time, session} of committedTicks(dir, until)) {
      if (time <= this.through && time <= this.indexThrough) continue;
      const quotes = time > this.through ? (row.prints?.map(([code,price,quantity])=>({code,price,quantity})) ?? historicalQuotes(row)) : [];
      this.record(time, quotes, historicalIndex(row), session, row.prints?.reduce((n,p)=>n+p[2],0));
    }
  }
  async save(dir, retry) {
    const dest = path.join(dir, 'candles.json');
    const snapshot = { version: 2, through: this.through, books: Object.fromEntries(this.books), index: {book: this.indexBook, through: this.indexThrough} };
    await retry(() => writeFile(dest + '.tmp', JSON.stringify(snapshot)));
    await retry(() => rename(dest + '.tmp', dest));
  }
}
