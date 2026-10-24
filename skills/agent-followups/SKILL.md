---
name: agent-followups
description: Record evidence-backed independent follow-up work discovered during coding, and resume tasks through Beads without expanding the main task.
---

# Follow-up work

Finish required main-task corrections and validation in the current task. Capture unrelated, concrete bugs or investigation hypotheses with evidence, value, acceptance and a next step. Search existing Beads issues before proposing a duplicate.

Use the configured agent-followups CLI to `record` explicit evidence. Hooks only enqueue observations. An operator runs `drain` once or explicitly starts bounded foreground `watch` to analyze them, reviews `list`, and explicitly `accept`s a candidate into Beads. An accepted proposal authorizes task recording only.

Select the configured external planning store explicitly for task lookup. Use a verified store-aware wrapper (the local pilot uses `followups-beads ready` / `followups-beads show`) or invoke the configured Beads executable with `BEADS_DIR` set to `beadsDir`, inherited `BEADS_DB`/`BD_DB` cleared, sandbox mode enabled and its working directory in that store. Never use unqualified `bd` in a business checkout and assume it selects the follow-up store. Follow the selected repository's authorized workflow. UI-eval owns verification evidence; release tooling owns publication operations and recovery. Link those records instead of copying or upgrading their status claims. Keep reusable project knowledge in its canonical guides.

If Beads creation has an unknown result, inspect Beads for the `agent-followups:<proposal-id>` marker and use `reconcile`; never repeat creation blindly. See the installed project's README for configuration and recovery. Do not automatically install hooks, launch a worker, merge or publish.

For failed analysis, inspect its receipt and private attempt artifacts before explicit `retry`. A saved publication plan is replayed without another model call; never remove it to force re-extraction. Legacy partial publications without a plan require manual recovery. Missing project roots disable that scope while healthy projects and historical inspection remain available; restart after correcting availability. Use one compatible worker/recovery CLI version per store.

Use `agent-followups focus context --project PROJECT_ID` to refresh active observation priorities in an existing session. Follow the installed focus guide for explicit set/pause/archive/activate commands; preserve evidence ownership and never generate findings just to satisfy a direction. Pausing a direction does not close imported tasks.

Before a new import, inspect `similar --id ID`, verify current source/evidence and existing Beads tasks, then explicitly record `review set --id ID --input FILE`. Use checked source identities and evidence, not the model certainty label. Only a valid `current` review permits import; resolved, duplicate, unreviewed, stale and needs-investigation records do not. See the packaged docs/proposal-review.md. Reviews do not authorize task execution.
