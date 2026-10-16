# CRSF mutation (known-bad) cases

`cases.json` holds version-controlled mutation cases. Each case proves that a mapped security test fails **for the intended reason** when one specific security property is broken. Reproducible KILLED results are CRSF evidence level E4.

## Case fields

| Field | Meaning |
|---|---|
| `id` | `MUT-<control>-<property>-<origin>` |
| `targets` | the exact control sub-properties the mutation violates |
| `evidence_id` | the `EV-KB-*` evidence item in `security/crsf/evidence.json` that this case backs |
| `edits` | deterministic transformations: each `find` text must occur **exactly once** in `file`; it is replaced by `replace` |
| `tests` | test files to run against the mutated copy |
| `environment` | `node`, optionally `postgres` (disposable Postgres via `M1_DB_TEST_PG_URL` + `M1_DB_TEST_PG_MODULE`) |
| `expected_failures` | regexes for the failing test name (and optionally its assertion message) that count as the intended reason |
| `expected_result` | `KILLED`, `SURVIVED` for a documented test gap, or `EQUIVALENT` with a written proof |
| `detection` | `behavioral`, or `static` when only source-text/export checks catch it (recorded, never E4) |

## How a run works

1. `security:verify` copies the tracked and untracked (non-ignored) files into a temporary directory, symlinking `node_modules`. The working tree is never modified, and the copy is deleted in `finally` and on process exit.
2. **Baseline:** the unmutated copy must pass every mapped test. If it doesn't, all cases are `INVALID`.
3. Each case is applied, its tests run, and then the edit is reverted:
   - `KILLED`: an expected failure occurred and nothing was cancelled.
   - `KILLED_OTHER`: tests failed, but not for the intended reason (never counts).
   - `SURVIVED`: all tests still pass (never counts, and blocks E4 for that property).
   - `INVALID`: an anchor wasn't unique, the executor errored, or tests were skipped.
   - `NOT_RUN`: a required capability is missing.
4. If any declared `expected_result` differs from the observed result, the framework is invalid for that run.

## Adding a case

1. Pick one control sub-property and write the smallest edit that violates exactly that property.
2. Run the case and read the failing test names and messages. Set `expected_failures` only to tests that check that property; a failure elsewhere is the wrong reason.
3. Set `detection: static` if only source-text checks catch it.
4. Add the case to the matching `EV-KB-*` evidence item's `execution.mutation_ids`, and add the property to that item's `covers` (the verifier checks that these agree).
5. Run `node security/crsf/generator/crsf-gen.mjs --write`, then `npm run security:framework-test` and `npm run security:verify`.

## Provenance

The cases were rebuilt from the Phase-1 scratchpad harnesses (L2, L3, L4, H2, L1, L5). Each was re-run from a clean copy, and its expected failures were pinned to the property-specific tests. Phase 2A added new cases for SIWE fields, the EOA signature result, ERC-1271 magic value and consensus, token MAC, the webhook secret, update deduplication and the cron secret.

`MUT-CR-API-002-P1-NEW1` (cron secret check removed) **survives**: no test calls `/api/alerts` without `CRON_SECRET`. It is declared `SURVIVED` on purpose, as a recorded test gap.
