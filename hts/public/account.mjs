import { createQuoteFeed } from './order-entry.mjs';
const refs = Object.fromEntries([...document.querySelectorAll('[id]')].map(node => [node.id, node]));
const num = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 0 });
const clock = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const fmt = n => num.format(n || 0), pct = n => `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;
const signed = n => `${n > 0 ? '+' : n < 0 ? '−' : ''}${fmt(Math.abs(n))}`;
const tone = n => n > 0 ? 'up' : n < 0 ? 'down' : 'neutral';
function text(el, value) { if (el.textContent !== String(value)) el.textContent = value; }
function color(el, value) { el.classList.remove('up', 'down', 'neutral'); el.classList.add(tone(value)); }
let state, connected = false, accountMode = 'positions', ordersDirty = true, frame = 0, toastTimer;
const stocks = new Map(), positionRows = new Map(), orderRows = new Map(), cancelling = new Set();
function toast(message) { clearTimeout(toastTimer); text(refs.toast, message); refs.toast.hidden = false; toastTimer = setTimeout(() => { refs.toast.hidden = true; }, 4200); }
function cellRow(cache, key, body, columns) {
  if (cache.has(key)) return cache.get(key);
  const row = document.createElement('tr'); for (let i = 0; i < columns; i++) row.append(document.createElement('td'));
  cache.set(key, row); body.append(row); return row;
}
const statusNames = { open: '미체결', partial: '부분체결', filled: '체결완료', cancelled: '취소' };
function renderAccount() {
  const positions = state.account.positions, orders = state.orders || [], open = orders.filter(o => o.remaining && o.status !== 'cancelled');
  text(refs['position-count'], positions.length); text(refs['order-count'], orders.length); text(refs['open-count'], open.length);
  refs['positions-table'].hidden = accountMode !== 'positions'; refs['orders-table'].hidden = accountMode === 'positions';
  const list = accountMode === 'positions' ? positions : accountMode === 'open' ? open : orders;
  refs['account-empty'].hidden = list.length > 0;
  text(refs['account-empty'].querySelector('strong'), accountMode === 'positions' ? '아직 보유한 종목이 없습니다' : accountMode === 'open' ? '미체결 주문이 없습니다' : '아직 주문내역이 없습니다');
  refs['account-empty'].querySelector('p').hidden = accountMode !== 'positions';
  if (accountMode === 'positions') {
    const keys = new Set(positions.map(p => p.code));
    for (const [key, row] of positionRows) if (!keys.has(key)) { row.remove(); positionRows.delete(key); }
    for (const p of positions) {
      const row = cellRow(positionRows, p.code, refs['positions-body'], 8), cells = row.children;
      if (!cells[0].children.length) {
        cells[0].innerHTML = '<a class="name-button name"></a><small></small>';
        cells[0].firstChild.href = '/';
        cells[7].innerHTML = '<button>매도</button>'; cells[7].firstChild.dataset.sell = p.code;
      }
      text(cells[0].firstChild, stocks.get(p.code).name); text(cells[0].lastChild, p.code);
      cells[7].firstChild.disabled = !connected || p.available === 0;
      [null, `${fmt(p.quantity)} / ${fmt(p.available)}`, fmt(p.average), fmt(p.price), fmt(p.value), signed(p.profit), pct((p.price / p.average - 1) * 100)].forEach((value, i) => { if (i) text(cells[i], value); });
      color(cells[5], p.profit); color(cells[6], p.profit);
    }
  } else if (ordersDirty) {
    const keys = new Set(orders.map(o => o.id));
    for (const [key, row] of orderRows) if (!keys.has(key)) { row.remove(); orderRows.delete(key); }
    for (const order of orders) {
      const row = cellRow(orderRows, order.id, refs['orders-body'], 8), c = row.children;
      row.hidden = accountMode === 'open' && (!order.remaining || order.status === 'cancelled');
      if (!c[0].children.length) { c[0].innerHTML = '<span></span><small></small>'; c[6].innerHTML = '<span class="status-chip"></span>'; c[7].innerHTML = '<button>취소</button>'; c[7].firstChild.dataset.cancel = order.id; }
      text(c[0].firstChild, order.id); text(c[0].lastChild, clock.format(order.time)); text(c[1], stocks.get(order.code).name);
      text(c[2], `${order.side === 'buy' ? '매수' : '매도'} · ${order.type === 'market' ? '시장가' : '지정가'}`); color(c[2], order.side === 'buy' ? 1 : -1);
      text(c[3], order.type === 'market' && !(order.remaining && order.status !== 'cancelled') ? '시장가' : fmt(order.limit)); text(c[4], `${fmt(order.quantity)} / ${fmt(order.filled)}`); text(c[5], order.filled ? fmt(order.average) : '—');
      text(c[6].firstChild, statusNames[order.status]); c[6].firstChild.className = `status-chip ${order.status}`;
      c[7].firstChild.disabled = !connected || cancelling.has(order.id);
      c[7].firstChild.hidden = !order.remaining || order.status === 'cancelled';
    }
    // Insert only newly arrived rows at their chronological position; existing buttons retain focus.
    let next = refs['orders-body'].firstChild;
    for (const o of orders) { const row = orderRows.get(o.id); if (row !== next) refs['orders-body'].insertBefore(row, next); next = row.nextSibling; }
    ordersDirty = false;
  }
}
async function orderRequest(url, payload) {
  const options = payload ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) } : {};
  const response = await fetch(url, { ...options, cache: 'no-store', signal: AbortSignal.timeout(12000) });
  return { status: response.status, data: await response.json() };
}
function setAccountMode(mode) {
  accountMode = mode; ordersDirty = true;
  for (const [id, value] of [['positions-tab', 'positions'], ['orders-tab', 'orders'], ['open-orders-tab', 'open']]) { refs[id].classList.toggle('selected', value === mode); refs[id].setAttribute('aria-pressed', String(value === mode)); }
  if (state) renderAccount();
}

function paint() {
  if (!state) return;
  const a = state.account;
  text(refs['account-equity'], fmt(a.equity) + '원');
  text(refs['account-cash'], fmt(a.cash) + '원');
  text(refs['account-available'], fmt(a.available) + '원');
  text(refs['account-profit'], signed(a.profit) + '원');
  color(refs['account-profit'], a.profit);
  renderAccount();
}
function schedule() {
  if (!frame) frame = requestAnimationFrame(() => { frame = 0; paint(); });
}
const feed = createQuoteFeed({
  open: code => new EventSource('/api/events?symbol=' + code),
  status(live) {
    connected = live; ordersDirty = true;
    refs.connection.classList.toggle('offline', !live);
    text(refs['connection-text'], live ? '계좌 수신 중' : '계좌 연결 중');
    paint();
  },
  renderSnapshot(data) {
    state = data;
    for (const s of data.stocks) stocks.set(s.code, s);
    ordersDirty = true; paint();
  },
  update(event, data) {
    if (event === 'tick' || event === 'account') {
      state.account = event === 'tick' ? data.account : data;
    } else if (event === 'orders') {
      if (data.reset) state.orders = data.reset;
      else {
        const map = new Map(state.orders.map(o => [o.id, o]));
        for (const key of data.removed) map.delete(key);
        for (const o of data.updates) map.set(o.id, o);
        state.orders = [...map.values()].sort((a, b) => Number(b.id.slice(1)) - Number(a.id.slice(1)));
      }
      ordersDirty = true;
    } else return;
    schedule();
  },
});
const tabs = new Set(['orders', 'open', 'positions']);
function readTab() {
  const tab = new URL(location.href).searchParams.get('tab');
  setAccountMode(tabs.has(tab) ? tab : 'positions');
}
for (const [id, tab] of [['positions-tab','positions'], ['orders-tab','orders'], ['open-orders-tab','open']]) {
  refs[id].onclick = () => {
    if (accountMode === tab) return;
    const url = new URL(location.href);
    if (tab === 'positions') url.searchParams.delete('tab'); else url.searchParams.set('tab', tab);
    history.pushState(null, '', url); setAccountMode(tab);
  };
}
refs['account-panel'].addEventListener('click', async event => {
  const b = event.target.closest('button');
  if (!b || b.disabled) return;
  if (b.dataset.sell && connected && state.account.positions.some(p => p.code === b.dataset.sell && p.available > 0)) {
    location.assign('/?symbol=' + encodeURIComponent(b.dataset.sell) + '&side=sell');
  }
  if (b.dataset.cancel && connected) {
    cancelling.add(b.dataset.cancel); b.disabled = true;
    try { const {status,data} = await orderRequest(`/api/orders/${b.dataset.cancel}/cancel`, {}); toast(status === 200 ? `${b.dataset.cancel} 주문이 취소되었습니다.` : data.error || '주문내역에서 취소 결과를 확인하세요.'); }
    catch { toast('주문내역에서 취소 결과를 확인하세요.'); }
    finally { cancelling.delete(b.dataset.cancel); ordersDirty = true; paint(); }
  }
});
readTab(); feed.connect('005930');
