/**
 * Wiederholungen der viem-RPC-Clients (11.10.2026).
 *
 * viem wiederholt fehlgeschlagene und zeitlich ueberschrittene Aufrufe
 * standardmaessig bis zu dreimal. Wo eine Anwendungs-Zeitgrenze die Antwort
 * aufgibt, ist das Lesearbeit im Hintergrund fuer niemanden - dort ist
 * retryCount 0 gesetzt. Wo der Aufruf im Request abgewartet wird und ein
 * einzelner Ausreisser sonst eine Anmeldung oder eine Ablauf-Erinnerung kostet,
 * bleiben die Wiederholungen bewusst an.
 *
 * Gezaehlt werden echte Transport-Versuche gegen ein Attrappen-fetch (HTTP 503).
 * Kein Netz.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

Object.assign(process.env, {
	ALCHEMY_API_KEY: 'test-alchemy-key',
	INFURA_API_KEY: 'test-infura-key',
	SUPABASE_URL: process.env.SUPABASE_URL || 'https://supabase.test.invalid',
	SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY || 'test-secret-key'
});

const attempts = [];
const infuraAttempts = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
	const u = String(url);
	if (u.startsWith('https://eth-mainnet.g.alchemy.com/v2/')) {
		attempts.push(JSON.parse(init.body).method);
		return new Response('unavailable', { status: 503 });
	}
	if (u.startsWith('https://mainnet.infura.io/v3/')) {
		infuraAttempts.push(JSON.parse(init.body).method);
		return new Response('unavailable', { status: 503 });
	}
	return realFetch(url, init);
};
test.after(() => { globalThis.fetch = realFetch; });

const WALLET = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const { isDeployedContract } = await import('../src/contract-detect.mjs');
const { verifyContractSiweSignature } = await import('../src/contract-signature.mjs');
const { getChainWalletCovers } = await import('../src/cover-chain.mjs');
const { getWalletPositions, _test: positions } = await import('../src/positions/index.mjs');

test('contract detection: one attempt, then fail closed (no background retries)', async () => {
	attempts.length = 0;
	await assert.rejects(isDeployedContract(WALLET, { cache: new Map() }));
	assert.deepEqual(attempts, ['eth_getCode']);
});

test('positions: one attempt per call, market UNAVAILABLE', async () => {
	attempts.length = 0;
	positions.reset();
	const result = await getWalletPositions(WALLET, { catalogLoader: async () => null });
	assert.equal(result.complete, false);
	assert.deepEqual(attempts, ['eth_blockNumber']);
});

test('ERC-1271 login keeps viem retries on purpose: a single 503 must not fail a Safe sign-in - at BOTH providers', async () => {
	attempts.length = 0;
	infuraAttempts.length = 0;
	const result = await verifyContractSiweSignature({ address: WALLET, message: 'coverraccoon.com wants you to sign in', signature: `0x${'ab'.repeat(65)}` });
	assert.equal(result, 'RPC_UNAVAILABLE', 'nach allen Versuchen weiterhin fail closed');
	// Dual-RPC: der erste Schritt (Kette + Kopf) laeuft bei beiden Providern, je 1 + 3 Versuche.
	const count = (list, method) => list.filter((m) => m === method).length;
	for (const [name, list] of [['alchemy', attempts], ['infura', infuraAttempts]]) {
		assert.equal(count(list, 'eth_chainId'), 4, `${name}: awaited in the request: 1 + 3 retries`);
		assert.equal(count(list, 'eth_blockNumber'), 4, name);
		assert.equal(count(list, 'eth_getCode') + count(list, 'eth_call'), 0, `${name}: ohne gemeinsamen Block kein Zustandslesen`);
	}
});

test('cover reads keep viem retries on purpose: a lost read can cost an expiry-day reminder', async () => {
	attempts.length = 0;
	const fetchImpl = async (url) => ({
		ok: true,
		json: async () => (String(url).includes('getNFTsForOwner') ? { ownedNfts: [{ contractAddress: '0xcafeaCa76be547F14D0220482667B42D8E7Bc3eb', tokenId: '1' }], totalCount: 1 } : [])
	});
	await assert.rejects(getChainWalletCovers(WALLET, { apiKey: 'test-alchemy-key', fetchImpl }));
	assert.deepEqual(attempts, ['eth_call', 'eth_call', 'eth_call', 'eth_call'], 'awaited in the request: 1 + 3 retries');
});

test('inventory: every server-side viem RPC client is one of the four reviewed ones', () => {
	const files = [];
	const walk = (dir) => {
		for (const name of readdirSync(dir)) {
			const path = join(dir, name);
			if (statSync(path).isDirectory()) walk(path);
			else if (/\.m?js$/.test(name) && readFileSync(path, 'utf8').includes('createPublicClient(')) files.push(path);
		}
	};
	walk('src');
	walk('api');
	assert.deepEqual(files.sort(), ['src/contract-detect.mjs', 'src/contract-signature.mjs', 'src/cover-chain.mjs', 'src/positions/index.mjs']);
	const source = (file) => readFileSync(file, 'utf8');
	assert.match(source('src/contract-detect.mjs'), /\{ timeout: 10_000, retryCount: 0 \}/);
	assert.match(source('src/positions/index.mjs'), /retryCount: 0/);
	assert.doesNotMatch(source('src/contract-signature.mjs'), /retryCount/);
	assert.doesNotMatch(source('src/cover-chain.mjs'), /retryCount/);
	for (const file of files) assert.doesNotMatch(source(file), /sendTransaction|writeContract|signTypedData|eth_sendRawTransaction/, file);
});
