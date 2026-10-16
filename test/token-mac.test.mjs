/**
 * Sitzungs-Token: MAC-Vergleich und fester Algorithmus (CRSF Phase 2D, CR-SESSION-001 P2/P3).
 *
 * P3 im Verhalten: ein Token kann weder Algorithmus noch Schluessel waehlen. Mit
 * dem ECHTEN Server-Secret, aber einem anderen HMAC-Algorithmus signierte Tokens
 * werden abgelehnt, auch wenn das Token selbst `alg`, `kid` oder `key` nennt;
 * mit einem fremden Schluessel signierte ebenso. Kontrolle: dieselben Daten mit
 * HMAC-SHA-256 und dem Server-Secret werden angenommen.
 *
 * P2 ueber Instrumentierung: crypto.timingSafeEqual wird durch einen Spion
 * ersetzt (syncBuiltinESMExports aktualisiert die importierte Bindung, wie in
 * csprng-construction.test.mjs). Belegt wird, dass die MAC-Entscheidung genau
 * EINMAL und AUSSCHLIESSLICH von timingSafeEqual auf den beiden MAC-Puffern
 * getroffen wird: zwingt der Spion "gleich", gilt eine falsche Signatur; zwingt
 * er "ungleich", gilt die richtige nicht. Ein zusaetzlicher oder ersetzender
 * Vergleich (===, Buffer.equals, Buffer.compare) faellt damit auf. Dass
 * timingSafeEqual selbst zeitkonstant ist, ist eine Zusage von Node
 * (Vertrauensannahme), nicht Gegenstand dieses Tests.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';

const SECRET = 'token-mac-test-secret-0123456789abcdef-012345';
process.env.DASHBOARD_SESSION_SECRET = SECRET;
process.env.APP_BASE_URL = 'https://coverraccoon.com';
const auth = await import('../src/dashboard-auth.mjs');

const WALLET = '0x' + 'a1'.repeat(20);
const encode = (data) => Buffer.from(JSON.stringify(data)).toString('base64url');
const session = (extra = {}) => ({ type: 'session', wallet: WALLET, kind: 'eoa', iat: Date.now(), exp: Date.now() + 60 * 60_000, ...extra });
const signWith = (payload, alg, key) => createHmac(alg, key).update(payload).digest('base64url');

test('TOKEN-ALG control: HMAC-SHA-256 with the server secret is accepted', () => {
	const p = encode(session());
	assert.equal(auth.verifyDashboardToken(`${p}.${signWith(p, 'sha256', SECRET)}`)?.wallet, WALLET);
	assert.equal(auth.verifyDashboardToken(`${p}.${signWith(p, 'sha256', SECRET)}`)?.type, 'session');
});

test('TOKEN-ALG: the server secret with any other HMAC algorithm is rejected, even when the token names that algorithm', () => {
	for (const alg of ['sha1', 'sha224', 'sha384', 'sha512', 'sha512-256', 'sha3-256', 'md5']) {
		for (const named of [{}, { alg }, { alg, typ: 'JWT' }, { header: { alg } }]) {
			const p = encode(session(named));
			assert.equal(auth.verifyDashboardToken(`${p}.${signWith(p, alg, SECRET)}`), null, `${alg} ${JSON.stringify(named)}`);
		}
	}
});

test('TOKEN-ALG: "none" and empty signatures are rejected', () => {
	const p = encode(session({ alg: 'none' }));
	for (const token of [`${p}.`, `${p}`, `${p}.none`, `${p}..`]) assert.equal(auth.verifyDashboardToken(token), null, token);
});

test('TOKEN-KEY: a token cannot choose its key - kid/key/secret fields with a matching attacker signature are rejected', () => {
	const attacker = 'attacker-chosen-key-0123456789abcdef-0123456';
	for (const named of [{ key: attacker }, { kid: attacker }, { secret: attacker }, { k: Buffer.from(attacker).toString('base64url') }]) {
		const p = encode(session(named));
		assert.equal(auth.verifyDashboardToken(`${p}.${signWith(p, 'sha256', attacker)}`), null, JSON.stringify(named));
	}
	// The same payloads ARE accepted when signed with the real server key: the extra fields are inert, the key is fixed.
	const p = encode(session({ key: attacker }));
	assert.equal(auth.verifyDashboardToken(`${p}.${signWith(p, 'sha256', SECRET)}`)?.wallet, WALLET);
});

test('TOKEN-KEY: a token signed under a different server secret (rotation / other deployment) is rejected', () => {
	const p = encode(session());
	assert.equal(auth.verifyDashboardToken(`${p}.${signWith(p, 'sha256', `${SECRET}-other`)}`), null);
});

/* ------------------------------------------------- P2: timingSafeEqual decides */
const nodeCrypto = createRequire(import.meta.url)('node:crypto');
const realTimingSafeEqual = nodeCrypto.timingSafeEqual;
function withTimingSpy(answer, fn) {
	const calls = [];
	nodeCrypto.timingSafeEqual = (a, b) => { calls.push([Buffer.from(a), Buffer.from(b)]); return answer === undefined ? realTimingSafeEqual(a, b) : answer; };
	syncBuiltinESMExports();
	try { return { value: fn(), calls }; } finally { nodeCrypto.timingSafeEqual = realTimingSafeEqual; syncBuiltinESMExports(); }
}

test('TOKEN-CT: every well-formed token reaches timingSafeEqual exactly once, with the received and the expected MAC', () => {
	const p = encode(session());
	const good = signWith(p, 'sha256', SECRET);
	const forged = Buffer.from(good, 'base64url'); forged[0] ^= 1; forged[forged.length - 1] ^= 1;
	for (const [label, sig, expectWallet] of [['valid', good, WALLET], ['forged (same length)', forged.toString('base64url'), undefined]]) {
		const { value, calls } = withTimingSpy(undefined, () => auth.verifyDashboardToken(`${p}.${sig}`));
		assert.equal(value?.wallet, expectWallet, label);
		assert.equal(calls.length, 1, `${label}: exactly one comparison`);
		assert.deepEqual(calls[0][0], Buffer.from(sig, 'base64url'), `${label}: received MAC`);
		assert.deepEqual(calls[0][1], Buffer.from(good, 'base64url'), `${label}: expected MAC`);
	}
});

test('TOKEN-CT: the MAC decision is timingSafeEqual and nothing else (forced answers decide the outcome)', () => {
	const p = encode(session());
	const good = signWith(p, 'sha256', SECRET);
	const forged = Buffer.from(good, 'base64url'); forged[5] ^= 0xff;
	assert.equal(withTimingSpy(true, () => auth.verifyDashboardToken(`${p}.${forged.toString('base64url')}`)).value?.wallet, WALLET, 'forced "equal": no second comparison rejects the forged MAC');
	assert.equal(withTimingSpy(false, () => auth.verifyDashboardToken(`${p}.${good}`)).value, null, 'forced "unequal": no other path accepts the valid MAC');
});

test('TOKEN-CT: a MAC of the wrong length is rejected before any byte comparison (length is not secret)', () => {
	const p = encode(session());
	const { value, calls } = withTimingSpy(undefined, () => auth.verifyDashboardToken(`${p}.${signWith(p, 'sha256', SECRET).slice(0, 20)}`));
	assert.equal(value, null);
	assert.equal(calls.length, 0);
});
