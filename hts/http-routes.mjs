const apiMethods = new Map([
  ['/api/health', ['GET', 'HEAD']], ['/api/state', ['GET']], ['/api/events', ['GET']],
  ['/api/orders', ['POST']], ['/api/cash', ['GET', 'POST']], ['/api/candles', ['GET']],
]);
export function allowedMethods(pathname, files) {
  if (files.has(pathname)) return ['GET', 'HEAD'];
  if (/^\/api\/orders\/P\d+\/cancel$/.test(pathname)) return ['POST'];
  if (/^\/api\/orders\/requests\/[a-zA-Z0-9-]{8,80}$/.test(pathname)) return ['GET'];
  return apiMethods.get(pathname);
}
export function isLocalHost(host, port) {
  const match = /^(localhost|127\.0\.0\.1)(?::(\d+))?$/i.exec(host ?? '');
  return !!match && Number(match[2] ?? 80) === port;
}
export function bufferEvent(queue, event, payload) {
  // Delete/reinsert to flush each surviving kind in order of its latest update.
  let replaced = Number(queue.delete(event));
  if (event === 'tick') replaced += Number(queue.delete('account')); // tick includes the full account
  queue.set(event, payload);
  return replaced;
}
