import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validStoredOrder } from './checkpoint.mjs';

// The live checkpoint contains the latest 500 orders. Keep terminal receipts
// separately so quotes never serialize the entire lifetime of the account.
export class OrderArchive {
  constructor(dataDir, retryFile) {
    this.directory = path.join(dataDir, 'order-receipts');
    this.retryFile = retryFile;
  }
  file(requestId) {
    const hash = createHash('sha256').update(requestId).digest('hex');
    return path.join(this.directory, hash.slice(0, 2), hash.slice(2) + '.json');
  }
  async read(requestId) {
    let data;
    try { data = await this.retryFile(() => readFile(this.file(requestId), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    let receipt;
    try { receipt = JSON.parse(data); } catch { /* Report an invalid receipt below. */ }
    const terms = receipt?.order ?? receipt?.rejected;
    if (receipt?.version !== 1 || terms?.requestId !== requestId ||
        !(receipt.order ? validStoredOrder(receipt.order) && ['filled', 'cancelled'].includes(receipt.order.status) : typeof receipt.error === 'string')) {
      throw Object.assign(new Error('저장된 주문 결과를 확인할 수 없습니다.'), { code: 'EBADRECEIPT' });
    }
    return receipt;
  }
  async save(requestId, receipt) {
    const file = this.file(requestId);
    await mkdir(path.dirname(file), { recursive: true });
    await this.retryFile(() => writeFile(file + '.tmp', JSON.stringify({ version: 1, ...receipt })));
    await this.retryFile(() => rename(file + '.tmp', file));
  }
}
