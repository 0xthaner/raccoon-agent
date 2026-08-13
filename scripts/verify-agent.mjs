import { createClient } from '@supabase/supabase-js';
import { checkExpiryAlerts } from '../src/alerts.mjs';
import { getMonitoredWallets, renameMonitoredWallet, setPrimaryWallet, setWalletAlertSettings, snoozeCoverAlert } from '../src/db.mjs';
import { DEMO_WALLET } from '../src/covers.mjs';

const chatId = `integration-test-${Date.now()}`;
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const sent = [];

async function clean() {
	for (const table of ['alert_snoozes', 'cover_snapshots', 'sent_alerts', 'weekly_summary_log', 'monitored_wallets', 'user_preferences']) {
		const { error } = await db.from(table).delete().eq('chat_id', chatId);
		if (error) throw error;
	}
}

try {
	await clean();
	const { error } = await db.from('monitored_wallets').insert({ chat_id: chatId, wallet: DEMO_WALLET, label: 'Integration Test', is_primary: true, alerts_enabled: true, alert_thresholds: [] });
	if (error) throw error;
	await checkExpiryAlerts({ sendMessage: async (target, text) => sent.push({ target, text }), now: Date.parse('2026-08-13T12:00:00Z') });
	const snapshots = await db.from('cover_snapshots').select('cover_id').eq('chat_id', chatId);
	if (snapshots.error || snapshots.data.length === 0) throw snapshots.error ?? new Error('Cover snapshot was not created');
	if (sent.length !== 0) throw new Error(`Initial snapshot unexpectedly sent ${sent.length} message(s)`);
	await db.from('cover_snapshots').update({ ends_at: '2026-07-01T12:00:00Z' }).match({ chat_id: chatId, cover_id: '424242' });
	await checkExpiryAlerts({ sendMessage: async (target, text) => sent.push({ target, text }), now: Date.parse('2026-08-13T12:00:00Z') });
	if (!sent.some((message) => message.text.includes('Verlängerung bestätigt'))) throw new Error('Extended expiry was not recognized as renewal');
	sent.length = 0;
	await db.from('cover_snapshots').delete().match({ chat_id: chatId, cover_id: '424242' });
	await db.from('cover_snapshots').insert({ chat_id: chatId, wallet: DEMO_WALLET, cover_id: 'previous-cover', product_id: '1', status: 'active', ends_at: '2026-05-28T12:00:00Z' });
	await checkExpiryAlerts({ sendMessage: async (target, text) => sent.push({ target, text }), now: Date.parse('2026-08-13T12:00:00Z') });
	if (!sent.some((message) => message.text.includes('Verlängerung bestätigt'))) throw new Error('Replacement cover ID was not recognized as renewal');
	sent.length = 0;
	await db.from('cover_snapshots').delete().eq('chat_id', chatId);
	await db.from('cover_snapshots').insert({ chat_id: chatId, wallet: DEMO_WALLET, cover_id: 'old-cover', status: 'expired' });
	await checkExpiryAlerts({ sendMessage: async (target, text) => sent.push({ target, text }), now: Date.parse('2026-08-13T12:00:00Z') });
	if (!sent.some((message) => message.text.includes('Neues Cover erkannt'))) throw new Error('New cover was not detected');
	sent.length = 0;
	await db.from('cover_snapshots').update({ status: 'expired' }).match({ chat_id: chatId, cover_id: '424242' });
	await checkExpiryAlerts({ sendMessage: async (target, text) => sent.push({ target, text }), now: Date.parse('2026-08-13T12:00:00Z') });
	if (!sent.some((message) => message.text.includes('Cover-Status geändert'))) throw new Error('Cover status change was not detected');
	sent.length = 0;
	await snoozeCoverAlert(chatId, DEMO_WALLET, 424242, Date.parse('2026-08-13T11:00:00Z'));
	await checkExpiryAlerts({ sendMessage: async (target, text) => sent.push({ target, text }), now: Date.parse('2026-08-13T12:00:00Z') });
	if (sent.length !== 1 || !sent[0].text.includes('Erinnerung wie gewünscht')) throw new Error('Due snooze was not delivered exactly once');
	const snoozes = await db.from('alert_snoozes').select('cover_id').eq('chat_id', chatId);
	if (snoozes.error || snoozes.data.length !== 0) throw snoozes.error ?? new Error('Delivered snooze was not cleared');
	sent.length = 0;
	await db.from('monitored_wallets').update({ weekly_summary: true }).eq('chat_id', chatId);
	await checkExpiryAlerts({ sendMessage: async (target, text) => sent.push({ target, text }), now: Date.parse('2026-08-17T08:00:00Z') });
	if (!sent.some((message) => message.text.includes('Wöchentliche Cover-Übersicht'))) throw new Error('Weekly summary was not delivered');
	const secondWallet = '0x0000000000000000000000000000000000000001';
	await db.from('monitored_wallets').insert({ chat_id: chatId, wallet: secondWallet, label: 'Wallet 2', is_primary: false, alerts_enabled: true });
	await renameMonitoredWallet(chatId, secondWallet, 'Treasury');
	await setPrimaryWallet(chatId, secondWallet);
	await setWalletAlertSettings(chatId, secondWallet, { thresholds: [7, 1, 0], weeklySummary: true });
	const wallets = await getMonitoredWallets(chatId); const treasury = wallets.find((item) => item.wallet === secondWallet);
	if (wallets.length !== 2 || treasury?.label !== 'Treasury' || !treasury.is_primary || treasury.alert_thresholds.join(',') !== '7,1,0' || !treasury.weekly_summary) throw new Error('Multi-wallet settings were not persisted correctly');
	console.log(JSON.stringify({ snapshots: snapshots.data.length, renewalDetection: 'ok', replacementRenewalDetection: 'ok', newCoverDetection: 'ok', statusDetection: 'ok', snoozeDelivery: 'ok', weeklySummary: 'ok', namedMultiWallet: 'ok' }));
} finally {
	await clean();
}
