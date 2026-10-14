/*
	ERC-1271 mit zwei unabhaengigen Providern (Alchemy + Infura), 14.10.2026.

	Ein einzelner boeswilliger, veralteter oder gestoerter Provider darf eine
	Contract-Wallet nie anmelden; er darf hoechstens eine Anmeldung verhindern.
	Beide Provider pruefen am selben Block (min(Koepfe) - STATE_DEPTH) mit
	identischem Block-Hash. Alles ueber den echten Produktionscode und echte
	viem-Clients auf einer simulierten Kette (test-support/dual-rpc-sim.mjs).
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { hashMessage, toHex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { simChain, dualProviders, ownerSignature, stateBlocks, MAGIC_RESULT, SAFE_CODE } from '../test-support/dual-rpc-sim.mjs';

process.env.APP_BASE_URL = 'https://coverraccoon.com';
process.env.DASHBOARD_SESSION_SECRET = 'dual-rpc-erc1271-secret-0123456789abcdef-0123';

const { verifyContractSiweSignature, verifyWalletSiweAuthority, combineErc1271Verdicts, commonBlock, noContractCodeByQuorum, erc1271Providers, MAX_HEAD_DIFFERENCE, STATE_DEPTH, WALLET_SIG_RESULTS } = await import('../src/contract-signature.mjs');
const auth = await import('../src/dashboard-auth.mjs');

const SAFE = '0x5afe00000000000000000000000000000000a00a';
const OTHER = '0x5afe00000000000000000000000000000000b00b';
const HEAD = 20_000_000n;
const N = HEAD - BigInt(STATE_DEPTH);
const MESSAGE = 'coverraccoon.com login fixture';
const HASH = hashMessage(MESSAGE);
const SIG_A = ownerSignature(['a1'], HASH);
const SIG_C = ownerSignature(['c3'], HASH);

function chain({ history = [{ from: 0n, owners: ['a1', 'b2'], threshold: 1 }], head = HEAD } = {}) {
	return simChain({ head, safes: { [SAFE]: { history }, [OTHER]: { history: [{ from: 0n, owners: ['zz'], threshold: 1 }] } } });
}
const verify = (providers, { address = SAFE, message = MESSAGE, signature = SIG_A } = {}) => verifyContractSiweSignature({ address, message, signature }, { providers });
const timeout = () => { throw new Error('The request took too long to respond.'); };

/* ------------------------------------------------------------------ 1-20 */

test('DUAL 1: both honest providers VALID -> VALID, both evaluated the same block', async () => {
	const { providers, logs } = dualProviders(chain());
	assert.equal(await verify(providers), 'VALID');
	assert.deepEqual(stateBlocks(logs.alchemy), [toHex(N), toHex(N)]);
	assert.deepEqual(stateBlocks(logs.infura), [toHex(N), toHex(N)]);
});

test('DUAL 2/20: Alchemy forges VALID while Infura says INVALID -> rejected (disagreement)', async () => {
	const { providers } = dualProviders(chain(), { behave: { eth_call: () => MAGIC_RESULT } });
	assert.equal(await verify(providers, { signature: SIG_C }), 'RPC_DISAGREEMENT');
});

test('DUAL 3/20: Infura forges VALID while Alchemy says INVALID -> rejected (disagreement)', async () => {
	const { providers } = dualProviders(chain(), {}, { behave: { eth_call: () => MAGIC_RESULT } });
	assert.equal(await verify(providers, { signature: SIG_C }), 'RPC_DISAGREEMENT');
});

test('DUAL 4: Alchemy fakes contract code for an EOA/undeployed address, Infura says no code -> rejected, no ERC-1271 call', async () => {
	const { providers, logs } = dualProviders(chain(), { behave: { eth_getCode: () => SAFE_CODE, eth_call: () => MAGIC_RESULT } });
	const eoa = '0x1111111111111111111111111111111111111111';
	assert.equal(await verify(providers, { address: eoa }), 'RPC_DISAGREEMENT');
	assert.equal(logs.alchemy.filter((l) => l.method === 'eth_call').length + logs.infura.filter((l) => l.method === 'eth_call').length, 0);
});

test('DUAL 5: Alchemy fakes no-code for the Safe, Infura reports code -> rejected', async () => {
	const { providers } = dualProviders(chain(), { behave: { eth_getCode: () => '0x' } });
	assert.equal(await verify(providers), 'RPC_DISAGREEMENT');
});

test('DUAL 5b: both report code but different code at the same block -> rejected', async () => {
	const { providers } = dualProviders(chain(), {}, { behave: { eth_getCode: () => '0x6080604052' } });
	assert.equal(await verify(providers), 'RPC_DISAGREEMENT');
});

test('DUAL 6/7/8: a timeout at ANY stage of either provider (or both) never authenticates', async () => {
	for (const method of ['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getCode', 'eth_call']) {
		for (const who of ['alchemy', 'infura', 'both']) {
			const slow = { behave: { [method]: timeout } };
			const { providers } = dualProviders(chain(), who === 'infura' ? {} : slow, who === 'alchemy' ? {} : slow);
			assert.equal(await verify(providers), 'RPC_UNAVAILABLE', `${method}/${who}`);
		}
	}
});

test('DUAL 9/10: malformed results from either provider never authenticate', async () => {
	const malformed = {
		eth_chainId: () => 'one',
		eth_blockNumber: () => '0xzz',
		eth_getBlockByNumber: () => ({ number: '0x1', hash: 'nothash' }),
		eth_getCode: () => 'garbage',
		eth_call: () => 'nothex'
	};
	for (const [method, fn] of Object.entries(malformed)) {
		for (const who of ['alchemy', 'infura']) {
			const bad = { behave: { [method]: fn } };
			const { providers } = dualProviders(chain(), who === 'alchemy' ? bad : {}, who === 'infura' ? bad : {});
			assert.notEqual(await verify(providers), 'VALID', `${method}/${who}`);
		}
	}
	// Leere Antwort und falscher Magic-Wert eines Providers: nie VALID.
	for (const result of ['0x', `0x1626ba7f${'0'.repeat(56)}`, `0x${'0'.repeat(64)}`]) {
		const { providers } = dualProviders(chain(), {}, { behave: { eth_call: () => result } });
		assert.equal(await verify(providers), 'RPC_DISAGREEMENT', result);
	}
});

test('DUAL 11: a provider on the wrong chain (or claiming chain 1 with a forked block) is refused', async () => {
	const wrongChain = dualProviders(chain(), {}, { chainId: 11155111 });
	assert.equal(await verify(wrongChain.providers), 'RPC_UNAVAILABLE');
	const forked = dualProviders(chain(), { behave: { eth_getBlockByNumber: (params) => ({ number: params[0], hash: `0x${'ab'.repeat(32)}` }) } });
	assert.equal(await verify(forked.providers), 'RPC_DISAGREEMENT');
	assert.equal(forked.logs.alchemy.filter((l) => l.method === 'eth_call').length, 0, 'kein ERC-1271 auf ungleichem Zustand');
});

test('DUAL 12: provider heads further apart than MAX_HEAD_DIFFERENCE -> refused before any state read', async () => {
	const { providers, logs } = dualProviders(chain(), {}, { headOffset: -BigInt(MAX_HEAD_DIFFERENCE + 1) });
	assert.equal(await verify(providers), 'RPC_UNAVAILABLE');
	assert.deepEqual([...stateBlocks(logs.alchemy), ...stateBlocks(logs.infura)], []);
	const ahead = dualProviders(chain(), { headOffset: 1_000n });
	assert.equal(await verify(ahead.providers), 'RPC_UNAVAILABLE', 'ein unplausibel weit vorausliegender Kopf');
});

test('DUAL 13: honest providers one block apart evaluate the same deterministic block', async () => {
	for (const offset of [1n, 2n, 3n]) {
		const { providers, logs } = dualProviders(chain(), { headOffset: offset });
		assert.equal(await verify(providers), 'VALID', `offset ${offset}`);
		const expected = toHex(HEAD - BigInt(STATE_DEPTH)); // min(Koepfe) - Tiefe
		assert.deepEqual(stateBlocks(logs.alchemy), [expected, expected]);
		assert.deepEqual(stateBlocks(logs.infura), [expected, expected]);
	}
	const c = await commonBlock(dualProviders(chain(), { headOffset: 2n }).providers);
	assert.deepEqual(c, { status: 'OK', blockNumber: N });
});

test('DUAL 14 (mandatory): owner A removed at block N+1 - consistent VALID at N, consistent INVALID at N+1, never mixed-state VALID', async () => {
	const removal = [{ from: 0n, owners: ['a1', 'b2'], threshold: 1 }, { from: N + 1n, owners: ['b2'], threshold: 1 }];
	// Beide Koepfe so, dass der gemeinsame Block N ist: A ist noch Owner.
	const atN = dualProviders(chain({ history: removal }));
	assert.equal(await verify(atN.providers), 'VALID');
	// Beide Koepfe einen Block weiter: gemeinsamer Block N+1, A ist entfernt.
	const atN1 = dualProviders(chain({ history: removal, head: HEAD + 1n }));
	assert.equal(await verify(atN1.providers), 'INVALID_SIGNATURE');
	// Ein Provider bei Kopf HEAD, der andere bei HEAD+1: beide pruefen N - kein gemischter Zustand.
	const mixed = dualProviders(chain({ history: removal }), {}, { headOffset: 1n });
	assert.equal(await verify(mixed.providers), 'VALID');
	assert.deepEqual(new Set([...stateBlocks(mixed.logs.alchemy), ...stateBlocks(mixed.logs.infura)]), new Set([toHex(N)]));
	// Owner HINZUGEFUEGT bei N+1: ein Provider, der eigenmaechtig N+1 pruefen wuerde, ergaebe
	// nie VALID ohne den anderen. Erst wenn der gemeinsame Block N+1 ist, gilt die Signatur.
	const addition = [{ from: 0n, owners: ['b2'], threshold: 1 }, { from: N + 1n, owners: ['a1', 'b2'], threshold: 1 }];
	assert.equal(await verify(dualProviders(chain({ history: addition })).providers), 'INVALID_SIGNATURE', 'bei N noch nicht Owner');
	assert.equal(await verify(dualProviders(chain({ history: addition }), {}, { headOffset: 1n }).providers), 'INVALID_SIGNATURE', 'ein Provider voraus: trotzdem gemeinsamer Block N');
	assert.equal(await verify(dualProviders(chain({ history: addition, head: HEAD + 1n })).providers), 'VALID');
});

test('DUAL 15/16/17/18: wrong Safe address, wrong message, wrong owner, below-threshold signature -> rejected', async () => {
	const twoOfThree = chain({ history: [{ from: 0n, owners: ['a1', 'b2', 'c3'], threshold: 2 }] });
	assert.equal(await verify(dualProviders(chain()).providers, { address: OTHER }), 'INVALID_SIGNATURE', 'falsche Safe');
	assert.equal(await verify(dualProviders(chain()).providers, { message: 'another message' }), 'INVALID_SIGNATURE', 'falsche Nachricht');
	assert.equal(await verify(dualProviders(chain()).providers, { signature: SIG_C }), 'INVALID_SIGNATURE', 'kein Owner');
	assert.equal(await verify(dualProviders(twoOfThree).providers, { signature: SIG_A }), 'INVALID_SIGNATURE', '1 von 2 noetigen');
	assert.equal(await verify(dualProviders(twoOfThree).providers, { signature: ownerSignature(['a1', 'b2'], HASH) }), 'VALID', '2 von 3');
	assert.equal(await verify(dualProviders(twoOfThree).providers, { signature: ownerSignature(['a1', 'a1'], HASH) }), 'INVALID_SIGNATURE', 'derselbe Owner zweimal');
});

test('DUAL 19: a revert from one provider while the other says VALID -> rejected; revert from both -> INVALID', async () => {
	const revert = () => { const e = new Error('execution reverted'); e.code = 3; e.data = '0x'; throw e; };
	assert.equal(await verify(dualProviders(chain(), { behave: { eth_call: revert } }).providers), 'RPC_DISAGREEMENT');
	assert.equal(await verify(dualProviders(chain(), {}, { behave: { eth_call: revert } }).providers), 'RPC_DISAGREEMENT');
	assert.equal(await verify(dualProviders(chain(), { behave: { eth_call: revert } }, { behave: { eth_call: revert } }).providers), 'INVALID_SIGNATURE');
});

test('DUAL 20b: both providers malicious and agreeing is NOT protected (documented limit)', async () => {
	const forge = { behave: { eth_call: () => MAGIC_RESULT } };
	assert.equal(await verify(dualProviders(chain(), forge, forge).providers, { signature: SIG_C }), 'VALID');
});

/* -------------------------------------------------------- decision table */

test('DUAL: consensus table - VALID only when both say VALID', () => {
	const V = 'VALID'; const I = 'INVALID'; const U = 'UNAVAILABLE';
	const table = [[V, V, 'VALID'], [V, I, 'RPC_DISAGREEMENT'], [I, V, 'RPC_DISAGREEMENT'], [V, U, 'RPC_UNAVAILABLE'], [U, V, 'RPC_UNAVAILABLE'], [I, I, 'INVALID_SIGNATURE'], [U, U, 'RPC_UNAVAILABLE'], [I, U, 'RPC_UNAVAILABLE'], [U, I, 'RPC_UNAVAILABLE']];
	for (const [a, b, expected] of table) assert.equal(combineErc1271Verdicts(a, b), expected, `${a}/${b}`);
	assert.ok(WALLET_SIG_RESULTS.includes('RPC_DISAGREEMENT'));
});

/* -------------------------------------------------------- configuration */

test('DUAL: a missing secondary (or primary) key means NO contract authentication - never single-provider', async () => {
	const saved = { a: process.env.ALCHEMY_API_KEY, i: process.env.INFURA_API_KEY };
	try {
		for (const [alchemy, infura] of [['present', undefined], [undefined, 'present'], [undefined, undefined], ['present', '   ']]) {
			if (alchemy) process.env.ALCHEMY_API_KEY = alchemy; else delete process.env.ALCHEMY_API_KEY;
			if (infura) process.env.INFURA_API_KEY = infura; else delete process.env.INFURA_API_KEY;
			assert.equal(erc1271Providers(), null);
			assert.equal(await verifyContractSiweSignature({ address: SAFE, message: MESSAGE, signature: SIG_A }), 'RPC_UNAVAILABLE');
		}
		// Ein injizierter einzelner Provider genuegt ebenfalls nie.
		const one = dualProviders(chain()).providers;
		assert.equal(await verify({ alchemy: one.alchemy }), 'RPC_UNAVAILABLE');
		assert.equal(await verify({ infura: one.infura }), 'RPC_UNAVAILABLE');
		process.env.ALCHEMY_API_KEY = 'a'; process.env.INFURA_API_KEY = 'b';
		const both = erc1271Providers();
		assert.ok(both.alchemy && both.infura && both.alchemy !== both.infura, 'zwei getrennte Clients');
	} finally {
		if (saved.a === undefined) delete process.env.ALCHEMY_API_KEY; else process.env.ALCHEMY_API_KEY = saved.a;
		if (saved.i === undefined) delete process.env.INFURA_API_KEY; else process.env.INFURA_API_KEY = saved.i;
	}
});

test('DUAL: EOA logins stay offline - not a single RPC call to either provider', async () => {
	const owner = privateKeyToAccount(generatePrivateKey());
	const { token } = auth.createDashboardChallenge(owner.address);
	const data = auth.verifyDashboardToken(token);
	const message = auth.dashboardMessage(data, owner.address);
	const { providers, logs } = dualProviders(chain());
	const r = await verifyWalletSiweAuthority({ message, signature: await owner.signMessage({ message }), expected: auth.dashboardSiweExpectation(data, owner.address) }, { providers });
	assert.deepEqual(r, { result: 'VALID', authority: 'eoa' });
	assert.equal(logs.alchemy.length + logs.infura.length, 0);
	// Feldfehler und Formatfehler loesen ebenfalls keinen RPC aus.
	const wrongField = await verifyWalletSiweAuthority({ message: message.replace('Chain ID: 1', 'Chain ID: 5'), signature: SIG_A, expected: auth.dashboardSiweExpectation(data, owner.address) }, { providers });
	assert.equal(wrongField.result, 'CHAIN_MISMATCH');
	assert.equal(await verify(providers, { signature: '0xzz' }), 'INVALID_SIGNATURE_FORMAT');
	assert.equal(logs.alchemy.length + logs.infura.length, 0);
});

test('DUAL: a contract-wallet login gets contract authority only through consensus', async () => {
	const c = chain();
	const { token } = auth.createDashboardChallenge(SAFE, Date.now(), auth.DASHBOARD_CHALLENGE_TTL_CONTRACT_MS);
	const data = auth.verifyDashboardToken(token);
	const message = auth.dashboardMessage(data, SAFE);
	const sig = ownerSignature(['a1'], hashMessage(message));
	const expected = auth.dashboardSiweExpectation(data, SAFE);
	assert.deepEqual(await verifyWalletSiweAuthority({ message, signature: sig, expected }, { providers: dualProviders(c).providers }), { result: 'VALID', authority: 'contract' });
	const split = dualProviders(c, {}, { behave: { eth_call: () => `0x${'0'.repeat(64)}` } });
	assert.deepEqual(await verifyWalletSiweAuthority({ message, signature: sig, expected }, { providers: split.providers }), { result: 'RPC_DISAGREEMENT', authority: null });
});

test('DUAL: "fresh signature not needed" for legacy sessions requires BOTH providers to report no code', async () => {
	const eoa = '0x1111111111111111111111111111111111111111';
	assert.equal(await noContractCodeByQuorum(eoa, { providers: dualProviders(chain()).providers }), true);
	assert.equal(await noContractCodeByQuorum(SAFE, { providers: dualProviders(chain()).providers }), false);
	assert.equal(await noContractCodeByQuorum(SAFE, { providers: dualProviders(chain(), { behave: { eth_getCode: () => '0x' } }).providers }), false, 'ein Provider luegt "kein Code"');
	assert.equal(await noContractCodeByQuorum(eoa, { providers: dualProviders(chain(), {}, { behave: { eth_getCode: timeout } }).providers }), false, 'Ausfall -> Bestaetigung noetig');
	assert.equal(await noContractCodeByQuorum(eoa, { providers: { alchemy: dualProviders(chain()).providers.alchemy } }), false);
});

test('DUAL: no result cache - the same signature is re-evaluated on every call', async () => {
	const c = chain();
	const { providers, logs } = dualProviders(c);
	assert.equal(await verify(providers), 'VALID');
	c.safes[SAFE.toLowerCase()].history.push({ from: 0n + N, owners: ['b2'], threshold: 1 });
	assert.equal(await verify(providers), 'INVALID_SIGNATURE');
	assert.equal(logs.alchemy.filter((l) => l.method === 'eth_call').length, 2);
});

test('DUAL: a provider that never answers cannot hang the request - the overall deadline fails closed', async () => {
	const hang = { behave: { eth_getCode: () => new Promise(() => {}) } };
	const { providers } = dualProviders(chain(), {}, hang);
	const started = Date.now();
	assert.equal(await verifyContractSiweSignature({ address: SAFE, message: MESSAGE, signature: SIG_A }, { providers, deadlineMs: 50 }), 'RPC_UNAVAILABLE');
	assert.ok(Date.now() - started < 2_000);
	const { ERC1271_DEADLINE_MS, RPC_TIMEOUT_MS } = await import('../src/contract-signature.mjs');
	assert.ok(ERC1271_DEADLINE_MS <= 20_000 && RPC_TIMEOUT_MS <= 6_000, 'begrenzte Wartezeit');
});
