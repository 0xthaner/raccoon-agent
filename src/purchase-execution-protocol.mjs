/*
	NEXUS P4J: PROTOKOLL DES WALLET-SCHRITTS UND SEINER FEHLERFAELLE (20.10.2026).

	Reines Modell, ohne I/O, ohne Wallet, ohne Provider: was ein spaeterer
	Wallet-Schritt nach dem Verbrauch einer P4I-Sitzung tun darf und was nicht.
	Durchgesetzt wird der dauerhafte Teil in
	supabase/migrations/20261020160000_cover_purchase_execution_attempts.sql
	(Helfer src/purchase-execution-attempt-db.mjs); dieses Modul ist die
	Entscheidungslogik, die der Wallet-Schritt dazu benutzen muss.

	  P4I Sitzung verbraucht (CAS)
	    -> Versuch AUTHORIZED (einer je Sitzung, nur die verbrauchende Anfrage)
	    -> Write-ahead WALLET_REQUEST_STARTED (CAS, genau ein Gewinner; NUR der
	       Gewinner darf die Wallet rufen, und erst nachdem der Schritt gespeichert ist)
	    -> Wallet-Ergebnis:
	         ausdrueckliche Ablehnung vor jedem tx_hash -> ABORTED_NO_TX
	         Timeout / Netzfehler / unbekannt            -> UNCERTAIN
	         tx_hash                                     -> TX_HASH_OBSERVED
	    -> buyCover: P4D SUBMITTED mit dem gebundenen Hash -> P4E Receipt -> P4G CONFIRMED
	       Freigabe: Allowance unabhaengig nachpruefen -> APPROVAL_VERIFIED, dann eine
	       NEUE buyCover-Sitzung mit frischer Vorpruefung (P4F) an einem spaeteren Block

	Kein "exactly once": die Datenbank garantiert hoechstens einen Verbrauch je
	Sitzung und hoechstens einen Wallet-Aufruf je Versuch, soweit der Schritt sich
	an das Write-ahead haelt. Ob die Wallet oder der Provider nach dem Start
	gesendet hat, entscheidet allein die Kette (tx_hash, Nonce, Receipt).

	Kein Kaufpfad: kein Senden, kein Signieren, keine Wallet, keine Route. Bis zu
	einer spaeteren Phase importiert nur test/ dieses Modul (P4J-IMPORT).
*/

export const ATTEMPT_STATES = Object.freeze([
	'AUTHORIZED', 'WALLET_REQUEST_STARTED', 'UNCERTAIN', 'ABORTED_NO_TX', 'TX_HASH_OBSERVED', 'SUBMITTED', 'APPROVAL_VERIFIED', 'APPROVAL_FAILED'
]);
export const TRANSACTION_KINDS = Object.freeze(['USDC_APPROVAL', 'NEXUS_BUY_COVER']);

/** Erlaubte Uebergaenge, wie der Trigger der Migration sie durchsetzt. Nur vorwaerts. */
export const TRANSITIONS = Object.freeze({
	AUTHORIZED: Object.freeze(['WALLET_REQUEST_STARTED']),
	WALLET_REQUEST_STARTED: Object.freeze(['UNCERTAIN', 'ABORTED_NO_TX', 'TX_HASH_OBSERVED']),
	UNCERTAIN: Object.freeze(['ABORTED_NO_TX', 'TX_HASH_OBSERVED']),
	ABORTED_NO_TX: Object.freeze([]),
	TX_HASH_OBSERVED: Object.freeze(['SUBMITTED', 'APPROVAL_VERIFIED', 'APPROVAL_FAILED']),
	SUBMITTED: Object.freeze([]),
	APPROVAL_VERIFIED: Object.freeze([]),
	APPROVAL_FAILED: Object.freeze([])
});

export const canTransition = (from, to) => Object.hasOwn(TRANSITIONS, from) && TRANSITIONS[from].includes(to);

/** Zustaende, in denen eine Transaktion existieren kann: die Wallet ist belegt, kein weiterer Wallet-Aufruf fuer sie (auch nicht ueber einen neuen Intent). */
export const HOLDING_STATES = Object.freeze(['WALLET_REQUEST_STARTED', 'UNCERTAIN', 'TX_HASH_OBSERVED']);

export const GUARANTEES = Object.freeze({
	dbAuthorization: 'AT_MOST_ONCE: one consumption per session (P4I compare-and-set), one attempt per consumed session (UNIQUE session_id)',
	walletInvocation: 'AT_MOST_ONCE_PER_ATTEMPT where enforceable: only the single winner of the AUTHORIZED -> WALLET_REQUEST_STARTED compare-and-set may call the wallet, and only after that write committed',
	chainTransaction: 'DETERMINED_BY_CHAIN: tx_hash, nonce and receipt decide what happened; the database cannot observe or prevent what a wallet or provider does after the request started',
	exactlyOnce: 'NOT_CLAIMED'
});

export const RESIDUAL_AMBIGUITY = Object.freeze([
	'A wallet or provider may broadcast and still answer with an error, a timeout or nothing; such a result is UNCERTAIN, never "no transaction".',
	'An explicit rejection (EIP-1193 4001) is taken as "no transaction" on the word of the wallet; a lying or compromised wallet can still have signed.',
	'A transaction signed but held back (for example a later nonce chosen by the wallet) can appear after any scan; RECONCILED_NO_TX after the quiet period is an operator decision with evidence, not a proof.',
	'A wallet may replace a transaction (same nonce, other hash). The first bound hash is never replaced; P4E reports TX_REPLACED and an operator reconciles.',
	'Compromised served frontend JavaScript can call the wallet API directly and present any request. Server-side controls constrain only the legitimate application path; the wallet confirmation stays the independent last control, and CSP, supply-chain and deployment integrity stay relevant. Misuse is not impossible.'
]);

/**
 * Wiederaufnahme je Zustand. Eine zweite verbrauchte Sitzung derselben Art fuer denselben Intent gibt es
 * nie (P4I); "neu" heisst daher immer: neue Sitzung einer ANDEREN Art (buyCover nach verifizierter
 * Freigabe) oder ein NEUER Intent, nachdem der alte geschlossen ist.
 */
const policy = (p) => Object.freeze({ retrySameAttempt: false, chainReconciliationRequired: false, newSessionAllowed: false, newIntentAllowed: false, terminal: false, purchaseStep: 'NONE', ...p });
export const RECOVERY_POLICY = Object.freeze({
	AUTHORIZED: policy({ retrySameAttempt: true, note: 'no wallet request was started (write-ahead absent); the same consumer request may start it before the session expires; after expiry the attempt is dead and the intent may be closed' }),
	WALLET_REQUEST_STARTED: policy({ chainReconciliationRequired: true, note: 'a request may be in flight or lost; never call the wallet again; after the request timeout treat as UNCERTAIN' }),
	UNCERTAIN: policy({ chainReconciliationRequired: true, note: 'unknown whether the wallet broadcast; search the chain for a matching transaction; bind it, or after the quiet period record RECONCILED_NO_TX with evidence' }),
	ABORTED_NO_TX: policy({ terminal: true, newIntentAllowed: true, note: 'no transaction on the record; the intent is not FAILED and not SUBMITTED; it may be cancelled and a new intent created' }),
	TX_HASH_OBSERVED: policy({ purchaseStep: 'BY_KIND', note: 'NEXUS_BUY_COVER: submit the bound hash to P4D; approval: verify the allowance independently; never a new authority' }),
	SUBMITTED: policy({ terminal: true, purchaseStep: 'RECEIPT', note: 'P4E receipt verification and P4G confirmation take over' }),
	APPROVAL_VERIFIED: policy({ terminal: true, newSessionAllowed: true, note: 'a fresh NEXUS_BUY_COVER session (new P4F pre-send at a block from the verification on) may be created' }),
	APPROVAL_FAILED: policy({ terminal: true, newIntentAllowed: true, note: 'approval did not take effect; close the intent, start again with a new one' })
});

export function recoveryFor(state) {
	if (!Object.hasOwn(RECOVERY_POLICY, state)) throw new TypeError('STATE');
	return RECOVERY_POLICY[state];
}

/** Was der Versuch fuer den Kauf-Intent bedeutet. Nur ein buyCover-Hash fuehrt zu P4D SUBMITTED; nie FAILED oder CONFIRMED von hier. */
export function purchaseEffect({ kind, state }) {
	if (!TRANSACTION_KINDS.includes(kind) || !ATTEMPT_STATES.includes(state)) throw new TypeError('ATTEMPT');
	if (kind === 'NEXUS_BUY_COVER' && state === 'TX_HASH_OBSERVED') return 'MARK_SUBMITTED';
	return 'NONE';
}

/* ------------------------------------------------------------ Wallet-Ergebnis -- */

const TX_HASH = /^0x[0-9a-f]{64}$/;
/** EIP-1193 userRejectedRequest. Nur dieser Code gilt als ausdrueckliche Ablehnung. */
export const EXPLICIT_REJECTION_CODE = 4001;

/**
 * Ordnet die normalisierte Antwort eines (spaeteren) Adapters ein. Nur zwei eindeutige Faelle:
 * ein wohlgeformter tx_hash, oder die ausdrueckliche Ablehnung 4001 ohne Hash. ALLES andere
 * (Timeout, Netzfehler, anderer Code, Safe-Vorschlag ohne Ketten-Hash, fehlende Antwort) ist UNCERTAIN.
 */
export function classifyWalletOutcome(result) {
	if (result && typeof result === 'object' && result.type === 'TX_HASH' && typeof result.txHash === 'string' && TX_HASH.test(result.txHash)) {
		return Object.freeze({ next: 'TX_HASH_OBSERVED', txHash: result.txHash, source: 'WALLET_RESPONSE' });
	}
	if (result && typeof result === 'object' && result.type === 'REJECTED' && result.code === EXPLICIT_REJECTION_CODE && result.txHash === undefined) {
		return Object.freeze({ next: 'ABORTED_NO_TX', reason: 'WALLET_REJECTED' });
	}
	return Object.freeze({ next: 'UNCERTAIN', reason: result && typeof result === 'object' && typeof result.type === 'string' ? result.type : 'NO_RESULT' });
}

/* --------------------------------------------------------- Abgleich, Nonce -- */

/** Blocktiefe, bis zu der ein Abgleich ohne Treffer gescannt sein muss. */
export const RECONCILIATION_FINALITY_BLOCKS = 64;
/** Ruhezeit seit dem Write-ahead, vor der RECONCILED_NO_TX moeglich ist (die Migration prueft dieselben 30 Minuten). */
export const RECONCILIATION_QUIET_SECONDS = 30 * 60;

/**
 * Entscheidung nach einem Ketten-Abgleich fuer WALLET_REQUEST_STARTED oder UNCERTAIN. `matches` sind
 * gemined gefundene Transaktionen, die verifyObservedTransaction gegen die Anfrage bestanden haben.
 * Die Nonce ist nur Nachweis: eine unveraenderte Nonce beweist nicht, dass nichts gesendet wurde
 * (Mempool, zurueckgehaltene Signatur), eine veraenderte nicht, dass es diese Transaktion war.
 */
export function reconciliationDecision({ matches, startedAtBlock, scannedToBlock, quietPeriodElapsed, walletNonceAtStart, walletNonceNow }) {
	if (!Array.isArray(matches) || typeof startedAtBlock !== 'bigint' || typeof scannedToBlock !== 'bigint' || typeof quietPeriodElapsed !== 'boolean') throw new TypeError('RECONCILIATION');
	void walletNonceAtStart; void walletNonceNow;
	if (matches.length === 1) return Object.freeze({ decision: 'BIND_TX', txHash: matches[0], source: 'CHAIN_RECONCILIATION' });
	if (matches.length > 1) return Object.freeze({ decision: 'OPERATOR_REQUIRED', reason: 'MULTIPLE_MATCHING_TRANSACTIONS' });
	if (quietPeriodElapsed && scannedToBlock >= startedAtBlock + BigInt(RECONCILIATION_FINALITY_BLOCKS)) return Object.freeze({ decision: 'RECORD_NO_TX', reason: 'NO_MATCH_AFTER_QUIET_PERIOD' });
	return Object.freeze({ decision: 'KEEP_UNCERTAIN', reason: 'NOT_ENOUGH_EVIDENCE' });
}

/** Ein zweiter, anderer Hash fuer denselben Versuch (Ersetzung, Beschleunigung, Abbruch in der Wallet) wird nie gebunden. */
export function classifyReplacement({ boundTxHash, observedTxHash }) {
	if (!TX_HASH.test(boundTxHash ?? '') || !TX_HASH.test(observedTxHash ?? '')) throw new TypeError('TX_HASH');
	if (boundTxHash === observedTxHash) return 'SAME_TRANSACTION';
	return 'REPLACEMENT_SUSPECTED_KEEP_FIRST_BINDING';
}

/* ------------------------------------------------- Anfrage, Wallet-Bindung -- */

const ADDRESS = /^0x[0-9a-f]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DATA = /^0x(?:[0-9a-f]{2})+$/;
export const WALLET_REQUEST_FIELDS = Object.freeze(['chainId', 'from', 'to', 'value', 'data', 'executionAttemptId']);

/**
 * Die einzige Form, in der ein spaeterer Adapter eine Transaktion anfordern darf:
 * requestTransaction({ chainId, from, to, value, data, executionAttemptId }). Alle Felder kommen aus der
 * verbrauchten Sitzung; `from` muss gleich SIWE-Sitzungs-Wallet, Intent-Wallet und Sitzungs-Wallet sein.
 * Kein Feld vom Client, kein freies `from`, keine Gas- oder Nonce-Vorgabe.
 */
export function buildWalletRequest({ session, attemptId, siweWallet, intentWallet }) {
	if (!session || typeof session !== 'object') return Object.freeze({ ok: false, code: 'SESSION' });
	if (typeof attemptId !== 'string' || !UUID.test(attemptId)) return Object.freeze({ ok: false, code: 'ATTEMPT_ID' });
	if (![siweWallet, intentWallet, session.wallet].every((w) => typeof w === 'string' && ADDRESS.test(w))) return Object.freeze({ ok: false, code: 'WALLET_FORMAT' });
	if (siweWallet !== intentWallet || intentWallet !== session.wallet) return Object.freeze({ ok: false, code: 'WALLET_MISMATCH' });
	if (session.chainId !== 1 || session.value !== 0n || typeof session.to !== 'string' || !ADDRESS.test(session.to) || typeof session.data !== 'string' || !DATA.test(session.data)) {
		return Object.freeze({ ok: false, code: 'SESSION_FIELDS' });
	}
	return Object.freeze({ ok: true, request: Object.freeze({ chainId: 1, from: session.wallet, to: session.to, value: 0n, data: session.data, executionAttemptId: attemptId }) });
}

/** Der Adapter darf kein Feld veraendern: was er der Wallet uebergibt, muss Feld fuer Feld gleich sein. */
export function checkAdapterRequest(expected, handedToWallet) {
	if (!handedToWallet || typeof handedToWallet !== 'object') return 'ADAPTER_ALTERED';
	const keys = Object.keys(handedToWallet).sort();
	if (keys.length !== WALLET_REQUEST_FIELDS.length || !keys.every((k, i) => k === [...WALLET_REQUEST_FIELDS].sort()[i])) return 'ADAPTER_ALTERED';
	for (const k of WALLET_REQUEST_FIELDS) if (handedToWallet[k] !== expected[k]) return 'ADAPTER_ALTERED';
	return 'UNCHANGED';
}

/**
 * Prueft eine auf der Kette gefundene oder per Hash geladene Transaktion gegen die Anfrage, bevor ihr Hash
 * gebunden wird: from, to, value, data und chainId exakt. Ein Hash allein ist nie Beleg.
 */
export function verifyObservedTransaction({ request, tx }) {
	if (!request || !tx || typeof tx !== 'object' || typeof tx.hash !== 'string' || !TX_HASH.test(tx.hash)) return Object.freeze({ ok: false, code: 'TX' });
	const lower = (x) => (typeof x === 'string' ? x.toLowerCase() : x);
	if (lower(tx.from) !== request.from) return Object.freeze({ ok: false, code: 'FROM' });
	if (lower(tx.to) !== request.to) return Object.freeze({ ok: false, code: 'TO' });
	if (tx.value !== 0n) return Object.freeze({ ok: false, code: 'VALUE' });
	if (lower(tx.input) !== request.data) return Object.freeze({ ok: false, code: 'DATA' });
	if (tx.chainId !== 1) return Object.freeze({ ok: false, code: 'CHAIN' });
	return Object.freeze({ ok: true, txHash: tx.hash });
}

/* ------------------------------------------------- Freigabe und buyCover -- */

/**
 * Reihenfolge der Berechtigungen: ist die Allowance schon ausreichend, keine Freigabe. Sonst zuerst die
 * Freigabe (eigene Sitzung, eigener Versuch), dann deren Wirkung unabhaengig nachpruefen, dann eine NEUE
 * buyCover-Sitzung mit frischer Vorpruefung. Eine Freigabe ist nie ein Kauf.
 */
export function planAuthorities({ allowanceRaw, requiredRaw }) {
	if (typeof allowanceRaw !== 'bigint' || typeof requiredRaw !== 'bigint' || allowanceRaw < 0n || requiredRaw <= 0n) throw new TypeError('AMOUNTS');
	if (allowanceRaw >= requiredRaw) return Object.freeze(['NEXUS_BUY_COVER']);
	return Object.freeze(['USDC_APPROVAL', 'NEXUS_BUY_COVER']);
}

/** Die Freigabe gilt erst, wenn die Allowance an einem Block unabhaengig gelesen mindestens requiredRaw ist. */
export function assessApproval({ receiptStatus, allowanceRaw, requiredRaw, verifiedAtBlock, minedAtBlock }) {
	if (typeof allowanceRaw !== 'bigint' || typeof requiredRaw !== 'bigint' || typeof verifiedAtBlock !== 'bigint' || typeof minedAtBlock !== 'bigint') throw new TypeError('APPROVAL');
	if (receiptStatus !== 'success') return Object.freeze({ outcome: 'FAILED', reason: 'RECEIPT' });
	if (verifiedAtBlock < minedAtBlock) return Object.freeze({ outcome: 'PENDING', reason: 'READ_BEFORE_MINING' });
	if (allowanceRaw < requiredRaw) return Object.freeze({ outcome: 'FAILED', reason: 'ALLOWANCE_INSUFFICIENT' });
	return Object.freeze({ outcome: 'VERIFIED', verifiedAtBlock });
}

/* ------------------------------------------------------------ Absturzfenster -- */

const crash = (c) => Object.freeze(c);
export const CRASH_WINDOWS = Object.freeze([
	crash({ id: 'C1', window: 'consume committed, process dies before the wallet call', authoritative: 'P4I session consumed; attempt absent or AUTHORIZED, no write-ahead',
		safeRetry: 'same consumer request: consume replays (IDEMPOTENT_REPLAY), open returns the same attempt, start may win the write-ahead while the session is unexpired',
		newSession: 'never for the same kind; after expiry the intent may be closed and a new intent created (no wallet request can have been made)', chainLookup: false, operator: false }),
	crash({ id: 'C2', window: 'wallet call started, process dies before any response', authoritative: 'attempt WALLET_REQUEST_STARTED; the wallet is busy (no other attempt of it can start)',
		safeRetry: 'none: start returns ALREADY_STARTED, the wallet is not called again', newSession: 'no wallet request for this wallet, whatever the session or intent (wallet busy)', chainLookup: true, operator: 'only if nothing is found after the quiet period' }),
	crash({ id: 'C3', window: 'transaction broadcast, process dies before the tx_hash is persisted', authoritative: 'attempt WALLET_REQUEST_STARTED; the chain has the transaction',
		safeRetry: 'none: reconciliation finds the matching transaction (verifyObservedTransaction) and binds it with source CHAIN_RECONCILIATION', newSession: 'no', chainLookup: true, operator: false }),
	crash({ id: 'C4', window: 'tx_hash persisted, process dies before P4D SUBMITTED', authoritative: 'attempt TX_HASH_OBSERVED; intent BUILT; the wallet stays busy',
		safeRetry: 'submit the bound hash again (submit takes the hash from the attempt, never from the caller)', newSession: 'no', chainLookup: false,
		operator: 'only if the build deadline passed before submission: P4D refuses SUBMITTED, the hash stays bound and the wallet busy; an operator reconciles from the P4E receipt (the intent may expire meanwhile, a second purchase cannot start)' }),
	crash({ id: 'C5', window: 'SUBMITTED persisted, response to the browser lost', authoritative: 'attempt SUBMITTED; intent SUBMITTED with the bound hash',
		safeRetry: 'the browser repeats the same consumer request and reads the state (start: ALREADY_STARTED with SUBMITTED and tx_hash); nothing is sent again', newSession: 'no', chainLookup: false, operator: false }),
	crash({ id: 'C6', window: 'approval mined, browser closes before the NEXUS_BUY_COVER request', authoritative: 'approval attempt TX_HASH_OBSERVED (or WALLET_REQUEST_STARTED until reconciled)',
		safeRetry: 'verify the allowance independently -> APPROVAL_VERIFIED; then a fresh NEXUS_BUY_COVER session (new P4F at a block from that verification) while the intent is still buildable, otherwise a new intent that needs no approval',
		newSession: 'yes, only NEXUS_BUY_COVER and only after APPROVAL_VERIFIED', chainLookup: true, operator: false })
]);

/* ------------------------------------------------------------- Wallet-Arten -- */

/** Modell der spaeteren Adapter; KEINER ist in P4J umgesetzt. */
export const WALLET_MODELS = Object.freeze({
	EOA_INJECTED: Object.freeze({ implemented: false, authority: 'SIWE wallet == intent wallet == session wallet == transaction from', txHash: 'returned by the wallet; verified against the chain before it decides anything',
		nonce: 'chosen by the wallet; evidence after the fact, never authorization', duplicateProtection: 'write-ahead compare-and-set per attempt, not the nonce' }),
	WALLETCONNECT: Object.freeze({ implemented: false, authority: 'as EOA; the pairing session may outlive the request and must be ended after it (see SIWE practice)',
		txHash: 'returned over the relay; a lost relay answer is UNCERTAIN', nonce: 'chosen by the remote wallet; evidence only', duplicateProtection: 'write-ahead compare-and-set per attempt' }),
	SAFE_ERC1271: Object.freeze({ implemented: false, authority: 'from is the Safe; authority follows ERC-1271 and the Safe owners/threshold, not one SIWE key',
		txHash: 'a proposal yields a safeTxHash, which is NOT a chain transaction hash and is never bound; only the executed chain transaction is', nonce: 'the Safe nonce, separate from any owner EOA nonce; evidence only',
		duplicateProtection: 'write-ahead compare-and-set per attempt; execution by other owners is reconciled from the chain' })
});
