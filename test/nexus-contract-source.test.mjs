/**
 * F-2Z-1 (18.10.2026): welcher Quellcode hinter welcher Nexus-Adresse steht.
 *
 * Offline. Grundlage sind zwei Mitschnitte des on-chain Runtime-Bytecodes
 * (test/fixtures/nexus/runtime-*.hex, eth_getCode bei drei RPCs identisch) und
 * die unabhaengige Rekompilierung der Kandidaten (contract-builds.json). Ein Pin
 * gilt nur, wenn der Build seines Tags dieselbe Laenge hat, sich nur in den vom
 * Compiler gemeldeten Immutable-Regionen unterscheidet, denselben Metadaten-Hash
 * traegt und die Immutables im Bytecode genau den gepinnten Werten entsprechen.
 * Funktionsnamen oder Selektoren allein reichen nie.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { keccak256, toFunctionSelector } from 'viem';

const { NEXUS_CONTRACT_SOURCES, NEXUS_CONTRACTS } = await import('../src/nexus-pinned.mjs');
const fixture = (name) => readFileSync(new URL(`./fixtures/nexus/${name}`, import.meta.url), 'utf8');
const BUILDS = JSON.parse(fixture('contract-builds.json')).builds;
const DEPLOYED = {
	CoverBroker: fixture('runtime-coverbroker-cb2b7366.hex').trim(),
	Cover: fixture('runtime-cover-impl-cafeaff1.hex').trim()
};
const SOURCES = JSON.parse(readFileSync(new URL('../security/crsf/sources.json', import.meta.url), 'utf8')).sources;

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** Solidity-CBOR-Trailer: die letzten zwei Bytes nennen seine Laenge. */
const trailer = (hex) => hex.slice(hex.length - 4 - 2 * parseInt(hex.slice(-4), 16));
function metadataCid(hex) {
	const cbor = trailer(hex);
	const at = cbor.indexOf('6970667358221220'); // "ipfs" + bytes(34) + multihash sha2-256
	if (at < 0) return null;
	let x = BigInt(`0x${cbor.slice(at + 12, at + 12 + 68)}`), s = '';
	while (x > 0n) { s = B58[Number(x % 58n)] + s; x /= 58n; }
	return s;
}
const lower = (v) => String(v).toLowerCase();

/** Prueft einen Pin gegen einen Build und den deployten Code. Liefert den ersten Grund fuer ein Nein. */
function verify(pin, build, deployedHex) {
	if (!build) return 'NO_BUILD_FOR_PINNED_SOURCE';
	const deployed = deployedHex.slice(2), compiled = build.runtime.slice(2);
	if (keccak256(deployedHex) !== pin.runtime.keccak256) return 'DEPLOYED_FIXTURE_NOT_PINNED_RUNTIME';
	for (const key of ['solc', 'optimizer', 'runs', 'evmVersion']) if (build.compiler[key] !== pin.compiler[key]) return `COMPILER_${key}`;
	if (compiled.length !== deployed.length) return 'LENGTH';
	const regions = Object.values(build.immutableReferences).flat();
	const inRegion = (i) => regions.some((r) => i >= r.start && i < r.start + r.length);
	// The CBOR trailer is the compiler's metadata section; a difference there alone is reported as METADATA below.
	const trailerStart = deployed.length / 2 - 2 - parseInt(deployed.slice(-4), 16);
	for (let i = 0; i < trailerStart; i++) if (compiled.substr(i * 2, 2) !== deployed.substr(i * 2, 2) && !inRegion(i)) return 'BYTES_OUTSIDE_IMMUTABLES';
	if (trailer(compiled) !== trailer(deployed) || metadataCid(deployed) !== pin.runtime.metadataCid) return 'METADATA';
	const names = Object.keys(build.immutableReferences).sort();
	if (JSON.stringify(names) !== JSON.stringify(Object.keys(pin.immutables).sort())) return 'IMMUTABLE_NAMES';
	for (const name of names) {
		const values = new Set(build.immutableReferences[name].map((r) => deployed.substr(r.start * 2, r.length * 2)));
		if (values.size !== 1) return `IMMUTABLE_INCONSISTENT_${name}`;
		const word = [...values][0];
		const pinned = lower(pin.immutables[name]).slice(2);
		if (word !== pinned.padStart(64, '0')) return `IMMUTABLE_${name}`;
	}
	return 'OK';
}
const buildFor = (pin) => BUILDS.find((b) => b.contract === pin.source.contract && b.tag === pin.source.tag && b.commit === pin.source.commit);
/** Funktions-Selektoren der Dispatcher-Vergleiche (PUSH4 sel, EQ, PUSH2 ziel, JUMPI). */
const dispatched = (hex) => new Set([...hex.slice(2).matchAll(/63([0-9a-f]{8})1461[0-9a-f]{4}57/g)].map((m) => m[1]));

test('SOURCE-BROKER the pinned CoverBroker source compiles to the deployed runtime except compiler-declared immutables', () => {
	const pin = NEXUS_CONTRACT_SOURCES.CoverBroker;
	assert.equal(lower(pin.address), lower(NEXUS_CONTRACTS.CoverBroker), 'the pin is about the address the read model knows');
	assert.equal(pin.proxy, false);
	assert.equal(verify(pin, buildFor(pin), DEPLOYED.CoverBroker), 'OK');
	assert.equal(lower(pin.immutables.cover), lower(NEXUS_CONTRACTS.Cover), 'the broker calls the pinned Cover proxy');
});

test('SOURCE-COVER the pinned Cover implementation source compiles to the deployed runtime except compiler-declared immutables', () => {
	const pin = NEXUS_CONTRACT_SOURCES.Cover;
	assert.equal(lower(pin.address), lower(NEXUS_CONTRACTS.Cover));
	assert.equal(pin.proxy, true);
	assert.match(pin.implementation, /^0x[0-9a-fA-F]{40}$/);
	assert.notEqual(lower(pin.implementation), lower(pin.address));
	assert.equal(verify(pin, buildFor(pin), DEPLOYED.Cover), 'OK');
	assert.equal(lower(pin.immutables.coverNFT), lower(NEXUS_CONTRACTS.CoverNFT));
	assert.equal(lower(pin.immutables.registry), lower(NEXUS_CONTRACTS.Registry));
	assert.equal(lower(pin.immutables.coverProducts), lower(NEXUS_CONTRACTS.CoverProducts));
});

test('SOURCE-INDEPENDENT broker and Cover are pinned separately; no other candidate build can stand in for either', () => {
	const { CoverBroker: broker, Cover: cover } = NEXUS_CONTRACT_SOURCES;
	assert.notEqual(broker.source.tag, cover.source.tag, 'two releases, not one release for both');
	for (const [name, pin] of [['CoverBroker', broker], ['Cover', cover]]) {
		const own = buildFor(pin);
		const others = BUILDS.filter((b) => b !== own);
		assert.ok(others.length >= 3);
		for (const other of others) assert.notEqual(verify(pin, other, DEPLOYED[name]), 'OK', `${other.contract} ${other.tag} must not verify as ${name}`);
	}
	// the old pin: v3.4.0 for the broker is a different program, not just other metadata
	const v34 = BUILDS.find((b) => b.contract === 'CoverBroker' && b.tag === 'v3.4.0');
	assert.equal(verify({ ...broker, source: { ...broker.source, tag: 'v3.4.0', commit: v34.commit } }, v34, DEPLOYED.CoverBroker), 'LENGTH');
	// Cover v3.4.0 differs from the deployed implementation only in its metadata - still not the pinned source
	const c34 = BUILDS.find((b) => b.contract === 'Cover' && b.tag === 'v3.4.0');
	assert.equal(verify(cover, c34, DEPLOYED.Cover), 'METADATA');
});

test('SOURCE-ABI the deployed broker dispatches exactly the functions of its pinned build; v3-only ABI entries are absent', () => {
	const pin = NEXUS_CONTRACT_SOURCES.CoverBroker;
	const own = buildFor(pin);
	const deployed = dispatched(DEPLOYED.CoverBroker);
	const expected = new Set(Object.values(own.methodIdentifiers));
	assert.deepEqual([...deployed].sort(), [...expected].sort());
	assert.equal(own.methodIdentifiers['buyCover((uint256,address,uint24,uint8,uint96,uint32,uint256,uint8,uint16,address,string),(uint256,uint256)[])'], '7c59cac4');
	// what @nexusmutual/deployments 3.2.0 lists for this address (v3 ABI) but the deployed code does not have
	for (const signature of ['pool()', 'registry()', 'tokenController()']) {
		const selector = toFunctionSelector(signature).slice(2);
		assert.ok(!deployed.has(selector), `${signature} must not be assumed for the deployed broker`);
		assert.ok(!(signature in own.methodIdentifiers));
	}
	for (const build of BUILDS.filter((b) => b.contract === 'CoverBroker' && b !== own)) {
		for (const [signature, selector] of Object.entries(build.methodIdentifiers)) if (!(signature in own.methodIdentifiers)) assert.ok(!deployed.has(selector), `${build.tag} ${signature}`);
	}
});

test('SOURCE-REGISTRY CRSF sources pin broker and Cover separately, consistent with the code pin and the fixtures', () => {
	const sha = (name) => createHash('sha256').update(fixture(name)).digest('hex');
	const byId = (id) => SOURCES.find((s) => s.id === id);
	for (const [id, pin, files] of [
		['SRC-NEXUS-COVERBROKER', NEXUS_CONTRACT_SOURCES.CoverBroker, ['runtime-coverbroker-cb2b7366.hex', 'contract-builds.json']],
		['SRC-NEXUS-COVER', NEXUS_CONTRACT_SOURCES.Cover, ['runtime-cover-impl-cafeaff1.hex', 'contract-builds.json']]
	]) {
		const source = byId(id);
		assert.ok(source, id);
		assert.equal(source.version, pin.source.tag, id);
		for (const part of [pin.source.commit, pin.compiler.solc, pin.compiler.evmVersion, pin.runtime.keccak256, pin.runtime.metadataCid, pin.address, ...(pin.implementation ? [pin.implementation] : [])]) assert.ok(source.pin.includes(part), `${id} pin must name ${part}`);
		for (const file of files) assert.ok(source.pin.includes(`${file} ${sha(file)}`), `${id} pins ${file} by hash`);
	}
	const old = byId('SRC-NEXUS-CONTRACTS');
	assert.doesNotMatch(`${old.title} ${old.pin}`, /CoverBroker (source|code) (is|=) v3/i);
	assert.match(old.pin, /not the CoverBroker source/i);
	assert.match(old.pin, /SRC-NEXUS-COVERBROKER/);
});
