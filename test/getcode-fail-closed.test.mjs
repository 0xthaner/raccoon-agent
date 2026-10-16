/**
 * F-2D-2 (CRSF Phase 2E): noContractCodeByQuorum zaehlt einen Provider nur dann
 * fuer "diese Adresse hat keinen Code", wenn er POSITIV ein wohlgeformtes
 * eth_getCode-Hex liefert. "0x" ist eine gueltige Aussage (kein Bytecode);
 * eine fehlende, leere oder kaputte Antwort ist UNBEKANNT - und UNBEKANNT ist
 * weder "0x" noch EOA.
 *
 * Die Antworten laufen auf Draht-Ebene durch einen echten viem-http-Transport
 * (test-support/rpc-wire.mjs, offline). Kontrolle in jedem Fall: dieselbe
 * Anordnung mit "0x" bei beiden Providern ergibt true - ein false kommt also
 * von der Validierung, nicht vom Testaufbau.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { wireProvider, rawResultProvider, rpcResult, OMIT } from '../test-support/rpc-wire.mjs';

const { noContractCodeByQuorum } = await import('../src/contract-signature.mjs');
const ADDRESS = '0x' + 'a1'.repeat(20);
const CODE = '0x608060405234801561001057600080fd5b50';

const valid = { '0x': rpcResult('0x'), bytecode: rpcResult(CODE) };
/** Jede Antwort, die KEINE positive, wohlgeformte Code-Aussage ist. */
const invalid = {
	'result omitted': rpcResult(OMIT),
	'result null': rpcResult(null),
	'result ""': rpcResult(''),
	'result "0"': rpcResult('0'),
	'result "0x0" (odd length)': rpcResult('0x0'),
	'result 0 (number)': rpcResult(0),
	'result false': rpcResult(false),
	'result {} (object)': rpcResult({}),
	'result ["0x"] (array)': rpcResult(['0x']),
	'result "0xzz" (malformed hex)': rpcResult('0xzz'),
	'result "0x6080 " (trailing space)': rpcResult('0x6080 '),
	'result "6080" (no prefix)': rpcResult('6080'),
	'malformed JSON body': () => ({ text: '{"jsonrpc":"2.0","id":', headers: { 'content-type': 'application/json' } }),
	'empty HTTP 200 body': () => ({ text: '' }),
	'empty HTTP 200 body (json content-type)': () => ({ text: '', headers: { 'content-type': 'application/json' } }),
	'JSON-RPC error': (id) => ({ json: { jsonrpc: '2.0', id, error: { code: -32000, message: 'header not found' } } }),
	'HTTP 500': () => ({ text: 'internal error', status: 500 }),
	'non-JSON-RPC shape': () => ({ json: { code: '0x' } }),
	'transport error (fetch throws)': () => 'throw',
	timeout: () => 'hang'
};
const quorum = (a, b) => noContractCodeByQuorum(ADDRESS, { providers: { alchemy: wireProvider(a).client, infura: wireProvider(b, { url: 'https://mainnet.infura.io/v3/offline' }).client } });

test('GETCODE control A: both providers positively report "0x" -> no contract code (true)', async () => {
	assert.equal(await quorum(valid['0x'], valid['0x']), true);
});

test('GETCODE B: both providers report valid bytecode -> false', async () => {
	assert.equal(await quorum(valid.bytecode, valid.bytecode), false);
});

test('GETCODE C/D/E: a missing, empty or malformed answer from either provider never counts as "0x"', async () => {
	for (const [label, bad] of Object.entries(invalid)) {
		assert.equal(await quorum(valid['0x'], bad), false, `C (P1 0x, P2 ${label})`);
		assert.equal(await quorum(bad, valid['0x']), false, `D (P1 ${label}, P2 0x)`);
		assert.equal(await quorum(bad, bad), false, `E (both ${label})`);
	}
});

test('GETCODE undefined result (transport returns undefined, which JSON cannot carry) is unknown, not "0x"', async () => {
	const ok = rawResultProvider('0x');
	assert.equal(await noContractCodeByQuorum(ADDRESS, { providers: { alchemy: ok, infura: ok } }), true, 'control');
	for (const [a, b] of [[rawResultProvider(undefined), ok], [ok, rawResultProvider(undefined)], [rawResultProvider(undefined), rawResultProvider(undefined)], [rawResultProvider(null), rawResultProvider(null)]]) {
		assert.equal(await noContractCodeByQuorum(ADDRESS, { providers: { alchemy: a, infura: b } }), false);
	}
});

test('GETCODE F: provider disagreement (one reports code, the other "0x") -> false', async () => {
	assert.equal(await quorum(valid.bytecode, valid['0x']), false);
	assert.equal(await quorum(valid['0x'], valid.bytecode), false);
});

test('GETCODE G: errors and timeouts on one or both providers -> false, within the transport timeout', async () => {
	const started = Date.now();
	for (const bad of [invalid['JSON-RPC error'], invalid['transport error (fetch throws)'], invalid.timeout, invalid['HTTP 500']]) {
		assert.equal(await quorum(bad, valid['0x']), false);
		assert.equal(await quorum(valid['0x'], bad), false);
		assert.equal(await quorum(bad, bad), false);
	}
	assert.ok(Date.now() - started < 10_000, 'bounded by the transport timeout');
});

test('GETCODE: exactly one eth_getCode request per provider, for the asked address at "latest"', async () => {
	const a = wireProvider(valid['0x']);
	const b = wireProvider(valid['0x'], { url: 'https://mainnet.infura.io/v3/offline' });
	assert.equal(await noContractCodeByQuorum(ADDRESS, { providers: { alchemy: a.client, infura: b.client } }), true);
	for (const { requests } of [a, b]) {
		assert.deepEqual(requests.map(({ method, params }) => [method, params]), [['eth_getCode', [ADDRESS, 'latest']]]);
	}
});

test('GETCODE: a missing provider (configuration) is not a quorum -> false', async () => {
	assert.equal(await noContractCodeByQuorum(ADDRESS, { providers: { alchemy: wireProvider(valid['0x']).client } }), false);
	assert.equal(await noContractCodeByQuorum(ADDRESS, { providers: {} }), false);
});
