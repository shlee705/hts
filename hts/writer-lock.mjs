import { createHash, randomUUID } from 'node:crypto';
import { link, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';

const busy = () => Error('이 데이터 폴더를 사용하는 서버가 이미 실행 중이거나 잠금 주소가 사용 중입니다. 다른 --data-dir를 사용하세요.');

function endpoint(directory) {
  const key = process.platform === 'win32' ? directory.toLowerCase() : directory;
  const digest = createHash('sha256').update(key).digest('hex');
  if (process.platform === 'win32') return { path: '\\\\.\\pipe\\pulse-hts-' + digest };
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (process.platform === 'linux' && (major > 20 || major === 20 && minor >= 8)) {
    return { path: '\0pulse-hts-' + digest };
  }
  // Platforms without abstract sockets use a deterministic loopback port.
  // A port collision refuses startup instead of allowing concurrent writes.
  return { host: '127.0.0.1', port: 20000 + parseInt(digest.slice(0, 8), 16) % 20000, exclusive: true };
}

export async function acquireWriterLock(directory) {
  const address = endpoint(await realpath(directory));
  const guard = createServer(socket => socket.destroy());
  await new Promise((resolve, reject) => {
    guard.once('error', error => reject(error.code === 'EADDRINUSE' ? busy() : error));
    guard.listen(address, resolve);
  });
  const releaseGuard = () => new Promise(resolve => guard.close(resolve));
  const pidFile = path.join(directory, 'server.lock');
  const candidate = path.join(directory, `.server-lock-${randomUUID()}.tmp`);
  try {
    await writeFile(candidate, `pulse-ipc-v1 ${process.pid}\n`, { flag: 'wx' });
    try {
      try { await link(candidate, pidFile); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const owner = (await readFile(pidFile, 'utf8')).trim();
        if (!/^pulse-ipc-v1 [1-9]\d*$/.test(owner)) {
          // Preserve compatibility with a running PID-only server.
          if (!/^[1-9]\d*$/.test(owner) || !Number.isSafeInteger(Number(owner))) throw busy();
          let oldWriterAlive = true;
          try { process.kill(Number(owner), 0); }
          catch (probe) {
            if (probe.code !== 'ESRCH') throw probe;
            oldWriterAlive = false;
          }
          if (oldWriterAlive) throw busy();
        }
        // The OS guard automatically excludes every other recovery process.
        await rename(candidate, pidFile);
      }
    } finally {
      await unlink(candidate).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  } catch (error) {
    await releaseGuard();
    throw error;
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try { await unlink(pidFile); }
    finally { await releaseGuard(); }
  };
}
