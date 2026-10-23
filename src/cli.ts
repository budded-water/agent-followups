#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { loadConfig, boundedInput, readJson } from './io.js';
import { hook, hookConfig, record, drain, status, proposals, accept, reject, reconcile, retry, exportMarkdown } from './workflow.js';

const help = `agent-followups <command> --config /absolute/config.json

  hooks-json                  Print user-scoped Codex hook definitions (no installation)
  hook                        Read one Codex hook payload from stdin; enqueue only
  record --project ID --input /path/evidence.json [--parent BEAD]
  drain [--limit 1]            Analyze queued evidence with isolated read-only Codex
  status                      Inspect queue, proposal receipts and lock (no model calls)
  list                        List local proposals; accepted task status lives in Beads
  accept --id ID              Explicitly create one Beads task (no execution)
  reject --id ID --reason TEXT
  reconcile --id ID --bead ID  Attach an existing matching Bead after an unknown write
  retry --id EVENT --reason TEXT  Explicitly retry failed/interrupted extraction
  export                      Write a read-only Markdown view to stdout

No command runs implementation tasks, tests, builds, merges or releases.
See README.md for configuration and recovery. Node >=24; Codex and Beads are external CLIs.
`;
async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    config: { type: 'string' }, input: { type: 'string' }, project: { type: 'string' }, parent: { type: 'string' },
    limit: { type: 'string' }, id: { type: 'string' }, reason: { type: 'string' }, bead: { type: 'string' }, help: { type: 'boolean' },
  } });
  const operation = positionals[0];
  if (values.help || !operation) { console.log(help); return; }
  const required = (key: keyof typeof values) => { const v = values[key]; if (typeof v !== 'string' || !v.trim()) throw new Error(`--${key} is required`); return v; };
  if (operation === 'hooks-json') { console.log(JSON.stringify(hookConfig(required('config'), fileURLToPath(import.meta.url)), null, 2)); return; }
  const c = await loadConfig(required('config'));
  let result: unknown;
  switch (operation) {
    case 'hook': result = await hook(c, JSON.parse(await boundedInput(process.stdin))); break;
    case 'record': result = { id: await record(c, required('project'), await readJson(resolve(required('input'))), values.parent) }; break;
    case 'drain': result = await drain(c, Number(values.limit ?? '1')); if ((result as { state: string }[]).some(r => r.state === 'failed')) process.exitCode ||= 1; break;
    case 'status': result = await status(c); break;
    case 'list': result = await proposals(c); break;
    case 'accept': result = await accept(c, required('id')); break;
    case 'reject': result = await reject(c, required('id'), required('reason')); break;
    case 'reconcile': result = await reconcile(c, required('id'), required('bead')); break;
    case 'retry': await retry(c, required('id'), required('reason')); result = { retried: values.id }; break;
    case 'export': process.stdout.write(await exportMarkdown(c)); return;
    default: throw new Error(`Unknown command: ${operation}`);
  }
  console.log(JSON.stringify(result, null, 2));
}
main().catch(() => {
  // Do not leak observations, credentials, or raw external command output to hook/CI logs.
  console.error('agent-followups failed. Check command arguments, configuration, private state and CLI availability. Unknown Beads writes require reconcile; see README.md.');
  process.exitCode = 1;
});
