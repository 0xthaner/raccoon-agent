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

At CRSF 1.0-draft-phase2p the expected result is `FRAMEWORK_VALID: YES` and `RELEASE_SECURITY_ASSERTION: INCOMPLETE_EVIDENCE` (54 release-blocking controls; two are `MISSING_EVIDENCE`: CR-VERIFY-003, CR-VERIFY-004). Findings F-2D-2, F-2F-1, F-2H-1, F-2I-1 and F-2K-1 are fixed; their probes are now regression proofs. F-2K-1 (GET /api/link) is covered by CR-RESOURCE-001 P5, added in 1.0-draft-phase2l.

Findings are a ledger, replayed from the `NEW_FINDING` / `FINDING_MAPPED` / `FINDING_FIXED` / `FINDING_WITHDRAWN` records in `framework-changes.json` (since 1.0-draft-phase2j, F-2J-1). Every application finding is mapped to a control property or explicitly declared unmapped. An open unmapped application finding makes `RELEASE_SECURITY_ASSERTION: FAIL` whatever the control statuses say. An open mapped one must be recorded as a `VIOLATION` on that property. The version lock records every finding, so none can be deleted or retyped.

A change record may carry a typed `finding` block. Marking a finding `FIXED` is checked rather than trusted (`FINDING_FIX_NOT_PROVEN`): the cited mutation cases must exist, be behavioural `KILLED` and target the violated property, and no `VIOLATION` of that property may remain.

## CR-RESOURCE-001 path matrix (1.0-draft-phase2m)

Every path named by P1-P5, with its expensive work and gates (all windows 600 s). "Behavioural" is the test item that satisfies the property; "Mutations" the known-bad cases that kill it.

| Property | Endpoint / path | Expensive work | IP gate | Per-key gate | Global gate | Behavioural | Mutations | Status |
|---|---|---|---|---|---|---|---|---|
| P1 | POST /api/dashboard login (signature) | SIWE verification, ERC-1271 at Alchemy+Infura, nonce consume, session | dashboard-login 10 | dashboard-login-wallet 10 | dashboard-login-global 200 | EV-RESOURCE-P1 | P1-2MA/B/C | covered |
| P1 | POST /api/dashboard login (on-chain approval) | challenge-state read, ERC-1271 at both providers, consume, session | dashboard-onchain 60 | dashboard-onchain-nonce 45, -wallet 90 | dashboard-onchain-global 600 | EV-RESOURCE-P1 | P1-2MD/E | covered |
| P1 | DELETE /api/dashboard fresh authority (sign-out everywhere, ?telegram=1; contract sessions) | verification, ERC-1271, consume, revoke/unlink | dashboard-delete 10 | dashboard-action-verify 10 | dashboard-action-verify-global 100 | EV-RESOURCE-P1 | P1-2MF/G | covered |
| P1 | POST {action}, DELETE sign-out, DELETE ?telegram=1 (legacy sessions without kind) | dual eth_getCode | dashboard-action 20 / dashboard-delete 10 | dashboard-action-wallet 10 | dashboard-action-verify-global 100 | EV-RESOURCE-P1 (EV-LEGACY-ORDER tests) | P1-F2F1A/B1/B2/C/D | covered |
| P2 | POST /api/link/verify | Telegram getChat, verification, ERC-1271, consume, notification | wallet-link-verify 10 | wallet-link-code 5 | wallet-link-verify-global 200 | EV-RESOURCE-P2 | P2-2MA/B/C | covered |
| P3 | GET /api/dashboard?wallet= (login challenge) | Alchemy eth_getCode, challenge insert | dashboard-read 120, dashboard-challenge 20 | dashboard-challenge-wallet 10 | dashboard-challenge-global 600 | EV-RESOURCE-P3 | P3-2MA/B/C | covered |
| P3 | POST {action} action challenge (legacy sessions) | dual eth_getCode, challenge insert | dashboard-action 20 | dashboard-action-wallet 10 | dashboard-action-verify-global 100 | EV-RESOURCE-P3 (EV-LEGACY-ORDER tests) | P1-F2F1A/C/D | covered |
| P4 | GET /api/positions | Aave RPC (multicall), Nexus catalog | positions-read 60 | positions-wallet 30 | positions-global 1200; positions-lookup-global 200 before each chain lookup | EV-RESOURCE-P4 | P4-2MA/B/C/D | covered (cold, warm, failure cache; merging) |
| P4 | GET/POST /api/position-attributions | positions lookup; cover lookup (Alchemy NFT, Nexus, getCovers) | attributions-read 60 / attributions-write 30 | attributions-wallet 60 / attributions-write-wallet 30 | positions-lookup-global 200; dashboard-read-global 300 | EV-RESOURCE-P4 | P4-2ME/F; P4-F2H1A-D | covered (cold, warm, failure cache) |
| P5 | GET /api/link | Telegram getChat | wallet-link-read 30 | wallet-link-read-code 10 | wallet-link-read-global 600 | EV-LINK-READ-BUDGET | P5-F2K1A-E | covered (Phase 2L) |

Paths with no verification or provider work, so no P1-P5 obligation: POST {access} redemption (IP limit before a single-use DB consume), POST {action} for sessions with kind (IP and wallet limits before a DB insert), DELETE sign-out of EOA sessions, DELETE /api/position-attributions. Dashboard cover reads are CR-RESOURCE-004. src/web.mjs repeats link read/verify without limits but is the local polling-mode server (only without VERCEL, bound to 127.0.0.1).

## CR-INPUT-004 database input inventory (1.0-draft-phase2n)

P1 "runtime builds no SQL strings from input", P2 "SQL functions use no EXECUTE with untrusted text". Evidence: EV-INPUT-DB-STRUCTURE (request structure, every helper), EV-INPUT-DB-PG (real Postgres, functions, catalog), EV-KB-INPUT-004 (4 mutations).

| Path / function | Input source | DB operation | Query construction | Parameterization model | Dynamic SQL? | Untrusted text reaches SQL syntax? | Status |
|---|---|---|---|---|---|---|---|
| src/db.mjs: pending links, dashboard access, challenges (createPendingLink, getPendingLink, createDashboardAccess, consumeDashboardAccess, storeDashboardChallenge, consumeDashboardChallenge, isDashboardChallengeOpen) | link/access codes, nonces, wallets from requests; chat ids from Telegram | PostgREST select/insert/update/delete | supabase-js builder, literal table and columns | `col=eq.<value>` / JSON body; `like` only with the constant `dashboard:%` | no | no | covered |
| src/db.mjs: wallets, settings, unlink, snoozes, snapshots, alerts, summaries, product context, language (getMonitoredWallets ... saveChatProductContext) | chat ids (validated Telegram updates), wallets (session/validated), labels, cover ids, callback data | PostgREST select/insert/upsert/update/delete | builder; `.match({literal keys})`; literal `on_conflict`, `order`, `select` | values only; thresholds/language allowlisted | no | no | covered |
| src/db.mjs: remembered wallets (getRememberedWallet(s), forgetRememberedWallet, consumePendingLink cleanup) | Telegram chat id (number, private-update check) or chat_id of a link row (string, isTelegramLinkRow) | PostgREST select/delete with `like` | pattern `unlinked:<chat>:%` | bound value; pattern anchored on `:`; since 1.0-draft-phase2o the helper itself admits only a positive safe integer or canonical decimal string, otherwise no request and a neutral result | no | no (enforced at the DB boundary) | covered |
| src/db.mjs: audit and renewals (recordAgentEvent, begin/finishTelegramDelivery, recordRenewalEvent) | event fields, error texts, metadata objects | PostgREST insert/update/upsert | builder, literal columns | JSON body values; metadata is jsonb data | no | no | covered |
| src/db.mjs: attributions (list/delete/deleteStale) | session wallet, deployment key, cover id | PostgREST select/delete | builder; `select` from a code constant | values only | no | no | covered |
| src/db.mjs: purgeOldRecords, listDueSnoozesPage, getAlertRunCursor, claimTelegramUpdate | none from requests (table/column from a code constant; integer update id) | PostgREST delete/select/insert | builder | values only | no | no | covered |
| RPC check_agent_rate_limit | HMAC rate key | plpgsql function | static statements | plpgsql variables (bind parameters) | no | no | covered |
| RPC consume_wallet_link_v2 / consume_wallet_link -> link_wallet_to_chat_limited, lock_chat_wallets | link code, wallet | plpgsql/sql functions | static statements; `\|\|` only builds values (advisory-lock key, label) | bind parameters | no | no | covered |
| RPC revoke_dashboard_sessions_atomic | wallet (regex-checked in SQL), cutoff | plpgsql (invoker) | static; `'revoked:' \|\| wallet` is a value | bind parameters | no | no | covered |
| RPC alert_subscriptions_page | keyset cursor (DB-derived), page size | sql function | static | bind parameters | no | no | covered |
| RPC upsert_position_attribution_limited | session wallet, deployment key, ids | plpgsql (invoker) | static | bind parameters; check constraints | no | no | covered |
| Migration 20260924170000 DO blocks | catalog names (pg_class, pg_proc), fixed role list | GRANT/REVOKE at migration time | `execute format('%I' / regprocedure)` | identifier quoting / regprocedure text | yes (migration-time) | no (no application input; not callable) | class A |
| Removed: consume_dashboard_challenge, consume_telegram_handoff | - | dropped by later migrations | - | - | - | - | absent (catalog asserted) |

PostgREST depth: the request structure is shown on the real supabase-js; database behaviour on real Postgres through the repository adapter, which models PostgREST's binding of every filter value as a parameter. A real PostgREST end-to-end run is optional additional evidence and is not claimed.

SECURITY DEFINER functions all set `search_path`; none has dynamic SQL; only service_role may execute them (CR-DB-001/002). `search_path` without `pg_temp` last is CR-DB-003 (SECURITY_DEBT). The only database client is src/db.mjs (asserted); operator scripts under scripts/ use the same helpers.

## CR-BROWSER-004 browser-side inventory (1.0-draft-phase2p)

P1 "no HTML sinks receive untrusted data", P2 "no eval/dynamic code", P3 "CSP forbids unsafe-eval". Evidence: EV-BROWSER-RENDER (real web/src/main.js and guide.js in a recording DOM built from the real HTML, 14 hostile payloads on every API-fed path), EV-CSP-BROWSER (vercel.json policy served per path, enforced by headless Chrome, with a no-policy control run), EV-BROWSER-STRUCT (syntax tree, static supplement), EV-KB-BROWSER-004 (9 mutations).

Classes: A text only (textContent/createTextNode/append of strings); B URL with fixed scheme and host; C fixed constant; D third-party code bounded by the CSP; E HTML or code sink with untrusted data (none found).

| File / path | Input source | Output / sink | Escaping / encoding model | Executable context? | User-controlled? | Security control | Evidence | Status |
|---|---|---|---|---|---|---|---|---|
| web/src/main.js addTextElement, element, renderDashboard, renderPositions, renderCoverChooser, renderCoverAttributions, renderSummary, renderUnavailableCard | /api/dashboard, /api/positions, /api/position-attributions (product names, symbols, amounts, labels, ids, dates, settings) | textContent / createTextNode | DOM text, never parsed (A) | no | indirectly (on-chain and server data) | text-only helpers | EV-BROWSER-RENDER, MUT-2PA | covered |
| web/src/main.js show() status line | /api/dashboard and /api/link error strings, Error.message | textContent | A | no | indirectly | text only | EV-BROWSER-RENDER, MUT-2PB | covered |
| web/src/main.js zeigeTelegramKonto (?code=) | /api/link telegram.target/username/name, error | textContent, createTextNode, `<strong>` | A | no | yes (Telegram account name) | text only | EV-BROWSER-RENDER, MUT-2PC | covered |
| web/src/main.js applyLanguage, guide.js apply | fixed translation tables, text of the static HTML | textContent on `[data-teil]` | A/C | no | no | markup fixed in HTML (AGENT-SEC-F1) | EV-BROWSER-RENDER | covered |
| web/src/main.js nexusLink href | product id from /api/positions | `a.href` | fixed table NEXUS_PRODUCT_PAGES, regex re-check, id equality (B/C) | navigation | id only | fixed https://app.nexusmutual.io | EV-BROWSER-RENDER, EV-BROWSER-STRUCT | covered |
| web/src/main.js renderDashboard Telegram button href | /api/config telegramUsername (server-checked `^[A-Za-z0-9_]{5,32}$`) | `a.href` = `https://t.me/<name>[?start=connect]` | fixed scheme and host; value only in the path (B); no client re-check (noted, not exploitable) | navigation | no (operator config) | fixed prefix; server check in api/config.mjs | EV-BROWSER-RENDER (hostile names never leave t.me), MUT-2PD | covered |
| web/src/main.js finish() back link href | /api/config telegramUsername | `a.href` = `https://t.me/<name>` | B, client re-check TELEGRAM_NAME | navigation | no | fixed prefix and format check | EV-BROWSER-STRUCT | covered |
| web/src/main.js dashboard link | constant | `a.href = '/'` | C | navigation | no | literal | EV-BROWSER-STRUCT | covered |
| web/src/main.js className, dataset, hidden, style.cssText, classList | constants and booleans | element properties | C | no | no | fixed values | EV-BROWSER-STRUCT (no computed writes) | covered |
| web/src/main.js, safe-app.js dynamic import() | literal module names (@reown/appkit*, @safe-global/safe-apps-sdk, ./safe-app.js, DEV fixture) | module loading | C | code (fixed modules) | no | literal specifiers; fixture only under import.meta.env.DEV | EV-BROWSER-STRUCT, EV-BROWSER-RENDER | covered |
| web/src/* timers | functions only | setTimeout/setInterval | C | no string code | no | - | EV-BROWSER-STRUCT, EV-BROWSER-RENDER (traps) | covered |
| web/src/eye.js, analytics.js | pointer events; page URL (redacted to origin+path) | canvas drawing; @vercel/analytics with beforeSend | no DOM text from data | no | no | - | EV-BROWSER-STRUCT | covered |
| WalletConnect/AppKit modal, Safe Apps SDK, @vercel/analytics (bundled third-party) | wallet registry, wallet responses | their own DOM (web components) | third-party (D) | bounded by CSP | partly | script-src 'self', no unsafe-eval, object-src/base-uri 'none' | EV-CSP-BROWSER | bounded, not rendered |
| web/index.html, guide.html, impressum.html, datenschutz.html | static | markup | no inline script or event attributes (scripts/check-frontend.mjs), no meta CSP | - | no | external module scripts only | EV-FRONTEND-SCAN, EV-CSP-BROWSER | covered |
| vercel.json Content-Security-Policy ("/" and "/(.+)") | configuration | response header | `script-src 'self'`, no unsafe-inline/unsafe-eval for scripts, `object-src 'none'`, `base-uri 'none'`, `frame-ancestors` per rule; style-src keeps unsafe-inline (styles only) | - | no | enforced in Chrome per path | EV-CSP-BROWSER, MUT-2PG/H/I; production delivery EV-PROD-HEADERS (manual) | covered |

URL schemes tried against every navigation sink: javascript:, JaVaScRiPt:, leading whitespace, data:text/html, vbscript:, //host, percent- and entity-encoded, user@host, backslashes, ../. All URLs stayed https on coverraccoon.com, t.me or app.nexusmutual.io. Server-side HTML: none (api/* answers JSON; src/web.mjs is the local static file server). No finding.

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
