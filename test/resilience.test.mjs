import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, rm, readFile, writeFile, readdir, symlink, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicJson, command, hash, loadConfig, MAX_JSON_BYTES } from '../dist/io.js';
import { record, drain, retry, proposals, accept, reconcile, hook, status } from '../dist/workflow.js';
import { setProposalReview } from '../dist/review.js';
import { setFocus, changeFocus } from '../dist/focus.js';
import { jsonObjectArray } from '../dist/json-array.js';
import { currentReview } from './helpers.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'followups-resilience-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'repo'); await mkdir(repo);
  const beadsDir = join(root, 'planning'); await mkdir(beadsDir);
  const config = join(root, 'config.json');
  await atomicJson(config, { version: 1, stateDir: join(root, 'state'), beadsDir, projects: [{ id: 'app', root: repo }] });
  return { root, repo, config, c: await loadConfig(config) };
}
const evidence = [{ summary: 'Two independently reproducible failures', source: 'fixture-report' }];
const candidate = title => ({ title, project: 'app', kind: 'bug', certainty: 'confirmed', evidence,
  rationale: 'Preserve recovery evidence', acceptance: 'Both findings remain recoverable', nextStep: 'Inspect the fixture' });
const output = candidates => async (b, args) => {
  await writeFile(args[args.indexOf('-o') + 1], JSON.stringify({ outcome: candidates.length ? 'candidates_found' : 'no_findings', candidates }));
  return '';
};
const json = async path => JSON.parse(await readFile(path, 'utf8'));
async function faultRename(predicate, action) {
  const rename = fs.promises.rename;
  fs.promises.rename = async (from, to) => {
    if (predicate(to)) throw Object.assign(new Error('injected publication failure'), { code: 'EIO' });
    return rename(from, to);
  };
  syncBuiltinESMExports();
  try { return await action(); }
  finally { fs.promises.rename = rename; syncBuiltinESMExports(); }
}

for (const boundary of ['first proposal', 'second proposal', 'success receipt']) {
  test(`publication recovery replays saved results after failure at ${boundary}`, async t => {
    const { c } = await fixture(t); const id = await record(c, 'app', evidence);
    let publications = 0, receipts = 0;
    const result = await faultRename(path => {
      if (path.includes('/proposals/')) return ++publications === (boundary === 'first proposal' ? 1 : boundary === 'second proposal' ? 2 : -1);
      if (path.endsWith(`/checks/${id}.json`)) return ++receipts === 2 && boundary === 'success receipt';
      return false;
    }, () => drain(c, 1, output([candidate('First defect'), candidate('Second defect')])));
    assert.equal(result[0].state, 'failed');
    const receipt = await json(join(c.stateDir, 'checks', `${id}.json`));
    assert.equal(receipt.phase, 'publishing');
    const run = join(c.stateDir, 'runs', id, receipt.attempt);
    const original = await readFile(join(run, 'output.json'), 'utf8');
    await retry(c, id, 'Removed filesystem failure');
    let calls = 0;
    const recovered = await drain(c, 1, async () => { calls++; throw new Error('must replay, not ask model'); });
    assert.equal(calls, 0); assert.equal(recovered[0].state, 'succeeded');
    assert.equal(recovered[0].attempt, receipt.attempt); assert.equal(recovered[0].proposals.length, 2);
    const tasks = await proposals(c); assert.equal(tasks.length, 2);
    for (const task of tasks) assert.deepEqual(task.eventIds, [id]);
    assert.equal(await readFile(join(run, 'output.json'), 'utf8'), original);
    assert.equal((await readdir(join(c.stateDir, 'recovery'))).length, 1);
  });
}

test('failed extraction gets a new attempt without overwriting raw output or legacy artifacts', async t => {
  const { c } = await fixture(t); const id = await record(c, 'app', evidence);
  await atomicJson(join(c.stateDir, 'runs', id, 'output.json'), { legacy: true });
  await drain(c, 1, async (b, args) => { await writeFile(args[args.indexOf('-o') + 1], 'incomplete raw output'); throw new Error('provider stopped'); });
  const failed = await json(join(c.stateDir, 'checks', id + '.json'));
  await retry(c, id, 'Provider available again');
  const [done] = await drain(c, 1, output([]));
  assert.equal(done.state, 'succeeded'); assert.notEqual(done.attempt, failed.attempt);
  assert.equal(await readFile(join(c.stateDir, 'runs', id, failed.attempt, 'output.json'), 'utf8'), 'incomplete raw output');
  assert.deepEqual(await json(join(c.stateDir, 'runs', id, 'output.json')), { legacy: true });
});

test('saved publication preserves its focus and proposal decisions across recovery', async t => {
  const { c } = await fixture(t);
  const direction = { id: 'recovery', status: 'active', layer: 'general', projects: [], question: 'Find recovery failures', lookFor: ['Partial writes'], evidenceRequired: ['Reproduction'], exclude: [], exitWhen: 'Explicit pause' };
  const focus = await setFocus(c, { version: 1, directions: [direction] });
  const id = await record(c, 'app', evidence); let writes = 0;
  await faultRename(path => path.includes('/proposals/') && ++writes === 2,
    () => drain(c, 1, output([candidate('First defect'), candidate('Second defect')].map(c => ({ ...c, focusIds: ['recovery'] })))));
  const [first] = await proposals(c);
  await setProposalReview(c, first.id, currentReview);
  await accept(c, first.id, async (b, a) => a[0] === 'list' ? '[]' : '{"id":"imported-first"}');
  await changeFocus(c, 'recovery', 'paused');
  await retry(c, id, 'Resume original publication');
  const [done] = await drain(c, 1, async () => { throw new Error('no new analysis'); });
  assert.equal(done.state, 'succeeded'); assert.equal(done.focusRevision, focus.revision);
  const tasks = await proposals(c); assert.equal(tasks.length, 2);
  assert.equal(tasks.find(t => t.id === first.id).status, 'accepted');
  assert.ok(tasks.every(t => t.focusRuns[0].revision === focus.revision));
});

test('tampered publication or changed input fails closed without re-extraction', async t => {
  for (const changed of ['plan', 'event']) {
    const { c } = await fixture(t); const id = await record(c, 'app', evidence);
    await faultRename(path => path.includes('/proposals/'), () => drain(c, 1, output([candidate('First defect')])));
    const path = join(c.stateDir, changed === 'plan' ? `runs/${id}/publication.json` : `events/${id}.json`);
    const value = await json(path);
    if (changed === 'plan') value.publication.result.candidates[0].title = 'Changed';
    else value.evidence[0].summary = 'Different source';
    await atomicJson(path, value); await retry(c, id, 'Attempt recovery');
    let calls = 0; const [done] = await drain(c, 1, async () => { calls++; return ''; });
    assert.equal(done.state, 'failed'); assert.equal(calls, 0); assert.deepEqual(await proposals(c), []);
  }
});

test('legacy partially published attempts require investigation before another extraction', async t => {
  const { c } = await fixture(t); const id = await record(c, 'app', evidence);
  await drain(c, 1, output([candidate('Legacy defect')]));
  await rm(join(c.stateDir, 'runs', id, 'publication.json'));
  await atomicJson(join(c.stateDir, 'checks', id + '.json'), { state: 'failed', finishedAt: new Date().toISOString() });
  await assert.rejects(retry(c, id, 'Legacy recovery'), /Legacy partial publication/);
  assert.equal((await json(join(c.stateDir, 'checks', id + '.json'))).state, 'failed');
});

test('temporary source revocation cannot discard or strand a prepared publication', async t => {
  const { c } = await fixture(t); const id = await record(c, 'app', evidence); let writes = 0;
  await faultRename(path => path.includes('/proposals/') && ++writes === 2,
    () => drain(c, 1, output([candidate('First defect'), candidate('Second defect')])));
  const projects = c.projects; c.projects = [];
  await retry(c, id, 'Retry while project temporarily unavailable');
  let calls = 0; const noModel = async () => { calls++; throw new Error('must not call provider'); };
  assert.equal((await drain(c, 1, noModel))[0].state, 'failed');
  c.projects = projects;
  await retry(c, id, 'Restored the original source authorization');
  assert.equal((await drain(c, 1, noModel))[0].state, 'succeeded');
  assert.equal(calls, 0); assert.equal((await proposals(c)).length, 2);
});

test('Beads preflight streams more than 2 MiB and still detects a duplicate at the end', async t => {
  const { c, root } = await fixture(t); const id = await record(c, 'app', evidence);
  await drain(c, 1, output([candidate('Independent issue')])); const [task] = await proposals(c);
  await setProposalReview(c, task.id, currentReview);
  const unrelated = Array.from({ length: 30 }, (_, i) => ({ id: `other-${i}`, title: 'Other task', labels: ['project:other'], description: '法语 é \" {nested} '.repeat(6000) }));
  const path = join(root, 'beads-output.json');
  let creates = 0;
  const adapter = async (b, args, options) => {
    if (args[0] === 'create') { creates++; return '{"id":"created"}'; }
    return command(process.execPath, ['-e', 'require("node:fs").createReadStream(process.argv[1]).pipe(process.stdout)', path], options);
  };
  for (const tail of [
    { id: 'duplicate', title: task.candidate.title, labels: ['project:app'] },
    { id: 'duplicate', title: 'Renamed', description: `agent-followups:${task.id}\r\nProject: other` },
  ]) {
    await writeFile(path, JSON.stringify([...unrelated, tail]));
    assert.ok((await readFile(path)).length > MAX_JSON_BYTES);
    await assert.rejects(accept(c, task.id, adapter), /existing Beads issue/);
  }
  assert.equal(creates, 0);
  await writeFile(path, JSON.stringify(unrelated));
  assert.equal((await accept(c, task.id, adapter)).beadId, 'created'); assert.equal(creates, 1);
});

test('streaming preflight rejects malformed, oversized or failed output before intent', async t => {
  const { c, root } = await fixture(t); await record(c, 'app', evidence);
  await drain(c, 1, output([candidate('Independent issue')])); const [task] = await proposals(c);
  await setProposalReview(c, task.id, currentReview);
  const path = join(root, 'bad-beads.json'); let creates = 0;
  for (const payload of ['[{"id":"x","title":"ok"}', '[{"id":"x","title":"ok"},]', '[{"id":"x","title":"ok"}]trailing', '[{}]', JSON.stringify([{ id: 'x', title: 'ok', description: 'x'.repeat(MAX_JSON_BYTES) }])]) {
    await writeFile(path, payload);
    await assert.rejects(accept(c, task.id, async (b, args, options) => {
      if (args[0] === 'create') { creates++; return '{"id":"bad"}'; }
      return command(process.execPath, ['-e', 'require("node:fs").createReadStream(process.argv[1]).pipe(process.stdout)', path], options);
    }));
    assert.equal((await proposals(c))[0].status, 'proposed');
  }
  await assert.rejects(accept(c, task.id, async (b, args, options) => {
    assert.equal(args[0], 'list');
    return command(process.execPath, ['-e', 'process.stdout.write("[]");process.exitCode=2'], options);
  }));
  assert.equal(creates, 0);
});

test('incremental array validation preserves Unicode, escapes and nested objects at every byte boundary', () => {
  const value = [{ title: '法语 é 🧭', description: 'quote " slash \\ bracket } ]', nested: [{ a: [1, 2] }] }, { title: 'next' }];
  const bytes = Buffer.from(JSON.stringify(value));
  for (let size = 1; size <= bytes.length; size++) {
    const parsed = []; const stream = jsonObjectArray(v => parsed.push(v));
    for (let i = 0; i < bytes.length; i += size) stream.push(bytes.subarray(i, i + size));
    stream.finish(); assert.deepEqual(parsed, value);
  }
});

test('older pending work precedes newer lower hashes, and corrupt events stay schedulable', async t => {
  const { c } = await fixture(t);
  const old = await record(c, 'app', [{ summary: 'Old observation', source: 'old' }]);
  const oldPath = join(c.stateDir, 'events', old + '.json');
  await atomicJson(oldPath, { ...await json(oldPath), createdAt: '2000-01-01T00:00:00.000Z' });
  let newer;
  for (let i = 0; ; i++) {
    const evidence = [{ summary: 'New observation', source: String(i) }];
    if (hash({ project: 'app', session: 'manual', kind: 'manual', evidence }) < old) { newer = await record(c, 'app', evidence); break; }
  }
  assert.equal((await drain(c, 1, output([])))[0].id, old);
  const corrupt = 'f'.repeat(64); const badPath = join(c.stateDir, 'events', corrupt + '.json');
  await writeFile(badPath, '{'); await utimes(badPath, new Date(0), new Date(0));
  const batch = await drain(c, 2, output([]));
  assert.deepEqual(batch.map(r => [r.id, r.state]), [[corrupt, 'failed'], [newer, 'succeeded']]);
});

test('unavailable checkout isolates collection and imports while inspection and reconciliation remain usable', async t => {
  const { c, config, root, repo } = await fixture(t);
  const missing = join(root, 'deleted');
  const input = await json(config); input.projects.push({ id: 'gone', root: missing }); await atomicJson(config, input);
  const loaded = await loadConfig(config);
  assert.deepEqual((await status(loaded)).unavailableProjects, [{ id: 'gone', reason: 'missing' }]);
  await hook(loaded, { hook_event_name: 'Stop', session_id: 'healthy', cwd: repo, last_assistant_message: 'Independent issue' });
  assert.equal((await drain(loaded, 1, output([candidate('Healthy task')])))[0].state, 'succeeded');
  await assert.rejects(record(loaded, 'gone', evidence), /Unknown project/);
  const [task] = await proposals(loaded); const taskPath = join(c.stateDir, 'proposals', task.id + '.json');
  await atomicJson(taskPath, { ...task, candidate: { ...task.candidate, project: 'gone' } });
  let calls = 0;
  await assert.rejects(accept(loaded, task.id, async () => { calls++; return ''; }), /no longer configured/); assert.equal(calls, 0);
  await atomicJson(taskPath, { ...await json(taskPath), status: 'accepting' });
  assert.equal((await reconcile(loaded, task.id, 'existing', async () => JSON.stringify([{ id: 'existing', description: `agent-followups:${task.id}` }]))).status, 'accepted');
  const cli = join(import.meta.dirname, '../dist/cli.js');
  const snapshot = JSON.parse(await command(process.execPath, [cli, 'status', '--config', config], { cwd: root }));
  assert.equal(snapshot.unavailableProjects[0].id, 'gone');
  input.projects = [{ id: 'gone', root: missing }]; await atomicJson(config, input);
  assert.equal((await loadConfig(config)).projects.length, 0);
  assert.equal(JSON.parse(await command(process.execPath, [cli, 'list', '--config', config], { cwd: root })).length, 1);
});

test('unavailable nested projects never fall back to an authorized ancestor', async t => {
  const { config, repo } = await fixture(t); const nested = join(repo, 'missing-child');
  const input = await json(config); input.projects.push({ id: 'child', root: nested }); await atomicJson(config, input);
  const c = await loadConfig(config); await mkdir(nested);
  await hook(c, { hook_event_name: 'Stop', session_id: 'no-fallback', cwd: nested, last_assistant_message: 'Must not belong to ancestor' });
  assert.equal((await status(c)).queue.pending, 0);
});

test('missing roots cannot bypass private-state containment, including symlink ancestors', async t => {
  const { config, root, repo } = await fixture(t); const alias = join(root, 'repo-alias'); await symlink(repo, alias);
  const input = await json(config); input.projects.push({ id: 'missing', root: join(alias, 'child') });
  input.stateDir = join(repo, 'child', 'private'); await atomicJson(config, input);
  await assert.rejects(loadConfig(config), /outside/);
});
