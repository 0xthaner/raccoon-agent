/**
 * Zufall der Einmalwerte (CRSF Phase 2C, CR-AUTH-008 P1/P2).
 *
 * Kein Statistiktest: bewiesen wird die KONSTRUKTION. crypto.randomBytes wird
 * durch einen Spion ersetzt (syncBuiltinESMExports aktualisiert die importierten
 * Bindungen), der jede angeforderte Laenge mitschreibt und unterscheidbare Bytes
 * liefert. Jeder sicherheitsrelevante Einmalwert muss dann EXAKT die vollstaendige
 * Kodierung (hex bzw. base64url) eines randomBytes-Aufrufs von mindestens 16 Byte
 * sein: keine Kuerzung, keine Zeit, kein Zaehler, kein Math.random.
 * node:crypto.randomBytes ist laut Node-Dokumentation ein CSPRNG.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, syncBuiltinESMExports } from 'node:module';

process.env.DASHBOARD_SESSION_SECRET = 'csprng-test-secret-0123456789abcdef-0123456789';
process.env.APP_BASE_URL = 'https://coverraccoon.com';
process.env.SUPABASE_URL = 'https://csprng-test.invalid';
process.env.SUPABASE_SECRET_KEY = 'csprng-test-not-a-key';

const inserted = [];
globalThis.fetch = async (url, options = {}) => {
	const u = new URL(String(url));
	if (u.host !== 'csprng-test.invalid') throw new Error(`unexpected outbound request to ${u.host}`);
	if ((options.method ?? 'GET').toUpperCase() === 'POST') inserted.push({ path: u.pathname, body: JSON.parse(options.body) });
	return (options.method ?? 'GET').toUpperCase() === 'GET' ? Response.json([]) : new Response(null, { status: 201 });
};

const nodeCrypto = createRequire(import.meta.url)('node:crypto');
const realRandomBytes = nodeCrypto.randomBytes;
const calls = [];
let seq = 0;
function spyRandomBytes(size, callback) {
	if (callback) throw new Error('callback form not expected');
	const b = Buffer.alloc(size);
	for (let i = 0; i < size; i++) b[i] = (seq * 37 + i * 11 + 5) & 0xff;
	seq++;
	calls.push(b);
	return b;
}
const realMathRandom = Math.random;

const auth = await import('../src/dashboard-auth.mjs');
const siwe = await import('../src/siwe-auth.mjs');
const linking = await import('../src/linking.mjs');

/** Runs fn with the spy installed; returns { value, bytes[] } where bytes are the randomBytes outputs used. */
async function observe(fn) {
	calls.length = 0;
	nodeCrypto.randomBytes = spyRandomBytes;
	syncBuiltinESMExports();
	Math.random = () => { throw new Error('Math.random used for a security value'); };
	try { return { value: await fn(), bytes: [...calls] }; } finally {
		nodeCrypto.randomBytes = realRandomBytes;
		syncBuiltinESMExports();
		Math.random = realMathRandom;
	}
}
const payload = (token) => JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
const WALLET = '0x1111111111111111111111111111111111111111';

/** The value must be the complete encoding of one spied randomBytes output of >= 16 bytes. */
function assertFromCsprng(value, bytes, encoding, label) {
	const match = bytes.find((b) => b.toString(encoding) === value);
	assert.ok(match, `${label}: value is not the full ${encoding} encoding of any randomBytes output (truncated, mixed or not from randomBytes)`);
	assert.ok(match.length >= 16, `${label}: only ${match.length * 8} bits`);
	return match.length * 8;
}

test('CSPRNG: the spy is effective - a fresh randomBytes call is observed (control)', async () => {
	const { value, bytes } = await observe(() => nodeCrypto.randomBytes(16).toString('hex'));
	assert.equal(bytes.length, 1);
	assert.equal(value, bytes[0].toString('hex'));
});

test('CSPRNG: dashboard login challenge nonce and request id are full 128-bit randomBytes values', async () => {
	const { value, bytes } = await observe(() => auth.createDashboardChallenge(WALLET).token);
	const data = payload(value);
	assert.equal(assertFromCsprng(data.nonce, bytes, 'hex', 'challenge nonce'), 128);
	assert.equal(assertFromCsprng(data.rid, bytes, 'hex', 'challenge request id'), 128);
	assert.notEqual(data.nonce, data.rid, 'nonce and request id come from separate draws');
});

test('CSPRNG: fresh-confirmation (action) nonce and request id are full 128-bit randomBytes values', async () => {
	const { value, bytes } = await observe(() => auth.createActionChallenge(WALLET, 'session-revoke').data);
	assert.equal(assertFromCsprng(value.nonce, bytes, 'hex', 'action nonce'), 128);
	assert.equal(assertFromCsprng(value.rid, bytes, 'hex', 'action request id'), 128);
});

test('CSPRNG: SIWE request ids are full 128-bit randomBytes values', async () => {
	const { value, bytes } = await observe(() => siwe.newRequestId());
	assert.equal(assertFromCsprng(value, bytes, 'hex', 'request id'), 128);
});

test('CSPRNG: Telegram link code (144 bits) and link nonce (128 bits) come straight from randomBytes', async () => {
	let stored;
	const { value, bytes } = await observe(() => linking.newLinkRequest(4242, { gate: async () => true, create: async (row) => { stored = row; }, record: async () => {} }));
	assert.equal(assertFromCsprng(value.code, bytes, 'base64url', 'link code'), 144);
	assert.equal(stored.code, value.code);
	assert.equal(assertFromCsprng(stored.nonce, bytes, 'hex', 'link nonce'), 128);
});

test('CSPRNG: dashboard access code (192 bits) comes straight from randomBytes and is stored unchanged', async () => {
	inserted.length = 0;
	const { value, bytes } = await observe(() => linking.newDashboardAccess(WALLET));
	assert.equal(assertFromCsprng(value.code, bytes, 'base64url', 'access code'), 192);
	assert.ok(inserted.some((r) => JSON.stringify(r.body).includes(value.code)), 'the stored code is the generated one');
});

test('CSPRNG: two draws never repeat a value under the real generator (sanity, not proof)', () => {
	const nonces = new Set(Array.from({ length: 200 }, () => payload(auth.createDashboardChallenge(WALLET).token).nonce));
	assert.equal(nonces.size, 200);
});
