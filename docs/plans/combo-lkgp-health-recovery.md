# Combo LKGP Health Recovery - Implementation Status and Plan

## Implementation instructions
- Use OpenCode with the configured `coding-pro` orchestrator and specialists per the latest user instructions; do not substitute or invent model configuration.
- Keep work local on branch `fix/combo-health-recovery`. Implementation remains uncommitted: no commit, push, or deployment.
- Final documentation/cleanup is performed only via a synchronous fixer. Restore only the full-suite-generated `tests/translator/__snapshots__/golden-url-header.test.js.snap` to HEAD; retain validation artifacts and unrelated work.

## Actual implementation status
The local implementation covers opt-in fallback combo health/cooldown and bounded recovery. UI is untouched. This is locally tested implementation, not upstream or deployment acceptance.

| Area | Implemented scope |
|------|-------------------|
| Fallback health | Explicit per-combo opt-in, Retry-After cooldown floor, request-scoped 4xx without health penalty |
| Ordering | Capability filtering before LKGP ordering; restore higher manual priority on successful recovery |
| Recovery | One bounded privacy-safe recovery probe per combo, timeout cancellation and stale/late-result guards |
| Persistence | Health revision tokens and process-local serialization for health/pin mutations |
| Wiring | Direct/nested combo wiring, with nested auto state left untouched |
| Regression coverage | Toggle-off/non-fallback behavior, capability mismatch, cooldown, recovery, timeout and concurrency cases |

### Implementation files
- `open-sse/services/comboHealth.js`: shared health/recovery helpers.
- `open-sse/services/combo.js`: fallback health and recovery integration.
- `open-sse/handlers/chatCore.js`: request/probe handling support.
- `src/lib/db/repos/comboLkgpRepo.js`: health persistence, revision checks and process-local serialization.
- `src/sse/services/comboHealthService.js`: bounded recovery service and injected dependencies.
- `src/sse/handlers/chat.js`: health service and direct/nested combo wiring.
- `tests/unit/combo-health.test.js`, `tests/unit/combo-health-repo.test.js`, `tests/unit/combo-health-service.test.js`, `tests/unit/combo-health-integration.test.js`: focused coverage.

## Persistence/service design and boundaries
- `createComboHealthRepo({ store = makeKv("comboState") })` accepts an injected async KV (`get(key, fallback)` / `set(key, value)`). Health keys encode `health:[combo,member]`; existing `lkgp:<combo>` keys remain compatible. Shared per-store/key promise queues serialize in-process mutations across repository instances. Success requires an unchanged revision token, including equal-clock failures.
- `createComboHealthService({ store, executeProbe, now, timeoutMs })` supports attempt tracking, failure/success recording, attempt ordering and recovery. `executeProbe({ combo, model, body, signal })` returns a non-streaming Fetch `Response`. Request-scoped failures do not incur health penalties; probe 4xx other than 408/429 are request-scoped.
- Recovery returns a status such as `busy`, `idle`, `recovered`, `failed`, `timeout`, `stale`, or `request-scoped`. A process-local probe lock and generation guard bound execution/payload reading and reject late completion. Bodies are consumed or cancelled. Sanitized source-shaped probes reuse `buildAutoProbeBody` read-only; only text/tool payloads count. Recovery prefers the earliest healthy manually ordered member over a lower-priority pin.
- The original bounded repository/service slice has now been wired into the combo handler. Verification of wiring is limited as described below; it is not an HTTP acceptance claim.

## Actual verification results
These are the completed validation results supplied for this work, not fresh runs during documentation cleanup.

| Check | Actual result |
|-------|---------------|
| Focused tests | **137 passed** |
| Build | `npm run build` with `DATA_DIR` set to the worktree's `.validation-data`: **exit 0** |
| Exact baseline | Commit `1a913d69`: **4531 passed**, **16 failed files / 26 failed tests** |
| Final full suite | **4592 passed**, **16 failed files / 26 failed tests** |
| Baseline comparison | Final failed-file set is **identical** to the exact baseline; **no new failed files** |

**The whole suite is NOT green.** Matching the baseline failed-file set does not establish upstream or deployment acceptance.

An initial run also observed an extra `zed` failure. Its isolated rerun passed all **12 tests**, and that failure was absent from the final full-suite rerun. This is a **flaky observation**, not a proven fix or an additional final failed file.

The final suite generated snapshot changes in `tests/translator/__snapshots__/golden-url-header.test.js.snap`; final cleanup restores that file only to HEAD. Validation logs/data are retained.

## Verified scope versus remaining limitations
- Tests exercise the **actual combo handler with injected store/provider dependencies**, plus **source assertions for direct/nested wiring**. They do not exercise real upstream services or HTTP local-auth integration.
- Locks and persistence serialization are **process-local**, not distributed compare-and-swap (CAS). Multi-process writers are not covered.
- Storage is assumed finite; this work does not establish unbounded-storage behavior.
- Membership rename/delete lifecycle behavior is **not fully exercised**.
- UI is untouched; there is no UI acceptance claim.
- No deployment acceptance has been performed. Build success and local tests do not establish production readiness.
- All changes remain local and uncommitted on `fix/combo-health-recovery`; no commit, push, or deploy is part of this work.

## Follow-up acceptance (not completed)
Real upstream and HTTP local-auth integration, distributed-writer guarantees if required, fuller membership rename/delete lifecycle coverage, and deployment acceptance remain separate work. Preserve the distinction between injected local handler tests, source-level wiring assertions, and end-to-end acceptance when reporting results.

## Stage 2 — real HTTP against a loopback mock provider (`scripts/qa/combo-health-http.mjs`)

Harness: standalone Next server on an ephemeral loopback port, fresh `DATA_DIR` per run, mock OpenAI-compatible upstream, remote egress blocked, independent combos per scenario (`qa-direct`, `qa-nested`, `qa-concurrent`, `qa-toggle`, `qa-members`).

Result: **17/17 assertions pass on two consecutive runs**; `report.json` `passed: true`; both ports confirmed closed. Covered: direct and nested combo health, combo failure distinct from account lock, skip while cooling, persistence across restart, expiry probe, single concurrent probe, toggle-off bypass, membership reorder, removed member never used.

### Defect this stage found (fixed)

**Symptom:** after the expiry probe cleared `qa/primary` failures, `lkgp:qa-direct` still pointed at `qa/fallback`, so the next request served fallback. Health showed both members healthy.

**Cause:** pin promotion was guarded by the attempt's pin generation. A main request that started before the probe could finish its fallback success afterwards and bump the generation, so the probe's promotion of the earlier manual member was rejected as stale. The reverse ordering could also let a late lower-priority success overwrite a fresh recovery pin.

**Fix:** `setPin(combo, model, attempt, { members })` — on generation mismatch, accept only when member order proves the new model is strictly earlier than the current pin; otherwise reject. Recovery passes the member list and targets the earliest healthy concrete member. Plain stale successes without member order are still rejected.

**Deterministic coverage:** repo tests for earlier-priority promotion accepted, late lower-priority success rejected, plain stale rejected; service test where a later member success bumps the pin mid-probe; service test where an older lower-member success cannot replace a newer recovery pin. Focused suite after the fix: **141 passed / 7 files**.

The harness assertion stays intact: it waits up to 5 s for the pin to return to primary, then asserts the *next* request is answered by primary and adds no fallback traffic. Both runs observed `waitMs: 0`.
