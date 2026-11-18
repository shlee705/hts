// Only loaded by the deadline integration test, in its isolated child server.
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { isMainThread } from 'node:worker_threads';
import { setTimeout as delay } from 'node:timers/promises';

if (!isMainThread) {
  const write = fs.writeFile;
  fs.writeFile = async (file, data, ...options) => {
    if (String(file).endsWith('market-state.json.tmp') && typeof data === 'string' &&
        data.includes('"requestId":"reconcile-order-123"')) {
      fs.writeFile = write;
      syncBuiltinESMExports();
      await delay(350);
    }
    return write(file, data, ...options);
  };
  syncBuiltinESMExports();
}
