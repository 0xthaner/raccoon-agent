# CRSF — CoverRaccoon Security Framework

CRSF is the version-controlled definition that maps CoverRaccoon against pinned external standards (OWASP ASVS 5.0.0 and others), the security evidence for it, and the runner that reproduces the evaluation for one commit:

```sh
npm run security:verify          # recompute and execute everything; writes security/reports/out/
npm run security:framework-test  # generator up to date + verifier self-tests (known-bad fixtures)
```

## What CRSF is — and is not

- **It is:** a derivation chain from pinned standard → external requirement → CRSF control → sub-properties → required evidence → status. Each status is computed by `scripts/security-verify.mjs` from the evidence actually executed for the commit.
- **It is not:** a certification, an audit opinion or a compliance claim. CoverRaccoon is *mapped against* and *evaluated against* ASVS and the other sources. A PASS says the evidence CRSF requires exists and ran; it does not say "secure".

## Sources

The pins live in `sources.json`. They cover:

- **OWASP:** ASVS 5.0.0 (vendored requirement file in `vendor/`, checksum-verified) and its Appendix C; API Security Top 10 2023.
- **Ethereum:** ERC-4361, ERC-191, ERC-1271, the Ethereum Yellow Paper and execution-specs.
- **Wallets and platforms:** Safe; Telegram Bot API; PostgreSQL 17.
- **Supply chain:** NIST SSDF 1.1, OpenSSF Scorecard, the OSSF npm guide, SLSA 1.2.
- **Hosting:** Vercel documentation.

Profile: ASVS L2 baseline plus selected L3 requirements (`profile.json`).

## Files (JSON is authoritative)

| File | Role |
|---|---|
| `sources.json`, `profile.json`, `drift-model.json` | inputs |
| `controls.json` | control definitions (inputs) + computed fields written by the generator |
| `evidence.json` | evidence items, their property coverage and how each one executes |
| `deviations.json` | protocol/platform deviation records; status computed |
| `asvs-applicability.json` | every ASVS 5.0.0 requirement: applicability + reason (inputs), mapping and conformance (computed) |
| `framework-lock.json`, `framework-changes.json` | version lock and change record (see below) |
| `CRSF-1.0.md` | **generated** from the JSON; never edit by hand |
| `schema/*.schema.json` | strict schemas (unknown fields and enum values fail) |
| `../mutation/cases.json` | mutation (known-bad) cases |

The computed fields include statuses, coverage, reasons, independence and ASVS conformance. The verifier recomputes them and fails if a recorded value differs. A hand-edited status is therefore rejected (`STATUS_NOT_RECOMPUTABLE`), and so is a status override flag (`MANUAL_OVERRIDE`).

## Two separate axes

- **Security assurance:** `PASS_AUTOMATED`, `PASS_MANUAL`, `MISSING_EVIDENCE`, `FAIL`, `INFORMATIONAL`, `NOT_APPLICABLE`, `DEFERRED`.
- **Standard conformance:** `CONFORMANT`, `NON_CONFORMANT`, `NOT_DEMONSTRATED`, `ACCEPTED_PROTOCOL_DEVIATION`, `ACCEPTED_PLATFORM_DEVIATION`, `NOT_APPLICABLE`, `DEFERRED`.

The two axes are never merged into one score.

What the security statuses mean:

- **`PASS_AUTOMATED`:** every sub-property is covered by reproducible evidence at or above the control's minimum level, and that evidence passed in this run.
- **`PASS_MANUAL`:** the same, but with a dated manual record. This is only allowed for `MANUAL_ASSURANCE` controls or controls with `automation: NO`, and never for `RELEASE_BLOCKING` ones.
- **`MISSING_EVIDENCE`:** a sub-property is not demonstrated. This is the default whenever anything is ambiguous, partial, too weak, or didn't run.
- **`FAIL`:** an evidence finding shows the requirement is violated. A FAIL can only disappear through a recorded change.
- **`INFORMATIONAL`:** an accepted, validated deviation covers the conformance property, and every remaining security property is satisfied. It is **never** counted as PASS.

### Sub-properties

A control lists properties P1..Pn. Each one needs its own satisfying evidence, so strong evidence for P1 says nothing about P2. There is no "maximum evidence level wins".

## Evidence levels

| Level | Meaning |
|---|---|
| E0 | none |
| E1 | static/config/manual inspection |
| E2 | positive behavioural test |
| E3 | negative/adversarial behavioural test |
| E4 | reproducible known-bad/mutation proof: KILLED by the intended test, with behavioural detection |
| E5 | real-system proof (real Postgres, real concurrency) |
| E6 | independent external review (never claimed) |

Minimum levels by release class:

- `RELEASE_BLOCKING`: E4 for auth/authorization/replay, E5 for concurrency/atomicity, otherwise E3.
- `MANUAL_ASSURANCE` and documentation controls: E1.

Executable evidence only counts if it ran in this run and passed. Evidence that couldn't run (for example, no Postgres) counts as missing.

An evidence item may not declare a level above the cap of its type (`evidence_level_cap_by_type`). Reproducible `real-system` evidence must also require a real-system capability such as Postgres; a plain Node test cannot call itself real-system (`REAL_SYSTEM_WITHOUT_INFRASTRUCTURE`).

### Structural properties (one owner-approved exception)

`profile.structural_property_rule` lets exactly the listed properties — currently CR-SESSION-001 P2 (constant-time MAC compare) and P3 (fixed algorithm and key) — be met by **structural** evidence at E1. Such evidence must:

- be static and executable, so it is re-checked every run;
- name a Node standard-library primitive, the exact `file:line` call site, `standard_library: true` and `client_selectable: false`.

The property must also be marked `evidence_basis: STRUCTURAL` in its control. Any other marker, misplaced structural evidence, or a widened allowlist without a version is rejected. A property met only this way is reported as *structurally verified, not behaviourally mutation-proven*. (In 1.0-draft-phase2d both properties also have behavioural E4 proof.)

## Deviations

A deviation exists only for a **CONFORMANCE** property that has a **VIOLATION** finding. It needs pinned protocol or platform sources and every eligibility criterion met:

- **Protocol deviations:** criteria A–G.
- **Platform deviations:** criteria PD1–PD5, plus D and E.

On top of that, a deviation must target exactly one requirement and one control, must not hide a FAIL of the listed implementation controls, and must carry review triggers. Its status (`ACCEPTED` / `REJECTED` / `REQUIRES_REVIEW`) is computed.

`owner_signoff` stays `PENDING` until the repository owner reviews the record. Tooling never sets `APPROVED`, and `APPROVED` requires a sign-off record.

Current records:

- **DEV-PROTO-001 (secp256k1 ECDSA) and DEV-PROTO-002 (Keccak-256).** These primitives are required by Ethereum, ERC-191 and SIWE. CoverRaccoon only uses established libraries (viem → @noble) and has no local primitive implementation.
  - Their security properties remain enforced, so the security status is `INFORMATIONAL`.
  - Evidence question Q-CRYPTO-LOW-S is answered by `probes/ecdsa-low-s-probe.mjs`: high-s twins are accepted. That is classified INFORMATIONAL, not an auth bypass, because challenges are single-use and signatures are never stored.
- **DEV-PLAT-001 (Vercel forces HTTP→HTTPS redirects on `/api`).** The conformance axis shows the accepted platform deviation. The security status stays **`MISSING_EVIDENCE`**, because the HSTS evidence is only a manual production record.
  - HSTS state, HSTS preload state and the production redirect behaviour are recorded as separate evidence properties.
- **DEV-CAND-001..003:** rejected candidates, kept for audit.

## Running verification

- **Node 24** (`engines.node`). On another Node major, all executable evidence is `NOT_RUN`, and therefore missing.
- **Optional disposable Postgres:** set `M1_DB_TEST_PG_URL` and `M1_DB_TEST_PG_MODULE` (the same variables as the DB tests) to enable E5 evidence and the DB mutations. Never point this at a shared or production database.
- **Child processes get a fixed minimal environment:** `PATH`, `HOME`, the same placeholder Supabase values as CI, and the Postgres variables if set. `.env` is never read.
- **Options:**
  - `--no-mutations`: faster; mutation evidence then counts as missing.
  - `--base <ref>`: drift.
  - `--out <dir>`: report directory.
  - `--require-release-assertion`: exit 2 unless the assertion is PASS.

Exit codes:

- **1:** the framework is invalid, an executed security test failed, was cancelled, was todo or was skipped unexpectedly, a mutation result differs from its declaration, or a release-blocking control is FAIL.
- **0:** otherwise.

`RELEASE_SECURITY_ASSERTION` is reported separately:

- **PASS:** only when every release-blocking control is `PASS_AUTOMATED`.
- **FAIL:** a release-blocking FAIL or an evidence failure.
- **INCOMPLETE_EVIDENCE:** everything else.

At CRSF 1.0-draft-phase2k the expected result is `FRAMEWORK_VALID: YES` and `RELEASE_SECURITY_ASSERTION: FAIL`: application finding F-2K-1 (GET /api/link calls Telegram getChat behind only a per-IP limit) is open and not yet mapped to a control property, so the run exits 1 until it is mapped and fixed. 54 release-blocking controls; five are `MISSING_EVIDENCE`. Findings F-2D-2, F-2F-1, F-2H-1 and F-2I-1 are fixed; their probes are now regression proofs. The F-2K-1 reproduction is security/crsf/probes/link-read-getchat-probe.mjs.

Findings are a ledger, replayed from the `NEW_FINDING` / `FINDING_MAPPED` / `FINDING_FIXED` / `FINDING_WITHDRAWN` records in `framework-changes.json` (since 1.0-draft-phase2j, F-2J-1). Every application finding is mapped to a control property or explicitly declared unmapped. An open unmapped application finding makes `RELEASE_SECURITY_ASSERTION: FAIL` whatever the control statuses say. An open mapped one must be recorded as a `VIOLATION` on that property. The version lock records every finding, so none can be deleted or retyped.

A change record may carry a typed `finding` block. Marking a finding `FIXED` is checked rather than trusted (`FINDING_FIX_NOT_PROVEN`): the cited mutation cases must exist, be behavioural `KILLED` and target the violated property, and no `VIOLATION` of that property may remain.

## Framework versions

`framework-lock.json` records, per control: release class, minimum level, applicability, external IDs, a property digest and a derivation digest. The derivation digest covers title, domain, source refs, derivation type, the external and CoverRaccoon requirement texts, applicability reason, profile level, scope, threat, expected property and automation. The lock also holds a digest of the profile rules, including the type caps and the structural rule. If any of these change while `crsf_version` stays the same, the change is rejected:

- `THRESHOLD_REDUCED_SILENTLY`
- `RELEASE_CLASS_CHANGED_SILENTLY`
- `CONTROL_DELETED_SILENTLY`
- `APPLICABILITY_CHANGED_SILENTLY`
- `DERIVATION_CHANGED_SILENTLY`
- `PROPERTIES_CHANGED_SILENTLY`
- `PROFILE_CHANGED_WITHOUT_VERSION`
- `FRAMEWORK_CHANGED_WITHOUT_VERSION`

After a version bump, every change must be listed for that version in `framework-changes.json`:

- A threshold reduction must be declared as `THRESHOLD_REDUCTION`.
- An applicability change must be declared as `APPLICABILITY_CHANGE`.
- A changed requirement (properties, derivation or external IDs) needs a `REQUIREMENT_CLARIFICATION`, `PROPERTY_ADDED` or `EVIDENCE_BASIS_CHANGE` record. That record carries the exact `before` and `after` wording, which must hash to the old lock and the current definition, plus a `rationale` and `why_not_weakening`; otherwise the change fails with `REQUIREMENT_CHANGE_NOT_DOCUMENTED`.
- A deletion needs `asvs_reconciliation`, and must not leave an applicable ASVS requirement unmapped.

Only then will `crsf-gen --write` update the lock. With `--base <ref>`, the verifier also checks against the lock at that ref.

## Adding a control

1. Add it to `controls.json` with its inputs only (pinned `source_refs`, `external_requirement_ids`, properties with their kind, release class, minimum level, automation).
2. Bump `crsf_version` in the definition files and record the addition in `framework-changes.json`.
3. Run `node security/crsf/generator/crsf-gen.mjs --write`, then `npm run security:framework-test`.

## Adding evidence

1. Add an item to `evidence.json`:
   - `covers`: control, properties, `FULL`/`PARTIAL` (`PARTIAL` needs a note), `SUPPORTS`/`VIOLATION`.
   - an honest `level`, `reproducible`, and `execution`. Runners: `node-test` (test files, optional name filters, environment), `mutation`, `crsf-selftest`, `probe`, `static`, `manual`.
2. Registering a test never upgrades it: source-text checks are E1, and a test that survives a known-bad variant isn't E4.
3. Regenerate with `crsf-gen --write`. The status changes appear in the git diff of `controls.json`.

## Adding a mutation

See `security/mutation/README.md`.

## Drift detection

`npm run security:verify -- --base <ref>` maps `git diff <ref>..HEAD` paths to CRSF domains through `drift-model.json`, for example `src/db.mjs` → CR-DB, CR-CONC, CR-RESOURCE, CR-API, CR-INPUT. A path with no matching rule requires a full re-run.

Drift only prioritises review. Verification always evaluates every control, so no global control is ever skipped because of drift.

## Self-tests

`selftest/framework-selftest.mjs` derives broken variants of the real definition and checks that each is rejected with a specific code:

- PASS with missing evidence
- unknown control, evidence and source references
- duplicate IDs
- partial evidence labelled FULL
- silent threshold or class changes, and deletions
- unpinned or FAIL-hiding deviations, and APPROVED without a record
- override flags and fields
- unmapped ASVS requirements
- statuses that don't recompute
- derivation rewrites after results (expected property, sources, external IDs, applicability, class, minimum)
- undocumented or fabricated requirement clarifications
- tampered vendored sources or an incomplete ASVS list
- an E4 control without mutation proof, and behavioural evidence relabelled E4, E5 or real-system
- misuse of the structural rule (another property, widened allowlist, misplaced or incomplete structural evidence)

It also checks that the executor flags unexpected skipped, cancelled and todo tests, and that a mutation declared KILLED whose test still passes is reported as a claim mismatch. Finally, it checks that generation is deterministic.

## Licences

`vendor/asvs-5.0.0.flat.json` is OWASP ASVS 5.0.0 (CC BY-SA 4.0), copied unchanged from tag `v5.0.0_release`.
