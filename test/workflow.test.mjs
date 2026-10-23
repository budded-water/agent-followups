import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Config, Extraction } from '../dist/contracts.js';
import { atomicJson, loadConfig, command, withLock } from '../dist/io.js';
import { hook, record, drain, proposals, accept, reconcile, retry, reject, exportMarkdown, hookConfig } from '../dist/workflow.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'agent-followups-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'repo'); await mkdir(repo);
  const c = Config.parse({ version: 1, stateDir: join(root, 'private'), beadsDir: join(root, 'planning', '.beads'), projects: [{ id: 'app', root: repo }] });
  const config = join(root, 'config.json'); await atomicJson(config, c); return { c: await loadConfig(config), root, repo, config };
}
const evidence = [{ summary: 'The same label is clipped in the recorded French screenshot; investigate the shared control.', source: 'synthetic screenshot report' }];
const finding = { title: 'Investigate French label clipping', project: 'app', kind: 'investigation', certainty: 'hypothesis', evidence, rationale: 'Affects navigation', acceptance: 'Confirm reproduction and verify the corrected control', nextStep: 'Inspect the report and shared control' };
function extractor(result = { outcome: 'candidates_found', candidates: [finding] }) {
  return async (binary, args, options) => {
    assert.equal(args[0], '-a'); assert.equal(args[1], 'never');
    assert.ok(args.includes('--ignore-user-config')); assert.ok(args.includes('features.hooks=false'));
    assert.ok(args.includes('features.shell_tool=false')); assert.ok(args.includes('apps._default.enabled=false'));
    assert.equal(options.env.AGENT_FOLLOWUPS_INTERNAL, '1'); assert.ok(options.input.includes('untrusted data'));
    await writeFile(args[args.indexOf('-o') + 1], JSON.stringify(result)); return '';
  };
}
async function propose(t) { const f = await fixture(t); await record(f.c, 'app', evidence); await drain(f.c, 1, extractor()); return { ...f, task: (await proposals(f.c))[0] }; }

test('hook ignores unknown projects, recursive continuations and internal analysis', async t => {
  const { c, root, repo } = await fixture(t);
  const payload = { hook_event_name: 'Stop', session_id: 's', cwd: root, last_assistant_message: 'something' };
  await hook(c, payload); await hook(c, { ...payload, cwd: repo, stop_hook_active: true });
  process.env.AGENT_FOLLOWUPS_INTERNAL = '1';
  try { await hook(c, { ...payload, cwd: repo }); } finally { delete process.env.AGENT_FOLLOWUPS_INTERNAL; }
  assert.deepEqual(await proposals(c), []); assert.deepEqual(await drain(c), []);
});
test('duplicate Stop delivery is idempotent and does not store raw session IDs or prompts by default', async t => {
  const { c, repo } = await fixture(t);
  const h = { hook_event_name: 'Stop', session_id: 'secret-session', turn_id: 'turn-1', cwd: repo, last_assistant_message: 'observed issue', prompt: 'secret prompt' };
  await hook(c, h); await hook(c, h);
  let calls = 0; const result = await drain(c, 20, async (...a) => { calls++; assert.ok(!a[2].input.includes('secret prompt')); assert.ok(!a[2].input.includes('secret-session')); return extractor()(...a); });
  assert.equal(calls, 1); assert.equal(result.length, 1); assert.deepEqual(await drain(c, 20, extractor()), []);
});
test('prompt collection is opt-in and attaches context to a check', async t => {
  const { c, repo } = await fixture(t); c.capturePrompts = true;
  await hook(c, { hook_event_name: 'UserPromptSubmit', session_id: 's', cwd: repo, prompt: 'Fix the main task first' });
  await hook(c, { hook_event_name: 'Stop', session_id: 's', cwd: repo, last_assistant_message: 'A separate issue exists' });
  await drain(c, 1, async (...a) => { assert.ok(a[2].input.includes('Fix the main task first')); return extractor()(...a); });
});
test('interruption without semantic evidence records no findings without calling a model', async t => {
  const { c, repo } = await fixture(t);
  await hook(c, { hook_event_name: 'Interrupt', session_id: 's', cwd: repo });
  const r = await drain(c, 1, () => { throw new Error('must not call'); }); assert.equal(r[0].outcome, 'no_findings');
});
test('no findings is a successful check, distinct from a failed extraction', async t => {
  const { c } = await fixture(t); await record(c, 'app', evidence);
  const r = await drain(c, 1, extractor({ outcome: 'no_findings', candidates: [] }));
  assert.equal(r[0].state, 'succeeded'); assert.equal(r[0].outcome, 'no_findings'); assert.deepEqual(await proposals(c), []);
});
test('failed and interrupted checks require an explicit retry and preserve recovery evidence', async t => {
  const { c } = await fixture(t); const id = await record(c, 'app', evidence);
  assert.equal((await drain(c, 1, async () => { throw new Error('private diagnostics'); }))[0].state, 'failed');
  assert.deepEqual(await drain(c, 1, extractor()), []);
  await retry(c, id, 'Fixed runtime configuration');
  assert.equal((await drain(c, 1, extractor()))[0].state, 'succeeded');
  await assert.rejects(retry(c, id, 'again'));
});
test('invalid output and unknown projects fail without silently succeeding or saving partial candidates', async t => {
  const { c } = await fixture(t); const id = await record(c, 'app', evidence);
  assert.equal((await drain(c, 1, extractor({ outcome: 'candidates_found', candidates: [finding, { ...finding, project: 'unknown' }] })))[0].state, 'failed');
  assert.deepEqual(await proposals(c), []);
  await retry(c, id, 'Corrected output');
  assert.equal((await drain(c, 1, extractor({ outcome: 'no_findings', candidates: [finding] })))[0].state, 'failed');
});
test('normalized duplicate proposals preserve reviewed content and rejected state', async t => {
  const { c, task } = await propose(t); await reject(c, task.id, 'Already tracked');
  await record(c, 'app', [{ ...evidence[0], source: 'another event' }]);
  await drain(c, 1, extractor({ outcome: 'candidates_found', candidates: [{ ...finding, title: 'INVESTIGATE French label clipping!', rationale: 'new rationale' }] }));
  const tasks = await proposals(c); assert.equal(tasks.length, 1); assert.equal(tasks[0].status, 'rejected'); assert.equal(tasks[0].candidate.rationale, finding.rationale); assert.equal(tasks[0].eventIds.length, 2);
});
test('Beads import records an intent, carries acceptance, and does not repeat successful creation', async t => {
  const { c, task } = await propose(t); let writes = 0;
  const bd = async (binary, args, options) => {
    assert.equal(options.env.BEADS_DIR, c.beadsDir);
    if (args[0] === 'list') return '[]';
    assert.equal(args[0], 'create'); writes++; assert.ok(args.includes('--acceptance'));
    assert.ok(args[args.indexOf('--description') + 1].includes(`agent-followups:${task.id}`));
    assert.equal((await proposals(c))[0].status, 'accepting'); return '{"id":"plan-123"}';
  };
  const done = await accept(c, task.id, bd); assert.equal(done.beadId, 'plan-123');
  await accept(c, task.id, bd); assert.equal(writes, 1);
});
test('existing Beads titles prevent duplicate creation before intent', async t => {
  const { c, task } = await propose(t);
  await assert.rejects(accept(c, task.id, async () => JSON.stringify([{ id: 'existing', title: finding.title }])));
  assert.equal((await proposals(c))[0].status, 'proposed');
});
test('unknown Beads write remains accepting and can only reconcile a matching existing task', async t => {
  const { c, task } = await propose(t);
  await assert.rejects(accept(c, task.id, async (b, a) => { if (a[0] === 'list') return '[]'; throw new Error('timeout after remote acceptance'); }));
  assert.equal((await proposals(c))[0].status, 'accepting');
  await assert.rejects(accept(c, task.id));
  await assert.rejects(reconcile(c, task.id, 'plan-1', async () => '[{"id":"plan-1","description":"wrong"}]'));
  const r = await reconcile(c, task.id, 'plan-1', async () => JSON.stringify([{ id: 'plan-1', description: `agent-followups:${task.id}` }]));
  assert.equal(r.status, 'accepted');
});
test('manual discovery parents become native Beads discovered-from links', async t => {
  const { c } = await fixture(t); await record(c, 'app', evidence, 'plan-parent'); await drain(c, 1, extractor());
  const [task] = await proposals(c); let parentChecked = false;
  await accept(c, task.id, async (b, a) => {
    if (a[0] === 'list') return '[]'; if (a[0] === 'show') { parentChecked = true; return '[{"id":"plan-parent"}]'; }
    assert.ok(parentChecked); assert.ok(a.includes('discovered-from:plan-parent')); return '{"id":"plan-child"}';
  });
});
test('operation lock prevents overlapping consumers and cannot be silently stolen', async t => {
  const { c } = await fixture(t);
  await withLock(c, async () => { await assert.rejects(withLock(c, async () => {}), /owns the state lock/); });
  await withLock(c, async () => {});
});
test('state path validation rejects in-repository storage, symlink roots and permissive permissions', async t => {
  const { c, config, root, repo } = await fixture(t);
  await atomicJson(config, { ...c, stateDir: join(repo, 'private') }); await assert.rejects(loadConfig(config), /outside/);
  if (process.platform !== 'win32') {
    const permissive = join(root, 'permissive'); await mkdir(permissive, { mode: 0o755 });
    await atomicJson(config, { ...c, stateDir: permissive }); await assert.rejects(loadConfig(config), /0700/);
    const link = join(root, 'link'); await symlink(c.stateDir, link);
    await atomicJson(config, { ...c, stateDir: link }); await assert.rejects(loadConfig(config), /real directory/);
  }
});
test('Markdown export is read-only and hook generation does not overwrite user configuration', async t => {
  const { c, config } = await propose(t); const before = await readFile(config, 'utf8');
  const md = await exportMarkdown(c); assert.ok(md.includes('## Acceptance')); assert.ok(md.includes('not imported'));
  const h = hookConfig(config, '/path with spaces/cli.js'); assert.ok(h.hooks.Stop[0].hooks[0].command.includes("'/path with spaces/cli.js'"));
  assert.equal(await readFile(config, 'utf8'), before);
});
test('command timeout and nonzero exit are failures, never successful empty observations', async () => {
  await assert.rejects(command(process.execPath, ['-e', 'process.exit(2)'], { cwd: tmpdir() }), /failed/);
  await assert.rejects(command(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: tmpdir(), timeoutMs: 30 }), /timed out/);
});
test('concurrent hook deliveries publish complete immutable events once', async t => {
  const { c, repo } = await fixture(t);
  const payload = { hook_event_name: 'Stop', session_id: 'concurrent', cwd: repo, last_assistant_message: 'independent observed issue' };
  await Promise.all(Array.from({ length: 20 }, () => hook(c, payload)));
  assert.equal((await drain(c, 20, extractor())).length, 1);
});
test('double-dot-prefixed child directories cannot bypass containment or project matching', async t => {
  const { c, config, repo } = await fixture(t);
  await atomicJson(config, { ...c, stateDir: join(repo, '..private') });
  await assert.rejects(loadConfig(config), /outside/);
  const nested = join(repo, '..source'); await mkdir(nested);
  await hook(c, { hook_event_name: 'Stop', session_id: 'dotdot-child', cwd: nested, last_assistant_message: 'Observed follow-up' });
  assert.equal((await drain(c, 1, extractor())).length, 1);
});
test('same-title Beads issues in another explicit project do not block a legitimate import', async t => {
  const { c, task } = await propose(t);
  const accepted = await accept(c, task.id, async (b, a) => {
    if (a[0] === 'list') return JSON.stringify([{ id: 'other-1', title: finding.title, description: 'Project: ui-eval' }]);
    assert.equal(a[0], 'create'); assert.ok(a.includes('project:app')); return '{"id":"app-2"}';
  });
  assert.equal(accepted.beadId, 'app-2');
});
test('streaming multibyte subprocess stdout retains correct Unicode JSON', async () => {
  const output = await command(process.execPath, ['-e', "const b=Buffer.from(JSON.stringify({title:'法语 é'}));process.stdout.write(b.subarray(0,11));setTimeout(()=>process.stdout.write(b.subarray(11)),20)"], { cwd: tmpdir() });
  assert.deepEqual(JSON.parse(output), { title: '法语 é' });
});
test('Beads subprocess cannot inherit database redirection or auto-push mode', async t => {
  const { c, task } = await propose(t);
  const previous = { BEADS_DB: process.env.BEADS_DB, BD_DB: process.env.BD_DB };
  process.env.BEADS_DB = '/wrong/database'; process.env.BD_DB = '/another/database';
  try {
    await accept(c, task.id, async (b, a, o) => {
      assert.equal(o.env.BEADS_DB, undefined); assert.equal(o.env.BD_DB, undefined); assert.ok(a.includes('--sandbox'));
      return a[0] === 'list' ? '[]' : '{"id":"safe-1"}';
    });
  } finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
});

test('status on an empty store creates no queue directories and CLI returns only a summary', async t => {
  const { c, config } = await fixture(t);
  const { status } = await import('../dist/workflow.js');
  const { readdir } = await import('node:fs/promises');
  assert.deepEqual(await readdir(c.stateDir), []);
  const s = await status(c);
  assert.deepEqual(s.queue, { pending: 0, running: 0, failed: 0, succeeded: 0, invalid: 0 });
  assert.equal(s.lastHookEventAt, null); assert.equal(s.lastSuccessfulAnalysisAt, null);
  assert.equal(s.operationLock.present, false);
  const cli = await command(process.execPath, [join(import.meta.dirname, '../dist/cli.js'), 'status', '--config', config], { cwd: tmpdir() });
  assert.equal(JSON.parse(cli).snapshot, 'best-effort');
  assert.deepEqual(await readdir(c.stateDir), []);
});

test('status distinguishes pending, running, failure, no findings and corrupt records without exposing evidence', async t => {
  const { c, repo } = await fixture(t);
  const { status } = await import('../dist/workflow.js');
  const pending = await record(c, 'app', [{ summary: 'private-pending-evidence', source: 'pending' }]);
  await hook(c, { hook_event_name: 'SessionEnd', session_id: 'private-session', cwd: repo });
  const successful = await drain(c, 20, extractor({ outcome: 'no_findings', candidates: [] }));
  assert.equal(successful.length, 2);
  const waiting = await record(c, 'app', [{ summary: 'private-pending-evidence', source: 'waiting' }]);
  const failed = await record(c, 'app', [{ summary: 'private-failure-evidence', source: 'failure' }]);
  await atomicJson(join(c.stateDir, 'checks', `${failed}.json`), { state: 'failed', finishedAt: new Date().toISOString() });
  const running = await record(c, 'app', [{ summary: 'private-running-evidence', source: 'running' }]);
  await atomicJson(join(c.stateDir, 'checks', `${running}.json`), { state: 'running', eventId: running, startedAt: new Date().toISOString() });
  const corrupt = await record(c, 'app', [{ summary: 'private-corrupt-evidence', source: 'corrupt' }]);
  await writeFile(join(c.stateDir, 'checks', `${corrupt}.json`), '{');
  await withLock(c, async () => {
    const s = await status(c);
    assert.deepEqual(s.queue, { pending: 1, running: 1, failed: 1, succeeded: 2, invalid: 1 });
    assert.equal(s.oldestPendingAt, JSON.parse(await readFile(join(c.stateDir, 'events', `${waiting}.json`), 'utf8')).createdAt);
    assert.ok(s.lastHookEventAt); assert.ok(s.lastSuccessfulAnalysisAt); assert.equal(s.operationLock.present, true);
    assert.ok(!JSON.stringify(s).includes('private-'));
    assert.equal(JSON.parse(await readFile(join(c.stateDir, 'checks', `${pending}.json`), 'utf8')).state, 'succeeded');
    await assert.rejects(withLock(c, async () => {}), /owns the state lock/);
  });
  assert.equal(await readFile(join(c.stateDir, 'checks', `${corrupt}.json`), 'utf8'), '{');
});

test('status reports unresolved import intents and accepted provenance without querying or changing Beads', async t => {
  const { c, task } = await propose(t);
  const { status } = await import('../dist/workflow.js');
  const original = await readFile(join(c.stateDir, 'proposals', `${task.id}.json`), 'utf8');
  assert.equal((await status(c)).proposals.proposed, 1);
  assert.equal(await readFile(join(c.stateDir, 'proposals', `${task.id}.json`), 'utf8'), original);
  await assert.rejects(accept(c, task.id, async (b, a) => { if (a[0] === 'list') return '[]'; throw new Error('unknown write'); }));
  assert.equal((await status(c)).proposals.accepting, 1);
  await reconcile(c, task.id, 'existing-1', async () => JSON.stringify([{ id: 'existing-1', description: `agent-followups:${task.id}` }]));
  const imported = await status(c); assert.equal(imported.proposals.accepted, 1); assert.equal(imported.proposals.accepting, 0);
  await writeFile(join(c.stateDir, 'proposals', `${'f'.repeat(64)}.json`), '{}');
  assert.equal((await status(c)).proposals.invalid, 1);
});

test('a corrupt event is preserved and reported while independent queued work still runs', async t => {
  const { c } = await fixture(t);
  const id = '0'.repeat(64);
  await atomicJson(join(c.stateDir, 'events', `${id}.json`), {});
  await writeFile(join(c.stateDir, 'events', `${id}.json`), '{private-corrupt-bytes');
  const valid = await record(c, 'app', evidence);
  const r = await drain(c, 20, extractor({ outcome: 'no_findings', candidates: [] }));
  assert.equal(r.find(e => e.id === id).state, 'failed');
  assert.equal(r.find(e => e.id === valid).state, 'succeeded');
  assert.equal(await readFile(join(c.stateDir, 'events', `${id}.json`), 'utf8'), '{private-corrupt-bytes');
  assert.ok(!JSON.stringify(r).includes('private-corrupt'));
  assert.deepEqual(await drain(c, 20, extractor()), []);
  await withLock(c, async () => {});
  await retry(c, id, 'Operator restored original evidence after keeping a backup');
  const original = JSON.parse(await readFile(join(c.stateDir, 'events', `${valid}.json`), 'utf8'));
  await atomicJson(join(c.stateDir, 'events', `${id}.json`), { ...original, id });
  assert.equal((await drain(c, 1, extractor({ outcome: 'no_findings', candidates: [] })))[0].state, 'succeeded');
});

test('a running receipt survives drain until explicit recovery archives it and reprocesses once', async t => {
  const { c } = await fixture(t);
  const id = await record(c, 'app', evidence);
  const receipt = { state: 'running', eventId: id, startedAt: '2026-01-01T00:00:00.000Z' };
  await atomicJson(join(c.stateDir, 'checks', `${id}.json`), receipt);
  assert.deepEqual(await drain(c, 1, () => { throw new Error('must skip running'); }), []);
  await retry(c, id, 'Verified crashed worker and children are stopped');
  const { readdir } = await import('node:fs/promises');
  const [file] = await readdir(join(c.stateDir, 'recovery'));
  assert.deepEqual(JSON.parse(await readFile(join(c.stateDir, 'recovery', file), 'utf8')).previous, receipt);
  assert.equal((await drain(c, 1, extractor()))[0].state, 'succeeded');
  assert.deepEqual(await drain(c, 1, extractor()), []);
});
