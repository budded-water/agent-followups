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

- Node.js 24+ and npm.
- An authenticated Codex CLI with `exec --ignore-user-config`, `--ephemeral`, `--output-schema` and `--output-last-message` support. Development targets Codex CLI 0.160.1; check your installed CLI before use.
- Beads CLI; the integration targets the v1.3.1 command contract. Initialize an external planning workspace separately. Embedded Beads needs no separate Dolt CLI; concurrent writers require appropriate Beads coordination/server configuration.

```sh
git clone https://github.com/budded-water/agent-followups.git
cd agent-followups
npm ci
npm run check
npm link
agent-followups --help
```

The CLI has one runtime npm dependency, Zod. TypeScript is compiled at build time. No native database package, Redis, agent SDK, Gas Town or web server is required. This project is not published to the npm registry by this workflow.

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

No daemon is installed. Hooks provide durable collection; someone must run `drain`, directly or using a separately configured local scheduler. A 3-second hook timeout may still prevent collection on a slow filesystem. Test the actual client lifecycle; printing a valid definition is not acceptance.

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
agent-followups accept --config /absolute/private/followups.json --id PROPOSAL_ID
agent-followups reject --config /absolute/private/followups.json \
  --id PROPOSAL_ID --reason "Already tracked or not worth pursuing"
```

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
- Extraction writes a running receipt first. Failed/interrupted checks are not retried automatically. After resolving the cause, use `retry --id EVENT_ID --reason "..."`. Recovery preserves the previous receipt.
- Beads creation persists an `accepting` intent before the write. A timeout, invalid reply or crash may leave a task created with no local acknowledgement. Do not repeat creation. Search Beads for `agent-followups:PROPOSAL_ID`, then use `reconcile --id PROPOSAL_ID --bead EXISTING_BEAD_ID`; the CLI verifies the marker before attaching it. If no task exists, manual investigation/recovery is required; there is deliberately no blind reset.
- Evidence, model output and event receipts live under private state. Raw subprocess stderr is not copied into public errors. The Codex provider receives supplied evidence during `drain`; private local storage does not make model processing offline.
- Keep the whole state directory and the Beads database backed up separately. No automatic retention, remote backup or installation-wide resource manager is included.

## Validation scope

`npm run check` builds TypeScript and runs behavioral tests with isolated directories and fake external commands. The suite covers queue idempotence, hook filtering, opt-in prompt collection, output validation, duplicate proposals, explicit retry, lock exclusion, uncertain Beads writes and reconciliation. Tests do not certify installed Codex hook trust, real model quality, concurrent Beads writers, simulator acceptance or store release readiness. See [architecture](docs/architecture.md) and [validation](docs/validation.md).

## License

MIT. Beads, Codex and other invoked tools retain their own licenses and terms. No upstream source is vendored.
