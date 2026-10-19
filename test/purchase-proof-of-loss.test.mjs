/**
 * Nexus P4B (19.10.2026): Proof-of-Loss-Nutzlast fuer Produkt 97, nur lokal gebaut und geprueft.
 * Kein Netz, keine Signatur, keine Speicherung, keine CID. Nur die angemeldete Wallet.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { getAddress } from 'viem';

const L = await import('../src/purchase-proof-of-loss.mjs');

const WALLET = '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed';
const OTHER = '0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359';
const binding = { wallet: WALLET, owner: WALLET };
const payload = (patch = {}) => ({ creatorAddress: WALLET, proofOfLoss: [{ type: 'address', content: [{ address: WALLET }] }], ...patch });
const entry = (content, type = 'address') => payload({ proofOfLoss: [{ type, content }] });
const status = (p, b = binding) => L.validateProofOfLossPayload(p, b);

test('P4B-POL-BUILD the payload is exactly the wallet as creator and as the only address', () => {
	const r = L.buildProofOfLossPayload({ wallet: getAddress(WALLET) });
	assert.equal(r.ok, true);
	assert.deepEqual(r.payload, { creatorAddress: WALLET, proofOfLoss: [{ type: 'address', content: [{ address: WALLET }] }] });
	assert.deepEqual(Object.keys(r).sort(), ['ok', 'payload'], 'no CID, no id, no extra output');
	assert.ok(Object.isFrozen(r.payload) && Object.isFrozen(r.payload.proofOfLoss[0].content[0]));
	assert.deepEqual(status(r.payload), { status: 'VALID_LOCAL_PAYLOAD', errors: [] });
	assert.deepEqual(L.buildProofOfLossPayload({ wallet: '0x1234' }).errors, ['WALLET']);
	assert.deepEqual(L.buildProofOfLossPayload({ wallet: WALLET, label: 'main' }).errors, ['UNKNOWN_INPUT:label']);
	assert.deepEqual(L.buildProofOfLossPayload({ wallet: WALLET, addresses: [OTHER] }).errors, ['UNKNOWN_INPUT:addresses']);
});

test('P4B-POL-BINDING creator, address and owner must all be the authenticated wallet', () => {
	assert.equal(status(payload({ creatorAddress: getAddress(WALLET) })).status, 'VALID_LOCAL_PAYLOAD', 'checksummed spelling of the same wallet');
	assert.deepEqual(status(payload({ creatorAddress: OTHER })), { status: 'INVALID_WALLET_BINDING', errors: ['CREATOR_NOT_WALLET'] });
	assert.deepEqual(status(entry([{ address: OTHER }])), { status: 'INVALID_WALLET_BINDING', errors: ['ADDRESS_NOT_WALLET'] });
	assert.deepEqual(status(payload(), { wallet: WALLET, owner: OTHER }), { status: 'INVALID_WALLET_BINDING', errors: ['OWNER_NOT_WALLET'] });
	assert.deepEqual(status(payload(), { wallet: OTHER, owner: OTHER }), { status: 'INVALID_WALLET_BINDING', errors: ['CREATOR_NOT_WALLET', 'ADDRESS_NOT_WALLET'] });
	assert.equal(status(payload(), { wallet: WALLET }).status, 'INVALID_WALLET_BINDING');
	assert.equal(status(payload({ creatorAddress: 'not-an-address' })).status, 'INVALID_PAYLOAD');
});

test('P4B-POL-MINIMAL a second address, another entry or another type is rejected', () => {
	assert.ok(status(entry([{ address: WALLET }, { address: OTHER }])).errors.includes('ADDRESS_COUNT'));
	assert.ok(status(entry([{ address: WALLET }, { address: WALLET }])).errors.includes('ADDRESS_COUNT'), 'not even the same wallet twice');
	assert.ok(status(entry([])).errors.includes('ADDRESS_COUNT'));
	assert.ok(status(payload({ proofOfLoss: [{ type: 'address', content: [{ address: WALLET }] }, { type: 'address', content: [{ address: OTHER }] }] })).errors.includes('ENTRY_COUNT'));
	assert.ok(status(payload({ proofOfLoss: [] })).errors.includes('ENTRY_COUNT'));
	for (const type of ['free_text', 'api_key', 'csv', 'validator']) assert.equal(status(entry([{ address: WALLET }], type)).status, 'INVALID_PAYLOAD', type);
	assert.deepEqual(status(entry([{ address: WALLET }], 'free_text')).errors, ['ENTRY_TYPE']);
});

test('P4B-POL-PII personal, free-text, file and credential fields are rejected by name', () => {
	const cases = [
		[payload({ freeText: 'my funds were drained' }), 'FORBIDDEN_FIELD:payload.freeText'],
		[payload({ email: 'a@b.c' }), 'FORBIDDEN_FIELD:payload.email'],
		[payload({ name: 'Alice' }), 'FORBIDDEN_FIELD:payload.name'],
		[payload({ ip: '1.2.3.4' }), 'FORBIDDEN_FIELD:payload.ip'],
		[payload({ userAgent: 'x' }), 'FORBIDDEN_FIELD:payload.userAgent'],
		[payload({ publicData: { quotaShare: 1 } }), 'FORBIDDEN_FIELD:payload.publicData'],
		[payload({ apiKey: 'k' }), 'FORBIDDEN_FIELD:payload.apiKey'],
		[payload({ file: 'proof.pdf' }), 'FORBIDDEN_FIELD:payload.file'],
		[payload({ csv: 'a,b' }), 'FORBIDDEN_FIELD:payload.csv'],
		[payload({ notes: 'n' }), 'FORBIDDEN_FIELD:payload.notes'],
		[payload({ secondWallet: OTHER }), 'FORBIDDEN_FIELD:payload.secondWallet'],
		[entry([{ address: WALLET, label: 'main wallet' }]), 'FORBIDDEN_FIELD:content.label'],
		[entry([{ address: WALLET, value: 'text' }]), 'FORBIDDEN_FIELD:content.value'],
		[payload({ proofOfLoss: [{ type: 'address', content: [{ address: WALLET }], notes: 'x' }] }), 'FORBIDDEN_FIELD:entry.notes']
	];
	for (const [p, code] of cases) {
		const r = status(p);
		assert.equal(r.status, 'INVALID_PAYLOAD', code);
		assert.ok(r.errors.includes(code), `${code}: ${r.errors}`);
	}
	for (const field of ['name', 'email', 'ip', 'userAgent', 'apiKey', 'notes', 'freeText', 'file', 'csv', 'label', 'secondWallet']) assert.ok(L.FORBIDDEN_PROOF_OF_LOSS_FIELDS.includes(field), field);
	assert.deepEqual({ ...L.PROOF_OF_LOSS_POLICY, types: [...L.PROOF_OF_LOSS_POLICY.types] }, { productId: 97, types: ['address'], addressesPerPayload: 1, labels: false });
});

test('P4B-POL-SHAPE any unknown field anywhere makes the payload invalid', () => {
	assert.deepEqual(status(payload({ extra: 1 })).errors, ['PAYLOAD_SHAPE']);
	assert.ok(status(payload({ proofOfLoss: [{ type: 'address', content: [{ address: WALLET }], extra: 1 }] })).errors.includes('ENTRY_SHAPE'));
	assert.ok(status(entry([{ address: WALLET, extra: 1 }])).errors.includes('ADDRESS_SHAPE'));
	assert.deepEqual(status({ proofOfLoss: payload().proofOfLoss }).errors, ['PAYLOAD_SHAPE']);
	for (const bad of [null, [], 'x']) assert.equal(status(bad).status, 'INVALID_PAYLOAD');
});

test('P4B-POL-READINESS a locally valid payload stays blocked on Nexus confirmation; never ready for purchase', () => {
	const { payload: built } = L.buildProofOfLossPayload({ wallet: WALLET });
	const r = L.evaluateProofOfLossReadiness(built, binding);
	assert.equal(r.status, 'BLOCKED_NEXUS_CONFIRMATION');
	assert.equal(r.local, 'VALID_LOCAL_PAYLOAD');
	assert.equal(r.proofOfLoss, 'PROOF_OF_LOSS_UNRESOLVED');
	assert.deepEqual([...r.openQuestions], ['EMPTY_IPFS_DATA_CLAIM_VALIDITY', 'DISTRIBUTOR_CREATION_WITHOUT_WALLET_SIGNATURE', 'CREATOR_MUST_EQUAL_OWNER', 'IDEMPOTENCY_AND_RETRY', 'RETENTION_DELETION_ENCRYPTION', 'MANDATORY_DISTRIBUTOR_WORDING']);
	assert.equal(L.evaluateProofOfLossReadiness(payload({ creatorAddress: OTHER }), binding).status, 'INVALID_WALLET_BINDING');
	assert.equal(L.evaluateProofOfLossReadiness(payload({ email: 'x' }), binding).status, 'INVALID_PAYLOAD');
	assert.deepEqual([...L.PROOF_OF_LOSS_RESULTS], ['VALID_LOCAL_PAYLOAD', 'BLOCKED_NEXUS_CONFIRMATION', 'INVALID_WALLET_BINDING', 'INVALID_PAYLOAD']);
	for (const s of L.PROOF_OF_LOSS_RESULTS) assert.doesNotMatch(s, /READY|PURCHASE|SEND/);
	assert.ok(!Object.keys(r).some((k) => /cid|ipfs|hash/i.test(k)), 'no CID is produced');
});

/* ------------------------------------------------------------- Reinheit -- */

const code = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/.*$/gm, '');

test('P4B-POL-PURE no network, upload, signature, storage or CID in the proof-of-loss module', async () => {
	const source = code('src/purchase-proof-of-loss.mjs');
	const imports = [...source.matchAll(/^\s*import\s[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]);
	assert.deepEqual(imports, ['./purchase-intent.mjs']);
	assert.doesNotMatch(source, /\bimport\s*\(|fetch\s*\(|XMLHttpRequest|WebSocket|createPublicClient|createWalletClient|process\.|node:|require\s*\(|localStorage|indexedDB|supabase|Date\.now|new Date|globalThis/);
	assert.doesNotMatch(source, /cover-metadata|\/v2\/|POST|x-auth|signTypedData|eth_signTypedData|personal_sign|signMessage|Authentication|Nexus Mutual App|keccak|sha256|createHash|\bcid\b|\bipfs\b|base58|eth_sendTransaction|wallet_sendCalls|sendTransaction|writeContract|encodeFunctionData|approve\s*\(|buyCover/i);
	const realFetch = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = () => { calls++; throw new Error('network'); };
	try {
		const fresh = await import(`../src/purchase-proof-of-loss.mjs?pure=${Date.now()}`);
		const { payload: built } = fresh.buildProofOfLossPayload({ wallet: WALLET });
		fresh.evaluateProofOfLossReadiness(built, binding);
	} finally { globalThis.fetch = realFetch; }
	assert.equal(calls, 0);
});

function walk(dir) {
	const out = [];
	for (const name of readdirSync(new URL(`../${dir}`, import.meta.url))) {
		if (name === 'node_modules' || name.startsWith('.')) continue;
		const path = `${dir}/${name}`;
		if (statSync(new URL(`../${path}`, import.meta.url)).isDirectory()) out.push(...walk(path));
		else if (/\.(m?js|cjs|ts|tsx|jsx|html)$/.test(name)) out.push(path);
	}
	return out;
}

/** Die reinen Kauf-Module; sie duerfen einander importieren, sonst nur Tests. */
const PURE_PURCHASE = ['src/purchase-intent.mjs', 'src/purchase-terms.mjs', 'src/purchase-proof-of-loss.mjs'];

test('P4B-IMPORT no runtime code imports the terms or proof-of-loss module; only pure purchase modules and their tests do', () => {
	const runtime = [...walk('src'), ...walk('api'), ...walk('web'), ...walk('scripts')].filter((f) => !PURE_PURCHASE.includes(f));
	assert.ok(runtime.includes('src/bot.mjs') && runtime.some((f) => f.startsWith('api/')) && runtime.some((f) => f.startsWith('web/src/')) && runtime.some((f) => /^src\/agent-/.test(f)));
	for (const file of runtime) assert.doesNotMatch(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), /purchase-(terms|proof-of-loss)(\.mjs)?['"`]/, file);
	const importing = /(?:from\s*|import\s*\(\s*)['"`][^'"`]*purchase-(terms|proof-of-loss)\.mjs/;
	const importers = [...walk('src'), ...walk('test')].filter((f) => importing.test(readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'))).sort();
	assert.deepEqual(importers, ['test/purchase-proof-of-loss.test.mjs', 'test/purchase-terms.test.mjs']);
});
