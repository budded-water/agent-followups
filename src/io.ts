import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, rename, link, lstat, realpath, open, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, relative, isAbsolute, dirname, join, sep } from 'node:path';
import { Config, type Settings } from './contracts.js';

export const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export async function privateDir(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077)))
    throw new Error(`Private state directory must be a real directory with mode 0700: ${path}`);
}
export async function atomicJson(path: string, value: unknown) {
  await privateDir(dirname(path));
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temp, path);
  } finally { await rm(temp, { force: true }); }
}
export async function createJson(path: string, value: unknown) {
  await privateDir(dirname(path));
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    try { await link(temp, path); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
  } finally { await rm(temp, { force: true }); }
}
export async function readJson(path: string) {
  const file = await open(path, 'r');
  try {
    if ((await file.stat()).size > 2 * 1024 * 1024) throw new Error('JSON file exceeded limit');
    return JSON.parse(await file.readFile('utf8')) as unknown;
  } finally { await file.close(); }
}
export async function exists(path: string) {
  try { await lstat(path); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; }
}
const outside = (rel: string) => rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
export async function loadConfig(path: string): Promise<Settings> {
  const c = Config.parse(await readJson(path));
  c.projects = await Promise.all(c.projects.map(async p => ({ ...p, root: await realpath(p.root) })));
  if (new Set(c.projects.map(p => p.root)).size !== c.projects.length) throw new Error('Duplicate project roots');
  await privateDir(c.stateDir);
  c.stateDir = await realpath(c.stateDir);
  for (const p of c.projects) {
    const rel = relative(p.root, resolve(c.stateDir));
    if (!outside(rel)) throw new Error('State must live outside tracked project roots');
  }
  return c;
}
export async function projectAt(c: Settings, cwd: string) {
  const actual = await realpath(cwd);
  return c.projects.filter(p => {
    const rel = relative(p.root, actual);
    return !outside(rel);
  }).sort((a, b) => b.root.length - a.root.length)[0];
}
export async function withLock<T>(c: Settings, fn: () => Promise<T>): Promise<T> {
  const path = join(c.stateDir, 'operation.lock');
  const file = await open(path, 'wx', 0o600).catch(e => {
    if (e.code === 'EEXIST') throw new Error('Another operation owns the state lock. After a crash, verify all workers stopped before removing operation.lock.');
    throw e;
  });
  try { await file.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() })); return await fn(); }
  finally { await file.close(); await rm(path); }
}
export type Command = (binary: string, args: string[], options: { cwd: string; input?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; signal?: AbortSignal }) => Promise<string>;
export const command: Command = (binary, args, options) => new Promise((done, fail) => {
  if (options.signal?.aborted) { fail(new Error('Command aborted before startup')); return; }
  const child = spawn(binary, args, { cwd: options.cwd, env: options.env ?? process.env, shell: false,
    detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
  const output: Buffer[] = [];
  let bytes = 0, failure: Error | undefined, force: NodeJS.Timeout | undefined;
  const kill = (signal: NodeJS.Signals) => {
    if (!child.pid) return;
    try { if (process.platform !== 'win32') process.kill(-child.pid, signal); else child.kill(signal); } catch { /* already exited */ }
  };
  const stop = (message: string) => {
    if (failure) return;
    failure = new Error(message); kill('SIGTERM'); force = setTimeout(() => kill('SIGKILL'), 1000);
  };
  const abort = () => stop('Command aborted');
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  const interrupt = () => { process.exitCode = 130; stop('Command interrupted'); };
  const terminate = () => { process.exitCode = 143; stop('Command terminated'); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', terminate);
  const timer = setTimeout(() => stop(`Command timed out: ${binary}`), options.timeoutMs ?? 120000);
  child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) stop('Command output exceeded limit'); else output.push(Buffer.from(chunk)); });
  child.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) stop('Command output exceeded limit'); });
  child.on('error', e => { failure = e; });
  child.stdin.on('error', () => { /* close reports subprocess failure */ });
  child.stdin.end(options.input ?? '');
  child.on('close', code => {
    options.signal?.removeEventListener('abort', abort);
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate);
    clearTimeout(timer); if (force) clearTimeout(force); kill('SIGKILL');
    if (failure || code !== 0) fail(failure ?? new Error(`Command failed (${code}): ${binary}; inspect provider state before retrying writes`));
    else done(Buffer.concat(output).toString('utf8'));
  });
});
export async function boundedInput(stream: NodeJS.ReadableStream, max = 1024 * 1024) {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of stream) { const b = Buffer.from(chunk); bytes += b.length; if (bytes > max) throw new Error('Input exceeded limit'); chunks.push(b); }
  return Buffer.concat(chunks).toString('utf8');
}
