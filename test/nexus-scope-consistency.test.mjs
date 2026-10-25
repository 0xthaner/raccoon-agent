/*
	Deckungsumfang von Nexus-Produkt 97 je Aave-v3-Markt (25.10.2026).

	Nur Ethereum Core ist in der strengen Zuordnung (nexus-mapping.mjs) EXACT. Fuer
	Lido/Prime und EtherFi hat Nexus den Deckungsumfang nicht bestaetigt. Vorher
	meldete match-nexus.mjs fuer alle drei Maerkte MATCHED; das Dashboard zeigte
	"Produkt verfuegbar" und liess eine Cover-Zuordnung zu. Diese Tests binden
	alle Schichten an dieselbe strenge Tabelle: Anzeige-Match, Readiness,
	Zuordnungspruefung, Abgleich und Tabellenansicht.
*/
import test from 'node:test';
import assert from 'node:assert/strict';

import { AAVE_V3_MARKETS } from '../src/positions/aave-registry.mjs';
import { MATCH_STATES, matchDeployment } from '../src/positions/match-nexus.mjs';
import { mappingFor, matchPositionToNexus } from '../src/positions/nexus-mapping.mjs';
import { nexusMappingClass } from '../src/aave-cover-readiness.mjs';
import { checkRelation, reconcile } from '../src/position-attributions.mjs';
import { positionRows, positionStatus } from '../web/src/dashboard-shell.js';

const CORE = 'aave-v3-ethereum-core';
const LIDO = 'aave-v3-ethereum-lido';
const ETHERFI = 'aave-v3-ethereum-etherfi';
const WALLET = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const CATALOG = [{ productId: 97, officialName: 'Aave v3', normalizedName: 'aave v3', productType: 0, typeName: 'Single Protocol Cover', status: 'ACTIVE', deprecated: false }];

const marketOf = (key) => AAVE_V3_MARKETS.find((market) => market.deploymentKey === key);
const detected = (key, nexus) => {
	const market = marketOf(key);
	return { deploymentKey: key, label: market.label, chainId: 1, protocolKey: market.protocolKey, protocolVersion: market.protocolVersion, marketAddress: market.pool, nexus, supplied: [{ symbol: 'USDC', amount: '100', usdValue: '100' }], borrowed: [], totals: { suppliedUsd: '100', debtUsd: '0', netUsd: '100' } };
};
const positionsOf = (positions) => ({ wallet: WALLET, complete: true, positions, checkedDeployments: AAVE_V3_MARKETS.map((m) => ({ deploymentKey: m.deploymentKey, status: 'OK' })) });
const coversOf = (covers) => ({ wallet: WALLET, covers });
const cover = (coverId) => ({ coverId, productId: 97, status: 'active', endsAt: '2027-01-01T00:00:00.000Z' });
const row = (key, coverId) => ({ wallet: WALLET, deployment_key: key, product_id: 97, cover_id: coverId, source: 'user_confirmed', confirmed_at: '2026-10-13T10:00:00.000Z' });

test('SCOPE-MAP: only Core is MATCHED; Lido/Prime and EtherFi are SCOPE_UNCONFIRMED with product 97 named, never expanded', () => {
	assert.ok(MATCH_STATES.includes('SCOPE_UNCONFIRMED'));
	assert.deepEqual(matchDeployment(CORE, CATALOG), { state: 'MATCHED', productId: 97, productName: 'Aave v3' }, 'Core unveraendert');
	for (const key of [LIDO, ETHERFI]) {
		assert.deepEqual(matchDeployment(key, CATALOG), { state: 'SCOPE_UNCONFIRMED', productId: 97, productName: 'Aave v3', reason: 'NEXUS_SCOPE_UNCONFIRMED' }, key);
	}
	// Katalogfehler und eingestelltes Produkt gehen weiter vor - nie ein Treffer.
	for (const key of [CORE, LIDO, ETHERFI]) {
		assert.equal(matchDeployment(key, null).state, 'UNAVAILABLE', key);
		assert.equal(matchDeployment(key, [{ ...CATALOG[0], deprecated: true }]).state, 'PRODUCT_DEPRECATED', key);
		assert.equal(matchDeployment(key, []).state, 'NO_PRODUCT', key);
	}
	assert.equal(matchDeployment('aave-v3-ethereum-horizon', CATALOG).state, 'UNSUPPORTED');
});

test('SCOPE-CONSISTENCY: display match, strict mapping and purchase readiness agree for every registered market', () => {
	for (const market of AAVE_V3_MARKETS) {
		const key = market.deploymentKey;
		const exact = mappingFor(key)?.status === 'EXACT';
		const display = matchDeployment(key, CATALOG).state;
		const strict = matchPositionToNexus(detected(key, null)).status;
		const readiness = nexusMappingClass(detected(key, null)).class;
		assert.equal(display === 'MATCHED', exact, `${key}: Anzeige`);
		assert.equal(strict === 'EXACT', exact, `${key}: streng`);
		assert.equal(readiness === 'MATCHED', exact, `${key}: Readiness`);
	}
	assert.deepEqual(AAVE_V3_MARKETS.filter((m) => mappingFor(m.deploymentKey)?.status === 'EXACT').map((m) => m.deploymentKey), [CORE], 'nur Core');
	assert.equal(mappingFor('__proto__'), null);
	assert.equal(mappingFor('toString'), null);
});

test('SCOPE-CHECK: checkRelation refuses Lido/EtherFi even with a forged MATCHED position; Core is accepted as before', () => {
	const covers = coversOf([cover(1)]);
	for (const key of [LIDO, ETHERFI]) {
		for (const nexus of [{ state: 'SCOPE_UNCONFIRMED', productId: 97 }, { state: 'MATCHED', productId: 97 }]) {
			const result = checkRelation({ wallet: WALLET, deploymentKey: key, coverId: 1, positions: positionsOf([detected(key, nexus)]), covers });
			assert.deepEqual(result, { ok: false, code: 'COVERAGE_SCOPE_UNCONFIRMED' }, `${key} ${nexus.state}`);
		}
	}
	const core = checkRelation({ wallet: WALLET, deploymentKey: CORE, coverId: 1, positions: positionsOf([detected(CORE, { state: 'MATCHED', productId: 97 })]), covers });
	assert.equal(core.ok, true);
	assert.deepEqual(core.relation, { wallet: WALLET, protocolKey: 'aave', protocolVersion: 'v3', deploymentKey: CORE, productId: 97, coverId: 1 });
	// Ein anderes Produkt bleibt PRODUCT_NOT_MATCHED, nicht "Umfang unbestaetigt".
	assert.equal(checkRelation({ wallet: WALLET, deploymentKey: CORE, coverId: 1, positions: positionsOf([detected(CORE, { state: 'MATCHED', productId: 98 })]), covers }).code, 'PRODUCT_NOT_MATCHED');
});

test('SCOPE-RECONCILE: legacy rows become unconfirmed - never valid, never stale; Core rows unchanged', () => {
	const positions = positionsOf([detected(CORE, { state: 'MATCHED', productId: 97 }), detected(LIDO, { state: 'SCOPE_UNCONFIRMED', productId: 97 }), detected(ETHERFI, { state: 'SCOPE_UNCONFIRMED', productId: 97 })]);
	const result = reconcile([row(CORE, 1), row(LIDO, 1), row(ETHERFI, 2)], { wallet: WALLET, positions, covers: coversOf([cover(1), cover(2)]) });
	assert.deepEqual(result.valid.map((entry) => [entry.deploymentKey, entry.coverId, entry.label]), [[CORE, 1, 'Core']]);
	assert.deepEqual(result.unconfirmed.map((entry) => [entry.deploymentKey, entry.coverId, entry.reason]), [[LIDO, 1, 'NEXUS_SCOPE_UNCONFIRMED'], [ETHERFI, 2, 'NEXUS_SCOPE_UNCONFIRMED']]);
	assert.deepEqual(result.stale, [], 'der fehlende Deckungsumfang loescht nichts');
	assert.deepEqual(result.unknown, []);
	// Auch eine faelschlich MATCHED gemeldete Position macht die Zeile nicht gueltig.
	const forged = reconcile([row(LIDO, 1)], { wallet: WALLET, positions: positionsOf([detected(LIDO, { state: 'MATCHED', productId: 97 })]), covers: coversOf([cover(1)]) });
	assert.deepEqual([forged.valid.length, forged.unconfirmed.length, forged.stale.length], [0, 1, 0]);
	// Review N1: auch ein Lesefehler aendert an der Einstufung nichts - weder gueltig noch "pending".
	const unread = reconcile([row(LIDO, 1)], { wallet: WALLET, positions: null, covers: coversOf([cover(1)]) });
	assert.deepEqual([unread.valid.length, unread.unknown.length, unread.unconfirmed.length, unread.stale.length], [0, 0, 1, 0]);
});

/*
	Review N1, 25.10.2026: jede bisherige Stale-Regel und jeder Lesefehler gegen
	Lido/EtherFi (immer unconfirmed) und Core (Regeln wie bisher).
*/
const SCENARIOS = [
	// [Name, Positionen fuer den Markt, Covers, Erwartung Core]
	['cover expired', (key) => positionsOf([detected(key, nexusFor(key))]), coversOf([{ ...cover(1), status: 'expired' }]), 'stale:COVER_INACTIVE'],
	['cover transferred', (key) => positionsOf([detected(key, nexusFor(key))]), coversOf([cover(9)]), 'stale:COVER_NOT_IN_WALLET'],
	['empty but complete cover list', (key) => positionsOf([detected(key, nexusFor(key))]), coversOf([]), 'stale:COVER_NOT_IN_WALLET'],
	['cover of another product', (key) => positionsOf([detected(key, nexusFor(key))]), coversOf([{ ...cover(1), productId: 98 }]), 'stale:PRODUCT_MISMATCH'],
	['position gone', () => positionsOf([]), coversOf([cover(1)]), 'stale:POSITION_NOT_FOUND'],
	['position matched to another product', (key) => positionsOf([detected(key, { state: 'MATCHED', productId: 98 })]), coversOf([cover(1)]), 'stale:PRODUCT_MISMATCH'],
	['positions unreadable (RPC)', () => null, coversOf([cover(1)]), 'unknown:POSITION_LOOKUP_UNAVAILABLE'],
	['positions of another wallet', (key) => ({ ...positionsOf([detected(key, nexusFor(key))]), wallet: '0x' + 'b'.repeat(40) }), coversOf([cover(1)]), 'unknown:POSITION_LOOKUP_UNAVAILABLE'],
	['covers unreadable', (key) => positionsOf([detected(key, nexusFor(key))]), null, 'unknown:COVER_LOOKUP_UNAVAILABLE'],
	['nexus catalog unavailable', (key) => positionsOf([detected(key, { state: 'UNAVAILABLE' })]), coversOf([cover(1)]), 'unknown:PRODUCT_LOOKUP_UNAVAILABLE'],
	['still valid', (key) => positionsOf([detected(key, nexusFor(key))]), coversOf([cover(1)]), 'valid']
];
function nexusFor(key) { return key === CORE ? { state: 'MATCHED', productId: 97 } : { state: 'SCOPE_UNCONFIRMED', productId: 97 }; }
const outcome = (result) => {
	for (const bucket of ['valid', 'stale', 'unknown', 'unconfirmed']) {
		if (result[bucket].length) return bucket === 'valid' || bucket === 'unconfirmed' ? bucket : `${bucket}:${result[bucket][0].reason}`;
	}
	return 'none';
};

test('SCOPE-N1: Lido/EtherFi legacy rows are never deleted by any stale rule or read error and never valid; Core rules unchanged', () => {
	for (const [name, positions, covers, core] of SCENARIOS) {
		assert.equal(outcome(reconcile([row(CORE, 1)], { wallet: WALLET, positions: positions(CORE), covers })), core, `Core: ${name}`);
		for (const key of [LIDO, ETHERFI]) {
			const result = reconcile([row(key, 1)], { wallet: WALLET, positions: positions(key), covers });
			assert.deepEqual([result.valid.length, result.stale.length, result.unknown.length, result.unconfirmed.length], [0, 0, 0, 1], `${key}: ${name}`);
			assert.equal(result.unconfirmed[0].reason, 'NEXUS_SCOPE_UNCONFIRMED');
		}
	}
});

test('SCOPE-N1: the classification uses the strict table, never position.nexus', () => {
	const covers = coversOf([cover(1)]);
	// Eine (veraltete oder manipulierte) MATCHED-Position macht Lido weder gueltig noch loeschbar.
	for (const nexus of [{ state: 'MATCHED', productId: 97 }, { state: 'MATCHED', productId: 98 }, null, { state: 'NO_PRODUCT' }]) {
		const result = reconcile([row(LIDO, 1)], { wallet: WALLET, positions: positionsOf([detected(LIDO, nexus)]), covers });
		assert.deepEqual([result.valid.length, result.stale.length, result.unconfirmed.length], [0, 0, 1], JSON.stringify(nexus));
	}
	// Umgekehrt macht ein SCOPE_UNCONFIRMED-Status Core nicht zum Altbestand und nicht gueltig - nur "nicht entscheidbar".
	const core = reconcile([row(CORE, 1)], { wallet: WALLET, positions: positionsOf([detected(CORE, { state: 'SCOPE_UNCONFIRMED', productId: 97 })]), covers });
	assert.deepEqual([core.valid.length, core.stale.length, core.unconfirmed.length, core.unknown.map((u) => u.reason)], [0, 0, 0, ['PRODUCT_LOOKUP_UNAVAILABLE']]);
	// Fremde Zeilen bleiben unsichtbar, auch als Altbestand.
	const foreign = reconcile([{ ...row(LIDO, 1), wallet: '0x' + 'b'.repeat(40) }], { wallet: WALLET, positions: null, covers: null });
	assert.deepEqual([foreign.valid, foreign.stale, foreign.unknown, foreign.unconfirmed], [[], [], [], []]);
	// Fehlerhafte Zeilen bleiben "unknown" (MALFORMED), wie bisher.
	assert.equal(reconcile([{ ...row(LIDO, 1), source: 'auto' }], { wallet: WALLET, positions: null, covers: null }).unknown[0].reason, 'MALFORMED');
});

test('SCOPE-SHELL: the table view never shows Lido/EtherFi as attributed or as "product available"', () => {
	const lido = detected(LIDO, { state: 'SCOPE_UNCONFIRMED', productId: 97 });
	const confirmedEntry = { byPosition: new Map([[LIDO, { state: 'USER_CONFIRMED', covers: [cover(1)] }]]) };
	assert.equal(positionStatus(lido, confirmedEntry), 'SCOPE_UNCONFIRMED', 'auch mit einer (alten) Bestaetigung');
	assert.equal(positionStatus(lido, null), 'SCOPE_UNCONFIRMED');
	assert.equal(positionStatus(detected(CORE, { state: 'MATCHED', productId: 97 }), { byPosition: new Map([[CORE, { state: 'USER_CONFIRMED' }]]) }), 'ATTRIBUTED', 'Core unveraendert');
	const rows = positionRows({ status: 'ok', data: positionsOf([detected(CORE, { state: 'MATCHED', productId: 97 }), lido]) }, null);
	const byMarket = Object.fromEntries(rows.map((r) => [r.market, [r.status, r.product]]));
	assert.deepEqual(byMarket['Lido / Prime'], ['SCOPE_UNCONFIRMED', 'unconfirmed']);
	assert.equal(byMarket.Core[1], 'yes');
});
