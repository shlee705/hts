import { STOCKS } from './market-data.mjs';
import { createQuoteFeed, createOrderEntry, fillableQuantity } from './order-entry.mjs';
import { createCandleHistory, createCandleRenderer, periods } from './candle-chart.mjs';
import { createChartNavigation } from './chart-navigation.mjs';
const $ = id => document.getElementById(id);
const refs = Object.fromEntries([...document.querySelectorAll('[id]')].map(el => [el.id, el]));
const num = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 0 });
const indexNumber = new Intl.NumberFormat('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const clock = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' });
const fmt = n => num.format(n || 0), pct = n => `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;
const signed = n => `${n > 0 ? '+' : n < 0 ? '−' : ''}${fmt(Math.abs(n))}`;
const tone = n => n > 0 ? 'up' : n < 0 ? 'down' : 'neutral';
function text(el, value) { if (el.textContent !== String(value)) el.textContent = value; }
function color(el, value) { el.classList.remove('up', 'down', 'neutral'); el.classList.add(tone(value)); }
const initialParams = new URLSearchParams(location.search);
const initialStock = STOCKS.find(stock => stock.code === initialParams.get('symbol'));
let initialSellCode = initialStock && initialParams.get('side') === 'sell' ? initialStock.code : null;
let selected = initialStock?.code ?? '005930', state = null, detail = null, stocks = new Map(), connected = false;
let side = 'buy', listMode = 'all', favorites = new Set(['005930', '000660', '035420', '005380', '105560']);
let frameRequested = false, lastRender = 0, needsPrice = true, toastTimer;
try {
  const saved = JSON.parse(localStorage.getItem('pulse.favorites.v1'));
  if (Array.isArray(saved)) favorites = new Set(saved.filter(code => STOCKS.some(s => s.code === code)));
} catch { /* Private mode and malformed local preferences do not prevent trading. */ }
const stockRows = new Map();
const visibleCodes = new Set(STOCKS.map(s => s.code));
for (const stock of STOCKS) {
  const row = document.createElement('div'); row.className = 'stock-row'; row.dataset.code = stock.code; row.dataset.testid = `stock-${stock.code}`;
  row.innerHTML = '<button class="star" data-action="favorite">☆</button><button class="stock-select" data-action="select"><span><span class="name"></span><small></small></span><span class="numbers"><span class="price">—</span><span class="change">—</span></span></button>';
  const name = row.querySelector('.name'); name.textContent = stock.name;
  name.title = stock.name; row.querySelector('small').textContent = stock.code;
  row.querySelector('.stock-select').setAttribute('aria-label', `${stock.name} ${stock.code} 선택`);
  stockRows.set(stock.code, { row, star: row.querySelector('.star'), price: row.querySelector('.price'), change: row.querySelector('.change') });
  refs['stock-list'].append(row);
}
const bookRows = [];
const bookGap = document.createElement('div');
bookGap.className = 'book-gap';
for (let i = 0; i < 20; i++) {
  if (i === 10) refs.orderbook.append(bookGap);
  const row = document.createElement('div'); row.className = `book-row ${i < 10 ? 'ask' : 'bid'}`;
  row.innerHTML = '<span></span><button type="button"></button><span></span><i class="depth-bar"></i>';
  refs.orderbook.append(row); bookRows.push({ row, quantity: row.children[i < 10 ? 0 : 2], button: row.children[1], bar: row.children[3] });
}
const tradeRows = Array.from({ length: 16 }, () => {
  const row = document.createElement('div'); row.className = 'trade-row'; row.innerHTML = '<span></span><span></span><span></span>'; refs.trades.append(row); return row;
});
const chartHistory = createCandleHistory(async (code, period, signal) => {
  const response = await fetch(`/api/candles?symbol=${code}&period=${period}`, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]), cache: 'no-store',
  });
  if (!response.ok) throw Error('Candle history unavailable');
  return response.json();
}, scheduleRender);
const paintChart = createCandleRenderer(refs);
const indexChart = { code: 'KPI100', name: 'KOSPI 100', unit: 0.01, format: indexNumber };
const indexDialog = refs['index-dialog'];
const stockChartMount = refs['shared-chart'].parentElement;
const chartNavigation = createChartNavigation(refs, drawChart);
const stockDialog = refs['stock-dialog'];
refs['open-stock-chart'].onclick = () => {
  if (!connected || !stocks.has(selected) || stockDialog.open) return;
  text(refs['stock-dialog-title'], stocks.get(selected).name + ' 차트');
  refs['chart-settings'].open = false;
  stockDialog.showModal();
  refs['stock-chart-mount'].append(refs['shared-chart']);
  updateSubmit();
};
refs['close-stock-chart'].onclick = () => stockDialog.close();
stockDialog.addEventListener('close', () => {
  stockChartMount.append(refs['shared-chart']);
  refs['open-stock-chart'].focus({preventScroll:true});
  updateSubmit();
});
function chartSubject() {
  return indexDialog.open ? indexChart : stocks.get(selected);
}
function switchChart() {
  refs['chart-settings'].open = false;
  if (connected) chartHistory.select(chartSubject().code, chartPeriod);
  else chartHistory.clear();
  if (chartSubject()) drawChart();
  updateSubmit();
}
refs['open-index-chart'].onclick = () => {
  if (!connected || !state?.index || indexDialog.open) return;
  refs['index-chart-mount'].append(refs['shared-chart']);
  indexDialog.showModal();
  switchChart();
};
refs['close-index-chart'].onclick = () => indexDialog.close();
indexDialog.addEventListener('close', () => {
  stockChartMount.append(refs['shared-chart']);
  switchChart();
});
let chartPeriod = '1m';
try {
  const saved = JSON.parse(localStorage.getItem('pulse.chart.v1')) || {};
  if (periods.has(saved.period)) chartPeriod = saved.period;
  if (['bars', 'line'].includes(saved.style)) refs['chart-style'].value = saved.style;
} catch {}
function updateChartControls() {
  for (const b of refs['chart-periods'].querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.period === chartPeriod));
  try { localStorage.setItem('pulse.chart.v1', JSON.stringify({ period: chartPeriod, style: refs['chart-style'].value })); } catch {}
  scheduleRender();
}
refs['chart-periods'].onclick = e => {
  const next = e.target.closest('button')?.dataset.period;
  if (!periods.has(next) || next === chartPeriod) return;
  chartPeriod = next;
  if (connected) chartHistory.select(chartSubject().code, next);
  updateChartControls();
};
refs['chart-style'].onchange = updateChartControls;
refs['retry-chart'].onclick = () => chartHistory.retry();
function toast(message) { clearTimeout(toastTimer); text(refs.toast, message); refs.toast.hidden = false; toastTimer = setTimeout(() => { refs.toast.hidden = true; }, 4200); }
const openOrders = new Map(), openRows = new Map(), cancelling = new Set();
function updateOpenOrders({reset,updates=[],removed=[]}) {
  if (reset) openOrders.clear();
  for (const id of removed) openOrders.delete(id);
  for (const order of reset ?? updates) {
    if (order.remaining && order.status !== 'cancelled') openOrders.set(order.id,order);
    else openOrders.delete(order.id);
  }
  renderOpenOrders();
}
function renderOpenOrders() {
  const list = refs['trade-open-list'];
  for (const [id,row] of openRows) if (!openOrders.has(id)) {
    row.remove();
    openRows.delete(id);
  }
  let next = list.firstChild;
  for (const order of [...openOrders.values()].sort((a,b)=>b.time-a.time || b.id.localeCompare(a.id))) {
    let row = openRows.get(order.id);
    if (!row) {
      row = document.createElement('li');
      row.innerHTML = '<strong></strong><small></small><button type="button">잔량 취소</button>';
      row.lastChild.dataset.cancel = order.id;
      openRows.set(order.id,row);
    }
    const [title,info,button] = row.children;
    const name = stocks.get(order.code)?.name ?? order.code;
    text(title,name+' '+(order.side==='buy'?'매수':'매도')+' · 잔량 '+fmt(order.remaining)+'주');
    text(info,order.id+' · '+fmt(order.limit)+'원 · '+(order.type==='market'?'시장가':'지정가'));
    button.setAttribute('aria-label',name+' '+order.id+' 잔량 취소');
    button.disabled = !connected || cancelling.has(order.id);
    if (row !== next) list.insertBefore(row,next);
    next = row.nextSibling;
  }
  refs['open-order-empty'].hidden = !!openOrders.size;
  text(refs['open-order-empty'], connected ? '미체결 주문이 없습니다.' : '서버 연결 대기 중입니다.');
}
refs['trade-open-list'].onclick = async event => {
  const id = event.target.closest('button')?.dataset.cancel;
  if (!connected || !openOrders.has(id) || cancelling.has(id)) return;
  cancelling.add(id);
  renderOpenOrders();
  try {
    const {status,data} = await orderRequest('/api/orders/'+id+'/cancel',{});
    if (status===200 && data.id===id && data.status==='cancelled') {
      updateOpenOrders({removed:[id]});
      toast(id+' 주문의 남은 '+fmt(data.remaining)+'주를 취소했습니다.');
    } else toast(data.error || '주문내역에서 취소 결과를 확인하세요.');
  } catch { toast('주문내역에서 취소 결과를 확인하세요.'); }
  finally { cancelling.delete(id); renderOpenOrders(); }
};
function connection(value) {
  connected = value; renderOpenOrders(); refs.connection.classList.toggle('offline', !value);
  refs['open-index-chart'].disabled = !value; refs['open-stock-chart'].disabled = !value;
  if (!value) {
    chartHistory.clear();
    if (indexDialog.open || stockDialog.open) drawChart();
  }
  document.querySelector('.center-column').setAttribute('aria-busy', String(!value));
  text(refs['connection-text'], value ? '시세 수신 중' : '서버 연결 끊김');
  text(refs['footer-status'], value ? '서버 시세 · 로컬 기록 중' : '시세 정지 · 서버에 다시 연결하는 중');
  updateSubmit();
}
const feed = createQuoteFeed({
  open: code => new EventSource(`/api/events?symbol=${encodeURIComponent(code)}`),
  status: connection,
  renderSnapshot(data) {
    state = data; stocks = new Map(data.stocks.map(s => [s.code, s])); detail = data.detail;
    updateOpenOrders({reset:data.orders});
    if (initialSellCode === selected) {
      initialSellCode = null;
      setSide('sell');
      refs['order-quantity'].value = Math.min(1000000, state.account.positions.find(p => p.code === selected)?.available ?? 0);
    }
    chartHistory.select(chartSubject().code, chartPeriod);
    filterList(); render();
    refs['order-form'].dataset.code = selected;
  },
  update: (event, data) => marketUpdates[event](data),
});
const marketUpdates = {
  tick(data) {
    if (!state || data.time < state.time) return;
    state.tick = data.tick; state.time = data.time; state.account = data.account;
    state.index = data.index;
    if (indexDialog.open) chartHistory.update(indexChart.code, data.indexCandles, data.time);
    for (const q of data.quotes) Object.assign(stocks.get(q.code), q);
    scheduleRender();
  },
  detail(data) {
    if (!detail || data.code !== selected) return;
    if (data.point.time < (detail.point?.time || 0)) return;
    if (!indexDialog.open) chartHistory.update(selected, data.candles, data.point.time);
    detail = data; scheduleRender();
  },
  orders: updateOpenOrders,
  account(account) { if (state) { state.account = account; scheduleRender(); } },
};
function scheduleRender() {
  if (frameRequested) return; frameRequested = true;
  const wait = Math.max(0, 100 - (performance.now() - lastRender));
  setTimeout(() => requestAnimationFrame(() => { frameRequested = false; lastRender = performance.now(); render(); }), wait);
}
function updateStars() {
  for (const s of STOCKS) {
    const r = stockRows.get(s.code), on = favorites.has(s.code);
    text(r.star, on ? '★' : '☆'); r.star.classList.toggle('on', on);
    r.star.setAttribute('aria-label', `${s.name} 관심종목 ${on ? '삭제' : '추가'}`); r.star.setAttribute('aria-pressed', String(on));
    r.row.classList.toggle('selected', s.code === selected);
  }
  text(refs['favorite-count'], favorites.size);
  const on = favorites.has(selected); text(refs['selected-favorite'], on ? '★' : '☆'); refs['selected-favorite'].classList.toggle('on', on);
  refs['selected-favorite'].setAttribute('aria-pressed', String(on)); refs['selected-favorite'].setAttribute('aria-label', `${STOCKS.find(s => s.code === selected).name} 관심종목 ${on ? '삭제' : '추가'}`);
}
function toggleFavorite(code) {
  favorites.has(code) ? favorites.delete(code) : favorites.add(code);
  updateStars(); filterList();
}
function filterList() {
  const query = refs.search.value.trim().toLocaleLowerCase().replaceAll(' ', ''); visibleCodes.clear();
  const invalidCode = /^\d[a-z\d]{5}$/.test(query) && /[a-z]/.test(query);
  let count = 0;
  for (const stock of STOCKS) {
    const show = !invalidCode && (listMode === 'all' || favorites.has(stock.code)) && `${stock.name}${stock.code}`.toLocaleLowerCase().replaceAll(' ', '').includes(query);
    stockRows.get(stock.code).row.hidden = !show;
    if (show) { count++; visibleCodes.add(stock.code); }
  }
  text(refs['result-count'], `${count}종목`); refs['empty-search'].hidden = count > 0;
  text(refs['empty-search'], listMode === 'favorites' && !favorites.size ? '별을 눌러 관심종목을 추가하세요.' : '검색 결과가 없습니다.');
  sortList(); scheduleRender();
}
function sortList() {
  const mode = refs.sort.value;
  const list = [...STOCKS].sort((a, b) => {
    const x = stocks.get(a.code), y = stocks.get(b.code);
    if (!x || !y) return a.rank - b.rank;
    if (mode === 'rank') return y.price * y.shares - x.price * x.shares || a.rank - b.rank;
    if (mode === 'volume') return y.volume - x.volume || a.rank - b.rank;
    const delta = (y.price / y.prev - x.price / x.prev) * (mode === 'down' ? -1 : 1);
    return delta || a.rank - b.rank;
  });
  const focused = document.activeElement;
  let next = refs['stock-list'].firstChild;
  for (const s of list) { const row = stockRows.get(s.code).row; if (row !== next) refs['stock-list'].insertBefore(row, next); next = row.nextSibling; }
  if (focused?.isConnected && focused !== document.activeElement) focused.focus({ preventScroll: true });
}
function select(code) {
  if (code === selected) return;
  initialSellCode = null;
  selected = code; detail = null; needsPrice = true; refs['order-error'].hidden = true;
  delete refs['order-form'].dataset.code;
  refs['order-price'].value = '';
  text(refs['order-estimate'], '—'); text(refs['order-available'], '—');
  text(refs['stock-name'], STOCKS.find(s => s.code === code).name); text(refs['stock-code'], code);
  updateStars(); feed.connect(code);
}
function render() {
  if (!state || detail?.code !== selected) return;
  const s = stocks.get(selected), change = s.price - s.prev;
  let up = 0, down = 0;
  for (const q of stocks.values()) {
    if (q.price > q.prev) up++; else if (q.price < q.prev) down++;
    if (!visibleCodes.has(q.code)) continue;
    const r = stockRows.get(q.code); text(r.price, fmt(q.price)); text(r.change, pct((q.price / q.prev - 1) * 100)); color(r.price, q.price - q.prev); color(r.change, q.price - q.prev);
  }
  text(refs.rising, up); text(refs.falling, down); text(refs.flat, 100 - up - down);
  if (state.index) {
    const index = state.index;
    const value = indexNumber.format(index.value);
    const movement = `${index.change > 0 ? '▲' : index.change < 0 ? '▼' : '−'} ${indexNumber.format(Math.abs(index.change))} (${pct(index.changeRate)})`;
    text(refs['index-value'], value); color(refs['index-value'], index.change);
    text(refs['index-change'], movement); color(refs['index-change'], index.change);
    if (indexDialog.open) {
      text(refs['dialog-index-value'], value); color(refs['dialog-index-value'], index.change);
      text(refs['dialog-index-change'], movement); color(refs['dialog-index-change'], index.change);
    }
  }
  sortList();
  text(refs['market-clock'], clock.format(state.time)); text(refs['tick-counter'], `TICK ${fmt(state.tick)} · ${state.interval}ms`);
  text(refs['stock-name'], s.name); text(refs['stock-code'], s.code); text(refs['stock-monogram'], s.name.startsWith('삼성') ? 'S' : s.name[0]);
  text(refs['current-price'], fmt(s.price)); color(refs['current-price'], change);
  text(refs['price-change'], `${change > 0 ? '▲' : change < 0 ? '▼' : '−'} ${fmt(Math.abs(change))} (${pct(change / s.prev * 100)})`); color(refs['price-change'], change);
  text(refs['upper-limit'], fmt(s.upperLimit));
  text(refs['lower-limit'], fmt(s.lowerLimit));
  const cap = s.price * s.shares;
  const billions = Math.round(cap / 1e8);
  text(refs['market-cap'], (billions >= 10000 ? fmt(Math.floor(billions / 10000)) + '조 ' : '') + fmt(billions % 10000) + '억원');
  refs['market-cap'].title = fmt(s.shares) + '주 × ' + fmt(s.price) + '원';
  refs['limit-badge'].hidden = s.price !== s.upperLimit && s.price !== s.lowerLimit;
  text(refs['limit-badge'], s.price === s.upperLimit ? '상한가' : '하한가');
  color(refs['limit-badge'], change);
  text(refs['previous-close'], fmt(s.prev)); text(refs['high-price'], fmt(s.high)); text(refs['low-price'], fmt(s.low)); text(refs.volume, `${fmt(s.volume)}주`);
  text(refs['total-equity'], `${fmt(state.account.equity)}원`); text(refs['available-cash'], `${fmt(state.account.available)}원`);
  text(refs['total-profit'], `${signed(state.account.profit)}원`); color(refs['total-profit'], state.account.profit);
  text(refs['reference-date'], state.reference.length > 10 ? `${date.format(new Date(state.reference))} ${clock.format(new Date(state.reference))}` : state.reference.replaceAll('-', '.'));
  refs['order-price'].min = s.lowerLimit; refs['order-price'].max = s.upperLimit;
  if (needsPrice) { refs['order-price'].value = s.price; refs['order-price'].step = 'any'; needsPrice = false; }
  renderDetail(); estimate();
}
function renderDetail() {
  if (!detail) return;
  const max = Math.max(1, ...detail.asks.map(l => l[1]), ...detail.bids.map(l => l[1]));
  for (let i = 0; i < 20; i++) {
    const r = bookRows[i], level = i < 10 ? detail.asks[9 - i] : detail.bids[i - 10];
    r.row.hidden = !level || level[1] === 0;
    if (r.row.hidden) continue;
    const currentPrice = level[0] === stocks.get(selected).price;
    r.row.classList.toggle('at-current', currentPrice);
    r.button.dataset.code = selected;
    text(r.quantity, fmt(level[1])); text(r.button, fmt(level[0])); r.button.dataset.price = level[0];
    r.button.setAttribute('aria-label', `${currentPrice ? '현재가 · ' : ''}${i < 10 ? '매도' : '매수'} 호가 ${fmt(level[0])}원 적용`);
    r.bar.style.width = `${level[1] / max * 32}%`;
  }
  const price = stocks.get(selected).price;
  const hasCurrent = [...detail.asks, ...detail.bids].some(([p, qty]) => p === price && qty > 0);
  bookGap.classList.toggle('current-marker', !hasCurrent);
  text(bookGap, hasCurrent ? '' : `${fmt(price)}원 · 잔량 0주`);
  text(refs['ask-total'], fmt(detail.asks.reduce((a, l) => a + l[1], 0))); text(refs['bid-total'], fmt(detail.bids.reduce((a, l) => a + l[1], 0)));
  for (let i = 0; i < tradeRows.length; i++) {
    const row = tradeRows[i], trade = detail.trades[i]; row.hidden = !trade; if (!trade) continue;
    text(row.children[0], clock.format(trade.time)); text(row.children[1], fmt(trade.price)); text(row.children[2], fmt(trade.quantity));
    color(row.children[1], trade.side === 'buy' ? 1 : -1); color(row.children[2], trade.side === 'buy' ? 1 : -1);
  }
  refs['empty-trades'].hidden = !!detail.trades.length; drawChart();
}
function drawChart() {
  const subject = chartSubject();
  if (!subject) return;
  const view = chartHistory.view;
  const { count, start } = chartNavigation.window(view);
  paintChart(view, chartHistory.revision, count, refs['chart-style'].value, subject, start, Math.min(count, 12));
}
function estimate() {
  const market = refs['order-type'].value === 'market';
  refs['limit-price-fields'].hidden = market;
  refs['estimate-row'].hidden = market;
  refs['market-fill-help'].hidden = !market;
  refs['order-price'].disabled = market; refs['order-price'].required = !market;
  if (!state || !detail) { updateSubmit(); return; }
  const s = stocks.get(selected), qty = Number(refs['order-quantity'].value);
  if (market) {
    const levels = side === 'buy' ? detail.asks : detail.bids;
    const filled = fillableQuantity(levels, qty);
    text(refs['market-fill-help'], `표시된 10단계 호가의 체결 가능 수량 ${fmt(filled)}주`);
  } else {
    text(refs['order-estimate'], `${fmt(Math.max(0, Number(refs['order-price'].value)))}원`);
  }
  text(refs['available-label'], side === 'buy' ? '매수 가능 금액' : '매도 가능 수량');
  text(refs['order-available'], side === 'buy' ? `${fmt(state.account.available)}원` : `${fmt(state.account.positions.find(p => p.code === selected)?.available || 0)}주`);
  text(refs['price-help'], `${fmt(s.unit)}원 단위 · 호가 클릭으로 가격 입력`);
  updateSubmit();
}
function formReady() {
  return !stockDialog.open && !indexDialog.open && connected && feed.ready(selected) && detail?.code === selected && refs['order-form'].dataset.code === selected;
}
function updateSubmit() {
  const ready = formReady(), market = refs['order-type'].value === 'market';
  refs['order-price'].disabled = !ready || market; refs['use-current'].disabled = !ready || market;
  const available = state?.account.positions.find(p => p.code === selected)?.available ?? 0;
  const canSell = side !== 'sell' || available > 0;
  refs['submit-order'].disabled = !ready || !entry || !!entry.pending || !canSell;
}
function setSide(value) {
  side = value; refs['buy-tab'].classList.toggle('selected', side === 'buy'); refs['sell-tab'].classList.toggle('selected', side === 'sell');
  refs['buy-tab'].setAttribute('aria-pressed', String(side === 'buy')); refs['sell-tab'].setAttribute('aria-pressed', String(side === 'sell'));
  refs['submit-order'].className = `submit ${side}`; text(refs['submit-order'], side === 'buy' ? '매수 주문' : '매도 주문'); refs['order-error'].hidden = true; estimate();
}
const statusNames = { open: '미체결', partial: '부분체결', filled: '체결완료', cancelled: '취소' };
async function orderRequest(url, payload) {
  const options = payload ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) } : {};
  const response = await fetch(url, { ...options, cache: 'no-store', signal: AbortSignal.timeout(12000) });
  return { status: response.status, data: await response.json() };
}
let entry, recoveryTimer, recoveryDelay = 1000;
function orderNotice(event, value) {
  if (event !== 'idle') clearTimeout(recoveryTimer);
  const accepted = event === 'accepted';
  if (accepted || event === 'rejected') {
    recoveryDelay = 1000;
    if (accepted) {
      toast(`${STOCKS.find(s => s.code === value.code).name} ${value.side === 'buy' ? '매수' : '매도'} ${fmt(value.quantity)}주 · ${statusNames[value.status]} (${fmt(value.filled)}주 체결)`);
    } else {
      text(refs['order-error'], value); refs['order-error'].hidden = false;
    }
  } else if (event === 'pending' || event === 'missing' || event === 'waiting') {
    const name = STOCKS.find(s => s.code === value.code)?.name || value.code;
    const terms = value.type === 'market' ? '시장가' : `지정가 ${fmt(value.price)}원`;
    text(refs['order-progress'], `${name} ${value.side === 'buy' ? '매수' : '매도'} ${fmt(value.quantity)}주 · ${terms} · ${event === 'missing' ? '접수 기록 없음' : '주문 결과 확인 중'}`);
    if (event === 'pending') {
      recoveryTimer = setTimeout(() => entry.check(), recoveryDelay);
      recoveryDelay = Math.min(10000, recoveryDelay * 2);
    }
  }
  refs['order-recovery'].hidden = !entry.pending;
  refs['check-order'].hidden = !entry.pending || entry.busy;
  refs['retry-order'].hidden = !entry.mayRetry || entry.busy;
  updateSubmit();
}
try {
  entry = createOrderEntry({
    storage: sessionStorage, uuid: () => crypto.randomUUID(), notify: orderNotice,
    send: payload => orderRequest('/api/orders', payload),
    lookup: id => orderRequest(`/api/orders/requests/${encodeURIComponent(id)}`),
  });
} catch {
  text(refs['order-error'], '이 탭의 주문 기록을 읽을 수 없습니다. 주문내역을 확인하세요.'); refs['order-error'].hidden = false;
}
refs['check-order'].onclick = () => entry?.check();
refs['retry-order'].onclick = () => entry?.retry();
function correctLimitPrice() {
  const field=refs['order-price'], stock=stocks.get(selected);
  if(!stock || refs['order-type'].value!=='limit' || !Number.isFinite(field.valueAsNumber))return;
  const corrected=Math.min(stock.upperLimit,Math.max(stock.lowerLimit,field.valueAsNumber));
  if(corrected!==field.valueAsNumber){field.value=String(corrected);estimate();}
}
refs['order-price'].addEventListener('change',correctLimitPrice);
refs['order-form'].addEventListener('submit', async event => {
  event.preventDefault();
  correctLimitPrice();
  if (!formReady() || refs['submit-order'].disabled || !refs['order-form'].reportValidity()) return;
  const payload = { code: selected, side, type: refs['order-type'].value, quantity: Number(refs['order-quantity'].value) };
  if (payload.type === 'limit') payload.price = Number(refs['order-price'].value);
  refs['order-error'].hidden = true;
  try {
    await entry.submit(payload);
  } catch {
    text(refs['order-error'], '이 탭에 요청 번호를 저장할 수 없어 주문을 보내지 않았습니다.'); refs['order-error'].hidden = false;
  }
});
refs['stock-list'].addEventListener('click', e => { const button = e.target.closest('button'); if (!button) return; const code = button.closest('[data-code]').dataset.code; button.dataset.action === 'favorite' ? toggleFavorite(code) : select(code); });
refs['selected-favorite'].onclick = () => toggleFavorite(selected);
refs.search.addEventListener('input', filterList); refs.sort.onchange = filterList;
for (const [id, mode] of [['all-tab', 'all'], ['favorites-tab', 'favorites']]) refs[id].onclick = () => {
  listMode = mode; refs['all-tab'].classList.toggle('selected', mode === 'all'); refs['favorites-tab'].classList.toggle('selected', mode === 'favorites');
  refs['all-tab'].setAttribute('aria-pressed', String(mode === 'all')); refs['favorites-tab'].setAttribute('aria-pressed', String(mode === 'favorites')); filterList();
};
refs['buy-tab'].onclick = () => setSide('buy'); refs['sell-tab'].onclick = () => setSide('sell');
refs['order-type'].onchange = estimate; refs['order-price'].oninput = estimate; refs['order-quantity'].oninput = estimate;
refs['use-current'].onclick = () => { if (formReady()) { refs['order-price'].value = stocks.get(selected).price; estimate(); } };
document.querySelectorAll('[data-quantity]').forEach(b => { b.onclick = () => { refs['order-quantity'].value = b.dataset.quantity; estimate(); }; });
refs['max-quantity'].onclick = () => {
  if (!formReady()) return;
  const market = refs['order-type'].value === 'market', price = market ? stocks.get(selected)?.upperLimit : Number(refs['order-price'].value);
  const quantity = side === 'buy' ? Math.floor(state.account.available / (price || Infinity)) : state.account.positions.find(p => p.code === selected)?.available ?? 0;
  refs['order-quantity'].value = Math.max(0, Math.min(1000000, quantity)); estimate();
};
refs.orderbook.onclick = e => { const b = e.target.closest('button[data-price]'); if (!formReady() || b?.dataset.code !== selected || b.parentElement.hidden) return; refs['order-type'].value = 'limit'; refs['order-price'].value = b.dataset.price; estimate(); };
refs['source-button'].onclick = () => refs['data-dialog'].showModal(); refs['close-dialog'].onclick = () => refs['data-dialog'].close();
refs['data-dialog'].onclick = e => { if (e.target === refs['data-dialog'] && (e.offsetX < 0 || e.offsetY < 0 || e.offsetX > e.target.clientWidth || e.offsetY > e.target.clientHeight)) refs['data-dialog'].close(); };
document.addEventListener('keydown', e => { if (e.key === '/' && !['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName) && !refs['data-dialog'].open && !indexDialog.open && !stockDialog.open) { e.preventDefault(); refs.search.focus(); } });
window.addEventListener('storage', e => { if (e.key === 'pulse.favorites.v1') { try { const saved = JSON.parse(e.newValue); if (Array.isArray(saved)) { favorites = new Set(saved.filter(code => stockRows.has(code))); updateStars(); filterList(); } } catch {} } });
document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleRender(); });
updateChartControls(); updateStars(); feed.connect(selected);
if (entry?.pending) entry.check();
