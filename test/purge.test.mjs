/**
 * Taegliche Bereinigung (purgeOldRecords in src/db.mjs). Offline mit einem
 * nachgebauten Supabase-Client, der nur aufzeichnet.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { purgeOldRecords, RETENTION_DAYS } from '../src/db.mjs';

function client({ kaputt = null } = {}) {
	const aufrufe = [];
	return {
		aufrufe,
		from(table) {
			return {
				delete(options) {
					return {
						lt: async (column, before) => {
							aufrufe.push({ table, column, before, options });
							if (table === kaputt) return { error: { message: 'gesperrt' }, count: null };
							return { error: null, count: 3 };
						}
					};
				}
			};
		}
	};
}

const NOW = Date.parse('2026-10-01T08:00:00Z');

test('Protokolle nach 90 Tagen, Login-Codes nach Ablauf', async () => {
	const c = client();
	const r = await purgeOldRecords({ client: c, now: NOW });
	assert.equal(RETENTION_DAYS, 90);
	const grenze = new Date(NOW - 90 * 86_400_000).toISOString();
	const erwartet = {
		agent_events: ['occurred_at', grenze],
		telegram_deliveries: ['attempted_at', grenze],
		sent_alerts: ['ends_at', grenze],
		weekly_summary_log: ['sent_at', grenze],
		dashboard_challenges: ['expires_at', new Date(NOW).toISOString()]
	};
	assert.deepEqual(Object.fromEntries(c.aufrufe.map((a) => [a.table, [a.column, a.before]])), erwartet);
	assert.ok(c.aufrufe.every((a) => a.options?.count === 'exact'));
	assert.equal(r.agent_events, 3);
});

test('der Dienst selbst wird nie bereinigt', async () => {
	const c = client();
	await purgeOldRecords({ client: c, now: NOW });
	for (const tabu of ['wallet_links', 'monitored_wallets', 'user_preferences', 'cover_snapshots', 'chat_product_context']) {
		assert.ok(!c.aufrufe.some((a) => a.table === tabu), tabu);
	}
});

test('eine gesperrte Tabelle haelt die anderen nicht auf', async () => {
	const c = client({ kaputt: 'agent_events' });
	const r = await purgeOldRecords({ client: c, now: NOW });
	assert.match(String(r.agent_events), /fehler: gesperrt/);
	assert.equal(r.dashboard_challenges, 3);
	assert.equal(c.aufrufe.length, 5);
});
