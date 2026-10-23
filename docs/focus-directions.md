# Observation focus directions

## Ownership and scope

Generic session summaries can omit independent findings. Operator-defined directions guide the main agent's evidence collection and the extractor's attention. They are priorities, not mandatory findings, execution authorization, truth verification or a replacement for completing the main task.

The private state's `focus.json` is the canonical current direction document. It is not business knowledge, a UI-eval result or a Beads task ledger. Use the CLI to mutate it; each successful mutation archives the complete validated definition in `focus-history/<content-hash>.json` before switching the current document atomically. README links here rather than duplicating this contract. Direct file edits bypass this history protocol and are unsupported.

## Commands

```sh
agent-followups focus set --input /absolute/private/directions.json
agent-followups focus list
agent-followups focus export > /absolute/private/directions.json
agent-followups focus context --project go-global-app
agent-followups focus pause --id ui-eval-speed
agent-followups focus activate --id ui-eval-speed
agent-followups focus archive --id ui-eval-speed
agent-followups focus list --revision REVISION_HASH
```

Set replaces the full document, not a partial patch. Export the current document, edit that private copy, then set it. List includes a computed revision; export intentionally omits it for round-trip editing. Pause/archive/activate change one existing direction; archival is reversible through explicit activation. These mutations use the same operation lock as drain and proposal decisions. During an active batch a mutation refuses the lock; stop the runner or retry explicitly between batches. No command automatically pauses a direction, accepts a proposal or closes an existing task.

## Definition contract

`examples/focus.json` contains three general directions and three UI-eval directions. It is an optional starter template, not automatically enabled by package installation. Adapt target project IDs to the configured project allowlist before setting it.

Each direction has a stable ID, active/paused/archived status, general/targeted layer, project IDs, question, lookFor, evidenceRequired, exclude and exitWhen. An empty project list means all configured projects and is allowed only for general directions. Targeted directions require explicit projects. Both layers use the same evidence and authorization rules; layer is descriptive and does not impose proposal quotas or scoring.

At most eight directions may be active, and their combined serialized context is capped at 12,000 characters. Full documents may retain up to 30 directions including paused/archived history references. Changing wording, order, scope or status changes the content-derived revision; restoring identical content restores its revision. The CLI validates IDs, scopes and budgets before replacing existing definitions. History retrieval verifies its hash and does not grant current project access.

## Collection, extraction and attribution

A new SessionStart receives active directions applicable to its source project. Updating definitions does not rewrite an existing session's context. Run focus context explicitly and provide the refreshed result to that session, or start a fresh session with the trusted collector. The context reports its revision. This release does not attest which revision an existing main agent actually read.

Every analysis reads a current direction snapshot under the operation lock, including all active target scopes so cross-project findings remain possible. Watch naturally reloads it per event/batch. A pause affects subsequent analysis; already processed events are not re-extracted automatically. Delayed events are analyzed using analysis-time focus, not a reconstructed collection-time focus. Empty-evidence markers skip the model. `no_findings` remains valid, and useful independent findings outside active directions may use an empty match list.

With active directions, model output must contain focusIds. Code rejects unknown, inactive, duplicate or wrong-target matches before saving any proposal in that batch. Whether a finding actually satisfies a direction's semantic evidence requirements still requires model judgment and operator review; matching is not an attestation of truth.

Each proposal retains analysis associations as focusRuns: event ID, full direction-document revision and matched direction IDs. Runs also retain their active snapshot, and successful check receipts include the revision. Duplicate findings add associations while preserving the original reviewed candidate and decision. Existing event/proposal files remain readable; older proposals have no focus associations. Import descriptions and Markdown exports include the available provenance. A Beads description is a snapshot at import, not a live mirror of later duplicate observations or direction changes.

## Reviewing and retiring directions

For UI-eval, speed requires measured stage duration or repeated-operation traces; efficiency requires scenario scope/intervention records; accuracy requires an automated result plus independent counterevidence. Link canonical UI-eval runs rather than copying acceptance claims. Establish actual baselines and agreed targets before judging improvement. No numerical target is invented by the template.

Several empty extraction results are a review signal, not evidence that a direction is resolved. Review representative runs and canonical acceptance evidence, then explicitly pause or archive the direction. Existing proposals, Beads tasks and history remain available. Replace a direction when the next period's priorities change; do not rewrite its old meaning under an old revision.

## Storage and import guards

JSON writes are checked against the same byte limit as reads before publication. If duplicate provenance would exceed that limit, the analysis fails while preserving the previous readable proposal; original events and the failed check remain available for operator recovery. Associations are never silently truncated. This prototype does not shard provenance automatically.

A restored proposal must have an internal ID matching its filename before duplicate updates, decisions, imports or reconciliation. New Beads imports also revalidate the target against the current project allowlist. Removing a project does not erase its historical proposals, but prevents new imports for it. Existing unknown-write reconciliation remains an identity-checked recovery operation, not a new task creation.

Queued events also revalidate their source project before any provider call. Revoked-source evidence receives a failure receipt and remains private for explicit operator recovery.

Beads descriptions use its `--body-file -` stdin interface, avoiding command-argument limits. Other arguments are bounded before creation intent. External Beads IDs are limited to 512 ASCII identity characters by this adapter. Before creation, the writer reserves receipt headroom for that bound. If provenance prevents that reserve or makes the description too large, the exact original proposal is retained through an immutable content-addressed hard link in `provenance-archives/`; the current record links that archive and clears only the now-archived association arrays. Nested archive references retain earlier snapshots. The same path allows reconciliation of near-limit legacy intents. Candidate content and current import outcome stay in the current proposal; archive statuses are historical, not a second current-status ledger. Markdown/Beads descriptions expose the private archive reference, and no associations are silently discarded. These guarantees require the documented local filesystem and atomic-write protocol, not arbitrary in-place editing of archive files.

Project paths/allowlists, executable paths and provider settings are startup configuration. Stop a running watch before changing project authorization, then restart it with the updated config; editing a config file does not revoke an already-running process's in-memory configuration. Focus definitions are the separately reloadable state described above. Source/target revocation checks use the configuration supplied to each operation.

Reading historical/current definitions does not require their old project scopes to remain authorized. Context generation intersects active scopes with the operation's current allowlist, excludes directions with no surviving target, and preserves the original full-document revision for audit. Remaining projects continue normally after another project is removed. New operator mutations still validate scope strictly; export and correct stale scope references before replacing the document.

Candidate updates are staged in memory: all existing identities and serialized replacement sizes are validated before any proposal is published. Known data-validation failures therefore cannot leave earlier candidates from that batch behind. Publication remains a sequence of atomic per-file replacements, not a multi-file transaction: an actual filesystem failure can still leave partial updates. Inspect proposal/event associations and the failed receipt before explicit recovery; never interpret a partial store as an automatically accepted task.
