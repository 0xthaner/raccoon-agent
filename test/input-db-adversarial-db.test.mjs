/*
	CRSF Phase 2N, CR-INPUT-004 gegen ECHTEN Postgres.

	P1 ("runtime builds no SQL strings from input"): der echte src/db.mjs mit dem
	echten supabase-js; jede PostgREST-Anfrage wird wie von PostgREST in EIN
	Statement mit gebundenen Parametern uebersetzt (test-support/pg-postgrest.mjs:
	eq/gt/lt/like/is als $n). Feindselige Werte treffen nichts, aendern nichts
	Fremdes und landen woertlich in der Datenbank. Die LIKE-Muster je Chat
	(`unlinked:<chat>:%`) sind am Doppelpunkt verankert: Chat 1 trifft nie Chat 12.
	Die drei LIKE-Helfer (getRememberedWallet(s), forgetRememberedWallet) haben
	eine Vorbedingung: chatId ist eine Telegram-Chat-ID, die der Aufrufer als
	positive ganze Zahl geprueft hat (test/input-db-request-structure.test.mjs).
	Mit rohem '%' wuerden sie Platzhalter auswerten; deshalb laufen sie hier nur
	mit ihrem erreichbaren Wertebereich.

	P2 ("SQL functions use no EXECUTE with untrusted text"): jede aufrufbare
	Funktion im Schema public (aus allen Migrationen) mit feindseligen
	Text-Argumenten - kein Syntaxfehler, keine fremde Zeile, Werte woertlich; dazu
	der Katalog: genau die bekannten Funktionen, keine mit EXECUTE oder format(),
	jede SECURITY DEFINER mit festem search_path, keine Trigger.

	Nur mit Wegwerf-Postgres (M1_DB_TEST_PG_URL / M1_DB_TEST_PG_MODULE), sonst
	sichtbar uebersprungen.
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { postgrestOverPg } from '../test-support/pg-postgrest.mjs';
import { dropTestDatabase } from '../test-support/drop-test-db.mjs';
import { ADVERSARIAL } from '../test-support/adversarial-values.mjs';

const URL_ = process.env.M1_DB_TEST_PG_URL;
const MODULE = process.env.M1_DB_TEST_PG_MODULE;
const skip = !URL_ || !MODULE ? 'M1_DB_TEST_PG_URL / M1_DB_TEST_PG_MODULE nicht gesetzt (Wegwerf-Postgres noetig)' : false;
const MIGRATIONS = new URL('../supabase/migrations/', import.meta.url);
const HOST = 'input-db-test.invalid';

process.env.SUPABASE_URL = `https://${HOST}`;
process.env.SUPABASE_SECRET_KEY = 'input-db-test-not-a-key';

let pg, dbUrl, rest, sql;
const connect = async () => { const c = new pg.Client({ connectionString: dbUrl, statement_timeout: 20_000 }); await c.connect(); return c; };
globalThis.fetch = (input, init) => rest.fetch(input, init);
const db = await import('../src/db.mjs');

async function setup() {
	pg = (await import(MODULE)).default;
	pg.types.setTypeParser(1184, (text) => text);
	if (!/^postgres:\/\/[^@]*@(127\.0\.0\.1|localhost)[:/]/.test(URL_)) throw new Error('Nur gegen einen lokalen Wegwerf-Postgres.');
	const admin = new pg.Client({ connectionString: URL_ });
	await admin.connect();
	const name = `inputdb_${process.pid}`;
	await admin.query(`drop database if exists ${name}`);
	await admin.query(`create database ${name}`);
	for (const role of ['anon', 'authenticated', 'service_role', 'supabase_admin']) {
		await admin.query(`do $$ begin if not exists (select 1 from pg_roles where rolname = '${role}') then create role ${role}; end if; end $$`);
	}
	await admin.end();
	dbUrl = URL_.replace(/\/[^/]*$/, `/${name}`);
	const c = await connect();
	for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) await c.query(readFileSync(new URL(file, MIGRATIONS), 'utf8'));
	await c.end();
	rest = postgrestOverPg({ host: HOST, connect, maxConnections: 8 });
	await rest.warm(8);
	sql = await connect();
}

/* -------------------------------------------------------------- Daten -- */

const VICTIM_CHAT = '777001';
const VICTIM_WALLET = '0x' + 'a7'.repeat(20);
const VICTIM_CODE = 'VictimLinkCode0123456789';
const VICTIM_ACCESS = 'VictimDashboardAccessCode0123456';
const VICTIM_NONCE = 'victim-nonce-0123456789';
const DEPLOYMENT = 'aave-v3-ethereum-core';
const FUTURE = new Date(Date.now() + 3_600_000).toISOString();

/** Ein Opfer in jeder Tabelle, die eine Eingabe-gesteuerte Abfrage trifft. */
async function seedVictim() {
	await sql.query(`insert into public.pending_links (code, chat_id, nonce, expires_at) values
		($1, $2, 'victim-link-nonce', $5), ($3, 'dashboard:' || $3, $4, $5), ('unlinked_victim', 'unlinked:' || $2 || ':' || $4, $4, $5)`, [VICTIM_CODE, VICTIM_CHAT, VICTIM_ACCESS, VICTIM_WALLET, FUTURE]);
	await sql.query('insert into public.monitored_wallets (chat_id, wallet, label, is_primary) values ($1, $2, $3, true)', [VICTIM_CHAT, VICTIM_WALLET, 'Victim']);
	await sql.query('insert into public.wallet_links (chat_id, wallet) values ($1, $2)', [VICTIM_CHAT, VICTIM_WALLET]);
	await sql.query("insert into public.user_preferences (chat_id, language) values ($1, 'de')", [VICTIM_CHAT]);
	await sql.query('insert into public.dashboard_challenges (nonce, wallet, expires_at) values ($1, $2, $3)', [VICTIM_NONCE, VICTIM_WALLET, FUTURE]);
	await sql.query(`insert into public.position_cover_attributions (wallet, protocol_key, protocol_version, deployment_key, product_id, cover_id, confirmed_at, updated_at)
		values ($1, 'aave', 'v3', $2, 97, 1, now(), now())`, [VICTIM_WALLET, DEPLOYMENT]);
	await sql.query("insert into public.alert_snoozes (chat_id, wallet, cover_id, remind_at) values ($1, $2, '1', $3)", [VICTIM_CHAT, VICTIM_WALLET, FUTURE]);
	await sql.query("insert into public.cover_snapshots (chat_id, wallet, cover_id, status) values ($1, $2, '1', 'active')", [VICTIM_CHAT, VICTIM_WALLET]);
}

/** Inhalt jeder Tabelle (ohne Ratenzaehler und Protokolle, die die Tests absichtlich schreiben). */
async function snapshot() {
	const { rows } = await sql.query(`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
		where n.nspname = 'public' and c.relkind = 'r' order by 1`);
	const out = {};
	for (const { relname } of rows) {
		if (['api_rate_limits', 'agent_events', 'telegram_deliveries'].includes(relname)) continue;
		const data = await sql.query(`select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) as h, count(*)::int as n from public.${relname} t`);
		out[relname] = `${data.rows[0].n}:${data.rows[0].h}`;
	}
	return out;
}

/** Ein Fehler ist nur als sicherer Datenfehler erlaubt - nie als Syntax-/Objektfehler. */
const SAFE_ERRORS = new Set(['22P02', '22007', '22008', '23514', '22003', 'P0001']);
async function safely(label, fn) {
	try { return { value: await fn() }; } catch (error) {
		assert.ok(SAFE_ERRORS.has(error?.code), `${label}: SQL syntax/structure error ${error?.code} ${error?.message}`);
		return { error: error.code };
	}
}
const reset = async () => {
	for (const t of ['pending_links', 'monitored_wallets', 'wallet_links', 'user_preferences', 'dashboard_challenges', 'position_cover_attributions', 'alert_snoozes', 'cover_snapshots', 'api_rate_limits', 'agent_events', 'telegram_deliveries', 'chat_product_context']) await sql.query(`delete from public.${t}`);
	await seedVictim();
};

// Nach allen Migrationen (consume_dashboard_challenge und consume_telegram_handoff sind entfernt).
const KNOWN_FUNCTIONS = ['alert_subscriptions_page', 'check_agent_rate_limit', 'consume_wallet_link', 'consume_wallet_link_v2',
	'link_wallet_to_chat_limited', 'lock_chat_wallets', 'revoke_dashboard_sessions_atomic', 'upsert_position_attribution_limited'];

test('INPUT-DB-PG', { skip, timeout: 300_000 }, async (t) => {
	await setup();
	t.after(() => dropTestDatabase(pg, URL_, dbUrl));
	try {
		t.beforeEach(reset);

		await t.test('INPUT-DB-PG P1 lookups and writes keyed by adversarial values match nothing and change nothing else', async () => {
			const before = await snapshot();
			for (const v of ADVERSARIAL) {
				const label = JSON.stringify(v);
				assert.equal((await safely(label, () => db.getPendingLink(v))).value, null, `${label}: getPendingLink widened`);
				assert.equal((await safely(label, () => db.consumeDashboardAccess(v))).value, null, `${label}: consumeDashboardAccess widened`);
				assert.equal((await safely(label, () => db.consumeDashboardChallenge(v, VICTIM_WALLET))).value, false, `${label}: challenge consumed`);
				assert.equal((await safely(label, () => db.consumeDashboardChallenge(VICTIM_NONCE, v))).value, false, `${label}: challenge consumed by wallet`);
				assert.equal((await safely(label, () => db.isDashboardChallengeOpen(v, VICTIM_WALLET))).value, false, `${label}: challenge open`);
				assert.deepEqual((await safely(label, () => db.getMonitoredWallets(v))).value, [], `${label}: wallets widened`);
				assert.deepEqual((await safely(label, () => db.getWalletLinkStateByWallet(v))).value, { linked: false, link: null }, `${label}: wallet state widened`);
				assert.equal((await safely(label, () => db.getLanguage(v))).value, null, `${label}: language widened`);
				assert.deepEqual((await safely(label, () => db.listPositionAttributions(v))).value, [], `${label}: attributions widened`);
				assert.deepEqual((await safely(label, () => db.getCoverSnapshots(v, v))).value, [], `${label}: snapshots widened`);
				assert.equal((await safely(label, () => db.isDashboardSessionRevoked(v, 1))).value, false, `${label}: revocation widened`);
				assert.equal((await safely(label, () => db.renameMonitoredWallet(v, VICTIM_WALLET, 'x'))).value, false, `${label}: rename widened`);
				assert.equal((await safely(label, () => db.setWalletAlertSettings(VICTIM_CHAT, v, { weeklySummary: true }))).value, null, `${label}: settings widened`);
				assert.equal((await safely(label, () => db.unlinkWallet(v))).value, false, `${label}: unlink widened`);
				await safely(label, () => db.clearSnooze(v, v, v));
				await safely(label, () => db.rescheduleSnooze(v, v, '1', Date.now()));
				const deleted = await safely(label, () => db.deletePositionAttribution(v, v, 1));
				if ('value' in deleted) assert.equal(deleted.value, 0, `${label}: attribution delete widened`);
				const stale = await safely(label, () => db.deleteStalePositionAttribution(VICTIM_WALLET, DEPLOYMENT, 1, v));
				if ('value' in stale) assert.equal(stale.value, 0, `${label}: stale delete widened`);
				assert.deepEqual((await safely(label, () => db.unlinkWalletByWallet(v))).value, [], `${label}: unlink by wallet widened`);
				assert.deepEqual((await safely(label, () => db.unlinkWalletFromAllChats(v))).value, [], `${label}: unlink all widened`);
				assert.equal((await safely(label, () => db.snoozeLinkedCoverAlert(v, VICTIM_WALLET, '1', Date.now()))).value, 'not_linked', `${label}: snooze widened`);
				assert.equal((await safely(label, () => db.wasAlertSent(v, v, Date.now(), 1))).value, false);
				assert.equal((await safely(label, () => db.getAlertSubscription(v, v))).value, null);
			}
			assert.deepEqual(await snapshot(), before, 'no row outside the adversarial keys changed');
		});

		await t.test('INPUT-DB-PG P1 adversarial values are stored and read back literally', async () => {
			for (const [i, v] of ADVERSARIAL.entries()) {
				const label = JSON.stringify(v);
				await db.recordAgentEvent({ chatId: v, wallet: v, eventType: v, source: 'telegram', command: `cmd-${i}`, coverId: v, metadata: { [v]: v } });
				const event = (await sql.query('select chat_id, wallet, event_type, cover_id, metadata from public.agent_events where command = $1', [`cmd-${i}`])).rows;
				assert.equal(event.length, 1, label);
				assert.deepEqual({ ...event[0], wallet: undefined }, { chat_id: v, wallet: undefined, event_type: v, cover_id: v, metadata: { [v]: v } }, `${label}: event stored literally`);
				assert.equal(event[0].wallet, v.toLowerCase(), `${label}: wallet stored literally (normalized)`);

				assert.equal(await db.renameMonitoredWallet(VICTIM_CHAT, VICTIM_WALLET, v), true, label);
				assert.equal((await db.getMonitoredWallets(VICTIM_CHAT))[0].label, v.trim(), `${label}: label stored literally`);

				assert.equal(await db.checkRateLimit(v, 5, 60), true, label);
				assert.equal((await sql.query('select count(*)::int as n from public.api_rate_limits where key_hash = $1', [v])).rows[0].n, 1, `${label}: rate key stored literally`);

				const code = `adv-${i}-${v}`;
				await db.createPendingLink({ code, chatId: v, nonce: v, expiresAt: Date.now() + 60_000 });
				const link = await db.getPendingLink(code);
				assert.deepEqual([link?.chat_id, link?.nonce], [v, v], `${label}: link stored literally`);
				assert.equal((await db.getPendingLink(VICTIM_CODE))?.chat_id, VICTIM_CHAT, `${label}: victim link survived createPendingLink`);

				await db.storeDashboardChallenge({ nonce: `n-${i}-${v}`, wallet: VICTIM_WALLET, expiresAt: Date.now() + 60_000 });
				assert.equal(await db.isDashboardChallengeOpen(`n-${i}-${v}`, VICTIM_WALLET), true, `${label}: exact challenge found`);
				assert.equal(await db.consumeDashboardChallenge(`n-${i}-${v}`, VICTIM_WALLET), true, `${label}: exact challenge consumed`);
			}
			assert.equal(await db.isDashboardChallengeOpen(VICTIM_NONCE, VICTIM_WALLET), true, 'victim challenge untouched');
		});

		await t.test('INPUT-DB-PG P1 per-chat LIKE patterns are anchored: chat 1 never touches chats 10, 12 or 100', async () => {
			for (const chat of ['1', '10', '12', '100']) {
				await sql.query("insert into public.pending_links (code, chat_id, nonce, expires_at) values ($1, $2, $3, $4)", [`unl-${chat}`, `unlinked:${chat}:0x${chat}`, `0x${chat}`, FUTURE]);
			}
			assert.deepEqual(await db.getRememberedWallets(1), ['0x1']);
			assert.equal(await db.getRememberedWallet(1), '0x1');
			await db.forgetRememberedWallet(1);
			const remembered = async () => (await sql.query("select chat_id from public.pending_links where chat_id like 'unlinked:%'")).rows.map((r) => r.chat_id).sort();
			const left = await remembered();
			assert.deepEqual(left, ['unlinked:100:0x100', 'unlinked:10:0x10', 'unlinked:12:0x12', `unlinked:${VICTIM_CHAT}:${VICTIM_WALLET}`], 'forget for chat 1 removed another chat\'s remembered wallet');
			// Verknuepfen ueber einen echten Code fuer Chat 1 raeumt nur dessen gemerkte Wallets.
			await sql.query("insert into public.pending_links (code, chat_id, nonce, expires_at) values ('Chat1LinkCode0123456789x', '1', 'n', $1), ('unl-1b', 'unlinked:1:0xold', '0xold', $1)", [FUTURE]);
			assert.deepEqual(await db.consumePendingLink('Chat1LinkCode0123456789x', '0x' + 'c1'.repeat(20)), { status: 'linked', chatId: '1' });
			assert.deepEqual(await remembered(), left, 'linking chat 1 removed another chat\'s remembered wallet');
		});

		await t.test('INPUT-DB-PG P2 every callable SQL function treats adversarial text arguments as values', async () => {
			const before = await snapshot();
			const call = (fn, args) => sql.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) as r`, args).then((res) => res.rows[0].r);
			for (const [i, v] of ADVERSARIAL.entries()) {
				const label = JSON.stringify(v);
				assert.equal((await safely(`${label} check_agent_rate_limit`, () => call('check_agent_rate_limit', [v, 60, 5]))).value, true);
				assert.equal((await sql.query('select count(*)::int as n from public.api_rate_limits where key_hash = $1', [v])).rows[0].n, 1, `${label}: rate key literal`);
				assert.deepEqual((await safely(`${label} consume_wallet_link_v2`, () => call('consume_wallet_link_v2', [v, VICTIM_WALLET]))).value, { status: 'invalid' }, `${label}: unknown code linked`);
				assert.equal((await safely(`${label} consume_wallet_link`, () => call('consume_wallet_link', [v, VICTIM_WALLET]))).value, null);
				assert.equal((await safely(`${label} revoke_dashboard_sessions_atomic`, () => call('revoke_dashboard_sessions_atomic', [v, 1]))).error, 'P0001', `${label}: malformed wallet accepted by revocation`);
				await safely(`${label} lock_chat_wallets`, () => call('lock_chat_wallets', [v]));
				const page = await safely(`${label} alert_subscriptions_page`, () => sql.query('select * from public.alert_subscriptions_page($1, $2, $3, $4, 50)', [v, v, null, null]));
				assert.ok(page.value.rows.every((r) => r.chat_id === VICTIM_CHAT), `${label}: page returned foreign rows`);
				const upsert = await safely(`${label} upsert_position_attribution_limited`, () => call('upsert_position_attribution_limited', [VICTIM_WALLET, 'aave', 'v3', v, 97, 1, new Date().toISOString()]));
				assert.equal(upsert.error, '23514', `${label}: deployment key not constrained`);
			}
			// Mit echtem Code: die Wallet aus dem Argument wird woertlich (kleingeschrieben) gespeichert, nur im Chat des Codes.
			for (const [i, v] of ADVERSARIAL.entries()) {
				const code = `AdvLinkCode${String(i).padStart(13, '0')}`;
				await sql.query("insert into public.pending_links (code, chat_id, nonce, expires_at) values ($1, $2, 'n', $3)", [code, `88${i}`, FUTURE]);
				assert.deepEqual(await call('consume_wallet_link_v2', [code, v]), { status: 'linked', chat_id: `88${i}` }, JSON.stringify(v));
				const stored = (await sql.query('select chat_id from public.monitored_wallets where wallet = lower($1)', [v])).rows.map((r) => r.chat_id);
				assert.deepEqual(stored, [`88${i}`], `${JSON.stringify(v)}: wallet stored literally in the code's chat only`);
				await sql.query('select public.link_wallet_to_chat_limited($1, $2)', [`adv:${v}`, v]);
				assert.equal((await sql.query('select count(*)::int as n from public.monitored_wallets where chat_id = $1 and wallet = lower($2)', [`adv:${v}`, v])).rows[0].n, 1, `${JSON.stringify(v)}: chat stored literally`);
			}
			const after = await snapshot();
			for (const table of Object.keys(before)) {
				if (['monitored_wallets', 'wallet_links', 'pending_links'].includes(table)) continue;
				assert.equal(after[table], before[table], `${table} changed by adversarial function calls`);
			}
			const victim = (await sql.query('select chat_id, wallet, label from public.monitored_wallets where chat_id = $1', [VICTIM_CHAT])).rows;
			assert.deepEqual(victim, [{ chat_id: VICTIM_CHAT, wallet: VICTIM_WALLET, label: 'Victim' }], 'victim chat changed');
		});

		await t.test('INPUT-DB-PG P2 catalog: exactly the known functions, none with EXECUTE or format(), SECURITY DEFINER with fixed search_path, no triggers', async () => {
			const { rows } = await sql.query(`select p.proname, p.prosrc, p.prosecdef, p.proconfig, l.lanname from pg_proc p
				join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang where n.nspname = 'public' order by 1`);
			assert.deepEqual([...new Set(rows.map((r) => r.proname))], KNOWN_FUNCTIONS, 'callable function inventory changed');
			for (const r of rows) {
				assert.ok(['plpgsql', 'sql'].includes(r.lanname), `${r.proname}: language ${r.lanname}`);
				const code = r.prosrc.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
				assert.doesNotMatch(code, /\bexecute\b/i, `${r.proname}: dynamic SQL (EXECUTE)`);
				assert.doesNotMatch(code, /\b(format|quote_ident|quote_literal|quote_nullable)\s*\(/i, `${r.proname}: SQL text construction`);
				if (r.prosecdef) assert.ok((r.proconfig ?? []).some((c) => /^search_path=/.test(c)), `${r.proname}: SECURITY DEFINER without fixed search_path`);
			}
			assert.equal((await sql.query("select count(*)::int as n from pg_trigger g join pg_class c on c.oid = g.tgrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and not g.tgisinternal")).rows[0].n, 0, 'trigger in public');
			assert.equal((await sql.query('select count(*)::int as n from pg_event_trigger')).rows[0].n, 0, 'event trigger');
		});
	} finally {
		await sql?.end();
		await rest?.close();
	}
});
