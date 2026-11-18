import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function tempData(name) {
  const parent = path.join(root, '.test-runs'); await mkdir(parent, { recursive: true });
  return mkdtemp(path.join(parent, name + '-'));
}
export async function launch({ port, dataDir, interval = 1000, seed = 12345, env = {} }) {
  const child = fork(path.join(root, 'server.mjs'), ['--port', String(port), '--data-dir', dataDir, '--tick-ms', String(interval), '--seed', String(seed)], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true, env: { ...process.env, ...env } });
  let output = ''; child.stdout.on('data', d => { output += d; }); child.stderr.on('data', d => { output += d; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(Error(`Server startup timed out: ${output}`)); }, 10000);
    child.once('message', message => { if (message.type === 'ready') { clearTimeout(timer); resolve(); } });
    child.once('exit', code => { clearTimeout(timer); reject(Error(`Server exited ${code}: ${output}`)); });
  });
  return { child, url: `http://127.0.0.1:${port}`, output: () => output };
}
export async function stop(server) {
  if (server.child.exitCode !== null || server.child.signalCode !== null) return;
  const ended = once(server.child, 'exit'); server.child.send('shutdown');
  const timer = setTimeout(() => server.child.kill(), 8000);
  const [code, signal] = await ended; clearTimeout(timer);
  if (code !== 0 || signal) throw Error(`Shutdown failed: ${code}/${signal} ${server.output()}`);
}
export async function get(server, route = '/api/state') {
  const res = await fetch(server.url + route, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw Error(`GET ${route}: ${res.status} ${await res.text()}`); return res.json();
}
export async function post(server, route, data) {
  const res = await fetch(server.url + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data), signal: AbortSignal.timeout(10000) });
  return { status: res.status, data: await res.json() };
}
