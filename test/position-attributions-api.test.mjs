/*
	/api/position-attributions, Abgleich und Erinnerungen (14.10.2026).

	Der echte Handler mit echter Sitzungspruefung (HMAC-Cookie / Bearer), echter
	Body- und Content-Type-Pruefung und einer Datenbank im Arbeitsspeicher, die wie
	die Tabelle je Wallet filtert. Positionen und Covers sind Nachbauten in der
	Form von getWalletPositions / getWalletCovers. Kein Netz, keine Datenbank.
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.DASHBOARD_SESSION_SECRET = 'attributions-test-secret-0123456789abcdef-0123';
process.env.APP_BASE_URL = 'https://coverraccoon.com';

const { createAttributionsHandler } = await import('../api/position-attributions.mjs');
const { createDashboardSession, SESSION_COOKIE } = await import('../src/dashboard-auth.mjs');
const { checkRelation, reconcile, parseRelationBody } = await import('../src/position-attributions.mjs');
const { formatExpiryAlert, attributionContext } = await import('../src/alerts.mjs');
const { LookupNotAdmittedError } = await import('../src/positions/index.mjs');

const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const CORE = 'aave-v3-ethereum-core';
const LIDO = 'aave-v3-ethereum-lido';
const ETHERFI = 'aave-v3-ethereum-etherfi';
const NEXUS = { state: 'MATCHED', productId: 97, productName: 'Aave v3' };

const position = (deploymentKey, label, nexus = NEXUS) => ({ deploymentKey, label, nexus, supplied: [{ symbol: 'USDC', amount: '100' }], borrowed: [] });
const positionsOf = (wallet, { positions = [position(CORE, 'Core'), position(LIDO, 'Lido / Prime')], unavailable = [] } = {}) => ({
	ok: true, wallet, complete: unavailable.length === 0, positions: positions.filter((p) => !unavailable.includes(p.deploymentKey)),
	checkedDeployments: [CORE, LIDO, ETHERFI].map((deploymentKey) => ({ deploymentKey, status: unavailable.includes(deploymentKey) ? 'UNAVAILABLE' : 'OK' }))
});
const cover = (coverId, extra = {}) => ({ coverId, productId: 97, productName: 'Aave v3', status: 'active', amount: '10000', asset: { symbol: 'USDC' }, endsAt: '2026-11-28T00:00:00.000Z', ...extra });
const coversOf = (wallet, covers) => ({ apiVersion: 'agent.v1', wallet, covers });

/** Welt: Positionen/Covers je Wallet, Tabelle im Arbeitsspeicher, Aufrufprotokoll. */
function world() {
	const state = {
		positions: new Map([[A, positionsOf(A)], [B, positionsOf(B)]]),
		covers: new Map([[A, coversOf(A, [cover(1), cover(2)])], [B, coversOf(B, [cover(3)])]]),
		rows: [], calls: [], fail: {}
	};
	const deps = {
		getPositions: async (wallet) => { state.calls.push(['positions', wallet]); if (state.fail.positions) throw state.fail.positions; return state.positions.get(wallet) ?? positionsOf(wallet, { positions: [] }); },
		getCovers: async (wallet) => { state.calls.push(['covers', wallet]); if (state.fail.covers) throw new Error('rpc down'); return state.covers.get(wallet) ?? coversOf(wallet, []); },
		listRows: async (wallet) => { state.calls.push(['list', wallet]); if (state.fail.list) throw new Error('db'); return state.rows.filter((row) => row.wallet === wallet).map((row) => ({ ...row })); },
		upsertRow: async (relation) => {
			state.calls.push(['upsert', relation]);
			if (state.fail.upsert) throw new Error('db');
			const at = new Date(relation.now).toISOString();
			let row = state.rows.find((r) => r.wallet === relation.wallet && r.deployment_key === relation.deploymentKey && r.cover_id === relation.coverId);
			if (!row) { row = { wallet: relation.wallet, protocol_key: relation.protocolKey, protocol_version: relation.protocolVersion, deployment_key: relation.deploymentKey, product_id: relation.productId, cover_id: relation.coverId, source: 'user_confirmed' }; state.rows.push(row); }
			row.confirmed_at = at;
			return { deployment_key: row.deployment_key, product_id: row.product_id, cover_id: row.cover_id, source: row.source, confirmed_at: row.confirmed_at };
		},
		deleteRow: async (wallet, deploymentKey, coverId) => {
			state.calls.push(['delete', wallet, deploymentKey, coverId]);
			if (state.fail.delete) throw new Error('db');
			const before = state.rows.length;
			state.rows = state.rows.filter((r) => !(r.wallet === wallet && r.deployment_key === deploymentKey && r.cover_id === coverId));
			return before - state.rows.length;
		},
		isRevoked: async () => { if (state.fail.revoked) throw new Error('db'); return false; },
		rateLimit: async () => true,
		rateLimitFor: async () => true,
		now: () => Date.parse('2026-10-14T10:00:00Z')
	};
	return { state, handler: createAttributionsHandler(deps), deps };
}

const cookie = (wallet) => `${SESSION_COOKIE}=${encodeURIComponent(createDashboardSession(wallet))}`;
function res() {
	return { statusCode: null, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}
async function call(handler, { method = 'GET', wallet = A, body, headers = {}, query = {} } = {}) {
	const r = res();
	const h = { ...(wallet ? { cookie: cookie(wallet) } : {}), ...(method === 'GET' ? {} : { 'content-type': 'application/json' }), ...headers };
	await handler({ method, headers: h, query, body }, r);
	return r;
}
const rowsOf = (state, wallet) => state.rows.filter((r) => r.wallet === wallet).map((r) => [r.deployment_key, r.cover_id, r.source]);

/* ------------------------------------------------------- AUTH / ISOLATION */

test('1/2/3: unauthenticated GET, POST and DELETE are rejected without any lookup or write', async () => {
	const { state, handler } = world();
	for (const method of ['GET', 'POST', 'DELETE']) {
		const r = await call(handler, { method, wallet: null, body: { deploymentKey: CORE, coverId: 1 } });
		assert.equal(r.statusCode, 401, method);
		assert.equal(r.body.code, 'NO_SESSION');
	}
	assert.deepEqual(state.calls, []);
});

test('4/5: the wallet comes only from the session; body or query wallets are rejected', async () => {
	const { state, handler } = world();
	for (const body of [{ deploymentKey: CORE, coverId: 1, wallet: B }, { deploymentKey: CORE, coverId: 1, source: 'nexus_verified' }, { deploymentKey: CORE, coverId: 1, productId: 97 }, { deploymentKey: CORE, coverId: 1, verified: true }]) {
		const r = await call(handler, { method: 'POST', body });
		assert.equal(r.statusCode, 400, JSON.stringify(body));
		assert.equal(r.body.code, 'INVALID_BODY');
	}
	for (const query of [{ wallet: B }, { x: '1' }]) assert.equal((await call(handler, { query })).statusCode, 400);
	assert.deepEqual(state.rows, []);
	// Auch kein Header kann die Wallet setzen.
	const ok = await call(handler, { method: 'POST', body: { deploymentKey: CORE, coverId: 1 }, headers: { 'x-wallet': B, 'x-attribution-wallet': B, 'x-dashboard-wallet': B } });
	assert.equal(ok.statusCode, 200);
	assert.deepEqual(rowsOf(state, A), [[CORE, 1, 'user_confirmed']]);
	assert.deepEqual(rowsOf(state, B), []);
	assert.ok(state.calls.filter(([k]) => k === 'positions' || k === 'covers').every(([, wallet]) => wallet === A), 'nur die Sitzungs-Wallet wird gelesen');
});

test('6/7: wallet A can neither read nor delete wallet B relations', async () => {
	const { state, handler } = world();
	assert.equal((await call(handler, { method: 'POST', wallet: B, body: { deploymentKey: CORE, coverId: 3 } })).statusCode, 200);
	const read = await call(handler, { wallet: A });
	assert.deepEqual(read.body.attributions, []);
	const del = await call(handler, { method: 'DELETE', wallet: A, body: { deploymentKey: CORE, coverId: 3 } });
	assert.equal(del.statusCode, 200);
	assert.equal(del.body.deleted, false);
	assert.deepEqual(rowsOf(state, B), [[CORE, 3, 'user_confirmed']], 'B unveraendert');
	assert.ok(state.calls.filter(([k]) => k === 'delete').every(([, wallet]) => wallet === A));
});

test('8: cookie A + bearer B is a conflict and fails closed', async () => {
	const { state, handler } = world();
	for (const method of ['GET', 'POST', 'DELETE']) {
		const r = await call(handler, { method, wallet: A, headers: { authorization: `Bearer ${createDashboardSession(B)}` }, body: { deploymentKey: CORE, coverId: 1 } });
		assert.equal(r.statusCode, 401, method);
	}
	assert.deepEqual(state.rows, []);
	// Bearer allein (Safe-App) funktioniert.
	const safe = await call(handler, { method: 'POST', wallet: null, headers: { authorization: `Bearer ${createDashboardSession(B)}` }, body: { deploymentKey: CORE, coverId: 3 } });
	assert.equal(safe.statusCode, 200);
	assert.deepEqual(rowsOf(state, B), [[CORE, 3, 'user_confirmed']]);
});

test('HARDENING: writes need same origin and JSON; wrong methods 405; revocation errors 503', async () => {
	const { state, handler } = world();
	assert.equal((await call(handler, { method: 'POST', headers: { origin: 'https://evil.example' }, body: { deploymentKey: CORE, coverId: 1 } })).statusCode, 403);
	assert.equal((await call(handler, { method: 'POST', headers: { 'sec-fetch-site': 'cross-site' }, body: { deploymentKey: CORE, coverId: 1 } })).statusCode, 403);
	assert.equal((await call(handler, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: { deploymentKey: CORE, coverId: 1 } })).statusCode, 415);
	assert.equal((await call(handler, { method: 'POST', body: { deploymentKey: CORE, coverId: 1, pad: 'x'.repeat(2000) } })).statusCode, 413);
	assert.equal((await call(handler, { method: 'PUT' })).statusCode, 405);
	state.fail.revoked = true;
	assert.equal((await call(handler, { method: 'POST', body: { deploymentKey: CORE, coverId: 1 } })).statusCode, 503);
	assert.deepEqual(state.rows, []);
});

/* ------------------------------------------------------- WRITE VALIDATION */

test('9/19: a detected position + active same-product cover is stored once (idempotent), source user_confirmed', async () => {
	const { state, handler } = world();
	const first = await call(handler, { method: 'POST', body: { deploymentKey: CORE, coverId: 1 } });
	const second = await call(handler, { method: 'POST', body: { deploymentKey: CORE, coverId: 1 } });
	assert.equal(first.statusCode, 200);
	assert.equal(second.statusCode, 200);
	assert.deepEqual(first.body.attribution, { deploymentKey: CORE, coverId: 1, productId: 97, source: 'user_confirmed', confirmedAt: '2026-10-14T10:00:00.000Z' });
	assert.equal(state.rows.length, 1);
	assert.deepEqual(Object.keys(state.rows[0]).sort(), ['confirmed_at', 'cover_id', 'deployment_key', 'product_id', 'protocol_key', 'protocol_version', 'source', 'wallet']);
	// Ein Cover darf mehreren Maerkten, ein Markt mehreren Covers zugeordnet werden.
	assert.equal((await call(handler, { method: 'POST', body: { deploymentKey: LIDO, coverId: 1 } })).statusCode, 200);
	assert.equal((await call(handler, { method: 'POST', body: { deploymentKey: CORE, coverId: 2 } })).statusCode, 200);
	assert.equal(state.rows.length, 3);
});

test('10-18: every invalid relation is refused and nothing is written', async () => {
	const cases = [
		['10 unknown deployment', (s) => s, { deploymentKey: 'aave-v3-ethereum-horizon', coverId: 1 }, 422, 'UNKNOWN_DEPLOYMENT'],
		['11 no position in market', (s) => s.positions.set(A, positionsOf(A, { positions: [position(LIDO, 'Lido / Prime')] })), { deploymentKey: CORE, coverId: 1 }, 422, 'POSITION_NOT_FOUND'],
		['11 zero position', (s) => s.positions.set(A, positionsOf(A, { positions: [{ ...position(CORE, 'Core'), supplied: [], borrowed: [] }] })), { deploymentKey: CORE, coverId: 1 }, 422, 'POSITION_NOT_FOUND'],
		['12 market unavailable', (s) => s.positions.set(A, positionsOf(A, { unavailable: [CORE] })), { deploymentKey: CORE, coverId: 1 }, 503, 'POSITION_LOOKUP_UNAVAILABLE'],
		['12 positions lookup failed', (s) => { s.fail.positions = new Error('rpc'); }, { deploymentKey: CORE, coverId: 1 }, 503, 'POSITION_LOOKUP_UNAVAILABLE'],
		['12 covers lookup failed', (s) => { s.fail.covers = true; }, { deploymentKey: CORE, coverId: 1 }, 503, 'COVER_LOOKUP_UNAVAILABLE'],
		['12 catalog unavailable', (s) => s.positions.set(A, positionsOf(A, { positions: [position(CORE, 'Core', { state: 'UNAVAILABLE' })] })), { deploymentKey: CORE, coverId: 1 }, 503, 'PRODUCT_LOOKUP_UNAVAILABLE'],
		['13 unknown cover', (s) => s, { deploymentKey: CORE, coverId: 999 }, 422, 'COVER_NOT_FOUND'],
		['14 inactive cover', (s) => s.covers.set(A, coversOf(A, [cover(1, { status: 'expired' })])), { deploymentKey: CORE, coverId: 1 }, 422, 'COVER_INACTIVE'],
		['14 superseded cover', (s) => s.covers.set(A, coversOf(A, [cover(1, { status: 'superseded' })])), { deploymentKey: CORE, coverId: 1 }, 422, 'COVER_INACTIVE'],
		["15 cover of another wallet", (s) => s, { deploymentKey: CORE, coverId: 3 }, 422, 'COVER_NOT_FOUND'],
		['16 wrong productId', (s) => s.covers.set(A, coversOf(A, [cover(1, { productId: 98 })])), { deploymentKey: CORE, coverId: 1 }, 422, 'PRODUCT_MISMATCH'],
		['17 string productId', (s) => s.covers.set(A, coversOf(A, [cover(1, { productId: '97' })])), { deploymentKey: CORE, coverId: 1 }, 422, 'PRODUCT_MISMATCH'],
		['18 same name, other product', (s) => s.covers.set(A, coversOf(A, [cover(1, { productId: 1, productName: 'Aave v3' })])), { deploymentKey: CORE, coverId: 1 }, 422, 'PRODUCT_MISMATCH'],
		['demo cover', (s) => s.covers.set(A, coversOf(A, [cover(424242, { demo: true })])), { deploymentKey: CORE, coverId: 424242 }, 422, 'COVER_NOT_FOUND'],
		['position mapped to another product', (s) => s.positions.set(A, positionsOf(A, { positions: [position(CORE, 'Core', { state: 'MATCHED', productId: 98 })] })), { deploymentKey: CORE, coverId: 1 }, 422, 'PRODUCT_NOT_MATCHED'],
		['lookup returned another wallet', (s) => s.covers.set(A, coversOf(B, [cover(1)])), { deploymentKey: CORE, coverId: 1 }, 503, 'LOOKUP_WALLET_MISMATCH']
	];
	for (const [name, setup, body, status, code] of cases) {
		const { state, handler } = world();
		setup(state);
		const r = await call(handler, { method: 'POST', body });
		assert.equal(r.statusCode, status, name);
		assert.equal(r.body.code, code, name);
		assert.deepEqual(state.rows, [], name);
		assert.ok(!state.calls.some(([k]) => k === 'upsert'), name);
	}
	for (const body of [{ deploymentKey: CORE, coverId: '1' }, { deploymentKey: CORE, coverId: 0 }, { deploymentKey: CORE, coverId: -1 }, { deploymentKey: CORE, coverId: 1.5 }, { deploymentKey: 'CORE!', coverId: 1 }, { deploymentKey: CORE }, [], null, 'x']) {
		assert.equal(parseRelationBody(body), null, JSON.stringify(body));
	}
});

test('12b: an unavailable OTHER market does not block storing a relation for a positively detected market', async () => {
	const { state, handler } = world();
	state.positions.set(A, positionsOf(A, { unavailable: [ETHERFI] }));
	assert.equal((await call(handler, { method: 'POST', body: { deploymentKey: CORE, coverId: 1 } })).statusCode, 200);
	assert.equal(state.rows.length, 1);
});

test('MARK-AFTER-SUCCESS: a failed write is reported as unavailable, never as confirmed', async () => {
	const { state, handler } = world();
	state.fail.upsert = true;
	const r = await call(handler, { method: 'POST', body: { deploymentKey: CORE, coverId: 1 } });
	assert.equal(r.statusCode, 503);
	assert.equal(r.body.ok, false);
	assert.equal(r.body.attribution, undefined);
});

test('LIMIT: a wallet cannot store an unbounded number of relations', async () => {
	const { state, handler } = world();
	for (let i = 0; i < 60; i++) state.rows.push({ wallet: A, deployment_key: CORE, product_id: 97, cover_id: 10_000 + i, source: 'user_confirmed' });
	const r = await call(handler, { method: 'POST', body: { deploymentKey: CORE, coverId: 1 } });
	assert.equal(r.statusCode, 409);
	assert.equal(state.rows.length, 60);
});

/* ------------------------------------------------------- READ RECONCILIATION */

async function seeded(rows) {
	const w = world();
	for (const [deploymentKey, coverId] of rows) assert.equal((await call(w.handler, { method: 'POST', body: { deploymentKey, coverId } })).statusCode, 200);
	return w;
}

test('20: active relations are returned', async () => {
	const { handler } = await seeded([[CORE, 1], [LIDO, 2]]);
	const r = await call(handler);
	assert.deepEqual(r.body.attributions.map((a) => [a.deploymentKey, a.coverId, a.source]), [[CORE, 1, 'user_confirmed'], [LIDO, 2, 'user_confirmed']]);
	assert.equal(r.body.pending, 0);
});

test('21-24: expired, transferred, disappeared or mismatched relations are not returned and are deleted', async () => {
	const scenarios = [
		['21 expired', (s) => s.covers.set(A, coversOf(A, [cover(1, { status: 'expired' }), cover(2)]))],
		['22 transferred away', (s) => s.covers.set(A, coversOf(A, [cover(2)]))],
		['23 position gone', (s) => s.positions.set(A, positionsOf(A, { positions: [position(LIDO, 'Lido / Prime')] }))],
		['24 product mismatch (cover)', (s) => s.covers.set(A, coversOf(A, [cover(1, { productId: 98 }), cover(2)]))],
		['24 product mismatch (position)', (s) => s.positions.set(A, positionsOf(A, { positions: [position(CORE, 'Core', { state: 'MATCHED', productId: 98 }), position(LIDO, 'Lido / Prime')] }))]
	];
	for (const [name, change] of scenarios) {
		const { state, handler } = await seeded([[CORE, 1], [LIDO, 2]]);
		change(state);
		const r = await call(handler);
		assert.deepEqual(r.body.attributions.map((a) => [a.deploymentKey, a.coverId]), [[LIDO, 2]], name);
		assert.equal(r.body.removed, 1, name);
		assert.deepEqual(rowsOf(state, A).map(([k, c]) => [k, c]), [[LIDO, 2]], `${name}: nachweislich veraltete Zeile geloescht`);
	}
});

test('25: a failed or partial read never deletes and never shows stored relations', async () => {
	const scenarios = [
		['positions threw', (s) => { s.fail.positions = new Error('rpc'); }],
		['covers threw', (s) => { s.fail.covers = true; }],
		['market unavailable', (s) => s.positions.set(A, positionsOf(A, { unavailable: [CORE, LIDO] }))],
		['catalog unavailable', (s) => s.positions.set(A, positionsOf(A, { positions: [position(CORE, 'Core', { state: 'UNAVAILABLE' }), position(LIDO, 'Lido / Prime', { state: 'UNAVAILABLE' })] }))]
	];
	for (const [name, change] of scenarios) {
		const { state, handler } = await seeded([[CORE, 1], [LIDO, 2]]);
		change(state);
		const r = await call(handler);
		assert.equal(r.statusCode, 200, name);
		assert.deepEqual(r.body.attributions, [], name);
		assert.equal(r.body.pending, 2, name);
		assert.equal(state.rows.length, 2, `${name}: nichts geloescht`);
		assert.ok(!state.calls.some(([k]) => k === 'delete'), name);
	}
	const { state, handler } = await seeded([[CORE, 1]]);
	state.fail.list = true;
	assert.equal((await call(handler)).statusCode, 503, 'Datenbankfehler -> 503');
	state.fail.list = false;
	state.fail.positions = new LookupNotAdmittedError('budget');
	const r = res();
	let wrote = false;
	const h = createAttributionsHandler({ ...world().deps, listRows: async () => [{ wallet: A, deployment_key: CORE, product_id: 97, cover_id: 1, source: 'user_confirmed' }], getPositions: async () => { throw new LookupNotAdmittedError('budget'); }, deleteRow: async () => { wrote = true; return 1; } });
	await h({ method: 'GET', headers: { cookie: cookie(A) }, query: {} }, r);
	assert.equal(wrote, false, 'Budget erschoepft: nichts geloescht');
});

test('25b: a failed cleanup delete never changes what is returned', async () => {
	const { state, handler } = await seeded([[CORE, 1], [LIDO, 2]]);
	state.covers.set(A, coversOf(A, [cover(2)]));
	state.fail.delete = true;
	const r = await call(handler);
	assert.deepEqual(r.body.attributions.map((a) => a.coverId), [2]);
	assert.equal(r.body.removed, 0);
});

/* ------------------------------------------------------- DELETE */

test('26/27/28: own relation removable, repeat delete is safe, other wallets untouched', async () => {
	const { state, handler } = await seeded([[CORE, 1]]);
	assert.equal((await call(handler, { method: 'POST', wallet: B, body: { deploymentKey: CORE, coverId: 3 } })).statusCode, 200);
	const first = await call(handler, { method: 'DELETE', body: { deploymentKey: CORE, coverId: 1 } });
	const again = await call(handler, { method: 'DELETE', body: { deploymentKey: CORE, coverId: 1 } });
	assert.deepEqual([first.statusCode, first.body.deleted, again.statusCode, again.body.deleted], [200, true, 200, false]);
	assert.deepEqual(rowsOf(state, A), []);
	assert.deepEqual(rowsOf(state, B), [[CORE, 3, 'user_confirmed']]);
	assert.equal((await call(handler, { method: 'DELETE', body: { deploymentKey: CORE, coverId: 3, wallet: B } })).statusCode, 400);
	assert.deepEqual(rowsOf(state, B), [[CORE, 3, 'user_confirmed']]);
});

/* ------------------------------------------------------- AGENT */

const alertCover = cover(900001, { endsAt: new Date(Date.parse('2026-10-14T10:00:00Z') + 7 * 86_400_000).toISOString() });

test('36: a currently valid user confirmation enriches the reminder', async () => {
	const rows = [{ wallet: A, deployment_key: CORE, product_id: 97, cover_id: 900001, source: 'user_confirmed' }];
	const context = await attributionContext(A, alertCover, coversOf(A, [alertCover]), {}, { loadAttributions: async () => rows, loadPositions: async () => positionsOf(A) });
	assert.deepEqual(context, { positions: ['Core'] });
	assert.match(formatExpiryAlert(alertCover, 7, 'de', context), /Das Cover, das du deiner Aave-v3-Position Core zugeordnet hast, läuft innerhalb der nächsten 7 Tage aus\./);
	assert.match(formatExpiryAlert(alertCover, 7, 'en', context), /The cover you assigned to your Aave v3 position Core expires within 7 days\./);
	assert.doesNotMatch(formatExpiryAlert(alertCover, 7, 'de', context), /versicher|gedeckt|geschützt|abgesichert|Claim|verifiziert/i);
	assert.match(formatExpiryAlert(alertCover, 7, 'de', context), /\nCover-Betrag: \S.* USDC\n/, 'neutrales Label; Betragsformat unveraendert');
});

test('37: a stale or unverifiable confirmation falls back to the generic sentence', async () => {
	const rows = [{ wallet: A, deployment_key: CORE, product_id: 97, cover_id: 900001, source: 'user_confirmed' }];
	const generic = /Dein Cover läuft innerhalb der nächsten 7 Tage aus\./;
	const cases = [
		['position gone', { loadAttributions: async () => rows, loadPositions: async () => positionsOf(A, { positions: [] }) }, coversOf(A, [alertCover])],
		['market unavailable', { loadAttributions: async () => rows, loadPositions: async () => positionsOf(A, { unavailable: [CORE] }) }, coversOf(A, [alertCover])],
		['positions failed', { loadAttributions: async () => rows, loadPositions: async () => { throw new Error('rpc'); } }, coversOf(A, [alertCover])],
		['other product', { loadAttributions: async () => [{ ...rows[0], product_id: 98 }], loadPositions: async () => positionsOf(A) }, coversOf(A, [alertCover])],
		['wrong source', { loadAttributions: async () => [{ ...rows[0], source: 'auto' }], loadPositions: async () => positionsOf(A) }, coversOf(A, [alertCover])],
		['other wallet row', { loadAttributions: async () => [{ ...rows[0], wallet: B }], loadPositions: async () => positionsOf(A) }, coversOf(A, [alertCover])],
		['cover inactive', { loadAttributions: async () => rows, loadPositions: async () => positionsOf(A) }, coversOf(A, [{ ...alertCover, status: 'expired' }])]
	];
	for (const [name, deps, covers] of cases) {
		const context = await attributionContext(A, alertCover, covers, {}, deps);
		assert.equal(context, null, name);
		assert.match(formatExpiryAlert(alertCover, 7, 'de', context), generic, name);
	}
});

test('38: the reminder is still sent when the attribution lookup fails', async () => {
	const { checkExpiryAlerts } = await import('../src/alerts.mjs');
	const source = readFileSync(new URL('../src/alerts.mjs', import.meta.url), 'utf8');
	const loop = source.slice(source.indexOf('export async function checkExpiryAlerts('));
	assert.ok(loop.indexOf('attributionContext(') < loop.indexOf("_messageKind: 'expiry_alert'"));
	assert.match(source, /export async function attributionContext\([^)]*\) \{\n\ttry \{/, 'jeder Fehler endet im catch');
	assert.match(source, /\} catch \{\n\t\treturn null;\n\t\}\n\}/);
	const context = await attributionContext(A, alertCover, coversOf(A, [alertCover]), {}, { loadAttributions: async () => { throw new Error('db down'); }, loadPositions: async () => positionsOf(A) });
	assert.equal(context, null);
	assert.match(formatExpiryAlert(alertCover, 7, 'de', context), /⚠️ Cover-Ablaufwarnung/);
	assert.equal(typeof checkExpiryAlerts, 'function');
});

/* ------------------------------------------------------- SECURITY / SCHEMA */

test('42/43: the migration stores only identifiers - no proof of loss, no signature, no amounts, no verified flag', () => {
	const sql = readFileSync(new URL('../supabase/migrations/20261014120000_position_cover_attributions.sql', import.meta.url), 'utf8');
	const table = sql.slice(sql.indexOf('create table'), sql.indexOf(');', sql.indexOf('create table')));
	const columns = [...table.matchAll(/^\t([a-z_]+) /gm)].map((m) => m[1]).filter((c) => c !== 'constraint');
	assert.deepEqual(columns, ['id', 'wallet', 'protocol_key', 'protocol_version', 'deployment_key', 'product_id', 'cover_id', 'source', 'confirmed_at', 'created_at', 'updated_at']);
	assert.doesNotMatch(table, /proof|loss|signature|verified|covered|insured|amount|usd|balance|metadata|address/i);
	assert.match(table, /source text not null default 'user_confirmed' check \(source = 'user_confirmed'\)/);
	assert.match(table, /wallet text not null check \(wallet ~ '\^0x\[0-9a-f\]\{40\}\$'\)/);
	assert.match(table, /product_id integer not null check \(product_id = 97\)/);
	assert.match(table, /unique \(wallet, deployment_key, cover_id\)/);
	assert.doesNotMatch(sql, /unique \(wallet, cover_id\)|unique \(wallet, deployment_key\)/, 'ein Cover darf mehreren Maerkten zugeordnet werden');
	assert.match(sql, /alter table public\.position_cover_attributions enable row level security;/);
	assert.match(sql, /revoke all on table public\.position_cover_attributions from public, anon, authenticated;/);
	assert.match(sql, /grant select, insert, update, delete on table public\.position_cover_attributions to service_role;/);
	assert.doesNotMatch(sql, /grant [^;]* to (anon|authenticated)|create policy|security definer|create (or replace )?function/i);
	const api = readFileSync(new URL('../api/position-attributions.mjs', import.meta.url), 'utf8');
	assert.doesNotMatch(api, /request\.body\.wallet|request\.query\.wallet|verified\s*[:=]\s*true|covered\s*[:=]|insured\s*[:=]/);
	const db = readFileSync(new URL('../src/db.mjs', import.meta.url), 'utf8');
	const fn = db.slice(db.indexOf('export async function upsertPositionAttribution'), db.indexOf('export async function deletePositionAttribution'));
	assert.match(fn, /source: 'user_confirmed'/);
	assert.doesNotMatch(fn, /signature|proof|amount|verified/i);
});

test('DOMAIN: checkRelation and reconcile never trust a different wallet or a non-numeric product', () => {
	const ok = checkRelation({ wallet: A, deploymentKey: CORE, coverId: 1, positions: positionsOf(A), covers: coversOf(A, [cover(1)]) });
	assert.equal(ok.ok, true);
	assert.deepEqual(ok.relation, { wallet: A, protocolKey: 'aave', protocolVersion: 'v3', deploymentKey: CORE, productId: 97, coverId: 1 });
	assert.equal(checkRelation({ wallet: A, deploymentKey: CORE, coverId: 1, positions: positionsOf(B), covers: coversOf(A, [cover(1)]) }).code, 'LOOKUP_WALLET_MISMATCH');
	const rows = [{ wallet: B, deployment_key: CORE, product_id: 97, cover_id: 1, source: 'user_confirmed' }];
	const result = reconcile(rows, { wallet: A, positions: positionsOf(A), covers: coversOf(A, [cover(1)]) });
	assert.deepEqual([result.valid.length, result.stale.length, result.unknown.length], [0, 0, 0], 'fremde Zeile: weder zeigen noch loeschen');
	const unsupported = reconcile([{ wallet: A, deployment_key: 'aave-v3-ethereum-horizon', product_id: 97, cover_id: 1, source: 'user_confirmed' }], { wallet: A, positions: null, covers: null });
	assert.equal(unsupported.stale[0].reason, 'DEPLOYMENT_UNSUPPORTED', 'nicht mehr unterstuetzter Markt ist sicher veraltet');
});

test('DB: every attribution query is scoped to exactly one wallet', () => {
	const db = readFileSync(new URL('../src/db.mjs', import.meta.url), 'utf8');
	const list = db.slice(db.indexOf('export async function listPositionAttributions'), db.indexOf('export async function upsertPositionAttribution'));
	const del = db.slice(db.indexOf('export async function deletePositionAttribution'), db.indexOf('/*', db.indexOf('export async function deletePositionAttribution')));
	assert.match(list, /\.eq\('wallet', wallet\.toLowerCase\(\)\)/);
	assert.match(del, /\.match\(\{ wallet: wallet\.toLowerCase\(\), deployment_key: deploymentKey, cover_id: coverId \}\)/);
	const upsert = db.slice(db.indexOf('export async function upsertPositionAttribution'), db.indexOf('export async function deletePositionAttribution'));
	assert.match(upsert, /wallet: wallet\.toLowerCase\(\), protocol_key: protocolKey/);
	assert.match(upsert, /onConflict: 'wallet,deployment_key,cover_id'/);
});
