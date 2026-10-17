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

**Observed real-system use (1.0-draft-phase2u, F-2T-1).** A declaration earns nothing. `security:verify` runs each real-system item in its own child executor (`lib/observed-test-exec.mjs`), behind a runner-side relay to the disposable Postgres (`lib/pg-observer.mjs`). The tests receive only the relay address. The relay credits only what the server confirms: an authenticated connection (AuthenticationOk) and a completed statement (CommandComplete).

For properties marked as concurrency claims (`profile.real_system_observation.concurrency.properties`; every CR-CONC property and every property text naming concurrency, enforced by `CONCURRENCY_CLAIM_UNMARKED`), it must additionally observe overlap: at least 2 server-authenticated connections busy at the same time, and at least 2 overlap events, where an open transaction counts as busy.

The receipt is signed with an HMAC key and nonce that reach the executor only on stdin. The runner accepts only that line; a test that writes a forged line into the executor's stdout via `/proc` changes nothing.

- Without Postgres the item is `NOT_RUN`.
- Without a receipt, with a receipt from the self-test fake upstream, or without confirmed use, it gets no credit.

Not observable: whether the overlapping statements are the ones relevant to the claimed race. That stays with the mutation cases.

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

At CRSF 1.0-draft-phase2v the expected result is `FRAMEWORK_VALID: YES` and `RELEASE_SECURITY_ASSERTION: INCOMPLETE_EVIDENCE`. There are 54 release-blocking controls, and one is `MISSING_EVIDENCE`: CR-VERIFY-004. CR-VERIFY-003 is `PASS_AUTOMATED` only in the full environment: disposable Postgres, the Vercel CLI and `CRSF_NETWORK_EVIDENCE=1`. Framework findings F-2T-1 (fake E5 via declared metadata) and F-2T-2 (self-test fixture N needed an open control) are fixed in 1.0-draft-phase2u; Since 1.0-draft-phase2v every concurrency control has real-Postgres evidence with runner-observed use and overlap:

- CR-CONC-001 to 006;
- CR-RESOURCE-002, via `test/rate-limit-atomic-db.test.mjs`, which uses a row-lock gate that forces the lost-update interleaving;
- CR-CONC-006, via `test/advisory-locks-db.test.mjs`, which takes its inventory from `pg_proc` and checks one transaction-scoped lock per operation and a waiting rather than retrying second caller.

CR-VERIFY-004 still stays `MISSING_EVIDENCE`. No real-system item covers its meta-property, and closing it needs a versioned framework decision (see `framework-changes.json`, 1.0-draft-phase2v). Findings F-2D-2, F-2F-1, F-2H-1, F-2I-1 and F-2K-1 are fixed; their probes are now regression proofs. F-2K-1 (GET /api/link) is covered by CR-RESOURCE-001 P5, added in 1.0-draft-phase2l.

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

## CR-VERIFY-003 historical security-fix register (1.0-draft-phase2q, 2r, 2s, 2u)

`fix-register.json` is the canonical inventory of every historical security fix: AGENT-*, AUDIT-2026-10-12, AUDIT E-/SA-, META-AUDIT, Restaudit, HARD-n and the CRSF findings F-xx-n. It also classifies every historical commit by hash (113 commits in total, not only keyword matches). Each fix has exactly one invariant. A PROVEN fix is at E4: it has a behavioural regression test, and a known-bad mutation that reintroduces the original bug and is expected KILLED by that test. `security:verify` executes every one of these mutations.

The guard `lib/fix-register.mjs` (run by `test/fix-register.test.mjs`) fails closed in these cases:

- a tag of a known family in code, tests, migrations, configuration or docs is not registered;
- a catch-all marker of a new family (AUDIT, Restaudit, META-AUDIT, AGENT-X-, HARD-n) is not registered;
- a registered tag has vanished;
- a commit is unclassified;
- a PROVEN fix lacks an invariant or a behavioural KILLED mutation;
- a fix names a test that is not an expected failure of its mutations;
- a mutation is claimed by two fixes;
- a FINDING_FIXED id is not registered as a fix.

Known-bad cases weaken the guard itself, and each is killed by its fixture.

**Commits after 1.0-draft-phase2r.** A commit cannot name its own hash, so every later commit carries exactly one trailer:

- `Security-Fix: FIX-<id>[, FIX-<id>]` for a registered fix;
- `Security-Fix: none - <reason>` with a reason of at least 10 characters.

A commit without such a trailer fails the guard. This holds with full history and in a shallow CI clone; without git nothing is asserted. A future security fix without a tag and without a keyword can therefore not pass silently, because its commit must declare itself. The remaining risk is a false `none` declaration, and that is a review matter.

**Platform fixes with the real Vercel CLI.** `test/vercel-cli-local.test.mjs` runs the installed CLI locally, with the capability `vercel_cli` (`vercel --version`):

- Setup: every API call goes to a local fake API that refuses every deployment. Every other request goes through a refusing proxy, and the test asserts that it saw none.
- `vercel deploy` reports its upload set. With the repository `.vercelignore` it excludes `.env` and `.env.*` and keeps `.env.example`. Without the file, the CLI would upload `.env` and `.env.production`; this is cad24d4.
- `vercel build` runs the `installCommand` from `vercel.json`. `npm ci` aborts on a lockfile that does not match `package.json`. Without the `installCommand`, Vercel's default `npm install` rewrites the lockfile and builds; this is b647281.
- Without the CLI, the two tests are an allowed skip and their evidence is NOT_RUN.

**Registry signatures with the real npm (b706956, 1.0-draft-phase2s).** `test/npm-registry-signatures.test.mjs` runs the real `npm run check:ci` and needs the explicit opt-in `CRSF_NETWORK_EVIDENCE=1` (capability `npm_network`). npm refreshes the Sigstore TUF metadata online from `tuf-repo-cdn.sigstore.dev` and takes the registry keys from the TUF target `registry.npmjs.org/keys.json`; pacote then verifies every signature.

- **Positive control:** a fresh disposable cache against the real registry passes.
- **Known-bad case:** in a copy of that cache, only `dist.integrity` of one direct dependency is changed, and the real signature is kept. npm reads it with `prefer-offline` while TUF still refreshes online. `check:ci` then fails for exactly that package.
- **Network:** a preload in every node process allows only the two read-only hosts and logs every connection; the test asserts the log. No credentials are used and nothing is published.
- **Without the opt-in:** the test is an allowed skip and the evidence is NOT_RUN.

Status: all 102 fixes are PROVEN (E4), so CR-VERIFY-003 is PASS_AUTOMATED. Each capability-dependent case (Postgres, Vercel CLI, network) is NOT_RUN where its capability is missing, and then the control does not reach PASS in that environment.

The register does not hold everything as a fix:

- Tag-only labels, UX items, an outdated runbook note, test-only regression tests, superseded or removed code, and non-security commits are classified with a reason. They are not counted as fixes.
- Fixes with several independent invariants are split, for example AGENT-SEC-A1 into five entries.
- Existing mutation cases are referenced, not copied.

| FIX_ID | ORIGIN | AFFECTED_FILE/PATH | ORIGINAL_SECURITY_BUG | SECURITY_INVARIANT_AFTER_FIX | CURRENT_REGRESSION_TEST | CURRENT_MUTATION/KNOWN-BAD | EVIDENCE_LEVEL | STATUS |
|---|---|---|---|---|---|---|---|---|
| FIX-A1-SESSION-SECRET | AGENT-SEC-A1 (a), internal review 29.08.2026 | src/dashboard-auth.mjs | without DASHBOARD_SESSION_SECRET the dashboard signed sessions with TELEGRAM_WEBHOOK_SECRET | no dashboard token is signed or accepted unless DASHBOARD_SESSION_SECRET is set; the webhook secret is never a fallback | dashboard-auth-boundaries.test.mjs | VERIFY-003-P1-2QA1SECRET | E4 | PROVEN |
| FIX-A1-LOGOUT-REVOKE | AGENT-SEC-A1 (b) | api/dashboard.mjs, src/dashboard-auth.mjs | logout only deleted browser cookies; a stolen session stayed valid for 7 days | logout revokes the wallet sessions server-side (revocation cutoff), not only the cookies | session-revocation-db.test.mjs | SESSION-007-P1-NEW1 | E4 | PROVEN |
| FIX-A1-LINKVERIFY-NO-SESSION | AGENT-SEC-A1 (c) | api/link/verify.mjs | a Telegram link signature set a dashboard session cookie | a link-verify signature never sets a dashboard session cookie | m1-link-limits.test.mjs | VERIFY-003-P1-2QA1VERIFY | E4 | PROVEN |
| FIX-A1-LEGACY-COOKIE | AGENT-SEC-A1 (d) | src/dashboard-auth.mjs | the legacy cookie without the __Host- prefix still authenticated | only the __Host- session cookie authenticates; the legacy cookie name is ignored | dashboard-auth-boundaries.test.mjs | VERIFY-003-P1-2QA1LEGACY | E4 | PROVEN |
| FIX-A1-RATE-SECRET | AGENT-SEC-A1 (e) | src/http-security.mjs | the rate-limit HMAC key fell back to the webhook secret | without DASHBOARD_SESSION_SECRET the rate limiter fails closed (503) and derives no key | historical-fix-regressions.test.mjs | VERIFY-003-P1-2QA1RATE | E4 | PROVEN |
| FIX-A2-ACCESS-NO-SESSION | AGENT-SEC-A2 (server) | api/dashboard.mjs | a Telegram access link logged the browser in directly | redeeming an access code returns only the expected wallet; it never issues a session | historical-fix-regressions.test.mjs | VERIFY-003-P1-2QA2COOKIE | E4 | PROVEN |
| FIX-A2-URL-CLEARED | AGENT-SEC-A2 (frontend) | web/src/main.js | the access code stayed in the address bar (history, referrer, screenshots) while it was redeemed | the frontend removes ?access= from the URL before the redeem request and redeems it only by POST | historical-fix-frontend.test.mjs | VERIFY-003-P1-2QA2URL | E4 | PROVEN |
| FIX-A3-DOMAIN-BOUND-SIWE | AGENT-SEC-A3 / 663a953 | src/siwe-auth.mjs, api/dashboard.mjs | the signed message was not domain-bound and partly client-supplied | the server rebuilds the SIWE message; domain, uri, chain id, nonce and address must equal the stored challenge | siwe-auth.test.mjs, siwe-signature.test.mjs | AUTH-001-P1-NEW1, AUTH-001-P1-NEW2, AUTH-001-P2-NEW1, AUTH-001-P3-NEW1, AUTH-001-P5-NEW1 | E4 | PROVEN |
| FIX-A3-LEGACY-CHALLENGE | AGENT-SEC-A3 (old schema) | src/dashboard-auth.mjs | challenges and sessions of the old message schema (no iat) stayed usable in parallel | a challenge or session token without the server-side iat is rejected | historical-fix-regressions.test.mjs | VERIFY-003-P1-2QA3LEGACY | E4 | PROVEN |
| FIX-A4-FIELDS-BEFORE-SIGNATURE | AGENT-SEC-A4 | src/siwe-auth.mjs | field validation and signature check were separate paths per endpoint | one shared SIWE boundary: a valid signature over a message with a wrong field is never VALID | siwe-signature.test.mjs | VERIFY-003-P1-2QA4ORDER | E4 | PROVEN |
| FIX-A5-PER-CODE-LIMIT | AGENT-SEC-A5 / d18c95b | api/link/verify.mjs | link verification was limited only per IP; a distributed attempt against one code passed | link verify is limited per link code across all callers before anything is checked or consumed | link-verify-rate-order.test.mjs | RESOURCE-001-P2-2MA | E4 | PROVEN |
| FIX-A6-CONFIG-BOTNAME | AGENT-SEC-A6 | api/config.mjs | /api/config delivered TELEGRAM_BOT_USERNAME unvalidated into frontend links | /api/config delivers a bot name only in Telegram format (5-32 of A-Z a-z 0-9 _), else empty | historical-fix-regressions.test.mjs | VERIFY-003-P1-2QA6 | E4 | PROVEN |
| FIX-A7-CSP-ENFORCED | AGENT-SEC-A7 (CSP) | vercel.json | the strict CSP ran report-only | every page path is served one enforcing Content-Security-Policy that the browser applies | csp-browser-enforced.test.mjs | VERIFY-003-P1-2QA7ENFORCE | E4 | PROVEN |
| FIX-A7-DEFAULT-PRIVILEGES | AGENT-SEC-A7 (database) / 638f10a | supabase/migrations/20260924170000_revoke_public_default_privileges.sql | new tables inherited Supabase default grants for anon/authenticated | default privileges are closed: a future table or sequence grants anon/authenticated nothing | db-privileges-db.test.mjs | VERIFY-003-P1-2QA7DEFPRIV | E4 | PROVEN |
| FIX-F1-FINISH | AGENT-SEC-F1 (finish) | web/src/main.js | the link success message was assembled as an HTML string | finish() builds the success message from elements and text only | historical-fix-frontend.test.mjs | VERIFY-003-P1-2QF1FINISH | E4 | PROVEN |
| FIX-F1-APPLYLANGUAGE | AGENT-SEC-F1 (applyLanguage) | web/src/main.js, web/index.html | a translation helper wrote strings via innerHTML next to /api values | translated text parts are written via textContent only | browser-render-sinks.test.mjs | VERIFY-003-P1-2QF1LANG | E4 | PROVEN |
| FIX-F1-GUIDE-ICON | AGENT-SEC-F1 (guide.js) | web/src/guide.js, web/guide.html | the guide replaced the Instagram icon via innerHTML at runtime | guide.js writes no markup at runtime; the icon is static in guide.html | browser-render-sinks.test.mjs | VERIFY-003-P1-2QF1GUIDE | E4 | PROVEN |
| FIX-F2-BACKLINK | AGENT-SEC-F2 | web/src/main.js | the back-to-Telegram link was built from /api/config without validation | the back link exists only for a Telegram-format bot name and always points to https://t.me/<name> | historical-fix-frontend.test.mjs | VERIFY-003-P1-2QF2 | E4 | PROVEN |
| FIX-W1-METHODS | AGENT-SEC-W1 / d714a3e | web/src/wallet-methods.js | the WalletConnect session requested the full default method list (transactions, typed data) | the requested methods are only read, personal_sign and wallet_switchEthereumChain - nothing value-moving | wallet-methods.test.mjs | VERIFY-003-P1-2QW1 | E4 | PROVEN |
| FIX-W2-ORIGIN | AGENT-SEC-W2 (server) | src/http-security.mjs | the expected origin fell back to https://<Host header> | the expected origin comes only from configuration; the Host header never decides it | same-origin-boundary.test.mjs | VERIFY-003-P1-2QW2ORIGIN | E4 | PROVEN |
| FIX-W2-DISCONNECT | AGENT-SEC-W2 (frontend) / aec089d | web/src/main.js | the WalletConnect session (with wallet-granted send rights) stayed open after login | after the signature the WalletConnect session is disconnected, on success and failure | historical-fix-frontend.test.mjs | VERIFY-003-P1-2QW2DISCONNECT | E4 | PROVEN |
| FIX-W3-REVOKE | AGENT-SEC-W3 / 08a9e22 | web/src/main.js | the browser extension kept the site connected after login | after the signature the page revokes the browser wallet permission (wallet_revokePermissions) | historical-fix-frontend.test.mjs | VERIFY-003-P1-2QW3 | E4 | PROVEN |
| FIX-API-001-BODY-SIZE | AGENT-API-001 | src/http-security.mjs | body size was checked only via Content-Length | body size is checked on the parsed body, independent of Content-Length; unserialisable bodies count as too large | api-hardening.test.mjs | VERIFY-003-P1-2QAPI001 | E4 | PROVEN |
| FIX-API-002-CSP-RATE | AGENT-API-002 | api/csp-report.mjs | csp-report could be flooded without limit (log flooding) | csp-report is rate limited before anything is parsed or logged | historical-fix-regressions.test.mjs | VERIFY-003-P1-2QAPI002 | E4 | PROVEN |
| FIX-API-003-NO-DB-ERRORS | AGENT-API-003 | api/alerts.mjs | the cron answer leaked raw database error text | the cron answer carries only counts or a generic "fehler", never database error text | historical-fix-regressions.test.mjs | VERIFY-003-P1-2QAPI003 | E4 | PROVEN |
| FIX-AUTH-001-ERC1271 | AGENT-AUTH-001 | src/contract-signature.mjs | contract-wallet signatures needed a fail-closed ERC-1271 check | only the exact ERC-1271 magic value counts; every RPC/decode error is invalid | erc1271.test.mjs, dual-rpc-erc1271.test.mjs | AUTH-003-P1-NEW1, AUTH-003-P4-NEW1 | E4 | PROVEN |
| FIX-AUTH-002-GET-READONLY | AGENT-AUTH-002 | api/dashboard.mjs | GET ?access= consumed the one-time code (state change in GET) | GET never consumes an access code; it answers 405 ACCESS_REDEEM_VIA_POST | historical-fix-regressions.test.mjs | VERIFY-003-P1-2QAUTH002 | E4 | PROVEN |
| FIX-HARD-001-WALLET-LIMITS | AGENT-HARD-001 / 04b2f04 | api/dashboard.mjs | login and challenge issuance were limited per IP only | login and challenge issuance are limited per wallet before signature/provider work | dashboard-auth-rate-order.test.mjs, challenge-rate-order.test.mjs | RESOURCE-001-P1-2MA, RESOURCE-001-P3-2MA | E4 | PROVEN |
| FIX-HARD-001-CODE-CACHE | AGENT-HARD-001 (cache) | src/contract-detect.mjs | a contract-detection RPC failure could be cached as a classification | a getCode RPC error is never cached; the next request asks again | safe-app-backend.test.mjs | VERIFY-003-P1-2QHARD001CACHE | E4 | PROVEN |
| FIX-HARD-002-ATOMIC-REVOKE | HARD-002 / 75417e9 | supabase/migrations/20261006120000_atomic_dashboard_revocation.sql | concurrent revocations could overwrite a newer cutoff | the revocation cutoff is max-merged under an advisory lock | session-revocation-db.test.mjs | CONC-005-P1-NEW1, CONC-005-P1-NEW2 | E4 | PROVEN |
| FIX-HARD-002-OPERATOR | HARD-002 (operator containment) / 75417e9 | scripts/revoke-dashboard-wallet.mjs | an operator could not revoke a compromised wallet's sessions without the user | the operator CLI revokes the normalized wallet's sessions and records a bounded incident | dashboard-atomic-revoke.test.mjs | VERIFY-003-P1-2QHARD002OPERATOR | E4 | PROVEN |
| FIX-HARD-003-GLOBAL | AGENT-HARD-003 / 676ca30 | api/dashboard.mjs | distributed attackers had no shared budget before provider work | login and challenge issuance consume a global budget before signature/provider work | dashboard-auth-rate-order.test.mjs, challenge-rate-order.test.mjs | RESOURCE-001-P1-2MB, RESOURCE-001-P3-2MB | E4 | PROVEN |
| FIX-HARD-004-SIGNED-LINK | HARD-004 / 04e8ca2 | src/bot.mjs, api/link/verify.mjs | a Telegram /start handoff bound a wallet without a wallet signature | a wallet is linked to a chat only after a verified wallet signature; no direct handoff binds | l2-telegram-handoff-removed.test.mjs, hard004.test.mjs | TELEGRAM-002-P1-L2X4, TELEGRAM-002-P1-L2X5 | E4 | PROVEN |
| FIX-HARD-004-REVOKED-LOGOUT | HARD-004 (logout) / 04e8ca2 | api/dashboard.mjs | an already-revoked session could revoke (sign out) newer sessions of its wallet | a revoked session only clears its own cookie; it never moves the wallet cutoff | historical-fix-regressions.test.mjs | VERIFY-003-P1-2QHARD004 | E4 | PROVEN |
| FIX-IR-001-CRON-ALERT | AGENT-IR-001 | api/alerts.mjs | a failing reminder run failed silently | a failed reminder run alerts the operator once with a generic id and answers a generic 500 | historical-fix-regressions.test.mjs | VERIFY-003-P1-2QIR001 | E4 | PROVEN |
| FIX-IR-002-SECURITY-EVENTS | AGENT-IR-002 | api/telegram.mjs, src/security-events.mjs | webhook forgeries left no trace | a forged webhook call is recorded as a security event with a fingerprint, never the raw IP or token | historical-fix-regressions.test.mjs | VERIFY-003-P1-2QIR002, VERIFY-003-P1-2QIR002RAW | E4 | PROVEN |
| FIX-LLM-001-DATA-CHANNEL | AGENT-LLM-001 | src/agent-knowledge.mjs | external product facts could reach the instruction channel (prompt injection) | external facts appear only in the input channel as data, never in the instructions | llm-trust-boundary.test.mjs | VERIFY-003-P1-2QLLM001 | E4 | PROVEN |
| FIX-SAFE-1-SERVER-TTL | AGENT-SAFE-1 | api/dashboard.mjs | the long contract challenge TTL had to be server-decided and fail closed | only a server-side getCode decides the contract TTL; detection failure or client hints give the EOA TTL | l4-contract-detect-ttl.test.mjs, historical-fix-regressions.test.mjs | VERIFY-003-P1-2QSAFE1FAIL, VERIFY-003-P1-2QSAFE1CLIENT | E4 | PROVEN |
| FIX-SAFE-2-CONFLICT | AGENT-SAFE-2 / 2edae68 | src/dashboard-auth.mjs | a strict cookie and a Safe-App session of different wallets had to be resolved | conflicting strict and Safe-App sessions fail closed (401, cookies cleared, no data) | historical-fix-regressions.test.mjs | VERIFY-003-P1-2QSAFE2 | E4 | PROVEN |
| FIX-SAFE-2-NO-BEARER | 2edae68 / 9458d95 | src/dashboard-auth.mjs | the Safe App used a JS-readable bearer token | Authorization: Bearer is never accepted as a dashboard session | session-token-boundaries.test.mjs, safe-app-session.test.mjs | SESSION-005-P2-NEW1 | E4 | PROVEN |
| FIX-SAFE-4-PREVIEW-ORIGINS | AGENT-SAFE-4 / 8d6a335 | src/http-security.mjs | a preview origin allowlist could widen production origins | ALLOWED_APP_ORIGINS is ignored in production | preview-origin-allowlist.test.mjs | VERIFY-003-P1-2QSAFE4 | E4 | PROVEN |
| FIX-UX-5-ACCOUNT-RECHECK | AGENT-UX-5 / 2baa440 (labelled security) | web/src/eoa-login.js | after a network switch the old account could be used silently | after the switch the active account is re-read; a changed account stops the login (browser wallet and WalletConnect) | eoa-login-mainnet.test.mjs | VERIFY-003-P1-2QUX5ACCOUNT, VERIFY-003-P1-2QUX5APPKIT | E4 | PROVEN |
| FIX-MAINNET-SIGNING | 4e52666 / 2cc2bac | web/src/eoa-login.js | EOA sign-in could sign on a non-mainnet chain | no signature is requested unless the wallet reports chain 1 (browser wallet and WalletConnect) | eoa-login-mainnet.test.mjs | VERIFY-003-P1-2QUX5CHAIN, VERIFY-003-P1-2QUX5WCCHAIN | E4 | PROVEN |
| FIX-AUDIT-F1-LINK-ROWS | AUDIT-2026-10-12 F1 | src/linking.mjs, api/link.mjs, api/link/verify.mjs | link endpoints looked up any pending_links code (revocation markers revealed sign-outs) | only the exact link-code format reaches the DB and only private-chat rows count as links | link-row-kind.test.mjs | VERIFY-003-P1-2QAUDITF1 | E4 | PROVEN |
| FIX-AUDIT-F2-OFFCHAIN | AUDIT-2026-10-12 F2 | web/src/safe-app.js | the Safe login could propose an on-chain SignMessageLib transaction | the Safe login stops unless the host confirms offChainSigning === true | safe-app-flow.test.mjs | VERIFY-003-P1-2QAUDITF2 | E4 | PROVEN |
| FIX-AUDIT-F3-CACHE-BOUND | AUDIT-2026-10-12 F3 | src/contract-detect.mjs | the contract-detection cache grew without bound | the cache holds at most 1000 entries (expired first, then oldest) | erc1271.test.mjs | VERIFY-003-P1-2QAUDITF3 | E4 | PROVEN |
| FIX-E-L2-TARGET | AUDIT E-L2 | api/link.mjs, api/link/verify.mjs, src/linking.mjs | the link signature did not name the Telegram target | the signed text names the target derived from the bound chat id; request values never choose it | extended-audit-low.test.mjs | VERIFY-003-P1-2QEL2 | E4 | PROVEN |
| FIX-CAD24D4-LINK-ACCOUNT | cad24d4 | api/link.mjs | a foreign link ("please confirm") could attach the wallet to someone else's chat unnoticed | the link page receives (and shows) the Telegram account the link belongs to | extended-audit-low.test.mjs | VERIFY-003-P1-2QLINKACCOUNT | E4 | PROVEN |
| FIX-E-L3-BOUND | AUDIT E-L3 (bound) | src/display-text.mjs, src/cover-chain.mjs | upstream display names were unbounded (messages over 4096 characters failed) | upstream display text is cleaned and bounded; every Telegram text stays within 4096 characters | extended-audit-low.test.mjs | VERIFY-003-P1-2QEL3BOUND | E4 | PROVEN |
| FIX-E-L3-ISOLATION | AUDIT E-L3 (isolation) | src/alerts.mjs | one failed send aborted all further due covers, every day | a failed send for one cover does not suppress the next; only sent covers are marked | extended-audit-low.test.mjs | VERIFY-003-P1-2QEL3ISO | E4 | PROVEN |
| FIX-E-L4-LOG | AUDIT E-L4 | api/csp-report.mjs | csp-report logged attacker-chosen directive text (log forging) | csp-report logs only allow-listed directive forms and origins/keywords | extended-audit-low.test.mjs | VERIFY-003-P1-2QEL4 | E4 | PROVEN |
| FIX-SA-L1-FRESH-AUTHORITY | AUDIT SA-L1 | api/dashboard.mjs | a restored contract session alone authorised destructive actions | destructive contract actions need fresh authority | safe-session-authority.test.mjs | AUTH-007-P1-NEW1 | E4 | PROVEN |
| FIX-SA-L2-REVOCATION-503 | AUDIT SA-L2 | api/dashboard.mjs | a failing revocation check crashed or served data | an unverifiable revocation check serves no data (503 SESSION_CHECK_UNAVAILABLE) | historical-fix-regressions.test.mjs | VERIFY-003-P1-2QSAL2 | E4 | PROVEN |
| FIX-M-1-DASHBOARD | META-AUDIT M-1 (dashboard) | api/dashboard.mjs, src/db.mjs | current Safe owners could never remove a stale chat of a removed owner | fresh contract authority unlinks the wallet from all chats | telegram-stale-authority.test.mjs | VERIFY-003-P1-2QM1DASH | E4 | PROVEN |
| FIX-M-1-BOT | META-AUDIT M-1 (bot) | src/bot.mjs | a removed owner's chat could act wallet-wide on the Safe | "fully disconnect" acts wallet-wide only with a dual-RPC no-code quorum, else chat-local | telegram-stale-authority.test.mjs | VERIFY-003-P1-2QM1BOT | E4 | PROVEN |
| FIX-M-2-GLOBAL-BEFORE-1271 | META-AUDIT M-2 | api/dashboard.mjs | ERC-1271 dual-RPC checks ran before any global budget | every ERC-1271 path (fresh authority, on-chain approval) consumes the global budget first | dashboard-auth-rate-order.test.mjs | RESOURCE-001-P1-2MF, RESOURCE-001-P1-2MD | E4 | PROVEN |
| FIX-M-3-ONCHAIN-LOGIN | META-AUDIT M-3 / aa78b6c | src/contract-signature.mjs, api/dashboard.mjs | the on-chain SignMessageLib approval path needed binding, expiry and single use | an on-chain approval login is bound to the wallet, expires server-side and is single use | dashboard-login-db.test.mjs | AUTH-004-P1-NEW1, AUTH-004-P2-NEW1, AUTH-004-P2-NEW2 | E4 | PROVEN |
| FIX-M-3-APPKIT-FEATURES | 7207f7e (kept by 04273f7) | web/src/main.js | AppKit offered send, receive, swaps and onramp inside the login dialog | AppKit starts with send, receive, swaps, onramp, email and social login disabled | historical-fix-frontend.test.mjs | VERIFY-003-P1-2QAPPKIT | E4 | PROVEN |
| FIX-RM1-LINK-LIMITS | Restaudit M1 (link codes) | src/linking.mjs | link codes could be created without limit | new link codes are limited per chat and globally before any write | m1-link-limits.test.mjs | VERIFY-003-P1-2QRM1LINKCHAT, VERIFY-003-P1-2QRM1LINKGLOBAL | E4 | PROVEN |
| FIX-RM1-WALLET-CAP | Restaudit M1 (wallet cap) | supabase/migrations/20261015200000_m1_wallet_limit_alert_budget.sql | a chat could link unlimited wallets | the database caps linked wallets per chat | m1-wallet-limit-db.test.mjs | CONC-002-P1-L2X15 | E4 | PROVEN |
| FIX-RM1-ALERT-RUN | Restaudit M1 (reminder run) | src/alerts.mjs | the daily run loaded every subscription and did unbounded provider work | the reminder run stops at its lookup budget and keeps the snooze reserve | m1-alert-run-budget.test.mjs | VERIFY-003-P1-2QRM1ALERT | E4 | PROVEN |
| FIX-RM2-DASHBOARD-READ | Restaudit M2 | api/dashboard.mjs | authenticated dashboard reads triggered provider work without budget | authenticated reads consume per-wallet and global budgets before provider work | m2-dashboard-read-budget.test.mjs | VERIFY-003-P1-2QRM2WALLET, VERIFY-003-P1-2QRM2GLOBAL | E4 | PROVEN |
| FIX-RH2-SINGLE-USE | Restaudit H2 | src/db.mjs | single use of challenges and access codes was unproven under concurrency | challenges and access codes are consumed exactly once under real concurrency | h2-challenge-concurrency-db.test.mjs | CONC-001-P1-H2A, CONC-001-P2-H2I | E4 | PROVEN |
| FIX-RL1-ATTRIBUTION-LIMIT | Restaudit L1 | supabase/migrations/20261016150000_l1_attribution_limit.sql | the attribution limit was a racy JS pre-check | the database enforces the per-wallet attribution limit atomically under a lock | l1-attribution-limit-db.test.mjs | CONC-003-P1-L1A, CONC-003-P1-L1D | E4 | PROVEN |
| FIX-RL2-HANDOFF-REMOVED | Restaudit L2 | src/linking.mjs, supabase/migrations/20261016120000_l2_drop_telegram_handoff.sql | the dead unsigned Telegram handoff was still callable | no unsigned handoff path exists in code or database | m1-link-limits.test.mjs | TELEGRAM-002-P2-L2X8 | E4 | PROVEN |
| FIX-RL3-SNOOZE-AUTH | Restaudit L3 | src/bot.mjs, src/db.mjs | renew_later callbacks were not authorised against the current chat link | a snooze is written only for a cover of a wallet currently linked to this chat, canonical ids only | l3-snooze-authorization.test.mjs | TELEGRAM-003-P1-L3Y1, TELEGRAM-003-P2-L3Y7, INPUT-010-P2-L3Y3 | E4 | PROVEN |
| FIX-RL4-GETCODE-TTL | Restaudit L4 | src/contract-detect.mjs | malformed getCode answers counted as contract (long TTL) | only well-formed bytecode is a contract; the challenge expiry is not recomputed at verification | l4-contract-detect-ttl.test.mjs | PROVIDER-001-P2-L4J, SESSION-002-P1-L4D | E4 | PROVEN |
| FIX-RL5-RECONCILE | Restaudit L5 | src/db.mjs, api/position-attributions.mjs | GET reconciliation could delete a freshly re-confirmed attribution | reconciliation deletes only rows proven stale at read time; provider errors delete nothing | l5-attribution-cleanup-db.test.mjs, position-attributions-api.test.mjs | CONC-004-P1-L5F, PROVIDER-001-P4-L5C | E4 | PROVEN |
| FIX-F-2C-1 | F-2C-1 (CRSF 2C) | scripts/file-case-accounting.mjs | a test file without tests counted as one passing entry | per-file accounting counts only real test cases; a case-less file is reported | guard-behaviour.test.mjs | VERIFY-002-P4-NEW1 | E4 | PROVEN |
| FIX-F-2C-2 | F-2C-2 (CRSF 2C) | security/crsf/lib/engine.mjs | the engine credited a property while one of its cases was NOT_RUN | a NOT_RUN case blocks the known-bad proof of its property | crsf-engine.test.mjs | VERIFY-003-P1-2QF2C2 | E4 | PROVEN |
| FIX-F-2C-3 | F-2C-3 (CRSF 2C) | security/crsf/lib/engine.mjs | self-declared evidence levels were trusted | evidence levels are capped per evidence type (LEVEL_EXCEEDS_TYPE) | crsf-framework-fixes.test.mjs | VERIFY-003-P1-2QF2C3 | E4 | PROVEN |
| FIX-F-2D-1 | F-2D-1 (CRSF 2D) | security/crsf/lib/engine.mjs | a plain node test relabelled real-system reached E5 | reproducible real-system evidence must require a non-node capability | crsf-framework-fixes.test.mjs | VERIFY-003-P1-2QF2D1 | E4 | PROVEN |
| FIX-F-2D-2 | F-2D-2 (CRSF 2D, application Low) | src/contract-signature.mjs | a missing getCode result was read as "no contract code" | only a well-formed eth_getCode string from both providers is "no code"; anything else is unknown | getcode-fail-closed.test.mjs | PROVIDER-001-P2-F2D2A, PROVIDER-001-P2-F2D2B | E4 | PROVEN |
| FIX-F-2F-1 | F-2F-1 (CRSF 2F, application Low) | api/dashboard.mjs | legacy-session fresh-authority getCode ran before per-wallet/global limits | the legacy kind lookup runs only after the per-wallet and global action gates | dashboard-legacy-rate-order.test.mjs | RESOURCE-001-P1-F2F1A, RESOURCE-001-P1-F2F1B1, RESOURCE-001-P1-F2F1B2, RESOURCE-001-P1-F2F1C, RESOURCE-001-P1-F2F1D | E4 | PROVEN |
| FIX-F-2H-1 | F-2H-1 (CRSF 2H, application Low) | api/position-attributions.mjs | attribution cover lookups had no global budget | every attribution cover lookup consumes the global cover budget before the lookup | attribution-cover-budget.test.mjs | RESOURCE-001-P4-F2H1A, RESOURCE-001-P4-F2H1B, RESOURCE-001-P4-F2H1C, RESOURCE-001-P4-F2H1D | E4 | PROVEN |
| FIX-F-2I-1 | F-2I-1 (CRSF 2I, application Low) | src/bot.mjs | Telegram cover lookups had no per-chat or global budget | every Telegram cover lookup consumes per-chat and global budgets before the lookup, per wallet | telegram-cover-budget.test.mjs | RESOURCE-007-P1-F2I1A, RESOURCE-007-P1-F2I1B, RESOURCE-007-P1-F2I1B2, RESOURCE-007-P1-F2I1C, RESOURCE-007-P1-F2I1D, RESOURCE-007-P1-F2I1D2, RESOURCE-007-P1-F2I1E, RESOURCE-007-P1-F2I1F | E4 | PROVEN |
| FIX-F-2J-1 | F-2J-1 (CRSF 2J) | security/crsf/lib/engine.mjs | an open unmapped application finding did not change the release assertion | an open unmapped application finding fails the release | crsf-framework-fixes.test.mjs | VERIFY-003-P1-2QF2J1 | E4 | PROVEN |
| FIX-F-2K-1 | F-2K-1 (CRSF 2K, application Low) | api/link.mjs | GET /api/link called Telegram getChat without per-code or global limits | getChat runs only after the per-IP, per-code and global limits | link-read-budget.test.mjs | RESOURCE-001-P5-F2K1A, RESOURCE-001-P5-F2K1B, RESOURCE-001-P5-F2K1C, RESOURCE-001-P5-F2K1D, RESOURCE-001-P5-F2K1E | E4 | PROVEN |
| FIX-062201C-LINK-STATE | 062201c | src/db.mjs | a wallet linked to several chats exposed one arbitrary chat's label and settings | the wallet link state carries chat metadata only when exactly one chat is linked | historical-fix-regressions.test.mjs | VERIFY-003-P1-2QISOMETA | E4 | PROVEN |
| FIX-062201C-UNLINK-ONE | 062201c | src/db.mjs | a wallet-authorized unlink could pick one of several chats | a wallet-authorized unlink acts only when exactly one chat is linked and removes only that wallet | telegram-stale-authority.test.mjs | VERIFY-003-P1-2QISOUNLINK | E4 | PROVEN |
| FIX-062201C-LIKE-DELIMITER | 062201c | src/db.mjs | the remembered-wallet LIKE pattern matched other chats with the same prefix | the per-chat pattern keeps its delimiter (unlinked:<chat>:%) | input-db-adversarial-db.test.mjs | INPUT-004-P1-2NB | E4 | PROVEN |
| FIX-3664868-CHAT-ID-DOMAIN | 3664868 (defence in depth) | src/db.mjs | remembered-wallet helpers relied on callers for integer chat ids | remembered-wallet helpers accept only canonical chat ids; anything else sends no request | input-db-adversarial-db.test.mjs | INPUT-004-P1-2OE | E4 | PROVEN |
| FIX-B44F37A-PRIVATE-SENDER | b44f37a | src/telegram-audit.mjs | a private-chat message was trusted without matching sender and chat | a private message is authentic only if chat.id equals from.id | telegram-audit.test.mjs | VERIFY-003-P1-2QPRIVMSG | E4 | PROVEN |
| FIX-DA4D901-PRIVATE-ONLY | da4d901 | api/telegram.mjs | the bot processed group chats | non-private updates are acknowledged without DB, AI or reply | telegram-private-only.test.mjs | TELEGRAM-001-P2-NEW1 | E4 | PROVEN |
| FIX-E987990-ANSWER-FILTER | e987990 / 7db17e8 | src/answer-filter.mjs | AI answers could contain foreign links or wallet addresses (phishing) | AI answers keep only allow-listed hosts and the bot's own handle; wallet addresses are removed | answer-filter.test.mjs | VERIFY-003-P1-2QFILTERHOST, VERIFY-003-P1-2QFILTERADDR | E4 | PROVEN |
| FIX-CAD24D4-AI-BUDGET | cad24d4 | src/ai-budget.mjs | AI answers had no cost cap across chats | AI requests consume a global budget across all chats | ai-budget.test.mjs | VERIFY-003-P1-2QAIGLOBAL | E4 | PROVEN |
| FIX-7DB17E8-AI-FAIL-CLOSED | 7db17e8 | src/ai-budget.mjs | a failing budget count allowed private AI requests | a failing AI budget count blocks private and group requests | ai-budget.test.mjs | VERIFY-003-P1-2QAIFAIL | E4 | PROVEN |
| FIX-D18C95B-CSP-CONNECT | d18c95b | vercel.json | connect-src allowed any https:/wss: origin | connect-src names the WalletConnect endpoints individually; other https origins are blocked | csp-browser-enforced.test.mjs | VERIFY-003-P1-2QCSPCONNECT | E4 | PROVEN |
| FIX-D18C95B-CSP-REPORT-LOG | d18c95b | api/csp-report.mjs | CSP reports carry document-uri/referrer with link and access codes | csp-report stores nothing and logs only directive and blocked origin, never the page address | historical-fix-regressions.test.mjs | VERIFY-003-P1-2QCSPLOG | E4 | PROVEN |
| FIX-D18C95B-FRONTEND-GUARD | d18c95b | scripts/check-frontend.mjs | nothing stopped a reintroduced HTML sink | the frontend guard fails the build on a reintroduced innerHTML | frontend-markup.test.mjs | VERIFY-003-P1-2QGUARDHTML | E4 | PROVEN |
| FIX-20F9549-FONT-SHA256 | 20f9549 | scripts/fetch-fonts.mjs | downloaded fonts were shipped unverified | fonts whose SHA-256 does not match are never written and the build fails | font-integrity.test.mjs | VERIFY-003-P1-2QFONTSHA | E4 | PROVEN |
| FIX-B706956-IGNORE-SCRIPTS | b706956 / 51c0cd4 | .npmrc, vercel.json | dependency install scripts ran during install (also in Vercel's second install run) | the project .npmrc stops npm from running install lifecycle scripts | npm-install-scripts.test.mjs | VERIFY-003-P1-2QNPMRC | E4 | PROVEN |
| FIX-0F3A6EF-OWN-FONT | 0f3a6ef (privacy) | web/src/main.js, vercel.json | AppKit preloaded fonts from fonts.reown.com (visitor IP to a third party) | AppKit is started with the own font, so it adds no third-party font preloads | historical-fix-frontend.test.mjs | VERIFY-003-P1-2QAPPKITFONT | E4 | PROVEN |
| FIX-AA77699-RETENTION | aa77699 (privacy) | src/db.mjs | logs and login codes were kept indefinitely | logs are purged after 90 days, login challenges after expiry | purge.test.mjs | VERIFY-003-P1-2QRETENTION | E4 | PROVEN |
| FIX-BC42B0A-ANALYTICS-REDACT | bc42b0a (privacy) | web/src/analytics.js | page-view URLs carry one-time secrets (?access=, ?code=) | analytics URLs carry only origin and path; query and fragment are dropped | analytics.test.mjs | VERIFY-003-P1-2QANALYTICS | E4 | PROVEN |
| FIX-39196D0-NO-JS-TOKEN | 39196d0 | api/dashboard.mjs | the login answer handed an EOA a JS-readable session token | the login response body never carries the session token | eoa-session-transport.test.mjs, safe-app-session.test.mjs, safe-session-authority.test.mjs | SESSION-005-P1-NEW1 | E4 | PROVEN |
| FIX-4F55789-DUAL-RPC | 4f55789 | src/contract-signature.mjs | one RPC provider decided ERC-1271 validity | ERC-1271 needs agreement of two independent providers | dual-rpc-erc1271.test.mjs, onchain-safe-login.test.mjs | AUTH-003-P2-NEW1 | E4 | PROVEN |
| FIX-E69AFD3-QUERY-PARAMS | e69afd3 | src/request-query.mjs | handlers read request.query loosely (query could override secrets or body values) | handlers read only defined single query values; query never replaces secrets or body fields | query-authority.test.mjs | API-004-P1-NEW1, API-004-P1-NEW2, API-004-P1-NEW3, API-004-P1-NEW4 | E4 | PROVEN |
| FIX-536BC02-CANCELLED-TESTS | 536bc02 | scripts/run-tests-guarded.mjs | cancelled security tests (cancelledByParent) let the run exit 0 | the guarded test runner fails on cancelled tests | guard-behaviour.test.mjs | VERIFY-001-P1-NEW1 | E4 | PROVEN |
| FIX-B706956-REGISTRY-SIGNATURES | b706956 | package.json | registry signatures were not verified | check:ci runs npm audit signatures and fails on invalid registry signatures | npm-registry-signatures.test.mjs | VERIFY-003-P1-2SSIGNONE, VERIFY-003-P1-2SSIGNEUTER | E4 | PROVEN |
| FIX-B647281-NPM-CI | b647281 | vercel.json | npm install could deviate from the lockfile hashes in the deployment build | the Vercel installCommand installs exactly the lockfile (npm ci) | vercel-cli-local.test.mjs | VERIFY-003-P1-2RNCNONE, VERIFY-003-P1-2RNCINSTALL | E4 | PROVEN |
| FIX-CAD24D4-VERCELIGNORE | cad24d4 | .vercelignore | `vercel --prod` uploaded the local .env (bot token, Supabase key) as source | deployment uploads exclude .env and .env.* (except .env.example) | vercel-cli-local.test.mjs | VERIFY-003-P1-2RVIALL, VERIFY-003-P1-2RVISTAR | E4 | PROVEN |
| FIX-F-2T-1 | F-2T-1 (CRSF 2T, fixed 2U) | security/crsf/lib/pg-observer.mjs, security/crsf/lib/observed-test-exec.mjs, security/crsf/lib/exec.mjs, security/crsf/lib/engine.mjs | real-system E5 evidence was credited on declared type and environment alone; a node-only test declared [node, postgres] satisfied CR-VERIFY-004 | real-system evidence is credited only with a runner-signed receipt of server-confirmed Postgres use, and concurrency claims only with observed overlapping execution | crsf-real-system-observation.test.mjs | VERIFY-003-P1-2UOBSUSE, VERIFY-003-P1-2UOBSCLIENT, VERIFY-003-P1-2UOBSSEQ, VERIFY-003-P1-2UOBSCONC, VERIFY-003-P1-2UOBSMAC | E4 | PROVEN |
| FIX-F-2T-2 | F-2T-2 (CRSF 2T, fixed 2U) | security/crsf/lib/selftest-states.mjs, security/crsf/selftest/framework-selftest.mjs | self-test fixture N threw when no release-blocking control was MISSING_EVIDENCE, making an honest all-closed state framework-invalid | fixture N catches a forged PASS without evidence both while a control is open and when every release-blocking control is satisfied | crsf-real-system-observation.test.mjs | VERIFY-003-P1-2UNOPEN | E4 | PROVEN |

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
- real-system authenticity (1.0-draft-phase2u). These fixtures run behind the observer against a self-test fake upstream:
  - T3/T3E: a node-only test declared real-system [node, postgres];
  - RS2–RS7: a printed usage marker, environment variables, a receipt-shaped file, a mocked pg, sequential statements claimed as concurrency, a forged receipt line via `/proc`;
  - RG1: genuine overlap is credited;
  - FAKEUP, NOOBS, MAC;
- N-ALL: every definition fixture, including N, is still rejected in a synthetic state where all release-blocking controls are satisfied

It also checks that the executor flags unexpected skipped, cancelled and todo tests, and that a mutation declared KILLED whose test still passes is reported as a claim mismatch. Finally, it checks that generation is deterministic.

## Licences

`vendor/asvs-5.0.0.flat.json` is OWASP ASVS 5.0.0 (CC BY-SA 4.0), copied unchanged from tag `v5.0.0_release`.
