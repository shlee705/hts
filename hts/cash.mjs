function invalid(message, status = 400) {
  return Object.assign(new Error(message), { status });
}
export function cashState(market) {
  return { cash: market.cash, available: market.availableCash(), revision: market.cashRevision, lastOperation: market.lastCashOperation };
}
export function adjustCash(market, body) {
  const { direction, amount, revision, requestId } = body;
  if (!['deposit', 'withdraw'].includes(direction) || !Number.isSafeInteger(amount) || amount < 1 ||
      !Number.isSafeInteger(revision) || revision < 0 || typeof requestId !== 'string' || !/^[a-zA-Z0-9-]{8,80}$/.test(requestId)) {
    throw invalid('충전 또는 인출할 양의 정수 금액을 입력하세요.');
  }
  const last = market.lastCashOperation;
  if (last?.requestId === requestId) {
    if (last.amount !== amount || last.direction !== direction || last.revision !== revision + 1) throw invalid('같은 요청 번호에 다른 변경 내용이 있습니다.', 409);
    return false;
  }
  if (revision !== market.cashRevision) throw invalid('예수금이 이미 변경되었습니다. 최신 잔액을 확인하세요.', 409);
  if (!Number.isSafeInteger(revision + 1)) throw invalid('예수금 변경 번호 한도에 도달했습니다.', 409);
  if (direction === 'withdraw' && amount > market.availableCash()) throw invalid('인출 가능 금액이 부족합니다.');
  const nextCash = market.cash + (direction === 'deposit' ? amount : -amount);
  // Leave headroom for settlement of existing positions at their session ceiling.
  if (direction === 'deposit') {
    const holdingsAtLimit = [...market.holdings.values()].reduce((sum, h) => sum + h.quantity * market.getStock(h.code).upperLimit, 0);
    if (!Number.isSafeInteger(nextCash + holdingsAtLimit) || nextCash > 1_000_000_000_000_000) throw invalid('충전 가능한 잔액 한도를 초과했습니다.');
  }
  market.cash = nextCash;
  market.cashRevision++;
  market.lastCashOperation = { requestId, revision: market.cashRevision, direction, amount, cash: nextCash, available: market.availableCash(), time: Date.now() };
  return true;
}
