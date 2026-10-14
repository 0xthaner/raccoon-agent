/*
	AGENT-AUTH-001: ERC-1271 Smart-Contract-Wallet (Safe) SIWE.

	Alle Faelle laufen OFFLINE: der Offline-EOA-Pfad (`verifyOffline`) wird
	injiziert, die Chain-Lesevorgaenge laufen ueber zwei simulierte Provider
	(test-support/dual-rpc-sim.mjs, echte viem-Clients, kein Netz). Seit dem
	Dual-RPC-Konsens (14.10.2026) gilt eine Contract-Signatur nur, wenn Alchemy
	UND Infura sie am selben Block bestaetigen. Zentrale Nachweise: der EOA-Pfad
	bleibt RPC-frei, das Formatgate loest nie einen RPC aus, jeder Chain-/Decode-/
	Timeoutfehler faellt zu, und die gepruefte Adresse ist immer expected.wallet.
*/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashMessage } from 'viem';
import {
	verifyWalletSiweSignature,
	verifyContractSiweSignature,
	isContractSignatureCandidate,
	WALLET_SIG_RESULTS,
	MAX_CONTRACT_SIGNATURE_BYTES
} from '../src/contract-signature.mjs';
import { simChain, dualProviders, ownerSignature } from '../test-support/dual-rpc-sim.mjs';

const WALLET_A = '0x1111111111111111111111111111111111111111';
const WALLET_B = '0x2222222222222222222222222222222222222222';
const EOA_SIG = `0x${'ab'.repeat(65)}`;            // 65 Byte, formal EOA
const CONTRACT_SIG = ownerSignature(['a1'], hashMessage('m')); // gueltige Owner-Signatur ueber 'm'

/* Kette: WALLET_A ist eine 1-von-1-Safe mit Owner a1; WALLET_B eine Safe mit Owner b2. */
const chain = () => simChain({ safes: {
	[WALLET_A]: { history: [{ from: 0n, owners: ['a1'], threshold: 1 }] },
	[WALLET_B]: { history: [{ from: 0n, owners: ['b2'], threshold: 1 }] }
} });
const rpcCalls = (logs) => logs.alchemy.length + logs.infura.length;
const calls = (logs, method) => [...logs.alchemy, ...logs.infura].filter((l) => l.method === method);
const offline = (result) => async () => result;
const fail = () => { throw new Error('The request took too long to respond.'); };

/* ------------------------------------------------------------------ *
 * 1-3: EOA bleibt unveraendert und RPC-frei
 * ------------------------------------------------------------------ */

test('1: gueltige EOA-Signatur -> VALID, kein RPC', async () => {
	const { providers, logs } = dualProviders(chain());
	const r = await verifyWalletSiweSignature({ message: 'm', signature: EOA_SIG, expected: { wallet: WALLET_A } }, { verifyOffline: offline('VALID'), providers });
	assert.equal(r, 'VALID');
	assert.equal(rpcCalls(logs), 0, 'kein Provider gefragt');
});

test('2: Feld-Mismatch (DOMAIN_MISMATCH) -> durchgereicht, kein RPC', async () => {
	const { providers, logs } = dualProviders(chain());
	const r = await verifyWalletSiweSignature({ message: 'm', signature: CONTRACT_SIG, expected: { wallet: WALLET_A } }, { verifyOffline: offline('DOMAIN_MISMATCH'), providers });
	assert.equal(r, 'DOMAIN_MISMATCH');
	assert.equal(rpcCalls(logs), 0);
});

test('3: NONCE_MISMATCH und EXPIRED -> durchgereicht, kein RPC', async () => {
	for (const code of ['NONCE_MISMATCH', 'EXPIRED', 'CHAIN_MISMATCH', 'ADDRESS_MISMATCH']) {
		const { providers, logs } = dualProviders(chain());
		const r = await verifyWalletSiweSignature({ message: 'm', signature: CONTRACT_SIG, expected: { wallet: WALLET_A } }, { verifyOffline: offline(code), providers });
		assert.equal(r, code);
		assert.equal(rpcCalls(logs), 0, `kein RPC bei ${code}`);
	}
});

/* ------------------------------------------------------------------ *
 * 4-11: ERC-1271-Pfad (beide Provider)
 * ------------------------------------------------------------------ */

test('4: offline INVALID_SIGNATURE + kein Contract-Code (beide) -> INVALID_SIGNATURE', async () => {
	const { providers, logs } = dualProviders(chain());
	const r = await verifyWalletSiweSignature({ message: 'm', signature: EOA_SIG, expected: { wallet: '0x3333333333333333333333333333333333333333' } }, { verifyOffline: offline('INVALID_SIGNATURE'), providers });
	assert.equal(r, 'INVALID_SIGNATURE');
	assert.equal(calls(logs, 'eth_getCode').length, 2, 'getCode bei beiden');
	assert.equal(calls(logs, 'eth_call').length, 0, 'kein 1271 ohne Code');
});

test('5: offline INVALID_SIGNATURE + Contract + gueltige 1271-Antwort beider -> VALID', async () => {
	const { providers, logs } = dualProviders(chain());
	const r = await verifyWalletSiweSignature({ message: 'm', signature: CONTRACT_SIG, expected: { wallet: WALLET_A } }, { verifyOffline: offline('INVALID_SIGNATURE'), providers });
	assert.equal(r, 'VALID');
	assert.deepEqual(calls(logs, 'eth_call').map((c) => c.params[0].to.toLowerCase()), [WALLET_A, WALLET_A]);
});

test('6: Contract-Signatur (offline FORMAT) + Contract + gueltige 1271 -> VALID', async () => {
	const { providers } = dualProviders(chain());
	const r = await verifyWalletSiweSignature({ message: 'm', signature: CONTRACT_SIG, expected: { wallet: WALLET_A } }, { verifyOffline: offline('INVALID_SIGNATURE_FORMAT'), providers });
	assert.equal(r, 'VALID');
});

test('7: Contract sagt nein (falsche Magic) -> INVALID_SIGNATURE', async () => {
	const { providers } = dualProviders(chain());
	const r = await verifyWalletSiweSignature({ message: 'm', signature: ownerSignature(['c3'], hashMessage('m')), expected: { wallet: WALLET_A } }, { verifyOffline: offline('INVALID_SIGNATURE_FORMAT'), providers });
	assert.equal(r, 'INVALID_SIGNATURE');
});

test('8: 1271-Aufruf: Timeout -> RPC_UNAVAILABLE; Revert bei beiden -> INVALID_SIGNATURE (nie VALID)', async () => {
	const timeoutBoth = dualProviders(chain(), { behave: { eth_call: fail } }, { behave: { eth_call: fail } });
	assert.equal(await verifyContractSiweSignature({ address: WALLET_A, message: 'm', signature: CONTRACT_SIG }, { providers: timeoutBoth.providers }), 'RPC_UNAVAILABLE');
	const revert = () => { const e = new Error('execution reverted'); e.code = 3; e.data = '0x'; throw e; };
	const revertBoth = dualProviders(chain(), { behave: { eth_call: revert } }, { behave: { eth_call: revert } });
	assert.equal(await verifyContractSiweSignature({ address: WALLET_A, message: 'm', signature: CONTRACT_SIG }, { providers: revertBoth.providers }), 'INVALID_SIGNATURE');
});

test('9: getCode wirft (RPC-Timeout/Ratelimit) -> RPC_UNAVAILABLE, kein 1271', async () => {
	for (const [a, b] of [[{ behave: { eth_getCode: fail } }, {}], [{}, { behave: { eth_getCode: fail } }]]) {
		const { providers, logs } = dualProviders(chain(), a, b);
		const r = await verifyContractSiweSignature({ address: WALLET_A, message: 'm', signature: CONTRACT_SIG }, { providers });
		assert.equal(r, 'RPC_UNAVAILABLE');
		assert.equal(calls(logs, 'eth_call').length, 0, 'ohne Code-Status kein 1271');
	}
});

test('10: getCode = 0x bei beiden -> INVALID_SIGNATURE', async () => {
	const { providers } = dualProviders(chain(), { behave: { eth_getCode: () => '0x' } }, { behave: { eth_getCode: () => '0x' } });
	assert.equal(await verifyContractSiweSignature({ address: WALLET_A, message: 'm', signature: CONTRACT_SIG }, { providers }), 'INVALID_SIGNATURE');
});

test('11: getCode = null bei beiden -> INVALID_SIGNATURE', async () => {
	const { providers } = dualProviders(chain(), { behave: { eth_getCode: () => null } }, { behave: { eth_getCode: () => null } });
	assert.equal(await verifyContractSiweSignature({ address: WALLET_A, message: 'm', signature: CONTRACT_SIG }, { providers }), 'INVALID_SIGNATURE');
});

/* ------------------------------------------------------------------ *
 * 12-17: Formatgate - nie ein RPC
 * ------------------------------------------------------------------ */

async function formatGate(signature) {
	const { providers, logs } = dualProviders(chain());
	const r = await verifyContractSiweSignature({ address: WALLET_A, message: 'm', signature }, { providers });
	assert.equal(r, 'INVALID_SIGNATURE_FORMAT', String(signature).slice(0, 20));
	assert.equal(rpcCalls(logs), 0);
}

test('12: Nicht-String-Signatur -> INVALID_SIGNATURE_FORMAT, kein RPC', async () => {
	for (const bad of [null, undefined, 123, {}, []]) await formatGate(bad);
});

test('13: Nicht-Hex-Signatur -> INVALID_SIGNATURE_FORMAT, kein RPC', async () => { await formatGate('0xZZZZ'); });

test('14: leeres 0x -> INVALID_SIGNATURE_FORMAT, kein RPC', async () => { await formatGate('0x'); });

test('15: ungerade Hex-Laenge -> INVALID_SIGNATURE_FORMAT, kein RPC', async () => { await formatGate('0xabc'); });

test('16: uebergrosse Signatur (> Limit) -> INVALID_SIGNATURE_FORMAT, kein RPC', async () => {
	const tooBig = `0x${'ab'.repeat(MAX_CONTRACT_SIGNATURE_BYTES + 1)}`;
	await formatGate(tooBig);
	// auch ueber den Orchestrator (offline FORMAT) kein RPC
	const { providers, logs } = dualProviders(chain());
	const r2 = await verifyWalletSiweSignature({ message: 'm', signature: tooBig, expected: { wallet: WALLET_A } }, { verifyOffline: offline('INVALID_SIGNATURE_FORMAT'), providers });
	assert.equal(r2, 'INVALID_SIGNATURE_FORMAT');
	assert.equal(rpcCalls(logs), 0);
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

test('18: geprueft wird ausschliesslich expected.wallet - bei beiden Providern', async () => {
	const { providers, logs } = dualProviders(chain());
	await verifyWalletSiweSignature({ message: 'm', signature: CONTRACT_SIG, expected: { wallet: WALLET_A } }, { verifyOffline: offline('INVALID_SIGNATURE_FORMAT'), providers });
	assert.deepEqual(calls(logs, 'eth_getCode').map((c) => c.params[0].toLowerCase()), [WALLET_A, WALLET_A], 'getCode gegen expected.wallet');
	assert.deepEqual(calls(logs, 'eth_call').map((c) => c.params[0].to.toLowerCase()), [WALLET_A, WALLET_A], '1271 gegen expected.wallet');
});

test('19: 1271-Signatur fuer Wallet A authentifiziert nie Wallet B', async () => {
	const { providers, logs } = dualProviders(chain());
	const r = await verifyWalletSiweSignature({ message: 'm', signature: CONTRACT_SIG, expected: { wallet: WALLET_B } }, { verifyOffline: offline('INVALID_SIGNATURE_FORMAT'), providers });
	assert.equal(r, 'INVALID_SIGNATURE');
	assert.ok(calls(logs, 'eth_call').every((c) => c.params[0].to.toLowerCase() === WALLET_B));
});

/* ------------------------------------------------------------------ *
 * 20: Safe-Fixture (langer Contract-Signature-Blob)
 * ------------------------------------------------------------------ */

test('20: Safe-artige Fixture (langer Blob, mehrere Owner) + Contract + gueltig -> VALID', async () => {
	const multi = simChain({ safes: { [WALLET_A]: { history: [{ from: 0n, owners: ['a1', 'b2', 'c3'], threshold: 2 }] } } });
	const safeSig = ownerSignature(['a1', 'c3'], hashMessage('login'));
	assert.equal(isContractSignatureCandidate(safeSig), true);
	const { providers } = dualProviders(multi);
	assert.equal(await verifyContractSiweSignature({ address: WALLET_A, message: 'login', signature: safeSig }, { providers }), 'VALID');
});

/* ------------------------------------------------------------------ *
 * 21-23: Defaults / Exporte / kein Schluessel
 * ------------------------------------------------------------------ */

function withoutKeys(run) {
	const saved = { a: process.env.ALCHEMY_API_KEY, i: process.env.INFURA_API_KEY };
	delete process.env.ALCHEMY_API_KEY;
	delete process.env.INFURA_API_KEY;
	return Promise.resolve().then(run).finally(() => {
		if (saved.a !== undefined) process.env.ALCHEMY_API_KEY = saved.a;
		if (saved.i !== undefined) process.env.INFURA_API_KEY = saved.i;
	});
}

test('21: ohne Provider-Schluessel und ohne injizierte Provider -> RPC_UNAVAILABLE', async () => {
	await withoutKeys(async () => {
		assert.equal(await verifyContractSiweSignature({ address: WALLET_A, message: 'm', signature: CONTRACT_SIG }, {}), 'RPC_UNAVAILABLE');
	});
});

test('22: Formatgate schlaegt vor dem fehlenden Schluessel zu', async () => {
	await withoutKeys(async () => {
		assert.equal(await verifyContractSiweSignature({ address: WALLET_A, message: 'm', signature: '0xnothex' }, {}), 'INVALID_SIGNATURE_FORMAT');
	});
});

test('23: Exporte vorhanden und erwartet', () => {
	assert.deepEqual(WALLET_SIG_RESULTS, ['VALID', 'INVALID_SIGNATURE', 'INVALID_SIGNATURE_FORMAT', 'RPC_UNAVAILABLE', 'RPC_DISAGREEMENT']);
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

// AUDIT-2026-10-12: nur der exakte Magic-Wert authentifiziert, kein "truthy" Ergebnis - bei beiden Providern.
test('AUDIT 1271 result must be exactly the magic value', async () => {
	for (const result of [`0x${'0'.repeat(63)}1`, `0x1626ba7f${'0'.repeat(56)}`, `0x${'0'.repeat(64)}`, `0x0000000${'1'.padEnd(57, '0')}`]) {
		const both = { behave: { eth_call: () => result } };
		const { providers } = dualProviders(chain(), both, both);
		assert.equal(await verifyContractSiweSignature({ address: WALLET_A, message: 'm', signature: CONTRACT_SIG }, { providers }), 'INVALID_SIGNATURE', result);
	}
});
