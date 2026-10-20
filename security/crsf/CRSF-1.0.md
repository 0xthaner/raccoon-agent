# CoverRaccoon Security Framework — CRSF 1.0-draft-phase2zl

> Generated from `security/crsf/*.json` by `security/crsf/generator/crsf-gen.mjs`. Do not edit by hand.
>
> CoverRaccoon is **mapped against and evaluated against** the pinned sources below. This document is not a certification and makes no compliance claim. The statuses here are the *declared* evaluation of the definition; `npm run security:verify` recomputes them from executed evidence for a specific commit.

## 1. Declared evaluation

### Security assurance

- FAIL: 19
- INFORMATIONAL: 2
- MISSING_EVIDENCE: 47
- PASS_AUTOMATED: 84
- PASS_MANUAL: 24

### Release classes

- INFORMATIONAL: 2
- MANUAL_ASSURANCE: 30
- RELEASE_BLOCKING: 80
- SECURITY_DEBT: 64

### Release-blocking controls by security status

- PASS_AUTOMATED: 80

### Standard conformance (ASVS 5.0.0, applicable requirements)

- ACCEPTED_PLATFORM_DEVIATION: 1
- ACCEPTED_PROTOCOL_DEVIATION: 2
- CONFORMANT: 79
- NON_CONFORMANT: 21
- NOT_DEMONSTRATED: 59

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
| CR-VERIFY-004 | Concurrency claims proven with real concurrent execution | RELEASE_BLOCKING | E5 | **PASS_AUTOMATED** | CONFORMANT | all 1 sub-properties satisfied at >= E5 (P1 derived by OBSERVED_CONCURRENCY_COVERAGE over 23 properties) |
| CR-VERIFY-005 | Security tests fail for the intended reason | RELEASE_BLOCKING | E4 | **PASS_AUTOMATED** | CONFORMANT | all 1 sub-properties satisfied at >= E4 |
| CR-VERIFY-006 | Production-code vs test-only changes distinguished per release | MANUAL_ASSURANCE | E1 | **MISSING_EVIDENCE** | NOT_DEMONSTRATED | P1 unsatisfied |
| CR-VERIFY-007 | Deployed artifact equals intended commit | MANUAL_ASSURANCE | E1 | **PASS_MANUAL** | CONFORMANT | all 1 sub-properties satisfied at >= E1 |
| CR-VERIFY-008 | Security claims identify untested/manual portions | MANUAL_ASSURANCE | E1 | **MISSING_EVIDENCE** | NOT_DEMONSTRATED | P1 unsatisfied |
| CR-VERIFY-009 | Tests that pass against known-bad code rejected as evidence | RELEASE_BLOCKING | E4 | **PASS_AUTOMATED** | CONFORMANT | all 1 sub-properties satisfied at >= E4 |
| CR-VERIFY-010 | Release-blocking controls not weakened to preserve release | RELEASE_BLOCKING | E3 | **PASS_AUTOMATED** | CONFORMANT | all 1 sub-properties satisfied at >= E3 |
| CR-VERIFY-011 | Controls derived from pinned sources before results | RELEASE_BLOCKING | E3 | **PASS_AUTOMATED** | CONFORMANT | all 1 sub-properties satisfied at >= E3 |
| CR-VERIFY-012 | Machine-readable status preserves FAIL and MISSING_EVIDENCE | RELEASE_BLOCKING | E3 | **PASS_AUTOMATED** | CONFORMANT | all 1 sub-properties satisfied at >= E3 |
| CR-NEXUS-001 | Nexus product identity pinned and validated | RELEASE_BLOCKING | E3 | **PASS_AUTOMATED** | CONFORMANT | all 2 sub-properties satisfied at >= E3 |
| CR-NEXUS-002 | Position to Nexus product mapping fails closed | RELEASE_BLOCKING | E3 | **PASS_AUTOMATED** | CONFORMANT | all 2 sub-properties satisfied at >= E3 |
| CR-NEXUS-003 | Nexus API responses structurally validated | RELEASE_BLOCKING | E3 | **PASS_AUTOMATED** | CONFORMANT | all 3 sub-properties satisfied at >= E3 |
| CR-NEXUS-004 | Nexus API failure cannot create availability | RELEASE_BLOCKING | E3 | **PASS_AUTOMATED** | CONFORMANT | all 2 sub-properties satisfied at >= E3 |
| CR-NEXUS-005 | Only an explicitly supported product and chain becomes AVAILABLE | RELEASE_BLOCKING | E3 | **PASS_AUTOMATED** | CONFORMANT | all 1 sub-properties satisfied at >= E3 |
| CR-QUOTE-001 | Quote product derived server-side, never chosen by the client | RELEASE_BLOCKING | E3 | **PASS_AUTOMATED** | CONFORMANT | all 1 sub-properties satisfied at >= E3 |
| CR-QUOTE-002 | Quote bound to an EXACT validated Nexus mapping of the session wallet | RELEASE_BLOCKING | E3 | **PASS_AUTOMATED** | CONFORMANT | all 1 sub-properties satisfied at >= E3 |
| CR-QUOTE-003 | Quote amount, asset and period strictly bounded | RELEASE_BLOCKING | E3 | **PASS_AUTOMATED** | CONFORMANT | all 3 sub-properties satisfied at >= E3 |
| CR-QUOTE-004 | Nexus quote responses strictly validated | RELEASE_BLOCKING | E3 | **PASS_AUTOMATED** | CONFORMANT | all 2 sub-properties satisfied at >= E3 |
| CR-QUOTE-005 | Quote freshness explicit; stale quotes never usable | RELEASE_BLOCKING | E3 | **PASS_AUTOMATED** | CONFORMANT | all 1 sub-properties satisfied at >= E3 |
| CR-QUOTE-006 | Nexus failures never produce a synthetic premium or availability | RELEASE_BLOCKING | E3 | **PASS_AUTOMATED** | CONFORMANT | all 1 sub-properties satisfied at >= E3 |
| CR-QUOTE-007 | User-facing quote is informational and cannot trigger wallet methods | RELEASE_BLOCKING | E3 | **PASS_AUTOMATED** | CONFORMANT | all 2 sub-properties satisfied at >= E3 |
| CR-QUOTE-008 | Quote retrieval rate limited per IP, wallet and globally | RELEASE_BLOCKING | E3 | **PASS_AUTOMATED** | CONFORMANT | all 1 sub-properties satisfied at >= E3 |
| CR-NEXUS-006 | Pinned Nexus contracts bound to their verified deployed source | RELEASE_BLOCKING | E3 | **PASS_AUTOMATED** | CONFORMANT | all 3 sub-properties satisfied at >= E3 |
| CR-NEXUS-007 | Aave v3 Ethereum scope, purchase readiness, cover status and quote freshness fail closed | RELEASE_BLOCKING | E3 | **PASS_AUTOMATED** | CONFORMANT | all 6 sub-properties satisfied at >= E3 |
| CR-PURCHASE-003 | Purchase intent canonically binds every security-critical value (P4A model) | RELEASE_BLOCKING | E3 | **PASS_AUTOMATED** | CONFORMANT | all 6 sub-properties satisfied at >= E3 |
| CR-PURCHASE-005 | Purchase-intent state model allows only the defined single-use transitions (P4A model, P4D database) | RELEASE_BLOCKING | E3 | **PASS_AUTOMATED** | CONFORMANT | all 13 sub-properties satisfied at >= E3 |
| CR-COMMISSION-001 | Commission fixed server-side to zero (P4A policy) | RELEASE_BLOCKING | E3 | **PASS_AUTOMATED** | CONFORMANT | all 2 sub-properties satisfied at >= E3 |
| CR-ALLOC-001 | Pool allocations validated per verified Cover v3.3.0 semantics | RELEASE_BLOCKING | E3 | **PASS_AUTOMATED** | CONFORMANT | all 3 sub-properties satisfied at >= E3 |
| CR-TERMS-001 | Purchase acknowledgements bound to exact text versions, documents, wallet and intent | RELEASE_BLOCKING | E3 | **PASS_AUTOMATED** | CONFORMANT | all 3 sub-properties satisfied at >= E3 |
| CR-TERMS-002 | Nexus-required purchase texts confirmed by Nexus | SECURITY_DEBT | E1 | **MISSING_EVIDENCE** | NOT_DEMONSTRATED | P1 unsatisfied; P2 unsatisfied; P3 unsatisfied |
| CR-POL-001 | Proof-of-loss payload bound to the authenticated wallet and minimal (P4B, local only) | RELEASE_BLOCKING | E3 | **PASS_AUTOMATED** | CONFORMANT | all 4 sub-properties satisfied at >= E3 |
| CR-POL-002 | Proof-of-loss server semantics and claim validity confirmed by Nexus | SECURITY_DEBT | E1 | **MISSING_EVIDENCE** | NOT_DEMONSTRATED | P1 unsatisfied; P2 unsatisfied; P3 unsatisfied; P4 unsatisfied |
| CR-PURCHASE-001 | Purchase transactions fixed to the verified Broker, buyCover selector and USDC approval target (P4C offline) | RELEASE_BLOCKING | E3 | **PASS_AUTOMATED** | CONFORMANT | all 3 sub-properties satisfied at >= E3 |
| CR-PURCHASE-002 | buyCover fields derived only from the validated intent and quote; independently decoded (P4C offline) | RELEASE_BLOCKING | E3 | **PASS_AUTOMATED** | CONFORMANT | all 4 sub-properties satisfied at >= E3 |
| CR-APPROVAL-001 | USDC approval exact: maxPremium to the Broker only (P4C offline) | RELEASE_BLOCKING | E3 | **PASS_AUTOMATED** | CONFORMANT | all 3 sub-properties satisfied at >= E3 |
| CR-PURCHASE-006 | Purchase receipt independently verified on-chain against the intent (P4E, read-only) | RELEASE_BLOCKING | E3 | **PASS_AUTOMATED** | CONFORMANT | all 7 sub-properties satisfied at >= E3 |
| CR-PURCHASE-007 | Cover implementation drift at execution disables receipt verification (P4E) | RELEASE_BLOCKING | E3 | **PASS_AUTOMATED** | CONFORMANT | all 2 sub-properties satisfied at >= E3 |
| CR-PURCHASE-008 | Pre-send chain validation, USDC implementation pin, wallet execution and confirmed-state recording | SECURITY_DEBT | E3 | **MISSING_EVIDENCE** | NOT_DEMONSTRATED | P3 unsatisfied |

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
| EV-DBPRIV-DB | real-system | E5 | node-test | FULL | yes | RLS on every public table; anon/authenticated hold no table privilege and really get 42501 on read/insert/delete of every table; no role can CREATE in public; function EXECUTE matches the allowlist exactly (5 runtime RPCs + legacy consume_wallet_link + the 8 P4D purchase-intent functions, which have no runtime caller, for service_role only; internal helpers incl. the P4D trigger and JSON helper for nobody; PUBLIC nowhere); SECURITY DEFINER set and pinned search_path |
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
| EV-INPUT-DB-PG | real-system | E5 | node-test | FULL | yes | disposable Postgres with every migration; real src/db.mjs and supabase-js, each PostgREST request translated into one statement with bound parameters (test-support/pg-postgrest.mjs). P1: adversarial lookups, updates and deletes match nothing, change no row outside their own keys (content hash of every table) and either succeed or fail with a data error (22P02/22007/23514), never a syntax or object error; adversarial values are stored and read back literally (events, labels, rate keys, link rows, challenges); per-chat LIKE patterns are anchored on the delimiter (chat 1 never touches 10, 12 or 100, on forget and on link); at the helper boundary each of chats 1, 10, 12, 100 (number and string) reads and forgets only its own remembered wallet, all 38 out-of-domain ids read nothing and delete nothing, and link cleanup for a link row with a wildcard chat id (%, _, 1%, 1_) deletes nothing while chat 10 cleans only chat 10. P2: every callable function (alert_subscriptions_page, check_agent_rate_limit, consume_wallet_link, consume_wallet_link_v2, link_wallet_to_chat_limited, lock_chat_wallets, revoke_dashboard_sessions_atomic, upsert_position_attribution_limited) called with adversarial text, and the P4D purchase-intent functions (create, build, submit, confirm, fail, late-confirm, cancel) with adversarial text in every text parameter: always rejected, nothing created or changed: no syntax error, no foreign row, values stored literally in the code's chat only, malformed wallets/deployment keys rejected by checks; catalog: exactly these functions plus the P4D expire helper, trigger function and JSON helper, plpgsql/sql only, no EXECUTE, format() or quote_* in any body, SECURITY DEFINER functions with a fixed search_path, no trigger except the P4D immutability trigger cover_purchase_intents_guard, no event triggers. |
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
| EV-META-DERIVATION | behavioral | E3 | node-test | PARTIAL | yes | The derivation of CR-VERIFY-004 P1 from the real definition: PASS only when every canonical concurrency property is genuinely satisfied and observed (M9); not PASS for a property without evidence (M1), a missing postgres capability (M2), use without overlap (M3), overlap without a completed statement (M3b), a NOT_RUN / SURVIVED / KILLED_OTHER / INVALID mutation or a declared gap (M4, M5), a VIOLATION or open finding (M6), a new marked or unmarked concurrency property without evidence (M7), declared metadata without a runner observation, a fake-upstream receipt or a failed run (M8), the reduced environment (M10), an unkilled rule mutation; a relabelled real-system item covering CR-VERIFY-004 is a framework error and not counted; lowering the meta control below a real-system level is a framework error. |
| EV-KB-META-CONC | known-bad | E4 | mutation | FULL | yes | Each weakening of the derivation is detected by the meta-derivation tests: tolerating one failing property (A), ignoring missing Postgres use (B) or overlap (C), accepting a NOT_RUN mutation (D), accepting declared instead of observed E5 (E), hard-coding the current concurrency set (F). |
| EV-NEXUS-READ | behavioral | E3 | node-test | FULL | yes | Offline, against captured Nexus responses: product 97 is AVAILABLE for an Aave v3 Ethereum Core position only with its exact pinned identity and wording; renamed, similarly named, re-typed, private, deprecated, re-categorised, re-worded or annexed products are UNAVAILABLE; wrong chain, Aave v2, look-alike protocol keys and another market address are AMBIGUOUS; Lido/Prime and EtherFi are PROBABLE and never read; malformed, mismatched, inflated or zero capacity, timeouts, network/HTTP errors and redirected responses are UNAVAILABLE; only GET on three allowlisted paths, bounded size, failures not cached; only ETH/USDC/cbBTC capacity reported with timestamp; exposure AAVE_NET_EXPOSURE_V1 exact and disclaimed; no purchase fields. |
| EV-KB-NEXUS-READ | known-bad | E4 | mutation | FULL | yes | Each listed weakening of the read-only Nexus integration is detected by its intended test: renamed or similar product name, wrong product type, changed wording, wrong chain, Aave v2 as v3, similar protocol key, malformed or fake-high capacity, followed redirect, missing capacity, API timeout, stale data after failure, ambiguous deployment accepted. |
| EV-NEXUS-QUOTE | behavioral | E3 | node-test | FULL | yes | Offline, real handler with real session/origin/JSON checks, real read model and quote validation against captured Nexus responses: valid USDC and ETH quotes (server-derived productId 97, fixed GET path, no redirect); client productId rejected; ambiguous, unsupported and unavailable positions get a neutral status and no quote request; unsupported assets, amounts above exposure or capacity and periods outside 28..365 rejected before Nexus; malformed, foreign-pool, foreign-asset, mispriced, redirected or timed-out quotes never become a premium; quotes stale after 60 s and never usable; per-IP/wallet/global limits; responses without pools, fees or transaction fields; no purchase surface in runtime code; the cover panel (recording DOM) never calls a wallet method, renders remote strings as text and links only validated Nexus IPFS URLs. |
| EV-KB-NEXUS-QUOTE | known-bad | E4 | mutation | FULL | yes | Each listed weakening of the quote display is detected by its intended test: client productId, ambiguous mapping, unsupported asset, amount above capacity or exposure, period below 28 or above 365 days, malformed/foreign-product/foreign-asset quote, followed redirect, arbitrary host, stale quote marked fresh, fallback premium on timeout, wallet method from the panel, exposed pools/fee fields, missing global quote budget. |
| EV-NEXUS-SOURCE | behavioral | E3 | node-test | FULL | yes | Offline against captured on-chain runtimes (eth_getCode identical at three RPCs) and independently recompiled candidate builds: the pinned CoverBroker (v2.12.1) and Cover implementation (v3.3.0) builds differ from the deployed code only inside compiler-declared immutable regions, carry the identical metadata hash and immutable values equal to the pin; the v3.4.0 broker (other program), the v3.4.0 Cover (other metadata) and every cross-substitution do not verify; the deployed broker dispatches exactly its build's 12 functions and none of the v3-only ones (pool, registry, tokenController); sources.json pins both separately, consistent with the code pin and the fixture hashes. |
| EV-KB-NEXUS-SOURCE | known-bad | E4 | mutation | FULL | yes | The old v3.4.0 broker pin, a wrong broker immutable, the broker pinned to the Cover source, and the Cover pinned to v3.4.0 are each detected by the intended test. |
| EV-PURCHASE-INTENT | behavioral | E3 | node-test | PARTIAL | yes | Behaviourally, against the pure module: a valid intent validates and hashes stably and independently of key order and wallet spelling; changing any model field or any contract pin changes the hash; every listed policy violation, unknown/derived/caller-hash field and non-canonical raw amount is rejected and has no hash, 2^96-1 and 2^53+1 round-trip exactly; exactly the 8 allowed transitions hold over all 49 pairs, terminal states have none, SUBMITTED expires never and keeps a late outcome; expiry only with an explicit time; readiness is never send-ready and proof of loss blocks every transaction; commission only 0/0x0; the real 1000 USDC quote (1000192871) passes, below-requested, off-total, over-cap, duplicate, zero and oversized lists fail; the module imports only viem and nexus-pinned, touches no network or clock when called, emits no transaction shape, and no file under src, api, web or scripts imports it. |
| EV-KB-PURCHASE-INTENT | known-bad | E4 | mutation | PARTIAL | yes | Each listed weakening of the hash, validation, integer parsing, purity, reachability, commission policy, transition table, expiry and allocation rules is detected by the intended test. |
| EV-PURCHASE-TERMS | behavioral | E3 | node-test | FULL | yes | Behaviourally, against the pure module: the terms hash is deterministic over a fixed ABI layout and independent of wallet spelling; it changes with every bound text reference, wording, annex, wallet and intent id; unknown, superseded and wrong-category references, missing acknowledgements, booleans and caller hashes are rejected; a stored record with a wrong hash is invalid; text versions are pinned by digest; unconfirmed Nexus texts have no wording and block readiness (BLOCKED_NEXUS_TEXT before BLOCKED_SOURCE_PIN before READY_MODEL_ONLY), and no readiness means buy; the hash validates in and binds the P4A intent, whose transactional readiness stays BLOCKED_PROOF_OF_LOSS; the module has no I/O, signing or transaction surface. |
| EV-PURCHASE-POL | behavioral | E3 | node-test | FULL | yes | Behaviourally, against the pure module: the payload is built from the wallet only and is exactly { creatorAddress, proofOfLoss: [address entry with the wallet] }; creator, address or owner other than the wallet, a second address or entry, other entry types, named personal / credential / file / free-text fields and any unknown field are rejected; a locally valid payload stays BLOCKED_NEXUS_CONFIRMATION with the open questions listed; the module imports only the P4A module, contains no network, upload, signature, hashing or CID code, does not call fetch when used, and no runtime file imports it. |
| EV-KB-PURCHASE-TERMS-POL | known-bad | E4 | mutation | FULL | yes | Each listed weakening of the terms hash binding, text version resolution, readiness gate, wallet binding, minimality, purity and reachability is detected by the intended test. |
| EV-PURCHASE-TX-BUILDER | behavioral | E3 | node-test | PARTIAL | yes | Behaviourally, against the pure builder: the local Broker ABI equals the verified v2.12.1 signature (recompilation methodIdentifiers, deployed runtime dispatches 0x7c59cac4) and wrong ABI assumptions change the selector; the approval is exactly USDC.approve(Broker, maxPremiumRaw), value 0, deterministic, never unbounded (MaxUint and above-cover maxima rejected); buyCover decodes (test-own ABI) to exactly the intent/quote-derived fields with value 0, the real overshooting quote is accepted, underflow / mismatch / premium above max / other assets / missing proof-of-loss CID are rejected; calldataHash is deterministic and changes with each bound field; every override field is rejected; only two fixed encodings exist; outputs are never production-ready; no wallet, send, network, DB, clock or unlimited-approval code; no runtime import; transaction encoding exists only in the two P4C modules. |
| EV-PURCHASE-TX-DECODE | behavioral | E3 | node-test | PARTIAL | yes | Behaviourally, against the independent decoder (which does not import the builder): builder outputs validate; every single-bit change of either calldata is rejected; each changed buyCover field fails with its own reason; changed target, value, selector, chain, metadata, extra transaction fields, trailing bytes and intent binding are rejected; empty proof-of-loss is never accepted; approval spender / amount / MaxUint / target are exact; the real mainnet purchase of block 26219867 (hash recomputed offline) decodes structurally and is rejected by CoverRaccoon policy for exactly commission ratio, commission destination and missing proof-of-loss. |
| EV-KB-PURCHASE-TX | known-bad | E4 | mutation | FULL | yes | Each listed weakening of target, selector, ABI, approval, field derivation, override rejection, decoder checks, purity and reachability is detected by the intended test. |
| EV-PURCHASE-DB | real-system | E5 | node-test | PARTIAL | yes | Disposable Postgres with every migration and emulated Supabase default privileges; the real helper src/purchase-intent-db.mjs over a supabase-js-shaped rpc adapter (one bound statement per call). Immutability: every listed critical field and every once-set value is refused by the trigger (also by the owner), values are never cleared, late only false->true; the stored hash equals the P4A hash of the stored data and tampered data cannot build. Transitions: build, submit, confirm, fail, late-confirm, cancel and expire each act once with idempotent exact retries and fail-closed different values; OPEN->SUBMITTED, terminal->OPEN, SUBMITTED->EXPIRED and FAILED->CONFIRMED without late are refused by the trigger; SUBMITTED is never cancelled or expired. Expiry at exactly now() and build_deadline at exactly now() refuse, now()+1 us works; a stale active intent is closed when its wallet creates a new one. Access: RLS on, anon/authenticated 42501 on every table operation and function, service_role reads and calls exactly the eight functions, cannot write directly, nobody deletes; SECURITY DEFINER with pinned search_path, no EXECUTE/format()/DELETE in any body. Concurrency: six races of 40 independent connections, each held in an open transaction at an advisory-lock barrier that is released only after the database reports 40 waiting backends with 40 distinct PIDs: one active intent per wallet, one row per idempotency key (no last write wins), one build, one transaction hash, one owner per transaction hash, idempotent confirmations, at most one cover id per intent and one intent per cover id in a mixed late/normal race. |
| EV-KB-PURCHASE-DB | known-bad | E4 | mutation | PARTIAL | yes | Each listed weakening of the active-intent index, idempotency key, build/submit/confirm/late conditions, once-set fields, transition trigger, immutable fields, privileges, delete guard, search_path, expiry boundary and runner observer (zero overlap accepted, serial statements of one connection credited) is detected by the intended test. |
| EV-PURCHASE-RECEIPT | behavioral | E3 | node-test | FULL | yes | Behaviourally, against the read-only verifier with two offline readers. Positive: a SYNTHETIC receipt constructed from the verified ABI (event topics and view selectors recomputed from the source signatures, real pinned runtimes for Broker, Cover proxy and implementation) verifies with every one of 21 checks passed; amount equal to or above the intent and a zero refund are accepted. Negative, each with its own status: missing / pending / reverted transaction, receipt not belonging to the transaction, wrong chain (node and transaction), sender, Broker target, value, calldata hash (incl. an otherwise valid swapped input), selector and non-canonical encoding, decoder policy for owner / product / amount / period / maxPremium / commission / proof-of-loss / coverId, CoverBought missing / foreign emitter / duplicate / wrong product / member / originalCoverId, NFT mint missing / foreign / not a mint / other recipient / other token id, Cover state product / asset / amount below intent / period / start / not original / ownerOf / metadata, third-party USDC payout, Broker / proxy / implementation code and implementation slot drift at the receipt block, too few confirmations (incl. the lower head of two readers), not finalized, zero confirmations refused, block hash differing from the block at that number. Reader B disagreeing on transaction, receipt, logs, block, storage, code, state or chain fails closed in both directions; both readers see the same reads; one reader passed twice is refused; a failure of either reader on any method is TEMPORARY_RPC_FAILURE. Client receipt / logs / cover id / block / from / to / data / value / status are refused and never read. Deterministic over repeated runs. Real mainnet receipt of block 26219867 (two-provider capture, replayed offline): structural relationship of transaction, receipt, block, CoverBought(5645, 5645, 9301, 97), NFT mint, USDC flows and Cover state; the verifier rejects it for exactly commission ratio, commission destination and proof-of-loss CID (never verified). No send, sign, wallet, network, DB or environment code; only eight read methods; no runtime importer; no builder import. |
| EV-KB-PURCHASE-RECEIPT | known-bad | E4 | mutation | FULL | yes | Each listed weakening of the receipt verifier (client receipt trusted, one reader, disagreement ignored, status / sender / target / value / calldata hash / policy skipped, CoverBought and NFT checks, state amount / period / metadata, proxy implementation, implementation and Broker code hash, zero confirmations, block hash, reader failure as failed transaction, builder import, runtime route import) and of the decoder policy it relies on (product, owner, amount, period, commission, proof-of-loss CID) is detected by the intended test. |
| EV-PURCHASE-PRE-SEND | behavioral | E3 | node-test | PARTIAL | yes | Behaviourally, against the read-only pre-send verifier with two offline readers that answer only for the agreed block hash. Positive: the REAL chain state of block 26230166 (two-provider capture, pinned runtimes of Broker, Cover proxy and implementation, USDC proxy and implementation, both implementation slots) with a SYNTHETIC BUILT intent gives PRE_SEND_VERIFIED with all 17 checks passed, the observed pins and a non-authoritative allowance observation; deterministic over repeated runs. Negative, each with its own status: every status other than BUILT, expires_at and build_deadline at and after the exclusive bound, an inconsistent build window, the persisted intent hash not equal to the P4A recomputation, malformed intent or calldata hash, missing proof-of-loss CID, client-shaped fields (intent hash, calldata hash, status, deadline, to, data, value, spender, ABI, selector, transaction) refused and never read, wrong chain, the same reader twice, disagreement on chain id, block hash, block timestamp, missing block, head skew, code and storage in both directions, reader failure on every method from either side (TEMPORARY_RPC_FAILURE), malformed head, stale or future block, every code/storage/call read bound to the agreed block hash and only the pinned addresses and slots read, Broker / Cover proxy / Cover implementation slot (including EIP-1967 and garbage upper bytes) / Cover implementation runtime drift, USDC proxy runtime / implementation address (including empty, EIP-1967) / implementation runtime drift, an unresolved USDC pin. USDC source: proxy and implementation fixtures hash to the pins, the deployed proxy carries the zeppelinos implementation and admin slots and no EIP-1967 slot, our recompilations differ from the deployed runtimes only in the 32-byte metadata hash, the shipped Circle sources hash to the compiled metadata, and the pinned approve overwrites the allowance with the exact value, returns true and has no zero-first requirement; the deployed implementation dispatches approve and allowance. TOCTOU residual stated, never claimed eliminated. No send, sign, wallet, network, DB or environment code; six read methods; no runtime importer. |
| EV-KB-PURCHASE-PRE-SEND | known-bad | E4 | mutation | PARTIAL | yes | Each listed weakening of the pre-send verifier (one reader, same reader twice, disagreement ignored, wrong chain, OPEN status, expiry and build deadline ignored, intent hash not recomputed, reads at latest instead of the agreed block, block hash disagreement, stale block, head skew, Broker / Cover proxy / implementation address / implementation code checks dropped, EIP-1967 slot instead of govblocks, USDC proxy / implementation address / implementation code checks dropped, USDC EIP-1967 slot, a USDC pin hash that is not the deployed code, unresolved USDC pin accepted, reader failure papered over, client fields accepted, send method, DB write, route import, TOCTOU described as eliminated) is detected by the intended test. |
| EV-PURCHASE-CONFIRMATION | behavioral | E3 | node-test | PARTIAL | yes | Behaviourally, with the REAL P4E verifier (never a mock) over two offline readers of a CONSTRUCTED purchase (test-support/purchase-receipt-world.mjs: verified ABI, pinned runtimes; head +100, finalized +10, so the production policy holds without a shortcut). Positive: a SUBMITTED record whose persisted tx_hash and calldata_hash match the chain gives exactly one markConfirmed({ id, persisted txHash, verifier coverId }) and CONFIRMED; the cover id follows the chain (7001 / 7002), the tx hash follows the record. Finality: exactly 64 confirmations and finalized confirms, 63 or not finalized do not; the policy object is the P4E production policy and cannot be passed in. Negative, each with zero writes and the row still SUBMITTED: caller txHash, wallet, calldataHash, coverId, receipt, logs, from, to, data, value, status, blockHash, blockNumber, verdict, result, verification, intent, record, now, policy fields (refused before any load or chain read); a repository with any extra method (query, update, from, rpc, executeSql, markFailed, markLateConfirmed) or a record with extra facts; a record of another id, another intent id, a wrong intent hash, an invalid intent, no proof-of-loss CID; OPEN, BUILT, FAILED, EXPIRED, CANCELLED, unknown status, late CONFIRMED, SUBMITTED with a cover id; missing or malformed persisted tx_hash or calldata_hash (no chain read); TEMPORARY_RPC_FAILURE (on every read method), RPC_DISAGREEMENT, INSUFFICIENT_CONFIRMATIONS, TX_NOT_FOUND, RECEIPT_NOT_FOUND, BLOCK_HASH_MISMATCH (retryable); TX_FAILED, WRONG_SENDER, RECEIPT_MISMATCH, CALLDATA_HASH_MISMATCH, CALLDATA_POLICY_MISMATCH, COVERBOUGHT_MISSING, POL_METADATA_MISMATCH, PROXY_DRIFT_AT_EXECUTION, WRONG_CHAIN, the same reader twice (not verified); cross-intent substitution (another wallet, the same calldata hash, a swapped record, a cover id already confirmed elsewhere); every unexpected DB answer (DB_CONFIRMATION_CONFLICT) or a DB exception (DB_UNAVAILABLE); a reorg after an earlier VERIFIED result (fresh verification each attempt). The gate rejects forged verdicts (ok false with VERIFIED, ok true with another status, errors, any required check not passed, non-positive or non-bigint cover id, missing block). An exact existing confirmation is accepted; an exact CONFIRMED row is reported without chain read or write. Static: no wallet, send, sign, builder, generic DB, FAILED, environment or cache surface; one verifier call, one write; no runtime importer, route or cron. The builder stays OFFLINE_ONLY, every output productionReady false, blockers and external controls separated, the former blockers documented. |
| EV-PURCHASE-CONFIRMATION-DB | behavioral | E3 | node-test | PARTIAL | yes | Against a disposable Postgres with all migrations (real P4D functions, real P4D uniqueness) and the REAL P4E verifier over the CONSTRUCTED purchase: a SUBMITTED row created through createIntent / markBuilt / markSubmitted is loaded, reconstructed to the stored intent hash, verified and confirmed exactly once (CONFIRMED, cover id 7001, same tx_hash, not late); a second attempt is ALREADY_CONFIRMED with the row byte-identical; TX_FAILED, insufficient confirmations and a transaction of another sender leave the second row byte-identical (status, cover_id, tx_hash, late, updated_at); a cover id already held by another intent fails at the P4D uniqueness as DB_CONFIRMATION_CONFLICT with the row unchanged; a tx_hash is held by one row only; the second row confirms with its own cover id. |
| EV-KB-PURCHASE-CONFIRMATION | known-bad | E4 | mutation | PARTIAL | yes | Each listed weakening of the orchestration (confirm without the verifier, ok false or a non-VERIFIED status accepted, a failed receipt check ignored, caller cover id / tx hash / calldata hash used, BUILT or FAILED admitted, one-reader retry after disagreement or reader failure, lowered confirmations, no finality, TX_NOT_FOUND written, persisted tx_hash or calldata_hash binding dropped, a cached verdict reused, the builder imported, a generic DB update, an API importer, a wallet send method, FAILED written on infrastructure failure, a foreign record accepted, a DB conflict treated as success, a late confirmation reported as exact, the intent hash not recomputed, extra record facts tolerated) and of the builder statement (production-ready output, wallet blocker dropped, wallet orchestration claimed satisfied) is detected by the intended test. |
| EV-PURCHASE-RUNTIME-LOADER | behavioral | E3 | node-test | PARTIAL | yes | Behaviourally, over the exact answer shape of the fixed read function: an exact BUILT row loads into the canonical P4A intent with the stored and recomputed intent hash, calldata hash, build times and expiry, frozen; NOT_FOUND; OPEN, SUBMITTED, CONFIRMED, FAILED, EXPIRED, CANCELLED and malformed statuses refused; tx_hash or cover_id set refused; a wrong, malformed or upper-case intent hash, changed amount or max premium (hash mismatch), missing, short or upper-case calldata hash, no proof-of-loss CID, another terms version, another row id, missing build times, a build window over 120 s, before built_at or after expires_at refused; extra or missing columns and malformed answers refused without repair; expires_at and build_deadline exclusive, no extension; every caller copy (wallet, txHash, calldataHash, intentHash, status, to, data, value, abi, selector, spender, amount, period, coverId, verifiedAtBlock, verifiedAtBlockHash, sessionHash, intent, purchase, deadlines) and malformed ids refused before any read; a repository with any extra method refused; a DB exception is DB_UNAVAILABLE; a loaded model is re-validated in full later (edits and the clock not trusted). Static: one import (purchase-intent), one repository call, no write, wallet, network, environment or clock; the P4D helper calls exactly the fixed function; only the session module and tests import the loader. |
| EV-PURCHASE-EXECUTION-SESSION | behavioral | E3 | node-test | PARTIAL | yes | Behaviourally, with the REAL P4F verifier over the REAL chain state of block 26230166 (two offline readers, test-support/purchase-pre-send-world.mjs), the REAL P4C decoder and a SYNTHETIC intent: a BUILT intent loaded through the fixed loader, a PRE_SEND_VERIFIED verdict and the exact buyCover bytes (keccak256 equal to the persisted calldata hash) or the exact USDC approval (Broker, maxPremium) give one frozen session with the bound fields, verifiedAtBlock / block hash of the replayed block, expiry now + 30 s, singleUse true, MODEL_ONLY_NOT_PERSISTED, the TOCTOU statement and no key, signature, provider or wallet client; only P4F read methods are used. Refused: forged or incomplete verdicts (ok false, other status, ok true with RPC_DISAGREEMENT, errors, a missing check, missing / zero / non-bigint block, missing / short / upper-case block hash, missing or wrong pins) and real P4F rejections (RPC_DISAGREEMENT, broker drift, temporary reader failure, wrong chain); other bytes than built (CALLDATA_HASH_MISMATCH), bytes that match the stored hash but not the intent (owner), other target, value, chain or kind, builder metadata (calldataHash, productionReady, blockers), gas or from, wrong spender, amount, unlimited approval, appended bytes; no window at or after build_deadline or expires_at; every caller copy at the boundary (refused before any load or chain read) and in the pure step; edited purchase models. The hash equals an independent ABI re-encoding and changes with every bound field; expiry tampering, consumed and expired sessions are not usable. Static: no wallet, send, sign, builder, encoding, network, environment, clock, randomness or JSON surface, one P4F call, one decode per kind; no runtime importer, route or cron. The builder statement lists RUNTIME_LOADER and EXECUTION_SESSION_BINDING as SATISFIED_BY_P4H, keeps WALLET_ORCHESTRATION, TERMS, PROOF_OF_LOSS unresolved and every output productionReady false. |
| EV-PURCHASE-LOADER-DB | behavioral | E3 | node-test | PARTIAL | yes | Against a disposable Postgres with all migrations: an intent created and built through the real P4D functions is read by get_cover_purchase_intent_for_execution and loaded exactly (P4A intent equal, stored intent hash equal to the recomputation, calldata hash, BUILT, no tx_hash, no cover_id, built_at rounded up and build_deadline down); the answer carries only the fixed columns; OPEN, SUBMITTED and unknown ids are not loadable; anon, authenticated and PUBLIC have no EXECUTE (calls fail with 42501), service_role has; the function is SECURITY INVOKER, STABLE, search_path public, pg_temp, without dynamic SQL or writes, and no role gains INSERT, UPDATE, DELETE or TRUNCATE on the table. |
| EV-KB-PURCHASE-EXECUTION-SESSION | known-bad | E4 | mutation | PARTIAL | yes | Each listed weakening of the loader (OPEN or SUBMITTED accepted, stored intent hash trusted, malformed calldata hash, expiry or build deadline ignored, a deadline after the expiry accepted) and of the session (caller wallet, data or block used, PRE_SEND_VERIFIED not required, a disagreement verdict accepted, decoder skipped, builder metadata trusted, the hash omitting intent id, calldata hash, wallet, target, data, block, block hash or expiry, TTL over 30 s, expiry ignoring build_deadline, a wallet send method, a public API importer, a production-ready builder) is detected by the intended test (27 KILLED). One case is declared EQUIVALENT with proof (the session expiry ignoring expires_at is a redundant layer behind the loader's build-window check, itself KILLED). |
| EV-KB-PURCHASE-LOADER-DB | known-bad | E4 | mutation | PARTIAL | yes | Granting EXECUTE on the read function to anon or to authenticated is detected by P4H-DB-PRIVILEGES against the real database. |
| EV-PURCHASE-SESSION-DB | real-system | E5 | node-test | PARTIAL | yes | Disposable Postgres with every migration and emulated Supabase default privileges; the real helper src/purchase-execution-session-db.mjs over a supabase-js-shaped rpc adapter. Hash authority: the helper recomputes the P4H executionSessionHash (also for a genuine P4H session built with the real P4F verifier over block 26230166) and persists only that value; a changed block, block hash, target, data, wallet, expiry, intent hash, session id, intent id or kind with the old hash, a forged hash, extra or missing fields, unbound bytes, a window over 30 s, value, chain or block errors are refused before any call; in the database a stored hash belongs to one session. Creation: exact canonical columns only (no key, signature, receipt, RPC answer, IP, user agent or metadata column), created_at from the database clock, idempotent for identical fields, SESSION_ID_REUSED otherwise; refused for another intent hash, calldata hash or wallet, unknown, OPEN, SUBMITTED or CANCELLED intents, a window over 30 s or already expired, a target or selector not pinned for the kind, value, chain or block errors; one open session per intent, one consumed session per intent and kind. Consumption: one CONSUMED with the unchanged persisted facts, the same request id IDEMPOTENT_REPLAY with the identical record, any other ALREADY_CONSUMED; wrong hash or intent id SESSION_MISMATCH; refused for SUBMITTED, CONFIRMED, FAILED, CANCELLED and EXPIRED intents and at build_deadline or intent expiry (rows inserted past the create function), exactly at expires_at (now()+1 us works), after real expiry, and superseded sessions; an expired open session is superseded by the next and never consumable. Immutability: every fact refused by the trigger (also for the owner), expires_at never extended, consumed_at and the request id never cleared or changed, no delete or truncate (even the owner). Access: RLS on, anon, authenticated and service_role hold no table right (42501 on select, insert, update, delete), service_role executes exactly the two SECURITY DEFINER functions (pinned search_path, no dynamic SQL), helpers and trigger by nobody, PUBLIC nowhere. Concurrency: eight races of 40 independent connections (40 distinct backend PIDs) released from an advisory-lock barrier only after the database reports 40 waiting backends, each call its own transaction: one CONSUMED and 39 ALREADY_CONSUMED; one request retried 40 times: one CONSUMED, 39 identical IDEMPOTENT_REPLAY; mixed requests: only the winner's retries replay; 40 creates for one intent: one stored; 40 replacements of an expired session: one new, the old superseded; consume against creates: one consumed session per kind and no new open one; expiry races (one session, and forty sessions spread around their common expiry): never consumed at or after expires_at, at most one winner. Static: no wallet, send or sign method, no generic SQL, table or RPC path, exactly two fixed function calls; no runtime importer, route, rewrite or cron. |
| EV-KB-PURCHASE-SESSION | known-bad | E4 | mutation | PARTIAL | yes | Each listed weakening of the session store outside the database (the supplied hash persisted instead of the recomputed one, a wallet send method, a public API importer) and of the runner observer that grants E5 (serial statements of one connection credited, zero overlap with one busy connection accepted) is detected by the intended P4I test (5 KILLED). |
| EV-KB-PURCHASE-SESSION-DB | known-bad | E4 | mutation | PARTIAL | yes | Each listed weakening of the session table and functions (two open sessions per intent, session hash, intent id, intent hash or calldata hash unchecked, expired or already consumed sessions consumed, consumed_at cleared, expires_at extended, target, wallet, block or block hash mutable, intent status, SUBMITTED, CANCELLED, CONFIRMED, build deadline or both intent bounds ignored, idempotency key ignored or a different key answered with the record, a second consumption of a kind, anon or authenticated execute, direct UPDATE, a DELETE path) is detected by the intended test against the real database (26 KILLED). 3 cases are declared EQUIVALENT with proof (intent expiry, tx hash and cover id at consume are implied by status BUILT and now() < build_deadline through the intent table CHECKs); each has a separate KILLED case that removes the underlying protection. |
| EV-PURCHASE-ATTEMPT-DB | real-system | E5 | node-test | PARTIAL | yes | Disposable Postgres with every migration and emulated Supabase default privileges; real P4D intents and real P4I sessions (persisted and consumed through their helpers); the real helper src/purchase-execution-attempt-db.mjs over a supabase-js-shaped rpc adapter. Open: one AUTHORIZED attempt per consumed session, the same request (also with a fresh attempt id) gets it back, another request REQUEST_MISMATCH, unconsumed, unknown or expired sessions refused, attempt ids not reusable. Write-ahead: one WALLET_REQUEST_PERMITTED, every repeat ALREADY_STARTED, another request refused, refused after session expiry (the attempt stays AUTHORIZED) and for a cancelled intent. Rejection: only after the write-ahead, ABORTED_NO_TX / WALLET_REJECTED, the intent stays BUILT without tx hash, no restart, no later hash, no second session of the kind (P4I), a new intent of the same wallet may start. UNCERTAIN: no restart, no late rejection or wallet hash, the wallet stays busy (a new intent of the same wallet gets WALLET_BUSY), a chain-found hash binds. Tx hash: bound with attempt, session, intent, kind and wallet; same hash idempotent, another TX_HASH_CONFLICT (the first stays), a hash of another attempt TX_HASH_TAKEN, another request refused, caller fields refused before any call. Submit: only from TX_HASH_OBSERVED, only for the attempt intent, never with a caller hash, the intent becomes SUBMITTED with the bound hash, repeat EXISTING, a lost answer is read back by the same request. Approval: never submits (NOT_A_PURCHASE) or touches the intent, allowance below max_premium_raw refused, APPROVAL_VERIFIED / APPROVAL_FAILED settle once, a buyCover attempt needs the verified approval and a session verified from that block on, no approval after a consumed buyCover. Reconciliation: RECONCILED_NO_TX refused within the 30-minute quiet period, recorded with block and nonce after it (rows inserted by the owner with an old write-ahead), never after a bound hash. Crash windows C1-C6 end to end. Immutability: no backward transition, tx hash, kind, session, intent, wallet, request id, write-ahead time, abort reason and settle time fixed (also for the owner), no delete or truncate. Access: RLS on, no table right for anon, authenticated or service_role, exactly eight SECURITY DEFINER functions for service_role (pinned search_path, no dynamic SQL), helper and trigger for nobody; no new trigger on the P4D or P4I tables. Concurrency: six races of 40 independent connections (40 distinct backend PIDs) released from an advisory-lock barrier only after the database reports 40 waiting backends: one write-ahead winner of 40, one attempt of 40 opens, one bound hash of 40 different hashes, one of 40 attempts binds a shared hash, one recorded outcome of 40 conflicting wallet outcomes, one submission of 40. Pure protocol (always running): transitions identical to the trigger, outcome classification, recovery per state, purchase effect, nonce never authorization, replacement, SIWE binding and unalterable adapter request, chain transaction check, approval sequencing, crash windows, wallet models, guarantees. Static: no wallet, send, sign or permission method, no generic SQL, table or RPC path, exactly eight fixed function calls, no replaced P4D or P4I function; no runtime importer, route, rewrite or cron. |
| EV-KB-PURCHASE-ATTEMPT | known-bad | E4 | mutation | PARTIAL | yes | Each listed weakening of the pure protocol and its reach (rejection marks FAILED, timeout as no broadcast or as success, a caller hash trusted without the chain transaction, approval marks CONFIRMED, a wallet send method, a public API importer, an unchanged nonce taken as proof, adapter fields added, the SIWE wallet not compared) and of the runner observer that grants E5 (serial statements of one connection credited, zero overlap accepted) is detected by the intended test (12 KILLED). |
| EV-KB-PURCHASE-ATTEMPT-DB | known-bad | E4 | mutation | PARTIAL | yes | Each listed weakening of the attempt table and functions (two attempts per session, UNCERTAIN restartable, a hash bound elsewhere accepted, an approval submitting the purchase, submission for the caller intent, another request getting the attempt, a backward transition, the tx hash, kind, bindings or write-ahead time mutable, a direct UPDATE, UNCERTAIN terminal with the wallet free, the write-ahead won twice, no wallet-busy index, a wallet answer after UNCERTAIN, no quiet period, buyCover without verified approval or with a stale pre-send, an insufficient allowance verified, an approval after a consumed buyCover) is detected by the intended test against the real database (21 KILLED). |
| EV-AAVE-READINESS | behavioral | E3 | node-test | FULL | yes | Offline against the captured Nexus product/capacity responses: the three registry markets and their live-verified provider/pool pins; other chains, v2, v4, Horizon, fuzzy names and conflicting pools fail closed; only Core is MATCHED to product 97, Lido/Prime and EtherFi AMBIGUOUS, client product ids ignored; exposure exact in BigInt incl. 0.1+0.2-0.3 and 21-digit values, debt subtracted, floored at zero, floats and mismatched totals invalid; quotes bounded by exposure/capacity and 28..365 days; freshness strictly below 60 s; with every technical condition met the decision is BLOCKED by exactly the Terms/PoL and external blockers, every missing condition adds its own reason, unknown override fields are refused; external blockers agree with the CRSF record; cover details show BLOCKED with neutral reasons; ACTIVE_COVER only via a confirmed attribution of an unexpired product-97 cover of the same wallet; expiry days and the existing Telegram thresholds; the support matrix file equals the implementation; the execution loader refuses quote/capacity at 60 s inside the 120 s build window and every session ends at the older fetch time + 60 s. |
| EV-KB-AAVE-READINESS | known-bad | E4 | mutation | PARTIAL | yes | Each listed weakening of the Aave scope, mapping, exposure, readiness, cover status and 60 s execution bound is detected by its intended test: unsupported chain, v2 as v3, Horizon in the registry, fuzzy protocol name, wrong product, client product id, float exposure, ignored debt, negative exposure, stale capacity, stale quote, asset outside the allowlist, Terms/PoL blockers bypassed, unexpected PoL types, READY despite external blockers, a blocker marked resolved, foreign wallet, other chain, cover of another market, expired cover, covers of another wallet, stale quote or capacity in the execution loader, session outliving the freshness, freshness ignoring older capacity, readiness missing in the details. |

## 6. Mutation cases

666 cases in `security/mutation/cases.json`. Static-detection kills never count as E4.

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
| MUT-CR-VERIFY-004-P1-2WIGNOREONE | CR-VERIFY-004.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-004-P1-2WNOUSE | CR-VERIFY-004.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-004-P1-2WNOOVERLAP | CR-VERIFY-004.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-004-P1-2WNOTRUNOK | CR-VERIFY-004.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-004-P1-2WDECLARED | CR-VERIFY-004.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-004-P1-2WHARDCODED | CR-VERIFY-004.P1 | behavioral | KILLED |
| MUT-CR-VERIFY-003-P1-2WZ6OPEN | CR-VERIFY-003.P1 | behavioral | KILLED |
| MUT-CR-NEXUS-001-P1-NXRENAMED | CR-NEXUS-001.P1 | behavioral | KILLED |
| MUT-CR-NEXUS-001-P1-NXSIMILARNAME | CR-NEXUS-001.P1 | behavioral | KILLED |
| MUT-CR-NEXUS-001-P1-NXPRODTYPE | CR-NEXUS-001.P1 | behavioral | KILLED |
| MUT-CR-NEXUS-001-P2-NXWORDING | CR-NEXUS-001.P2 | behavioral | KILLED |
| MUT-CR-NEXUS-002-P1-NXCHAIN | CR-NEXUS-002.P1 | behavioral | KILLED |
| MUT-CR-NEXUS-002-P1-NXAAVEV2 | CR-NEXUS-002.P1 | behavioral | KILLED |
| MUT-CR-NEXUS-002-P2-NXPROTONAME | CR-NEXUS-002.P2 | behavioral | KILLED |
| MUT-CR-NEXUS-003-P1-NXMALFORMED | CR-NEXUS-003.P1 | behavioral | KILLED |
| MUT-CR-NEXUS-003-P2-NXFAKEHIGH | CR-NEXUS-003.P2 | behavioral | KILLED |
| MUT-CR-NEXUS-003-P3-NXREDIRECT | CR-NEXUS-003.P3 | behavioral | KILLED |
| MUT-CR-NEXUS-004-P1-NXMISSINGCAP | CR-NEXUS-004.P1 | behavioral | KILLED |
| MUT-CR-NEXUS-004-P1-NXTIMEOUT | CR-NEXUS-004.P1 | behavioral | KILLED |
| MUT-CR-NEXUS-004-P2-NXSTALE | CR-NEXUS-004.P2 | behavioral | KILLED |
| MUT-CR-NEXUS-005-P1-NXAMBIGUOUS | CR-NEXUS-005.P1 | behavioral | KILLED |
| MUT-CR-QUOTE-001-P1-QTCLIENTPID | CR-QUOTE-001.P1 | behavioral | KILLED |
| MUT-CR-QUOTE-002-P1-QTAMBIGUOUS | CR-QUOTE-002.P1 | behavioral | KILLED |
| MUT-CR-QUOTE-003-P1-QTASSET | CR-QUOTE-003.P1 | behavioral | KILLED |
| MUT-CR-QUOTE-003-P2-QTCAPACITY | CR-QUOTE-003.P2 | behavioral | KILLED |
| MUT-CR-QUOTE-003-P2-QTEXPOSURE | CR-QUOTE-003.P2 | behavioral | KILLED |
| MUT-CR-QUOTE-003-P3-QTSHORTPERIOD | CR-QUOTE-003.P3 | behavioral | KILLED |
| MUT-CR-QUOTE-003-P3-QTLONGPERIOD | CR-QUOTE-003.P3 | behavioral | KILLED |
| MUT-CR-QUOTE-004-P1-QTMALFORMED | CR-QUOTE-004.P1 | behavioral | KILLED |
| MUT-CR-QUOTE-004-P1-QTWRONGPRODUCT | CR-QUOTE-004.P1 | behavioral | KILLED |
| MUT-CR-QUOTE-004-P1-QTWRONGASSET | CR-QUOTE-004.P1 | behavioral | KILLED |
| MUT-CR-QUOTE-004-P2-QTREDIRECT | CR-QUOTE-004.P2 | behavioral | KILLED |
| MUT-CR-QUOTE-004-P2-QTANYHOST | CR-QUOTE-004.P2 | behavioral | KILLED |
| MUT-CR-QUOTE-005-P1-QTSTALE | CR-QUOTE-005.P1 | behavioral | KILLED |
| MUT-CR-QUOTE-006-P1-QTFALLBACK | CR-QUOTE-006.P1 | behavioral | KILLED |
| MUT-CR-QUOTE-007-P1-QTWALLET | CR-QUOTE-007.P1 | behavioral | KILLED |
| MUT-CR-QUOTE-007-P2-QTEXPOSEDATA | CR-QUOTE-007.P2 | behavioral | KILLED |
| MUT-CR-QUOTE-008-P1-QTGLOBALRATE | CR-QUOTE-008.P1 | behavioral | KILLED |
| MUT-CR-NEXUS-006-P1-2ZBROKERV34 | CR-NEXUS-006.P1, CR-NEXUS-006.P3 | behavioral | KILLED |
| MUT-CR-NEXUS-006-P1-2ZBROKERIMM | CR-NEXUS-006.P1 | behavioral | KILLED |
| MUT-CR-NEXUS-006-P2-2ZSWAP | CR-NEXUS-006.P2 | behavioral | KILLED |
| MUT-CR-NEXUS-006-P2-2ZCOVERV34 | CR-NEXUS-006.P2 | behavioral | KILLED |
| MUT-CR-PURCHASE-003-P1-P4AWALLET | CR-PURCHASE-003.P1 | behavioral | KILLED |
| MUT-CR-PURCHASE-003-P1-P4APRODUCT | CR-PURCHASE-003.P1 | behavioral | KILLED |
| MUT-CR-PURCHASE-003-P1-P4AAMOUNT | CR-PURCHASE-003.P1 | behavioral | KILLED |
| MUT-CR-PURCHASE-003-P1-P4APERIOD | CR-PURCHASE-003.P1 | behavioral | KILLED |
| MUT-CR-PURCHASE-003-P1-P4AMAXPREM | CR-PURCHASE-003.P1 | behavioral | KILLED |
| MUT-CR-PURCHASE-003-P1-P4ATERMS | CR-PURCHASE-003.P1 | behavioral | KILLED |
| MUT-CR-PURCHASE-003-P1-P4APOL | CR-PURCHASE-003.P1 | behavioral | KILLED |
| MUT-CR-PURCHASE-003-P1-P4AIMPL | CR-PURCHASE-003.P1 | behavioral | KILLED |
| MUT-CR-PURCHASE-003-P2-P4AEXTRA | CR-PURCHASE-003.P2 | behavioral | KILLED |
| MUT-CR-PURCHASE-003-P3-P4ANUMBER | CR-PURCHASE-003.P3 | behavioral | KILLED |
| MUT-CR-PURCHASE-003-P4-P4AFETCH | CR-PURCHASE-003.P4 | behavioral | KILLED |
| MUT-CR-PURCHASE-003-P4-P4AREACH | CR-PURCHASE-003.P4 | behavioral | KILLED |
| MUT-CR-COMMISSION-001-P1-P4ARATIO | CR-COMMISSION-001.P1 | behavioral | KILLED |
| MUT-CR-COMMISSION-001-P2-P4ADEST | CR-COMMISSION-001.P2 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P1-P4ASKIP | CR-PURCHASE-005.P1 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P2-P4ARESTART | CR-PURCHASE-005.P2 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P3-P4ALATE | CR-PURCHASE-005.P3 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P4-P4AEXPIRY | CR-PURCHASE-005.P4 | behavioral | KILLED |
| MUT-CR-ALLOC-001-P1-P4AEQUAL | CR-ALLOC-001.P1 | behavioral | KILLED |
| MUT-CR-ALLOC-001-P1-P4AUNDER | CR-ALLOC-001.P1 | behavioral | KILLED |
| MUT-CR-ALLOC-001-P2-P4ACAP | CR-ALLOC-001.P2 | behavioral | KILLED |
| MUT-CR-ALLOC-001-P3-P4ADUP | CR-ALLOC-001.P3 | behavioral | KILLED |
| MUT-CR-TERMS-001-P1-P4BWORDING | CR-TERMS-001.P1 | behavioral | KILLED |
| MUT-CR-TERMS-001-P1-P4BANNEX | CR-TERMS-001.P1 | behavioral | KILLED |
| MUT-CR-TERMS-001-P1-P4BWALLET | CR-TERMS-001.P1 | behavioral | KILLED |
| MUT-CR-TERMS-001-P1-P4BINTENT | CR-TERMS-001.P1 | behavioral | KILLED |
| MUT-CR-TERMS-001-P1-P4BPOS | CR-TERMS-001.P1 | behavioral | KILLED |
| MUT-CR-TERMS-001-P1-P4BCOUNTRY | CR-TERMS-001.P1 | behavioral | KILLED |
| MUT-CR-TERMS-001-P1-P4BMEMBER | CR-TERMS-001.P1 | behavioral | KILLED |
| MUT-CR-TERMS-001-P2-P4BVERSION | CR-TERMS-001.P2 | behavioral | KILLED |
| MUT-CR-TERMS-001-P3-P4BUNRESOLVED | CR-TERMS-001.P3 | behavioral | KILLED |
| MUT-CR-POL-001-P2-P4BCREATOR | CR-POL-001.P2 | behavioral | KILLED |
| MUT-CR-POL-001-P2-P4BADDRESS | CR-POL-001.P2 | behavioral | KILLED |
| MUT-CR-POL-001-P1-P4BSECOND | CR-POL-001.P1 | behavioral | KILLED |
| MUT-CR-POL-001-P3-P4BFREETEXT | CR-POL-001.P3 | behavioral | KILLED |
| MUT-CR-POL-001-P3-P4BEXTRA | CR-POL-001.P3 | behavioral | KILLED |
| MUT-CR-POL-001-P4-P4BFAKECID | CR-POL-001.P4 | behavioral | KILLED |
| MUT-CR-POL-001-P4-P4BPOST | CR-POL-001.P4 | behavioral | KILLED |
| MUT-CR-POL-001-P4-P4BEIP712 | CR-POL-001.P4 | behavioral | KILLED |
| MUT-CR-POL-001-P4-P4BREACH | CR-POL-001.P4 | behavioral | KILLED |
| MUT-CR-PURCHASE-001-P1-P4CBROKER | CR-PURCHASE-001.P1 | behavioral | KILLED |
| MUT-CR-PURCHASE-001-P3-P4CAPPROVETARGET | CR-PURCHASE-001.P3 | behavioral | KILLED |
| MUT-CR-APPROVAL-001-P2-P4CSPENDER | CR-APPROVAL-001.P2 | behavioral | KILLED |
| MUT-CR-APPROVAL-001-P3-P4CMAXUINT | CR-APPROVAL-001.P3 | behavioral | KILLED |
| MUT-CR-APPROVAL-001-P1-P4COVERAPPROVE | CR-APPROVAL-001.P1 | behavioral | KILLED |
| MUT-CR-PURCHASE-001-P2-P4CSELECTOR | CR-PURCHASE-001.P2 | behavioral | KILLED |
| MUT-CR-PURCHASE-002-P1-P4CCOVERID | CR-PURCHASE-002.P1 | behavioral | KILLED |
| MUT-CR-PURCHASE-002-P1-P4COWNER | CR-PURCHASE-002.P1 | behavioral | KILLED |
| MUT-CR-PURCHASE-002-P1-P4CPRODUCT | CR-PURCHASE-002.P1 | behavioral | KILLED |
| MUT-CR-PURCHASE-002-P1-P4CCOVERASSET | CR-PURCHASE-002.P1 | behavioral | KILLED |
| MUT-CR-PURCHASE-002-P1-P4CPAYASSET | CR-PURCHASE-002.P1 | behavioral | KILLED |
| MUT-CR-PURCHASE-002-P1-P4CAMOUNT | CR-PURCHASE-002.P1 | behavioral | KILLED |
| MUT-CR-PURCHASE-002-P1-P4CPERIOD | CR-PURCHASE-002.P1 | behavioral | KILLED |
| MUT-CR-PURCHASE-002-P1-P4CMAXPREMIUM | CR-PURCHASE-002.P1 | behavioral | KILLED |
| MUT-CR-PURCHASE-002-P1-P4CCOMMRATIO | CR-PURCHASE-002.P1 | behavioral | KILLED |
| MUT-CR-PURCHASE-002-P1-P4CCOMMDEST | CR-PURCHASE-002.P1 | behavioral | KILLED |
| MUT-CR-PURCHASE-002-P1-P4CEMPTYPOL | CR-PURCHASE-002.P1 | behavioral | KILLED |
| MUT-CR-PURCHASE-002-P1-P4CPOLCID | CR-PURCHASE-002.P1 | behavioral | KILLED |
| MUT-CR-PURCHASE-002-P1-P4CALLOC | CR-PURCHASE-002.P1 | behavioral | KILLED |
| MUT-CR-PURCHASE-002-P1-P4CSUMEQ | CR-PURCHASE-002.P1 | behavioral | KILLED |
| MUT-CR-PURCHASE-002-P2-P4CANYTO | CR-PURCHASE-002.P2 | behavioral | KILLED |
| MUT-CR-PURCHASE-002-P2-P4CANYDATA | CR-PURCHASE-002.P2 | behavioral | KILLED |
| MUT-CR-PURCHASE-002-P2-P4CGENERIC | CR-PURCHASE-002.P2 | behavioral | KILLED |
| MUT-CR-PURCHASE-002-P3-P4CDECOWNER | CR-PURCHASE-002.P3 | behavioral | KILLED |
| MUT-CR-PURCHASE-002-P3-P4CDECCOMM | CR-PURCHASE-002.P3 | behavioral | KILLED |
| MUT-CR-PURCHASE-002-P3-P4CDECTRUST | CR-PURCHASE-002.P3 | behavioral | KILLED |
| MUT-CR-PURCHASE-002-P4-P4CBOT | CR-PURCHASE-002.P4 | behavioral | KILLED |
| MUT-CR-PURCHASE-002-P4-P4CAPI | CR-PURCHASE-002.P4 | behavioral | KILLED |
| MUT-CR-PURCHASE-002-P4-P4CSEND | CR-PURCHASE-002.P4 | behavioral | KILLED |
| MUT-CR-PURCHASE-001-P2-P4CWRONGABI | CR-PURCHASE-001.P2 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P5-P4DNOACTIVEIDX | CR-PURCHASE-005.P5 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P5-P4DTWOACTIVE | CR-PURCHASE-005.P5 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P5-P4DNOREQKEY | CR-PURCHASE-005.P5 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P5-P4DKEYPAYLOAD | CR-PURCHASE-005.P5 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P6-P4DBUILDSTATUS | CR-PURCHASE-005.P6 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P6-P4DBUILDHASH | CR-PURCHASE-005.P6 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P10-P4DBUILDEXPIRY | CR-PURCHASE-005.P10 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P6-P4DCALLDATAOVERWRITE | CR-PURCHASE-005.P6 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P6-P4DTWOBUILDS | CR-PURCHASE-005.P6 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P7-P4DSUBMITSTATUS | CR-PURCHASE-005.P7 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P10-P4DSUBMITDEADLINE | CR-PURCHASE-005.P10 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P8-P4DNOTXUNIQUE | CR-PURCHASE-005.P8 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P7-P4DTXOVERWRITE | CR-PURCHASE-005.P7 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P9-P4DNOCOVERUNIQUE | CR-PURCHASE-005.P9 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P9-P4DCONFIRMTX | CR-PURCHASE-005.P9 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P11-P4DREOPEN | CR-PURCHASE-005.P11 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P10-P4DSUBMITTEDEXPIRES | CR-PURCHASE-005.P10 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P11-P4DLATEOTHERTX | CR-PURCHASE-005.P11 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P11-P4DLATEFLAG | CR-PURCHASE-005.P11 | behavioral | KILLED |
| MUT-CR-PURCHASE-003-P5-P4DAMOUNT | CR-PURCHASE-003.P5 | behavioral | KILLED |
| MUT-CR-PURCHASE-003-P5-P4DWALLET | CR-PURCHASE-003.P5 | behavioral | KILLED |
| MUT-CR-PURCHASE-003-P5-P4DTERMS | CR-PURCHASE-003.P5 | behavioral | KILLED |
| MUT-CR-PURCHASE-003-P5-P4DPOLCID | CR-PURCHASE-003.P5 | behavioral | KILLED |
| MUT-CR-PURCHASE-003-P5-P4DCOMMISSION | CR-PURCHASE-003.P5 | behavioral | KILLED |
| MUT-CR-PURCHASE-003-P5-P4DINTENTHASH | CR-PURCHASE-003.P5 | behavioral | KILLED |
| MUT-CR-PURCHASE-003-P6-P4DANONINSERT | CR-PURCHASE-003.P6 | behavioral | KILLED |
| MUT-CR-PURCHASE-003-P6-P4DAUTHUPDATE | CR-PURCHASE-003.P6 | behavioral | KILLED |
| MUT-CR-PURCHASE-003-P6-P4DDELETE | CR-PURCHASE-003.P6 | behavioral | KILLED |
| MUT-CR-PURCHASE-003-P6-P4DSEARCHPATH | CR-PURCHASE-003.P6 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P10-P4DOFFBYONE | CR-PURCHASE-005.P10 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P5-P4DOBSZERO | CR-PURCHASE-005.P5 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P5-P4DSERIALCONN | CR-PURCHASE-005.P5 | behavioral | KILLED |
| MUT-CR-PURCHASE-006-P7-P4ECLIENTRECEIPT | CR-PURCHASE-006.P7 | behavioral | KILLED |
| MUT-CR-PURCHASE-006-P6-P4EONERPC | CR-PURCHASE-006.P6 | behavioral | KILLED |
| MUT-CR-PURCHASE-006-P6-P4ENODISAGREE | CR-PURCHASE-006.P6 | behavioral | KILLED |
| MUT-CR-PURCHASE-006-P1-P4ENOSTATUS | CR-PURCHASE-006.P1 | behavioral | KILLED |
| MUT-CR-PURCHASE-006-P2-P4ENOSENDER | CR-PURCHASE-006.P2 | behavioral | KILLED |
| MUT-CR-PURCHASE-006-P2-P4ENOTARGET | CR-PURCHASE-006.P2 | behavioral | KILLED |
| MUT-CR-PURCHASE-006-P2-P4ENOVALUE | CR-PURCHASE-006.P2 | behavioral | KILLED |
| MUT-CR-PURCHASE-006-P2-P4ENOCALLDATAHASH | CR-PURCHASE-006.P2 | behavioral | KILLED |
| MUT-CR-PURCHASE-006-P2-P4ENOPOLICY | CR-PURCHASE-006.P2 | behavioral | KILLED |
| MUT-CR-PURCHASE-006-P2-P4EPOLPRODUCT | CR-PURCHASE-006.P2 | behavioral | KILLED |
| MUT-CR-PURCHASE-006-P2-P4EPOLOWNER | CR-PURCHASE-006.P2 | behavioral | KILLED |
| MUT-CR-PURCHASE-006-P2-P4EPOLAMOUNT | CR-PURCHASE-006.P2 | behavioral | KILLED |
| MUT-CR-PURCHASE-006-P2-P4EPOLPERIOD | CR-PURCHASE-006.P2 | behavioral | KILLED |
| MUT-CR-PURCHASE-006-P2-P4EPOLCOMMISSION | CR-PURCHASE-006.P2 | behavioral | KILLED |
| MUT-CR-PURCHASE-006-P2-P4EPOLCID | CR-PURCHASE-006.P2 | behavioral | KILLED |
| MUT-CR-PURCHASE-006-P3-P4ENOCOVERBOUGHT | CR-PURCHASE-006.P3 | behavioral | KILLED |
| MUT-CR-PURCHASE-006-P3-P4ECBPRODUCT | CR-PURCHASE-006.P3 | behavioral | KILLED |
| MUT-CR-PURCHASE-006-P3-P4ECBMEMBER | CR-PURCHASE-006.P3 | behavioral | KILLED |
| MUT-CR-PURCHASE-006-P3-P4ECBCOVERID | CR-PURCHASE-006.P3 | behavioral | KILLED |
| MUT-CR-PURCHASE-006-P3-P4ENOMINT | CR-PURCHASE-006.P3 | behavioral | KILLED |
| MUT-CR-PURCHASE-006-P3-P4EMINTOWNER | CR-PURCHASE-006.P3 | behavioral | KILLED |
| MUT-CR-PURCHASE-006-P4-P4ESTATEAMOUNT | CR-PURCHASE-006.P4 | behavioral | KILLED |
| MUT-CR-PURCHASE-006-P4-P4ESTATEPERIOD | CR-PURCHASE-006.P4 | behavioral | KILLED |
| MUT-CR-PURCHASE-006-P4-P4EMETADATA | CR-PURCHASE-006.P4 | behavioral | KILLED |
| MUT-CR-PURCHASE-007-P1-P4EPROXYIMPL | CR-PURCHASE-007.P1 | behavioral | KILLED |
| MUT-CR-PURCHASE-007-P2-P4EIMPLCODE | CR-PURCHASE-007.P2 | behavioral | KILLED |
| MUT-CR-PURCHASE-006-P5-P4EBROKERCODE | CR-PURCHASE-006.P5 | behavioral | KILLED |
| MUT-CR-PURCHASE-006-P6-P4EZEROCONF | CR-PURCHASE-006.P6 | behavioral | KILLED |
| MUT-CR-PURCHASE-006-P6-P4EBLOCKHASH | CR-PURCHASE-006.P6 | behavioral | KILLED |
| MUT-CR-PURCHASE-006-P6-P4ERPCFAILTX | CR-PURCHASE-006.P6 | behavioral | KILLED |
| MUT-CR-PURCHASE-006-P2-P4EBUILDERIMPORT | CR-PURCHASE-006.P2 | behavioral | KILLED |
| MUT-CR-PURCHASE-006-P7-P4EROUTEIMPORT | CR-PURCHASE-006.P7 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P1-P4FONERPC | CR-PURCHASE-008.P1 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P1-P4FSAMEREADER | CR-PURCHASE-008.P1 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P1-P4FDISAGREE | CR-PURCHASE-008.P1 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P1-P4FWRONGCHAIN | CR-PURCHASE-008.P1 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P1-P4FSTATUSOPEN | CR-PURCHASE-008.P1 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P1-P4FEXPIRY | CR-PURCHASE-008.P1 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P1-P4FDEADLINE | CR-PURCHASE-008.P1 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P1-P4FNOHASH | CR-PURCHASE-008.P1 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P1-P4FLATEST | CR-PURCHASE-008.P1 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P1-P4FBLOCKHASH | CR-PURCHASE-008.P1 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P1-P4FBROKER | CR-PURCHASE-008.P1 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P1-P4FPROXY | CR-PURCHASE-008.P1 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P1-P4FEIP1967 | CR-PURCHASE-008.P1 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P1-P4FIMPLADDR | CR-PURCHASE-008.P1 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P1-P4FIMPLCODE | CR-PURCHASE-008.P1 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P2-P4FUSDCPROXY | CR-PURCHASE-008.P2 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P2-P4FUSDCADDR | CR-PURCHASE-008.P2 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P2-P4FUSDCCODE | CR-PURCHASE-008.P2 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P2-P4FUNRESOLVED | CR-PURCHASE-008.P2 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P1-P4FRPCERROR | CR-PURCHASE-008.P1 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P1-P4FSENDMETHOD | CR-PURCHASE-008.P1 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P1-P4FDBWRITE | CR-PURCHASE-008.P1 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P1-P4FROUTEIMPORT | CR-PURCHASE-008.P1 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P1-P4FTOCTOU | CR-PURCHASE-008.P1 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P1-P4FSTALE | CR-PURCHASE-008.P1 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P1-P4FHEADSKEW | CR-PURCHASE-008.P1 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P1-P4FCLIENTFIELDS | CR-PURCHASE-008.P1 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P2-P4FUSDCSLOT | CR-PURCHASE-008.P2 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P2-P4FUSDCPINHASH | CR-PURCHASE-008.P2 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P4-P4GNOVERIFY | CR-PURCHASE-008.P4 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P4-P4GOKFALSE | CR-PURCHASE-008.P4 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P4-P4GNOTVERIFIEDSTATUS | CR-PURCHASE-008.P4 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P4-P4GCALLERCOVERID | CR-PURCHASE-008.P4 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P4-P4GCALLERTXHASH | CR-PURCHASE-008.P4 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P4-P4GCALLERCALLDATA | CR-PURCHASE-008.P4 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P4-P4GBUILT | CR-PURCHASE-008.P4 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P4-P4GFAILEDNORMAL | CR-PURCHASE-008.P4 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P4-P4GRPCDISAGREE | CR-PURCHASE-008.P4 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P4-P4GRPCTEMP | CR-PURCHASE-008.P4 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P4-P4GLOWCONF | CR-PURCHASE-008.P4 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P4-P4GNOFINAL | CR-PURCHASE-008.P4 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P4-P4GTXNOTFOUND | CR-PURCHASE-008.P4 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P4-P4GRECEIPTMISMATCH | CR-PURCHASE-008.P4 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P4-P4GNOTXBIND | CR-PURCHASE-008.P4 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P4-P4GNOCALLDATABIND | CR-PURCHASE-008.P4 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P4-P4GCACHE | CR-PURCHASE-008.P4 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P4-P4GBUILDER | CR-PURCHASE-008.P4 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P4-P4GGENERICDB | CR-PURCHASE-008.P4 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P4-P4GAPIIMPORT | CR-PURCHASE-008.P4 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P4-P4GWALLETSEND | CR-PURCHASE-008.P4 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P4-P4GMARKFAILED | CR-PURCHASE-008.P4 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P4-P4GCROSSINTENT | CR-PURCHASE-008.P4 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P4-P4GCONFLICTOK | CR-PURCHASE-008.P4 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P5-P4GP4CREADY | CR-PURCHASE-008.P5 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P5-P4GP4CBLOCKERS | CR-PURCHASE-008.P5 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P5-P4GP4CWALLETOK | CR-PURCHASE-008.P5 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P4-P4GLATEOK | CR-PURCHASE-008.P4 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P4-P4GNOINTENTHASH | CR-PURCHASE-008.P4 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P4-P4GNOTNARROWRECORD | CR-PURCHASE-008.P4 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P6-P4HOPEN | CR-PURCHASE-008.P6 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P6-P4HSUBMITTED | CR-PURCHASE-008.P6 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P6-P4HTRUSTHASH | CR-PURCHASE-008.P6 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P6-P4HCALLDATAFMT | CR-PURCHASE-008.P6 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P6-P4HNOEXPIRY | CR-PURCHASE-008.P6 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P6-P4HNODEADLINE | CR-PURCHASE-008.P6 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P6-P4HCALLERWALLET | CR-PURCHASE-008.P6 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P6-P4HCALLERDATA | CR-PURCHASE-008.P6 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P6-P4HCALLERBLOCK | CR-PURCHASE-008.P6 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P6-P4HNOPRESEND | CR-PURCHASE-008.P6 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P6-P4HDISAGREE | CR-PURCHASE-008.P6 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P6-P4HNODECODE | CR-PURCHASE-008.P6 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P6-P4HTRUSTBUILDER | CR-PURCHASE-008.P6 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P6-P4HHASHINTENT | CR-PURCHASE-008.P6 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P6-P4HHASHCALLDATA | CR-PURCHASE-008.P6 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P6-P4HHASHWALLET | CR-PURCHASE-008.P6 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P6-P4HHASHTARGET | CR-PURCHASE-008.P6 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P6-P4HHASHDATA | CR-PURCHASE-008.P6 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P6-P4HHASHBLOCK | CR-PURCHASE-008.P6 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P6-P4HHASHBLOCKHASH | CR-PURCHASE-008.P6 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P6-P4HHASHEXPIRY | CR-PURCHASE-008.P6 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P6-P4HTTL60 | CR-PURCHASE-008.P6 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P6-P4HTTLDEADLINE | CR-PURCHASE-008.P6 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P6-P4HTTLEXPIRYEQ1 | CR-PURCHASE-008.P6 | behavioral | EQUIVALENT |
| MUT-CR-PURCHASE-008-P6-P4HDEADLINEAFTEREXPIRY | CR-PURCHASE-008.P6 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P6-P4HWALLETSEND | CR-PURCHASE-008.P6 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P6-P4HAPIIMPORT | CR-PURCHASE-008.P6 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P6-P4HREADY | CR-PURCHASE-008.P6 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P6-P4HANONEXEC | CR-PURCHASE-008.P6 | behavioral | KILLED |
| MUT-CR-PURCHASE-008-P6-P4HAUTHEXEC | CR-PURCHASE-008.P6 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P12-P4ITWOOPEN | CR-PURCHASE-005.P12 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P12-P4INOSESSIONHASH | CR-PURCHASE-005.P12 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P12-P4INOINTENTID | CR-PURCHASE-005.P12 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P12-P4INOINTENTHASH | CR-PURCHASE-005.P12 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P12-P4INOCALLDATAHASH | CR-PURCHASE-005.P12 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P12-P4IEXPIREDCONSUME | CR-PURCHASE-005.P12 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P12-P4ICONSUMEDAGAIN | CR-PURCHASE-005.P12 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P12-P4ICLEARCONSUMED | CR-PURCHASE-005.P12 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P12-P4IEXTENDEXPIRY | CR-PURCHASE-005.P12 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P12-P4ITARGETMUTABLE | CR-PURCHASE-005.P12 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P12-P4IWALLETMUTABLE | CR-PURCHASE-005.P12 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P12-P4IBLOCKMUTABLE | CR-PURCHASE-005.P12 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P12-P4IBLOCKHASHMUTABLE | CR-PURCHASE-005.P12 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P12-P4INOINTENTSTATUS | CR-PURCHASE-005.P12 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P12-P4ISUBMITTEDCONSUME | CR-PURCHASE-005.P12 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P12-P4ICANCELLEDCONSUME | CR-PURCHASE-005.P12 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P12-P4INODEADLINE | CR-PURCHASE-005.P12 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P12-P4INOINTENTEXPIRYEQ1 | CR-PURCHASE-005.P12 | behavioral | EQUIVALENT |
| MUT-CR-PURCHASE-005-P12-P4IINTENTWINDOW | CR-PURCHASE-005.P12 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P12-P4INOTXHASHEQ1 | CR-PURCHASE-005.P12 | behavioral | EQUIVALENT |
| MUT-CR-PURCHASE-005-P12-P4INOCOVERIDEQ1 | CR-PURCHASE-005.P12 | behavioral | EQUIVALENT |
| MUT-CR-PURCHASE-005-P12-P4ICONFIRMEDCONSUME | CR-PURCHASE-005.P12 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P12-P4IIGNOREREQKEY | CR-PURCHASE-005.P12 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P12-P4IDIFFKEYSUCCESS | CR-PURCHASE-005.P12 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P12-P4IKINDTWICE | CR-PURCHASE-005.P12 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P12-P4IANONEXEC | CR-PURCHASE-005.P12 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P12-P4IAUTHEXEC | CR-PURCHASE-005.P12 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P12-P4IDIRECTUPDATE | CR-PURCHASE-005.P12 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P12-P4IDELETEPATH | CR-PURCHASE-005.P12 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P12-P4ISERIALCONN | CR-PURCHASE-005.P12 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P12-P4IZEROOVERLAP | CR-PURCHASE-005.P12 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P12-P4ITRUSTHASH | CR-PURCHASE-005.P12 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P12-P4IWALLETSEND | CR-PURCHASE-005.P12 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P12-P4IAPIIMPORT | CR-PURCHASE-005.P12 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P13-P4JTWOATTEMPTS | CR-PURCHASE-005.P13 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P13-P4JUNCERTAINRETRY | CR-PURCHASE-005.P13 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P13-P4JREJECTFAILED | CR-PURCHASE-005.P13 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P13-P4JTIMEOUTNOTX | CR-PURCHASE-005.P13 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P13-P4JTIMEOUTSUCCESS | CR-PURCHASE-005.P13 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P13-P4JTRUSTCALLERHASH | CR-PURCHASE-005.P13 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P13-P4JCROSSINTENT | CR-PURCHASE-005.P13 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P13-P4JAPPROVALSUBMITS | CR-PURCHASE-005.P13 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P13-P4JAPPROVALCONFIRMS | CR-PURCHASE-005.P13 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P13-P4JBUYUNBOUND | CR-PURCHASE-005.P13 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P13-P4JDIFFREQUEST | CR-PURCHASE-005.P13 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P13-P4JBACKWARDS | CR-PURCHASE-005.P13 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P13-P4JCLEARTXHASH | CR-PURCHASE-005.P13 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P13-P4JKINDMUTABLE | CR-PURCHASE-005.P13 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P13-P4JSESSIONMUTABLE | CR-PURCHASE-005.P13 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P13-P4JGENERICUPDATE | CR-PURCHASE-005.P13 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P13-P4JWALLETMETHOD | CR-PURCHASE-005.P13 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P13-P4JAPIIMPORT | CR-PURCHASE-005.P13 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P13-P4JNONCEAUTH | CR-PURCHASE-005.P13 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P13-P4JUNCERTAINTERMINAL | CR-PURCHASE-005.P13 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P13-P4JSTARTTWICE | CR-PURCHASE-005.P13 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P13-P4JNOWALLETBUSY | CR-PURCHASE-005.P13 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P13-P4JUNCERTAINWALLETBIND | CR-PURCHASE-005.P13 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P13-P4JNOQUIET | CR-PURCHASE-005.P13 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P13-P4JAPPROVALUNVERIFIED | CR-PURCHASE-005.P13 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P13-P4JSTALEPRESEND | CR-PURCHASE-005.P13 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P13-P4JALLOWANCE | CR-PURCHASE-005.P13 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P13-P4JLATEAPPROVAL | CR-PURCHASE-005.P13 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P13-P4JADAPTERALTER | CR-PURCHASE-005.P13 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P13-P4JSIWEMISMATCH | CR-PURCHASE-005.P13 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P13-P4JSTARTEDMUTABLE | CR-PURCHASE-005.P13 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P13-P4JSERIALCONN | CR-PURCHASE-005.P13 | behavioral | KILLED |
| MUT-CR-PURCHASE-005-P13-P4JZEROOVERLAP | CR-PURCHASE-005.P13 | behavioral | KILLED |
| MUT-CR-NEXUS-007-P1-AVCHAIN | CR-NEXUS-007.P1 | behavioral | KILLED |
| MUT-CR-NEXUS-007-P1-AVV2ASV3 | CR-NEXUS-007.P1 | behavioral | KILLED |
| MUT-CR-NEXUS-007-P1-AVHORIZON | CR-NEXUS-007.P1 | behavioral | KILLED |
| MUT-CR-NEXUS-007-P1-AVFUZZY | CR-NEXUS-007.P1 | behavioral | KILLED |
| MUT-CR-NEXUS-007-P2-AVWRONGPRODUCT | CR-NEXUS-007.P2 | behavioral | KILLED |
| MUT-CR-NEXUS-007-P2-AVCLIENTPID | CR-NEXUS-007.P2 | behavioral | KILLED |
| MUT-CR-NEXUS-007-P3-AVFLOAT | CR-NEXUS-007.P3 | behavioral | KILLED |
| MUT-CR-NEXUS-007-P3-AVNODEBT | CR-NEXUS-007.P3 | behavioral | KILLED |
| MUT-CR-NEXUS-007-P3-AVNEGATIVE | CR-NEXUS-007.P3 | behavioral | KILLED |
| MUT-CR-NEXUS-007-P4-AVSTALECAP | CR-NEXUS-007.P4 | behavioral | KILLED |
| MUT-CR-NEXUS-007-P4-AVSTALEQUOTE | CR-NEXUS-007.P4 | behavioral | KILLED |
| MUT-CR-NEXUS-007-P4-AVASSET | CR-NEXUS-007.P4 | behavioral | KILLED |
| MUT-CR-NEXUS-007-P4-AVTERMS | CR-NEXUS-007.P4 | behavioral | KILLED |
| MUT-CR-NEXUS-007-P4-AVPOL | CR-NEXUS-007.P4 | behavioral | KILLED |
| MUT-CR-NEXUS-007-P4-AVPOLTYPES | CR-NEXUS-007.P4 | behavioral | KILLED |
| MUT-CR-NEXUS-007-P4-AVREADYEXT | CR-NEXUS-007.P4 | behavioral | KILLED |
| MUT-CR-NEXUS-007-P4-AVEXTRESOLVED | CR-NEXUS-007.P4 | behavioral | KILLED |
| MUT-CR-NEXUS-007-P4-AVWALLET | CR-NEXUS-007.P4 | behavioral | KILLED |
| MUT-CR-NEXUS-007-P4-AVCHAINREASON | CR-NEXUS-007.P4 | behavioral | KILLED |
| MUT-CR-NEXUS-007-P5-AVFALSEMATCH | CR-NEXUS-007.P5 | behavioral | KILLED |
| MUT-CR-NEXUS-007-P5-AVEXPIRED | CR-NEXUS-007.P5 | behavioral | KILLED |
| MUT-CR-NEXUS-007-P5-AVCOVERWALLET | CR-NEXUS-007.P5 | behavioral | KILLED |
| MUT-CR-NEXUS-007-P6-AVLOADQUOTE | CR-NEXUS-007.P6 | behavioral | KILLED |
| MUT-CR-NEXUS-007-P6-AVLOADCAP | CR-NEXUS-007.P6 | behavioral | KILLED |
| MUT-CR-NEXUS-007-P6-AVSESSIONTTL | CR-NEXUS-007.P6 | behavioral | KILLED |
| MUT-CR-NEXUS-007-P6-AVFRESHQUOTEONLY | CR-NEXUS-007.P6 | behavioral | KILLED |
| MUT-CR-NEXUS-007-P4-AVDETAILS | CR-NEXUS-007.P4 | behavioral | KILLED |

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
| V2.1.3 | L2 | CR-RESOURCE-005, CR-QUOTE-008 | NON_CONFORMANT |
| V2.2.1 | L1 | CR-API-003, CR-NEXUS-001, CR-NEXUS-003, CR-QUOTE-001, CR-QUOTE-003, CR-QUOTE-004, CR-PURCHASE-003, CR-PURCHASE-002 | CONFORMANT |
| V2.2.2 | L1 | CR-API-003 | CONFORMANT |
| V2.2.3 | L2 | CR-INPUT-010, CR-NEXUS-001, CR-NEXUS-002, CR-QUOTE-002, CR-NEXUS-007, CR-PURCHASE-003, CR-ALLOC-001, CR-TERMS-001, CR-PURCHASE-001, CR-PURCHASE-002 | CONFORMANT |
| V2.3.1 | L1 | CR-API-009, CR-PURCHASE-005 | CONFORMANT |
| V2.3.2 | L2 | CR-CONC-002, CR-QUOTE-003, CR-QUOTE-005, CR-NEXUS-007, CR-COMMISSION-001, CR-ALLOC-001, CR-TERMS-002, CR-APPROVAL-001, CR-PURCHASE-006, CR-PURCHASE-007, CR-PURCHASE-008 | NOT_DEMONSTRATED |
| V2.3.3 | L2 | CR-CONC-001, CR-CONC-004 | CONFORMANT |
| V2.3.4 | L2 | CR-CONC-002, CR-CONC-003 | CONFORMANT |
| V2.3.5 | L3 | CR-API-010 | CONFORMANT |
| V2.4.1 | L2 | CR-RESOURCE-001, CR-RESOURCE-002, CR-RESOURCE-007, CR-QUOTE-008 | CONFORMANT |
| V3.2.1 | L1 | CR-BROWSER-006 | CONFORMANT |
| V3.2.2 | L1 | CR-BROWSER-004, CR-QUOTE-007 | CONFORMANT |
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
| V8.2.2 | L1 | CR-API-001, CR-QUOTE-002, CR-NEXUS-007 | CONFORMANT |
| V8.2.3 | L2 | CR-API-003 | CONFORMANT |
| V8.3.1 | L1 | CR-API-001, CR-QUOTE-001 | CONFORMANT |
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
| V14.2.3 | L2 | CR-PRIV-003, CR-POL-002 | NOT_DEMONSTRATED |
| V14.2.4 | L2 | CR-PRIV-006 | NOT_DEMONSTRATED |
| V14.2.6 | L3 | CR-API-007, CR-PRIV-001, CR-POL-001 | NOT_DEMONSTRATED |
| V14.2.7 | L3 | CR-PRIV-002, CR-POL-002 | NOT_DEMONSTRATED |
| V14.3.1 | L1 | CR-PRIV-008 | NOT_DEMONSTRATED |
| V14.3.2 | L2 | CR-PRIV-009 | NOT_DEMONSTRATED |
| V14.3.3 | L2 | CR-SESSION-005 | CONFORMANT |
| V15.1.1 | L1 | CR-SUPPLY-005 | NON_CONFORMANT |
| V15.1.2 | L2 | CR-SUPPLY-006, CR-NEXUS-006 | NOT_DEMONSTRATED |
| V15.1.3 | L2 | CR-RESOURCE-006 | NON_CONFORMANT |
| V15.2.1 | L1 | CR-SUPPLY-005 | NON_CONFORMANT |
| V15.2.2 | L2 | CR-RESOURCE-001, CR-RESOURCE-003, CR-RESOURCE-004, CR-RESOURCE-007, CR-DOC-003 | CONFORMANT |
| V15.2.3 | L2 | CR-CONFIG-008 | CONFORMANT |
| V15.3.1 | L1 | CR-API-007, CR-QUOTE-007 | NOT_DEMONSTRATED |
| V15.3.2 | L2 | CR-PROVIDER-003, CR-NEXUS-003, CR-QUOTE-004 | CONFORMANT |
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
| V16.5.2 | L2 | CR-RESOURCE-003, CR-PROVIDER-001, CR-PROVIDER-002, CR-NEXUS-004, CR-QUOTE-006 | NOT_DEMONSTRATED |
| V16.5.3 | L2 | CR-AUTH-005, CR-API-006, CR-PROVIDER-001, CR-NEXUS-002, CR-NEXUS-004, CR-NEXUS-005, CR-QUOTE-002, CR-QUOTE-005, CR-QUOTE-006, CR-NEXUS-007 | NOT_DEMONSTRATED |

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
| SRC-NEXUS-API | [Nexus Mutual public API v2: products, product-types, capacity](https://api.nexusmutual.io/v2/products/97) | v2 (responses of 2026-10-18) | unversioned API; pinned by captured responses in test/fixtures/nexus (sha256 product-97 8382d2eca21ade50ebfa4b33405bc45726a60c1c469d39c8932041645f11fb51, product-type-0 da46bb115687d0ee1e0e250d9d2ff238540d5663eb07c43b206232738b7e7f25, capacity-97 7391051f6d37c0d0b729470ba13acda8311a234c5bc3cf53b45ce4515c2fb44a) and by the identity constants in src/nexus-pinned.mjs |
| SRC-NEXUS-CONTRACTS | [NexusMutual/smart-contracts (Cover.sol cover period limits)](https://github.com/NexusMutual/smart-contracts/tree/v3.4.0) | v3.4.0 | git tag v3.4.0 = commit 67f531208b693f8edbc6ea46528f164046ed1f0b; Cover.sol MIN_COVER_PERIOD 28 days, MAX_COVER_PERIOD 365 days (Cover.sol byte-identical in v3.3.0, the deployed Cover implementation, see SRC-NEXUS-COVER); mainnet addresses from @nexusmutual/sdk 3.1.1 data/addresses.json (SDK not used, GPL-3.0 review open). This release is not the CoverBroker source: the deployed CoverBroker is v2.12.1, see SRC-NEXUS-COVERBROKER (F-2Z-1). Until 1.0-draft-phase2y this entry named only v3.4.0 next to all SDK addresses. |
| SRC-NEXUS-WORDING | [Single Protocol Cover wording (product type 0)](https://api.nexusmutual.io/ipfs/QmQQ88vaZkgEY9qXKPtq7Se6caSjB2RTqF1GAnBLW1k8EY) | IPFS QmQQ88vaZkgEY9qXKPtq7Se6caSjB2RTqF1GAnBLW1k8EY | content-addressed IPFS CID QmQQ88vaZkgEY9qXKPtq7Se6caSjB2RTqF1GAnBLW1k8EY; PDF sha256 9d831f51fc158b385d0daaa8aa4ae0294990a8e68f60aa8884611dc39e62003b |
| SRC-NEXUS-QUOTE | [Nexus Mutual public API v2: quote](https://api.nexusmutual.io/v2/quote) | v2 (responses of 2026-10-18) | unversioned API; pinned by captured responses in test/fixtures/nexus (sha256 quote-97-usdc-1000-30d 0c81004cedb1038ec4b2d2d0852a589f9ffefff94f04d92909c09d987b2cb92e, quote-97-eth-1-365d d7556163bfe7c856509a3fa49a972e96a5048c4627a09939cc32403b8a28d233); query parameters productId, amount, period (days), coverAsset, paymentAsset as used by @nexusmutual/sdk 3.1.1 Quote.getQuote (SDK not used); premium = total x annualPrice[bps] x days / (10000 x 365) observed for USDC/ETH/cbBTC; the API itself accepted period 27 and coverAsset DAI for product 97 on 2026-10-18 |
| SRC-NEXUS-COVERBROKER | [NexusMutual/smart-contracts CoverBroker as deployed at 0xCB2B736652D2dBf7d72e4dB880Cf6B7d99507814](https://github.com/NexusMutual/smart-contracts/blob/20082c81ec1a01e03cd7748c5bfc0396e74af93d/contracts/external/cover/CoverBroker.sol) | v2.12.1 | address 0xCB2B736652D2dBf7d72e4dB880Cf6B7d99507814 (not a proxy); source tag v2.12.1 = commit 20082c81ec1a01e03cd7748c5bfc0396e74af93d (byte-identical sources and runtime at v2.12.0 = 94e1764ec704215a37a60fba2af8290940def5b8; v2.12.1 is the release whose deployments/src/addresses.json introduced this address); solc 0.8.28+commit.7893614a, optimizer runs 200, evmVersion cancun, no libraries; deployed runtime keccak256 0xeb0e42231c9134305a54b102cea19fa29ec57f663a294a35c5bd870d81e9657c, 5245 bytes, metadata ipfs QmYTrtJnwoqumTd33yvNJrL1hb8RNgcCRWhrn9Pqy6ZCJK; match DECLARED_IMMUTABLES_ONLY: 220 differing bytes, all inside the compiler immutableReferences of cover, memberRoles, nxmToken, master, CBOR trailer identical; immutables = on-chain getters (cover 0xcafeac0f..., memberRoles 0x055CC48f..., nxmToken 0xd7c49CEE..., master 0x01BFd826...); creation: compiled creation code + constructor args found in tx 0x10f3551e896d2ffe1473e7a0a0c61191d9635f593e523b514c13f1359ecf9fd1 (block 22375780, 2025-04-29), CREATE2 address reproduced from factory 0xfac7011663910f75cbe1e25539ec2d7529f93c3f with salt 0x...27c9; independent recompilation 2026-10-18: GitHub sources at the commit (import closure) + @openzeppelin/contracts 4.7.3 (npm sha512 = package-lock), official soljson-v0.8.28+commit.7893614a.js (sha256 0x72ef580a6ec5943130028e5294313f24e9435520acc89f8c9dbfd0139d9ae146), optimizer enabled runs 200, settings of hardhat-config/solidity.js at the tag (ENABLE_OPTIMIZER); fixtures runtime-coverbroker-cb2b7366.hex 2b25db29d5c6362eb67a78dba67955e3bdc1d39ef473ea08e027dad351875827, contract-builds.json bca90ebe047e836acab959c967353613758731c58271bce6af827d29bb046ac3 |
| SRC-NEXUS-COVER | [NexusMutual/smart-contracts Cover implementation behind proxy 0xcafeac0fF5dA0A2777d915531bfA6B29d282Ee62](https://github.com/NexusMutual/smart-contracts/blob/070972503a471b6e14d01213aca4cf41e156c215/contracts/modules/cover/Cover.sol) | v3.3.0 | proxy 0xcafeac0fF5dA0A2777d915531bfA6B29d282Ee62 (OwnedUpgradeabilityProxy, implementation slot keccak256("org.govblocks.proxy.implementation")) -> implementation 0xcafeafF1a21418f530Feb00C6BAeF07523979C05 (deployed block 24476528, tx 0xb2e2418bde74537a62d68ff63c099ead01a963cc313f54c36d6375a7a6a550f6, 2026-02-17); source tag v3.3.0 = commit 070972503a471b6e14d01213aca4cf41e156c215; solc 0.8.28+commit.7893614a, optimizer runs 200, evmVersion prague; runtime keccak256 0x2ecdeb32b923da39e181ca3fd7f2aa543e7e35e3db146f79327993f3b796a530, 23948 bytes, metadata ipfs QmVvxQParTb5FBNEDYsP4Wjpwj7G5ZqjaRcxSTc5Wwudht; match DECLARED_IMMUTABLES_ONLY (964 bytes, all in immutableReferences; CBOR identical; address immutables equal on-chain getters); v3.4.0 differs only in metadata (IPool.sol); independent recompilation 2026-10-18: GitHub sources at the commit (import closure) + @openzeppelin/contracts 4.7.3 (npm sha512 = package-lock), official soljson-v0.8.28+commit.7893614a.js (sha256 0x72ef580a6ec5943130028e5294313f24e9435520acc89f8c9dbfd0139d9ae146), optimizer enabled runs 200, settings of hardhat-config/solidity.js at the tag (ENABLE_OPTIMIZER); fixtures runtime-cover-impl-cafeaff1.hex 23ca356ed7e3ecf83cb16f914d4afc489fa20c939f12f01228d8193205ecc9a9, contract-builds.json bca90ebe047e836acab959c967353613758731c58271bce6af827d29bb046ac3 |
| SRC-NEXUS-SDK | [@nexusmutual/sdk (cover metadata / proof-of-loss client code)](https://www.npmjs.com/package/@nexusmutual/sdk/v/3.1.1) | 3.1.1 | npm tarball nexusmutual-sdk-3.1.1.tgz sha512-1DKvkt1RO5dsJrROtGAG18ktRSLLyB9RWF3i+nF6wL8CyIRwLUj+RI3kd+2STc1XMHGocAQnwy23DiXm+bYuJQ== (sha256 06d59bcc3063d9a72dbbfbad94d40323c65c57cd77398ee740cbd27a83937c5f), dist/index.js sha256 b0235a26abe3fccb7d84a3d4ace3454457baed068fa0dff8c33055eab3bdc186; read: CoverMetadataInput { creatorAddress, proofOfLoss?: [{ type, content }], publicData? }, ProofOfLossEntry type address content [{ address, label? }], createCoverMetadata POST /cover-metadata (creatorAddress lowercased) -> { cid }, view/edit with x-auth-signature / x-auth-payload (EIP-712 domain "Nexus Mutual App" 1.0.0, Authentication { timestamp, message }), coverMetadataRef { version "1.0", coverMetadata: uuid } |
| SRC-NEXUS-POL-BLOG | [Upfront Proof of Loss (blog)](https://nexusmutual.io/blog/upfront-proof-of-loss) | retrieved 2026-10-19 | unversioned web page, not content-pinned; read 2026-10-19: covered wallet details entered in a private field at purchase, stored in an offchain database, visible and editable only by the wallet holder (sign-to-reveal) |
| SRC-NEXUS-BUYCOVER-TX | [CoverBroker product-97 purchase transaction (decode-only negative fixture)](https://etherscan.io/tx/0x1bec0316a5e23e34d1e81bd81aab8b38333d67e01b01382a112314823edae031) | block 26219867 | tx 0x1bec0316a5e23e34d1e81bd81aab8b38333d67e01b01382a112314823edae031, captured read-only once (eth_getTransactionByHash, publicnode); test/fixtures/nexus/buycover-tx-26219867.json keeps the signed fields and the test recomputes the transaction hash offline |
| SRC-USDC-MAINNET | [USDC on Ethereum mainnet (proxy and implementation pinned)](https://etherscan.io/address/0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48) | FiatTokenProxy -> FiatTokenV2_2 | proxy 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 (FiatTokenProxy = zeppelinos AdminUpgradeabilityProxy, runtime keccak256 0xd80d4b7c890cb9d6a4893e6b52bc34b56b25335cb13716e0d1d31383e6b41505, 2186 bytes; implementation slot keccak256("org.zeppelinos.proxy.implementation") = 0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3, EIP-1967 slots empty) -> implementation 0x43506849D7C04F9138D1A2050bbF3A0c054402dd (FiatTokenV2_2, runtime keccak256 0xcdfb7d322961af3acae7a8f7ee8b69c205b36f576cc5b077f170c7eb8ecbe3ea, 23464 bytes); read on 2026-10-20 from two providers (eth.drpc.org, mainnet.gateway.tenderly.co) at one block with identical results; test/fixtures/usdc/runtime-usdc-*.hex |
| SRC-NEXUS-BUYCOVER-RECEIPT | [Receipt and Cover/CoverNFT state of the CoverBroker product-97 purchase (negative structural fixture)](https://etherscan.io/tx/0x1bec0316a5e23e34d1e81bd81aab8b38333d67e01b01382a112314823edae031) | block 26219867 | tx 0x1bec0316a5e23e34d1e81bd81aab8b38333d67e01b01382a112314823edae031 in block 26219867 (hash 0xb72af12b1c4af58497cb4942ed6b0cb5295e33be73d739b76779a8bf50e417fa); captured read-only once on 2026-10-19 from two independent providers (eth.drpc.org, mainnet.gateway.tenderly.co) which returned identical values: transaction, receipt with 11 logs, block, implementation slot keccak256("org.govblocks.proxy.implementation") = 0xcafeafF1a21418f530Feb00C6BAeF07523979C05, code hashes of Broker / Cover proxy / implementation at the block (equal to the pins), getCoverData / getCoverReference / getCoverMetadata / ownerOf at the block for cover 5645; test/fixtures/nexus/buycover-receipt-26219867.json; Cover proxy runtime (863 bytes, keccak256 0xd772ae50e8c6515f53b17b60eb2bf13e0d40ec60cc3d2d5dd8d58d78afb8a1e0, identical to the Sourcify exact-match OwnedUpgradeabilityProxy of CoverProducts 0xcafead81) in test/fixtures/nexus/runtime-cover-proxy-cafeac0f.hex |
| SRC-USDC-FIATTOKEN-V2-2 | [stablecoin-evm FiatTokenV2_2 (USDC implementation source)](https://github.com/circlefin/stablecoin-evm/tree/v2.2.0) | v2.2.0 | tag v2.2.0 = commit 405efc100c016ed1a437063b6274b4e24ea7b8b1, contracts/v2/FiatTokenV2_2.sol with @openzeppelin/contracts 3.4.2 (npm, sha512 integrity of the v2.2.0 yarn.lock), official soljson v0.6.12+commit.27d51765 (sha256 0x3e1956c5... per binaries.soliditylang.org list.json), optimizer 10000000 runs, istanbul, SignatureChecker library linked at 0x800c32eaa2a6c93cf4cb51794450ed77fbfbb172; test/fixtures/usdc/usdc-builds.json, FiatTokenV2_2.sol, FiatTokenV1.sol, Pausable.sol |
| SRC-NEXUS-PRE-SEND-STATE | [Broker / Cover / USDC pins at one agreed block (pre-send capture)](https://etherscan.io/block/26230166) | block 26230166 | block 26230166 (hash 0xeff8e6a815e51fd8d4ed2b8cc7f65f64b7951b95920949ae7618392a872810f8) = min(head A, head B) of eth.drpc.org and mainnet.gateway.tenderly.co; code of Broker, Cover proxy and implementation, USDC proxy and implementation, the govblocks and zeppelinos implementation slots, the EIP-1967 slots (empty) and one allowance, each read by EIP-1898 block hash from both providers with identical results; test/fixtures/nexus/pre-send-state-26230166.json |

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
| `src/nexus*` | CR-DOC, CR-NEXUS, CR-PROVIDER, CR-QUOTE |
| `api/nexus/*` | CR-API, CR-PROVIDER, CR-QUOTE, CR-RESOURCE |
| `web/src/nexus-cover.js` | CR-BROWSER, CR-QUOTE |
| `src/positions/aave-v3.mjs` | CR-QUOTE |
| `src/positions/nexus-mapping.mjs` | CR-NEXUS |
| `src/positions/exposure.mjs` | CR-NEXUS |
| `src/positions/aave-registry.mjs` | CR-NEXUS |
| `scripts/nexus-live-probe.mjs` | CR-NEXUS, CR-PROVIDER, CR-QUOTE |
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
| `src/purchase-intent.mjs` | CR-ALLOC, CR-COMMISSION, CR-PURCHASE |
| `src/purchase-terms.mjs` | CR-TERMS |
| `src/purchase-proof-of-loss.mjs` | CR-POL |
| `src/purchase-tx-builder.mjs` | CR-APPROVAL, CR-PURCHASE |
| `src/purchase-tx-decode.mjs` | CR-APPROVAL, CR-PURCHASE |
| `src/purchase-intent-db.mjs` | CR-DB, CR-PURCHASE |
| `supabase/migrations/20261019120000_cover_purchase_intents.sql` | CR-CONC, CR-DB, CR-PURCHASE |
| `src/purchase-receipt.mjs` | CR-PURCHASE |
| `src/purchase-pre-send.mjs` | CR-PURCHASE |
| `src/purchase-confirmation.mjs` | CR-PURCHASE |
| `src/purchase-runtime-loader.mjs` | CR-PURCHASE |
| `src/purchase-execution-session.mjs` | CR-PURCHASE |
| `supabase/migrations/20261020120000_cover_purchase_intent_execution_read.sql` | CR-DB, CR-PURCHASE |
| `src/purchase-execution-session-db.mjs` | CR-DB, CR-PURCHASE |
| `supabase/migrations/20261020140000_cover_purchase_execution_sessions.sql` | CR-CONC, CR-DB, CR-PURCHASE |
| `src/purchase-execution-protocol.mjs` | CR-PURCHASE |
| `src/purchase-execution-attempt-db.mjs` | CR-DB, CR-PURCHASE |
| `supabase/migrations/20261020160000_cover_purchase_execution_attempts.sql` | CR-CONC, CR-DB, CR-PURCHASE |
| `src/aave-cover-readiness.mjs` | CR-NEXUS, CR-QUOTE, CR-PURCHASE |
| `docs/aave-v3-ethereum-support.json` | CR-NEXUS |

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
- **1.0-draft-phase2w** — Phase 2W: versioned meta-control derivation. CR-VERIFY-004 P1 is computed by the engine from the observed, runtime-verified coverage of every canonical concurrency property (rule OBSERVED_CONCURRENCY_COVERAGE) instead of requiring an evidence item of its own. Minimum level E5, type real-system, property text and derivation of CR-VERIFY-004 unchanged. Six KILLED rule mutations. No application change, no finding. Framework finding F-2W-1 (findings fixture Z6 needed an open release-blocking control; Low, fails closed) found once every release-blocking control was satisfied, recorded and fixed.
- **1.0-draft-phase2x** — Nexus P1+P2: read-only Nexus product/capacity/wording integration and deterministic position -> product mapping. New domain CR-NEXUS with five RELEASE_BLOCKING controls (E3), behavioural evidence and 14 KILLED known-bad mutations; three pinned sources; drift rules for the new files. No purchase flow, no transaction, no deployment; no finding.
- **1.0-draft-phase2y** — Nexus P3: user-facing cover details and live quote, display only (POST /api/nexus/quote, dashboard cover panel). New domain CR-QUOTE with eight RELEASE_BLOCKING controls (E3), behavioural evidence and 17 KILLED known-bad mutations; source SRC-NEXUS-QUOTE; drift rules. No purchase, approval, transaction, fee or proof-of-loss upload; no deployment; no finding.
- **1.0-draft-phase2za** — F-2Z-1 (framework/source integrity, Low): the CRSF source for the Nexus contracts named v3.4.0 for all SDK addresses, but the deployed CoverBroker is v2.12.1. Proven by independent recompilation; per-contract pins SRC-NEXUS-COVERBROKER (v2.12.1) and SRC-NEXUS-COVER (v3.3.0 implementation), control CR-NEXUS-006 (RELEASE_BLOCKING, E3) with behavioural evidence and 4 KILLED mutations. No runtime behaviour changed, no contract called, no deployment.
- **1.0-draft-phase2zb** — Nexus P4A: pure purchase-intent model (validation, canonical hash v1, transition model, allocation and commission rules) in src/purchase-intent.mjs, unreachable at runtime. Controls CR-PURCHASE-003, CR-PURCHASE-005, CR-COMMISSION-001, CR-ALLOC-001 (RELEASE_BLOCKING, E3) with behavioural evidence and 22 KILLED mutations. No endpoint, wallet method, calldata, network call, migration or deployment.
- **1.0-draft-phase2zc** — Nexus P4B: versioned purchase acknowledgement texts and terms hash (src/purchase-terms.mjs), local proof-of-loss payload preparation (src/purchase-proof-of-loss.mjs), both pure and unreachable at runtime. CR-TERMS-001 and CR-POL-001 (RELEASE_BLOCKING, E3) with behavioural evidence and 18 KILLED mutations; CR-TERMS-002 and CR-POL-002 (SECURITY_DEBT, MISSING_EVIDENCE) hold what only Nexus can confirm. Nothing transmitted, signed, uploaded or stored; no CID generated.
- **1.0-draft-phase2zd** — Nexus P4C: offline transaction builder (src/purchase-tx-builder.mjs: exact USDC approval, CoverBroker v2.12.1 buyCover) and independent decoder (src/purchase-tx-decode.mjs), both pure and unreachable at runtime; outputs are never production-ready. CR-PURCHASE-001, CR-PURCHASE-002, CR-APPROVAL-001 (RELEASE_BLOCKING, E3) with behavioural evidence, a real mainnet decode-only fixture and 30 KILLED mutations; CR-PURCHASE-006 (SECURITY_DEBT, MISSING_EVIDENCE) holds pre-send chain validation, USDC implementation pin, wallet execution and receipt verification. CR-TERMS-002 and CR-POL-002 unchanged.
- **1.0-draft-phase2ze** — Nexus P4D: local-only persistence of purchase intents (supabase/migrations/20261019120000_cover_purchase_intents.sql, not applied to any hosted database) with immutable critical fields, once-set build/transaction/cover facts, compare-and-set transitions in eight SECURITY DEFINER functions, one active intent per wallet, idempotency per (wallet, client request id), unique transaction hash and cover id, exclusive expiry bounds against the database clock and a late-confirmation path that reopens nothing; narrow server helper src/purchase-intent-db.mjs (no runtime importer). CR-PURCHASE-003 gains P5 (immutability) and P6 (server-only access); CR-PURCHASE-005 gains P5-P11 (P5-P9 and P11 concurrency claims, observed by the runner) and a clarified P2. New E5 evidence EV-PURCHASE-DB (real Postgres, 40 independent connections per race, barrier-proven overlap) and 32 KILLED mutations. No wallet call, no transaction execution, no route. CR-PURCHASE-006, CR-TERMS-002 and CR-POL-002 stay MISSING_EVIDENCE.
- **1.0-draft-phase2zf** — Nexus P4E: independent, read-only receipt verifier src/purchase-receipt.mjs (two injected chain readers that must agree, no majority; transaction, receipt, block, confirmations and finality, sender / Broker / value / calldata hash, independent P4C decoder policy, CoverBought, CoverNFT mint, Cover state, Broker / Cover proxy / implementation pins at the execution block; client data never authoritative; no send, sign, wallet, DB or route). CR-PURCHASE-006 reworded into receipt properties P1-P7 and raised to RELEASE_BLOCKING / E3; its former pre-send, USDC, wallet and confirmed-recording obligations move verbatim to the new CR-PURCHASE-008 (SECURITY_DEBT, MISSING_EVIDENCE); new CR-PURCHASE-007 (implementation drift at execution). Evidence E3 (synthetic positive receipt + real negative mainnet receipt, offline) and 32 KILLED mutations. CR-TERMS-002, CR-POL-002 and the USDC implementation pin stay open.
- **1.0-draft-phase2zg** — Nexus P4F: read-only pre-send verifier src/purchase-pre-send.mjs (server-loaded BUILT intent, P4D expiry and build-deadline bounds, P4A intent hash recomputed, calldata hash format; two independent readers, one agreed block by hash, every read bound to it by EIP-1898; Broker, Cover proxy, Cover implementation slot (govblocks, not EIP-1967) and runtime, USDC proxy, implementation slot (zeppelinos) and runtime; PRE_SEND_VERIFIED never READY_TO_SEND; TOCTOU residual documented, not eliminated; no send, sign, wallet, DB write or route) and the independent USDC pin (deployed code from two readers, own recompilation of Circle stablecoin-evm v2.2.0 FiatTokenV2_2 and of FiatTokenProxy, identical except the metadata hash; approve overwrite semantics). CR-PURCHASE-008 P1/P2 reworded and satisfied by E3 + 29 KILLED mutations (E4); P3 (wallet path, now also binding the verified block) and P4 (receipt before CONFIRMED) stay MISSING_EVIDENCE, so the control stays MISSING_EVIDENCE / SECURITY_DEBT. Test infrastructure: security:verify refuses (exit 3) a disposable Postgres below max_connections 600. CR-TERMS-002 and CR-POL-002 unchanged.
- **1.0-draft-phase2zh** — Nexus P4G: server-side receipt-to-confirmation orchestration src/purchase-confirmation.mjs (intent id only; injected repository with exactly loadIntentById and the P4D SUBMITTED -> CONFIRMED transition; persisted tx_hash and calldata_hash; fresh P4E verification with two readers and the fixed production policy, finalized and >= 64 confirmations; markConfirmed only for ok === true and VERIFIED_COVER_PURCHASE with the verifier's cover id; every other outcome leaves SUBMITTED unchanged, never FAILED; unexpected DB answers fail closed; no route, wallet, send, builder or cache). CR-PURCHASE-008 P4 reworded into the concrete orchestration obligation and satisfied by E3 (offline with the real verifier, and against the real P4D database) + E4 (30 KILLED mutations); new P5: the offline builder states OFFLINE_ONLY, never production-ready, external controls separated (src/purchase-tx-builder.mjs: USDC_IMPLEMENTATION_NOT_PINNED and NO_PRE_SEND_CHAIN_VALIDATION replaced by EXTERNAL_REQUIRED_CONTROLS and WALLET_ORCHESTRATION_UNRESOLVED, history kept in comments). P3 (wallet path) stays MISSING_EVIDENCE, so the control stays MISSING_EVIDENCE / SECURITY_DEBT. CR-TERMS-002 and CR-POL-002 unchanged.
- **1.0-draft-phase2zi** — Nexus P4H: server-only runtime loader src/purchase-runtime-loader.mjs over the fixed read function public.get_cover_purchase_intent_for_execution(uuid) (local migration supabase/migrations/20261020120000_cover_purchase_intent_execution_read.sql, SECURITY INVOKER, STABLE, pinned search_path, service_role only, not applied remotely) and the short-lived execution-session binding src/purchase-execution-session.mjs (P4F PRE_SEND_VERIFIED for exactly the loaded intent, independent P4C decoder, never builder output; intent id as the only client input; TTL min(now + 30 s, build_deadline, expires_at); fixed-ABI executionSessionHash, domain coverraccoon.execution-session v1; single use modelled, not persisted; TOCTOU residual stated). Nothing sends, signs or reaches a wallet; no route, cron or command. New CR-PURCHASE-008 P6 (the technical binding) satisfied by E3 (offline with real P4F and decoder, and against the real database) + E4 (29 KILLED, 1 EQUIVALENT with proof). P3 (wallet execution) stays MISSING_EVIDENCE, so the control stays MISSING_EVIDENCE / SECURITY_DEBT. CR-TERMS-002 and CR-POL-002 unchanged. The P4C builder lists RUNTIME_LOADER and EXECUTION_SESSION_BINDING as SATISFIED_BY_P4H; productionReady stays false.
- **1.0-draft-phase2zj** — Nexus P4I: the P4H execution session becomes a durable single-use capability in a local-only table public.cover_purchase_execution_sessions (supabase/migrations/20261020140000_cover_purchase_execution_sessions.sql, not applied to any hosted database): server-recomputed session hash, immutable facts, at most 30 s of the database clock and never past the intent bounds, one open session per intent (expired ones superseded atomically), one consumed session per intent and transaction kind, one compare-and-set consumption with expiry and intent state (BUILT, no tx hash, no cover id, matching hashes and wallet, before build_deadline and expiry) checked in SQL, idempotent replay only for the same consumer request id, no delete or truncate; two service_role SECURITY DEFINER functions, no table right for anyone; narrow helper src/purchase-execution-session-db.mjs (no runtime importer). CR-PURCHASE-005 gains P12 (concurrency claim, observed by the runner) with E5 evidence (eight races of 40 independent connections, barrier-proven overlap) and E4 (31 KILLED, 3 EQUIVALENT with proof and a KILLED companion each). Nothing sends, signs or reaches a wallet; no route, cron or command. CR-PURCHASE-008 P3 (wallet execution) stays unsatisfied, so CR-PURCHASE-008 stays MISSING_EVIDENCE / SECURITY_DEBT; CR-TERMS-002 and CR-POL-002 unchanged.
- **1.0-draft-phase2zk** — Nexus P4J: the wallet execution protocol after a consumed P4I session, without any wallet call: a local-only table public.cover_purchase_execution_attempts (supabase/migrations/20261020160000_cover_purchase_execution_attempts.sql, not applied to any hosted database) with eight states (AUTHORIZED, WALLET_REQUEST_STARTED, UNCERTAIN, ABORTED_NO_TX, TX_HASH_OBSERVED, SUBMITTED, APPROVAL_VERIFIED, APPROVAL_FAILED), forward-only, one attempt per consumed session, a write-ahead compare-and-set won once before any wallet request, explicit rejection separated from ambiguous provider results, chain reconciliation with a 30-minute quiet period, tx hash binding, one busy attempt per wallet, buyCover submission to P4D with the bound hash only, approval separated from the purchase; eight service_role SECURITY DEFINER functions, no table right for anyone, no new trigger and no replaced function on the P4D or P4I tables; narrow helper src/purchase-execution-attempt-db.mjs and pure model src/purchase-execution-protocol.mjs (no runtime importer). CR-PURCHASE-005 gains P13 (concurrency claim, observed by the runner) with E5 evidence (six races of 40 independent connections, barrier-proven overlap) and E4 (33 KILLED). Nothing sends, signs or reaches a wallet; no route, cron or command. CR-PURCHASE-008 P3 (reviewed wallet execution) stays unsatisfied, so CR-PURCHASE-008 stays MISSING_EVIDENCE / SECURITY_DEBT; CR-TERMS-002 and CR-POL-002 unchanged.
- **1.0-draft-phase2zl** — Aave v3 Ethereum as the first end-to-end protocol path (no transaction code): new pure module src/aave-cover-readiness.mjs (exact deployment classes SUPPORTED/UNSUPPORTED/AMBIGUOUS/DEPRECATED, Nexus mapping classes MATCHED/AMBIGUOUS/UNSUPPORTED, Terms/PoL readiness, one server-side purchase readiness decision with fixed, non-overridable external blockers CR-TERMS-002, CR-POL-002 and CR-PURCHASE-008/P3, cover status ACTIVE_COVER/NO_ACTIVE_COVER/UNKNOWN/UNSUPPORTED, support matrix docs/aave-v3-ethereum-support.json). The cover details show the readiness as BLOCKED with neutral reasons. 60 s / 120 s resolved: the unreachable execution loader refuses quote or capacity of 60 s or more and every execution session ends at the older fetch time + 60 s. New control CR-NEXUS-007 (P1-P6, E3 + E4 27 KILLED). Three mutation anchors re-targeted (one broken by the dashboard redesign c0ea347, two by the new session bound). CR-TERMS-002, CR-POL-002 and CR-PURCHASE-008 P3 unchanged (MISSING_EVIDENCE).

