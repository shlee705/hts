import { STOCKS, MARKET_DATA, INDEX_NAME, constituentIndex } from './public/market-data.mjs';

import { tradingDay } from './calendar.mjs';
export const INITIAL_CASH = 100_000_000;
export const PRICE_MODEL = Object.freeze({
  normalBandRatio: .0015,
  firstEventMs: [45000, 120000],
  eventGapMs: [90000, 180000],
  eventDurationMs: [25000, 45000],
  recentEventLimit: 100,
});
export const EVENT_TYPES = Object.freeze([
  { type: 'good', label: '호재', direction: 1, weight: .4, impact: [.003, .008], noise: 1.8 },
  { type: 'bad', label: '악재', direction: -1, weight: .4, impact: [.003, .008], noise: 1.8 },
  { type: 'very-good', label: '매우 호재', direction: 1, weight: .1, impact: [.012, .025], noise: 3 },
  { type: 'very-bad', label: '매우 악재', direction: -1, weight: .1, impact: [.012, .025], noise: 3 },
]);
export const tickSize = p => p >= 500000 ? 1000 : p >= 200000 ? 500 : p >= 50000 ? 100 : p >= 20000 ? 50 : p >= 5000 ? 10 : p >= 2000 ? 5 : 1;
export function seededRandom(seed) {
  let state = Number(seed) >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = Math.imul(state ^ state >>> 15, 1 | state);
    t ^= t + Math.imul(t ^ t >>> 7, 61 | t);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
// The cursor describes every unmaterialized tick through the daily price limit.
function levelSize(seed, price, nearBest) {
  const random = seededRandom(seed ^ price)();
  // Nearby quotes carry more size than liquidity far away from the last trade.
  return nearBest ? 10 + Math.floor(random * 1800) : 40 + Math.floor(random * 131);
}
function appendLevel(levels) {
  const cursor = levels.tail;
  if (!cursor || (cursor.step > 0 ? cursor.next > cursor.end : cursor.next < cursor.end)) return false;
  const price = cursor.next;
  cursor.next += cursor.step;
  const quantity = levelSize(cursor.seed, price, Math.abs(price-cursor.best) < 10*Math.abs(cursor.step));
  levels.push([price, quantity]);
  return true;
}
function refillDisplay(levels) {
  while (levels.length < 10 && appendLevel(levels)) {}
}
function makeSide(best, step, end, seed) {
  const levels = [];
  levels.tail = {best,next:best,step,end,seed};
  refillDisplay(levels);
  return levels;
}
const bound = (n, low, high) => Math.max(low, Math.min(high, n));
export function orderError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}
export function validateOrderInput({ code, side, type, quantity, price, requestId }) {
  if (typeof requestId !== 'string' || !/^[a-zA-Z0-9-]{8,80}$/.test(requestId)) throw orderError('주문 요청 ID가 올바르지 않습니다.');
  if (typeof code !== 'string' || !/^[A-Z0-9]{6}$/.test(code)) throw orderError('종목 코드가 올바르지 않습니다.');
  if (!['buy', 'sell'].includes(side) || !['limit', 'market'].includes(type)) throw orderError('주문 유형이 올바르지 않습니다.');
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1000000) throw orderError('수량은 1~1,000,000 사이의 정수여야 합니다.');
  if (type === 'limit' && !Number.isSafeInteger(price)) throw orderError('지정가 주문 가격은 정수여야 합니다.');
  return { requestId, code, side, type, quantity, limit: type === 'limit' ? price : null };
}
export function checkOrderTerms(request, previous) {
  if (request.code !== previous.code || request.side !== previous.side || request.type !== previous.type ||
      request.quantity !== previous.quantity || (request.type === 'limit' && request.limit !== previous.limit && request.limit !== previous.requestedLimit)) {
    throw orderError('같은 요청 ID에 서로 다른 주문 내용이 제출되었습니다.', 409);
  }
}
export class Market {
  constructor({ seed = 20261116, previous, now = Date.now(), tickMs = 1000 } = {}) {
    if (!Number.isInteger(tickMs) || tickMs < 1 || tickMs > 60000) throw Error('Invalid tick duration.');
    this.seed = seed; this.random = seededRandom(seed); this.tick = 0; this.time = now;
    this.eventRandom = seededRandom(seed ^ 0x9E3779B9);
    this.tickMs = tickMs; this.elapsedMs = 0; this.nextEventId = 1;
    this.recentEvents = []; this.tickEvents = [];
    this.reference = previous?.reference ?? MARKET_DATA.asOf;
    this.restoreAccount(previous?.account);
    this.stocks = STOCKS.map(data => {
      const price = previous?.prices?.[data.code] ?? data.close;
      const unit = previous?.units?.[data.code] || tickSize(price);
      const stock = { ...data, prev: price, price, unit, open: price, high: price, low: price, volume: 0, turnover: 0, direction: 0, history: [{ time: now, price, volume: 0 }], trades: [] };
      stock.upperLimit = Math.floor(price * 130 / (100 * unit)) * unit;
      stock.lowerLimit = Math.ceil(price * 70 / (100 * unit)) * unit;
      stock.dynamics = { anchor: price, latent: price, event: null, nextEventAt: this.eventRange(PRICE_MODEL.firstEventMs) };
      this.makeBook(stock); return stock;
    });
    this.byCode = new Map(this.stocks.map(s => [s.code, s]));
    this.day = previous?.tradingDay ?? tradingDay(now);
    this.dayStats = previous?.dayStats;
    if (this.dayStats) for (const s of this.stocks) {
      const stats=this.dayStats[s.code]; if(stats) Object.assign(s,stats);
      s.upperLimit=Math.floor(s.prev*130/(100*s.unit))*s.unit;
      s.lowerLimit=Math.ceil(s.prev*70/(100*s.unit))*s.unit;
      this.makeBook(s);
    }
    for (const order of this.orders) {
      if (order.type === 'market' && order.remaining && order.status !== 'cancelled')
        this.getStock(order.code)[order.side === 'buy' ? 'asks' : 'bids'] = [];
    }
    for (const [code,book] of Object.entries(previous?.consumedBooks ?? {})) {
      const stock = this.getStock(code);
      for (const side of ['asks','bids']) {
        stock[side] = book[side].levels.map(level => [...level]);
        stock[side].tail = book[side].tail;
      }
      stock.bookChanged = true;
    }
    this.prints = [];
    this.indexPrevious = this.calculateIndex('prev');
    this.indexPrevious=previous?.index?.previousClose??this.indexPrevious;
    this.indexHigh=previous?.index?.high??this.indexPrevious; this.indexLow=previous?.index?.low??this.indexPrevious;
    this.updateIndex();
  }
  restoreAccount(account = {}) {
    this.cash = account.cash ?? INITIAL_CASH;
    this.realized = account.realized ?? 0;
    this.cashRevision = account.cashRevision ?? 0;
    this.lastCashOperation = account.lastCashOperation ?? null;
    this.holdings = new Map((account.holdings ?? []).map(h => [h.code, { ...h }]));
    this.nextOrderId = account.nextOrderId ?? 1;
    this.orders = (account.orders ?? []).map(o => ({ ...o }));
    this.ordersByRequest = new Map(this.orders.map(order => [order.requestId, order]));
    this.evictedOrder = null;
  }
  getStock(code) { const s = this.byCode.get(code); if (!s) throw orderError('존재하지 않는 종목입니다.'); return s; }
  eventRange([min, max]) { return min + this.eventRandom() * (max - min); }
  startEvent(s) {
    let roll = this.eventRandom();
    const type = EVENT_TYPES.find(item => (roll -= item.weight) < 0) || EVENT_TYPES.at(-1);
    const impact = this.eventRange(type.impact) * type.direction;
    const event = { id: this.nextEventId++, code: s.code, type: type.type, label: type.label, direction: type.direction,
      startedAt: this.time, elapsedStart: this.elapsedMs, durationMs: this.eventRange(PRICE_MODEL.eventDurationMs),
      from: s.dynamics.anchor, target: bound(s.dynamics.anchor * (1 + impact), s.lowerLimit, s.upperLimit),
      impact, noise: type.noise };
    s.dynamics.event = event; this.tickEvents.push(event); this.recentEvents.push(event);
    if (this.recentEvents.length > PRICE_MODEL.recentEventLimit) this.recentEvents.shift();
  }
  movePrice(s, seconds) {
    const d = s.dynamics;
    if (!d.event && this.elapsedMs >= d.nextEventAt) this.startEvent(s);
    const event = d.event;
    if (event) {
      const progress = bound((this.elapsedMs - event.elapsedStart) / event.durationMs, 0, 1);
      const eased = progress * progress * (3 - 2 * progress);
      d.anchor = event.from + (event.target - event.from) * eased;
      if (progress === 1) { d.event = null; d.nextEventAt = this.elapsedMs + this.eventRange(PRICE_MODEL.eventGapMs); }
    }
    // A bounded, mean-reverting latent price avoids an unbounded random walk.
    // Scale by elapsed simulation seconds so a faster feed does not amplify volatility.
    const alpha = 1 - Math.exp(-(event ? .7 : .18) * seconds);
    const noise = (this.random() + this.random() + this.random() - 1.5) * 2;
    const sigma = Math.max(s.unit * .22, d.anchor * .000035) * (event?.noise || 1);
    const band = Math.max(s.unit, d.anchor * PRICE_MODEL.normalBandRatio) * (event ? 1.5 : 1);
    d.latent = bound(d.latent + (d.anchor - d.latent) * alpha + noise * sigma * Math.sqrt(seconds), d.anchor - band, d.anchor + band);
    const movementLimit = event ? Math.max(1, Math.ceil(d.anchor * .0012 * seconds / s.unit)) * s.unit : s.unit;
    s.price = bound(Math.round(d.latent / s.unit) * s.unit, Math.max(s.lowerLimit, s.price - movementLimit), Math.min(s.upperLimit, s.price + movementLimit));
    return event;
  }
  calculateIndex(field = 'price') {
    return constituentIndex((stock, i) => this.stocks[i][field]);
  }
  updateIndex() {
    const value = this.calculateIndex(); this.indexHigh = Math.max(this.indexHigh, value); this.indexLow = Math.min(this.indexLow, value);
    this.indexState = { name: INDEX_NAME, value, previousClose: this.indexPrevious, change: value - this.indexPrevious,
      changeRate: (value / this.indexPrevious - 1) * 100, high: this.indexHigh, low: this.indexLow, base: MARKET_DATA.indexClose, constituents: this.stocks.length };
  }
  index() { return { ...this.indexState }; }
  makeBook(s, side = 'buy') {
    const bestAsk = side === 'buy' ? s.price : s.price + s.unit;
    const bestBid = bestAsk - s.unit;
    const seed = Math.floor(this.random() * 4294967296);
    s.asks = makeSide(bestAsk, s.unit, s.upperLimit, seed);
    s.bids = makeSide(bestBid, -s.unit, s.lowerLimit, ~seed);
    s.bookChanged = false;
  }
  rollDay(now) {
    const day=tradingDay(now);
    if(day===this.day) return;
    this.day=day; this.indexPrevious=this.calculateIndex();
    this.indexLow=this.indexHigh=this.indexPrevious;
    for(const s of this.stocks){
      s.prev=s.open=s.high=s.low=s.price; s.volume=s.turnover=0;
      s.upperLimit=Math.floor(s.prev*130/(100*s.unit))*s.unit; s.lowerLimit=Math.ceil(s.prev*70/(100*s.unit))*s.unit;
      this.makeBook(s);
    }
    this.reference=new Date(day).toISOString();
  }
  step(now = this.time + this.tickMs) {
    this.rollDay(now); this.prints=[]; this.tick++; this.time = now; this.elapsedMs += this.tickMs; this.tickEvents = [];
    const pressure = new Map();
    for (const order of this.orders) {
      if (order.type === 'market' && order.remaining && order.status !== 'cancelled' && !pressure.has(order.code))
        pressure.set(order.code, order);
    }
    for (const s of this.stocks) {
      const queued = pressure.get(s.code);
      if (queued) {
        // Incoming counterparty liquidity trades against the resting order at its price.
        const price = bound(queued.limit, s.lowerLimit, s.upperLimit);
        // Rebuild the passive side around the incoming execution, retaining user queues separately.
        const best = price + (queued.side === 'buy' ? -s.unit : s.unit);
        const sign = queued.side === 'buy' ? -1 : 1;
        s[queued.side === 'buy' ? 'bids' : 'asks'] = makeSide(best,sign*s.unit,
          sign<0 ? s.lowerLimit : s.upperLimit,Math.floor(this.random()*4294967296));
        const levels = queued.side === 'buy' ? 'asks' : 'bids';
        s[levels] = [[price, 10 + Math.floor(this.random() * 1800)]];
        continue;
      }
      const old = s.price;
      const event = this.movePrice(s, this.tickMs / 1000);
      s.direction = Math.sign(s.price - old);
      const quantity = Math.ceil(this.random() * 1500 * (event?.noise || 1));
      const side = s.direction === 0 ? (this.random() > .5 ? 'buy' : 'sell') : s.direction > 0 ? 'buy' : 'sell';
      this.prints.push([s.code,s.price,quantity]);
      s.volume += quantity; s.turnover += s.price * quantity;
      s.high = Math.max(s.high, s.price); s.low = Math.min(s.low, s.price);
      s.history.push({ time: now, price: s.price, volume: quantity });
      if (s.history.length > 180) s.history.shift();
      s.trades.unshift({ time: now, price: s.price, quantity, side });
      if (s.trades.length > 30) s.trades.pop();
      this.makeBook(s, side);
    }
    for (const order of this.orders) if (order.remaining && order.status !== 'cancelled') this.match(order);
    this.updateIndex();
  }
  availableCash(except) {
    return this.cash - this.orders.reduce((sum, o) => sum + (o.id !== except && o.side === 'buy' && o.status !== 'cancelled' ? o.remaining * o.limit : 0), 0);
  }
  availableShares(code, except) {
    return (this.holdings.get(code)?.quantity || 0) - this.orders.reduce((sum, o) => sum + (o.id !== except && o.code === code && o.side === 'sell' && o.status !== 'cancelled' ? o.remaining : 0), 0);
  }
  placeOrder(input, receivedAt = Date.now()) {
    const terms = validateOrderInput(input);
    const { code, side, type, quantity, requestId } = terms;
    const duplicate = this.ordersByRequest.get(requestId);
    if (duplicate) { checkOrderTerms(terms, duplicate); return duplicate; }
    this.prints=[];
    const s = this.getStock(code);
    const levels = side === 'buy' ? s.asks : s.bids;
    // V-04: accept whole-won limit orders between quoted price levels.
    const limit = type === 'market' ? (side === 'buy' ? s.upperLimit : s.lowerLimit) : bound(terms.limit,s.lowerLimit,s.upperLimit);
    if (side === 'buy' && limit * quantity > this.availableCash()) throw orderError('주문 가능 금액이 부족합니다.');
    if (side === 'sell' && quantity > this.availableShares(code)) throw orderError('매도 가능 수량이 부족합니다.');
    if (this.orders.filter(o => o.remaining && o.status !== 'cancelled').length >= 100) {
      let executable = 0;
      for (let i=0; executable<quantity && (i<levels.length || appendLevel(levels)); i++) {
        const [price,size] = levels[i];
        if (side === 'buy' ? price > limit : price < limit) break;
        executable += size;
      }
      if (executable < quantity) throw orderError('미체결 주문은 최대 100개까지 가능합니다.');
    }
    const order = { id: `P${String(this.nextOrderId++).padStart(6, '0')}`, requestId, code, side, type, quantity, limit, remaining: quantity, filled: 0, average: 0, status: 'open', time: receivedAt };
    if(type==='limit' && limit!==terms.limit) order.requestedLimit=terms.limit;
    this.ordersByRequest.set(requestId, order);
    this.orders.push(order); this.match(order); this.updateIndex();

    this.evictedOrder = null;
    if (this.orders.length > 500) {
      const index = this.orders.findIndex(o => o.status === 'filled' || o.status === 'cancelled');
      [this.evictedOrder] = this.orders.splice(index, 1);
      this.ordersByRequest.delete(this.evictedOrder.requestId);
    }
    return order;
  }
  match(order) {
    const s = this.getStock(order.code);
    const levels = order.side === 'buy' ? s.asks : s.bids;
    const before = order.filled, priorPrice = s.price;
    let exhausted = 0;
    for (let i=0; order.remaining && (i<levels.length || appendLevel(levels)); i++) {
      const level = levels[i];
      if (!order.remaining || (order.side === 'buy' ? level[0] > order.limit : level[0] < order.limit)) break;
      const fillPrice = order.type === 'limit' ? order.limit : level[0];
      let quantity = Math.min(order.remaining, level[1]);
      quantity = Math.min(quantity, order.side === 'buy' ? Math.floor(Math.max(0, this.availableCash(order.id)) / fillPrice) : Math.max(0, this.availableShares(order.code, order.id)));
      if (!quantity) continue;
      const value = fillPrice * quantity;
      let h = this.holdings.get(order.code);
      if (order.side === 'buy') {
        this.cash -= value;
        if (!h) { h = { code: order.code, quantity: 0, average: 0 }; this.holdings.set(order.code, h); }
        h.average = (h.quantity * h.average + value) / (h.quantity + quantity); h.quantity += quantity;
      } else {
        this.cash += value; this.realized += (fillPrice - h.average) * quantity;
        h.quantity -= quantity; if (!h.quantity) this.holdings.delete(order.code);
      }
      order.average = (order.average * order.filled + value) / (order.filled + quantity);
      order.filled += quantity; order.remaining -= quantity; level[1] -= quantity;
      if (!level[1]) exhausted++;
      const price=level[0], time=Math.max(this.time,order.time);
      s.direction=Math.sign(price-s.price); s.price=price; s.low=Math.min(s.low,price); s.high=Math.max(s.high,price);
      s.volume+=quantity; s.turnover+=price*quantity; this.prints.push([s.code,price,quantity]);
      s.trades.unshift({time,price,quantity,side:order.side}); s.trades.length=Math.min(30,s.trades.length);
      s.history.push({time,price,volume:quantity}); if(s.history.length>180)s.history.shift();
    }
    if (order.filled > before && s.dynamics.latent !== s.price) {
      s.dynamics.anchor = s.dynamics.latent = s.price;
      s.dynamics.event = null;
    }
    if (order.filled > before) {
      s.bookChanged = true;
      levels.splice(0, exhausted);
      refillDisplay(levels);
      // Quote behind a moving execution price. Retain all older passive levels and their sizes.
      const buy = order.side === 'buy';
      if (buy ? s.price > priorPrice : s.price < priorPrice) {
        const passive = buy ? s.bids : s.asks;
        const step = buy ? -s.unit : s.unit;
        const edge = buy ? s.lowerLimit : s.upperLimit;
        const existing = passive[0]?.[0] ?? (edge + step);
        const added = [];
        for (let price=s.price+step; buy ? price>existing : price<existing; price+=step) {
          const size = levelSize(this.seed ^ this.tick ^ Number(s.code), price, added.length<10);
          added.push([price, size]);
        }
        if (added.length) {
          const joined = added.concat(passive);
          joined.tail = passive.tail;
          s[buy ? 'bids' : 'asks'] = joined;
        }
      }
    }
    order.status = !order.remaining ? 'filled' : order.filled ? 'partial' : 'open';
  }
  cancelOrder(id) {
    const order = this.orders.find(o => o.id === id);
    if (!order || !order.remaining || order.status === 'cancelled') throw orderError('취소 가능한 주문이 아닙니다.');
    order.status = 'cancelled'; return order;
  }
  account() {
    let valuation = 0, cost = 0;
    const positions = [...this.holdings.values()].map(h => {
      const price = this.getStock(h.code).price, value = h.quantity * price;
      valuation += value; cost += h.quantity * h.average;
      return { ...h, price, value, profit: value - h.average * h.quantity, available: this.availableShares(h.code) };
    });
    return { cash: this.cash, available: this.availableCash(), equity: this.cash + valuation, valuation, profit: valuation - cost, realized: this.realized, positions };
  }
  quotes(includeLimits=false) { return this.stocks.map(s => ({ code: s.code, ...(includeLimits ? {prev:s.prev, open:s.open, upperLimit:s.upperLimit, lowerLimit:s.lowerLimit} : {}), price: s.price, high: s.high, low: s.low, volume: s.volume, turnover: s.turnover, direction: s.direction })); }
  detail(code, full = false) {
    const s = this.getStock(code);
    const pending = this.orders.filter(order => order.code === code && order.remaining && order.status !== 'cancelled');
    function depth(levels, side) {
      levels = levels.slice(0,10);
      if (!pending.length) return levels;
      const quantities = new Map(levels);
      for (const order of pending) if (order.side === side)
        quantities.set(order.limit, (quantities.get(order.limit) ?? 0) + order.remaining);
      return [...quantities].sort(([a], [b]) => side === 'buy' ? b - a : a - b).slice(0, 10);
    }
    return { code, asks: depth(s.asks, 'sell'), bids: depth(s.bids, 'buy'), trades: s.trades.slice(0, 16), point: s.history.at(-1), ...(full ? { history: s.history } : {}) };
  }
  state(code = '005930') {
    return { seed: this.seed, tick: this.tick, time: this.time, reference: this.reference, sourceDate: MARKET_DATA.asOf, index: this.index(), stocks: this.stocks.map(s => ({ code: s.code, name: s.name, rank: s.rank, shares: s.shares, upperLimit: s.upperLimit, lowerLimit: s.lowerLimit, prev: s.prev, unit: s.unit, open: s.open, ...this.quote(s) })), detail: this.detail(code, true), account: this.account(), orders: this.orders.toReversed() };
  }
  quote(s) { return { price: s.price, high: s.high, low: s.low, volume: s.volume, turnover: s.turnover, direction: s.direction }; }
  checkpoint(status = 'running', now = this.time) {
    const consumedBooks = {};
    for (const s of this.stocks) if (s.bookChanged) {
      consumedBooks[s.code] = Object.fromEntries(['asks','bids'].map(side =>
        [side,{levels:s[side].map(level=>[...level]),tail:s[side].tail && {...s[side].tail}}]));
    }
    return { version: 1, consumedBooks, reference:this.reference,lastQuoteTime:this.time, tradingDay:this.day, dayStats:Object.fromEntries(this.stocks.map(({code,prev,open,high,low,volume,turnover})=>[code,{prev,open,high,low,volume,turnover}])), status, seed: this.seed, tick: this.tick, updatedAt: now, closedAt: status === 'closed' ? new Date(now).toISOString() : null, prices: Object.fromEntries(this.stocks.map(s => [s.code, s.price])), units: Object.fromEntries(this.stocks.map(s => [s.code, s.unit])), index: this.index(), simulation: { elapsedMs: this.elapsedMs, recentEvents: this.recentEvents }, account: { cash: this.cash, cashRevision: this.cashRevision, lastCashOperation: this.lastCashOperation, realized: this.realized, holdings: [...this.holdings.values()], orders: this.orders, nextOrderId: this.nextOrderId } };
  }
}
