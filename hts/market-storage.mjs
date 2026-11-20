import path from 'node:path';
import {cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile} from 'node:fs/promises';
import {STOCKS} from './public/market-data.mjs';
import {validateAccount, validStoredOrder} from './checkpoint.mjs';

const selected = new Set(STOCKS.map(stock => stock.code));

async function exists(file) {
  try { await stat(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function compatibleReceipts(dir, oldCodes) {
  for (const entry of await readdir(dir, {withFileTypes: true})) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!await compatibleReceipts(file, oldCodes)) return false;
    } else if (entry.name.endsWith('.json')) {
      const receipt = JSON.parse(await readFile(file, 'utf8'));
      const terms = receipt.order ?? receipt.rejected;
      if (receipt.version !== 1 || !terms?.code ||
          (receipt.order ? !validStoredOrder(terms, oldCodes) : typeof receipt.error !== 'string')) {
        throw Error('저장된 주문 접수 기록이 올바르지 않습니다.');
      }
      if (receipt.order && !selected.has(terms.code)) return false;
    }
  }
  return true;
}

// The caller holds the writer lock shared with the previous service. Publish
// the opening account and its receipts together before starting the new market.
export async function prepareMarketDirectory(root) {
  const dir = path.join(root, 'kospi10');
  if (await exists(dir)) return dir;
  const oldState = path.join(root, 'market-state.json');
  if (!await exists(oldState)) {
    await mkdir(dir);
    return dir;
  }
  const previous = JSON.parse(await readFile(oldState, 'utf8'));
  const oldCodes = new Set(Object.keys(previous.prices ?? {}));
  if (previous.version !== 1 || !oldCodes.size) throw Error('저장된 시세 파일이 올바르지 않습니다.');
  validateAccount(previous.account, oldCodes);
  const temp = await mkdtemp(path.join(root, '.kospi10-'));
  try {
    const {holdings, orders} = previous.account;
    const receipts = path.join(root, 'order-receipts');
    const hasReceipts = await exists(receipts);
    if ([...holdings, ...orders].every(row => selected.has(row.code)) &&
        (!hasReceipts || await compatibleReceipts(receipts, oldCodes))) {
      await writeFile(path.join(temp, 'opening-account.json'), JSON.stringify(previous.account));
      if (hasReceipts) await cp(receipts, path.join(temp, 'order-receipts'), {recursive: true});
    }
    await rename(temp, dir);
  } catch (error) {
    await rm(temp, {recursive: true, force: true});
    throw error;
  }
  return dir;
}
