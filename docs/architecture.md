# Architecture and ownership

## Scope

The reusable unit is evidence-backed follow-up discovery. Keep it independent from product repositories, verification engines and release orchestrators. Initial execution is explicit and local; there is no unattended implementation scheduler.

## State transitions

Events are content-addressed immutable inputs. Checks transition from absent to running to succeeded or failed. A crash can retain running; an explicit retry archives that receipt and makes the event eligible again. A successful no-findings result is a completed check. Unreadable, invalid or ID-mismatched events receive a failure receipt without changing their original bytes; they consume a drain slot but do not abort unrelated queued work. They require operator repair of the original evidence/access plus explicit retry.

Proposals transition from proposed to rejected or accepting to accepted. The accepting state is written before a Beads create call. An unknown write outcome remains accepting and requires a matching existing Beads task to reconcile. A successful import never repeats creation. Subsequent duplicate observations add provenance without overwriting the original decision or reviewed proposal.

A single operation lock serializes analysis and decisions. Hooks use exclusive create for immutable events and do not acquire that long-lived lock. Atomic JSON writes use a temporary file plus rename. This provides process-level recovery on a local filesystem, not power-loss durability, distributed locking, protection against a same-user attacker, or a transaction with Beads. Back up runtime state and Beads separately.

## Integration boundaries

Codex hooks carry lifecycle events. They cannot guarantee useful semantic discoveries, and forced shutdown may skip them. User-scoped registrations require normal client trust. Beads provides canonical imported task state and discovery dependencies; external tickets must use explicit ownership and links rather than a second status copy. Project guides remain canonical for reusable knowledge.

The extractor receives selected observations, not arbitrary filesystem access supplied by this application. Prompt content is data, schema validation is mandatory, and approval of a proposal does not grant authority to execute its nextStep. Internal analysis is marked to avoid hook recursion, and user config/hook/tool defaults are restricted. Managed policies and external CLI behavior remain deployment dependencies.

UI-eval owns scenario execution, verification plans and evidence reconciliation. Release automation owns source/artifact identity, publication intent, locks and provider recovery. Store links to their records in Beads. Do not infer UI acceptance from static checks, or publication readiness from a closed task. Resources such as simulators and devices must remain coordinated by their existing execution owners.

## Deduplication

Event IDs hash sanitized input. Proposal IDs hash normalized title and target project. The latter intentionally avoids an additional model call: it is deterministic but misses differently worded duplicates. Acceptance inspects same-project Beads titles and global import markers; unscoped matching titles require manual duplicate review; independent external writers can race this preflight. One runner/state store per planning workflow is the supported deployment. Semantic duplicate review remains an operator responsibility.

## Queue visibility

`status` inspects immutable events, their analysis receipts and proposal/import receipts without provider calls or repair. It reports a best-effort snapshot because hook writers and explicit recovery may run concurrently. Lock presence and running receipts do not attest process liveness. Hook timestamps do not attest trust or complete lifecycle coverage. Beads retains canonical imported task status; status counts accepted import receipts only. Unreadable/invalid recognized records are counted separately rather than reported as empty or successful.

## Explicit bounded analysis loop

`watch` repeatedly invokes the existing drain with required polling and total event budgets. The README owns option bounds and exit semantics. Each batch takes the existing operation lock; idle intervals hold none. Failure stops the loop after the current batch without retrying previous receipts or Beads writes. SIGINT/SIGTERM cancellation preserves existing subprocess cleanup and recovery behavior. No background service, automatic restart, task acceptance or implementation executor is installed. A runner's presence must not be inferred from lock presence because it releases the lock between batches.
