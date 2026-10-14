import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { runOperatorRevoke } from '../scripts/revoke-dashboard-wallet.mjs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const sql = read('../supabase/migrations/20261006120000_atomic_dashboard_revocation.sql');
const source = read('../src/db.mjs');
const wallet = `0x${'ab'.repeat(20)}`;
const writer = source.slice(source.indexOf('export async function revokeDashboardSessions'), source.indexOf('export async function isDashboardSessionRevoked'));

// These are SQL contract checks, not a substitute for executing the migration
// in an isolated PostgreSQL instance during migration review.
test('RPC validates every marker before mutation and retains the maximum', () => {
	assert.match(sql, /security invoker/i);
	assert.doesNotMatch(sql, /security definer/i);
	assert.match(sql, /normalized !~ '\^0x\[0-9a-f\]\{40\}\$'/);
	assert.match(sql, /requested_cutoff is null or requested_cutoff < 1/);
	assert.match(sql, /effective_cutoff bigint := requested_cutoff/); // first revoke
	assert.match(sql, /for stored in[\s\S]*where chat_id = 'revoked:' \|\| normalized for update/);
	assert.match(sql, /stored\.nonce !~ '\^\[0-9\]\{1,16\}\$'/);
	assert.match(sql, /parsed := stored\.nonce::bigint/);
	assert.match(sql, /raise exception 'Malformed stored revocation cutoff'/);
	assert.match(sql, /effective_cutoff := greatest\(effective_cutoff, parsed\)/); // earlier/later and duplicates
	assert.ok(sql.indexOf('end loop;') < sql.indexOf('delete from public.pending_links'));
});

test('RPC serializes wallet revokes and commits one compatible marker plus access deletion', () => {
	assert.match(sql, /pg_advisory_xact_lock\(hashtextextended\('dashboard-revoke:' \|\| normalized, 0\)\)/);
	assert.ok(sql.indexOf('pg_advisory_xact_lock') < sql.indexOf('for stored in'));
	assert.equal((sql.match(/insert into public.pending_links/g) ?? []).length, 1);
	assert.match(sql, /delete from public.pending_links where chat_id = 'revoked:' \|\| normalized/);
	assert.match(sql, /'revoked_wallet_' \|\| normalized, 'revoked:' \|\| normalized,[\s\S]*effective_cutoff::text/);
	assert.match(sql, /interval '3650 days'/);
	assert.match(sql, /where chat_id like 'dashboard:%' and nonce = normalized/);
	assert.match(sql, /return effective_cutoff/);
	assert.doesNotMatch(sql, /exception\s+when/i); // no swallowed error/partial commit
	assert.match(sql, /begin;[\s\S]*commit;/);
});

test('RPC execution is explicitly service-role-only with no table permission changes', () => {
	assert.match(sql, /revoke all on function public\.revoke_dashboard_sessions_atomic\(text, bigint\) from public, anon, authenticated;/);
	assert.match(sql, /grant execute on function public\.revoke_dashboard_sessions_atomic\(text, bigint\) to service_role;/);
	assert.doesNotMatch(sql, /alter table|grant .* on table|create table/i);
});

function helperWith(db) {
	return vm.runInNewContext(`(${writer.replace('export ', '').trim()})`, {
		db, value: (result) => { if (result.error) throw result.error; return result.data; }
	});
}

test('DB helper calls only RPC, returns effective cutoff and never falls back', async () => {
	const calls = [];
	const revoke = helperWith({ rpc: async (...args) => { calls.push(args); return { data: 200 }; } });
	assert.equal(await revoke(wallet.toUpperCase(), 100), 200);
	assert.equal(calls[0][0], 'revoke_dashboard_sessions_atomic');
	assert.equal(calls[0][1].revoke_wallet, wallet);
	assert.equal(calls[0][1].requested_cutoff, 100);
	assert.doesNotMatch(writer, /\.from\(|\.delete\(|\.insert\(/);
	await assert.rejects(helperWith({ rpc: async () => ({ error: new Error('RPC unavailable') }) })(wallet, 100));
	for (const data of [null, 99, '200', NaN]) {
		await assert.rejects(helperWith({ rpc: async () => ({ data }) })(wallet, 100));
	}
});

test('unchanged reader rejects at/before cutoff and accepts after, including old markers', async () => {
	const reader = source.slice(source.indexOf('export async function isDashboardSessionRevoked'), source.indexOf('export async function getLanguage'));
	const check = vm.runInNewContext(`(${reader.replace('export ', '').trim()})`, {
		db: { from: () => ({ select: () => ({ eq: () => ({ limit: async () => ({ data: [{ nonce: '200' }] }) }) }) }) },
		value: (result) => result.data
	});
	assert.equal(await check(wallet, 199), true);
	assert.equal(await check(wallet, 200), true);
	assert.equal(await check(wallet, 201), false);
	assert.equal(await check(wallet, NaN), true);
	assert.doesNotMatch(reader, /revoked_wallet_/); // code-independent legacy compatibility
});

test('operator validates arguments before loading DB, without echoing rejected input', async () => {
	for (const args of [[], ['bad'], [wallet, 'x'.repeat(65)], [wallet, ''], [wallet, 'a b'], [wallet, '--token', 'secret'], [wallet, '--secret']]) {
		let loaded = false;
		const output = [];
		assert.equal(await runOperatorRevoke(args, { load: async () => { loaded = true; }, write: (line) => output.push(line) }), 1);
		assert.equal(loaded, false);
		assert.equal(output.length, 1);
	}
});

test('operator revokes normalized wallet then records a bounded incident and fixed operator source', async () => {
	const calls = [];
	const output = [];
	const status = await runOperatorRevoke([wallet.toUpperCase().replace('0X', '0x'), 'I'.repeat(64)], {
		load: async () => ({ revokeDashboardSessions: async (w) => { calls.push(w); return 200; }, recordAgentEvent: async (event) => calls.push(event) }),
		write: (line) => output.push(line)
	});
	assert.equal(status, 0);
	assert.equal(calls[0], wallet);
	assert.equal(calls[1].eventType, 'dashboard.sessions_revoked_by_operator');
	assert.equal(calls[1].source, 'system');
	assert.deepEqual(calls[1].metadata, { effectiveCutoff: 200, operatorSource: 'cli-operator', incidentReference: 'I'.repeat(64) });
	assert.equal(output.length, 1);
});

test('operator distinguishes revoke failure from audit failure without undo or error leaks', async () => {
	for (const failure of ['revoke', 'audit']) {
		const calls = [];
		const output = [];
		const status = await runOperatorRevoke([wallet], {
			load: async () => ({
				revokeDashboardSessions: async () => { calls.push('revoke'); if (failure === 'revoke') throw new Error('SECRET'); return 200; },
				recordAgentEvent: async () => { calls.push('audit'); throw new Error('SECRET'); }
			}), write: (line) => output.push(line)
		});
		assert.equal(status, failure === 'revoke' ? 1 : 2);
		assert.deepEqual(calls, failure === 'revoke' ? ['revoke'] : ['revoke', 'audit']);
		assert.equal(output.join('').includes('SECRET'), false);
		if (failure === 'audit') assert.deepEqual(output, ['revoked; audit incomplete']);
	}
});

test('logout failure leaves UI intact and successful logout follows existing reset path', async () => {
	const frontend = read('../web/src/main.js');
	const code = frontend.slice(frontend.indexOf('async function endSession('), frontend.indexOf('function enable()'));
	for (const mode of ['http', 'body', 'network', 'success']) {
		const calls = [];
		const logout = vm.runInNewContext(`(${code.trim()})`, {
			authFetch: async () => { if (mode === 'network') throw new Error(); return { ok: mode !== 'http', json: async () => ({ ok: mode !== 'body' }) }; },
			show: () => calls.push('show'), language: 'en', walletConnectPromise: null,
			frischeBestaetigung: async () => null, debugWallet: () => {}, // EOA: keine frische Bestaetigung (AUDIT SA-L1)
			clearWalletStorage: async () => calls.push('clear'), location: { reload: () => calls.push('reload') }
		});
		await logout({ disconnect: true });
		assert.deepEqual(calls, mode === 'success' ? ['show', 'clear', 'reload'] : ['show', 'show']);
	}
});
