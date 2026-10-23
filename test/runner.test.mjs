import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { watch } from '../dist/runner.js';
import { atomicJson, loadConfig, withLock, command } from '../dist/io.js';
import { record, hook, status } from '../dist/workflow.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'followups-runner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'repo'); await mkdir(repo);
  const config = join(root, 'config.json');
  await atomicJson(config, { version: 1, stateDir: join(root, 'state'), beadsDir: join(root, 'planning', '.beads'), projects: [{ id: 'app', root: repo }] });
  return { c: await loadConfig(config), config, repo };
}
const bounds = { maxCycles: 2, maxEvents: 2, intervalSeconds: 1, limit: 2 };
const evidence = [{ source: 'fixture', summary: 'An independent observation' }];
const noFindings = async (binary, args) => { await writeFile(args[args.indexOf('-o') + 1], JSON.stringify({ outcome: 'no_findings', candidates: [] })); return ''; };

test('runner caps total attempts even when batch limit and queue are larger', async t => {
  const { c } = await fixture(t);
  for (let i = 0; i < 3; i++) await record(c, 'app', [{ ...evidence[0], source: `fixture-${i}` }]);
  let calls = 0; const cycles = [];
  const s = await watch(c, { ...bounds, maxEvents: 1 }, { exec: async (...args) => { calls++; return noFindings(...args); }, onCycle: c => { cycles.push(c); } });
  assert.deepEqual(s, { reason: 'event_limit', cycles: 1, processed: 1 });
  assert.equal(calls, 1); assert.equal(cycles[0].remainingEvents, 0); assert.equal((await status(c)).queue.pending, 2);
});
test('idle runner polls within cycle limit and sees observations arriving between batches', async t => {
  const { c, repo } = await fixture(t); let calls = 0;
  const s = await watch(c, bounds, { exec: async (...args) => { calls++; return noFindings(...args); }, onCycle: async cycle => {
    if (cycle.cycle === 1) {
      assert.deepEqual(cycle.results, []);
      await hook(c, { hook_event_name: 'Stop', session_id: 'arriving', cwd: repo, last_assistant_message: 'Independent observation from an active session' });
    }
  } });
  assert.deepEqual(s, { reason: 'cycle_limit', cycles: 2, processed: 1 }); assert.equal(calls, 1);
  assert.equal((await status(c)).proposals.accepted, 0);
});
test('extraction failure stops the runner without a second attempt or silent recovery', async t => {
  const { c } = await fixture(t); await record(c, 'app', evidence); let calls = 0;
  const s = await watch(c, bounds, { exec: async () => { calls++; throw new Error('private diagnostics'); } });
  assert.deepEqual(s, { reason: 'failed', cycles: 1, processed: 1 }); assert.equal(calls, 1);
  assert.equal((await status(c)).queue.failed, 1);
  assert.ok(!JSON.stringify(s).includes('private diagnostics'));
  await withLock(c, async () => {});
});
test('aborted runner exits before a batch or cancels an idle wait without leaking locks', async t => {
  const { c } = await fixture(t); const before = new AbortController(); before.abort();
  assert.deepEqual(await watch(c, bounds, { signal: before.signal }), { reason: 'stopped', cycles: 0, processed: 0 });
  const controller = new AbortController();
  const s = await watch(c, { ...bounds, intervalSeconds: 3600 }, { signal: controller.signal, onCycle: () => { controller.abort(); } });
  assert.deepEqual(s, { reason: 'stopped', cycles: 1, processed: 0 });
  await withLock(c, async () => {});
});
test('runner refuses an existing lock and invalid bounds without consuming evidence', async t => {
  const { c } = await fixture(t); const id = await record(c, 'app', evidence);
  await withLock(c, async () => { await assert.rejects(watch(c, bounds), /owns the state lock/); });
  for (const options of [{ ...bounds, maxEvents: 0 }, { ...bounds, maxCycles: NaN }, { ...bounds, maxCycles: 61 }, { ...bounds, intervalSeconds: 0 }, { ...bounds, limit: 21 }]) await assert.rejects(watch(c, options));
  assert.equal((await status(c)).queue.pending, 1);
  assert.equal(JSON.parse(await readFile(join(c.stateDir, 'events', `${id}.json`), 'utf8')).id, id);
});
for (const [stopSignal, exitCode] of [['SIGTERM', 143], ['SIGINT', 130]]) test(`CLI emits bounded NDJSON and ${stopSignal} cancels idle sleep`, { timeout: 10000 }, async t => {
  const { config, c } = await fixture(t);
  const child = spawn(process.execPath, [join(import.meta.dirname, '../dist/cli.js'), 'watch', '--config', config, '--max-cycles', '2', '--max-events', '1', '--interval', '3600'], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let output = '', signaled = false;
  child.stdout.on('data', b => { output += b; if (!signaled && output.includes('\n')) { signaled = true; child.kill(stopSignal); } });
  let stderr = ''; child.stderr.on('data', b => { stderr += b; });
  const { code, signal } = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', (code, signal) => resolve({ code, signal })); });
  assert.equal(signal, null); assert.equal(code, exitCode, stderr);
  const lines = output.trim().split('\n').map(v => JSON.parse(v));
  assert.equal(lines[0].type, 'cycle'); assert.deepEqual(lines[0].results, []);
  assert.deepEqual(lines[1], { type: 'summary', reason: 'stopped', cycles: 1, processed: 0 });
  assert.equal((await status(c)).operationLock.present, false);
});


test('CLI termination stops an active extractor and releases its operation lock', { timeout: 10000, skip: process.platform === 'win32' }, async t => {
  const { config, c } = await fixture(t);
  const fake = join(c.stateDir, 'fake-codex'); const marker = join(c.stateDir, 'extractor-ready');
  await writeFile(fake, `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.EXTRACTOR_MARKER,String(process.pid));setInterval(()=>{},1000);\n`, { mode: 0o700 });
  const settings = JSON.parse(await readFile(config, 'utf8')); settings.codexBinary = fake; await atomicJson(config, settings);
  await record(c, 'app', evidence);
  const child = spawn(process.execPath, [join(import.meta.dirname, '../dist/cli.js'), 'watch', '--config', config, '--max-cycles', '2', '--max-events', '2'], { env: { ...process.env, EXTRACTOR_MARKER: marker }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', b => { output += b; }); child.stderr.resume();
  const closed = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', (code, signal) => resolve({ code, signal })); });
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGKILL');
    try { process.kill(-Number(await readFile(marker, 'utf8')), 'SIGKILL'); } catch { /* process group already stopped */ }
  });
  let pid;
  for (let i = 0; i < 200; i++) {
    try { pid = Number(await readFile(marker, 'utf8')); if (pid) break; } catch { /* wait for controlled subprocess */ }
    await delay(10);
  }
  assert.ok(pid, 'controlled extractor started'); child.kill('SIGTERM');
  assert.deepEqual(await closed, { code: 143, signal: null });
  assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
  assert.equal((await status(c)).queue.failed, 1); assert.equal((await status(c)).operationLock.present, false);
  assert.equal(JSON.parse(output.trim().split('\n').at(-1)).reason, 'stopped');
});


test('cancellation at the subprocess boundary prevents a provider start and preserves explicit recovery', async t => {
  const { c } = await fixture(t); await record(c, 'app', evidence); const controller = new AbortController(); let calls = 0;
  const s = await watch(c, bounds, { signal: controller.signal, exec: async (binary, args, options) => {
    calls++; assert.equal(options.signal, controller.signal); controller.abort();
    // A nonexistent binary would fail spawn if the pre-start cancellation guard were absent.
    await assert.rejects(command('/nonexistent/should-never-start', [], options), /aborted before startup/);
    throw new Error('cancelled before provider start');
  } });
  assert.deepEqual(s, { reason: 'stopped', cycles: 1, processed: 1 }); assert.equal(calls, 1);
  assert.equal((await status(c)).queue.failed, 1); await withLock(c, async () => {});
});

test('supplied AbortSignal terminates a controlled active extractor without an OS signal', { timeout: 10000 }, async t => {
  const { c } = await fixture(t); await record(c, 'app', evidence); const controller = new AbortController();
  const marker = join(c.stateDir, 'abort-ready'); let pid;
  const timer = setInterval(async () => {
    try { pid = Number(await readFile(marker, 'utf8')); if (pid) controller.abort(); } catch { /* startup */ }
  }, 10);
  t.after(() => { clearInterval(timer); if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* exited */ } } });
  const s = await watch(c, bounds, { signal: controller.signal, exec: async (binary, args, options) => {
    await command(process.execPath, ['-e', "require('node:fs').writeFileSync(process.env.EXTRACTOR_MARKER,String(process.pid));setInterval(()=>{},1000)"], { ...options, env: { ...options.env, EXTRACTOR_MARKER: marker } });
    throw new Error('must abort');
  } });
  assert.ok(pid); assert.deepEqual(s, { reason: 'stopped', cycles: 1, processed: 1 });
  assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
  assert.equal((await status(c)).queue.failed, 1); assert.equal((await status(c)).operationLock.present, false);
});


test('CLI extraction failure exits 1 and leaves further events pending', { timeout: 10000 }, async t => {
  const { config, c } = await fixture(t);
  const settings = JSON.parse(await readFile(config, 'utf8')); settings.codexBinary = '/nonexistent/controlled-provider'; await atomicJson(config, settings);
  await record(c, 'app', evidence); await record(c, 'app', [{ ...evidence[0], source: 'second-event' }]);
  const child = spawn(process.execPath, [join(import.meta.dirname, '../dist/cli.js'), 'watch', '--config', config, '--max-cycles', '2', '--max-events', '2'], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let output = ''; child.stdout.on('data', b => { output += b; }); child.stderr.resume();
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  assert.equal(code, 1); assert.equal(JSON.parse(output.trim().split('\n').at(-1)).reason, 'failed');
  const s = await status(c); assert.equal(s.queue.failed, 1); assert.equal(s.queue.pending, 1); assert.equal(s.operationLock.present, false);
});
