/*
	AGENT-AUTH-001: ERC-1271 Smart-Contract-Wallet (Safe) SIWE.

	Alle Faelle laufen OFFLINE: der Offline-EOA-Pfad (`verifyOffline`) und die
	Chain-Lesevorgaenge (`getCode`/`verify`) werden injiziert. Kein Test oeffnet
	eine echte RPC-Verbindung. Zentrale Nachweise: der EOA-Pfad bleibt RPC-frei,
	das Formatgate loest nie einen RPC aus, jeder Chain-/Decode-/Timeoutfehler
	faellt zu, und die gepruefte Adresse ist immer ausschliesslich expected.wallet.
*/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	verifyWalletSiweSignature,
	verifyContractSiweSignature,
	isContractSignatureCandidate,
	WALLET_SIG_RESULTS,
	MAX_CONTRACT_SIGNATURE_BYTES
} from '../src/contract-signature.mjs';

const WALLET_A = '0x1111111111111111111111111111111111111111';
const WALLET_B = '0x2222222222222222222222222222222222222222';
const EOA_SIG = `0x${'ab'.repeat(65)}`;            // 65 Byte, formal EOA
const CONTRACT_SIG = `0x${'cd'.repeat(300)}`;       // langer, gerader Hex-Blob (Safe-artig)
const BYTECODE = '0x363d3d373d3d3d363d73aabbcc';    // irgendein Nicht-0x-Code

function spy(result) {
	const calls = [];
	const fn = async (arg) => {
		calls.push(arg);
		if (typeof result === 'function') return result(arg);
		if (result instanceof Error) throw result;
		return result;
	};
	fn.calls = calls;
	return fn;
}

/* Ein verifyOffline-Spion, der ein fixes Feldergebnis liefert. */
function offline(result) {
	return spy(result);
}

/* ------------------------------------------------------------------ *
 * 1-3: EOA bleibt unveraendert und RPC-frei
 * ------------------------------------------------------------------ */

test('1: gueltige EOA-Signatur -> VALID, kein RPC', async () => {
	const getCode = spy(BYTECODE);
	const verify = spy(true);
	const verifyOffline = offline('VALID');
	const r = await verifyWalletSiweSignature(
		{ message: 'm', signature: EOA_SIG, expected: { wallet: WALLET_A } },
		{ verifyOffline, getCode, verify }
	);
	assert.equal(r, 'VALID');
	assert.equal(getCode.calls.length, 0, 'kein getCode');
	assert.equal(verify.calls.length, 0, 'kein verifyMessage');
});

test('2: Feld-Mismatch (DOMAIN_MISMATCH) -> durchgereicht, kein RPC', async () => {
	const getCode = spy(BYTECODE);
	const verify = spy(true);
	const r = await verifyWalletSiweSignature(
		{ message: 'm', signature: CONTRACT_SIG, expected: { wallet: WALLET_A } },
		{ verifyOffline: offline('DOMAIN_MISMATCH'), getCode, verify }
	);
	assert.equal(r, 'DOMAIN_MISMATCH');
	assert.equal(getCode.calls.length, 0);
	assert.equal(verify.calls.length, 0);
});

test('3: NONCE_MISMATCH und EXPIRED -> durchgereicht, kein RPC', async () => {
	for (const code of ['NONCE_MISMATCH', 'EXPIRED', 'CHAIN_MISMATCH', 'ADDRESS_MISMATCH']) {
		const getCode = spy(BYTECODE);
		const r = await verifyWalletSiweSignature(
			{ message: 'm', signature: CONTRACT_SIG, expected: { wallet: WALLET_A } },
			{ verifyOffline: offline(code), getCode, verify: spy(true) }
		);
		assert.equal(r, code);
		assert.equal(getCode.calls.length, 0, `kein RPC bei ${code}`);
	}
});

/* ------------------------------------------------------------------ *
 * 4-11: ERC-1271-Pfad
 * ------------------------------------------------------------------ */

test('4: offline INVALID_SIGNATURE + kein Contract-Code -> INVALID_SIGNATURE', async () => {
	const getCode = spy('0x');
	const verify = spy(true);
	const r = await verifyWalletSiweSignature(
		{ message: 'm', signature: EOA_SIG, expected: { wallet: WALLET_A } },
		{ verifyOffline: offline('INVALID_SIGNATURE'), getCode, verify }
	);
	assert.equal(r, 'INVALID_SIGNATURE');
	assert.equal(getCode.calls.length, 1);
	assert.equal(verify.calls.length, 0, 'kein 1271 ohne Code');
});

test('5: offline INVALID_SIGNATURE + Contract + gueltige 1271-Antwort -> VALID', async () => {
	const getCode = spy(BYTECODE);
	const verify = spy(true);
	const r = await verifyWalletSiweSignature(
		{ message: 'm', signature: EOA_SIG, expected: { wallet: WALLET_A } },
		{ verifyOffline: offline('INVALID_SIGNATURE'), getCode, verify }
	);
	assert.equal(r, 'VALID');
	assert.equal(verify.calls[0].address, WALLET_A);
});

test('6: Contract-Signatur (offline FORMAT) + Contract + gueltige 1271 -> VALID', async () => {
	const getCode = spy(BYTECODE);
	const verify = spy(true);
	const r = await verifyWalletSiweSignature(
		{ message: 'm', signature: CONTRACT_SIG, expected: { wallet: WALLET_A } },
		{ verifyOffline: offline('INVALID_SIGNATURE_FORMAT'), getCode, verify }
	);
	assert.equal(r, 'VALID');
});

test('7: Contract + verify false (falsche Magic / revert als false) -> INVALID_SIGNATURE', async () => {
	const r = await verifyWalletSiweSignature(
		{ message: 'm', signature: CONTRACT_SIG, expected: { wallet: WALLET_A } },
		{ verifyOffline: offline('INVALID_SIGNATURE_FORMAT'), getCode: spy(BYTECODE), verify: spy(false) }
	);
	assert.equal(r, 'INVALID_SIGNATURE');
});

test('8: Contract + verify wirft (revert/timeout) -> RPC_UNAVAILABLE (fail closed)', async () => {
	const r = await verifyWalletSiweSignature(
		{ message: 'm', signature: CONTRACT_SIG, expected: { wallet: WALLET_A } },
		{ verifyOffline: offline('INVALID_SIGNATURE_FORMAT'), getCode: spy(BYTECODE), verify: spy(new Error('revert')) }
	);
	assert.equal(r, 'RPC_UNAVAILABLE');
});

test('9: getCode wirft (RPC-Timeout/Ratelimit) -> RPC_UNAVAILABLE', async () => {
	const verify = spy(true);
	const r = await verifyWalletSiweSignature(
		{ message: 'm', signature: CONTRACT_SIG, expected: { wallet: WALLET_A } },
		{ verifyOffline: offline('INVALID_SIGNATURE_FORMAT'), getCode: spy(new Error('timeout')), verify }
	);
	assert.equal(r, 'RPC_UNAVAILABLE');
	assert.equal(verify.calls.length, 0, 'ohne Code-Status kein 1271');
});

test('10: getCode = 0x -> INVALID_SIGNATURE', async () => {
	const r = await verifyWalletSiweSignature(
		{ message: 'm', signature: CONTRACT_SIG, expected: { wallet: WALLET_A } },
		{ verifyOffline: offline('INVALID_SIGNATURE_FORMAT'), getCode: spy('0x'), verify: spy(true) }
	);
	assert.equal(r, 'INVALID_SIGNATURE');
});

test('11: getCode = null/undefined -> INVALID_SIGNATURE', async () => {
	for (const code of [null, undefined]) {
		const r = await verifyWalletSiweSignature(
			{ message: 'm', signature: CONTRACT_SIG, expected: { wallet: WALLET_A } },
			{ verifyOffline: offline('INVALID_SIGNATURE_FORMAT'), getCode: spy(code), verify: spy(true) }
		);
		assert.equal(r, 'INVALID_SIGNATURE');
	}
});

/* ------------------------------------------------------------------ *
 * 12-17: Formatgate - nie ein RPC
 * ------------------------------------------------------------------ */

test('12: Nicht-String-Signatur -> INVALID_SIGNATURE_FORMAT, kein RPC', async () => {
	for (const bad of [null, undefined, 123, {}, []]) {
		const getCode = spy(BYTECODE);
		const r = await verifyContractSiweSignature(
			{ address: WALLET_A, message: 'm', signature: bad },
			{ getCode, verify: spy(true) }
		);
		assert.equal(r, 'INVALID_SIGNATURE_FORMAT');
		assert.equal(getCode.calls.length, 0);
	}
});

test('13: Nicht-Hex-Signatur -> INVALID_SIGNATURE_FORMAT, kein RPC', async () => {
	const getCode = spy(BYTECODE);
	const r = await verifyContractSiweSignature(
		{ address: WALLET_A, message: 'm', signature: '0xZZZZ' },
		{ getCode, verify: spy(true) }
	);
	assert.equal(r, 'INVALID_SIGNATURE_FORMAT');
	assert.equal(getCode.calls.length, 0);
});

test('14: leeres 0x -> INVALID_SIGNATURE_FORMAT, kein RPC', async () => {
	const getCode = spy(BYTECODE);
	const r = await verifyContractSiweSignature(
		{ address: WALLET_A, message: 'm', signature: '0x' },
		{ getCode, verify: spy(true) }
	);
	assert.equal(r, 'INVALID_SIGNATURE_FORMAT');
	assert.equal(getCode.calls.length, 0);
});

test('15: ungerade Hex-Laenge -> INVALID_SIGNATURE_FORMAT, kein RPC', async () => {
	const getCode = spy(BYTECODE);
	const r = await verifyContractSiweSignature(
		{ address: WALLET_A, message: 'm', signature: '0xabc' },
		{ getCode, verify: spy(true) }
	);
	assert.equal(r, 'INVALID_SIGNATURE_FORMAT');
	assert.equal(getCode.calls.length, 0);
});

test('16: uebergrosse Signatur (> Limit) -> INVALID_SIGNATURE_FORMAT, kein RPC', async () => {
	const tooBig = `0x${'ab'.repeat(MAX_CONTRACT_SIGNATURE_BYTES + 1)}`;
	const getCode = spy(BYTECODE);
	const r = await verifyContractSiweSignature(
		{ address: WALLET_A, message: 'm', signature: tooBig },
		{ getCode, verify: spy(true) }
	);
	assert.equal(r, 'INVALID_SIGNATURE_FORMAT');
	assert.equal(getCode.calls.length, 0);
	// auch ueber den Orchestrator (offline FORMAT) kein RPC
	const getCode2 = spy(BYTECODE);
	const r2 = await verifyWalletSiweSignature(
		{ message: 'm', signature: tooBig, expected: { wallet: WALLET_A } },
		{ verifyOffline: offline('INVALID_SIGNATURE_FORMAT'), getCode: getCode2, verify: spy(true) }
	);
	assert.equal(r2, 'INVALID_SIGNATURE_FORMAT');
	assert.equal(getCode2.calls.length, 0);
});

test('17: isContractSignatureCandidate Wahrheitstabelle', () => {
	assert.equal(isContractSignatureCandidate(CONTRACT_SIG), true);
	assert.equal(isContractSignatureCandidate(EOA_SIG), true);        // formal gueltig
	assert.equal(isContractSignatureCandidate('0x'), false);
	assert.equal(isContractSignatureCandidate('0xabc'), false);        // ungerade
	assert.equal(isContractSignatureCandidate('0xZZ'), false);
	assert.equal(isContractSignatureCandidate('abcd'), false);         // ohne 0x
	assert.equal(isContractSignatureCandidate(null), false);
	assert.equal(isContractSignatureCandidate(`0x${'ab'.repeat(MAX_CONTRACT_SIGNATURE_BYTES)}`), true);
	assert.equal(isContractSignatureCandidate(`0x${'ab'.repeat(MAX_CONTRACT_SIGNATURE_BYTES + 1)}`), false);
});

/* ------------------------------------------------------------------ *
 * 18-19: Adressbindung / kein Client-gesteuerter Kontext
 * ------------------------------------------------------------------ */

test('18: geprueft wird ausschliesslich expected.wallet', async () => {
	const getCode = spy(BYTECODE);
	const verify = spy(true);
	await verifyWalletSiweSignature(
		{ message: 'm', signature: CONTRACT_SIG, expected: { wallet: WALLET_A } },
		{ verifyOffline: offline('INVALID_SIGNATURE_FORMAT'), getCode, verify }
	);
	assert.equal(getCode.calls[0], WALLET_A, 'getCode gegen expected.wallet');
	assert.equal(verify.calls[0].address, WALLET_A, 'verify gegen expected.wallet');
});

test('19: 1271-Signatur fuer Wallet A authentifiziert nie Wallet B', async () => {
	// Der Contract-Check laeuft gegen B (expected.wallet=B). Der B-Contract
	// akzeptiert die fuer A gedachte Signatur nicht -> verify meldet false.
	const verify = spy((params) => params.address === WALLET_B ? false : true);
	const r = await verifyWalletSiweSignature(
		{ message: 'm', signature: CONTRACT_SIG, expected: { wallet: WALLET_B } },
		{ verifyOffline: offline('INVALID_SIGNATURE_FORMAT'), getCode: spy(BYTECODE), verify }
	);
	assert.equal(r, 'INVALID_SIGNATURE');
	assert.equal(verify.calls[0].address, WALLET_B);
});

/* ------------------------------------------------------------------ *
 * 20: Safe-Fixture (langer Contract-Signature-Blob)
 * ------------------------------------------------------------------ */

test('20: Safe-artige Fixture (langer Blob) + Contract + gueltig -> VALID', async () => {
	// gnosis-safe-artige Signatur: deutlich > 65 Byte, gerade, nur Hex
	const safeSig = `0x${'00'.repeat(32)}${'11'.repeat(32)}${'1b'}${'ab'.repeat(65)}`;
	assert.equal(isContractSignatureCandidate(safeSig), true);
	const r = await verifyContractSiweSignature(
		{ address: WALLET_A, message: 'login', signature: safeSig },
		{ getCode: spy(BYTECODE), verify: spy(true) }
	);
	assert.equal(r, 'VALID');
});

/* ------------------------------------------------------------------ *
 * 21-23: Defaults / Exporte / kein Schluessel
 * ------------------------------------------------------------------ */

test('21: ohne ALCHEMY_API_KEY und ohne injizierte Deps -> RPC_UNAVAILABLE', async () => {
	const saved = process.env.ALCHEMY_API_KEY;
	delete process.env.ALCHEMY_API_KEY;
	try {
		const r = await verifyContractSiweSignature(
			{ address: WALLET_A, message: 'm', signature: CONTRACT_SIG },
			{}
		);
		assert.equal(r, 'RPC_UNAVAILABLE');
	} finally {
		if (saved !== undefined) process.env.ALCHEMY_API_KEY = saved;
	}
});

test('22: Formatgate schlaegt vor dem fehlenden Schluessel zu', async () => {
	const saved = process.env.ALCHEMY_API_KEY;
	delete process.env.ALCHEMY_API_KEY;
	try {
		// kaputte Signatur -> FORMAT, nicht RPC_UNAVAILABLE
		const r = await verifyContractSiweSignature(
			{ address: WALLET_A, message: 'm', signature: '0xnothex' },
			{}
		);
		assert.equal(r, 'INVALID_SIGNATURE_FORMAT');
	} finally {
		if (saved !== undefined) process.env.ALCHEMY_API_KEY = saved;
	}
});

test('23: Exporte vorhanden und erwartet', () => {
	assert.deepEqual(WALLET_SIG_RESULTS, ['VALID', 'INVALID_SIGNATURE', 'INVALID_SIGNATURE_FORMAT', 'RPC_UNAVAILABLE']);
	assert.ok(Object.isFrozen(WALLET_SIG_RESULTS));
	assert.equal(MAX_CONTRACT_SIGNATURE_BYTES, 4096);
});

// AUDIT-2026-10-12 F3: der Contract-Erkennungs-Cache waechst nicht unbegrenzt.
test('F3 contract-detect cache stays bounded: expired first, then oldest', async () => {
	const { isDeployedContract, CODE_CACHE_MAX_ENTRIES, CODE_CACHE_TTL_MS } = await import('../src/contract-detect.mjs');
	const cache = new Map();
	const addr = (i) => `0x${i.toString(16).padStart(40, '0')}`;
	const getCode = async () => '0x';
	for (let i = 0; i < CODE_CACHE_MAX_ENTRIES + 250; i++) await isDeployedContract(addr(i), { getCode, cache, now: 1_000 });
	assert.equal(cache.size, CODE_CACHE_MAX_ENTRIES);
	assert.equal(cache.has(addr(0)), false, 'aeltester Eintrag verdraengt');
	assert.equal(cache.has(addr(CODE_CACHE_MAX_ENTRIES + 249)), true, 'neuester bleibt');
	// Spaeter: alles Alte ist abgelaufen. Der naechste Ueberlauf raeumt alle
	// abgelaufenen Eintraege auf einmal, nicht nur einen.
	const later = 1_000 + CODE_CACHE_TTL_MS + 1;
	await isDeployedContract(addr(20_000), { getCode, cache, now: later });
	assert.equal(cache.size, 1, 'nur der frische Eintrag bleibt');
	// Unter der Grenze wird nichts geraeumt: frische Eintraege bleiben alle.
	for (let i = 0; i < 5; i++) await isDeployedContract(addr(30_000 + i), { getCode, cache, now: later + 1 });
	assert.equal(cache.size, 6);
	// Ein Treffer liefert weiter das gecachte Ergebnis ohne RPC.
	let calls = 0;
	assert.equal(await isDeployedContract(addr(20_000), { getCode: async () => { calls++; return '0x60'; }, cache, now: later + 2 }), false);
	assert.equal(calls, 0);
});

// AUDIT-2026-10-12: nur ein echtes `true` authentifiziert; ein "truthy" Rueckgabewert nicht.
test('AUDIT 1271 verify result must be exactly true', async () => {
	const { verifyContractSiweSignature } = await import('../src/contract-signature.mjs');
	const sig = `0x${'ab'.repeat(65)}`;
	for (const value of [1, 'true', 'VALID', {}, [], '0x1626ba7e']) {
		assert.equal(await verifyContractSiweSignature({ address: '0x5afe000000000000000000000000000000005afe', message: 'm', signature: sig }, { getCode: async () => '0x6080', verify: async () => value }), 'INVALID_SIGNATURE', JSON.stringify(value));
	}
});
