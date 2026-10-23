/*
	Preview-Origin fuer SIWE (23.10.2026), src/siwe-auth.mjs `isPreviewOrigin`.

	Invariante: nur bei VERCEL_ENV=preview darf `APP_BASE_URL` eine eigene
	https-Origin unter vercel.app tragen; Production bleibt exakt bei
	coverraccoon.com. Dieselbe Origin bestimmt SIWE-Domain, URI, Resource und die
	Same-Origin-Pruefung. Eine Preview-Anmeldung ist in Production nicht
	nachspielbar - weder ueber das Token (eigenes Secret) noch ueber die Signatur
	(andere Domain im rekonstruierten Text). Ausserdem: der Laufzeit-Nachweis
	loggt nur die Node-Version.

	Der Login laeuft wie in dashboard-login-behavior.test.mjs mit dem echten
	Handler und Offline-Schluesseln ohne Guthaben.
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { isAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { queryParams, singleQueryValue } from '../src/request-query.mjs';
import { checkSiweMessage, dashboardSiweMessage, dashboardExpectation, PRODUCTION_ORIGIN, siweOrigin } from '../src/siwe-auth.mjs';

const PREVIEW = 'https://raccoon-agent-abc123-team.vercel.app';
const OTHER_PREVIEW = 'https://raccoon-agent-def456-team.vercel.app';
const PREVIEW_SECRET = 'preview-test-secret-0123456789abcdef-0123456789';
const PRODUCTION_SECRET = 'production-test-secret-0123456789abcdef-012345';

const PREVIEW_ENV = { VERCEL_ENV: 'preview', APP_BASE_URL: PREVIEW, DASHBOARD_SESSION_SECRET: PREVIEW_SECRET, ALLOWED_APP_ORIGINS: undefined, NODE_ENV: undefined };
const PRODUCTION_ENV = { VERCEL_ENV: 'production', APP_BASE_URL: PRODUCTION_ORIGIN, DASHBOARD_SESSION_SECRET: PRODUCTION_SECRET, ALLOWED_APP_ORIGINS: undefined, NODE_ENV: undefined };

delete process.env.ALCHEMY_API_KEY; // Contract-Pfad ohne RPC: fail closed
Object.assign(process.env, { DASHBOARD_SESSION_SECRET: PREVIEW_SECRET });
const auth = await import('../src/dashboard-auth.mjs');
const { verifyWalletSiweAuthority } = await import('../src/contract-signature.mjs');
const { requireSameOrigin } = await import('../src/http-security.mjs');
const { meldeLaufzeit } = await import('../src/runtime-proof.mjs');

const OWNER = privateKeyToAccount(`0x${'05'.repeat(32)}`);

async function withEnv(values, run) {
	const previous = {};
	for (const [key, value] of Object.entries(values)) {
		previous[key] = process.env[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		return await run();
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

const originFor = (env) => withEnv(env, () => siweOrigin());
async function rejected(env) {
	await withEnv(env, () => assert.throws(() => siweOrigin(), /nicht konfiguriert/, JSON.stringify(env)));
}

function response() {
	return { headers: {}, status(n) { this.code = n; return this; }, setHeader(k, v) { this.headers[k] = v; }, json(b) { this.body = b; return this; } };
}

function loadHandler(deps) {
	const source = readFileSync(new URL('../api/dashboard.mjs', import.meta.url), 'utf8');
	const body = source.replace(/^import .*;\n/gm, '').replace('export default async function handler', 'async function handler');
	return new Function(...Object.keys(deps), `${body}\nreturn handler;`)(...Object.values(deps));
}

/** Login-Handler mit einem Nonce-Speicher wie dashboard_challenges: jede Nonce genau einmal. */
function setup(consumed = new Set()) {
	return loadHandler({
		isAddress, getWalletCovers: async () => ({ covers: [] }), queryParams, singleQueryValue,
		...auth,
		verifyWalletSiweAuthority, isDeployedContract: async () => false,
		beginTelegramDelivery: async () => null, finishTelegramDelivery: async () => {},
		consumeDashboardAccess: async () => null,
		consumeDashboardChallenge: async (nonce) => { if (consumed.has(nonce)) return false; consumed.add(nonce); return true; },
		getLanguage: async () => 'de', getWalletLinkStateByWallet: async () => ({ linked: false, link: null }),
		isDashboardSessionRevoked: async () => false, recordAgentEvent: async () => {}, revokeDashboardSessions: async () => Date.now(),
		storeDashboardChallenge: async () => {}, unlinkWalletByWallet: async () => [],
		ANMELDUNG_PAUSIERT: false, pauseAntwort: () => {},
		enforceRateLimit: async () => true, enforceRateLimitFor: async () => true, requireJson: () => true, requireSameOrigin: () => true,
		recordSecurityEvent: async () => {}, securityFingerprint: () => 'fp', SECURITY_EVENT: { SIWE_SIGNATURE_INVALID: 'invalid', SIWE_REPLAY_BLOCKED: 'replay', ACCESS_CODE_INVALID: 'access' }
	});
}

async function post(handler, body) {
	const res = response();
	await handler({ method: 'POST', query: {}, headers: {}, body }, res);
	return res;
}

/** Challenge und Signatur, ausgestellt in `env`. */
const signedChallenge = (env) => withEnv(env, async () => {
	const challenge = auth.createDashboardChallenge(OWNER.address);
	return { wallet: OWNER.address, token: challenge.token, signature: await OWNER.signMessage({ message: challenge.message }), message: challenge.message };
});
const sessionOf = (res) => decodeURIComponent(/=([^;]+)/.exec(String(res.headers['set-cookie']))?.[1] ?? '');
const cookieIssued = (res) => String(res.headers['set-cookie'] ?? '').includes(`${auth.SESSION_COOKIE}=`) && !String(res.headers['set-cookie']).includes('Max-Age=0');

/* ------------------------------------------------------------- Origin -- */

test('PREVIEW-ORIGIN a valid preview origin is the SIWE domain and URI in preview', async () => {
	assert.deepEqual(await originFor(PREVIEW_ENV), { domain: 'raccoon-agent-abc123-team.vercel.app', uri: PREVIEW });
	assert.deepEqual(await originFor({ ...PREVIEW_ENV, APP_BASE_URL: `${PREVIEW}/` }), { domain: 'raccoon-agent-abc123-team.vercel.app', uri: PREVIEW });
	const message = await withEnv(PREVIEW_ENV, () => dashboardSiweMessage({ wallet: OWNER.address, nonce: 'a'.repeat(32), issuedAt: Date.now(), expiresAt: Date.now() + 60_000, requestId: 'b'.repeat(32) }));
	assert.match(message, /^raccoon-agent-abc123-team\.vercel\.app wants you to sign in/);
	assert.match(message, new RegExp(`\\nURI: ${PREVIEW}\\n`));
	assert.match(message, new RegExp(`- ${PREVIEW}/dashboard`));
	assert.doesNotMatch(message, /coverraccoon\.com/);
});

test('PREVIEW-ORIGIN production accepts only coverraccoon.com, never a preview origin', async () => {
	assert.deepEqual(await originFor(PRODUCTION_ENV), { domain: 'coverraccoon.com', uri: PRODUCTION_ORIGIN });
	for (const vercelEnv of ['production', undefined, 'development', 'Preview', ' preview-x', '']) {
		await rejected({ ...PREVIEW_ENV, VERCEL_ENV: vercelEnv });
	}
	await rejected({ ...PREVIEW_ENV, VERCEL_ENV: undefined, NODE_ENV: 'production' });
	await rejected({ ...PREVIEW_ENV, VERCEL_ENV: undefined, NODE_ENV: 'development' });
});

test('PREVIEW-ORIGIN a missing preview configuration fails closed, no fallback to production', async () => {
	for (const value of [undefined, '', '   ']) await rejected({ ...PREVIEW_ENV, APP_BASE_URL: value });
	// Kein Rueckfall auf VERCEL_URL oder andere Systemvariablen.
	await rejected({ ...PREVIEW_ENV, APP_BASE_URL: undefined, VERCEL_URL: 'raccoon-agent-abc123-team.vercel.app', VERCEL_BRANCH_URL: 'raccoon-agent-git-x-team.vercel.app' });
});

test('PREVIEW-ORIGIN invalid preview configurations fail closed', async () => {
	for (const value of [
		'http://raccoon-agent-abc123-team.vercel.app', // kein https
		'https://raccoon-agent-abc123-team.vercel.app:8443', // Port
		'https://raccoon-agent-abc123-team.vercel.app/dashboard', // Pfad
		'https://raccoon-agent-abc123-team.vercel.app/?x=1',
		'https://raccoon-agent-abc123-team.vercel.app/#x',
		'https://user:pw@raccoon-agent-abc123-team.vercel.app',
		'https://a.b.vercel.app', // zwei Label
		'https://vercel.app',
		'https://.vercel.app',
		'https://-x.vercel.app',
		'https://x-.vercel.app',
		'https://raccoon-agent-abc123-team.vercel.app.evil.example',
		'https://raccoon-agent-abc123-team.vercel.app%2f.evil.example',
		'https://evil.example',
		'https://preview.coverraccoon.com', // keine eigene Domain, kein gemeinsamer Cookie-Bereich
		'https://agent.coverraccoon.com',
		'https://xn--80ak6aa92e.vercel.app', // Punycode
		'https://*.vercel.app',
		'*.vercel.app',
		'raccoon-agent-abc123-team.vercel.app',
		'http://localhost:8787', // Preview gilt fuer Loopback wie Production
		`${PREVIEW},${OTHER_PREVIEW}`,
		'not a url'
	]) await rejected({ ...PREVIEW_ENV, APP_BASE_URL: value });
});

test('PREVIEW-ORIGIN the same-origin check accepts exactly the configured preview origin', async () => {
	await withEnv(PREVIEW_ENV, () => {
		const check = (origin, extra = {}) => { const res = response(); return { ok: requireSameOrigin({ headers: { origin, ...extra } }, res), res }; };
		assert.equal(check(PREVIEW).ok, true);
		for (const origin of [OTHER_PREVIEW, PRODUCTION_ORIGIN, `${PREVIEW}/`, 'http://raccoon-agent-abc123-team.vercel.app', 'https://evil.example', 'null']) {
			const { ok, res } = check(origin);
			assert.equal(ok, false, origin);
			assert.equal(res.code, 403, origin);
		}
	});
});

test('PREVIEW-ORIGIN manipulated Host and Forwarded headers change nothing', async () => {
	const forged = { host: 'raccoon-agent-def456-team.vercel.app', 'x-forwarded-host': 'raccoon-agent-def456-team.vercel.app', 'x-forwarded-proto': 'https', forwarded: 'host=raccoon-agent-def456-team.vercel.app;proto=https', referer: `${OTHER_PREVIEW}/` };
	await withEnv(PREVIEW_ENV, () => {
		const res = response();
		assert.equal(requireSameOrigin({ headers: { origin: OTHER_PREVIEW, ...forged } }, res), false);
		assert.equal(res.code, 403);
		assert.equal(requireSameOrigin({ headers: { origin: PREVIEW, ...forged } }, response()), true);
		// siweOrigin nimmt keinen Request entgegen; Header koennen die Domain nicht setzen.
		assert.equal(siweOrigin.length, 0);
		assert.equal(siweOrigin().uri, PREVIEW);
	});
	await withEnv(PRODUCTION_ENV, () => {
		const res = response();
		assert.equal(requireSameOrigin({ headers: { origin: PREVIEW, host: 'raccoon-agent-abc123-team.vercel.app', 'x-forwarded-host': 'raccoon-agent-abc123-team.vercel.app' } }, res), false);
		assert.equal(res.code, 403);
	});
});

test('PREVIEW-ORIGIN ALLOWED_APP_ORIGINS does not add a second origin next to a preview SIWE origin', async () => {
	await withEnv({ ...PREVIEW_ENV, ALLOWED_APP_ORIGINS: OTHER_PREVIEW }, () => {
		const res = response();
		assert.equal(requireSameOrigin({ headers: { origin: OTHER_PREVIEW } }, res), false);
		assert.equal(res.code, 403);
		assert.equal(requireSameOrigin({ headers: { origin: PREVIEW } }, response()), true);
	});
	// Unveraendert (AGENT-SAFE-4): mit kanonischer SIWE-Origin gilt die Liste im Preview weiter.
	await withEnv({ ...PREVIEW_ENV, APP_BASE_URL: PRODUCTION_ORIGIN, ALLOWED_APP_ORIGINS: OTHER_PREVIEW }, () => {
		assert.equal(requireSameOrigin({ headers: { origin: OTHER_PREVIEW } }, response()), true);
	});
	// Und in Production nie.
	await withEnv({ ...PRODUCTION_ENV, ALLOWED_APP_ORIGINS: OTHER_PREVIEW }, () => {
		assert.equal(requireSameOrigin({ headers: { origin: OTHER_PREVIEW } }, response()), false);
	});
});

test('PREVIEW-ORIGIN a missing preview configuration makes the same-origin check fail closed (503)', async () => {
	await withEnv({ ...PREVIEW_ENV, APP_BASE_URL: 'https://evil.example' }, () => {
		const res = response();
		assert.equal(requireSameOrigin({ headers: { origin: 'https://evil.example' } }, res), false);
		assert.equal(res.code, 503);
	});
});

/* ------------------------------------------------------- SIWE / Login -- */

test('PREVIEW-ORIGIN SIWE domain mismatch: preview text never satisfies a production expectation and vice versa', async () => {
	const fields = { wallet: OWNER.address, nonce: 'c'.repeat(32), issuedAt: Date.now(), expiresAt: Date.now() + 60_000, requestId: 'd'.repeat(32) };
	const previewMessage = await withEnv(PREVIEW_ENV, () => dashboardSiweMessage(fields));
	const productionMessage = await withEnv(PRODUCTION_ENV, () => dashboardSiweMessage(fields));
	assert.equal(await withEnv(PREVIEW_ENV, () => checkSiweMessage(previewMessage, dashboardExpectation(fields))), 'VALID');
	assert.equal(await withEnv(PRODUCTION_ENV, () => checkSiweMessage(previewMessage, dashboardExpectation(fields))), 'DOMAIN_MISMATCH');
	assert.equal(await withEnv(PREVIEW_ENV, () => checkSiweMessage(productionMessage, dashboardExpectation(fields))), 'DOMAIN_MISMATCH');
	assert.equal(await withEnv({ ...PREVIEW_ENV, APP_BASE_URL: OTHER_PREVIEW }, () => checkSiweMessage(previewMessage, dashboardExpectation(fields))), 'DOMAIN_MISMATCH');
});

test('PREVIEW-ORIGIN a valid preview login issues a host-only session cookie for exactly that wallet', async () => {
	const signed = await signedChallenge(PREVIEW_ENV);
	const res = await withEnv(PREVIEW_ENV, () => post(setup(), signed));
	assert.equal(res.code, 200);
	assert.ok(cookieIssued(res));
	const header = String(res.headers['set-cookie']);
	assert.match(header, /^__Host-raccoon_dashboard=/);
	assert.doesNotMatch(header, /;\s*Domain=/i);
	for (const attribute of ['Path=/', 'HttpOnly', 'Secure', 'SameSite=Strict']) assert.ok(header.includes(attribute), attribute);
	assert.equal(await withEnv(PREVIEW_ENV, () => auth.verifyDashboardSession(sessionOf(res))?.wallet), OWNER.address.toLowerCase());
});

test('PREVIEW-ORIGIN cross-environment replay: a preview login never authenticates in production', async () => {
	const signed = await signedChallenge(PREVIEW_ENV);
	// Getrennte Secrets: das Preview-Token ist in Production keine Challenge.
	const res = await withEnv(PRODUCTION_ENV, () => post(setup(), signed));
	assert.equal(res.code, 401);
	assert.equal(cookieIssued(res), false);
	// Selbst bei (falsch) gleichem Secret scheitert die Signatur am Text mit der Production-Domain.
	const shared = await withEnv({ ...PRODUCTION_ENV, DASHBOARD_SESSION_SECRET: PREVIEW_SECRET }, () => post(setup(), signed));
	assert.equal(shared.code, 401);
	assert.equal(cookieIssued(shared), false);
	// Und umgekehrt: eine Production-Challenge meldet im Preview nicht an.
	const fromProduction = await signedChallenge(PRODUCTION_ENV);
	const back = await withEnv({ ...PREVIEW_ENV, DASHBOARD_SESSION_SECRET: PRODUCTION_SECRET }, () => post(setup(), fromProduction));
	assert.equal(back.code, 401);
	assert.equal(cookieIssued(back), false);
	// Eine andere Preview-Origin mit demselben Secret ebenso nicht.
	const otherPreview = await withEnv({ ...PREVIEW_ENV, APP_BASE_URL: OTHER_PREVIEW }, () => post(setup(), signed));
	assert.equal(otherPreview.code, 401);
});

test('PREVIEW-ORIGIN nonce replay: the same preview challenge logs in once, the second attempt gets 409', async () => {
	const signed = await signedChallenge(PREVIEW_ENV);
	const handler = await withEnv(PREVIEW_ENV, () => setup(new Set()));
	const first = await withEnv(PREVIEW_ENV, () => post(handler, signed));
	assert.equal(first.code, 200);
	const second = await withEnv(PREVIEW_ENV, () => post(handler, signed));
	assert.equal(second.code, 409);
	assert.equal(cookieIssued(second), false);
});

test('PREVIEW-ORIGIN session isolation: a preview session is not a production session', async () => {
	const signed = await signedChallenge(PREVIEW_ENV);
	const res = await withEnv(PREVIEW_ENV, () => post(setup(), signed));
	const token = sessionOf(res);
	assert.ok(token);
	assert.equal(await withEnv(PRODUCTION_ENV, () => auth.verifyDashboardSession(token)), null);
	assert.equal(await withEnv(PRODUCTION_ENV, () => auth.resolveDashboardSession({ headers: { cookie: `${auth.SESSION_COOKIE}=${encodeURIComponent(token)}` } }).session), null);
	const productionToken = await withEnv(PRODUCTION_ENV, () => auth.createDashboardSession(OWNER.address));
	assert.equal(await withEnv(PREVIEW_ENV, () => auth.verifyDashboardSession(productionToken)), null);
});

/* --------------------------------------------------- Laufzeit-Nachweis -- */

test('PREVIEW-ORIGIN the runtime proof logs only the Node version, once, and only on Vercel', () => {
	const lines = [];
	const log = (line) => lines.push(line);
	assert.equal(meldeLaufzeit({ env: {}, version: 'v24.22.1', log }), false);
	assert.equal(meldeLaufzeit({ env: { VERCEL: '0' }, version: 'v24.22.1', log }), false);
	const env = { VERCEL: '1', DASHBOARD_SESSION_SECRET: PREVIEW_SECRET, SUPABASE_SECRET_KEY: 'sb-secret-value', APP_BASE_URL: PREVIEW };
	assert.equal(meldeLaufzeit({ env, version: 'v24.22.1', log }), true);
	assert.equal(meldeLaufzeit({ env, version: 'v24.22.1', log }), false, 'only once per instance');
	assert.deepEqual(lines, ['runtime node=v24.22.1']);
});

test('PREVIEW-ORIGIN the runtime proof never reaches an HTTP response', () => {
	const source = readFileSync('src/runtime-proof.mjs', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
	assert.doesNotMatch(source, /process\.env\.[A-Z]/, 'reads no configuration value');
	assert.doesNotMatch(source, /\b(response|res|request|req)\b/);
	assert.match(readFileSync('src/http-security.mjs', 'utf8'), /^import '\.\/runtime-proof\.mjs';$/m);
	for (const file of readdirSync('api', { recursive: true }).filter((f) => f.endsWith('.mjs'))) {
		assert.doesNotMatch(readFileSync(`api/${file}`, 'utf8'), /process\.version|runtime-proof/, file);
	}
});
