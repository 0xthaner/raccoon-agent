/**
 * Dashboard-Anmeldung gegen echtes Postgres (CRSF Phase 2C, CR-AUTH-004 P1/P2, CR-AUTH-006 P1/P3).
 *
 * Der Dashboard-Handler laeuft mit den ECHTEN Challenge-Funktionen aus
 * src/db.mjs (storeDashboardChallenge, isDashboardChallengeOpen,
 * consumeDashboardChallenge) ueber test-support/pg-postgrest.mjs auf einer
 * Wegwerf-Datenbank mit allen Migrationen; die Kette ist das Dual-RPC-Modell.
 * So sind beide Schichten, die Ablauf, Einmaligkeit und Wallet-Bindung
 * erzwingen (Handler-Pruefung UND Datenbank-Praedikat), gleichzeitig echt im
 * Spiel - eine einzelne Schicht zu entfernen ist absichtlich wirkungslos.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { isAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { postgrestOverPg } from '../test-support/pg-postgrest.mjs';
import { dropTestDatabase } from '../test-support/drop-test-db.mjs';
import { simChain, dualProviders, executeSignMessageLib } from '../test-support/dual-rpc-sim.mjs';
import { queryParams, singleQueryValue } from '../src/request-query.mjs';

const URL_ = process.env.M1_DB_TEST_PG_URL;
const MODULE = process.env.M1_DB_TEST_PG_MODULE;
const skip = !URL_ || !MODULE ? 'M1_DB_TEST_PG_URL / M1_DB_TEST_PG_MODULE nicht gesetzt (Wegwerf-Postgres noetig)' : false;
const MIGRATIONS = new URL('../supabase/migrations/', import.meta.url);
const HOST = 'onchain-db-test.invalid';

process.env.SUPABASE_URL = `https://${HOST}`;
process.env.SUPABASE_SECRET_KEY = 'onchain-db-test-not-a-key';
process.env.DASHBOARD_SESSION_SECRET = 'onchain-db-test-secret-0123456789abcdef-012345';
process.env.APP_BASE_URL = 'https://coverraccoon.com';

let pg, dbUrl, rest, sql;
const connect = async () => { const c = new pg.Client({ connectionString: dbUrl, statement_timeout: 20_000 }); await c.connect(); return c; };
globalThis.fetch = (input, init) => rest.fetch(input, init);

const db = await import('../src/db.mjs');
const auth = await import('../src/dashboard-auth.mjs');
const cs = await import('../src/contract-signature.mjs');

async function setup() {
	pg = (await import(MODULE)).default;
	pg.types.setTypeParser(1184, (text) => text);
	// Wie PostgREST: bigint als JSON-Zahl (pg liefert int8 sonst als String).
	pg.types.setTypeParser(20, (text) => { const n = Number(text); if (!Number.isSafeInteger(n)) throw new Error('int8 ausserhalb von Number'); return n; });
	if (!/^postgres:\/\/[^@]*@(127\.0\.0\.1|localhost)[:/]/.test(URL_)) throw new Error('Nur gegen einen lokalen Wegwerf-Postgres.');
	const admin = new pg.Client({ connectionString: URL_ });
	await admin.connect();
	const name = `onchain_${process.pid}`;
	await admin.query(`drop database if exists ${name} with (force)`);
	await admin.query(`create database ${name}`);
	for (const role of ['anon', 'authenticated', 'service_role', 'supabase_admin']) {
		await admin.query(`do $$ begin if not exists (select 1 from pg_roles where rolname = '${role}') then create role ${role}; end if; end $$`);
	}
	await admin.end();
	dbUrl = URL_.replace(/\/[^/]*$/, `/${name}`);
	const c = await connect();
	for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) await c.query(readFileSync(new URL(file, MIGRATIONS), 'utf8'));
	await c.end();
	rest = postgrestOverPg({ host: HOST, connect, maxConnections: 30 });
	await rest.warm(30);
	sql = await connect();
}

const ATTACKER_SAFE = '0x5afe00000000000000000000000000000000a00a';
const VICTIM_SAFE = '0x5afe00000000000000000000000000000000b00b';
const freshChain = () => simChain({ head: 20_000_000n, safes: {
	[ATTACKER_SAFE]: { history: [{ from: 0n, owners: ['b2'], threshold: 1 }] },
	[VICTIM_SAFE]: { history: [{ from: 0n, owners: ['c3'], threshold: 1 }] }
} });
const strip = (path) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/^import [^;]*;\n/gm, '').replace('export default async function handler', 'async function handler');
const load = (path, deps) => new Function(...Object.keys(deps), `${strip(path)}\nreturn handler;`)(...Object.values(deps));

function server() {
	const chain = freshChain();
	const { providers } = dualProviders(chain);
	const handler = load('../api/dashboard.mjs', {
		...auth, isAddress, queryParams, singleQueryValue,
		storeDashboardChallenge: (row) => db.storeDashboardChallenge(row),
		isDashboardChallengeOpen: (nonce, wallet) => db.isDashboardChallengeOpen(nonce, wallet),
		consumeDashboardChallenge: (nonce, wallet) => db.consumeDashboardChallenge(nonce, wallet),
		verifyWalletSiweAuthority: (params) => cs.verifyWalletSiweAuthority(params, { providers }),
		verifyOnchainDashboardLoginApproval: (params) => cs.verifyOnchainDashboardLoginApproval(params, { providers }),
		noContractCodeByQuorum: (wallet) => cs.noContractCodeByQuorum(wallet, { providers }),
		isDeployedContract: async (wallet) => (await cs.noContractCodeByQuorum(wallet, { providers })) === false,
		enforceRateLimit: async () => true, enforceRateLimitFor: async () => true, requireSameOrigin: () => true, requireJson: () => true,
		recordSecurityEvent: async () => {}, securityFingerprint: () => 'fp',
		SECURITY_EVENT: { ERC1271_RPC_DISAGREEMENT: 'disagreement', SIWE_SIGNATURE_INVALID: 'invalid', SIWE_REPLAY_BLOCKED: 'replay', ACCESS_CODE_INVALID: 'access' },
		ANMELDUNG_PAUSIERT: false, pauseAntwort: () => {},
		getWalletCovers: async () => ({ covers: [] }), getWalletLinkStateByWallet: async () => ({ linked: false, link: null }),
		isDashboardSessionRevoked: (wallet, iat) => db.isDashboardSessionRevoked(wallet, iat), recordAgentEvent: async () => {}, consumeDashboardAccess: async () => null,
		getLanguage: async () => 'de', beginTelegramDelivery: async () => null, finishTelegramDelivery: async () => {},
		revokeDashboardSessions: (wallet) => db.revokeDashboardSessions(wallet), unlinkWalletByWallet: async () => [], unlinkWalletFromAllChats: async () => []
	});
	return { chain, handler };
}
async function call(handler, url, { method = 'GET', body, cookie } = {}) {
	const r = { statusCode: null, body: null, headers: {}, status(c) { this.statusCode = c; return this; }, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, json(b) { this.body = b; return this; } };
	await handler({ method, url, headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.9.0.1', ...(cookie ? { cookie } : {}) }, body }, r);
	return r;
}
const challengeFor = async (srv, wallet) => (await call(srv.handler, `/api/dashboard?wallet=${wallet}`)).body;
const postOnchain = (srv, body) => call(srv.handler, '/api/dashboard', { method: 'POST', body: { approval: 'onchain', ...body } });
function rawSession(r) {
	const cookie = String(r.headers['set-cookie'] ?? '');
	return decodeURIComponent((cookie.match(new RegExp(`${auth.SESSION_COOKIE}=([^;]+)`)) ?? [])[1] ?? '');
}
function sessionOf(r) {
	const raw = rawSession(r);
	return raw ? auth.verifyDashboardSession(raw) : null;
}
const VICTIM_EOA = privateKeyToAccount(`0x${'4c'.repeat(32)}`);
const ATTACKER_EOA = privateKeyToAccount(`0x${'5d'.repeat(32)}`);
/** Signature login (mode A) through the real handler. */
async function eoaLogin(srv, account, { challengeWallet = account.address, claimedWallet = account.address, signedFor = claimedWallet } = {}) {
	const { token } = await challengeFor(srv, challengeWallet);
	const message = auth.dashboardMessage(auth.verifyDashboardToken(token), signedFor);
	const signature = await account.signMessage({ message });
	return { token, response: await call(srv.handler, '/api/dashboard', { method: 'POST', body: { wallet: claimedWallet, token, signature } }) };
}
const row = async (token) => (await sql.query('select wallet, used_at, expires_at from public.dashboard_challenges where nonce = $1', [auth.verifyDashboardToken(token).nonce])).rows[0];

test('DASHBOARD-LOGIN-DB', { skip, timeout: 300_000 }, async (t) => {
	await setup();
	t.after(async () => { await sql?.end(); await rest?.close(); await dropTestDatabase(pg, URL_, dbUrl); });

	await t.test('ONCHAIN-DB: an approved, open challenge logs in exactly its own Safe (positive control)', async () => {
		const srv = server();
		const { token, message } = await challengeFor(srv, ATTACKER_SAFE);
		assert.equal((await postOnchain(srv, { wallet: ATTACKER_SAFE, token })).statusCode, 202, 'before approval: pending');
		executeSignMessageLib(srv.chain, ATTACKER_SAFE, message);
		const ok = await postOnchain(srv, { wallet: ATTACKER_SAFE, token });
		assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));
		assert.equal(sessionOf(ok)?.wallet, ATTACKER_SAFE);
		assert.equal(sessionOf(ok)?.kind, 'contract');
		assert.notEqual((await row(token)).used_at, null, 'consumed in Postgres');
	});

	await t.test('ONCHAIN-DB-EXPIRY: a challenge whose stored row expired never logs in, even with a valid token and an on-chain approval', async () => {
		const srv = server();
		const { token, message } = await challengeFor(srv, ATTACKER_SAFE);
		executeSignMessageLib(srv.chain, ATTACKER_SAFE, message);
		await sql.query(`update public.dashboard_challenges set expires_at = now() - interval '1 second' where nonce = $1`, [auth.verifyDashboardToken(token).nonce]);
		const r = await postOnchain(srv, { wallet: ATTACKER_SAFE, token });
		assert.notEqual(r.statusCode, 200);
		assert.equal(sessionOf(r), null, 'no session for an expired challenge');
		assert.equal((await row(token)).used_at, null, 'nothing consumed');
	});

	await t.test('ONCHAIN-DB-SINGLE-USE: one approval yields one session - sequentially and under 10 concurrent posts', async () => {
		const srv = server();
		const first = await challengeFor(srv, ATTACKER_SAFE);
		executeSignMessageLib(srv.chain, ATTACKER_SAFE, first.message);
		assert.equal((await postOnchain(srv, { wallet: ATTACKER_SAFE, token: first.token })).statusCode, 200);
		const again = await postOnchain(srv, { wallet: ATTACKER_SAFE, token: first.token });
		assert.notEqual(again.statusCode, 200);
		assert.equal(sessionOf(again), null, 'a consumed approval never yields a second session');
		const second = await challengeFor(srv, ATTACKER_SAFE);
		executeSignMessageLib(srv.chain, ATTACKER_SAFE, second.message);
		const results = await rest.race(10, () => postOnchain(srv, { wallet: ATTACKER_SAFE, token: second.token }));
		assert.equal(results.filter((r) => sessionOf(r)).length, 1, 'exactly one session from 10 concurrent posts');
	});

	await t.test('ONCHAIN-DB-BINDING: an attacker Safe cannot obtain a session for another wallet with its own challenge and approval', async () => {
		const srv = server();
		const { token } = await challengeFor(srv, ATTACKER_SAFE);
		// The attacker approves, on its own Safe, exactly the text the server would build for the victim wallet.
		const victimText = auth.dashboardMessage(auth.verifyDashboardToken(token), VICTIM_SAFE);
		executeSignMessageLib(srv.chain, ATTACKER_SAFE, victimText);
		const r = await postOnchain(srv, { wallet: VICTIM_SAFE, token });
		assert.notEqual(r.statusCode, 200);
		assert.equal(sessionOf(r), null, 'no session for the victim wallet');
		assert.equal((await row(token)).used_at, null, 'the attacker challenge is not consumed either');
	});

	await t.test('ONCHAIN-DB-BINDING: an approval of a different challenge or by a different Safe never logs in', async () => {
		const srv = server();
		const a = await challengeFor(srv, ATTACKER_SAFE);
		const b = await challengeFor(srv, ATTACKER_SAFE);
		executeSignMessageLib(srv.chain, ATTACKER_SAFE, a.message);
		const wrongChallenge = await postOnchain(srv, { wallet: ATTACKER_SAFE, token: b.token });
		assert.equal(sessionOf(wrongChallenge), null, 'approval of challenge A does not open challenge B');
		const v = await challengeFor(srv, VICTIM_SAFE);
		executeSignMessageLib(srv.chain, ATTACKER_SAFE, v.message);
		const wrongSafe = await postOnchain(srv, { wallet: VICTIM_SAFE, token: v.token });
		assert.equal(sessionOf(wrongSafe), null, 'another Safe approving the victim text does not log the victim in');
	});

	await t.test('LOGIN-BINDING: a valid EOA login yields a session for exactly the signing wallet (positive control)', async () => {
		const srv = server();
		const { response } = await eoaLogin(srv, VICTIM_EOA);
		assert.equal(response.statusCode, 200, JSON.stringify(response.body));
		assert.equal(sessionOf(response)?.wallet, VICTIM_EOA.address.toLowerCase());
		assert.equal(sessionOf(response)?.kind, 'eoa');
	});

	await t.test('LOGIN-BINDING: an attacker key cannot turn the victim challenge into a session for anyone', async () => {
		const srv = server();
		const victim = VICTIM_EOA.address;
		const own = await eoaLogin(srv, ATTACKER_EOA, { challengeWallet: victim, claimedWallet: ATTACKER_EOA.address });
		assert.notEqual(own.response.statusCode, 200, 'victim challenge + attacker wallet + attacker signature');
		assert.equal(sessionOf(own.response), null);
		assert.equal((await row(own.token)).used_at, null, 'victim challenge not consumed');
		const claimVictim = await eoaLogin(srv, ATTACKER_EOA, { challengeWallet: victim, claimedWallet: victim, signedFor: victim });
		assert.notEqual(claimVictim.response.statusCode, 200, 'victim challenge + victim wallet + attacker signature');
		assert.equal(sessionOf(claimVictim.response), null);
	});

	await t.test('LOGIN-FRESH: every login issues a new token; a login after logout is a fresh, unrevoked session', async () => {
		const srv = server();
		const first = await eoaLogin(srv, VICTIM_EOA);
		assert.equal(first.response.statusCode, 200);
		const firstToken = rawSession(first.response);
		await new Promise((resolve) => setTimeout(resolve, 5));
		const logout = await call(srv.handler, '/api/dashboard', { method: 'DELETE', cookie: `${auth.SESSION_COOKIE}=${encodeURIComponent(firstToken)}` });
		assert.equal(logout.statusCode, 200, JSON.stringify(logout.body));
		await new Promise((resolve) => setTimeout(resolve, 5));
		const second = await eoaLogin(srv, VICTIM_EOA);
		assert.equal(second.response.statusCode, 200);
		const secondToken = rawSession(second.response);
		assert.notEqual(secondToken, firstToken, 'a new token');
		const s1 = auth.verifyDashboardSession(firstToken), s2 = auth.verifyDashboardSession(secondToken);
		assert.ok(s2.iat > s1.iat, 'issued later');
		assert.equal(await db.isDashboardSessionRevoked(s1.wallet, s1.iat), true, 'the old session is revoked');
		assert.equal(await db.isDashboardSessionRevoked(s2.wallet, s2.iat), false, 'the new session is not revoked');
		const read = await call(srv.handler, '/api/dashboard', { cookie: `${auth.SESSION_COOKIE}=${encodeURIComponent(secondToken)}` });
		assert.equal(read.statusCode, 200, 'the new session works');
	});
});
