import { parentPort, workerData } from 'node:worker_threads';
import { writeFile, rename, open, stat } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Market, checkOrderTerms, orderError, validateOrderInput } from './market.mjs';
import { CandleHistory, INDEX_CODE } from './candles.mjs';
import { adjustCash, cashState } from './cash.mjs';
import { OrderArchive } from './order-archive.mjs';
import { openMarketStorage } from './market-storage.mjs';
import { dailyLimits } from './public/tick-size.mjs';

import {cutoff,daily} from './reference-history.mjs';
import {tradingDay,missingMinutes} from './calendar.mjs';
import {DayArchive} from './day-archive.mjs';
import {seededRandom} from './market.mjs';
const { seed, interval } = workerData;
const { dir: dataDir, previous, account: copiedAccount, migration, release: releaseWriter } = await openMarketStorage(workerData.dataDir);
const statePath = path.join(dataDir, 'market-state.json');
const recovered = Boolean(previous && previous.status !== 'closed');
const market = new Market({ seed, previous, tickMs: interval });
let candles = new CandleHistory(2000);
const archives=new DayArchive(dataDir);
await archives.open();
await candles.restore(dataDir, previous?.updatedAt);
// Preserve the transition from the historical exchange session to continuous trading.
function chartSession(time) {
  return Math.max(tradingDay(time), cutoff + 60000);
}
let fileRetries = 0;
if (candles.mergeRestartBars(chartSession)) await candles.save(dataDir, retryFile);
let lastChartSave = Date.now();
let symbols = new Set(['005930']), timer, stopping = false, queue = Promise.resolve();
let journal, journalSize = 0, workMs = 0, persistMs = 0, tickCount = 0;
let lastPublishedDay;
let orderVersions = new Map(market.orders.map(o => [o.id, `${o.status}|${o.remaining}|${o.average}`]));
const journalPath = path.join(dataDir, 'ticks.jsonl');

if (!previous) {
  market.day=tradingDay(cutoff);
  const seedDaily = (book,row) => book['1d'].push([market.day,...row.slice(1,5),null,row[5]]);
  const indexDays = daily[INDEX_CODE];
  seedDaily(candles.indexBook,indexDays.at(-1));
  for(const s of market.stocks){
    const rows=daily[s.code], [,open,high,low,,volume]=rows.at(-1);
    seedDaily(candles.books.get(s.code),rows.at(-1));
    Object.assign(s,{open,high,low,volume,prev:rows.at(-2)[4]});
    Object.assign(s, dailyLimits(s.prev));
    market.makeBook(s);
  }
  market.indexPrevious=indexDays.at(-2)[4];
  market.indexHigh=indexDays.at(-1)[2];market.indexLow=indexDays.at(-1)[3];market.updateIndex();
}
async function nextDay(time) {
  if(candles.through && tradingDay(time)>tradingDay(candles.through)){
    await archives.seal(tradingDay(candles.through),candles);
    candles=new CandleHistory(2000);
  }
  market.rollDay(time);
}
function recordPrints(time, session) {
  const quotes=market.prints.map(([code,price,quantity])=>({code,price,quantity}));
  if(quotes.length)candles.record(time,quotes,market.index().value,session,quotes.reduce((n,q)=>n+q.quantity,0));
}
// Windows indexers / OneDrive can briefly hold the destination during atomic replace.
// Keep the previous checkpoint intact and retry; never unlink the durable target.
async function retryFile(operation) {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 8) throw error;
      fileRetries++; await new Promise(resolve => setTimeout(resolve, Math.min(80, 5 * 2 ** attempt)));
    }
  }
}
try { journalSize = (await stat(journalPath)).size; } catch (e) { if (e.code !== 'ENOENT') throw e; }
journal = await open(journalPath, 'a');
async function rotate() {
  if (journalSize < 16 * 1024 * 1024) return;
  await journal.close();
  for (let i = 3; i >= 1; i--) {
    const from = i === 1 ? journalPath : path.join(dataDir, `ticks.${i - 1}.jsonl`);
    const to = path.join(dataDir, `ticks.${i}.jsonl`);
    try { await retryFile(() => rename(from, to)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  journal = await open(journalPath, 'a'); journalSize = 0;
}
async function persist(status = 'running', event = 'tick') {
  const start = performance.now();
  const checkpoint = market.checkpoint(status, Math.max(Date.now(),market.time));
  const sessionStart = chartSession(market.time);
  checkpoint.marketVersion=3;
  const prints=event==='tick'||event==='order'?market.prints:undefined;
  const line = JSON.stringify({ event, prints, time: checkpoint.updatedAt, quoteTime: market.time, sessionStart, tick: market.tick, prices: checkpoint.prices, index: checkpoint.index, ...(event === 'tick' && market.tickEvents.length ? { marketEvents: market.tickEvents } : {}) }) + '\n';
  await rotate(); await journal.write(line); journalSize += Buffer.byteLength(line);
  const temp = `${statePath}.tmp`;
  await retryFile(() => writeFile(temp, JSON.stringify(checkpoint))); await retryFile(() => rename(temp, statePath));
  if(prints?.length) recordPrints(market.time, sessionStart);
  if (status === 'closed' || Date.now() - lastChartSave >= 60000) {
    await candles.save(dataDir, retryFile);
    lastChartSave = Date.now();
  }
  persistMs = performance.now() - start;
  if (status === 'closed') {
    await journal.sync();
    const handle = await open(statePath, 'r+'); await handle.sync(); await handle.close();
  }
}
function publish(isTick = true, changedCode) {
  const updates = [], nextVersions = new Map();
  for (const o of market.orders) {
    const signature = `${o.status}|${o.remaining}|${o.average}`;
    nextVersions.set(o.id, signature); if (orderVersions.get(o.id) !== signature) updates.push(o);
  }
  const removed = [...orderVersions.keys()].filter(id => !nextVersions.has(id)); orderVersions = nextVersions;
  const changed = updates.length || removed.length;
  const account = market.account();
  const tick = isTick ? { tick: market.tick, time: market.time, quotes: changedCode ? [{code:changedCode,...market.quote(market.getStock(changedCode))}] : market.quotes(lastPublishedDay!==market.day), index: market.index(), indexCandles: candles.latest(INDEX_CODE), account } : null;
  if(isTick && !changedCode)lastPublishedDay=market.day;
  const detailCodes = isTick && !changedCode ? [...symbols] : symbols.has(changedCode) ? [changedCode] : [];
  parentPort.postMessage({ type: 'tick', json: tick ? JSON.stringify(tick) : null,
    accountJson: isTick ? null : JSON.stringify(account),
    ordersJson: changed ? JSON.stringify({ updates, removed }) : null,
    // Full reset is used only for a backpressured subscriber, never for ordinary tick traffic.
    ordersResetJson: changed ? JSON.stringify({ reset: market.orders.toReversed() }) : null,
    details: Object.fromEntries(detailCodes.map(code => [code, JSON.stringify({ ...market.detail(code), candles: candles.latest(code) })])),
    metrics: { workMs, persistMs, tickCount, fileRetries } });
}
const orderArchive = new OrderArchive(dataDir, retryFile);
async function findReceipt(requestId) {
  const order = market.ordersByRequest.get(requestId);
  return order ? { order } : orderArchive.read(requestId);
}
async function submitOrder(input, receivedAt) {
  const terms = validateOrderInput(input);
  const receipt = await findReceipt(terms.requestId);
  if (receipt) {
    checkOrderTerms(terms, receipt.order ?? receipt.rejected);
    if (receipt.rejected) throw orderError(receipt.error);
    return receipt.order;
  }
  let order;
  try { const time=Math.max(receivedAt,candles.through+1);await nextDay(time);market.time=time;order = market.placeOrder(input, time); }
  catch (error) {
    if (error.status === 400) await orderArchive.save(terms.requestId, { rejected: terms, error: error.message });
    throw error;
  }
  // Only remove the old receipt from the durable checkpoint after its
  // final result is safely published to the archive.
  if (market.evictedOrder) await orderArchive.save(market.evictedOrder.requestId, { order: market.evictedOrder });
  await persist('running', 'order');
  publish(!!market.prints.length, order.code);
  return order;
}
async function orderByRequest(requestId) {
  const receipt = await findReceipt(requestId);
  if (!receipt) throw orderError('해당 요청 ID로 접수된 주문이 없습니다.', 404);
  if (receipt.rejected) throw orderError(receipt.error, 422);
  return receipt.order;
}
async function fatal(error) {
  stopping = true; clearTimeout(timer); parentPort.postMessage({ type: 'fatal', message: error.message });
  // Fail closed if durable writes fail; retain the last complete checkpoint.
  try { await journal.close(); } catch {}
  try { await releaseWriter(); } catch {}
  parentPort.close();
}
function enqueue(task) { queue = queue.then(task).catch(fatal); return queue; }
function schedule(delay = interval) {
  if (stopping) return;
  timer = setTimeout(() => enqueue(async () => {
    if (stopping) return;
    const start = performance.now(); const now=Math.max(Date.now(),candles.through+1);await nextDay(now);market.step(now); await persist();
    workMs = performance.now() - start; tickCount++; publish();
    // Never accumulate missed ticks or an unbounded disk-write queue.
    schedule(Math.max(5, interval - (performance.now() - start)));
  }), delay);
}
parentPort.on('message', message => {
  if (message.type === 'symbols') { symbols = new Set(message.symbols); return; }
  if (message.type === 'stop') {
    if (stopping) return;
    stopping = true; clearTimeout(timer);
    enqueue(async () => {
      // The continuous market keeps outstanding reservations across restarts.
      await persist('closed', 'close'); await journal.close(); await releaseWriter();
      parentPort.postMessage({ type: 'stopped', closedAt: new Date().toISOString() }); parentPort.close();
    }); return;
  }
  if (message.type !== 'request') return;
  enqueue(async () => {
    try {
      if (stopping) throw orderError('서버가 종료 중입니다.', 503);
      let result;
      if (message.method === 'cash') result = cashState(market);
      else if (message.method === 'adjustCash') {
        if (adjustCash(market, message.body)) {
          await persist('running', 'cash');
          publish(false);
        }
        result = { ok: true, ...cashState(market) };
      } else if (message.method === 'candles') {
        result = await archives.serialize(candles,message.code,message.period);
      } else if (message.method === 'state') result = market.state(message.code);
      else if (message.method === 'order') result = await submitOrder(message.body, message.receivedAt);
      else if (message.method === 'orderByRequest') result = await orderByRequest(message.requestId);
      else if (message.method === 'cancel') { result = market.cancelOrder(message.id); await persist('running', 'cancel'); publish(false, result.code); }
      else throw Error('알 수 없는 요청입니다.');
      parentPort.postMessage({ type: 'response', request: message.request, result });
    } catch (error) {
      const status = error.status ?? (error.code ? 503 : 500);
      const reason = status >= 500 ? '주문·시세 서버를 사용할 수 없습니다. 요청 ID로 결과를 다시 확인하세요.' : error.message;
      parentPort.postMessage({ type: 'response', request: message.request, error: reason, status });
      if (!error.status) await fatal(error);
    }
  });
});
const startupTime=Date.now();
const resumeFrom=Math.max(cutoff,previous?.lastQuoteTime??previous?.updatedAt??cutoff,candles.through);
for (const minute of missingMinutes(resumeFrom,startupTime)){
  await nextDay(minute);
  market.random=seededRandom(seed ^ Math.floor(minute/60000));
  market.eventRandom=seededRandom((seed ^ Math.floor(minute/60000)) + 107);
  // Four ordered prints provide a reproducible intraminute price and volume path.
  for(const offset of [0,15000,30000,45000]){
    market.step(minute+offset);
    recordPrints(market.time,chartSession(minute));
  }
}
if(candles.through>resumeFrom)await candles.save(dataDir,retryFile);
// Outstanding orders begin trading in the new universe only after historical replay.
if (copiedAccount) market.restoreAccount(copiedAccount);
market.tick=0;
market.time=Math.max(startupTime,candles.through);
await persist('running', recovered ? 'recover-open' : 'open');
parentPort.postMessage({ type: 'ready', recovered, dataDir, migration, reference: market.reference }); schedule();
