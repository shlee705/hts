// An order form is ready only after the matching snapshot was painted to the DOM.
export function createQuoteFeed({ open, renderSnapshot, update, status, later = setTimeout, cancel = clearTimeout }) {
  let source;
  let retryTimer;
  let retryDelay = 500;
  let readyCode = null;

  function connect(code) {
    cancel(retryTimer);
    source?.close();
    readyCode = null;
    status(false);
    const current = open(code);
    source = current;
    const listen = (event, handler) => current.addEventListener(event, message => {
      if (current !== source) return;
      try { handler(JSON.parse(message.data)); }
      catch (error) { console.error('Invalid market update', error); }
    });
    listen('state', snapshot => {
      if (snapshot.detail?.code !== code) return;
      readyCode = null;
      renderSnapshot(snapshot);
      readyCode = code;
      retryDelay = 500;
      status(true);
    });
    for (const event of ['tick', 'detail', 'orders', 'account']) {
      listen(event, data => { if (readyCode === code) update(event, data); });
    }
    const disconnect = () => {
      if (source !== current) return;
      readyCode = null;
      status(false);
    };
    listen('closing', disconnect);
    current.onerror = () => {
      if (source !== current) return;
      disconnect();
      if (current.readyState !== 2) return; // CONNECTING retries are managed by EventSource.
      cancel(retryTimer);
      retryTimer = later(() => { if (source === current) connect(code); }, retryDelay);
      retryDelay = Math.min(10000, retryDelay * 2);
    };
  }
  return { connect, ready: code => readyCode === code };
}

export function fillableQuantity(levels, requested) {
  if (!Number.isSafeInteger(requested) || requested < 1) return 0;
  return Math.min(requested, levels.reduce((total, [, available]) => total + available, 0));
}

const intentKey = 'pulse.pending-order.v1';

// One unresolved intent per tab. Persist before sending; never create a new ID on recovery.
export function createOrderEntry({ storage, send, lookup, uuid, notify }) {
  let pending = storage.getItem(intentKey);
  if (pending) pending = JSON.parse(pending);
  let busy = false, mayRetry = false;
  function finish(event, value) {
    storage.removeItem(intentKey);
    pending = null;
    mayRetry = false;
    notify(event, value);
  }
  async function run(action) {
    if (!pending || busy) return;
    busy = true;
    mayRetry = false;
    notify('waiting', pending);
    try {
      const { status, data } = action === 'lookup' ? await lookup(pending.requestId) : await send(pending);
      if (status === 200 && data.requestId === pending.requestId && data.id) {
        const matches = data.code === pending.code && data.side === pending.side && data.type === pending.type
          && data.quantity === pending.quantity && (pending.type !== 'limit' || data.limit === pending.price);
        if (matches) finish('accepted', data);
        else finish('rejected', '이 요청 번호에는 다른 주문이 기록되어 있습니다. 주문내역을 확인하세요.');
      }
      else if (action === 'lookup' && status === 404) { mayRetry = true; notify('missing', pending); }
      else if (action === 'lookup' && status === 422 && data.requestId === pending.requestId) finish('rejected', data.error);
      else if (action === 'send' && status >= 400 && status < 500) finish('rejected', data.error || '주문을 접수하지 못했습니다.');
      else notify('pending', pending);
    } catch { notify('pending', pending); }
    finally { busy = false; notify('idle'); }
  }
  return {
    get pending() { return pending; },
    get busy() { return busy; },
    get mayRetry() { return mayRetry; },
    async submit(order) {
      if (pending || busy) return;
      const payload = { ...order, requestId: uuid() };
      storage.setItem(intentKey, JSON.stringify(payload));
      pending = payload;
      await run('send');
    },
    check: () => run('lookup'),
    retry: () => { if (mayRetry) return run('send'); },
  };
}
