/**
 * AGENT-IR-002: minimale, datenminimierte Security-Fehlerereignisse.
 *
 * Reine Logik mit injizierten record-/gate-Funktionen (kein Netz, keine DB).
 * `security-events.mjs` zieht `db.mjs` beim Import → Dummy-SUPABASE-Variablen.
 * Fuer den Fingerprint wird ein Dummy-DASHBOARD_SESSION_SECRET (>=32) gesetzt.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SECRET_KEY ||= 'dummy-secret-key-for-import-only';
process.env.DASHBOARD_SESSION_SECRET ||= 'test-dashboard-secret-at-least-32-chars-long';
const { recordSecurityEvent, securityFingerprint, SECURITY_EVENT, maybeAlertOperator, alertOperatorCronFailure, sendOperatorAlert } = await import('../src/security-events.mjs');

/** Zaehl-Gate wie checkRateLimit: true solange count<=max (increment je Aufruf). */
function countingGate() {
	const counts = {};
	return async (key, max) => { counts[key] = (counts[key] ?? 0) + 1; return counts[key] <= max; };
}
/** Env fuer eine aktive Operator-Destination setzen und danach sauber zuruecksetzen. */
async function withOperator(run) {
	const prev = { chat: process.env.OPERATOR_TELEGRAM_CHAT_ID, tok: process.env.TELEGRAM_BOT_TOKEN };
	process.env.OPERATOR_TELEGRAM_CHAT_ID = '367539889';
	process.env.TELEGRAM_BOT_TOKEN = 'dummy-bot-token-for-test';
	try { return await run(); } finally {
		if (prev.chat === undefined) delete process.env.OPERATOR_TELEGRAM_CHAT_ID; else process.env.OPERATOR_TELEGRAM_CHAT_ID = prev.chat;
		if (prev.tok === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = prev.tok;
	}
}

const src = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const VERBOTEN = ['ip', 'signature', 'nonce', 'code', 'token', 'message', 'wallet', 'secret'];

test('IR-002 Fingerprint ist kurz, hex und nicht umkehrbar', () => {
	const fp = securityFingerprint('0xabcdef0000000000000000000000000000001234');
	assert.match(fp, /^[0-9a-f]{12}$/);
	assert.notEqual(fp, '0xabcdef0000000000000000000000000000001234');
	// deterministisch (Korrelation), aber ohne den Rohwert preiszugeben
	assert.equal(fp, securityFingerprint('0xabcdef0000000000000000000000000000001234'));
});

test('IR-002 Fingerprint ist null ohne Secret oder ohne Wert', () => {
	assert.equal(securityFingerprint(''), null);
	assert.equal(securityFingerprint(null), null);
	const prev = process.env.DASHBOARD_SESSION_SECRET;
	process.env.DASHBOARD_SESSION_SECRET = 'zu-kurz';
	assert.equal(securityFingerprint('x'), null);
	process.env.DASHBOARD_SESSION_SECRET = prev;
});

test('IR-002 ein Ereignis wird genau einmal und minimal aufgezeichnet', async () => {
	const calls = [];
	const ok = await recordSecurityEvent(
		SECURITY_EVENT.SIWE_SIGNATURE_INVALID,
		{ source: 'dashboard', fingerprint: 'abc123def456', scope: 'dashboard-login' },
		{ record: async (e) => calls.push(e), gate: async () => true }
	);
	assert.equal(ok, true);
	assert.equal(calls.length, 1);
	const e = calls[0];
	assert.equal(e.eventType, 'security.siwe_signature_invalid');
	assert.equal(e.source, 'dashboard');
	assert.deepEqual(Object.keys(e.metadata).sort(), ['fp', 'scope']);
	assert.equal(e.metadata.fp, 'abc123def456');
	// keine Identitaets-/Rohfelder
	assert.equal('chatId' in e || 'wallet' in e, false);
});

test('IR-002 unterhalb der Schranke (gate false) wird nichts geschrieben', async () => {
	const calls = [];
	const ok = await recordSecurityEvent(
		SECURITY_EVENT.RATE_LIMIT_BLOCKED,
		{ source: 'system', fingerprint: 'deadbeef0000' },
		{ record: async (e) => calls.push(e), gate: async () => false }
	);
	assert.equal(ok, false);
	assert.equal(calls.length, 0);
});

test('IR-002 ein Fehler im record kippt nichts (best effort)', async () => {
	const ok = await recordSecurityEvent(
		SECURITY_EVENT.WEBHOOK_AUTH_FAILED,
		{ source: 'telegram', fingerprint: 'aaaa1111bbbb' },
		{ record: async () => { throw new Error('db down'); }, gate: async () => true }
	);
	assert.equal(ok, false);
});

test('IR-002 Metadaten tragen nie Rohdaten (nur fp/scope, gekuerzt)', async () => {
	const calls = [];
	await recordSecurityEvent(
		SECURITY_EVENT.ACCESS_CODE_INVALID,
		{ source: 'dashboard', fingerprint: 'f'.repeat(80) },
		{ record: async (e) => calls.push(e), gate: async () => true }
	);
	assert.ok(calls[0].metadata.fp.length <= 32);
});

/* ---- Verdrahtung in den Handlern: Fingerprint statt Rohwert ---- */

test('IR-002 Dashboard-Handler meldet SIWE-Fehler, Replay und Access-Code (nur Fingerprint)', () => {
	const d = src('../api/dashboard.mjs');
	assert.ok(d.includes('SECURITY_EVENT.SIWE_SIGNATURE_INVALID'));
	assert.ok(d.includes('SECURITY_EVENT.SIWE_REPLAY_BLOCKED'));
	assert.ok(d.includes('SECURITY_EVENT.ACCESS_CODE_INVALID'));
	// Es wird der Fingerprint uebergeben, nicht der Rohwert.
	assert.ok(d.includes('securityFingerprint(wallet)'));
	assert.ok(d.includes('securityFingerprint(body.access)'));
	// Keine rohe Signatur/Nonce/Code als Event-Metadatum.
	assert.equal(/recordSecurityEvent\([^)]*\bsignature\b/.test(d), false);
	assert.equal(/recordSecurityEvent\([^)]*challenge\.nonce/.test(d), false);
});

test('IR-002 Link-Verify meldet SIWE-Fehler und Replay (nur Fingerprint der Wallet)', () => {
	const v = src('../api/link/verify.mjs');
	assert.ok(v.includes('SECURITY_EVENT.SIWE_SIGNATURE_INVALID'));
	assert.ok(v.includes('SECURITY_EVENT.SIWE_REPLAY_BLOCKED'));
	assert.ok(v.includes('securityFingerprint(wallet)'));
	assert.equal(/recordSecurityEvent\([^)]*\bsignature\b/.test(v), false);
	assert.equal(/recordSecurityEvent\([^)]*\bcode\b/.test(v), false);
});

test('IR-002 Webhook meldet Auth-Fehler ohne rohe IP und ohne Token', () => {
	const t = src('../api/telegram.mjs');
	assert.ok(t.includes('SECURITY_EVENT.WEBHOOK_AUTH_FAILED'));
	assert.ok(t.includes('securityFingerprint(ip)'));
	// Das geheime Header-Token wird NICHT gefingerprintet/geloggt.
	assert.equal(/securityFingerprint\([^)]*secret-token/.test(t), false);
	assert.equal(/recordSecurityEvent\([^)]*x-telegram-bot-api-secret-token/.test(t), false);
});

test('IR-002 Rate-Limiter meldet Block mit gekuerztem Fingerprint, nicht roher IP', () => {
	const h = src('../src/http-security.mjs');
	assert.equal((h.match(/SECURITY_EVENT\.RATE_LIMIT_BLOCKED/g) ?? []).length, 2, 'in beiden enforce-Funktionen');
	assert.ok(h.includes('fingerprint: identity.slice(0, 12)'));
	assert.equal(/recordSecurityEvent\([^)]*requestIp\(/.test(h), false, 'keine rohe IP ins Event');
});

test('IR-002 kein Security-Event-Aufruf uebergibt offensichtliche Rohdaten', () => {
	for (const p of ['../api/dashboard.mjs', '../api/link/verify.mjs', '../api/telegram.mjs', '../src/http-security.mjs']) {
		const code = src(p);
		const aufrufe = code.match(/recordSecurityEvent\([\s\S]*?\)\)?;/g) ?? [];
		for (const call of aufrufe) {
			// erlaubt sind securityFingerprint(...) und identity.slice(...); verbotene Rohfelder nicht als Wert
			const ohneFp = call.replace(/securityFingerprint\([^)]*\)/g, '').replace(/identity\.slice\([^)]*\)/g, '');
			for (const w of ['request.body', 'signature', 'challenge.nonce', 'requestIp(', 'secret-token']) {
				assert.equal(ohneFp.includes(w), false, `${p}: ${w}`);
			}
		}
	}
});

/* ---- AGENT-IR-001: Operator-Alerts (Schwelle + Cooldown + Datenschutz) ---- */

test('ALERT ein einzelnes SIWE-Failure loest keinen Alert aus', async () => {
	await withOperator(async () => {
		const sent = [];
		const deps = { record: async () => {}, gate: countingGate(), alert: async (t) => sent.push(t) };
		await recordSecurityEvent(SECURITY_EVENT.SIWE_SIGNATURE_INVALID, { source: 'dashboard', fingerprint: 'abc123def456', scope: 'dashboard-login' }, deps);
		assert.equal(sent.length, 0);
	});
});

test('ALERT-1 Burst ueber Schwelle loest genau EINEN Alert aus; Cooldown verhindert weitere', async () => {
	await withOperator(async () => {
		const sent = [];
		const deps = { record: async () => {}, gate: countingGate(), alert: async (t) => sent.push(t) };
		// Schwelle login = 5: erst der 6. Fehlversuch alarmiert.
		for (let i = 0; i < 15; i++) {
			await recordSecurityEvent(SECURITY_EVENT.SIWE_SIGNATURE_INVALID, { source: 'dashboard', fingerprint: 'abc123def456', scope: 'dashboard-login' }, deps);
		}
		assert.equal(sent.length, 1, 'genau ein Alert trotz Burst');
		const text = sent[0];
		assert.ok(text.includes('Security-Alarm'));
		assert.ok(text.includes('SIWE/Login'));
		// keine Rohdaten im Alert
		assert.equal(/0x[0-9a-fA-F]{40}/.test(text), false);
		assert.equal(/\b\d{1,3}(\.\d{1,3}){3}\b/.test(text), false, 'keine rohe IP');
		for (const leak of ['signature', 'nonce', 'cookie', 'Bearer', 'dummy-bot-token']) assert.equal(text.includes(leak), false, leak);
	});
});

test('ALERT-2 Webhook-Forgery-Burst alarmiert (Schwelle 3)', async () => {
	await withOperator(async () => {
		const sent = [];
		const deps = { record: async () => {}, gate: countingGate(), alert: async (t) => sent.push(t) };
		for (let i = 0; i < 6; i++) await recordSecurityEvent(SECURITY_EVENT.WEBHOOK_AUTH_FAILED, { source: 'telegram', fingerprint: 'aaaa1111bbbb' }, deps);
		assert.equal(sent.length, 1);
		assert.ok(sent[0].includes('Webhook'));
	});
});

test('ALERT-3 Rate-Limit-Burst alarmiert (Schwelle 20)', async () => {
	await withOperator(async () => {
		const sent = [];
		const deps = { record: async () => {}, gate: countingGate(), alert: async (t) => sent.push(t) };
		for (let i = 0; i < 25; i++) await recordSecurityEvent(SECURITY_EVENT.RATE_LIMIT_BLOCKED, { source: 'system', fingerprint: 'ffff0000ffff', scope: 'dashboard-login' }, deps);
		assert.equal(sent.length, 1);
		assert.ok(sent[0].includes('Rate-Limit'));
	});
});

test('ALERT-4 Cron-Fehler alarmiert einmal, Cooldown verhindert zweiten', async () => {
	await withOperator(async () => {
		const sent = [];
		const gate = countingGate();
		const alert = async (t) => sent.push(t);
		await alertOperatorCronFailure('purge', { gate, alert });
		await alertOperatorCronFailure('purge', { gate, alert });
		assert.equal(sent.length, 1);
		assert.ok(sent[0].includes('Cron-Fehler'));
		assert.equal(sent[0].includes('purge'), true);
	});
});

test('ALERT ohne Operator-Destination kein Alert (auch ueber Schwelle)', async () => {
	// Env NICHT gesetzt -> alertingConfigured false.
	const sent = [];
	const deps = { record: async () => {}, gate: countingGate(), alert: async (t) => sent.push(t) };
	for (let i = 0; i < 15; i++) await recordSecurityEvent(SECURITY_EVENT.SIWE_SIGNATURE_INVALID, { source: 'dashboard', fingerprint: 'abc123def456' }, deps);
	assert.equal(sent.length, 0);
});

test('ALERT Telegram-Sendefehler kippt nichts (best effort)', async () => {
	await withOperator(async () => {
		const gate = countingGate();
		// alert wirft -> maybeAlertOperator faengt und gibt false zurueck.
		for (let i = 0; i < 7; i++) {
			const r = await recordSecurityEvent(SECURITY_EVENT.SIWE_SIGNATURE_INVALID, { source: 'dashboard', fingerprint: 'abc123def456' }, { record: async () => {}, gate, alert: async () => { throw new Error('telegram down'); } });
			assert.equal(typeof r, 'boolean');
		}
	});
	// sendOperatorAlert selbst mit kaputtem fetch -> false, kein Wurf.
	await withOperator(async () => {
		const ok = await sendOperatorAlert('x', { fetchImpl: async () => { throw new Error('net'); } });
		assert.equal(ok, false);
	});
});

test('ALERT chat_id kommt nur aus ENV (sendOperatorAlert nutzt keine Parameter-ID)', () => {
	const code = readFileSync(new URL('../src/security-events.mjs', import.meta.url), 'utf8');
	assert.ok(code.includes("process.env.OPERATOR_TELEGRAM_CHAT_ID"));
	assert.ok(code.includes('chat_id: chatId'));
	// operatorChatId validiert und liest ausschliesslich aus der Umgebung.
	assert.match(code, /function operatorChatId\(\)\s*\{[\s\S]*process\.env\.OPERATOR_TELEGRAM_CHAT_ID[\s\S]*\}/);
	assert.equal(code.includes('request.'), false, 'keine Request-Nutzung im Alert-Modul');
});

test('ALERT api/alerts.mjs meldet Cron-Fehler generisch, ohne Rohfehler', () => {
	const a = readFileSync(new URL('../api/alerts.mjs', import.meta.url), 'utf8');
	assert.ok(a.includes("alertOperatorCronFailure('expiry-alert-run')"));
	assert.ok(a.includes("alertOperatorCronFailure('purge')"));
	assert.equal(/alertOperatorCronFailure\([^)]*error/.test(a), false, 'kein roher Fehlertext an den Alert');
});
