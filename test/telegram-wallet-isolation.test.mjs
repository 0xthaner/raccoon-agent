import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const dbSource = await readFile(new URL('../src/db.mjs', import.meta.url), 'utf8');
const dashboardSource = await readFile(new URL('../api/dashboard.mjs', import.meta.url), 'utf8');

test('remembered-wallet lookups delimit the complete Telegram chat id', () => {
	assert.equal(dbSource.includes('`unlinked:${chatId}%`'), false);
	assert.equal((dbSource.match(/`unlinked:\$\{chatId\}:%`/g) ?? []).length, 5);
});

test('wallet lookup never selects an arbitrary Telegram chat', () => {
	const start = dbSource.indexOf('export async function getWalletLinkStateByWallet');
	const end = dbSource.indexOf('\nexport async function getMonitoredWallets', start);
	const branch = dbSource.slice(start, end);
	assert.ok(branch.includes('rows.length === 1 ? rows[0] : null'));
	assert.equal(branch.includes('.limit(1)'), false);
	assert.ok(branch.includes(".eq('wallet', wallet.toLowerCase())"));
});

test('dashboard exposes only aggregate linked state for ambiguous chat mappings', () => {
	assert.ok(dashboardSource.includes('getWalletLinkStateByWallet'));
	assert.ok(dashboardSource.includes('telegramLinked: telegramState.linked'));
	assert.ok(dashboardSource.includes('const telegramLink = telegramState.link'));
});

test('wallet-authorized unlink deletes only that wallet, never the whole chat', () => {
	const start = dbSource.indexOf('export async function unlinkWalletByWallet');
	const end = dbSource.indexOf('\nexport async function revokeDashboardSessions', start);
	const branch = dbSource.slice(start, end);
	assert.ok(branch.includes('if (matches.length !== 1) return []'));
	assert.ok(branch.includes(".match({ chat_id: chatId, wallet: normalized })"));
	assert.equal(branch.includes("from('monitored_wallets').delete().eq('chat_id', chatId)"), false);
	assert.ok(branch.includes('if (!remaining.length)'));
});
