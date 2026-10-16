/**
 * Cron-Endpunkt-Authentisierung (CRSF Phase 2B, CR-API-002 P1/P3).
 *
 * Laedt den echten Handler aus api/alerts.mjs mit eingesetzten Abhaengigkeiten
 * (gleiches Muster wie m1-alert-run-budget.test.mjs) und zaehlt jede Arbeit:
 * Erinnerungslauf, Bereinigung, Telegram-Zustellung, Operator-Alarm. Ein
 * abgelehnter Aufruf darf davon NICHTS ausloesen - die Pruefung muss vor jeder
 * Datenbank-, Provider- oder Telegram-Arbeit greifen.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SECRET = 'cron-secret-for-tests-0123456789';

function loadCron(env) {
	const work = { runs: 0, purges: 0, deliveries: 0, alerts: [] };
	const deps = {
		timingSafeEqual: (a, b) => a.equals(b), Buffer,
		checkExpiryAlerts: async () => { work.runs++; return { subscriptions: 0, sent: 0, summaries: 0, failed: 0, snoozes: 0, lookups: 0, budgetExhausted: null, continuation: false }; },
		beginTelegramDelivery: async () => { work.deliveries++; return null; }, finishTelegramDelivery: async () => {},
		purgeOldRecords: async () => { work.purges++; return { agent_events: 0 }; },
		alertOperatorCronFailure: async (reason) => { work.alerts.push(reason); }, telegramText: (t) => t,
		process: { env: { TELEGRAM_BOT_TOKEN: 'offline-placeholder', APP_BASE_URL: 'https://coverraccoon.com', ...env } },
		console: { error() {}, warn() {}, log() {} }
	};
	const body = readFileSync(new URL('../api/alerts.mjs', import.meta.url), 'utf8').replace(/^import [^;]*;\n/gm, '').replace('export default async function handler', 'async function handler');
	const handler = new Function(...Object.keys(deps), `${body}\nreturn handler;`)(...Object.values(deps));
	return { handler, work };
}
const call = async (handler, headers, method = 'GET') => {
	const res = { status(n) { this.code = n; return this; }, json(b) { this.body = b; return this; } };
	await handler({ method, headers }, res);
	return res;
};
const nothingDone = (work, label) => assert.deepEqual(work, { runs: 0, purges: 0, deliveries: 0, alerts: [] }, `${label}: no run, purge, delivery or alert`);

test('CRON-AUTH: the correct secret reaches the authenticated run', async () => {
	const { handler, work } = loadCron({ CRON_SECRET: SECRET });
	const res = await call(handler, { authorization: `Bearer ${SECRET}` });
	assert.equal(res.code, 200);
	assert.equal(work.runs, 1, 'the reminder run happened');
	assert.equal(work.purges, 1, 'the purge happened');
});

test('CRON-AUTH: missing, wrong or malformed secrets are rejected before any work', async () => {
	const sameLength = `${SECRET.slice(0, -1)}X`;
	const cases = {
		'no authorization header': {},
		'empty authorization header': { authorization: '' },
		'wrong secret, same length': { authorization: `Bearer ${sameLength}` },
		'wrong secret, other length': { authorization: 'Bearer short' },
		'secret without Bearer scheme': { authorization: SECRET },
		'lower-case scheme': { authorization: `bearer ${SECRET}` },
		'secret with trailing space': { authorization: `Bearer ${SECRET} ` },
		'Bearer only': { authorization: 'Bearer ' },
		'non-string header': { authorization: [`Bearer ${SECRET}`] }
	};
	for (const [label, headers] of Object.entries(cases)) {
		const { handler, work } = loadCron({ CRON_SECRET: SECRET });
		const res = await call(handler, headers);
		assert.equal(res.code, 401, label);
		assert.deepEqual(res.body, { ok: false }, label);
		nothingDone(work, label);
	}
});

test('CRON-AUTH: an unconfigured CRON_SECRET fails closed for every request', async () => {
	for (const configured of [undefined, '', '   ']) {
		for (const authorization of [undefined, '', 'Bearer ', 'Bearer undefined', 'Bearer    ', `Bearer ${SECRET}`]) {
			const env = configured === undefined ? {} : { CRON_SECRET: configured };
			const { handler, work } = loadCron(env);
			const res = await call(handler, authorization === undefined ? {} : { authorization });
			const label = `CRON_SECRET=${JSON.stringify(configured)} authorization=${JSON.stringify(authorization)}`;
			assert.equal(res.code, 401, label);
			nothingDone(work, label);
		}
	}
});

test('CRON-AUTH: only GET is accepted, and the method check does no work either', async () => {
	const { handler, work } = loadCron({ CRON_SECRET: SECRET });
	const res = await call(handler, { authorization: `Bearer ${SECRET}` }, 'POST');
	assert.equal(res.code, 405);
	nothingDone(work, 'POST');
});
