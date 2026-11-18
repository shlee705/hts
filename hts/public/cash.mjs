const el = id => document.getElementById(id);
const won = new Intl.NumberFormat('ko-KR');
const key = 'pulse.cash.pending.v1';
let current, pending, busy = false, reading = false, generation = 0;
try { pending = JSON.parse(sessionStorage.getItem(key)); } catch { pending = null; }

function updateControls() {
  el('apply').disabled = !current || !!pending || busy;
  el('direction').disabled = !!pending || busy;
  el('amount').disabled = !!pending || busy;
  el('cash-retry').hidden = !pending;
  el('cash-retry').disabled = busy;
  el('apply').textContent = el('direction').value === 'deposit' ? '충전 요청' : '인출 요청';
}
function showBalance(data) {
  current = data;
  el('balance').textContent = won.format(data.cash) + '원';
  el('available').textContent = won.format(data.available) + '원';
}
function clearPending() {
  pending = null;
  try { sessionStorage.removeItem(key); } catch {}
}
async function readBalance() {
  const response = await fetch('/api/cash', { cache:'no-store', signal:AbortSignal.timeout(10000) });
  if (!response.ok) throw Error('서버 잔액을 조회하지 못했습니다.');
  return response.json();
}
async function refresh() {
  if (busy || reading) return;
  reading = true;
  const started = generation;
  try {
    const balance = await readBalance();
    if (started !== generation) return;
    showBalance(balance);
    if (pending) {
      if (balance.lastOperation?.requestId === pending.requestId) {
        clearPending(); el('cash-message').textContent = '이전 요청의 서버 반영을 확인했습니다.';
      } else if (balance.revision !== pending.revision) {
        clearPending(); el('cash-message').textContent = '그 사이 다른 입출금이 반영되었습니다. 최신 잔액을 확인하세요.';
      } else {
        el('cash-message').textContent = '이전 요청의 확인이 필요합니다. 같은 요청 번호로 결과를 확인하세요.';
      }
    } else if (el('cash-message').textContent === '서버 잔액 조회 중') el('cash-message').textContent = '';
  } catch (error) {
    if (started !== generation) return;
    current = null;
    el('cash-message').textContent = error.message;
  } finally { reading = false; updateControls(); }
}
async function submitPending() {
  if (busy || !pending) return;
  generation++;
  busy = true; updateControls();
  el('cash-message').textContent = '서버 확인 중';
  try {
    const res = await fetch('/api/cash', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(pending), signal:AbortSignal.timeout(12000) });
    const data = await res.json();
    if (!res.ok || data.ok !== true) {
      if (res.status === 400 || res.status === 409) {
        clearPending();
        current = null;
        showBalance(await readBalance());
      }
      throw Error(data.error || '처리 결과를 다시 확인하세요.');
    }
    showBalance(data);
    el('cash-message').textContent = won.format(pending.amount) + '원 ' + (pending.direction === 'deposit' ? '충전' : '인출') + '을 서버에 저장했습니다.';
    clearPending(); el('amount').value = '';
  } catch (error) {
    el('cash-message').textContent = pending ? '서버 확인 전입니다. 같은 요청 번호로 결과를 확인하세요.' : error.message;
  } finally { busy = false; updateControls(); }
}
el('cash-form').onsubmit = event => {
  event.preventDefault();
  if (busy || pending || !current) return;
  const amount = Number(el('amount').value);
  if (!Number.isSafeInteger(amount) || amount < 1) { el('cash-message').textContent = '1원 이상의 정수 금액을 입력하세요.'; return; }
  const op = { direction:el('direction').value, amount, revision:current.revision, requestId:crypto.randomUUID() };
  try { sessionStorage.setItem(key, JSON.stringify(op)); }
  catch { el('cash-message').textContent = '요청 번호를 보관할 수 없습니다. 브라우저 저장소 사용을 허용하세요.'; return; }
  pending = op;
  void submitPending();
};
el('cash-retry').onclick = submitPending;
el('direction').onchange = updateControls;
void refresh();
setInterval(() => { if (!document.hidden) void refresh(); }, 5000);
