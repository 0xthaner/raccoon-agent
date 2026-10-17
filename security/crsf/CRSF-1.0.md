# CoverRaccoon Security Framework — CRSF 1.0-draft-phase2v

> Generated from `security/crsf/*.json` by `security/crsf/generator/crsf-gen.mjs`. Do not edit by hand.
>
> CoverRaccoon is **mapped against and evaluated against** the pinned sources below. This document is not a certification and makes no compliance claim. The statuses here are the *declared* evaluation of the definition; `npm run security:verify` recomputes them from executed evidence for a specific commit.

## 1. Declared evaluation

### Security assurance

- FAIL: 19
- INFORMATIONAL: 2
- MISSING_EVIDENCE: 45
- PASS_AUTOMATED: 57
- PASS_MANUAL: 24

### Release classes

- INFORMATIONAL: 2
- MANUAL_ASSURANCE: 30
- RELEASE_BLOCKING: 54
- SECURITY_DEBT: 61

### Release-blocking controls by security status

- MISSING_EVIDENCE: 1
- PASS_AUTOMATED: 53

### Standard conformance (ASVS 5.0.0, applicable requirements)

- ACCEPTED_PLATFORM_DEVIATION: 1
- ACCEPTED_PROTOCOL_DEVIATION: 2
- CONFORMANT: 82
- NON_CONFORMANT: 21
- NOT_DEMONSTRATED: 56

ASVS: 345 requirements — APPLICABLE 162, DEFERRED 57, NOT_APPLICABLE 126. Profile: ASVS L2 (all applicable L1 + L2 requirements are in scope); selected L3: V6.7.2, V15.4.2, V15.4.3, V7.5.3, V3.5.8, V14.2.6, V14.2.7, V8.3.2, V2.3.5.

## 2. Evidence levels and rules

- **E0** — no evidence
- **E1** — static/config/manual inspection
- **E2** — positive behavioural test
- **E3** — negative/adversarial behavioural test
- **E4** — reproducible known-bad/mutation proof (KILLED, behavioural detection)
- **E5** — real-system proof (real Postgres, real concurrency)
- **E6** — independent external review (never claimed)

- Evidence must be reproducible from the repository at the verified commit; non-reproducible evidence only satisfies MANUAL_ASSURANCE / automation NO controls, and only if it is a dated manual record.
- E4 requires a reproducible known-bad/mutation proof with result KILLED for the property.
- Comments in code/tests are never evidence; source-text and config-text checks are E1.
- A test that survives a known-bad variant is invalid evidence (known_bad_result SURVIVED -> ignored).
- FAIL arises only from an evidence finding VIOLATION; it can only disappear with an entry in classification-changes.json.
- E6 is not claimed: no independent external review exists.
- Executable evidence counts only if it was executed in this run and passed; evidence that could not run (missing environment) counts as missing, never as passed.
- Mutation (known-bad) evidence counts for a property only if at least one case targeting it was KILLED by its expected failing test with behavioural detection, and no case targeting it SURVIVED, was killed for another reason, was invalid, or did not run in this run. EQUIVALENT cases are neutral.
- A declared mutation result that differs from the observed result invalidates the framework run.
- An evidence item may not declare a level above the cap of its type (evidence_level_cap_by_type); E5 therefore requires real-system evidence.
- STRUCTURAL evidence satisfies only the properties listed in structural_property_rule.allowed (each also marked evidence_basis STRUCTURAL in its control), only as executable static evidence naming a standard-library primitive at an exact call site with client_selectable false; it is reported as structurally verified, not mutation-proven, and never applies to any other property.
- Real-system evidence (Phase 2U) counts only with a runner-side observation receipt: server-confirmed use of every real-system capability against the real upstream, and for properties marked as concurrency claims, observed overlapping execution. Declared type, environment or test output never count.

## 3. Deviations

| ID | Type | Control | Requirement | Status | Owner sign-off |
|---|---|---|---|---|---|
| DEV-PROTO-001 | PROTOCOL | CR-CRYPTO-008 | V11.6.1 | ACCEPTED | PENDING |
| DEV-PROTO-002 | PROTOCOL | CR-CRYPTO-009 | V11.4.1 | ACCEPTED | PENDING |
| DEV-PLAT-001 | PLATFORM | CR-TLS-003 | V4.1.2 | ACCEPTED | PENDING |
| DEV-CAND-001 | PROTOCOL | CR-AUTH-010 | V6.3.3 | REJECTED | NOT_REQUIRED |
| DEV-CAND-002 | PROTOCOL | CR-SESSION-008 | V7.5.2 | REJECTED | NOT_REQUIRED |
| DEV-CAND-003 | PLATFORM | CR-SUPPLY-007 | SLSA-1.2:build-L1-provenance | REJECTED | NOT_REQUIRED |

### DEV-PROTO-001

- Conflict: Appendix C Digital Signatures approves EdDSA (Ed25519, Ed448), XEdDSA, ECDSA (P-256, P-384, P-521), RSA-PSS; ECDSA over secp256k1 is not listed. Appendix C also states: "This list may be overridden in the context of a given application for various reasons including: new evolutions in the field of cryptography; compliance with regulation."
- Required by: SRC-ERC4361 §Signing and Verifying Messages with Ethereum Accounts; SRC-ERC191; SRC-ETH-YP Appendix F (Signing Transactions); SRC-ETH-EXECSPECS crypto/elliptic_curve.py secp256k1_recover — ERC-4361: "For Externally Owned Accounts (EOAs), the verification method specified in ERC-191 MUST be used." ERC-191 verification recovers the signer with ecrecover. Yellow Paper Appendix F: "Transactions are signed using recoverable ECDSA signatures. This method utilises the SECP-256k1 curve"; an Ethereum address is the rightmost 160 bits of the Keccak-256 hash of that ECDSA public key; ECREC = ECDSARECOVER over secp256k1n.
- Security impact: No standalone weakness demonstrated. secp256k1 gives ~128-bit security (V11.2.3 satisfied by CR-CRYPTO-005); it is not a NIST/FIPS curve, and no practical attack against it is known.
- Risk: Conformance-level deviation, low residual risk: (1) future cryptanalysis of secp256k1, shared with the whole Ethereum ecosystem; (2) no crypto agility for EOA verification (tracked separately by CR-CRYPTO-004, not hidden here); (3) signature malleability: the recovery stack accepts the high-s twin of a valid signature (Q-CRYPTO-LOW-S, EV-PROBE-LOW-S); no impact found because a malleated signature recovers the same signer, signatures are never stored or used as identifiers, and every challenge is single-use (CR-CONC-001).
- Mitigations: verification only through viem 2.55.13 -> @noble/curves 1.9.1 (no custom curve arithmetic), lockfile-pinned with integrity hashes and CI registry-signature verification (CR-SUPPLY-001/004); field checks (domain, uri, chain-id, nonce, times, address) before any signature check (CR-AUTH-001); single-use, short-lived server challenges (CR-CONC-001, CR-SESSION-002); exact 65-byte EOA signature format checked before recovery; contract wallets verified by the wallet contract via ERC-1271 with two providers at one block (CR-AUTH-003)
- Review triggers: ERC_EIP_REQUIREMENT_CHANGE, ETH_SIGNATURE_PRIMITIVE_CHANGE, SAFE_SIGNATURE_MODEL_CHANGE, CRYPTANALYSIS, LIBRARY_REPLACEMENT, CHAIN_OR_SCHEME_MIGRATION, ASVS_CRYPTO_GUIDANCE_CHANGE
- Evidence question Q-CRYPTO-LOW-S (ANSWERED): Does the current ECDSA recovery stack enforce or normalise low-s signatures? — No. viem 2.55.13 verifyMessage -> @noble/curves 1.9.1 recovery accepts the high-s twin (n - s, flipped v) of a valid signature for the same address (EV-PROBE-LOW-S, reproducible). Impact: INFORMATIONAL - not an authentication bypass: the twin proves the same key; replay protection is the single-use server nonce, not signature uniqueness; signatures are never persisted or used as keys (source search 2026-10-16).

### DEV-PROTO-002

- Conflict: Appendix C approves SHA3-512/384/256, SHA-512/384/256, SHA-512/256, SHAKE256, BLAKE2s/b, BLAKE3 for digital signatures; Keccak-256 (original Keccak padding, not FIPS 202) is not listed. It is not listed as Disallowed either.
- Required by: SRC-ERC4361 §Signing and Verifying Messages with Ethereum Accounts; SRC-ERC191 (version 0x45 personal_sign; verification example keccak256 + ecrecover); SRC-ERC1271 (isValidSignature(bytes32 hash, ...)); SRC-ETH-YP §Conventions KEC, Appendix E ECREC, Appendix F; SRC-ETH-EXECSPECS crypto/hash.py keccak256 — Wallets sign keccak256("\x19Ethereum Signed Message:\n" + len + message) (ERC-191 personal_sign); ecrecover and ERC-1271 isValidSignature take that 32-byte digest. The Yellow Paper defines KEC as "the Keccak-256 hash function (... rather than the final SHA-3 specification)".
- Security impact: No standalone weakness demonstrated. Keccak-256 differs from SHA3-256 only in domain-separation padding and offers the same 256-bit output and 128-bit collision resistance.
- Risk: Conformance-level deviation, low residual risk: (1) future cryptanalysis of Keccak, shared with SHA-3 and Ethereum; (2) scope creep: Keccak must not spread to application-chosen hashing (guarded by CR-CRYPTO-007 and CR-CRYPTO-009 P4).
- Mitigations: Keccak only via viem hashMessage/verifyMessage -> @noble/hashes 1.8.0; application-chosen hashing is SHA-256 / HMAC-SHA-256 only (CR-CRYPTO-007); lockfile integrity and registry-signature verification for the hashing library (CR-SUPPLY-001/004)
- Review triggers: ERC_EIP_REQUIREMENT_CHANGE, ETH_SIGNATURE_PRIMITIVE_CHANGE, SAFE_SIGNATURE_MODEL_CHANGE, CRYPTANALYSIS, LIBRARY_REPLACEMENT, CHAIN_OR_SCHEME_MIGRATION, ASVS_CRYPTO_GUIDANCE_CHANGE

### DEV-PLAT-001

- Conflict: http://coverraccoon.com/api/* is answered with 308 to https by the Vercel edge (observed 2026-10-16).
- Required by: SRC-VERCEL-ENC — Vercel: "HTTPS redirection is an industry standard and can't be disabled."
- Security impact: A client that erroneously sends an API request over HTTP leaks that request in clear text and the redirect hides the mistake.
- Risk: Low and bounded: the only intended API client is the same-origin HTTPS frontend (relative fetches; mixed content is blocked); HSTS max-age 1 year with includeSubDomains on all hosts; session cookies are Secure and __Host- (never sent over HTTP); Bearer credentials are never accepted; Telegram setWebhook only accepts HTTPS URLs; Vercel Cron calls are platform-internal. Residual: domain not on the HSTS preload list, so a first-contact browser can still send one HTTP navigation (not an API request with credentials).
- Mitigations: HSTS max-age=31536000; includeSubDomains; __Host-/Secure session cookies; no header-based credentials accepted; recommended (not implemented): HSTS preload
- Review triggers: PLATFORM_OPTION, PLATFORM_CHANGE, NEW_API_CLIENT, CREDENTIAL_MODEL_CHANGE, HSTS_CHANGE, ASVS_CHANGE
- Evidence property HSTS_STATE: EV-PROD-HEADERS (manual production record, 2026-10-16: max-age=31536000; includeSubDomains) (counts for security status: no)
- Evidence property PRELOAD_STATE: hstspreload.org status "unknown" (2026-10-16) (counts for security status: no)
- Evidence property PRODUCTION_REDIRECT_BEHAVIOUR: EV-PROD-TLS (manual production record: HTTP /api -> 308 https) (counts for security status: no)

## 4. Controls

| ID | Title | Class | Min | Security | Conformance | Reason |
|---|---|---|---|---|---|---|
| CR-AUTH-001 | SIWE message verified against server-side expectation | RELEASE_BLOCKING | E4 | **PASS_AUTOMATED** | CONFORMANT | all 5 sub-properties satisfied at >= E4 |
| CR-AUTH-002 | EOA signatures verified per ERC-191 for exactly the claimed address | RELEASE_BLOCKING | E4 | **PASS_AUTOMATED** | CONFORMANT | all 2 sub-properties satisfied at >= E4 |
| CR-AUTH-003 | Contract wallets authenticated only via ERC-1271 on chain-id 1 | RELEASE_BLOCKING | E4 | **PASS_AUTOMATED** | CONFORMANT | all 4 sub-properties satisfied at >= E4 |
| CR-AUTH-004 | Safe on-chain approval is challenge-bound and single-use server-side | RELEASE_BLOCKING | E4 | **PASS_AUTOMATED** | CONFORMANT | all 3 sub-properties satisfied at >= E4 |
| CR-AUTH-005 | Provider/classification results never authorize identity | RELEASE_BLOCKING | E4 | **PASS_AUTOMATED** | CONFORMANT | all 2 sub-properties satisfied at >= E4 |
| CR-AUTH-006 | Sessions bound to the verified address; new token per authentication | RELEASE_BLOCKING | E4 | **PASS_AUTOMATED** | CONFORMANT | all 3 sub-properties satisfied at >= E4 |
| CR-AUTH-007 | Fresh authority for destructive actions of contract sessions | RELEASE_BLOCKING | E4 | **PASS_AUTOMATED** | CONFORMANT | all 3 sub-properties satisfied at >= E4 |
| CR-AUTH-008 | Challenge nonces and codes from CSPRNG with >= 128 bits | RELEASE_BLOCKING | E3 | **PASS_AUTOMATED** | CONFORMANT | all 2 sub-properties satisfied at >= E3 |
| CR-AUTH-009 | Authentication pathways documented | SECURITY_DEBT | E1 | **FAIL** | NON_CONFORMANT | P1: no pathway document [EV-DOC-INVENTORY] |
| CR-AUTH-010 | Multi-factor or combined factors for access | SECURITY_DEBT | E1 | **FAIL** | NON_CONFORMANT | P1: wallet signature is the only factor [EV-INSPECT-ARCH] |
| CR-AUTH-011 | Anti-automation controls for authentication documented | SECURITY_DEBT | E1 | **FAIL** | NON_CONFORMANT | P1: no anti-automation document [EV-DOC-INVENTORY] |
| CR-AUTH-012 | No default or built-in accounts | MANUAL_ASSURANCE | E1 | **PASS_MANUAL** | CONFORMANT | all 1 sub-properties satisfied at >= E1 |
| CR-SESSION-001 | Self-contained tokens MAC-verified with fixed algorithm and server key | RELEASE_BLOCKING | E4 | **PASS_AUTOMATED** | CONFORMANT | all 3 sub-properties satisfied at >= E4 |
| CR-SESSION-002 | Token validity enforced from signed exp; stored challenge expiry enforced | RELEASE_BLOCKING | E4 | **PASS_AUTOMATED** | CONFORMANT | all 4 sub-properties satisfied at >= E4 |
| CR-SESSION-003 | Token type and purpose separation | RELEASE_BLOCKING | E4 | **PASS_AUTOMATED** | CONFORMANT | all 2 sub-properties satisfied at >= E4 |
| CR-SESSION-004 | Session cookie attributes | RELEASE_BLOCKING | E3 | **PASS_AUTOMATED** | CONFORMANT | all 2 sub-properties satisfied at >= E3 |
| CR-SESSION-005 | No JS-readable session token; Bearer not accepted | RELEASE_BLOCKING | E4 | **PASS_AUTOMATED** | CONFORMANT | all 2 sub-properties satisfied at >= E4 |
| CR-SESSION-006 | Absolute session lifetime and inactivity timeout | SECURITY_DEBT | E3 | **FAIL** | NON_CONFORMANT | P3: no lifetime decision document [EV-DOC-INVENTORY]; P2: no inactivity timeout [EV-INSPECT-ARCH] |
| CR-SESSION-007 | Logout/revocation invalidates self-contained sessions server-side | RELEASE_BLOCKING | E5 | **PASS_AUTOMATED** | CONFORMANT | all 2 sub-properties satisfied at >= E5 |
| CR-SESSION-008 | Users can view and terminate active sessions | SECURITY_DEBT | E3 | **FAIL** | NON_CONFORMANT | P2: self-contained tokens; no session listing [EV-INSPECT-ARCH] |
| CR-SESSION-009 | Concurrent-session policy documented | SECURITY_DEBT | E1 | **FAIL** | NON_CONFORMANT | P1: no parallel-session policy [EV-DOC-INVENTORY] |
| CR-SESSION-010 | Visible logout on authenticated pages | MANUAL_ASSURANCE | E1 | **PASS_MANUAL** | CONFORMANT | all 1 sub-properties satisfied at >= E1 |
| CR-SESSION-011 | Tokens accepted only by their issuing service (audience) | SECURITY_DEBT | E3 | **MISSING_EVIDENCE** | NOT_DEMONSTRATED | P1 unsatisfied; P2 unsatisfied |
| CR-API-001 | Object-level authorization: wallet only from the verified session | RELEASE_BLOCKING | E4 | **PASS_AUTOMATED** | CONFORMANT | all 4 sub-properties satisfied at >= E4 |
| CR-API-002 | Function-level authorization of machine endpoints | RELEASE_BLOCKING | E4 | **PASS_AUTOMATED** | CONFORMANT | all 3 sub-properties satisfied at >= E4 |
| CR-API-003 | Strict request bodies validated server-side | RELEASE_BLOCKING | E3 | **PASS_AUTOMATED** | CONFORMANT | all 3 sub-properties satisfied at >= E3 |
| CR-API-004 | Query parameters cannot alter scope | RELEASE_BLOCKING | E3 | **PASS_AUTOMATED** | CONFORMANT | all 2 sub-properties satisfied at >= E3 |
| CR-API-005 | Content-type and body-size limits independent of headers | RELEASE_BLOCKING | E3 | **PASS_AUTOMATED** | CONFORMANT | all 2 sub-properties satisfied at >= E3 |
| CR-API-006 | Generic errors without internals; secure failure | SECURITY_DEBT | E3 | **MISSING_EVIDENCE** | NOT_DEMONSTRATED | P1 unsatisfied (partial only: EV-ATTRIB); P2 unsatisfied |
| CR-API-007 | Response minimization | SECURITY_DEBT | E3 | **MISSING_EVIDENCE** | NOT_DEMONSTRATED | P1 unsatisfied (below E3/not acceptable: EV-TG-ISO-SRC(E1: type not acceptable for minimum level)) |
| CR-API-008 | State-changing operations not on safe methods | SECURITY_DEBT | E3 | **FAIL** | NON_CONFORMANT | P1: GET /api/position-attributions deletes provably stale rows [EV-INSPECT-ARCH] |
| CR-API-009 | Business flows enforce step order | RELEASE_BLOCKING | E3 | **PASS_AUTOMATED** | CONFORMANT | all 3 sub-properties satisfied at >= E3 |
| CR-API-010 | High-value flows require multi-party approval | MANUAL_ASSURANCE | E1 | **PASS_MANUAL** | CONFORMANT | all 1 sub-properties satisfied at >= E1 |
| CR-API-011 | Client IP from trusted intermediary fields only | MANUAL_ASSURANCE | E1 | **MISSING_EVIDENCE** | NOT_DEMONSTRATED | P1 unsatisfied; P2 unsatisfied |
| CR-API-012 | Authorization rules documented | SECURITY_DEBT | E1 | **FAIL** | NON_CONFORMANT | P1: no authorization rule document [EV-DOC-INVENTORY] |
| CR-DB-001 | RLS on all tables; no anon/authenticated privileges | RELEASE_BLOCKING | E5 | **PASS_AUTOMATED** | CONFORMANT | all 3 sub-properties satisfied at >= E5 |
| CR-DB-002 | RPC execute rights: service_role only; internal helpers none | RELEASE_BLOCKING | E5 | **PASS_AUTOMATED** | CONFORMANT | all 1 sub-properties satisfied at >= E5 |
| CR-DB-003 | SECURITY DEFINER functions: search_path with pg_temp last | SECURITY_DEBT | E1 | **FAIL** | NON_CONFORMANT | P1: search_path=public without pg_temp on 6 functions [EV-PROD-DB] |
| CR-DB-004 | Forward-only migrations; production history equals repository | MANUAL_ASSURANCE | E1 | **PASS_MANUAL** | CONFORMANT | all 1 sub-properties satisfied at >= E1 |
| CR-CONC-001 | Login challenges and access codes single-use under concurrency | RELEASE_BLOCKING | E5 | **PASS_AUTOMATED** | CONFORMANT | all 3 sub-properties satisfied at >= E5 |
| CR-CONC-002 | Wallet-per-chat limit and link-code single use atomic | RELEASE_BLOCKING | E5 | **PASS_AUTOMATED** | CONFORMANT | all 2 sub-properties satisfied at >= E5 |
| CR-CONC-003 | Attribution limit (60/wallet) atomic | RELEASE_BLOCKING | E5 | **PASS_AUTOMATED** | CONFORMANT | all 3 sub-properties satisfied at >= E5 |
| CR-CONC-004 | Stale cleanup is compare-and-delete | RELEASE_BLOCKING | E5 | **PASS_AUTOMATED** | CONFORMANT | all 2 sub-properties satisfied at >= E5 |
| CR-CONC-005 | Session revocation atomic per wallet | RELEASE_BLOCKING | E5 | **PASS_AUTOMATED** | CONFORMANT | all 1 sub-properties satisfied at >= E5 |
| CR-CONC-006 | Locks consistent, deadlock-free and local | SECURITY_DEBT | E3 | **PASS_AUTOMATED** | CONFORMANT | all 3 sub-properties satisfied at >= E3 |
| CR-RESOURCE-001 | Rate limits before expensive work (IP, wallet, global) | RELEASE_BLOCKING | E3 | **PASS_AUTOMATED** | CONFORMANT | all 5 sub-properties satisfied at >= E3 |
| CR-RESOURCE-002 | Rate limiter counting atomic | SECURITY_DEBT | E5 | **PASS_AUTOMATED** | CONFORMANT | all 1 sub-properties satisfied at >= E5 |
| CR-RESOURCE-003 | Cron run budgets, pagination and failure isolation | RELEASE_BLOCKING | E3 | **PASS_AUTOMATED** | CONFORMANT | all 4 sub-properties satisfied at >= E3 |
| CR-RESOURCE-004 | Dashboard provider amplification bounded | RELEASE_BLOCKING | E3 | **PASS_AUTOMATED** | CONFORMANT | all 2 sub-properties satisfied at >= E3 |
| CR-RESOURCE-005 | Business-logic limits documented | SECURITY_DEBT | E1 | **FAIL** | NON_CONFORMANT | P1: limits only in code [EV-DOC-INVENTORY] |
| CR-RESOURCE-006 | Resource-demanding functionality documented | SECURITY_DEBT | E1 | **FAIL** | NON_CONFORMANT | P1: no resource document [EV-DOC-INVENTORY] |
| CR-RESOURCE-007 | Telegram cover lookups budgeted per chat and globally | RELEASE_BLOCKING | E3 | **PASS_AUTOMATED** | CONFORMANT | all 1 sub-properties satisfied at >= E3 |
| CR-TELEGRAM-001 | Webhook authenticity, private chats only, update replay | RELEASE_BLOCKING | E4 | **PASS_AUTOMATED** | CONFORMANT | all 3 sub-properties satisfied at >= E4 |
| CR-TELEGRAM-002 | Wallet-to-chat binding only via signed link flow | RELEASE_BLOCKING | E4 | **PASS_AUTOMATED** | CONFORMANT | all 2 sub-properties satisfied at >= E4 |
| CR-TELEGRAM-003 | callback_data is untrusted input | RELEASE_BLOCKING | E4 | **PASS_AUTOMATED** | CONFORMANT | all 2 sub-properties satisfied at >= E4 |
| CR-TELEGRAM-004 | Unlink/disconnect scope | RELEASE_BLOCKING | E3 | **PASS_AUTOMATED** | CONFORMANT | all 2 sub-properties satisfied at >= E3 |
| CR-PROVIDER-001 | External data validated; failures fail closed | RELEASE_BLOCKING | E3 | **PASS_AUTOMATED** | CONFORMANT | all 4 sub-properties satisfied at >= E3 |
| CR-PROVIDER-002 | Outbound timeouts and bounded retries | SECURITY_DEBT | E3 | **MISSING_EVIDENCE** | NOT_DEMONSTRATED | P1 unsatisfied (partial only: EV-NEXUS,EV-RPC-RETRIES); P2 unsatisfied (partial only: EV-RPC-RETRIES) |
| CR-PROVIDER-003 | Outbound destinations allowlisted (SSRF) | RELEASE_BLOCKING | E3 | **PASS_AUTOMATED** | CONFORMANT | all 3 sub-properties satisfied at >= E3 |
| CR-DOC-001 | Remote document size, time and decompression bounds | RELEASE_BLOCKING | E3 | **PASS_AUTOMATED** | CONFORMANT | all 3 sub-properties satisfied at >= E3 |
| CR-DOC-002 | PDF parser fails closed on hostile structure | RELEASE_BLOCKING | E3 | **PASS_AUTOMATED** | CONFORMANT | all 2 sub-properties satisfied at >= E3 |
| CR-DOC-003 | Document cache bounded and product-scoped | RELEASE_BLOCKING | E3 | **PASS_AUTOMATED** | CONFORMANT | all 2 sub-properties satisfied at >= E3 |
| CR-DOC-004 | Document text isolated from model instructions | RELEASE_BLOCKING | E3 | **PASS_AUTOMATED** | CONFORMANT | all 3 sub-properties satisfied at >= E3 |
| CR-DOC-005 | Document-intake limits documented | SECURITY_DEBT | E1 | **FAIL** | NON_CONFORMANT | P1: limits only in code [EV-DOC-INVENTORY] |
| CR-BROWSER-001 | Security headers served in production | MANUAL_ASSURANCE | E1 | **PASS_MANUAL** | CONFORMANT | all 3 sub-properties satisfied at >= E1 |
| CR-BROWSER-002 | Cross-origin request forgery prevention | RELEASE_BLOCKING | E3 | **PASS_AUTOMATED** | CONFORMANT | all 3 sub-properties satisfied at >= E3 |
| CR-BROWSER-003 | No CORS exposure of authenticated APIs | MANUAL_ASSURANCE | E1 | **PASS_MANUAL** | CONFORMANT | all 1 sub-properties satisfied at >= E1 |
| CR-BROWSER-004 | Untrusted data rendered as text only (XSS) | RELEASE_BLOCKING | E3 | **PASS_AUTOMATED** | CONFORMANT | all 3 sub-properties satisfied at >= E3 |
| CR-BROWSER-005 | Safe App postMessage trust | SECURITY_DEBT | E3 | **MISSING_EVIDENCE** | NOT_DEMONSTRATED | P1 unsatisfied |
| CR-BROWSER-006 | Responses rendered in the correct context | MANUAL_ASSURANCE | E1 | **PASS_MANUAL** | CONFORMANT | all 1 sub-properties satisfied at >= E1 |
| CR-BROWSER-007 | One application per origin | MANUAL_ASSURANCE | E1 | **PASS_MANUAL** | CONFORMANT | all 1 sub-properties satisfied at >= E1 |
| CR-BROWSER-008 | Authenticated resources loaded only when intended | SECURITY_DEBT | E3 | **MISSING_EVIDENCE** | NOT_DEMONSTRATED | P1 unsatisfied (below E3/not acceptable: EV-PROD-HEADERS(E5,non-reproducible: non-reproducible (only dated manual records for MANUAL_ASSURANCE/automation NO))); P2 unsatisfied |
| CR-BROWSER-009 | Only supported client-side technologies | MANUAL_ASSURANCE | E1 | **PASS_MANUAL** | CONFORMANT | all 1 sub-properties satisfied at >= E1 |
| CR-BROWSER-010 | Automatic redirects only to allowlisted destinations | MANUAL_ASSURANCE | E1 | **PASS_MANUAL** | CONFORMANT | all 1 sub-properties satisfied at >= E1 |
| CR-TLS-001 | Only current TLS versions and recommended cipher suites | MANUAL_ASSURANCE | E1 | **MISSING_EVIDENCE** | NOT_DEMONSTRATED | P2 unsatisfied |
| CR-TLS-002 | TLS with publicly trusted certificates for external services | MANUAL_ASSURANCE | E1 | **PASS_MANUAL** | CONFORMANT | all 2 sub-properties satisfied at >= E1 |
| CR-TLS-003 | No transparent HTTP->HTTPS redirect for API endpoints | SECURITY_DEBT | E1 | **MISSING_EVIDENCE** | ACCEPTED_PLATFORM_DEVIATION | P2 unsatisfied (below E1/not acceptable: EV-PROD-HEADERS(E5,non-reproducible: non-reproducible (only dated manual records for MANUAL_ASSURANCE/automation NO))) |
| CR-TLS-004 | All service connections use validated TLS | SECURITY_DEBT | E1 | **MISSING_EVIDENCE** | NOT_DEMONSTRATED | P1 unsatisfied; P2 unsatisfied; P3 unsatisfied |
| CR-CRYPTO-001 | Key-management policy and lifecycle documented | SECURITY_DEBT | E1 | **MISSING_EVIDENCE** | NOT_DEMONSTRATED | P1 unsatisfied (partial only: EV-DOC-INVENTORY) |
| CR-CRYPTO-002 | Cryptographic inventory | SECURITY_DEBT | E1 | **FAIL** | NON_CONFORMANT | P1: no crypto inventory [EV-DOC-INVENTORY] |
| CR-CRYPTO-003 | Industry-validated crypto implementations | MANUAL_ASSURANCE | E1 | **PASS_MANUAL** | CONFORMANT | all 1 sub-properties satisfied at >= E1 |
| CR-CRYPTO-004 | Crypto agility | SECURITY_DEBT | E1 | **MISSING_EVIDENCE** | NOT_DEMONSTRATED | P1 unsatisfied (partial only: EV-DOC-INVENTORY) |
| CR-CRYPTO-005 | Primitives provide >= 128-bit security | MANUAL_ASSURANCE | E1 | **PASS_MANUAL** | CONFORMANT | all 1 sub-properties satisfied at >= E1 |
| CR-CRYPTO-006 | No insecure ciphers/modes; authenticated encryption only | MANUAL_ASSURANCE | E1 | **PASS_MANUAL** | CONFORMANT | all 1 sub-properties satisfied at >= E1 |
| CR-CRYPTO-007 | Application-chosen hash functions approved | MANUAL_ASSURANCE | E1 | **PASS_MANUAL** | CONFORMANT | all 2 sub-properties satisfied at >= E1 |
| CR-CRYPTO-008 | Wallet-signature algorithm (ECDSA over secp256k1) vs ASVS approved signatures | INFORMATIONAL | E1 | **INFORMATIONAL** | ACCEPTED_PROTOCOL_DEVIATION | P1 covered by accepted PROTOCOL deviation; all 3 remaining sub-properties satisfied at >= E1; no defect |
| CR-CRYPTO-009 | Wallet-message digest (Keccak-256) vs ASVS approved hashes | INFORMATIONAL | E1 | **INFORMATIONAL** | ACCEPTED_PROTOCOL_DEVIATION | P1 covered by accepted PROTOCOL deviation; all 3 remaining sub-properties satisfied at >= E1; no defect |
| CR-CONFIG-001 | Communication needs documented | SECURITY_DEBT | E1 | **MISSING_EVIDENCE** | NOT_DEMONSTRATED | P1 unsatisfied (partial only: EV-DOC-INVENTORY) |
| CR-CONFIG-002 | No default credentials for service authentication | MANUAL_ASSURANCE | E1 | **MISSING_EVIDENCE** | NOT_DEMONSTRATED | P1 unsatisfied |
| CR-CONFIG-003 | Debug modes disabled in production | SECURITY_DEBT | E1 | **FAIL** | NON_CONFORMANT | P1: ?debug=wallet enables a debug panel in production [EV-INSPECT-ARCH] |
| CR-CONFIG-004 | No directory listings | MANUAL_ASSURANCE | E1 | **PASS_MANUAL** | CONFORMANT | all 1 sub-properties satisfied at >= E1 |
| CR-CONFIG-005 | HTTP TRACE not supported | MANUAL_ASSURANCE | E1 | **PASS_MANUAL** | CONFORMANT | all 1 sub-properties satisfied at >= E1 |
| CR-CONFIG-006 | No unintended documentation/monitoring endpoints | MANUAL_ASSURANCE | E1 | **PASS_MANUAL** | CONFORMANT | all 1 sub-properties satisfied at >= E1 |
| CR-CONFIG-007 | HTTP message boundaries determined consistently | MANUAL_ASSURANCE | E1 | **MISSING_EVIDENCE** | NOT_DEMONSTRATED | P1 unsatisfied |
| CR-CONFIG-008 | Production contains only required functionality | MANUAL_ASSURANCE | E1 | **PASS_MANUAL** | CONFORMANT | all 2 sub-properties satisfied at >= E1 |
| CR-INPUT-001 | Input decoded to canonical form once | SECURITY_DEBT | E3 | **MISSING_EVIDENCE** | NOT_DEMONSTRATED | P1 unsatisfied |
| CR-INPUT-002 | Output encoded at the interpreter boundary (incl. JSON) | SECURITY_DEBT | E3 | **MISSING_EVIDENCE** | NOT_DEMONSTRATED | P1 unsatisfied |
| CR-INPUT-003 | URLs built with context encoding and safe schemes | SECURITY_DEBT | E3 | **MISSING_EVIDENCE** | NOT_DEMONSTRATED | P1 unsatisfied; P2 unsatisfied |
| CR-INPUT-004 | Database access parameterized | RELEASE_BLOCKING | E3 | **PASS_AUTOMATED** | CONFORMANT | all 2 sub-properties satisfied at >= E3 |
| CR-INPUT-005 | No OS command execution | SECURITY_DEBT | E1 | **MISSING_EVIDENCE** | NOT_DEMONSTRATED | P1 unsatisfied |
| CR-INPUT-006 | Regex metacharacters escaped for untrusted input | SECURITY_DEBT | E1 | **MISSING_EVIDENCE** | NOT_DEMONSTRATED | P1 unsatisfied |
| CR-INPUT-007 | Data sanitized before dangerous contexts | SECURITY_DEBT | E3 | **MISSING_EVIDENCE** | NOT_DEMONSTRATED | P1 unsatisfied |
| CR-INPUT-008 | Format strings not influenced by untrusted data | SECURITY_DEBT | E1 | **MISSING_EVIDENCE** | NOT_DEMONSTRATED | P1 unsatisfied |
| CR-INPUT-009 | Input validation rules documented | SECURITY_DEBT | E1 | **FAIL** | NON_CONFORMANT | P1: no validation rule document [EV-DOC-INVENTORY] |
| CR-INPUT-010 | Cross-field consistency enforced | RELEASE_BLOCKING | E3 | **PASS_AUTOMATED** | CONFORMANT | all 3 sub-properties satisfied at >= E3 |
| CR-INPUT-011 | Strict typing and equality | SECURITY_DEBT | E1 | **MISSING_EVIDENCE** | NOT_DEMONSTRATED | P1 unsatisfied; P2 unsatisfied |
| CR-INPUT-012 | Prototype pollution prevented | SECURITY_DEBT | E3 | **MISSING_EVIDENCE** | NOT_DEMONSTRATED | P1 unsatisfied; P2 unsatisfied |
| CR-INPUT-013 | No templates built from untrusted input | SECURITY_DEBT | E1 | **MISSING_EVIDENCE** | NOT_DEMONSTRATED | P1 unsatisfied |
| CR-LOG-001 | Log inventory and destinations | SECURITY_DEBT | E1 | **MISSING_EVIDENCE** | NOT_DEMONSTRATED | P1 unsatisfied (partial only: EV-DOC-INVENTORY); P2 unsatisfied |
| CR-LOG-002 | Log entries carry investigation metadata | SECURITY_DEBT | E3 | **MISSING_EVIDENCE** | NOT_DEMONSTRATED | P1 unsatisfied (partial only: EV-SECEVENTS) |
| CR-LOG-003 | Synchronized time, UTC timestamps | SECURITY_DEBT | E3 | **MISSING_EVIDENCE** | NOT_DEMONSTRATED | P1 unsatisfied |
| CR-LOG-004 | Logs machine-readable for correlation | SECURITY_DEBT | E3 | **MISSING_EVIDENCE** | NOT_DEMONSTRATED | P1 unsatisfied |
| CR-LOG-005 | Sensitive data in logs per protection level | SECURITY_DEBT | E3 | **MISSING_EVIDENCE** | NOT_DEMONSTRATED | P2 unsatisfied |
| CR-LOG-006 | Unexpected errors and control failures logged | SECURITY_DEBT | E3 | **MISSING_EVIDENCE** | NOT_DEMONSTRATED | P1 unsatisfied; P2 unsatisfied |
| CR-LOG-007 | Log injection prevented | SECURITY_DEBT | E3 | **MISSING_EVIDENCE** | NOT_DEMONSTRATED | P1 unsatisfied |
| CR-LOG-008 | Logs protected from unauthorized access and modification | SECURITY_DEBT | E3 | **MISSING_EVIDENCE** | NOT_DEMONSTRATED | P1 unsatisfied (below E3/not acceptable: EV-PROD-DB(E5,non-reproducible: non-reproducible (only dated manual records for MANUAL_ASSURANCE/automation NO))); P2 unsatisfied |
| CR-LOG-009 | Logs transmitted to a separate system | SECURITY_DEBT | E1 | **MISSING_EVIDENCE** | NOT_DEMONSTRATED | P1 unsatisfied |
| CR-SUPPLY-001 | Reproducible install from lockfile, install scripts disabled | MANUAL_ASSURANCE | E1 | **PASS_MANUAL** | CONFORMANT | all 2 sub-properties satisfied at >= E1 |
| CR-SUPPLY-002 | CI actions pinned by commit SHA | MANUAL_ASSURANCE | E1 | **PASS_MANUAL** | CONFORMANT | all 1 sub-properties satisfied at >= E1 |
| CR-SUPPLY-003 | Least-privilege workflow token declared | SECURITY_DEBT | E1 | **FAIL** | NON_CONFORMANT | P2: ci.yml has no permissions block [EV-CFG] |
| CR-SUPPLY-004 | Registry signature/attestation verification | MANUAL_ASSURANCE | E1 | **PASS_MANUAL** | CONFORMANT | all 1 sub-properties satisfied at >= E1 |
| CR-SUPPLY-005 | Dependency vulnerability policy and update tooling | SECURITY_DEBT | E1 | **FAIL** | NON_CONFORMANT | P1: no remediation timeframes [EV-DOC-INVENTORY] |
| CR-SUPPLY-006 | Component inventory (SBOM) | SECURITY_DEBT | E1 | **MISSING_EVIDENCE** | NOT_DEMONSTRATED | P1 unsatisfied (partial only: EV-INSPECT-ARCH); P2 unsatisfied (partial only: EV-INSPECT-ARCH); P3 unsatisfied |
| CR-SUPPLY-007 | Build provenance for production deploys | SECURITY_DEBT | E1 | **FAIL** | NON_CONFORMANT | P1: deploys are CLI uploads from a workstation; no provenance is generated (SLSA Build L0) [EV-INSPECT-DEPLOY] |
| CR-SUPPLY-008 | Secret handling and secret scanning | SECURITY_DEBT | E3 | **MISSING_EVIDENCE** | NOT_DEMONSTRATED | P1 unsatisfied; P2 unsatisfied (below E3/not acceptable: EV-PROD-PROBES(E5,non-reproducible: non-reproducible (only dated manual records for MANUAL_ASSURANCE/automation NO))); P3 unsatisfied |
| CR-SUPPLY-009 | Production deploy only on explicit decision | MANUAL_ASSURANCE | E1 | **PASS_MANUAL** | CONFORMANT | all 1 sub-properties satisfied at >= E1 |
| CR-PRIV-001 | Data minimization of stored attributions | SECURITY_DEBT | E3 | **MISSING_EVIDENCE** | NOT_DEMONSTRATED | P1 unsatisfied (below E3/not acceptable: EV-ATTRIB-SCHEMA-SRC(E1: type not acceptable for minimum level)); P2 unsatisfied (below E3/not acceptable: EV-ATTRIB-SCHEMA-SRC(E1: type not acceptable for minimum level)) |
| CR-PRIV-002 | Retention and purge | SECURITY_DEBT | E3 | **PASS_AUTOMATED** | CONFORMANT | all 1 sub-properties satisfied at >= E3 |
| CR-PRIV-003 | No sensitive data to untrusted third parties | SECURITY_DEBT | E3 | **PASS_AUTOMATED** | CONFORMANT | all 2 sub-properties satisfied at >= E3 |
| CR-PRIV-004 | No credentials in URLs | SECURITY_DEBT | E3 | **FAIL** | NON_CONFORMANT | P1: /?access=<code> and /link?code=<code> [EV-INSPECT-ARCH] |
| CR-PRIV-005 | Authentication and security events logged | SECURITY_DEBT | E3 | **MISSING_EVIDENCE** | NOT_DEMONSTRATED | P2 unsatisfied |
| CR-PRIV-006 | Sensitive data classified with protection requirements | SECURITY_DEBT | E1 | **MISSING_EVIDENCE** | NOT_DEMONSTRATED | P1 unsatisfied (partial only: EV-DOC-INVENTORY); P2 unsatisfied (partial only: EV-DOC-INVENTORY) |
| CR-PRIV-007 | Sensitive data not retained in server caches | SECURITY_DEBT | E3 | **MISSING_EVIDENCE** | NOT_DEMONSTRATED | P1 unsatisfied; P2 unsatisfied |
| CR-PRIV-008 | Client storage cleared after session termination | SECURITY_DEBT | E3 | **MISSING_EVIDENCE** | NOT_DEMONSTRATED | P1 unsatisfied |
| CR-PRIV-009 | Anti-caching headers on sensitive responses | SECURITY_DEBT | E3 | **MISSING_EVIDENCE** | NOT_DEMONSTRATED | P1 unsatisfied (partial only: EV-PROD-HEADERS) |
| CR-VERIFY-001 | Unexpected cancelled tests fail CI | RELEASE_BLOCKING | E4 | **PASS_AUTOMATED** | CONFORMANT | all 1 sub-properties satisfied at >= E4 |
| CR-VERIFY-002 | Unexpected skipped/todo tests fail CI; only exact allowlisted DB skips without DB | RELEASE_BLOCKING | E4 | **PASS_AUTOMATED** | CONFORMANT | all 4 sub-properties satisfied at >= E4 |
| CR-VERIFY-003 | Security fixes carry reproducible known-bad/mutation proof | RELEASE_BLOCKING | E4 | **PASS_AUTOMATED** | CONFORMANT | all 1 sub-properties satisfied at >= E4 |
| CR-VERIFY-004 | Concurrency claims proven with real concurrent execution | RELEASE_BLOCKING | E5 | **MISSING_EVIDENCE** | NOT_DEMONSTRATED | P1 unsatisfied (partial only: EV-E5-OBSERVATION) (below E5/not acceptable: EV-CRSF-SELFTEST(E3: type not acceptable for minimum level)) |
| CR-VERIFY-005 | Security tests fail for the intended reason | RELEASE_BLOCKING | E4 | **PASS_AUTOMATED** | CONFORMANT | all 1 sub-properties satisfied at >= E4 |
| CR-VERIFY-006 | Production-code vs test-only changes distinguished per release | MANUAL_ASSURANCE | E1 | **MISSING_EVIDENCE** | NOT_DEMONSTRATED | P1 unsatisfied |
| CR-VERIFY-007 | Deployed artifact equals intended commit | MANUAL_ASSURANCE | E1 | **PASS_MANUAL** | CONFORMANT | all 1 sub-properties satisfied at >= E1 |
| CR-VERIFY-008 | Security claims identify untested/manual portions | MANUAL_ASSURANCE | E1 | **MISSING_EVIDENCE** | NOT_DEMONSTRATED | P1 unsatisfied |
| CR-VERIFY-009 | Tests that pass against known-bad code rejected as evidence | RELEASE_BLOCKING | E4 | **PASS_AUTOMATED** | CONFORMANT | all 1 sub-properties satisfied at >= E4 |
| CR-VERIFY-010 | Release-blocking controls not weakened to preserve release | RELEASE_BLOCKING | E3 | **PASS_AUTOMATED** | CONFORMANT | all 1 sub-properties satisfied at >= E3 |
| CR-VERIFY-011 | Controls derived from pinned sources before results | RELEASE_BLOCKING | E3 | **PASS_AUTOMATED** | CONFORMANT | all 1 sub-properties satisfied at >= E3 |
| CR-VERIFY-012 | Machine-readable status preserves FAIL and MISSING_EVIDENCE | RELEASE_BLOCKING | E3 | **PASS_AUTOMATED** | CONFORMANT | all 1 sub-properties satisfied at >= E3 |

## 5. Evidence

| ID | Type | Level | Runner | Coverage | Reproducible | Proves |
|---|---|---|---|---|---|---|
| EV-ATTRIB | behavioral | E3 | node-test | PARTIAL | yes | session-only wallet; strict body; product consistency; provider failure never deletes; public fields |
| EV-ATTRIB-SCHEMA-SRC | static | E1 | node-test | FULL | yes | migration columns identifiers only |
| EV-CFG | manual-inspection | E1 | manual | PARTIAL | no | npm ci --ignore-scripts, SHA pins, git deploys disabled, redirects own-host, no permissions block |
| EV-CI-GUARD | behavioral | E2 | static | PARTIAL | yes | observed cancelled=0, todo=0, allowed skips |
| EV-CI-SIG | manual-production | E5 | manual | FULL | no | signatures/attestations verified in CI |
| EV-COVERCHAIN | behavioral | E3 | node-test | PARTIAL | yes | cover index/chain strict validation |
| EV-CRON-AUTH | behavioral | E3 | node-test | PARTIAL | yes | cron endpoint: correct secret runs; missing, wrong (same and other length), malformed and non-string secrets get 401 with no run/purge/delivery/alert; unconfigured CRON_SECRET fails closed |
| EV-CRSF-ENGINE | behavioral | E3 | node-test | FULL | yes | the real mutation runner reports KILLED only for the named expected failure (else KILLED_OTHER/SURVIVED/INVALID); a declared EQUIVALENT that is detected is a claim violation; one SURVIVED/KILLED_OTHER/INVALID/NOT_RUN case, EQUIVALENT-only or static-only kills never prove a property |
| EV-CRSF-SELFTEST | behavioral | E3 | crsf-selftest | PARTIAL | yes | the verifier rejects known-bad framework fixtures: silent threshold reduction / release-class / applicability / derivation / property changes (lock), undocumented requirement clarifications, tampered pinned sources, manual status override, recorded status that does not recompute, E4 without a KILLED mutation, behavioural evidence relabelled E4/E5 or real-system without infrastructure, misuse of the structural rule |
| EV-CSP-CFG | config | E1 | node-test | PARTIAL | yes | vercel.json CSP text |
| EV-CSPRNG | behavioral | E3 | node-test | FULL | yes | challenge/action nonces, request ids, link code/nonce and dashboard access code are each the complete hex/base64url encoding of one node:crypto.randomBytes draw of 16/18/24 bytes; Math.random never used; no clock or counter mixed in |
| EV-DBPRIV-DB | real-system | E5 | node-test | FULL | yes | RLS on every public table; anon/authenticated hold no table privilege and really get 42501 on read/insert/delete of every table; no role can CREATE in public; function EXECUTE matches the allowlist exactly (5 runtime RPCs + legacy consume_wallet_link for service_role only; internal helpers for nobody; PUBLIC nowhere); SECURITY DEFINER set and pinned search_path |
| EV-DOC-INVENTORY | document-inspection | E1 | manual | PARTIAL | no | which security topics are documented |
| EV-ERC1271 | behavioral | E3 | node-test | PARTIAL | yes | magic exact, dual agreement, block binding, fail closed, budget |
| EV-FRONTEND-SCAN | static | E1 | node-test | PARTIAL | yes | no HTML sinks in web/src |
| EV-GH-SETTINGS | manual-production | E5 | manual | PARTIAL | no | default workflow token permissions = read |
| EV-GUARD | behavioral | E3 | node-test | FULL | yes | the guard fails on cancelled, failed, todo and unexpectedly skipped tests and on a discovered test file without any test case (only an import, an empty suite, tests behind a false condition, a comment); the DB skip allowlist is exact (file + name) and only valid while M1_DB_TEST_PG_URL is unset; a run without test files fails; the CRSF test executor reports a case-less file as a failure |
| EV-H2-DB | real-system | E5 | node-test | PARTIAL | yes | single consume under 2/10/40 concurrency; one session per challenge; stored expiry enforced |
| EV-H2-REQ | static | E1 | node-test | PARTIAL | yes | one conditional PATCH with all predicates |
| EV-INSPECT-ARCH | manual-inspection | E1 | manual | PARTIAL | no | architecture facts |
| EV-INSPECT-CRYPTO-PROTOCOL | manual-inspection | E1 | manual | PARTIAL | no | EOA verification = viem verifyMessage (recoverMessageAddress + isAddressEqual) over @noble/curves 1.9.1 secp256k1; digest = keccak256(ERC-191 prefix + message) via @noble/hashes 1.8.0; EOA signature format /^0x[0-9a-fA-F]{130}$/ checked first; field checks precede signature checks; Keccak only via hashMessage/verifyMessage; no custom curve or hash code |
| EV-INSPECT-DEPLOY | manual-inspection | E1 | manual | FULL | no | how production artifacts are produced |
| EV-KB-AUTH | known-bad | E4 | mutation | PARTIAL | yes | SIWE domain/uri/chain/nonce/issued-at/expiration/address checks, EOA signature result, no consume/no session on failed signatures, ERC-1271 magic value, consensus, block binding and fail-closed provider errors, token MAC (Phase 2A + 2B cases) |
| EV-KB-CRON | known-bad | E4 | mutation | PARTIAL | yes | cron endpoint authentication: missing/wrong/length-only/unconfigured secret variants are caught by test/cron-auth.test.mjs (Phase 2B closed the Phase 2A gap) |
| EV-KB-DBPRIV | known-bad | E4 | mutation | FULL | yes | privilege regressions (RLS off, table grant, CREATE grant, RPC grant to authenticated, exposed helper, PUBLIC execute) are each caught by the real-Postgres privilege test |
| EV-KB-ENGINE | known-bad | E4 | mutation | FULL | yes | runner/engine mutations that count wrong-reason failures as kills or ignore SURVIVED cases are caught |
| EV-KB-GUARD | known-bad | E4 | mutation | FULL | yes | guard mutations accepting cancelled, skipped or todo tests, loosening the DB skip allowlist, or letting a case-less test file pass (wrapper counted as a case, report line removed, executor result removed) are caught behaviourally |
| EV-KB-H2 | known-bad | E4 | mutation | PARTIAL | yes | challenge and access-code single use under real concurrency; stored expiry enforced (H2) |
| EV-KB-L1 | known-bad | E4 | mutation | PARTIAL | yes | 60-row attribution limit atomic under real concurrency; idempotent re-confirmation (L1) |
| EV-KB-L2 | known-bad | E4 | mutation | PARTIAL | yes | Telegram binding only through the signed link flow: signature bypasses and alternative binding RPCs are caught (L2) |
| EV-KB-L3 | known-bad | E4 | mutation | PARTIAL | yes | callback_data never authorizes; malformed callbacks rejected; snooze consistency (L3) |
| EV-KB-L4 | known-bad | E4 | mutation | PARTIAL | yes | classification never authorizes; signed exp and stored expiry enforced; unsigned tokens refused; getCode strictness (L4) |
| EV-KB-L5 | known-bad | E4 | mutation | PARTIAL | yes | wallet-scoped cleanup; compare-and-delete; no deletion on uncertain provider data (L5) |
| EV-KB-LOGIN | known-bad | E4 | mutation | FULL | yes | session wallet decoupled from the signer (MULTI_LAYER), kind not derived from authority, and pinned issue time are caught |
| EV-KB-ONCHAIN | known-bad | E4 | mutation | PARTIAL | yes | expiry, single use and wallet binding of the on-chain login removed at every redundant layer (MULTI_LAYER) are caught end-to-end on real Postgres; the single-layer open-check removal is declared EQUIVALENT |
| EV-KB-RANDOM | known-bad | E4 | mutation | FULL | yes | Math.random, clock-derived, shortened or truncated nonces/codes are each caught by the CSPRNG construction test |
| EV-KB-REVOKE | known-bad | E4 | mutation | FULL | yes | the revocation test fails when the SQL max-merge or advisory lock is removed, when logout skips the server-side revoke, when any endpoint ignores revocation, or when the cutoff boundary is off by one |
| EV-KB-SCOPE | known-bad | E4 | mutation | PARTIAL | yes | header- or body-supplied wallet overrides on dashboard and positions reads are caught |
| EV-KB-SESSION | known-bad | E4 | mutation | PARTIAL | yes | session/action expiry, token-type separation, action purpose binding, no body token, no Bearer fallback, contract fresh authority, legacy-token fail-closed and single-use fresh confirmation are each caught behaviourally |
| EV-KB-TELEGRAM | known-bad | E4 | mutation | PARTIAL | yes | webhook secret bypass, length-only compare, unconfigured secret, private-chat guard removal and update_id dedup removal are each caught behaviourally |
| EV-L1-DB | real-system | E5 | node-test | FULL | yes | 59+N -> 60; 0+100 -> 60; per-wallet; idempotent |
| EV-L2 | behavioral | E3 | node-test | PARTIAL | yes | both verify endpoints bind nothing without valid signature; RPC allowlist |
| EV-L3 | behavioral | E3 | node-test | PARTIAL | yes | callback_data never authority; malformed rejected |
| EV-L4 | behavioral | E3 | node-test | PARTIAL | yes | classification never authorizes; expiry/forgery independent; getCode strict |
| EV-L5-DB | real-system | E5 | node-test | PARTIAL | yes | wallet-scoped cleanup; compare-and-delete; races |
| EV-LOGIN | behavioral | E3 | node-test | PARTIAL | yes | foreign key/tampered/foreign-claim -> 401 without consume; replay 409 |
| EV-LOGIN-DB | real-system | E5 | node-test | PARTIAL | yes | on-chain approval: stored expiry, single use (sequential and 10 concurrent posts) and wallet binding (attacker Safe approving the victim text, other challenge, other Safe) enforced end-to-end; signature login: an attacker key cannot use a victim challenge; every login issues a new token and a login after logout is unrevoked |
| EV-M1 | behavioral | E3 | node-test | PARTIAL | yes | link-code limits before write; cron budgets/paging/cursor/isolation; cron secret |
| EV-M1-DB | real-system | E5 | node-test | PARTIAL | yes | wallet limit and single link under concurrency; pagination; grants of 6 functions |
| EV-M2 | behavioral | E3 | node-test | PARTIAL | yes | read budgets, cache, coalescing |
| EV-MUT-NEXUS-DOCUMENTS | known-bad | E4 | manual | FULL | no | tests fail for the intended reason on known-bad variants |
| EV-NEXUS | behavioral | E3 | node-test | PARTIAL | yes | URL allowlist, no redirects, bounds, parser, cache, data channel, JSON frame |
| EV-ONCHAIN | behavioral | E3 | node-test | PARTIAL | yes | on-chain approval only for issued challenge/wallet; strict body |
| EV-ORIGIN | behavioral | E3 | node-test | PARTIAL | yes | origin checks; JSON/size limits |
| EV-PRIV | behavioral | E3 | node-test | PARTIAL | yes | purge per policy; analytics redaction |
| EV-PROBE-LOW-S | behavioral | E2 | probe | FULL | yes | observation: viem verifyMessage (@noble/curves 1.9.1) accepts the high-s twin of a valid EOA signature (no low-s enforcement or normalisation) |
| EV-PROD-ALIASES | manual-production | E5 | manual | FULL | no | all hostnames alias the single app |
| EV-PROD-ALIGN | manual-production | E5 | manual | PARTIAL | no | deployed = commit |
| EV-PROD-DB | manual-production | E5 | manual | PARTIAL | no | RLS all tables; no API-role privileges; ACLs; no CREATE; 6 SECURITY DEFINER with search_path=public |
| EV-PROD-HEADERS | manual-production | E5 | manual | PARTIAL | no | HSTS, CSP, nosniff, referrer, COOP, CORP, no ACAO, API no-store |
| EV-PROD-MIGRATIONS | manual-production | E5 | manual | FULL | no | 15/15 aligned |
| EV-PROD-PROBES | manual-production | E5 | manual | PARTIAL | no | no listing (assets returns a bundled file), sources/tests/config not served, TRACE 405 |
| EV-PROD-TLS | manual-production | E5 | manual | PARTIAL | no | TLS1.0/1.1 refused; 1.2/1.3 ok; Let's Encrypt cert; HTTP 308 to HTTPS incl. /api |
| EV-QUERY | behavioral | E3 | node-test | PARTIAL | yes | duplicate/unexpected keys rejected by parser |
| EV-REVOKE-DB | real-system | E5 | node-test | FULL | yes | logout through the real dashboard handler writes a Postgres cutoff; every earlier session of that wallet is then refused at GET/POST/DELETE /api/dashboard, /api/positions and /api/position-attributions; other wallets and later sessions unaffected; an already-revoked credential cannot move the cutoff; 2/10/25 truly concurrent revokes always store the maximum and a later lower request never lowers it |
| EV-REVOKE-SRC | static | E1 | node-test | PARTIAL | yes | lock/cutoff text present |
| EV-RL | static | E1 | node-test | PARTIAL | yes | limits before expensive work (partly source order) |
| EV-RPC-RETRIES | behavioral | E3 | node-test | PARTIAL | yes | bounded RPC retries/timeouts |
| EV-SAFE-AUTH | behavioral | E3 | node-test | PARTIAL | yes | contract session 24h; fresh authority; Safe-App cookie |
| EV-SCOPE | behavioral | E3 | node-test | PARTIAL | yes | real dashboard and positions handlers read only the session wallet; header/query/body hints, a foreign cookie name and a Bearer token for wallet B never retarget a lookup or appear in the response |
| EV-SECEVENTS | behavioral | E3 | node-test | PARTIAL | yes | events recorded, pseudonymized, flood-limited |
| EV-SESSION | behavioral | E3 | node-test | PARTIAL | yes | HttpOnly transport; no body token; Bearer ignored; cookie conflict fails closed |
| EV-SESSION-TOKENS | behavioral | E3 | node-test | PARTIAL | yes | expired session (EOA 7 d, contract 24 h) and action tokens refused; challenge/session/action not interchangeable; action bound to purpose; Bearer-only requests never resolve a session |
| EV-SIWE | behavioral | E3 | node-test | FULL | yes | field mismatches rejected |
| EV-SIWE-TIME | behavioral | E3 | node-test | PARTIAL | yes | issued-at and expiration-time must equal the server-issued challenge values |
| EV-TG | behavioral | E3 | node-test | PARTIAL | yes | webhook secret; private only; dedup; link row kinds; stale Safe authority |
| EV-TG-ISO-SRC | static | E1 | node-test | PARTIAL | yes | source counts/strings |
| EV-WEBHOOK-AUTH | behavioral | E3 | node-test | PARTIAL | yes | real webhook: wrong/missing/same-length/unconfigured secrets rejected before dedupe and bot; redelivered update_id acknowledged as duplicate without a second bot run |
| EV-QUERY-AUTH | behavioral | E3 | node-test | PARTIAL | yes | every handler under api/ is classified (inventory test): positions and position-attributions reject any query before rate limit, session or lookup; alerts, config, csp-report, telegram and link/verify produce byte-identical responses and identical dependency calls (same arguments) with and without hostile queries (foreign wallet, admin, chat_id, role=service_role, debug, session, code, the webhook or cron secret, duplicate wallet); without the header secret no query authorizes alerts or telegram; link/verify takes code/wallet/signature only from the body; dashboard and link ignore undeclared names |
| EV-KB-QUERY | known-bad | E4 | mutation | PARTIAL | yes | a query that grants cron authority, carries the webhook secret, overrides the link body or changes the public configuration is caught by the differential/negative tests |
| EV-TOKEN-MAC | behavioral | E3 | node-test | PARTIAL | yes | P3: tokens signed with the real secret under sha1/224/384/512/512-256/sha3-256/md5 are rejected even when the token names that algorithm; alg none / empty signatures are rejected; key/kid/secret fields with a matching attacker signature are rejected while the same payload with the server key is accepted (fields inert). P2: every well-formed token reaches node:crypto.timingSafeEqual exactly once with the received and the expected MAC, and forcing its answer decides the outcome both ways (no other comparison exists); wrong-length MACs never reach a byte comparison |
| EV-KB-TOKEN-MAC | known-bad | E4 | mutation | PARTIAL | yes | replacing timingSafeEqual by Buffer.equals, adding an early-exit byte comparison, or letting the token choose the HMAC algorithm or key is caught behaviourally |
| EV-STRUCT-MAC-CMP | static | E1 | node-test | PARTIAL | yes | the MAC bytes are compared only by node:crypto.timingSafeEqual at src/dashboard-auth.mjs:106 after a public length check; no ===, equals or compare on the MAC |
| EV-STRUCT-MAC-ALG | static | E1 | node-test | PARTIAL | yes | the only HMAC construction is node:crypto.createHmac('sha256', secret()) at src/dashboard-auth.mjs:39: literal algorithm, key from DASHBOARD_SESSION_SECRET, nothing parsed from the token |
| EV-OUTBOUND | behavioral | E3 | node-test | PARTIAL | yes | every outbound call site in src/ and api/ (16 files, inventory test fails on a new one) is driven with hostile inputs (foreign URLs, //host, ../, @host, %2F, CRLF, metadata IP, file:, localhost) through the real code - Telegram (bot via the real webhook, getChat, operator alerts, alerts/link-verify/dashboard senders), OpenAI, Nexus API + IPFS, Alchemy RPC/NFT, Infura RPC, Supabase REST - and every request goes to a fixed https host on the default port with a fixed path template; inputs only appear in encoded query values or bodies; malformed inputs are refused before any request |
| EV-PROBE-GETCODE | behavioral | E2 | probe | PARTIAL | yes | regression proof (F-2D-2 fixed in Phase 2E): noContractCodeByQuorum does NOT read an eth_getCode answer without result (missing, null, empty HTTP 200) as "no contract code", while real code -> false, real 0x -> true, RPC error -> false; the probe exits 1 if the defect returns |
| EV-GETCODE | behavioral | E3 | node-test | PARTIAL | yes | noContractCodeByQuorum counts a provider for "no contract code" only on a positive, well-formed eth_getCode hex answer, through a real viem http transport (offline fetch): both "0x" -> true; both bytecode -> false; one provider 0x and the other (or both) answering with result omitted, null, undefined, "", "0", "0x0", number, boolean, object, array, malformed hex, malformed JSON, empty HTTP 200 (with and without JSON content type), JSON-RPC error, HTTP 500, wrong response shape, transport error or timeout -> false; disagreement -> false; missing provider -> false; exactly one eth_getCode per provider at "latest" |
| EV-GETCODE-CALLSITES | behavioral | E3 | node-test | PARTIAL | yes | the two decisions that use noContractCodeByQuorum fail closed on unknown/ambiguous getCode answers, run through the real code (api/dashboard.mjs handler, src/bot.mjs unlinkWalletFor, real DB helpers on fake PostgREST, wire-level offline providers): a legacy Safe session (no kind) still needs fresh authority for session-revoke and Telegram disconnect, sign-out only clears this device, no wallet-wide revocation, no chat unlinked; the Telegram "fully disconnect" stays chat-local with no revocation; controls: both providers "0x" -> EOA behaviour unchanged |
| EV-KB-GETCODE | known-bad | E4 | mutation | PARTIAL | yes | reintroducing F-2D-2 (getCode() ?? '0x') or coercing a missing raw eth_getCode result to "0x" is caught behaviourally by the quorum matrix and by both call-site regressions |
| EV-PROBE-LEGACY-RPC | behavioral | E2 | probe | PARTIAL | yes | regression proof (F-2F-1 fixed in Phase 2G): with every per-wallet and global key denied, a legacy session (no kind) reaches no provider on POST {action} or DELETE (429); with every gate admitting it is still classified by the providers; sessions with kind never reach a provider; the probe exits 1 if the defect returns |
| EV-LEGACY-ORDER | behavioral | E3 | node-test | PARTIAL | yes | real api/dashboard.mjs + real src/http-security.mjs guards + real noContractCodeByQuorum on two offline wire providers with per-provider request counters: for a legacy session (no kind) on POST {action}, DELETE sign-out and DELETE ?telegram=1, a denied per-IP, per-wallet (dashboard-action-wallet) or global (dashboard-action-verify-global) limit yields 429 with Alchemy 0, Infura 0 eth_getCode calls and no challenge store, revocation or unlink, and no later gate is consulted; admitted legacy requests are still classified by both providers (contract code -> fresh authority required; both 0x -> legacy EOA behaviour); the wallet budget is charged once; sessions with kind eoa/contract make no provider call and pass exactly their previous gates |
| EV-KB-LEGACY-ORDER | known-bad | E4 | mutation | PARTIAL | yes | moving the provider lookup before the gates on POST, bypassing the gate on DELETE sign-out or on DELETE ?telegram=1, or removing the global or the per-wallet gate from the shared helper is each caught behaviourally (provider calls or writes observed under a denied limit) |
| EV-PROBE-ATTRIB-COVERS | behavioral | E2 | probe | PARTIAL | yes | regression proof (finding F-2H-1, fixed in Phase 2I): real createAttributionsHandler + real http-security guards + real getWalletPositions cache; with a denied global cover budget a POST reaches no cover provider for cold and warm positions caches (429), an admitted POST still reaches the provider and writes, and the warm request makes no positions RPC (cache intact). History: in Phase 2H it reproduced the defect (warm cache, every global budget denied -> cover provider reached and the attribution written). |
| EV-ATTRIB-COVER-BUDGET | behavioral | E3 | node-test | PARTIAL | yes | real createAttributionsHandler + real http-security guards + real getWalletPositions cache + real getWalletCovers up to the wire: with the global cover budget (dashboard-read-global, 300/600 s) denied, POST and GET return 429 with Alchemy NFT 0 / Nexus 0 / getCovers 0 calls and no write, for cold, warm and failure positions caches; the limit order is identical across cache states except positions-lookup-global on a miss; admitted requests make exactly one cover lookup, charge the cover budget once and keep their previous results; paths without a cover lookup charge nothing |
| EV-KB-ATTRIB-COVER-BUDGET | known-bad | E4 | mutation | PARTIAL | yes | bypassing the global cover budget on POST or on GET, charging it only on a positions-cache miss (the original F-2H-1 shape) or checking it after the lookup is each detected by the intended test and message |
| EV-PROBE-TG-COVERS | behavioral | E2 | probe | FULL | yes | regression proof (finding F-2I-1, fixed in Phase 2J): real src/bot.mjs handleUpdate with an offline recording fetch; for every Telegram cover entry point and 1 and 10 linked wallets, a denied chat or global cover budget yields 0 cover lookups, and an admitted request makes one lookup per wallet after both budgets were charged once per wallet. History: before the fix (Phase 2J) it reproduced the defect - 1 -> 1 and 10 -> 10 lookups with no cover budget before them. |
| EV-TG-COVER-BUDGET | behavioral | E3 | node-test | FULL | yes | real src/bot.mjs handleUpdate + real db/covers/cover-chain up to an offline wire: for the /covers command, the show_covers button and the AI intents show_covers and show_next_expiry, with 1 and 10 linked wallets: chat budget denied -> 0 cover lookups (global not charged); global budget denied -> 0 lookups; budget exhausted mid-sequence (global after 3, chat after 5) -> 0 lookups, stop at the first refusal; admitted -> exactly one lookup per wallet, both budgets charged once per wallet before the first lookup (30/600 s per chat, 300/600 s global = the dashboard cover budget key); AI route keeps its AI budget first; no wallet -> nothing charged; limiter failure fails closed |
| EV-KB-TG-COVER-BUDGET | known-bad | E4 | mutation | FULL | yes | bypassing the cover budget on the command, the callback button or either AI intent, removing the chat or the global budget, checking the budget after the lookups, or charging only the first wallet is each detected by the intended test and message |
| EV-PROBE-LINK-READ | behavioral | E2 | probe | PARTIAL | yes | regression proof (finding F-2K-1, fixed in Phase 2L): real api/link.mjs with an offline recording fetch; IP, per-code and global denial each yield 0 getChat; 20 requests from 20 IPs with one valid code make at most 10 getChat calls (10 refused); an admitted request answers 200 with the Telegram target after exactly one getChat, behind all three limits. History: in Phase 2K it reproduced the defect - 20 IPs x one code -> 20 getChat with only the per-IP limit before them. |
| EV-LINK-READ-BUDGET | behavioral | E3 | node-test | PARTIAL | yes | real api/link.mjs + src/http-security.mjs + src/db.mjs + src/linking.mjs up to an offline wire, limiter counting per key in a fixed window: IP denied -> no pending-link read, no getChat; per-code denied -> no pending-link read, no getChat; global denied -> no getChat (with and without wallet); admitted -> unchanged 200 responses (target; signing message with wallet) after exactly one getChat, order wallet-link-read -> wallet-link-read-code -> pending link -> wallet-link-read-global -> getChat; invalid code -> no limiter beyond IP, no DB, no getChat; expired / used / non-private / unknown link and invalid wallet -> no getChat, global not charged; 20 IPs x one code -> 10 getChat (per-code bound); 70 codes x 12 IPs -> 600 getChat (global bound); limiter failure -> no getChat; keys: HMAC(code) and constant "all", not shared with /api/link/verify |
| EV-KB-LINK-READ-BUDGET | known-bad | E4 | mutation | PARTIAL | yes | removing the per-code or the global limit, moving getChat before both limits, keying the per-code limit by IP, or applying the global limit only after getChat is each detected by the intended test and message |
| EV-RESOURCE-P1 | behavioral | E3 | node-test | PARTIAL | yes | real api/dashboard.mjs + real src/http-security.mjs guards + real dashboard-auth, with verifyWalletSiweAuthority / verifyOnchainDashboardLoginApproval / noContractCodeByQuorum on two offline wire providers (request counters) and DB spies. Login: dashboard-login (IP 10) -> dashboard-login-wallet (10) -> dashboard-login-global (200); on-chain approval: dashboard-onchain (IP 60) -> -nonce (45) -> -wallet (90) -> -global (600); fresh authority: dashboard-delete (IP 10) -> dashboard-action-verify (wallet 10) -> dashboard-action-verify-global (100); legacy action paths: IP -> dashboard-action-wallet -> dashboard-action-verify-global (F-2F-1). Denied at any gate -> 429 with 0 verifications, 0 Alchemy and 0 Infura requests, no challenge read, no nonce consumption, no session, no revoke/unlink, and no later gate asked; admitted -> all gates before the first verification or state read; owner key -> verified offline, consumed once, session issued / action run; foreign key -> ERC-1271 at both providers, fails closed, nothing consumed; documented sizes (all per 600 s). |
| EV-RESOURCE-P2 | behavioral | E3 | node-test | PARTIAL | yes | real api/link/verify.mjs + real guards + real telegramTarget (recording fetch), signingMessage, linkSiweExpectation and verifyWalletSiweSignature on two offline wire providers: wallet-link-verify (IP 10) -> code format -> wallet-link-code (5) -> link read/structure -> wallet-link-verify-global (200). Denied at any gate -> 429 with getChat 0, verification 0, RPC 0, no consume, no dashboard access code, no Telegram message; IP or code denied -> link not even read; invalid code format, expired/used/unknown link or malformed wallet/signature -> no global charge, no getChat, no verification; admitted -> all three gates before getChat and the verification; owner key -> one getChat, verified offline, consumed once, chat notified; foreign key -> ERC-1271 at both providers, fails closed; documented sizes. |
| EV-RESOURCE-P3 | behavioral | E3 | node-test | PARTIAL | yes | real api/dashboard.mjs + real guards + real isDeployedContract (fresh cache) on an offline wire provider: dashboard-read (IP 120) -> address check -> dashboard-challenge (IP 20) -> dashboard-challenge-wallet (10) -> dashboard-challenge-global (600) -> one eth_getCode -> one stored challenge. Denied at any gate -> 429, getCode 0, nothing stored, no later gate; invalid address -> 400 after the read gate only; admitted -> classification unchanged (EOA 5 min, contract 30 min, provider error fails closed to 5 min). Legacy action challenge: see EV-LEGACY-ORDER (IP -> wallet -> global before the dual getCode). |
| EV-RESOURCE-P4 | behavioral | E3 | node-test | PARTIAL | yes | GET /api/positions: real createPositionsHandler + real guards + real session resolution + real getWalletPositions cache/merging on an offline Aave client: positions-read (IP 60) -> session -> positions-wallet (30) -> positions-global (1200) -> cache -> positions-lookup-global (200, only before a chain lookup) -> RPC. Denied at an IP/wallet/global gate -> 429 with 0 chain calls in cold, warm and failure-cached states (a cached value never bypasses a gate); provider budget denied on a cold cache -> 429, 0 chain calls, no catalog, nothing cached; warm and failure-cached -> served without provider budget or chain call; two concurrent cold requests -> one budget charge, one lookup; merged and denied -> 0 chain calls, joined request 503. Attributions: attributions-read/-wallet (GET) or attributions-write/-write-wallet (POST) denied -> 0 position and 0 cover provider calls, no write, in all cache states; positions-lookup-global before positions RPC on a cold cache; dashboard-read-global before every cover lookup (F-2H-1). |
| EV-KB-RESOURCE-P1 | known-bad | E4 | mutation | PARTIAL | yes | removing the login per-wallet or global limit, verifying the login signature before them, removing the on-chain global limit, reading the challenge and asking the providers before the on-chain limits, removing the fresh-authority global limit or verifying before the fresh-authority limits is each detected by the intended test and message |
| EV-KB-RESOURCE-P2 | known-bad | E4 | mutation | PARTIAL | yes | removing the per-code or the global link-verify limit, or running getChat and the signature verification before both, is each detected by the intended test and message |
| EV-KB-RESOURCE-P3 | known-bad | E4 | mutation | PARTIAL | yes | removing the per-wallet or global challenge limit, or asking getCode before the per-IP challenge, per-wallet and global limits, is each detected by the intended test and message |
| EV-KB-RESOURCE-P4 | known-bad | E4 | mutation | PARTIAL | yes | removing the positions per-wallet or global limit, bypassing the provider budget, asking it only after the chain lookup, or removing the attribution per-wallet read or write limit is each detected by the intended test and message |
| EV-INPUT-DB-STRUCTURE | behavioral | E3 | node-test | PARTIAL | yes | real src/db.mjs with the real supabase-js; fetch records each PostgREST request. For every exported helper that takes input (coverage of the export list is asserted), harmless and adversarial values (SQL quotes/comments/statements, PostgREST operators and separators, LIKE wildcards, percent encoding, query-string characters, JSON, Unicode, 10 000 chars) produce the same request: same method, table or function, filter columns, operators (only eq/gt/lt/lte/like/is, never or/and/not/in), select/order/limit/on_conflict and body keys; the value after the operator and every body value is exactly the input (or its fixed frame such as unlinked:<chat>:%, lowercased where the helper normalizes wallets); RPC arguments travel as named JSON values, never in the URL. Input-free helpers send fixed requests. Remembered-wallet helpers (getRememberedWallet(s), forgetRememberedWallet, consumePendingLink cleanup) validate the chat id themselves (positive safe integer or canonical decimal string, no leading zero): valid ids keep their exact anchored request unlinked:<chat>:% for number and string; 38 out-of-domain values (wildcards, empty, whitespace, signs, leading zero, decimal/exponent/hex forms, unsafe integers, SQL/PostgREST-looking strings, non-strings) send no request and return null / [] / nothing; link cleanup runs only for a valid chat id from the link function. Static supplement: no other src/ or api/ file talks to the database; no expression builder with a string argument; every table, function, column and order name in src/db.mjs is a literal. |
| EV-INPUT-DB-PG | real-system | E5 | node-test | FULL | yes | disposable Postgres with every migration; real src/db.mjs and supabase-js, each PostgREST request translated into one statement with bound parameters (test-support/pg-postgrest.mjs). P1: adversarial lookups, updates and deletes match nothing, change no row outside their own keys (content hash of every table) and either succeed or fail with a data error (22P02/22007/23514), never a syntax or object error; adversarial values are stored and read back literally (events, labels, rate keys, link rows, challenges); per-chat LIKE patterns are anchored on the delimiter (chat 1 never touches 10, 12 or 100, on forget and on link); at the helper boundary each of chats 1, 10, 12, 100 (number and string) reads and forgets only its own remembered wallet, all 38 out-of-domain ids read nothing and delete nothing, and link cleanup for a link row with a wildcard chat id (%, _, 1%, 1_) deletes nothing while chat 10 cleans only chat 10. P2: every callable function (alert_subscriptions_page, check_agent_rate_limit, consume_wallet_link, consume_wallet_link_v2, link_wallet_to_chat_limited, lock_chat_wallets, revoke_dashboard_sessions_atomic, upsert_position_attribution_limited) called with adversarial text: no syntax error, no foreign row, values stored literally in the code's chat only, malformed wallets/deployment keys rejected by checks; catalog: exactly these functions, plpgsql/sql only, no EXECUTE, format() or quote_* in any body, SECURITY DEFINER functions with a fixed search_path, no triggers or event triggers. |
| EV-KB-INPUT-004 | known-bad | E4 | mutation | FULL | yes | splicing the link code into a PostgREST or-expression, dropping the delimiter of the per-chat LIKE pattern, turning an eq value into a LIKE pattern, building check_agent_rate_limit's statement by EXECUTE with the concatenated key, removing the remembered-wallet chat-id validation, admitting % or _ in the chat-id domain, deleting before validating, or cleaning up after linking without the boundary check is each detected by the intended behavioural test and message |
| EV-BROWSER-RENDER | behavioral | E3 | node-test | PARTIAL | yes | the real web/src/main.js (and guide.js) runs in a recording DOM built from the real web/index.html (guide.html); every /api/* answer it reads is hostile (14 payloads: <script>, <img onerror>, "><svg onload>, iframe srcdoc, javascript: in three spellings, data:text/html, vbscript:, //host, HTML-entity and percent-encoded markup, <a href=javascript:>, closing tags): dashboard covers and settings, Telegram button, DeFi positions, cover attributions, Telegram link page (?code=, account and error), dashboard link (?access=, expiry error and wallet handoff), session restore, paused sign-in, and wrongly typed fields. No HTML-parsing interface (innerHTML, outerHTML, insertAdjacentHTML, srcdoc, document.write/writeln, createContextualFragment, DOMParser) is ever used; only fixed harmless tags are created; no on* attribute; every href is https on coverraccoon.com, t.me or app.nexusmutual.io; hostile values appear as text. eval, Function and string timers are trapped and never called; dynamic import() only with fixed module names. |
| EV-CSP-BROWSER | behavioral | E3 | node-test | PARTIAL | yes | the Content-Security-Policy is taken from vercel.json and served per path exactly as its source patterns select (/ and /(.+), including /link, /guide, /datenschutz, /index.html; one enforcing policy each, no report-only, no meta policy in the HTML; outputDirectory dist-web); a local headless Chrome runs a same-origin probe script: eval and new Function throw EvalError, setTimeout(string), injected inline <script>, on* attribute, javascript: link and a foreign-origin script do not execute; <object> raises an object-src violation and <base> a base-uri violation. Control run with the same probe and no policy executes every one of them (the probe is not deaf). Thus no script of the page - first- or third-party bundle - can turn strings into code. |
| EV-BROWSER-STRUCT | static | E1 | node-test | PARTIAL | yes | syntax-tree scan (vite parseAst) of every web/src module: no eval (also as member or computed), no Function constructor, no string timer, no computed import(); no HTML-parsing sink, no on*/srcdoc/style or computed setAttribute, no computed property write; the four URL writes equal the reviewed inventory (fixed Nexus table, two https://t.me/ templates, literal /). Self-check covers each forbidden form. |
| EV-KB-BROWSER-004 | known-bad | E4 | mutation | FULL | yes | writing rendered text via innerHTML (text helper, status line, Telegram account), dropping the fixed https://t.me/ prefix of the Telegram button, calling eval or a string timer in the dashboard path, adding unsafe-eval to either CSP rule, or removing object-src 'none' is each detected by the intended behavioural test and message |
| EV-FIX-REGISTER | behavioral | E3 | node-test | FULL | yes | security/crsf/fix-register.json is the canonical inventory of historical security fixes (102: every AGENT-*, AUDIT-*, AUDIT X-Yn, META-AUDIT, Restaudit, HARD-n and CRSF F-xx-n item and every historical commit (not only keyword matches); one invariant each). The guard (security/crsf/lib/fix-register.mjs) discovers every tag of the known families and, by a catch-all, markers of new families in code, tests, migrations, configuration and docs, and every commit (all historical commits by hash; later commits by a mandatory "Security-Fix:" trailer, full history or shallow clone); unclassified, vanished or inconsistent entries fail closed. Each PROVEN fix names behavioural KILLED mutation cases of the catalogue and the regression tests that are their expected failures. New behavioural regression tests cover fixes that had none (historical-fix-regressions/-frontend, font integrity with the real fetch-fonts script, real npm install with the project .npmrc, framework fixture fixes). |
| EV-KB-VERIFY-003 | known-bad | E4 | mutation | FULL | yes | 82 new known-bad cases: each historical vulnerability without a prior mutation is reintroduced exactly at its fix (secret fallback, legacy cookie, session from access/link codes, URL-borne access code, old-schema challenges, CSP report-only and connect-src, default privileges, innerHTML sinks, WalletConnect methods/disconnect/revoke, Host-header origin, body size, csp-report limits and logging, raw DB errors, GET state change, RPC-error caching, operator revocation, revoked-session logout, missing alerts/security events, prompt channel, contract TTL hints, session conflicts, preview origins, network/account re-checks, link-row kinds, Safe off-chain signing, cache bound, link target/account, display bounds, send isolation, M-1/M1/M2 limits, AppKit features and font, framework fixes, multi-chat isolation, private sender, answer filter, AI budget, font SHA-256, install scripts, retention, analytics redaction) and is detected by the intended behavioural test and message; 8 further cases weaken the register guard itself and are detected by its fixtures. The remaining PROVEN fixes reference existing KILLED cases (CR-AUTH, CR-SESSION, CR-RESOURCE, CR-CONC, CR-TELEGRAM, CR-PROVIDER, CR-INPUT, CR-API, CR-VERIFY). Phase 2R: removing the .env rules from .vercelignore (entirely or only .env.*), and removing the installCommand or replacing npm ci by npm install, are each detected by the real Vercel CLI tests; three further cases weaken the commit-classification guard (no trailer, trailer naming an unknown fix, "none" without reason) and are detected by its fixtures. Phase 2S: removing npm audit signatures from check:ci, or ignoring its result, is detected by the real-npm registry-signature test (real Sigstore TUF and registry keys, tampered package metadata). Phase 2U: the framework fixes F-2T-1 (runner-observed real-system use and concurrency) and F-2T-2 (fixture N independent of open controls) are proven by six KILLED framework mutations. |
| EV-VERCEL-CLI-LOCAL | behavioral | E3 | node-test | PARTIAL | yes | with the real installed Vercel CLI, locally and without deployment or network (all API calls to a local fake API that refuses every deployment; every other request through a local refusing proxy, recorded and asserted empty; telemetry and update check off; fake token, isolated global config): (1) `vercel deploy` computes the upload set of a seeded project with the repository .vercelignore and excludes .env, .env.production, .env.preview, .env.development, .env.local and api/.env while keeping .env.example; the control without the file would upload .env and .env.production; (2) `vercel build` runs the installCommand of the repository vercel.json, which aborts on a lockfile that does not match package.json and leaves it unchanged; the control with a matching lockfile builds. |
| EV-NPM-SIGNATURES | behavioral | E3 | node-test | PARTIAL | yes | real npm 11.17.0 `npm run check:ci` (network evidence, capability npm_network = CRSF_NETWORK_EVIDENCE=1): npm refreshes the Sigstore TUF metadata online from tuf-repo-cdn.sigstore.dev and takes the registry keys from the TUF target registry.npmjs.org/keys.json; pacote verifies every dist.signatures entry against "<name>@<version>:<dist.integrity>". Positive: fresh disposable cache against the real registry passes. Known-bad: in a disposable copy of that cache only dist.integrity of one direct dependency (@vercel/analytics) is changed (real signature kept), read with prefer-offline while TUF still refreshes online: check:ci fails with "1 package has an invalid registry signature" for exactly that package. Network boundary (preload in every node process): only tuf-repo-cdn.sigstore.dev and registry.npmjs.org, asserted; no credentials (empty user and global npmrc), nothing published or written to the registry. Not proven: a compromise of the registry signing key itself; attestation (provenance) verification is reported but not part of the invariant; without CRSF_NETWORK_EVIDENCE=1 the evidence is NOT_RUN. |
| EV-E5-OBSERVATION | behavioral | E3 | node-test | PARTIAL | yes | The runner-side observer credits only server-confirmed use (silent server: none), distinguishes sequential from overlapping statements and open transactions, the engine refuses credit for a node-only item declared [node, postgres] (T3), for a missing observation, for a fake-upstream receipt and for concurrency claims without observed overlap; only a receipt with the run key and nonce is accepted, also when a test forges a line via /proc; without the postgres capability a real-system item is NOT_RUN. Fixture N holds in the current and in a synthetic all-satisfied state. |
| EV-RL-DB | real-system | E5 | node-test | FULL | yes | public.check_agent_rate_limit against real Postgres, every caller on its own connection. Deterministic gate: a caller holds the counter row lock in an open transaction until Postgres reports all N other callers waiting (pg_stat_activity, Lock); after release exactly min(max, N+1) are admitted and every request is counted (no lost increment), for N up to 29 and max 1..25. Simultaneous first requests for a fresh key (10 rounds, 29 connections) admit exactly max; two keys are independent. Runner-observed: server-confirmed use and overlapping execution (pg-observer). |
| EV-LOCKS-DB | real-system | E5 | node-test | FULL | yes | Inventory from pg_proc of the migrated database: every public function that takes an advisory lock, directly or through another function (lock_chat_wallets, upsert_position_attribution_limited, revoke_dashboard_sessions_atomic, consume_wallet_link_v2, consume_wallet_link), is exercised; a new locking function fails the test. Per operation with separate connections: inside an open transaction the caller holds exactly one advisory lock (P2); a second caller with the same key waits with wait_event Lock/advisory and exactly one ungranted advisory request - no retry, no sleep (P3); on commit the lock is gone, the second caller completes and no session keeps an advisory lock (P1); 11 simultaneous callers per operation finish without deadlock (40P01) or error and leave no lock. Runner-observed: server-confirmed use and overlapping execution. |
| EV-KB-RL-DB | known-bad | E4 | mutation | FULL | yes | Reintroducing the lost-update race (read the counter, then write read+1) in check_agent_rate_limit is detected by the gated real-Postgres test (more than max admitted). |
| EV-KB-LOCKS-DB | known-bad | E4 | mutation | FULL | yes | A session-level advisory lock (P1), a second advisory lock in one operation (P2) and an unbounded try-lock/sleep retry loop (P3) are each detected by the real-Postgres lock test. |

## 6. Mutation cases

307 cases in `security/mutation/cases.json`. Static-detection kills never count as E4.

| ID | Targets | Detection | Expected |
|---|---|---|---|
| MUT-CR-API-001-P1-NEW1 | CR-API-001.P1 | behavioral | KILLED |
| MUT-CR-API-001-P1-NEW2 | CR-API-001.P1 | behavioral | KILLED |
| MUT-CR-API-001-P2-NEW1 | CR-API-001.P2 | behavioral | KILLED |
| MUT-CR-API-001-P3-L5A | CR-API-001.P3 | behavioral | KILLED |
| MUT-CR-API-001-P3-L5B | CR-API-001.P3 | behavioral | KILLED |
| MUT-CR-API-001-P3-L5G | CR-API-001.P3 | behavioral | KILLED |
| MUT-CR-API-001-P4-L3Y4 | CR-API-001.P4 | behavioral | KILLED |
| MUT-CR-API-002-P1-NEW1 | CR-API-002.P1 | behavioral | KILLED |
| MUT-CR-API-002-P1-NEW2 | CR-API-002.P1 | behavioral | KILLED |
| MUT-CR-API-002-P2-NEW1 | CR-API-002.P2 | behavioral | KILLED |
| MUT-CR-API-002-P3-NEW1 | CR-API-002.P3 | behavioral | KILLED |
| MUT-CR-API-002-P3-NEW2 | CR-API-002.P3 | behavioral | KILLED |
| MUT-CR-AUTH-001-P1-NEW1 | CR-AUTH-001.P1 | behavioral | KILLED |
| MUT-CR-AUTH-001-P1-NEW2 | CR-AUTH-001.P1 | behavioral | KILLED |
| MUT-CR-AUTH-001-P2-NEW1 | CR-AUTH-001.P2 | behavioral | KILLED |
| MUT-CR-AUTH-001-P3-NEW1 | CR-AUTH-001.P3 | behavioral | KILLED |
| MUT-CR-AUTH-001-P4-NEW1 | CR-AUTH-001.P4 | behavioral | KILLED |
| MUT-CR-AUTH-001-P4-NEW2 | CR-AUTH-001.P4 | behavioral | KILLED |
| MUT-CR-AUTH-001-P4-NEW3 | CR-AUTH-001.P4 | behavioral | KILLED |
| MUT-CR-AUTH-001-P4-NEW4 | CR-AUTH-001.P4 | behavioral | KILLED |
| MUT-CR-AUTH-001-P5-NEW1 | CR-AUTH-001.P5 | behavioral | KILLED |
| MUT-CR-AUTH-002-P1-NEW1 | CR-AUTH-002.P1 | behavioral | KILLED |
| MUT-CR-AUTH-002-P2-NEW1 | CR-AUTH-002.P2 | behavioral | KILLED |
| MUT-CR-AUTH-002-P2-NEW2 | CR-AUTH-002.P2 | behavioral | KILLED |
| MUT-CR-AUTH-003-P1-NEW1 | CR-AUTH-003.P1 | behavioral | KILLED |
| MUT-CR-AUTH-003-P2-NEW1 | CR-AUTH-003.P2 | behavioral | KILLED |
| MUT-CR-AUTH-003-P3-NEW1 | CR-AUTH-003.P3 | behavioral | KILLED |
| MUT-CR-AUTH-003-P3-NEW2 | CR-AUTH-003.P3 | behavioral | KILLED |
| MUT-CR-AUTH-003-P4-NEW1 | CR-AUTH-003.P4 | behavioral | KILLED |
| MUT-CR-AUTH-003-P4-NEW2 | CR-AUTH-003.P4 | behavioral | KILLED |
| MUT-CR-AUTH-003-P4-NEW3 | CR-AUTH-003.P4 | behavioral | KILLED |
| MUT-CR-AUTH-004-P1-NEW1 | CR-AUTH-004.P1 | behavioral | KILLED |
| MUT-CR-AUTH-004-P2-EQ1 | CR-AUTH-004.P2 | behavioral | EQUIVALENT |
| MUT-CR-AUTH-004-P2-NEW1 | CR-AUTH-004.P2 | behavioral | KILLED |
| MUT-CR-AUTH-004-P2-NEW2 | CR-AUTH-004.P2 | behavioral | KILLED |
| MUT-CR-AUTH-005-P1-L4A | CR-AUTH-005.P1 | behavioral | KILLED |
| MUT-CR-AUTH-005-P1-L4B | CR-AUTH-005.P1 | behavioral | KILLED |
| MUT-CR-AUTH-005-P1-L4C | CR-AUTH-005.P1 | behavioral | KILLED |
| MUT-CR-AUTH-005-P2-NEW1 | CR-AUTH-005.P2 | behavioral | KILLED |
| MUT-CR-AUTH-006-P1-NEW1 | CR-AUTH-006.P1 | behavioral | KILLED |
| MUT-CR-AUTH-006-P2-NEW1 | CR-AUTH-006.P2 | behavioral | KILLED |
| MUT-CR-AUTH-006-P2-NEW2 | CR-AUTH-006.P2 | behavioral | KILLED |
| MUT-CR-AUTH-006-P3-NEW1 | CR-AUTH-006.P3 | behavioral | KILLED |
| MUT-CR-AUTH-007-P1-NEW1 | CR-AUTH-007.P1 | behavioral | KILLED |
| MUT-CR-AUTH-007-P2-NEW1 | CR-AUTH-007.P2 | behavioral | EQUIVALENT |
| MUT-CR-AUTH-007-P2-NEW2 | CR-AUTH-007.P2 | behavioral | KILLED |
| MUT-CR-AUTH-007-P2-NEW3 | CR-AUTH-007.P2 | behavioral | KILLED |
| MUT-CR-AUTH-007-P3-NEW1 | CR-AUTH-007.P3 | behavioral | KILLED |
| MUT-CR-AUTH-008-P1-NEW1 | CR-AUTH-008.P1 | behavioral | KILLED |
| MUT-CR-AUTH-008-P1-NEW2 | CR-AUTH-008.P1 | behavioral | KILLED |
| MUT-CR-AUTH-008-P2-NEW1 | CR-AUTH-008.P2 | behavioral | KILLED |
| MUT-CR-AUTH-008-P2-NEW2 | CR-AUTH-008.P2 | behavioral | KILLED |
| MUT-CR-AUTH-008-P2-NEW3 | CR-AUTH-008.P2 | behavioral | KILLED |
| MUT-CR-CONC-001-P1-H2A | CR-CONC-001.P1 | behavioral | KILLED |
| MUT-CR-CONC-001-P1-H2B | CR-CONC-001.P1 | behavioral | KILLED |
| MUT-CR-CONC-001-P1-H2C | CR-CONC-001.P1 | behavioral | KILLED |
| MUT-CR-CONC-001-P1-H2D | CR-CONC-001.P1 | behavioral | KILLED |
| MUT-CR-CONC-001-P1-H2E | CR-CONC-001.P1 | behavioral | KILLED |
| MUT-CR-CONC-001-P1-H2F | CR-CONC-001.P1 | behavioral | KILLED |
| MUT-CR-CONC-001-P2-H2I | CR-CONC-001.P2 | behavioral | KILLED |
| MUT-CR-CONC-001-P2-H2J | CR-CONC-001.P2 | behavioral | KILLED |
| MUT-CR-CONC-002-P1-L2X15 | CR-CONC-002.P1 | behavioral | KILLED |
| MUT-CR-CONC-003-P1-L1A | CR-CONC-003.P1 | behavioral | KILLED |
| MUT-CR-CONC-003-P1-L1B | CR-CONC-003.P1 | behavioral | KILLED |
| MUT-CR-CONC-003-P1-L1C | CR-CONC-003.P1 | behavioral | KILLED |
| MUT-CR-CONC-003-P1-L1D | CR-CONC-003.P1 | behavioral | KILLED |
| MUT-CR-CONC-003-P1-L1E | CR-CONC-003.P1 | behavioral | KILLED |
| MUT-CR-CONC-003-P1-L1F | CR-CONC-003.P1 | behavioral | KILLED |
| MUT-CR-CONC-003-P1-L1G | CR-CONC-003.P1 | behavioral | KILLED |
| MUT-CR-CONC-003-P1-L1H | CR-CONC-003.P1 | behavioral | KILLED |
| MUT-CR-CONC-003-P1-L1I | CR-CONC-003.P1 | behavioral | KILLED |
| MUT-CR-CONC-003-P3-L1J | CR-CONC-003.P3 | behavioral | KILLED |
| MUT-CR-CONC-004-P1-L5F | CR-CONC-004.P1 | behavioral | KILLED |
| MUT-CR-CONC-004-P1-L5H | CR-CONC-004.P1 | behavioral | KILLED |
| MUT-CR-CONC-005-P1-NEW1 | CR-CONC-005.P1 | behavioral | KILLED |
| MUT-CR-CONC-005-P1-NEW2 | CR-CONC-005.P1 | behavioral | KILLED |
| MUT-CR-DB-001-P1-NEW1 | CR-DB-001.P1 | behavioral | KILLED |
| MUT-CR-DB-001-P2-NEW1 | CR-DB-001.P2 | behavioral | KILLED |
| MUT-CR-DB-001-P2-NEW2 | CR-DB-001.P2 | behavioral | KILLED |
| MUT-CR-DB-001-P3-NEW1 | CR-DB-001.P3 | behavioral | KILLED |
| MUT-CR-DB-002-P1-NEW1 | CR-DB-002.P1 | behavioral | KILLED |
| MUT-CR-DB-002-P1-NEW2 | CR-DB-002.P1 | behavioral | KILLED |
| MUT-CR-DB-002-P1-NEW3 | CR-DB-002.P1 | behavioral | KILLED |
| MUT-CR-INPUT-010-P2-L3Y3 | CR-INPUT-010.P2 | behavioral | KILLED |
| MUT-CR-INPUT-010-P2-L3Y9 | CR-INPUT-010.P2 | behavioral | KILLED |
| MUT-CR-PROVIDER-001-P2-L4J | CR-PROVIDER-001.P2 | behavioral | KILLED |
| MUT-CR-PROVIDER-001-P4-L5C | CR-PROVIDER-001.P4 | behavioral | KILLED |
| MUT-CR-PROVIDER-001-P4-L5D | CR-PROVIDER-001.P4 | behavioral | KILLED |
| MUT-CR-PROVIDER-001-P4-L5E | CR-PROVIDER-001.P4 | behavioral | KILLED |
| MUT-CR-PROVIDER-001-P4-L5I | CR-PROVIDER-001.P4 | behavioral | KILLED |
| MUT-CR-SESSION-001-P1-L4I | CR-SESSION-001.P1 | behavioral | KILLED |
| MUT-CR-SESSION-001-P1-NEW1 | CR-SESSION-001.P1 | behavioral | KILLED |
| MUT-CR-SESSION-002-P1-L4D | CR-SESSION-002.P1 | behavioral | KILLED |
| MUT-CR-SESSION-002-P2-NEW1 | CR-SESSION-002.P2 | behavioral | KILLED |
| MUT-CR-SESSION-002-P3-NEW1 | CR-SESSION-002.P3 | behavioral | KILLED |
| MUT-CR-SESSION-002-P4-H2H | CR-SESSION-002.P4 | behavioral | KILLED |
| MUT-CR-SESSION-002-P4-L4E | CR-SESSION-002.P4 | behavioral | KILLED |
| MUT-CR-SESSION-003-P1-NEW1 | CR-SESSION-003.P1 | behavioral | KILLED |
| MUT-CR-SESSION-003-P1-NEW2 | CR-SESSION-003.P1 | behavioral | KILLED |
| MUT-CR-SESSION-003-P2-NEW1 | CR-SESSION-003.P2 | behavioral | KILLED |
| MUT-CR-SESSION-005-P1-NEW1 | CR-SESSION-005.P1 | behavioral | KILLED |
| MUT-CR-SESSION-005-P2-NEW1 | CR-SESSION-005.P2 | behavioral | KILLED |
| MUT-CR-SESSION-007-P1-NEW1 | CR-SESSION-007.P1 | behavioral | KILLED |
| MUT-CR-SESSION-007-P2-NEW1 | CR-SESSION-007.P2 | behavioral | KILLED |
| MUT-CR-SESSION-007-P2-NEW2 | CR-SESSION-007.P2 | behavioral | KILLED |
| MUT-CR-SESSION-007-P2-NEW3 | CR-SESSION-007.P2 | behavioral | KILLED |
| MUT-CR-SESSION-007-P2-NEW4 | CR-SESSION-007.P2 | behavioral | KILLED |
| MUT-CR-TELEGRAM-001-P1-NEW1 | CR-TELEGRAM-001.P1 | behavioral | KILLED |
| MUT-CR-TELEGRAM-001-P1-NEW2 | CR-TELEGRAM-001.P1 | behavioral | KILLED |
| MUT-CR-TELEGRAM-001-P2-NEW1 | CR-TELEGRAM-001.P2 | behavioral | KILLED |
| MUT-CR-TELEGRAM-001-P3-NEW1 | CR-TELEGRAM-001.P3 | behavioral | KILLED |
| MUT-CR-TELEGRAM-001-P3-NEW2 | CR-TELEGRAM-001.P3 | behavioral | KILLED |
| MUT-CR-TELEGRAM-002-P1-L2X4 | CR-TELEGRAM-002.P1 | behavioral | KILLED |
| MUT-CR-TELEGRAM-002-P1-L2X5 | CR-TELEGRAM-002.P1 | behavioral | KILLED |
| MUT-CR-TELEGRAM-002-P1-L2X6 | CR-TELEGRAM-002.P1 | behavioral | KILLED |
| MUT-CR-TELEGRAM-002-P2-L2X1 | CR-TELEGRAM-002.P2 | static | KILLED |
| MUT-CR-TELEGRAM-002-P2-L2X2 | CR-TELEGRAM-002.P2 | static | KILLED |
| MUT-CR-TELEGRAM-002-P2-L2X3 | CR-TELEGRAM-002.P2 | static | KILLED |
| MUT-CR-TELEGRAM-002-P2-L2X7 | CR-TELEGRAM-002.P2 | behavioral | KILLED |
| MUT-CR-TELEGRAM-002-P2-L2X8 | CR-TELEGRAM-002.P2 | behavioral | KILLED |
| MUT-CR-TELEGRAM-003-P1-L3Y1 | CR-TELEGRAM-003.P1 | behavioral | KILLED |
| MUT-CR-TELEGRAM-003-P1-L3Y2 | CR-TELEGRAM-003.P1 | behavioral | KILLED |
| MUT-CR-TELEGRAM-003-P1-L3Y5 | CR-TELEGRAM-003.P1 | behavioral | KILLED |
| MUT-CR-TELEGRAM-003-P1-L3Y6 | CR-TELEGRAM-003.P1 | behavioral | KILLED |
| MUT-CR-TELEGRAM-003-P1-L3Y8 | CR-TELEGRAM-003.P1 | behavioral | KILLED |
| MUT-CR-TELEGRAM-003-P2-L3Y10 | CR-TELEGRAM-003.P2 | behavioral | KILLED |
| MUT-CR-TELEGRAM-003-P2-L3Y7 | CR-TELEGRAM-003.P2 | behavioral | KILLED |
| MUT-CR-VERIFY-001-P1-NEW1 | CR-VERIFY-001.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-002-P1-NEW1 | CR-VERIFY-002.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-002-P2-NEW1 | CR-VERIFY-002.P2 | behavioral | KILLED |
| MUT-CR-VERIFY-002-P3-NEW1 | CR-VERIFY-002.P3 | behavioral | KILLED |
| MUT-CR-VERIFY-002-P3-NEW2 | CR-VERIFY-002.P3 | behavioral | KILLED |
| MUT-CR-VERIFY-005-P1-NEW1 | CR-VERIFY-005.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-009-P1-NEW1 | CR-VERIFY-009.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-002-P4-NEW1 | CR-VERIFY-002.P4 | behavioral | KILLED |
| MUT-CR-VERIFY-002-P4-NEW2 | CR-VERIFY-002.P4 | behavioral | KILLED |
| MUT-CR-VERIFY-002-P4-NEW3 | CR-VERIFY-002.P4 | behavioral | KILLED |
| MUT-CR-API-004-P1-NEW1 | CR-API-004.P1 | behavioral | KILLED |
| MUT-CR-API-004-P1-NEW2 | CR-API-004.P1 | behavioral | KILLED |
| MUT-CR-API-004-P1-NEW3 | CR-API-004.P1 | behavioral | KILLED |
| MUT-CR-API-004-P1-NEW4 | CR-API-004.P1 | behavioral | KILLED |
| MUT-CR-SESSION-001-P2-NEW1 | CR-SESSION-001.P2 | behavioral | KILLED |
| MUT-CR-SESSION-001-P2-NEW2 | CR-SESSION-001.P2 | behavioral | KILLED |
| MUT-CR-SESSION-001-P3-NEW1 | CR-SESSION-001.P3 | behavioral | KILLED |
| MUT-CR-SESSION-001-P3-NEW2 | CR-SESSION-001.P3 | behavioral | KILLED |
| MUT-CR-PROVIDER-001-P2-F2D2A | CR-PROVIDER-001.P2 | behavioral | KILLED |
| MUT-CR-PROVIDER-001-P2-F2D2B | CR-PROVIDER-001.P2 | behavioral | KILLED |
| MUT-CR-RESOURCE-001-P1-F2F1A | CR-RESOURCE-001.P1 | behavioral | KILLED |
| MUT-CR-RESOURCE-001-P1-F2F1B1 | CR-RESOURCE-001.P1 | behavioral | KILLED |
| MUT-CR-RESOURCE-001-P1-F2F1B2 | CR-RESOURCE-001.P1 | behavioral | KILLED |
| MUT-CR-RESOURCE-001-P1-F2F1C | CR-RESOURCE-001.P1 | behavioral | KILLED |
| MUT-CR-RESOURCE-001-P1-F2F1D | CR-RESOURCE-001.P1 | behavioral | KILLED |
| MUT-CR-RESOURCE-001-P4-F2H1A | CR-RESOURCE-001.P4 | behavioral | KILLED |
| MUT-CR-RESOURCE-001-P4-F2H1B | CR-RESOURCE-001.P4 | behavioral | KILLED |
| MUT-CR-RESOURCE-001-P4-F2H1C | CR-RESOURCE-001.P4 | behavioral | KILLED |
| MUT-CR-RESOURCE-001-P4-F2H1D | CR-RESOURCE-001.P4 | behavioral | KILLED |
| MUT-CR-RESOURCE-007-P1-F2I1A | CR-RESOURCE-007.P1 | behavioral | KILLED |
| MUT-CR-RESOURCE-007-P1-F2I1B | CR-RESOURCE-007.P1 | behavioral | KILLED |
| MUT-CR-RESOURCE-007-P1-F2I1B2 | CR-RESOURCE-007.P1 | behavioral | KILLED |
| MUT-CR-RESOURCE-007-P1-F2I1C | CR-RESOURCE-007.P1 | behavioral | KILLED |
| MUT-CR-RESOURCE-007-P1-F2I1D | CR-RESOURCE-007.P1 | behavioral | KILLED |
| MUT-CR-RESOURCE-007-P1-F2I1D2 | CR-RESOURCE-007.P1 | behavioral | KILLED |
| MUT-CR-RESOURCE-007-P1-F2I1E | CR-RESOURCE-007.P1 | behavioral | KILLED |
| MUT-CR-RESOURCE-007-P1-F2I1F | CR-RESOURCE-007.P1 | behavioral | KILLED |
| MUT-CR-RESOURCE-001-P5-F2K1A | CR-RESOURCE-001.P5 | behavioral | KILLED |
| MUT-CR-RESOURCE-001-P5-F2K1B | CR-RESOURCE-001.P5 | behavioral | KILLED |
| MUT-CR-RESOURCE-001-P5-F2K1C | CR-RESOURCE-001.P5 | behavioral | KILLED |
| MUT-CR-RESOURCE-001-P5-F2K1D | CR-RESOURCE-001.P5 | behavioral | KILLED |
| MUT-CR-RESOURCE-001-P5-F2K1E | CR-RESOURCE-001.P5 | behavioral | KILLED |
| MUT-CR-RESOURCE-001-P1-2MA | CR-RESOURCE-001.P1 | behavioral | KILLED |
| MUT-CR-RESOURCE-001-P1-2MB | CR-RESOURCE-001.P1 | behavioral | KILLED |
| MUT-CR-RESOURCE-001-P1-2MC | CR-RESOURCE-001.P1 | behavioral | KILLED |
| MUT-CR-RESOURCE-001-P1-2MD | CR-RESOURCE-001.P1 | behavioral | KILLED |
| MUT-CR-RESOURCE-001-P1-2ME | CR-RESOURCE-001.P1 | behavioral | KILLED |
| MUT-CR-RESOURCE-001-P1-2MF | CR-RESOURCE-001.P1 | behavioral | KILLED |
| MUT-CR-RESOURCE-001-P1-2MG | CR-RESOURCE-001.P1 | behavioral | KILLED |
| MUT-CR-RESOURCE-001-P2-2MA | CR-RESOURCE-001.P2 | behavioral | KILLED |
| MUT-CR-RESOURCE-001-P2-2MB | CR-RESOURCE-001.P2 | behavioral | KILLED |
| MUT-CR-RESOURCE-001-P2-2MC | CR-RESOURCE-001.P2 | behavioral | KILLED |
| MUT-CR-RESOURCE-001-P3-2MA | CR-RESOURCE-001.P3 | behavioral | KILLED |
| MUT-CR-RESOURCE-001-P3-2MB | CR-RESOURCE-001.P3 | behavioral | KILLED |
| MUT-CR-RESOURCE-001-P3-2MC | CR-RESOURCE-001.P3 | behavioral | KILLED |
| MUT-CR-RESOURCE-001-P4-2MA | CR-RESOURCE-001.P4 | behavioral | KILLED |
| MUT-CR-RESOURCE-001-P4-2MB | CR-RESOURCE-001.P4 | behavioral | KILLED |
| MUT-CR-RESOURCE-001-P4-2MC | CR-RESOURCE-001.P4 | behavioral | KILLED |
| MUT-CR-RESOURCE-001-P4-2MD | CR-RESOURCE-001.P4 | behavioral | KILLED |
| MUT-CR-RESOURCE-001-P4-2ME | CR-RESOURCE-001.P4 | behavioral | KILLED |
| MUT-CR-RESOURCE-001-P4-2MF | CR-RESOURCE-001.P4 | behavioral | KILLED |
| MUT-CR-INPUT-004-P1-2NA | CR-INPUT-004.P1 | behavioral | KILLED |
| MUT-CR-INPUT-004-P1-2NB | CR-INPUT-004.P1 | behavioral | KILLED |
| MUT-CR-INPUT-004-P1-2NC | CR-INPUT-004.P1 | behavioral | KILLED |
| MUT-CR-INPUT-004-P2-2NA | CR-INPUT-004.P2 | behavioral | KILLED |
| MUT-CR-INPUT-004-P1-2OA | CR-INPUT-004.P1 | behavioral | KILLED |
| MUT-CR-INPUT-004-P1-2OB | CR-INPUT-004.P1 | behavioral | KILLED |
| MUT-CR-INPUT-004-P1-2OC | CR-INPUT-004.P1 | behavioral | KILLED |
| MUT-CR-INPUT-004-P1-2OD | CR-INPUT-004.P1 | behavioral | KILLED |
| MUT-CR-INPUT-004-P1-2OE | CR-INPUT-004.P1 | behavioral | KILLED |
| MUT-CR-BROWSER-004-P1-2PA | CR-BROWSER-004.P1 | behavioral | KILLED |
| MUT-CR-BROWSER-004-P1-2PB | CR-BROWSER-004.P1 | behavioral | KILLED |
| MUT-CR-BROWSER-004-P1-2PC | CR-BROWSER-004.P1 | behavioral | KILLED |
| MUT-CR-BROWSER-004-P1-2PD | CR-BROWSER-004.P1 | behavioral | KILLED |
| MUT-CR-BROWSER-004-P2-2PE | CR-BROWSER-004.P2 | behavioral | KILLED |
| MUT-CR-BROWSER-004-P2-2PF | CR-BROWSER-004.P2 | behavioral | KILLED |
| MUT-CR-BROWSER-004-P3-2PG | CR-BROWSER-004.P3 | behavioral | KILLED |
| MUT-CR-BROWSER-004-P3-2PH | CR-BROWSER-004.P3 | behavioral | KILLED |
| MUT-CR-BROWSER-004-P3-2PI | CR-BROWSER-004.P3 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QA1SECRET | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QA1LEGACY | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QA1RATE | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QA1VERIFY | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QA2COOKIE | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QA2URL | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QA3LEGACY | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QA4ORDER | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QA6 | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QA7ENFORCE | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QA7DEFPRIV | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QF1FINISH | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QF1LANG | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QF1GUIDE | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QF2 | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QW1 | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QW2ORIGIN | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QW2DISCONNECT | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QW3 | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QAPI001 | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QAPI002 | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QAPI003 | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QAUTH002 | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QHARD001CACHE | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QHARD002OPERATOR | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QHARD004 | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QIR001 | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QIR002 | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QIR002RAW | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QLLM001 | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QSAFE1FAIL | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QSAFE1CLIENT | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QSAFE2 | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QSAFE4 | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QUX5ACCOUNT | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QUX5APPKIT | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QUX5CHAIN | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QUX5WCCHAIN | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QAUDITF1 | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QAUDITF2 | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QAUDITF3 | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QEL2 | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QLINKACCOUNT | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QEL3BOUND | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QEL3ISO | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QEL4 | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QSAL2 | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QM1DASH | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QM1BOT | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QRM1LINKCHAT | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QRM1LINKGLOBAL | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QRM1ALERT | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QRM2WALLET | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QRM2GLOBAL | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QAPPKIT | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QAPPKITFONT | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QF2C2 | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QF2C3 | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QF2D1 | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QF2J1 | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QISOMETA | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QISOUNLINK | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QPRIVMSG | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QFILTERHOST | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QFILTERADDR | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QAIGLOBAL | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QAIFAIL | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QCSPCONNECT | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QCSPLOG | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QGUARDHTML | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QFONTSHA | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QNPMRC | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QRETENTION | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QANALYTICS | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QGTAG | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QGCATCHALL | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QGBEHAVIOURAL | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QGCOMMIT | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QGCOMPLETE | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QGFINDING | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QGSTALE | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2QGTESTMATCH | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2RVIALL | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2RVISTAR | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2RNCNONE | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2RNCINSTALL | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2RGTRAILER | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2RGTRAILERFIX | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2RGNONEREASON | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2SSIGNONE | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2SSIGNEUTER | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2UOBSUSE | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2UOBSCLIENT | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2UOBSSEQ | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2UOBSCONC | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2UOBSMAC | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2UNOPEN | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-RESOURCE-002-P1-2VLOSTUPDATE | CR-RESOURCE-002.P1 | behavioral | KILLED |
| MUT-CR-CONC-006-P1-2VSESSIONLOCK | CR-CONC-006.P1 | behavioral | KILLED |
| MUT-CR-CONC-006-P2-2VTWOLOCKS | CR-CONC-006.P2 | behavioral | KILLED |
| MUT-CR-CONC-006-P3-2VRETRYLOOP | CR-CONC-006.P3 | behavioral | KILLED |

## 7. ASVS applicable requirements

| Requirement | Level | Controls | Conformance |
|---|---|---|---|
| V1.1.1 | L2 | CR-INPUT-001 | NOT_DEMONSTRATED |
| V1.1.2 | L2 | CR-INPUT-002 | NOT_DEMONSTRATED |
| V1.2.1 | L1 | CR-BROWSER-004 | CONFORMANT |
| V1.2.2 | L1 | CR-INPUT-003 | NOT_DEMONSTRATED |
| V1.2.3 | L1 | CR-INPUT-002 | NOT_DEMONSTRATED |
| V1.2.4 | L1 | CR-INPUT-004 | CONFORMANT |
| V1.2.5 | L1 | CR-INPUT-005 | NOT_DEMONSTRATED |
| V1.2.9 | L2 | CR-INPUT-006 | NOT_DEMONSTRATED |
| V1.3.2 | L1 | CR-BROWSER-004 | CONFORMANT |
| V1.3.3 | L2 | CR-INPUT-007 | NOT_DEMONSTRATED |
| V1.3.6 | L2 | CR-PROVIDER-003 | CONFORMANT |
| V1.3.7 | L2 | CR-INPUT-013 | NOT_DEMONSTRATED |
| V1.3.10 | L2 | CR-INPUT-008 | NOT_DEMONSTRATED |
| V1.5.2 | L2 | CR-DOC-002 | CONFORMANT |
| V2.1.1 | L1 | CR-INPUT-009 | NON_CONFORMANT |
| V2.1.2 | L2 | CR-INPUT-009 | NON_CONFORMANT |
| V2.1.3 | L2 | CR-RESOURCE-005 | NON_CONFORMANT |
| V2.2.1 | L1 | CR-API-003 | CONFORMANT |
| V2.2.2 | L1 | CR-API-003 | CONFORMANT |
| V2.2.3 | L2 | CR-INPUT-010 | CONFORMANT |
| V2.3.1 | L1 | CR-API-009 | CONFORMANT |
| V2.3.2 | L2 | CR-CONC-002 | CONFORMANT |
| V2.3.3 | L2 | CR-CONC-001, CR-CONC-004 | CONFORMANT |
| V2.3.4 | L2 | CR-CONC-002, CR-CONC-003 | CONFORMANT |
| V2.3.5 | L3 | CR-API-010 | CONFORMANT |
| V2.4.1 | L2 | CR-RESOURCE-001, CR-RESOURCE-002, CR-RESOURCE-007 | CONFORMANT |
| V3.2.1 | L1 | CR-BROWSER-006 | CONFORMANT |
| V3.2.2 | L1 | CR-BROWSER-004 | CONFORMANT |
| V3.3.1 | L1 | CR-SESSION-004 | CONFORMANT |
| V3.3.2 | L2 | CR-SESSION-004 | CONFORMANT |
| V3.3.3 | L2 | CR-SESSION-004 | CONFORMANT |
| V3.3.4 | L2 | CR-SESSION-004, CR-SESSION-005 | CONFORMANT |
| V3.4.1 | L1 | CR-BROWSER-001 | CONFORMANT |
| V3.4.2 | L1 | CR-BROWSER-003 | CONFORMANT |
| V3.4.3 | L2 | CR-BROWSER-001 | CONFORMANT |
| V3.4.4 | L2 | CR-BROWSER-001 | CONFORMANT |
| V3.4.5 | L2 | CR-BROWSER-001 | CONFORMANT |
| V3.4.6 | L2 | CR-BROWSER-001 | CONFORMANT |
| V3.5.1 | L1 | CR-BROWSER-002 | CONFORMANT |
| V3.5.2 | L1 | CR-BROWSER-002 | CONFORMANT |
| V3.5.3 | L1 | CR-API-008 | NON_CONFORMANT |
| V3.5.4 | L2 | CR-BROWSER-007 | CONFORMANT |
| V3.5.5 | L2 | CR-BROWSER-005 | NOT_DEMONSTRATED |
| V3.5.8 | L3 | CR-BROWSER-008 | NOT_DEMONSTRATED |
| V3.7.1 | L2 | CR-BROWSER-009 | CONFORMANT |
| V3.7.2 | L2 | CR-BROWSER-010 | CONFORMANT |
| V4.1.1 | L1 | CR-API-005 | CONFORMANT |
| V4.1.2 | L2 | CR-TLS-003 | ACCEPTED_PLATFORM_DEVIATION |
| V4.1.3 | L2 | CR-API-011 | NOT_DEMONSTRATED |
| V4.2.1 | L2 | CR-CONFIG-007 | NOT_DEMONSTRATED |
| V5.1.1 | L2 | CR-DOC-005 | NON_CONFORMANT |
| V5.2.1 | L1 | CR-DOC-001 | CONFORMANT |
| V5.2.3 | L2 | CR-DOC-001 | CONFORMANT |
| V6.1.1 | L1 | CR-AUTH-011 | NON_CONFORMANT |
| V6.1.3 | L2 | CR-AUTH-009 | NON_CONFORMANT |
| V6.3.1 | L1 | CR-RESOURCE-001 | CONFORMANT |
| V6.3.2 | L1 | CR-AUTH-012 | CONFORMANT |
| V6.3.3 | L2 | CR-AUTH-010 | NON_CONFORMANT |
| V6.3.4 | L2 | CR-AUTH-002 | CONFORMANT |
| V6.7.2 | L3 | CR-AUTH-008 | CONFORMANT |
| V7.1.1 | L2 | CR-SESSION-006 | NON_CONFORMANT |
| V7.1.2 | L2 | CR-SESSION-009 | NON_CONFORMANT |
| V7.2.1 | L1 | CR-SESSION-001 | CONFORMANT |
| V7.2.2 | L1 | CR-AUTH-006 | CONFORMANT |
| V7.2.4 | L1 | CR-AUTH-006 | CONFORMANT |
| V7.3.1 | L2 | CR-SESSION-006 | NON_CONFORMANT |
| V7.3.2 | L2 | CR-SESSION-006 | NON_CONFORMANT |
| V7.4.1 | L1 | CR-SESSION-007, CR-CONC-005 | CONFORMANT |
| V7.4.3 | L2 | CR-SESSION-007 | CONFORMANT |
| V7.4.4 | L2 | CR-SESSION-010 | CONFORMANT |
| V7.5.2 | L2 | CR-SESSION-008 | NON_CONFORMANT |
| V7.5.3 | L3 | CR-AUTH-007 | CONFORMANT |
| V8.1.1 | L1 | CR-API-012 | NON_CONFORMANT |
| V8.1.2 | L2 | CR-API-012 | NON_CONFORMANT |
| V8.2.1 | L1 | CR-API-002, CR-DB-002 | CONFORMANT |
| V8.2.2 | L1 | CR-API-001 | CONFORMANT |
| V8.2.3 | L2 | CR-API-003 | CONFORMANT |
| V8.3.1 | L1 | CR-API-001 | CONFORMANT |
| V8.3.2 | L3 | CR-SESSION-007 | CONFORMANT |
| V8.4.1 | L2 | CR-API-001, CR-TELEGRAM-004 | CONFORMANT |
| V9.1.1 | L1 | CR-SESSION-001 | CONFORMANT |
| V9.1.2 | L1 | CR-SESSION-001 | CONFORMANT |
| V9.1.3 | L1 | CR-SESSION-001 | CONFORMANT |
| V9.2.1 | L1 | CR-SESSION-002 | CONFORMANT |
| V9.2.2 | L2 | CR-SESSION-003 | CONFORMANT |
| V9.2.3 | L2 | CR-SESSION-011 | NOT_DEMONSTRATED |
| V9.2.4 | L2 | CR-SESSION-011 | NOT_DEMONSTRATED |
| V11.1.1 | L2 | CR-CRYPTO-001 | NOT_DEMONSTRATED |
| V11.1.2 | L2 | CR-CRYPTO-002 | NON_CONFORMANT |
| V11.2.1 | L2 | CR-CRYPTO-003 | CONFORMANT |
| V11.2.2 | L2 | CR-CRYPTO-004 | NOT_DEMONSTRATED |
| V11.2.3 | L2 | CR-CRYPTO-005 | CONFORMANT |
| V11.3.1 | L1 | CR-CRYPTO-006 | CONFORMANT |
| V11.3.2 | L1 | CR-CRYPTO-006 | CONFORMANT |
| V11.3.3 | L2 | CR-CRYPTO-006 | CONFORMANT |
| V11.4.1 | L1 | CR-CRYPTO-007, CR-CRYPTO-009 | ACCEPTED_PROTOCOL_DEVIATION |
| V11.4.3 | L2 | CR-CRYPTO-007 | CONFORMANT |
| V11.5.1 | L2 | CR-AUTH-008 | CONFORMANT |
| V11.6.1 | L2 | CR-CRYPTO-008 | ACCEPTED_PROTOCOL_DEVIATION |
| V12.1.1 | L1 | CR-TLS-001 | NOT_DEMONSTRATED |
| V12.1.2 | L2 | CR-TLS-001 | NOT_DEMONSTRATED |
| V12.2.1 | L1 | CR-TLS-002 | CONFORMANT |
| V12.2.2 | L1 | CR-TLS-002 | CONFORMANT |
| V12.3.1 | L2 | CR-TLS-004 | NOT_DEMONSTRATED |
| V12.3.2 | L2 | CR-TLS-004 | NOT_DEMONSTRATED |
| V12.3.3 | L2 | CR-TLS-004 | NOT_DEMONSTRATED |
| V12.3.4 | L2 | CR-TLS-004 | NOT_DEMONSTRATED |
| V13.1.1 | L2 | CR-CONFIG-001 | NOT_DEMONSTRATED |
| V13.2.1 | L2 | CR-TELEGRAM-001 | CONFORMANT |
| V13.2.2 | L2 | CR-DB-001, CR-DB-002 | CONFORMANT |
| V13.2.3 | L2 | CR-CONFIG-002 | NOT_DEMONSTRATED |
| V13.2.4 | L2 | CR-PROVIDER-003 | CONFORMANT |
| V13.2.5 | L2 | CR-PROVIDER-003 | CONFORMANT |
| V13.3.1 | L2 | CR-SUPPLY-008 | NOT_DEMONSTRATED |
| V13.3.2 | L2 | CR-SUPPLY-008 | NOT_DEMONSTRATED |
| V13.4.1 | L1 | CR-SUPPLY-008 | NOT_DEMONSTRATED |
| V13.4.2 | L2 | CR-CONFIG-003 | NON_CONFORMANT |
| V13.4.3 | L2 | CR-CONFIG-004 | CONFORMANT |
| V13.4.4 | L2 | CR-CONFIG-005 | CONFORMANT |
| V13.4.5 | L2 | CR-CONFIG-006 | CONFORMANT |
| V14.1.1 | L2 | CR-PRIV-006 | NOT_DEMONSTRATED |
| V14.1.2 | L2 | CR-PRIV-006 | NOT_DEMONSTRATED |
| V14.2.1 | L1 | CR-PRIV-004 | NON_CONFORMANT |
| V14.2.2 | L2 | CR-PRIV-007 | NOT_DEMONSTRATED |
| V14.2.3 | L2 | CR-PRIV-003 | CONFORMANT |
| V14.2.4 | L2 | CR-PRIV-006 | NOT_DEMONSTRATED |
| V14.2.6 | L3 | CR-API-007, CR-PRIV-001 | NOT_DEMONSTRATED |
| V14.2.7 | L3 | CR-PRIV-002 | CONFORMANT |
| V14.3.1 | L1 | CR-PRIV-008 | NOT_DEMONSTRATED |
| V14.3.2 | L2 | CR-PRIV-009 | NOT_DEMONSTRATED |
| V14.3.3 | L2 | CR-SESSION-005 | CONFORMANT |
| V15.1.1 | L1 | CR-SUPPLY-005 | NON_CONFORMANT |
| V15.1.2 | L2 | CR-SUPPLY-006 | NOT_DEMONSTRATED |
| V15.1.3 | L2 | CR-RESOURCE-006 | NON_CONFORMANT |
| V15.2.1 | L1 | CR-SUPPLY-005 | NON_CONFORMANT |
| V15.2.2 | L2 | CR-RESOURCE-001, CR-RESOURCE-003, CR-RESOURCE-004, CR-RESOURCE-007, CR-DOC-003 | CONFORMANT |
| V15.2.3 | L2 | CR-CONFIG-008 | CONFORMANT |
| V15.3.1 | L1 | CR-API-007 | NOT_DEMONSTRATED |
| V15.3.2 | L2 | CR-PROVIDER-003 | CONFORMANT |
| V15.3.3 | L2 | CR-API-003 | CONFORMANT |
| V15.3.4 | L2 | CR-API-011 | NOT_DEMONSTRATED |
| V15.3.5 | L2 | CR-INPUT-011 | NOT_DEMONSTRATED |
| V15.3.6 | L2 | CR-INPUT-012 | NOT_DEMONSTRATED |
| V15.3.7 | L2 | CR-API-004 | CONFORMANT |
| V15.4.2 | L3 | CR-CONC-001, CR-CONC-002, CR-CONC-003, CR-CONC-004, CR-CONC-005, CR-RESOURCE-002 | CONFORMANT |
| V15.4.3 | L3 | CR-CONC-006 | CONFORMANT |
| V16.1.1 | L2 | CR-LOG-001 | NOT_DEMONSTRATED |
| V16.2.1 | L2 | CR-LOG-002 | NOT_DEMONSTRATED |
| V16.2.2 | L2 | CR-LOG-003 | NOT_DEMONSTRATED |
| V16.2.3 | L2 | CR-LOG-001 | NOT_DEMONSTRATED |
| V16.2.4 | L2 | CR-LOG-004 | NOT_DEMONSTRATED |
| V16.2.5 | L2 | CR-LOG-005 | NOT_DEMONSTRATED |
| V16.3.1 | L2 | CR-PRIV-005 | NOT_DEMONSTRATED |
| V16.3.2 | L2 | CR-PRIV-005 | NOT_DEMONSTRATED |
| V16.3.3 | L2 | CR-PRIV-005 | NOT_DEMONSTRATED |
| V16.3.4 | L2 | CR-LOG-006 | NOT_DEMONSTRATED |
| V16.4.1 | L2 | CR-LOG-007 | NOT_DEMONSTRATED |
| V16.4.2 | L2 | CR-LOG-008 | NOT_DEMONSTRATED |
| V16.4.3 | L2 | CR-LOG-009 | NOT_DEMONSTRATED |
| V16.5.1 | L2 | CR-API-006 | NOT_DEMONSTRATED |
| V16.5.2 | L2 | CR-RESOURCE-003, CR-PROVIDER-001, CR-PROVIDER-002 | NOT_DEMONSTRATED |
| V16.5.3 | L2 | CR-AUTH-005, CR-API-006, CR-PROVIDER-001 | NOT_DEMONSTRATED |

## 8. Pinned sources

| ID | Title | Version | Pin |
|---|---|---|---|
| SRC-ASVS | [Application Security Verification Standard](https://github.com/OWASP/ASVS/tree/v5.0.0_release/5.0) | 5.0.0 | git tag v5.0.0_release = 5cf9b032440be53ce345ab3c130fda46ba1ce7a2; requirement file 5.0/docs_en/OWASP_Application_Security_Verification_Standard_5.0.0_en.flat.json sha256 8201b20eec2908c3380ac600c91c8ba746346fbb808859366abb232027532311 |
| SRC-API | [OWASP API Security Top 10](https://github.com/OWASP/API-Security/tree/33cea37b2ffde3e2e62f6b5d79a029a22a846633/editions/2023/en) | 2023 edition | git commit 33cea37b2ffde3e2e62f6b5d79a029a22a846633 (master 2026-09-21), path editions/2023/en; editions present: 2019, 2023 only |
| SRC-ERC4361 | [ERC-4361: Sign-In with Ethereum](https://github.com/ethereum/ERCs/blob/faa49e076526bade48318f0d6e04d9a73f82c131/ERCS/erc-4361.md) | status Final | git commit faa49e076526bade48318f0d6e04d9a73f82c131 of ERCS/erc-4361.md |
| SRC-ERC1271 | [ERC-1271: Standard Signature Validation Method for Contracts](https://github.com/ethereum/ERCs/blob/8dd085d159cb123f545c272c0d871a5339550e79/ERCS/erc-1271.md) | status Final | git commit 8dd085d159cb123f545c272c0d871a5339550e79 of ERCS/erc-1271.md |
| SRC-ERC191 | [ERC-191: Signed Data Standard](https://github.com/ethereum/ERCs/blob/8dd085d159cb123f545c272c0d871a5339550e79/ERCS/erc-191.md) | status Final | git commit 8dd085d159cb123f545c272c0d871a5339550e79 of ERCS/erc-191.md |
| SRC-SAFE | [safe-smart-account: CompatibilityFallbackHandler, SignMessageLib](https://github.com/safe-global/safe-smart-account/tree/bf943f80fec5ac647159d26161446ac5d716a294/contracts) | v1.4.1 (reference, matches simulated behaviour in tests); v1.5.0 current release | git tag v1.4.1 = bf943f80fec5ac647159d26161446ac5d716a294; v1.5.0 = dc437e8fba8b4805d76bcbd1c668c9fd3d1e83be |
| SRC-SAFE-APPS | [safe-apps-sdk](https://github.com/safe-global/safe-apps-sdk) | @safe-global/safe-apps-sdk 9.1.0 (pinned in package.json) | npm exact version 9.1.0 + package-lock integrity |
| SRC-SSDF | [SP 800-218 Secure Software Development Framework (SSDF)](https://doi.org/10.6028/NIST.SP.800-218) | 1.1 (final) | publication identifier NIST SP 800-218 (Final), DOI 10.6028/NIST.SP.800-218 |
| SRC-SCORECARD | [OpenSSF Scorecard checks](https://github.com/ossf/scorecard/blob/v5.6.0/docs/checks.md) | v5.6.0 | git tag v5.6.0 = 30831805a70dd0ec92139784ce076d81fc484c18 |
| SRC-OSSF-NPM | [npm Best Practices Guide (package-manager-best-practices)](https://github.com/ossf/package-manager-best-practices/blob/f51988aee8a9a1ab0436bbba61c1e94d7270683a/published/npm.md) | published/npm.md | git commit f51988aee8a9a1ab0436bbba61c1e94d7270683a |
| SRC-SLSA | [SLSA specification](https://github.com/slsa-framework/slsa/tree/19e4e2f005f871270c4f555fc47afecfb37f3efe/docs/spec/v1.2) | v1.2 | git tag v1.2 = 19e4e2f005f871270c4f555fc47afecfb37f3efe |
| SRC-TG | [Telegram Bot API](https://core.telegram.org/bots/api) | Bot API 10.3 | unversioned web page; pinned by Bot API version 10.3 + retrieval date; normative quotes: setWebhook secret_token / X-Telegram-Bot-Api-Secret-Token; CallbackQuery.data "the message originated the query can contain no callback buttons with this data" |
| SRC-PG | [PostgreSQL 17 documentation: CREATE FUNCTION - Writing SECURITY DEFINER Functions Safely](https://www.postgresql.org/docs/17/sql-createfunction.html) | 17 (production reports 17.6.1.155) | major-version documentation URL + retrieval date |
| SRC-ASVS-APPC | [ASVS 5.0.0 Appendix C: Cryptography Standards](https://github.com/OWASP/ASVS/blob/5cf9b032440be53ce345ab3c130fda46ba1ce7a2/5.0/en/0x92-Appendix-C_Cryptography.md) | 5.0.0 | git tag v5.0.0_release = 5cf9b032440be53ce345ab3c130fda46ba1ce7a2, path 5.0/en/0x92-Appendix-C_Cryptography.md, sha256 3e01f78cb945011059e7e86b3e6ce11478c95d0ea9d559fec60143a519c403f6 |
| SRC-ETH-YP | [Ethereum Yellow Paper (Paper.tex)](https://github.com/ethereum/yellowpaper/blob/efc5f9a1f356cba376c978eedb63cb0363c2aa85/Paper.tex) | master @ efc5f9a1 | git commit efc5f9a1f356cba376c978eedb63cb0363c2aa85, sha256 e24873bc2edc6f41fad1c319299f2ceff4e21b243a0fba83a61cfed4a11eb618 |
| SRC-ETH-EXECSPECS | [Ethereum execution-specs: crypto/elliptic_curve.py and crypto/hash.py](https://github.com/ethereum/execution-specs/tree/2004296f2ffcbcebcd00f41152d33e8dfda0922a/src/ethereum/crypto) | v2.20.0 | git tag v2.20.0 = 2004296f2ffcbcebcd00f41152d33e8dfda0922a; elliptic_curve.py sha256 216673ca717b6b6fcbc4d11009ed7e5126ed9fe65021834960b68147f660480b; hash.py sha256 a91044ec31477542dfeea97c9480456146332ac64cc0a9b5150264e19bb6440b |
| SRC-VERCEL-ENC | [Vercel docs: Encryption (HTTPS redirection)](https://vercel.com/docs/cdn-security/encryption) | unversioned web page | unversioned page; pinned by retrieval date + normative quote: "HTTPS redirection is an industry standard and can't be disabled." |

## 9. Drift model

Drift output only prioritises review. security:verify always evaluates every control; no control is skipped because of drift.

| Path | Domains |
|---|---|
| `src/*auth*` | CR-AUTH, CR-SESSION, CR-CONC |
| `src/siwe-auth.mjs` | CR-AUTH, CR-SESSION, CR-CRYPTO |
| `src/contract-*.mjs` | CR-AUTH, CR-PROVIDER, CR-CRYPTO |
| `src/db.mjs` | CR-DB, CR-CONC, CR-RESOURCE, CR-API, CR-INPUT |
| `src/http-security.mjs` | CR-BROWSER, CR-API, CR-RESOURCE |
| `api/dashboard*` | CR-AUTH, CR-SESSION, CR-API, CR-BROWSER, CR-RESOURCE |
| `api/link/*` | CR-AUTH, CR-TELEGRAM, CR-API |
| `api/link.mjs` | CR-TELEGRAM, CR-API |
| `api/telegram*` | CR-TELEGRAM, CR-API, CR-RESOURCE |
| `api/positions*` | CR-API, CR-PROVIDER, CR-RESOURCE |
| `api/position-attributions*` | CR-API, CR-CONC, CR-PROVIDER, CR-PRIV |
| `api/alerts*` | CR-API, CR-RESOURCE |
| `src/alerts*` | CR-RESOURCE, CR-TELEGRAM, CR-PROVIDER |
| `src/bot.mjs` | CR-TELEGRAM, CR-API, CR-INPUT |
| `src/nexus*` | CR-DOC, CR-PROVIDER |
| `src/pdf-text.mjs` | CR-DOC |
| `src/agent-*.mjs` | CR-DOC, CR-PRIV |
| `src/positions/*` | CR-PROVIDER, CR-RESOURCE |
| `src/cover*.mjs` | CR-PROVIDER |
| `src/security-events.mjs` | CR-LOG, CR-PRIV |
| `web/*` | CR-BROWSER, CR-SESSION, CR-CONFIG |
| `supabase/migrations/*` | CR-DB, CR-CONC, CR-RESOURCE |
| `package.json` | CR-SUPPLY, CR-VERIFY, CR-CRYPTO |
| `package-lock.json` | CR-SUPPLY, CR-CRYPTO |
| `.github/workflows/*` | CR-SUPPLY, CR-VERIFY |
| `vercel.json` | CR-BROWSER, CR-SUPPLY, CR-CONFIG, CR-TLS |
| `scripts/run-tests-guarded.mjs` | CR-VERIFY |
| `test/*` | CR-VERIFY |
| `test-support/*` | CR-VERIFY |
| `*.md` | CR-AUTH, CR-API, CR-CRYPTO, CR-LOG, CR-INPUT, CR-RESOURCE, CR-PRIV |
| `security/**` | CR-VERIFY |
| `scripts/security-*.mjs` | CR-VERIFY |
| `scripts/skip-policy.mjs` | CR-VERIFY |

## 10. Framework versions

- **1.0-draft-phase1b** — ASVS mapping completed (0 applicable unmapped), normalized schemas, sub-property engine, 11 Phase-1 FAILs reassessed (1 -> MISSING_EVIDENCE).
- **1.0-draft-phase1c** — Conformance and security axes separated; deviation model; CR-CRYPTO-008 split (CR-CRYPTO-009 added); 2 protocol + 1 platform deviations accepted; 4 sources added.
- **1.0-draft-phase2a** — Materialised in the repository. JSON is authoritative; statuses recomputed by scripts/security-verify.mjs. Scratchpad mutation records EV-MUT-{L2,L3,H2,L1,L4,L5} replaced by reproducible mutation evidence EV-KB-* (security/mutation/cases.json, 66 cases). EV-CRSF-SELFTEST and EV-PROBE-LOW-S added. Owner sign-off field added (PENDING). Framework lock bootstrapped. No control definition, release class or minimum level changed.
- **1.0-draft-phase2b** — Evidence closure for release-blocking controls: 11 closed (CR-API-002, CR-TELEGRAM-001, CR-AUTH-001/002/003/007, CR-SESSION-002/003/005/007, CR-CONC-005); 6 new test files, 37 new mutation cases; the Phase 2A surviving cron mutation is now KILLED. No application code changed.
- **1.0-draft-phase2c** — Evidence closure continued: 10 release-blocking controls closed (CR-DB-001/002, CR-AUTH-004/006/008, CR-API-001, CR-VERIFY-001/002/005/009); EQUIVALENT and MULTI_LAYER mutation semantics; two framework fixes; one test-infrastructure finding; two framework-policy gaps reported. No application code changed.
- **1.0-draft-phase2d** — Phase 2D: F-2C-1 fixed (case-less test files fail the guard and the CRSF executor); CR-API-004 P1 clarified (reject or demonstrably ignore); property-specific structural rule for CR-SESSION-001 P2/P3; derivation locked (CR-VERIFY-011); real-system evidence must need real infrastructure (F-2D-1); application finding F-2D-2 recorded as a VIOLATION of CR-PROVIDER-001 P2 (stop condition B, not fixed).
- **1.0-draft-phase2e** — Phase 2E: F-2D-2 fixed (fail closed on malformed eth_getCode answers); CR-PROVIDER-001 recomputed; finding-fix records must be proven (FINDING_FIX_NOT_PROVEN).
- **1.0-draft-phase2f** — Phase 2F: application finding F-2F-1 recorded as a VIOLATION of CR-RESOURCE-001 P1 (stop condition B, not fixed); remaining controls not attempted.
- **1.0-draft-phase2g** — Phase 2G: F-2F-1 fixed (dashboard action limits before the legacy provider lookup); CR-RESOURCE-001 recomputed (no FAIL; P1 evidence partial, P2-P4 unchanged).
- **1.0-draft-phase2h** — Phase 2H: application finding F-2H-1 recorded as a VIOLATION of CR-RESOURCE-001 P4 (stop condition B, not fixed); remaining work not attempted.
- **1.0-draft-phase2i** — Phase 2I: F-2H-1 fixed in api/position-attributions.mjs (global cover budget before every cover lookup), proven behaviourally and by four KILLED mutations; the VIOLATION probe is inverted to a regression proof. Same-root-cause search found a separate application finding F-2I-1 (Telegram cover lookups without any limit), recorded and not fixed (stop).
- **1.0-draft-phase2j** — Phase 2J: findings ledger (F-2J-1) - every open application finding must map to a control property or fail the release; F-2I-1 mapped to the new control CR-RESOURCE-007 and fixed.
- **1.0-draft-phase2k** — Phase 2K: application finding F-2K-1 recorded (UNMAPPED, release FAIL) during the CR-RESOURCE-001 path inventory - stop condition B; no evidence closure attempted.
- **1.0-draft-phase2l** — Phase 2L: F-2K-1 mapped to CR-RESOURCE-001 P5 (PROPERTY_ADDED: link read limits before the Telegram getChat call) and fixed in api/link.mjs.
- **1.0-draft-phase2m** — Phase 2M: CR-RESOURCE-001 P1-P4 behavioural evidence for every named path, with known-bad mutations; no application change, no finding.
- **1.0-draft-phase2n** — Phase 2N: CR-INPUT-004 behavioural evidence (request structure of every database helper, adversarial values and SQL functions on real Postgres, function catalog) with known-bad mutations; no application change, no finding.
- **1.0-draft-phase2o** — Phase 2O: defense-in-depth hardening of the remembered-wallet LIKE boundary (CR-INPUT-004 P1 precondition recorded in Phase 2N); application change in src/db.mjs only; no finding.
- **1.0-draft-phase2p** — Phase 2P: CR-BROWSER-004 behavioural evidence (real frontend rendering with hostile API data, CSP enforced in headless Chrome, syntax-tree structure) with known-bad mutations; no application change, no finding.
- **1.0-draft-phase2q** — Phase 2Q: CR-VERIFY-003 historical security-fix register (102 fixes, 99 PROVEN at E4, 3 MISSING_EVIDENCE) with a fail-closed inventory guard and 82 new known-bad mutations; no application change, no finding.
- **1.0-draft-phase2r** — Phase 2R: CR-VERIFY-003 remaining historical fixes. cad24d4 (.vercelignore) and b647281 (npm ci) PROVEN at E4 with the real Vercel CLI locally (no deployment, no network); b706956 registry signatures stays MISSING_EVIDENCE (EXTERNAL_EVIDENCE_REQUIRED: npm needs the Sigstore TUF mirror online). Every historical commit classified; future commits need a Security-Fix: trailer. No application change, no finding.
- **1.0-draft-phase2s** — Phase 2S: FIX-B706956-REGISTRY-SIGNATURES proven at E4 with the real npm verifier (real Sigstore TUF, real registry keys, tampered package metadata in a disposable cache); 102/102 historical fixes PROVEN. No application change, no finding.
- **1.0-draft-phase2ua** — Phase 2U (part a): framework findings F-2T-1 and F-2T-2 from the Phase 2T analysis persisted as OPEN before any fix. No status, threshold or control text changed.
- **1.0-draft-phase2u** — Phase 2U: framework findings F-2T-1 (fake E5 via declared metadata) and F-2T-2 (fixture N needs an open control) fixed. Real-system evidence is credited only from a runner-signed observation receipt (server-confirmed Postgres use; observed overlap for concurrency claims). All 8 existing real-system items revalidated with observed use, the 6 covering concurrency claims with observed overlap; no control lost PASS. CR-VERIFY-004 unchanged and still MISSING_EVIDENCE. No application change.
- **1.0-draft-phase2v** — Phase 2V: real-Postgres concurrency evidence with runner-observed use and overlap for CR-RESOURCE-002 (rate limiter counting) and CR-CONC-006 (advisory locks); four KILLED mutations. No application change, no finding. CR-VERIFY-004 re-evaluated and left MISSING_EVIDENCE (see record).

