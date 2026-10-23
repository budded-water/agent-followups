# agent-followups

Discover, track, and hand off follow-up work from coding sessions.

A small local CLI for evidence-backed follow-ups: Codex lifecycle hooks enqueue observations, an explicit worker analyzes them, and an operator accepts useful proposals into [Beads](https://github.com/gastownhall/beads). It does not implement coding tasks, run UI tests, merge PRs, or publish releases.

## Responsibilities

```text
Coding session → hook / explicit evidence → durable event queue
                                               ↓ explicit drain
                                         validated proposals
                                               ↓ explicit accept
                                             Beads
                                               ↓ selected, authorized task
                                    existing coding / UI-eval / release tools
```

- Beads owns imported task status, dependencies, assignment and closure.
- This CLI owns discovery events, local proposal decisions and import receipts.
- UI-eval and other test tools own verification evidence.
- Existing release tools own publication authority, artifacts and recovery.
- A ready Beads issue is unblocked, not permission to execute it. A proposal can never defer required main-task work to make the main task look complete.

## Requirements and installation

- Node.js 24+ and the pnpm version pinned in `package.json`.
- An authenticated Codex CLI with `exec --ignore-user-config`, `--ephemeral`, `--output-schema` and `--output-last-message` support. Development targets Codex CLI 0.160.1; check your installed CLI before use.
- Beads CLI; the integration targets the v1.3.1 command contract. Initialize an external planning workspace separately. Embedded Beads needs no separate Dolt CLI; concurrent writers require appropriate Beads coordination/server configuration.

```sh
git clone https://github.com/budded-water/agent-followups.git
cd agent-followups
pnpm install --frozen-lockfile
pnpm run check
pnpm add --global .
agent-followups --help
```

The CLI has one runtime npm dependency, Zod. TypeScript is compiled at build time. No native database package, Redis, agent SDK, Gas Town or web server is required. This project is not published to the npm registry by this workflow.

Use `pnpm-lock.yaml` as the only dependency lockfile. pnpm reuses dependency files across projects through its shared content-addressable store. Check `pnpm store path` if an installation reports a store inside the project; restricted environments may need explicit access to a shared store. Repository changes do not upgrade a separately pinned installed CLI or collector.

## Configure explicit project access

Create a private config outside your repositories. Use canonical absolute paths; do not use `~` inside JSON. Example paths below are placeholders, not directories created by installation:

```json
{
  "version": 1,
  "stateDir": "/absolute/private/agent-followups/state",
  "beadsDir": "/absolute/private/planning/.beads",
  "projects": [
    { "id": "app", "root": "/absolute/projects/app" },
    { "id": "ui-eval", "root": "/absolute/projects/ui-eval" }
  ],
  "codexBinary": "codex",
  "beadsBinary": "bd",
  "timeoutSeconds": 120,
  "capturePrompts": false
}
```

`beadsDir` is the initialized `.beads` directory, not its parent or a database file. The CLI does not initialize or migrate Beads. It clears inherited `BEADS_DB`/`BD_DB` overrides, passes this directory explicitly to `bd`, and uses Beads sandbox mode to disable automatic Dolt push so working on one project does not select another task database accidentally. Private runtime state must live outside configured project roots and be a real directory with mode 0700 on POSIX. State inputs and configured executables are trusted operator configuration; this is not isolation from another process running as your user. Protect the config as well.

## Enable hooks without overwriting existing hooks

```sh
agent-followups hooks-json --config /absolute/private/followups.json
```

This prints definitions for `SessionStart`, `UserPromptSubmit`, `Stop`, `Interrupt` and `SessionEnd`. Merge the emitted handler arrays into **user-scoped** Codex hooks; do not replace your existing configuration. Run `/hooks` and review/trust the exact definitions in Codex. Keep Beads' own context-recovery hooks if already installed; this tool does not duplicate them.

Handlers only write bounded observations and return JSON. They do not call a model, block normal completion, start background processes or run Beads. Unknown project paths, internal extractor sessions and hook-triggered Stop continuations are ignored. `SessionStart` adds workflow guidance. Stop means a turn boundary, not that the overall task is complete. Interrupt/SessionEnd are best-effort markers; process crashes can skip them.

No daemon is installed. Hooks provide durable collection; an operator must run `drain` once or explicitly start bounded foreground `watch`. A separately configured scheduler is outside this package. A 3-second hook timeout may still prevent collection on a slow filesystem. Test the actual client lifecycle; printing a valid definition is not acceptance.

## Provide explicit evidence

Default hook input is limited to the latest assistant message. Such claims are recorded as unverified observations, not proof. There is no automatic transcript, source-code, diff, screenshot or credential collection. `capturePrompts: true` additionally stores the latest user prompt per session; leave it disabled unless that collection is intended.

For useful reproducible findings, explicitly record a small evidence JSON array:

```json
[
  {
    "source": "ui-eval report path and scenario name",
    "summary": "The French label is clipped in this scenario; reproduce and inspect the shared control."
  }
]
```

```sh
agent-followups record --config /absolute/private/followups.json \
  --project app --input /absolute/private/evidence.json --parent plan-abc
```

`--parent` is optional. Parent IDs must belong to the configured planning store when accepting. Candidates can explicitly target a different configured project; their evidence must justify that ownership.

## Analyze, inspect and accept

```sh
agent-followups drain --config /absolute/private/followups.json --limit 3
agent-followups list --config /absolute/private/followups.json
agent-followups export --config /absolute/private/followups.json > /absolute/private/followups.md
agent-followups similar --config /absolute/private/followups.json --id PROPOSAL_ID
agent-followups review set --config /absolute/private/followups.json --id PROPOSAL_ID \
  --input /absolute/private/review.json
agent-followups accept --config /absolute/private/followups.json --id PROPOSAL_ID
agent-followups reject --config /absolute/private/followups.json \
  --id PROPOSAL_ID --reason "Already tracked or not worth pursuing"
```

**Import compatibility change:** every new import requires a valid operator review with verdict `current`. Legacy proposals remain readable; existing accepted receipts and unknown-write reconciliation retain their behavior. See [proposal review](docs/proposal-review.md) for review JSON, historical state, duplicate associations and similarity limits.

Inspect the queue without starting analysis:

```sh
agent-followups status --config /absolute/private/followups.json
```

`status` returns a best-effort JSON snapshot of pending/running/failed/succeeded events, invalid event or receipt records, proposal/import receipt counts, the oldest pending event, latest successful analysis, latest captured hook event and lock presence. It does not call Codex or Beads, change records, acquire/remove a lock, retry analysis or repair corruption. An existing lock does not prove a live worker; a `running` receipt may survive a crash. Accepted proposal counts describe import provenance, not current Beads task status. Only recognized record filenames are counted; unreferenced receipts are not included. Concurrent writes/retries can make a snapshot temporarily inconsistent. The shared config loader may initialize the private state root, but status does not create queue directories.

A recent hook event is evidence of collection, not proof that every hook is trusted or that the runner is scheduled. Review `/hooks` and test actual lifecycle paths separately. No pending events does not prove that collection is working. Use explicit `retry` or `reconcile` after inspecting failures; status never applies recovery automatically.

`drain` handles 1–20 unchecked events per invocation (default 1). Each eligible event gets one isolated Codex extraction, at most five proposals, a timeout, bounded command output and schema validation. User configuration is ignored; hooks, shell tools, multi-agent and app defaults are disabled; web search is disabled; the sandbox is read-only with approval policy `never`. It runs from a private analysis directory, not the business checkout. Managed system policies may affect available tools; validate your environment. Extracted content is untrusted and creates no external task until acceptance.

A successful `no_findings` check is distinct from failure. Repeated event payloads are idempotent. Normalized title + target project deduplicates local proposals; repeated findings preserve reviewed content/state and append event references. This is conservative exact normalization, not semantic deduplication. Review Beads for related work before acceptance. Acceptance additionally checks existing Beads titles within the target project and global import markers before creation; matching unscoped legacy titles require manual review; that preflight is not a transaction across other independent writers.

Acceptance creates a task with evidence, acceptance criteria, next step, project attribution and import marker. Known discovery parents become native `discovered-from` dependencies. Imported task lifecycle then belongs to Beads; `list` shows local import decisions, not a live copy of task completion. Markdown is an export, not a second editable task ledger. Do not place credentials or sensitive evidence in a planning store that syncs to a public remote.

## Recovery and privacy

- One exclusive state lock serializes drain and proposal decisions. It is never stolen or expired automatically. Hooks can keep enqueueing while analysis runs.
- If a process crashes holding `operation.lock`, first verify the worker and its child processes have stopped; then remove only that lock. Do not clear a live lock.
- Extraction writes a running receipt first. Failed/interrupted checks are not retried automatically. After resolving the cause, use `retry --id EVENT_ID --reason "..."`. Recovery preserves the previous receipt. An unreadable, invalid or ID-mismatched event gets a failed receipt and consumes one drain slot; independent events can still run. Its original bytes are preserved. Before retrying it, preserve a backup and restore valid original evidence or fix access permissions; do not invent replacement evidence or reset the queue.
- Beads creation persists an `accepting` intent before the write. A timeout, invalid reply or crash may leave a task created with no local acknowledgement. Do not repeat creation. Search Beads for `agent-followups:PROPOSAL_ID`, then use `reconcile --id PROPOSAL_ID --bead EXISTING_BEAD_ID`; the CLI verifies the marker before attaching it. If no task exists, manual investigation/recovery is required; there is deliberately no blind reset.
- Evidence, model output and event receipts live under private state. Raw subprocess stderr is not copied into public errors. The Codex provider receives supplied evidence during `drain` or `watch`; private local storage does not make model processing offline.
- Keep the whole state directory and the Beads database backed up separately. No automatic retention, remote backup or installation-wide resource manager is included.

## Validation scope

`pnpm run check` builds TypeScript and runs behavioral tests with isolated directories and fake external commands. The suite covers queue idempotence, hook filtering, opt-in prompt collection, output validation, duplicate proposals, explicit retry, lock exclusion, uncertain Beads writes and reconciliation. Tests do not certify installed Codex hook trust, real model quality, concurrent Beads writers, simulator acceptance or store release readiness. See [architecture](docs/architecture.md) and [validation](docs/validation.md).

## License

MIT. Beads, Codex and other invoked tools retain their own licenses and terms. No upstream source is vendored.

## Looking up imported work

Beads owns task status after import. Select the same external `beadsDir` used by this config, rather than running plain `bd` from a business checkout. Use a verified store-aware wrapper when installed; the local pilot provides `followups-beads ready --json` and `followups-beads show ID --json`. For a manual POSIX invocation, substitute the configured absolute paths:

```sh
(cd /absolute/private/planning/.beads && env -u BEADS_DB -u BD_DB BEADS_DIR=/absolute/private/planning/.beads /absolute/path/to/bd ready --json --sandbox)
```

Use `show ID` in place of `ready` to inspect a selected task. Clear inherited database overrides each time; do not export a global Beads directory that silently changes other projects. A ready task remains subject to the selected repository's execution authorization.

## Bounded foreground runner

Start `watch` explicitly in a terminal while you work in other sessions:

```sh
agent-followups watch --config /absolute/private/followups.json --max-cycles 10 --max-events 5 --interval 60 --limit 1
```

Both budgets are required: `max-cycles` counts polls including empty ones (1–60), and `max-events` caps attempted events across all batches (1–20). Empty markers and corrupt inputs also consume event budget; provider invocations cannot exceed this budget. `interval` is the idle delay between completed batches in seconds (1–3600, default 60), not a fixed-rate schedule. Each batch uses `limit` (1–20, default 1), reduced to the remaining event budget. Bounds limit attempts, not tokens, money or an exact wall-clock deadline. Each provider call retains the configured timeout.

The runner emits one compact JSON line per completed cycle and one final summary. It exits at either budget, after a batch containing a failure, or on SIGINT/SIGTERM. An existing operation lock or filesystem error aborts without stealing locks or retrying writes. Ordinary completion exits 0, batch failure exits 1, and handled SIGINT/SIGTERM exit 130/143. Active extraction cancellation uses the existing subprocess termination mechanism; idle waits are cancelled promptly. Forced kills can still leave a running receipt or lock requiring explicit recovery.

It acquires the operation lock only for each drain, allowing hooks to enqueue and operators to review between batches. Run one watch process per state store; it is a foreground command, not a daemon or process-liveness registry. It never accepts proposals, runs implementation work, installs a scheduler or restarts itself. Existing failed/running receipts remain skipped until explicit recovery; inspect `status` before starting. Progress is stdout, not a second persistent task ledger. Installing the CLI does not start watch.

## Observation focus

Track long-lived general concerns and temporary project-specific directions together. Explicitly activate, pause or archive directions as priorities change. See [focus directions](docs/focus-directions.md) for commands, the optional starter template, history, collection refresh and analysis-time attribution. Empty findings never prove a direction resolved. Focus configuration does not start a worker or authorize implementation.
