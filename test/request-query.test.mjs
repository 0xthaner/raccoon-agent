/*
	Abfrageparameter aus der Request-URL statt Vercels vorbereitetem Query-Objekt
	(15.10.2026, DEP0169). Hier wird belegt, dass sich nichts am Verhalten aendert:
	der Helfer gegen das bisherige querystring.parse (der Kern von Vercels
	url.parse(url, true).query) und jeder betroffene Endpunkt mit echten URLs.
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import querystring from 'node:querystring';

process.env.DASHBOARD_SESSION_SECRET = 'request-query-test-secret-0123456789abcdef-012';
process.env.APP_BASE_URL = 'https://coverraccoon.com';

const { queryParams, queryKeys, singleQueryValue } = await import('../src/request-query.mjs');
/** Code ohne Kommentare: die Schranken pruefen, was ausgefuehrt wird, nicht was erklaert wird. */
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const { createPositionsHandler } = await import('../api/positions.mjs');
const { createAttributionsHandler } = await import('../api/position-attributions.mjs');
const { createDashboardSession, SESSION_COOKIE } = await import('../src/dashboard-auth.mjs');

/** So las Vercel bisher die Parameter: querystring.parse auf dem Teil nach `?` (ohne `#`). */
function legacyQuery(url) {
	const start = url.indexOf('?');
	if (start < 0) return {};
	const rest = url.slice(start + 1);
	const hash = rest.indexOf('#');
	return querystring.parse(hash < 0 ? rest : rest.slice(0, hash));
}

const CASES = [
	'/api/x', '/api/x?', '/api/x?&', '/api/x?&&', '/api/x?=', '/api/x?=v', '/api/x?code=abc',
	'/api/x?code=a&code=a', '/api/x?code=a&code=b', '/api/x?code', '/api/x?code=', '/api/x?code=&code=',
	'/api/x?wallet=', '/api/x?WALLET=1', '/api/x?%77allet=1', '/api/x?code=a%20b+c', '/api/x?code=%E2%82%AC',
	'/api/x?code=%ff', '/api/x?code=%zz', '/api/x?code=%', '/api/x?a=1#frag', '/api/x#only', '/api/x?__proto__=1',
	'/api/x?constructor=1', '/api/x?a[]=1', '/api/x?x=1;y=2', '/api/x?a=1=2', '/api/x?code=' + 'A'.repeat(5000),
	'/api/x?telegram=1', '/api/x?telegram=1&telegram=1', '/api/x?telegram=01', '/api/x?access=x&wallet=y', '/api/x??code=1'
];

test('helper parity: keys, single values and duplicates match the previous querystring parsing', () => {
	for (const url of CASES) {
		const old = legacyQuery(url);
		const params = queryParams({ url });
		// Gleiche Schluessel; nur die Reihenfolge kann abweichen (ganzzahlige Objekt-Schluessel stehen in JS vorn), und kein Handler haengt davon ab.
		assert.deepEqual([...queryKeys(params)].sort(), Object.keys(old).sort(), url);
		for (const name of new Set([...Object.keys(old), 'code', 'wallet', 'access', 'telegram'])) {
			const before = typeof old[name] === 'string' ? old[name] : '';
			assert.equal(singleQueryValue(params, name), before, `${url} -> ${name}`);
		}
	}
});

test('helper: no URL, no query, or a non-string URL means no parameters; the host is never read', () => {
	for (const request of [{}, { url: undefined }, { url: 42 }, { url: '/api/x' }, null]) assert.deepEqual(queryKeys(queryParams(request)), []);
	const params = queryParams({ url: '//evil.example/api/x?code=1', headers: { host: 'evil.example' } });
	assert.equal(singleQueryValue(params, 'code'), '1', 'nur der Abfrageteil zaehlt');
	const source = stripComments(readFileSync(new URL('../src/request-query.mjs', import.meta.url), 'utf8'));
	assert.doesNotMatch(source, /headers|host|new URL\(/i);
});

/* ------------------------------------------------------- Endpunkte */

function res() {
	return { statusCode: null, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}
const WALLET = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const cookie = { cookie: `${SESSION_COOKIE}=${encodeURIComponent(createDashboardSession(WALLET))}` };

test('/api/positions: no query passes; ANY query is rejected exactly as before (incl. ?wallet=, duplicates, empty keys)', async () => {
	const handler = createPositionsHandler({ getPositions: async (wallet) => ({ ok: true, wallet, positions: [] }), isRevoked: async () => false, rateLimit: async () => true, rateLimitFor: async () => true });
	const run = async (url) => { const r = res(); await handler({ method: 'GET', url, headers: cookie }, r); return [r.statusCode, r.body.code ?? null]; };
	for (const url of ['/api/positions', '/api/positions?', '/api/positions?&', '/api/positions#x']) assert.deepEqual(await run(url), [200, null], url);
	for (const url of ['/api/positions?wallet=', '/api/positions?wallet=0x1', '/api/positions?WaLLet=1', '/api/positions?%77allet=1', '/api/positions?wallet[]=1', '/api/positions?x=1&wallet=2']) {
		assert.deepEqual(await run(url), [400, 'WALLET_PARAMETER_NOT_ALLOWED'], url);
	}
	for (const url of ['/api/positions?=', '/api/positions?x', '/api/positions?x=1', '/api/positions?x=1&x=1', '/api/positions?x=1&x=2', '/api/positions?__proto__=1']) {
		assert.deepEqual(await run(url), [400, 'QUERY_NOT_ALLOWED'], url);
	}
});

test('/api/position-attributions: query parameters stay prohibited; a wallet can never come from the URL', async () => {
	const handler = createAttributionsHandler({
		getPositions: async () => { throw new Error('not reached'); }, getCovers: async () => { throw new Error('not reached'); },
		listRows: async () => [], upsertRow: async () => null, deleteRow: async () => 0, isRevoked: async () => false,
		rateLimit: async () => true, rateLimitFor: async () => true
	});
	const run = async (url, method = 'GET', headers = cookie) => { const r = res(); await handler({ method, url, headers: { ...headers, 'content-type': 'application/json' }, body: { deploymentKey: 'aave-v3-ethereum-core', coverId: 1 } }, r); return [r.statusCode, r.body.code ?? null]; };
	assert.deepEqual(await run('/api/position-attributions'), [200, null]);
	assert.deepEqual(await run('/api/position-attributions?'), [200, null]);
	for (const url of ['/api/position-attributions?wallet=', '/api/position-attributions?wallet=0x1', '/api/position-attributions?x=1&x=1', '/api/position-attributions?=', '/api/position-attributions?deploymentKey=aave-v3-ethereum-core']) {
		for (const method of ['GET', 'POST', 'DELETE']) assert.deepEqual(await run(url, method), [400, 'QUERY_NOT_ALLOWED'], `${method} ${url}`);
	}
	assert.deepEqual(await run('/api/position-attributions?wallet=0x1', 'GET', {}), [400, 'QUERY_NOT_ALLOWED'], 'vor jeder Sitzungspruefung');
});

/* Handler mit entfernten Imports laden (wie test/hard004.test.mjs), Abhaengigkeiten injiziert. */
function loadHandler(file, deps) {
	const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
	const body = source.replace(/^import .*;\n/gm, '').replace('export default async function handler', 'async function handler');
	return new Function(...Object.keys(deps), `${body}\nreturn handler;`)(...Object.values(deps));
}

test('/api/link: exact code validation, duplicates count as missing, encoded values decode as before', async () => {
	const linking = await import('../src/linking.mjs');
	const CODE = 'Abcdefghijklmnopqrstuv_-';
	const lookups = [];
	const handler = loadHandler('api/link.mjs', {
		isAddress: (v) => /^0x[0-9a-fA-F]{40}$/.test(v), queryParams, singleQueryValue,
		getPendingLink: async (code) => { lookups.push(code); return code === CODE ? { chat_id: '123', nonce: 'ab'.repeat(16), expires_at: Date.now() + 60_000, used_at: null } : null; },
		signingMessage: (p) => `msg:${p.wallet}`, enforceRateLimit: async () => true, ANMELDUNG_PAUSIERT: false, pauseAntwort: () => {},
		isTelegramLinkCode: linking.isTelegramLinkCode, isTelegramLinkRow: linking.isTelegramLinkRow,
		process: { env: {} }, fetch: async () => { throw new Error('offline'); }
	});
	const run = async (url) => { const r = res(); await handler({ method: 'GET', url, headers: {} }, r); return r; };
	const W = '0x2222222222222222222222222222222222222222';
	assert.equal((await run(`/api/link?code=${CODE}&wallet=${W}`)).body.message, `msg:${W}`);
	assert.equal((await run(`/api/link?code=%41bcdefghijklmnopqrstuv_-&wallet=${W}`)).body.message, `msg:${W}`, 'kodiertes A');
	for (const url of [`/api/link?code=${CODE}&code=${CODE}`, `/api/link?code=${CODE}&code=x`, '/api/link?code=', '/api/link?code', '/api/link', `/api/link?CODE=${CODE}`]) {
		assert.equal((await run(url)).statusCode, 410, url);
	}
	// Doppelte Wallet galt als "nicht gesetzt": dann nur die Konto-Anzeige, keine Signaturnachricht.
	const twice = await run(`/api/link?code=${CODE}&wallet=${W}&wallet=${W}`);
	assert.deepEqual([twice.statusCode, twice.body.message, 'telegram' in twice.body], [200, undefined, true]);
	assert.equal((await run(`/api/link?code=${CODE}&wallet=bad`)).statusCode, 400);
	assert.deepEqual(lookups.filter((c) => c !== CODE), [], 'ungueltige Codes erreichen die Datenbank nie');
});

test('/api/dashboard: access/wallet/telegram parameters behave exactly as before', async () => {
	const auth = await import('../src/dashboard-auth.mjs');
	const effects = [];
	const handler = loadHandler('api/dashboard.mjs', {
		isAddress: (v) => /^0x[0-9a-fA-F]{40}$/.test(v ?? ''), queryParams, singleQueryValue, ...auth,
		getWalletCovers: async () => ({ covers: [] }), verifyWalletSiweSignature: async () => 'INVALID_SIGNATURE', isDeployedContract: async () => false,
		beginTelegramDelivery: async () => null, finishTelegramDelivery: async () => {}, consumeDashboardAccess: async () => null, consumeDashboardChallenge: async () => false,
		getLanguage: async () => 'de', getWalletLinkStateByWallet: async () => ({ linked: false, link: null }), isDashboardSessionRevoked: async () => false,
		recordAgentEvent: async () => {}, revokeDashboardSessions: async () => { effects.push('revoke'); return Date.now(); },
		storeDashboardChallenge: async () => { effects.push('challenge'); }, unlinkWalletByWallet: async () => { effects.push('unlink'); return []; },
		ANMELDUNG_PAUSIERT: false, pauseAntwort: () => {}, enforceRateLimit: async () => true, enforceRateLimitFor: async () => true,
		requireJson: () => true, requireSameOrigin: () => true, recordSecurityEvent: async () => {}, securityFingerprint: () => 'fp', SECURITY_EVENT: {}
	});
	const run = async (url, method = 'GET', headers = {}) => { effects.length = 0; const r = res(); await handler({ method, url, headers }, r); return [r.statusCode, r.body?.code ?? null, [...effects]]; };
	assert.deepEqual(await run('/api/dashboard?access=abc'), [405, 'ACCESS_REDEEM_VIA_POST', []]);
	assert.deepEqual(await run('/api/dashboard?access=a&access=b'), [401, 'NO_SESSION', []], 'doppelter Zugangscode gilt als nicht gesetzt');
	assert.deepEqual(await run('/api/dashboard?access='), [401, 'NO_SESSION', []]);
	assert.deepEqual(await run('/api/dashboard?wallet=bad'), [400, null, []]);
	assert.deepEqual(await run(`/api/dashboard?wallet=${WALLET}`), [200, null, ['challenge']]);
	assert.deepEqual(await run(`/api/dashboard?wallet=${WALLET}&wallet=${WALLET}`), [401, 'NO_SESSION', []], 'doppelte Wallet gilt als nicht gesetzt');
	assert.deepEqual(await run('/api/dashboard', 'GET', cookie), [200, null, []]);
	assert.deepEqual((await run('/api/dashboard?telegram=1', 'DELETE', cookie)).slice(0, 1).concat([effects]), [200, ['unlink']]);
	assert.deepEqual((await run('/api/dashboard?telegram=1&telegram=1', 'DELETE', cookie))[2], ['revoke'], 'doppelt -> normaler Logout wie bisher');
	assert.deepEqual((await run('/api/dashboard?telegram=01', 'DELETE', cookie))[2], ['revoke']);
});

/* ------------------------------------------------------- Statische Schranke */

function files(dir) {
	return readdirSync(dir).flatMap((name) => { const path = join(dir, name); return statSync(path).isDirectory() ? files(path) : [path]; });
}

test('GUARD: server code reads no lazy query object and calls no url.parse', () => {
	const server = ['api', 'src'].flatMap((d) => files(new URL(`../${d}`, import.meta.url).pathname)).filter((f) => /\.m?js$/.test(f));
	for (const file of server) {
		const raw = readFileSync(file, 'utf8');
		const text = stripComments(raw);
		assert.doesNotMatch(raw, /\b(request|req)\.query\b/, `${file} (auch nicht in Kommentaren)`);
		assert.doesNotMatch(text, /url\.parse\(|\bparse as parseUrl\b|require\(['"](node:)?url['"]\)/, file);
	}
	for (const file of ['api/dashboard.mjs', 'api/link.mjs', 'api/positions.mjs', 'api/position-attributions.mjs']) {
		assert.match(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), /from '\.\.\/src\/request-query\.mjs'/, file);
	}
});

test('helper parity: 5000 deterministic random query strings from the critical characters', () => {
	// Nur Zeichen, die in einem HTTP-Request-Target vorkommen koennen (ASCII); rohe
	// Nicht-ASCII-Bytes sind dort nicht erlaubt - siehe den naechsten Test.
	const alphabet = ['a', 'b', 'c', '=', '&', '?', '%', '+', '#', '2', '0', 'f', 'F', ';', '[', ']', 'w', 'l', 'e', 't'];
	let seed = 0x5eed;
	const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
	for (let i = 0; i < 5000; i++) {
		let qs = '';
		const length = Math.floor(next() * 16);
		for (let j = 0; j < length; j++) qs += alphabet[Math.floor(next() * alphabet.length)];
		const url = `/api/x?${qs}`;
		const old = legacyQuery(url);
		const params = queryParams({ url });
		assert.deepEqual([...queryKeys(params)].sort(), Object.keys(old).sort(), JSON.stringify(url));
		for (const name of Object.keys(old)) assert.equal(singleQueryValue(params, name), typeof old[name] === 'string' ? old[name] : '', `${JSON.stringify(url)} -> ${name}`);
	}
});

test('known quirk: raw non-ASCII plus "%+xx" may decode differently, but no decision changes', async () => {
	// querystring.parse('é%+Fa') -> 'é% Fa', URLSearchParams -> '�% Fa'. Rohe Nicht-ASCII-Bytes sind im
	// Request-Target ungueltig (Clients kodieren sie); jede Entscheidung haengt an ASCII-Pruefungen.
	assert.equal(queryKeys(queryParams({ url: '/api/x?é%+Fa' }))[0], '�% Fa');
	const handler = createPositionsHandler({ getPositions: async (wallet) => ({ ok: true, wallet, positions: [] }), isRevoked: async () => false, rateLimit: async () => true, rateLimitFor: async () => true });
	for (const [url, code] of [['/api/positions?é%+Fa', 'QUERY_NOT_ALLOWED'], ['/api/positions?é%+Fawallet=1', 'WALLET_PARAMETER_NOT_ALLOWED']]) {
		const r = res();
		await handler({ method: 'GET', url, headers: cookie }, r);
		assert.deepEqual([r.statusCode, r.body.code], [400, code], url);
	}
	const linking = await import('../src/linking.mjs');
	for (const url of ['/api/x?code=é%+Fa', '/api/x?code=Abcdefghijklmnopqrstuv_é']) {
		const value = singleQueryValue(queryParams({ url }), 'code');
		assert.equal(linking.isTelegramLinkCode(value), false, 'Link-Code bleibt ungueltig');
		assert.equal(linking.isTelegramLinkCode(typeof legacyQuery(url).code === 'string' ? legacyQuery(url).code : ''), false);
	}
});
