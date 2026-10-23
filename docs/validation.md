# Validation and rollout

## Required checks

Run `npm ci`, `npm run check` and `npm pack --dry-run` on the source to be delivered. CI uses Node 24 and 26 on Linux. The local development environment uses macOS arm64; provider calls in automated tests are replaced by explicit fakes.

## Runtime acceptance steps

1. Initialize a private external Beads planning store and create a synthetic parent task.
2. Record bounded synthetic evidence, run a real authenticated Codex extraction, inspect proposals and accept one into Beads.
3. Inspect the imported description, acceptance, target project and native discovery relation. Verify a repeated accept creates nothing new.
4. Merge generated handlers with existing user-scoped hooks, review/trust them in Codex, and start a fresh session in an explicitly configured project.
5. Verify actual startup context and queued Stop observation, including a discussion without code changes. Check outside-project and extractor recursion exclusions.
6. Exercise a failed extraction and explicit recovery; inspect a simulated unknown Beads creation and reconciliation without duplicate writes.

Direct hook payload tests establish handler behavior only. Real client acceptance, provider behavior and task usefulness need their own evidence. No step authorizes code execution, merge, release, simulator changes or modification of existing tool configuration beyond the explicitly installed handlers.

## Useful pilot measurements

Measure observed hook collection coverage, extraction failures, useful accepted findings, duplicate/rejected proposals, and the time/cost of extraction. Sample sessions manually for missed findings; an empty queue alone cannot establish that no issues were missed.

## Initial development observations

On 2026-10-23, a macOS arm64 synthetic run used the real Codex CLI 0.160.1 with the restricted extraction configuration and Beads v1.3.1 in a temporary planning workspace. Extraction returned one proposal; explicit acceptance created a Beads task with its acceptance field and native discovery-parent relation. This establishes that limited external CLI path, not model recall, actual user-scoped hook delivery, a background service, product UI acceptance or any release operation. The automated suite uses fakes so CI requires neither credentials nor those CLIs.

For queue visibility, test an empty store, CLI JSON output, pending/running/failed/succeeded events (including no findings), malformed receipts/proposals, unknown import intents, and status reads while another operation owns the lock. Assert private evidence is absent from the summary and records/locks are preserved. Status output alone does not establish hook trust, worker scheduling, process liveness or current Beads task status.

For the foreground runner, cover total event budget versus larger batch/queue sizes, idle cycle bounds, observations arriving between cycles, stopping after extraction failure, pre-aborted/idle cancellation, lock refusal, option rejection, CLI NDJSON, and SIGTERM while idle and during an active controlled extractor. Verify process exit codes, lock release and preservation of failed receipts. These tests use fake providers; they do not establish unattended scheduling or live model quality.

Cancellation regressions also cover a stop at the subprocess boundary before startup and a supplied AbortSignal during an active controlled extraction. Verify no post-cancellation provider startup, child termination, failure receipts and lock release.
