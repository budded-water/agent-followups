# Proposal review and duplicate suggestions

A historical finding can be correct for its recorded source and already addressed today. Model certainty is not current-state verification. Operators inspect canonical code/evidence and existing Beads work before creating a new task. This module stores that assessment; it does not inspect repositories or use a model.

## Operator workflow

```sh
agent-followups similar --id PROPOSAL_ID
agent-followups review set --id PROPOSAL_ID --input /absolute/private/review.json
agent-followups review show --id PROPOSAL_ID
agent-followups review show --id PROPOSAL_ID --revision REVIEW_HASH
agent-followups accept --id PROPOSAL_ID
```

Example private review input:

```json
{
  "reviewer": "operator",
  "verdict": "current",
  "reason": "Reproduced against the inspected source; existing task lookup found no duplicate.",
  "checkedAgainst": [{"source": "canonical repository", "revision": "inspected commit or content hash"}],
  "evidence": [{"source": "private reproduction record", "summary": "The recorded behavior still occurs."}]
}
```

Allowed verdicts are current, resolved, duplicate and needs_investigation. Duplicate requires duplicateOf with a same-project proposal ID. Other verdicts forbid duplicateOf. Links neither merge nor delete candidates, move evidence, reject a proposal or close a Beads task. A duplicate cannot target itself or another duplicate; a target with incoming links cannot become a duplicate. Correct the incoming reviews explicitly before changing the canonical target. These constraints include stale links to avoid hidden cycles.

Only proposed candidates can receive new review decisions, and their project must still be configured. Existing imported task status belongs to Beads. Rejected/importing/imported records retain historical review inspection, but cannot be re-reviewed through this command. Resolving or linking an existing Beads task remains an explicit Beads operation.

## Import gate and history

Every new import, including legacy proposals, requires a valid latest review with verdict current. This is an intentional import compatibility change. Unreviewed, stale, resolved, duplicate and needs_investigation reviews block before any Beads call or acceptance intent. Already accepted imports remain idempotent, and interrupted-write reconciliation remains available without a new review; it recovers the recorded write rather than authorizing another.

The operator record carries checkedAt, source identities, evidence, reason and reviewer. It is bound to the candidate content and its event, parent, focus and archive associations. New duplicate observations invalidate an earlier review even though the original candidate text is preserved. Re-review explicitly after inspecting the new information.

Immutable content-addressed records live in review-history/PROPOSAL_ID/REVIEW_HASH.json. reviews/PROPOSAL_ID.json selects the latest review. History is published and verified before the pointer switches atomically, under the shared operation lock. An unreferenced history file after a filesystem failure is not an active decision. Hash and proposal identity mismatches fail closed. Back up the whole private state, including review history. The import receipt and Beads description pin the review revision used for creation. Provenance compaction retains that pin. Historical review retrieval compares the old subject with the current proposal and may report stale; it does not replace the latest decision.

Source identities and evidence are operator-supplied attestations. The command does not authenticate a reviewer, fetch a commit, prove a reproduction or monitor external source changes. A review may become outdated when external code changes even if the proposal snapshot remains unchanged. Inspect and refresh it before import. The local filesystem and cooperative single-store writer protocol remain the supported environment; this is not protection against same-user edits or concurrent external Beads writers.

## Similarity suggestions

similar uses local normalized text overlap in titles/rationales/next steps and exact trimmed evidence-source equality. It returns at most ten same-project candidates with scores, shared terms and source-match reasons. It reads at most a 1000-proposal store; larger stores refuse rather than silently hide unscanned candidates. Revoked projects refuse new scans. Inspection can include proposed, rejected or imported records so earlier decisions are visible.

This is an explainable shortlist for operator semantic review, not embeddings, an LLM judge, equivalence proof, calibrated confidence or automatic deduplication. It can miss different-language paraphrases and suggest unrelated findings sharing vocabulary or a generic source. Compare the evidence and actual entities, and check Beads separately. Exact normalized-title IDs remain unchanged for compatibility. Similarity does not call providers, merge records, mark reviews or grant execution authority.

Markdown export shows the latest review validity and verdict. Proposal list/status remain proposal/import receipt views; review show owns detailed review provenance. No background verification, automatic acceptance, implementation, merge or publication is introduced.
