---
name: agent-followups
description: Record evidence-backed independent follow-up work discovered during coding, and resume tasks through Beads without expanding the main task.
---

# Follow-up work

Finish required main-task corrections and validation in the current task. Capture unrelated, concrete bugs or investigation hypotheses with evidence, value, acceptance and a next step. Search existing Beads issues before proposing a duplicate.

Use the configured agent-followups CLI to `record` explicit evidence. Hooks only enqueue observations. An operator runs `drain` to analyze them, reviews `list`, and explicitly `accept`s a candidate into Beads. An accepted proposal authorizes task recording only.

Select the configured external planning store explicitly for task lookup. Use a verified store-aware wrapper (the local pilot uses `followups-beads ready` / `followups-beads show`) or invoke the configured Beads executable with `BEADS_DIR` set to `beadsDir`, inherited `BEADS_DB`/`BD_DB` cleared, sandbox mode enabled and its working directory in that store. Never use unqualified `bd` in a business checkout and assume it selects the follow-up store. Follow the selected repository's authorized workflow. UI-eval owns verification evidence; release tooling owns publication operations and recovery. Link those records instead of copying or upgrading their status claims. Keep reusable project knowledge in its canonical guides.

If Beads creation has an unknown result, inspect Beads for the `agent-followups:<proposal-id>` marker and use `reconcile`; never repeat creation blindly. See the installed project's README for configuration and recovery. Do not automatically install hooks, launch a worker, merge or publish.
