import { cp, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { STOCKS } from './public/market-data.mjs';
import { validateCheckpoint } from './checkpoint.mjs';
import { acquireWriterLock } from './writer-lock.mjs';

async function readCheckpoint(dir) {
  try { return JSON.parse(await readFile(path.join(dir, 'market-state.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
}

export async function openMarketStorage(root) {
  await mkdir(root, { recursive: true });
  const unlockRoot = await acquireWriterLock(root);
  let unlockChild;
  const release = async () => {
    try { if (unlockChild) await unlockChild(); }
    finally { await unlockRoot(); }
  };
  try {
    const original = await readCheckpoint(root);
    const child = path.join(root, 'kospi10');
    const oldCodes = Object.keys(original?.prices ?? {});
    const formerMarket = oldCodes.length === 100 && original.index?.constituents === 100;
    // A ten-stock install uses the requested path directly. When upgrading, fork
    // both the account and all market history away from the original installation.
    if (!formerMarket && (original || !await readCheckpoint(child))) {
      if (original) validateCheckpoint(original);
      return { dir: root, previous: original, release };
    }
    await mkdir(child, { recursive: true });
    unlockChild = await acquireWriterLock(child);
    const previous = await readCheckpoint(child);
    if (previous) {
      validateCheckpoint(previous);
      return { dir: child, previous, release };
    }
    validateCheckpoint(original, new Set(oldCodes));
    const members = new Set(STOCKS.map(stock => stock.code));
    const account = original.account;
    const compatible = [...account.holdings, ...account.orders].every(row => members.has(row.code));
    if (compatible) {
      try { await cp(path.join(root, 'order-receipts'), path.join(child, 'order-receipts'), { recursive: true }); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const migration = compatible ? '기존 계좌와 주문을 복사했습니다.' : '제외된 종목의 보유·주문이 있어 별도 모의 계좌로 시작합니다.';
    return { dir: child, previous: null, account: compatible ? account : undefined, migration, release };
  } catch (error) {
    await release();
    throw error;
  }
}
