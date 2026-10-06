/*
	AGENT-SAFE-4: Preview-only Origin-Allowlist in requireSameOrigin.
	Production bleibt ausschliesslich https://coverraccoon.com; nur ausserhalb
	Production darf ALLOWED_APP_ORIGINS exakte zusaetzliche Origins erlauben.
	Offline, keine DB/kein Netz.
*/
import test from 'node:test';
import assert from 'node:assert/strict';

// siweOrigin() verlangt die Produktions-Origin (Preview/Production gelten gleich).
process.env.APP_BASE_URL = 'https://coverraccoon.com';
process.env.SUPABASE_URL ||= 'https://dummy.supabase.co';
process.env.SUPABASE_SECRET_KEY ||= 'dummy-service-role-key-0123456789';

const { requireSameOrigin } = await import('../src/http-security.mjs');

const CANON = 'https://coverraccoon.com';
const PREVIEW = 'https://preview-test.vercel.app';

function res() {
	const r = { statusCode: null, body: null };
	r.status = (c) => { r.statusCode = c; return r; };
	r.json = (b) => { r.body = b; return r; };
	return r;
}
function req(origin, site = 'same-origin') {
	const headers = {};
	if (origin !== undefined) headers.origin = origin;
	if (site) headers['sec-fetch-site'] = site;
	return { headers };
}
function withEnv({ vercelEnv, allowed }, fn) {
	const sv = process.env.VERCEL_ENV;
	const sa = process.env.ALLOWED_APP_ORIGINS;
	if (vercelEnv === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = vercelEnv;
	if (allowed === undefined) delete process.env.ALLOWED_APP_ORIGINS; else process.env.ALLOWED_APP_ORIGINS = allowed;
	try { return fn(); } finally {
		if (sv === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = sv;
		if (sa === undefined) delete process.env.ALLOWED_APP_ORIGINS; else process.env.ALLOWED_APP_ORIGINS = sa;
	}
}
const accept = (origin, env) => withEnv(env, () => requireSameOrigin(req(origin), res()));
function reject(origin, env) {
	return withEnv(env, () => {
		const r = res();
		const ok = requireSameOrigin(req(origin), r);
		return { ok, status: r.statusCode, error: r.body?.error };
	});
}

test('Production + coverraccoon.com -> PASS', () => {
	assert.equal(accept(CANON, { vercelEnv: 'production' }), true);
});

test('Production + Preview-Origin -> FAIL (403)', () => {
	const r = reject(PREVIEW, { vercelEnv: 'production' });
	assert.equal(r.ok, false); assert.equal(r.status, 403); assert.equal(r.error, 'Invalid request origin.');
});

test('Production + gesetzte ALLOWED_APP_ORIGINS -> Preview trotzdem FAIL', () => {
	const r = reject(PREVIEW, { vercelEnv: 'production', allowed: PREVIEW });
	assert.equal(r.ok, false); assert.equal(r.status, 403);
});

test('Preview + coverraccoon.com -> PASS', () => {
	assert.equal(accept(CANON, { vercelEnv: 'preview', allowed: PREVIEW }), true);
});

test('Preview + exakt allowlisted Preview-Origin -> PASS', () => {
	assert.equal(accept(PREVIEW, { vercelEnv: 'preview', allowed: PREVIEW }), true);
});

test('Preview + andere vercel.app-Origin -> FAIL', () => {
	assert.equal(reject('https://evil-other.vercel.app', { vercelEnv: 'preview', allowed: PREVIEW }).ok, false);
});

test('Preview + Subdomain-Manipulation -> FAIL', () => {
	assert.equal(reject(`${PREVIEW}.evil.com`, { vercelEnv: 'preview', allowed: PREVIEW }).ok, false);
	assert.equal(reject('https://sub.preview-test.vercel.app', { vercelEnv: 'preview', allowed: PREVIEW }).ok, false);
});

test('Preview + http:// -> FAIL', () => {
	// http-Origin passt nie; und ein http-Eintrag in der Liste wird ignoriert
	assert.equal(reject('http://preview-test.vercel.app', { vercelEnv: 'preview', allowed: 'http://preview-test.vercel.app' }).ok, false);
});

test('Preview + Wildcard-Eintrag -> ignoriert / FAIL', () => {
	assert.equal(reject(PREVIEW, { vercelEnv: 'preview', allowed: 'https://*.vercel.app' }).ok, false);
});

test('leere Liste -> nur kanonische Origin', () => {
	assert.equal(accept(CANON, { vercelEnv: 'preview', allowed: '' }), true);
	assert.equal(reject(PREVIEW, { vercelEnv: 'preview', allowed: '' }).ok, false);
	// unset ebenso
	assert.equal(reject(PREVIEW, { vercelEnv: 'preview' }).ok, false);
});

test('malformed entry -> ignoriert, kein Crash; gueltiger Eintrag daneben greift', () => {
	const good = 'https://good-preview.vercel.app';
	assert.equal(accept(good, { vercelEnv: 'preview', allowed: `not a url, ${good}, https://*.bad, ftp://x` }), true);
	assert.equal(reject('https://bad.vercel.app', { vercelEnv: 'preview', allowed: `not a url, ${good}` }).ok, false);
});

test('trailing slash / Pfad im Eintrag -> kein Match (exakte Origin)', () => {
	assert.equal(reject(PREVIEW, { vercelEnv: 'preview', allowed: `${PREVIEW}/` }).ok, false);
	assert.equal(reject(PREVIEW, { vercelEnv: 'preview', allowed: `${PREVIEW}/dashboard` }).ok, false);
});

test('Sec-Fetch-Site cross-site bleibt blockiert (unveraendert)', () => {
	const r = withEnv({ vercelEnv: 'preview', allowed: PREVIEW }, () => {
		const rr = res();
		const ok = requireSameOrigin({ headers: { origin: PREVIEW, 'sec-fetch-site': 'cross-site' } }, rr);
		return { ok, status: rr.statusCode, error: rr.body?.error };
	});
	assert.equal(r.ok, false); assert.equal(r.status, 403); assert.equal(r.error, 'Cross-site request blocked.');
});

test('kein Origin-Header -> durchgelassen (unveraendert)', () => {
	assert.equal(withEnv({ vercelEnv: 'preview', allowed: PREVIEW }, () => requireSameOrigin({ headers: {} }, res())), true);
});
