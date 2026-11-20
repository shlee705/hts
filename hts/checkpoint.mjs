import { STOCKS } from './public/market-data.mjs';
import { tickSize } from './public/tick-size.mjs';

const codes = new Set(STOCKS.map(s => s.code));
const units = new Set([1, 5, 10, 50, 100, 500, 1000]);
const whole = n => Number.isSafeInteger(n) && n >= 0;
const positive = n => whole(n) && n > 0;
const timestamp = n => whole(n) && n <= 8640000000000000;
const requestId = id => typeof id === 'string' && /^[a-zA-Z0-9-]{8,80}$/.test(id);

export function validStoredOrder(order, members = codes) {
  if (!order || typeof order.id !== 'string' || !/^P\d{6,}$/.test(order.id)) return false;
  const sequence = Number(order.id.slice(1));
  if (!positive(sequence) || order.id !== 'P' + String(sequence).padStart(6, '0')) return false;
  if (typeof order.code !== 'string' || !/^[A-Z0-9]{6}$/.test(order.code) || (members && !members.has(order.code)) ||
      !requestId(order.requestId) || !timestamp(order.time)) return false;
  if (!['buy', 'sell'].includes(order.side) || !['market', 'limit'].includes(order.type)) return false;
  if (!positive(order.limit) || !positive(order.quantity) || order.quantity > 1_000_000) return false;
  if (!whole(order.filled) || !whole(order.remaining) || order.quantity !== order.filled + order.remaining) return false;
  if (!Number.isFinite(order.average) || (order.filled ? order.average <= 0 : order.average !== 0)) return false;
  switch (order.status) {
    case 'filled': return order.remaining === 0;
    case 'cancelled': return order.remaining > 0;
    case 'open': return order.filled === 0;
    case 'partial': return order.filled > 0 && order.remaining > 0;
    default: return false;
  }
}

function invalid(field) {
  throw Error(`저장된 시세 파일의 ${field} 값이 올바르지 않습니다. 원본을 보존하고 복구해야 합니다.`);
}

function validateCashOperation(account) {
  const revision = account.cashRevision === undefined ? 0 : account.cashRevision;
  if (!whole(revision)) invalid('cashRevision');
  const operation = account.lastCashOperation;
  if (revision === 0 && operation == null) return;
  if (!revision || !operation || revision !== operation.revision || !requestId(operation.requestId) ||
      !['deposit', 'withdraw'].includes(operation.direction) || !positive(operation.amount) ||
      !whole(operation.cash) || !whole(operation.available) || operation.available > operation.cash ||
      !timestamp(operation.time)) invalid('lastCashOperation');
}

export function validateCheckpoint(state, members = codes) {
  if (state?.version !== 1 || !['running', 'closed'].includes(state.status) || !timestamp(state.updatedAt)) invalid('상태·시각');
  const variableGrid = state.quoteGridVersion === 2;
  if (state.quoteGridVersion !== undefined && !variableGrid) invalid('호가 형식');
  if (state.status === 'closed' && (typeof state.closedAt !== 'string' || !Number.isFinite(Date.parse(state.closedAt)))) invalid('종료 시각');
  if (Object.keys(state.prices ?? {}).length !== members.size) invalid('구성 종목');
  for (const code of members) {
    const price = state.prices?.[code];
    if (!positive(price)) invalid('종가');
    if (variableGrid && state.units?.[code] !== tickSize(price)) invalid('호가 단위');
    if (state.units !== undefined && (!units.has(state.units?.[code]) || price % state.units[code] !== 0)) invalid('호가 단위');
  }
  for (const [code, book] of Object.entries(state.consumedBooks ?? {})) {
    if (!members.has(code)) invalid('호가 종목');
    for (const side of ['asks','bids']) {
      const depth = book?.[side], direction = side === 'asks' ? 1 : -1;
      const step = direction * state.units?.[code];
      const onGrid = price => price % (variableGrid ? tickSize(price) : step) === 0;
      if (!Array.isArray(depth?.levels) || !depth.levels.every((row, i, rows) => {
        if (!Array.isArray(row)) return false;
        const [price,size] = row;
        return positive(price) && positive(size) && onGrid(price) &&
          (i === 0 || direction * (price-rows[i-1][0]) > 0);
      })) invalid('호가 잔량');
      const tail = depth.tail;
      if (!tail) continue;
      if (variableGrid ? (tail.direction !== direction || !whole(tail.nearRemaining) || tail.nearRemaining > 10) : tail.step !== step)
        invalid('호가 진행 방향');
      if (!Number.isSafeInteger(tail.next) || (variableGrid && tail.next < 0) ||
          !positive(tail.end) || !Number.isSafeInteger(tail.seed) ||
          !onGrid(tail.next) || !onGrid(tail.end) ||
          (depth.levels.length && direction*(tail.next-depth.levels.at(-1)[0])<=0))
        invalid('호가 가격대');
    }
  }
  const account = state.account;
  if (!whole(account?.cash) || !Number.isFinite(account.realized) || !positive(account.nextOrderId)) invalid('계좌');
  if (!Array.isArray(account.holdings) || !Array.isArray(account.orders) || account.orders.length > 500) invalid('잔고·주문 목록');
  validateCashOperation(account);
  const shares = new Map();
  for (const holding of account.holdings) {
    if (!members.has(holding?.code) || shares.has(holding.code) || !positive(holding.quantity) ||
        !Number.isFinite(holding.average) || holding.average <= 0) invalid('보유 종목');
    shares.set(holding.code, holding.quantity);
  }
  const orderIds = new Set(), requests = new Set();
  let availableCash = account.cash;
  let openOrders = 0;
  for (const order of account.orders) {
    if (!validStoredOrder(order, members) || orderIds.has(order.id) || requests.has(order.requestId) ||
        Number(order.id.slice(1)) >= account.nextOrderId) invalid('주문');
    orderIds.add(order.id);
    requests.add(order.requestId);
    if (order.status !== 'partial' && order.status !== 'open') continue;
    if (++openOrders > 100) invalid('미체결 주문');
    if (order.side === 'buy') {
      availableCash -= order.remaining * order.limit;
      if (!whole(availableCash)) invalid('예약 금액');
    } else {
      const availableShares = (shares.get(order.code) || 0) - order.remaining;
      if (availableShares < 0) invalid('예약 수량');
      shares.set(order.code, availableShares);
    }
  }
}
