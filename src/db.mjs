import { randomBytes, randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL?.trim();
const secretKey = process.env.SUPABASE_SECRET_KEY?.trim();

if (!url || !secretKey) {
	throw new Error('SUPABASE_URL und SUPABASE_SECRET_KEY fehlen in .env.');
}

const db = createClient(url, secretKey, {
	auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
});

function value(result) {
	if (result.error) throw result.error;
	return result.data;
}

export async function createPendingLink({ code, chatId, nonce, expiresAt }) {
	const chat = String(chatId);
	value(await db.from('pending_links').delete().eq('chat_id', chat));
	value(await db.from('pending_links').delete().lt('expires_at', new Date().toISOString()));
	value(await db.from('pending_links').insert({
		code,
		chat_id: chat,
		nonce,
		expires_at: new Date(expiresAt).toISOString()
	}));
}

export async function getPendingLink(code) {
	const data = value(await db.from('pending_links').select('*').eq('code', code).maybeSingle());
	return data ? { ...data, expires_at: Date.parse(data.expires_at), used_at: data.used_at ? Date.parse(data.used_at) : null } : null;
}

export async function consumePendingLink(code, wallet) {
	const chatId = value(await db.rpc('consume_wallet_link', { link_code: code, linked_wallet: wallet.toLowerCase() }));
	if (chatId) value(await db.from('pending_links').delete().like('chat_id', `unlinked:${chatId}%`));
	return chatId;
}

export async function createTelegramHandoff({ code, wallet, expiresAt }) {
	const normalized = wallet.toLowerCase();
	const [expired, existing] = await Promise.all([
		db.from('telegram_handoffs').delete().lt('expires_at', new Date().toISOString()),
		db.from('telegram_handoffs').delete().eq('wallet', normalized).is('used_at', null)
	]);
	value(expired); value(existing);
	value(await db.from('telegram_handoffs').insert({
		code,
		wallet: normalized,
		expires_at: new Date(expiresAt).toISOString()
	}));
}

export async function consumeTelegramHandoff(code, chatId) {
	const wallet = value(await db.rpc('consume_telegram_handoff', { handoff_code: code, telegram_chat_id: String(chatId) }));
	if (wallet) value(await db.from('pending_links').delete().like('chat_id', `unlinked:${chatId}%`));
	return wallet;
}

export async function createDashboardAccess({ code, wallet, expiresAt }) {
	value(await db.from('pending_links').delete().lt('expires_at', new Date().toISOString()));
	value(await db.from('pending_links').insert({
		code,
		chat_id: `dashboard:${code}`,
		nonce: wallet.toLowerCase(),
		expires_at: new Date(expiresAt).toISOString()
	}));
}

export async function consumeDashboardAccess(code) {
	const rows = value(await db.from('pending_links')
		.update({ used_at: new Date().toISOString() })
		.eq('code', code)
		.like('chat_id', 'dashboard:%')
		.is('used_at', null)
		.gt('expires_at', new Date().toISOString())
		.select('nonce'));
	return rows[0]?.nonce ?? null;
}

export async function storeDashboardChallenge({ nonce, wallet, expiresAt }) {
	value(await db.from('dashboard_challenges').insert({ nonce, wallet: wallet.toLowerCase(), expires_at: new Date(expiresAt).toISOString() }));
}

export async function consumeDashboardChallenge(nonce, wallet) {
	const rows = value(await db.from('dashboard_challenges')
		.update({ used_at: new Date().toISOString() })
		.eq('nonce', nonce)
		.eq('wallet', wallet.toLowerCase())
		.is('used_at', null)
		.gt('expires_at', new Date().toISOString())
		.select('nonce'));
	return rows.length === 1;
}

export async function checkRateLimit(keyHash, maxRequests, windowSeconds) {
	return Boolean(value(await db.rpc('check_agent_rate_limit', {
		rate_key: keyHash,
		window_seconds: windowSeconds,
		max_requests: maxRequests
	})));
}

export async function claimTelegramUpdate(updateId) {
	if (!Number.isSafeInteger(updateId) || updateId < 0) return false;
	value(await db.from('telegram_updates').delete().lt('received_at', new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString()));
	const result = await db.from('telegram_updates').insert({ update_id: String(updateId) });
	if (result.error?.code === '23505') return false;
	value(result);
	return true;
}

export async function getWalletLink(chatId) {
	const wallets = await getMonitoredWallets(chatId);
	return wallets.find((wallet) => wallet.is_primary) ?? wallets[0] ?? null;
}

export async function getWalletLinkByWallet(wallet) {
	const rows = value(await db.from('monitored_wallets').select('chat_id,wallet,alerts_enabled,label,is_primary,alert_thresholds,weekly_summary').ilike('wallet', wallet.toLowerCase()).eq('alerts_enabled', true).limit(1));
	return rows[0] ?? null;
}

export async function getMonitoredWallets(chatId) {
	return value(await db.from('monitored_wallets').select('*').eq('chat_id', String(chatId)).order('is_primary', { ascending: false }).order('linked_at'));
}

export async function renameMonitoredWallet(chatId, wallet, label) {
	const clean = String(label ?? '').trim().slice(0, 32);
	if (!clean) throw new Error('Wallet-Name fehlt.');
	const rows = value(await db.from('monitored_wallets').update({ label: clean, updated_at: new Date().toISOString() }).match({ chat_id: String(chatId), wallet: wallet.toLowerCase() }).select('wallet'));
	return rows.length > 0;
}

export async function setPrimaryWallet(chatId, wallet) {
	const chat = String(chatId);
	value(await db.from('monitored_wallets').update({ is_primary: false, updated_at: new Date().toISOString() }).eq('chat_id', chat));
	const rows = value(await db.from('monitored_wallets').update({ is_primary: true, updated_at: new Date().toISOString() }).match({ chat_id: chat, wallet: wallet.toLowerCase() }).select('*'));
	if (rows[0]) value(await db.from('wallet_links').upsert({ chat_id: chat, wallet: rows[0].wallet, linked_at: new Date().toISOString(), alerts_enabled: rows[0].alerts_enabled }));
	return rows[0] ?? null;
}

export async function setWalletAlertSettings(chatId, wallet, { thresholds, weeklySummary }) {
	const update = { updated_at: new Date().toISOString() };
	if (thresholds) update.alert_thresholds = [...new Set(thresholds.map(Number))].filter((day) => [0, 1, 3, 7, 14, 30].includes(day)).sort((a, b) => b - a);
	if (typeof weeklySummary === 'boolean') update.weekly_summary = weeklySummary;
	const rows = value(await db.from('monitored_wallets').update(update).match({ chat_id: String(chatId), wallet: wallet.toLowerCase() }).select('*'));
	return rows[0] ?? null;
}

export async function unlinkWallet(chatId) {
	const chat = String(chatId);
	const data = value(await db.from('monitored_wallets').delete().eq('chat_id', chat).select('wallet'));
	value(await db.from('wallet_links').delete().eq('chat_id', chat));
	return data.length > 0;
}

export async function rememberUnlinkedWallet(chatId, wallet) {
	const normalized = wallet.toLowerCase();
	value(await db.from('pending_links').delete().eq('chat_id', `unlinked:${chatId}:${normalized}`));
	value(await db.from('pending_links').insert({
		code: `unlinked_${randomBytes(18).toString('base64url')}`,
		chat_id: `unlinked:${chatId}:${normalized}`,
		nonce: normalized,
		expires_at: new Date(Date.now() + 10 * 365 * 24 * 60 * 60_000).toISOString()
	}));
}

export async function getRememberedWallet(chatId) {
	const rows = value(await db.from('pending_links').select('nonce').like('chat_id', `unlinked:${chatId}%`).limit(1));
	return rows[0]?.nonce ?? null;
}

export async function getRememberedWallets(chatId) {
	const rows = value(await db.from('pending_links').select('nonce').like('chat_id', `unlinked:${chatId}%`));
	return [...new Set(rows.map((row) => row.nonce))];
}

export async function forgetRememberedWallet(chatId) {
	value(await db.from('pending_links').delete().like('chat_id', `unlinked:${chatId}%`));
}

export async function unlinkWalletByWallet(wallet) {
	const normalized = wallet.toLowerCase();
	const matches = value(await db.from('monitored_wallets').select('chat_id').ilike('wallet', normalized));
	const chats = [...new Set(matches.map((row) => row.chat_id))];
	for (const chatId of chats) {
		const wallets = value(await db.from('monitored_wallets').select('wallet').eq('chat_id', chatId));
		value(await db.from('monitored_wallets').delete().eq('chat_id', chatId));
		value(await db.from('wallet_links').delete().eq('chat_id', chatId));
		await Promise.all(wallets.map((item) => rememberUnlinkedWallet(chatId, item.wallet)));
	}
	return chats.map((chat_id) => ({ chat_id }));
}

export async function revokeDashboardSessions(wallet, now = Date.now()) {
	const normalized = wallet.toLowerCase();
	const [oldRevocation, openAccess] = await Promise.all([
		db.from('pending_links').delete().eq('chat_id', `revoked:${normalized}`),
		db.from('pending_links').delete().like('chat_id', 'dashboard:%').eq('nonce', normalized)
	]);
	value(oldRevocation);
	value(openAccess);
	value(await db.from('pending_links').insert({
		code: `revoked_${randomBytes(18).toString('base64url')}`,
		chat_id: `revoked:${normalized}`,
		nonce: String(now),
		expires_at: new Date(now + 10 * 365 * 24 * 60 * 60_000).toISOString()
	}));
	return now;
}

export async function isDashboardSessionRevoked(wallet, issuedAt) {
	if (!Number.isFinite(issuedAt)) return true;
	const rows = value(await db.from('pending_links').select('nonce').eq('chat_id', `revoked:${wallet.toLowerCase()}`).limit(1));
	const revokedAt = Number(rows[0]?.nonce);
	return Number.isFinite(revokedAt) && issuedAt <= revokedAt;
}

export async function getLanguage(chatId) {
	const data = value(await db.from('user_preferences').select('language').eq('chat_id', String(chatId)).maybeSingle());
	return data?.language ?? null;
}

export async function setLanguage(chatId, language) {
	if (!['de', 'en', 'zh'].includes(language)) throw new Error('Unsupported language');
	value(await db.from('user_preferences').upsert({
		chat_id: String(chatId),
		language,
		updated_at: new Date().toISOString()
	}));
}

export async function listAlertSubscriptions() {
	const links = value(await db.from('monitored_wallets').select('chat_id,wallet,label,alert_thresholds,weekly_summary').eq('alerts_enabled', true).order('chat_id'));
	if (!links.length) return [];
	const preferences = value(await db.from('user_preferences').select('chat_id,language').in('chat_id', links.map((link) => link.chat_id)));
	const languages = new Map(preferences.map((preference) => [preference.chat_id, preference.language]));
	return links.map((link) => ({ ...link, language: languages.get(link.chat_id) ?? 'de' }));
}

export async function snoozeCoverAlert(chatId, wallet, coverId, remindAt) {
	value(await db.from('alert_snoozes').upsert({ chat_id: String(chatId), wallet: wallet.toLowerCase(), cover_id: String(coverId), remind_at: new Date(remindAt).toISOString(), created_at: new Date().toISOString() }));
}

export async function listDueSnoozes(now = Date.now()) {
	return value(await db.from('alert_snoozes').select('*').lte('remind_at', new Date(now).toISOString()).order('remind_at'));
}

export async function clearSnooze(chatId, wallet, coverId) {
	value(await db.from('alert_snoozes').delete().match({ chat_id: String(chatId), wallet: wallet.toLowerCase(), cover_id: String(coverId) }));
}

export async function getCoverSnapshots(chatId, wallet) {
	return value(await db.from('cover_snapshots').select('*').match({ chat_id: String(chatId), wallet: wallet.toLowerCase() }));
}

export async function saveCoverSnapshot(chatId, wallet, cover) {
	value(await db.from('cover_snapshots').upsert({
		chat_id: String(chatId), wallet: wallet.toLowerCase(), cover_id: String(cover.coverId),
		product_id: cover.productId == null ? null : String(cover.productId), product_name: cover.productName ?? null,
		status: cover.status, amount: cover.amount == null ? null : String(cover.amount), asset_symbol: cover.asset?.symbol ?? null,
		cover_asset_id: cover.asset?.id ?? null,
		starts_at: cover.startsAt ? new Date(cover.startsAt).toISOString() : null,
		ends_at: cover.endsAt ? new Date(cover.endsAt).toISOString() : null,
		grace_ends_at: cover.graceEndsAt ? new Date(cover.graceEndsAt).toISOString() : null,
		original_cover_id: cover.originalCoverId == null ? null : String(cover.originalCoverId),
		latest_cover_id: cover.latestCoverId == null ? null : String(cover.latestCoverId),
		purchase_tx: cover.purchaseTx ?? null,
		analysis_url: cover.analysis ?? null,
		last_seen_at: new Date().toISOString()
	}, { onConflict: 'chat_id,wallet,cover_id' }));
}

function safeMetadata(metadata) {
	return metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {};
}

export async function recordAgentEvent({ chatId = null, wallet = null, eventType, source, command = null, coverId = null, metadata = {} }) {
	value(await db.from('agent_events').insert({
		id: randomUUID(), chat_id: chatId == null ? null : String(chatId), wallet: wallet?.toLowerCase() ?? null,
		event_type: eventType, source, command, cover_id: coverId == null ? null : String(coverId), metadata: safeMetadata(metadata)
	}));
}

export async function beginTelegramDelivery(chatId, messageKind, metadata = {}) {
	const id = randomUUID();
	value(await db.from('telegram_deliveries').insert({ id, chat_id: String(chatId), message_kind: messageKind, status: 'pending', metadata: safeMetadata(metadata) }));
	return id;
}

export async function finishTelegramDelivery(id, { messageId = null, errorCode = null, errorMessage = null } = {}) {
	value(await db.from('telegram_deliveries').update({
		status: errorMessage ? 'failed' : 'sent', telegram_message_id: messageId == null ? null : String(messageId),
		error_code: errorCode == null ? null : String(errorCode).slice(0, 80),
		error_message: errorMessage == null ? null : String(errorMessage).slice(0, 500), completed_at: new Date().toISOString()
	}).eq('id', id));
}

export async function recordRenewalEvent(event) {
	const wallet = String(event.wallet ?? '').toLowerCase();
	const coverId = String(event.coverId ?? '');
	const status = String(event.status ?? '');
	if (!/^0x[a-f0-9]{40}$/.test(wallet) || !/^\d+$/.test(coverId) || !['opened','quoted','approval_requested','approval_confirmed','purchase_requested','submitted','confirmed','failed','cancelled'].includes(status)) throw new Error('Invalid renewal event.');
	const linked = await getWalletLinkByWallet(wallet);
	const attemptId = typeof event.attemptId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(event.attemptId) ? event.attemptId : randomUUID();
	const existing = value(await db.from('renewal_attempts').select('*').eq('id', attemptId).maybeSingle());
	const choose = (incoming, previous = null) => incoming == null ? previous : incoming;
	const row = {
		id: attemptId, wallet, chat_id: linked?.chat_id ?? null, cover_id: coverId,
		product_id: Number.isInteger(event.productId) ? event.productId : existing?.product_id ?? null,
		amount: choose(event.amount == null ? null : String(event.amount).slice(0, 100), existing?.amount),
		cover_asset_id: Number.isInteger(event.coverAssetId) ? event.coverAssetId : existing?.cover_asset_id ?? null,
		period_days: Number.isInteger(event.periodDays) ? event.periodDays : existing?.period_days ?? null,
		status, source: event.source === 'client_reported' ? 'client_reported' : 'coverraccoon',
		quote_max_premium: choose(event.maxPremium == null ? null : String(event.maxPremium).slice(0, 100), existing?.quote_max_premium),
		quote_asset_symbol: choose(event.assetSymbol == null ? null : String(event.assetSymbol).slice(0, 20), existing?.quote_asset_symbol),
		approval_tx_hash: /^0x[a-fA-F0-9]{64}$/.test(event.approvalTxHash ?? '') ? event.approvalTxHash.toLowerCase() : existing?.approval_tx_hash ?? null,
		buy_tx_hash: /^0x[a-fA-F0-9]{64}$/.test(event.buyTxHash ?? '') ? event.buyTxHash.toLowerCase() : existing?.buy_tx_hash ?? null,
		error_code: event.errorCode == null ? null : String(event.errorCode).slice(0, 80),
		error_message: event.errorMessage == null ? null : String(event.errorMessage).slice(0, 500),
		metadata: { ...(existing?.metadata ?? {}), ...safeMetadata(event.metadata) },
		started_at: existing?.started_at ?? new Date().toISOString(), updated_at: new Date().toISOString(),
		completed_at: ['confirmed','failed','cancelled'].includes(status) ? new Date().toISOString() : null
	};
	value(await db.from('renewal_attempts').upsert(row, { onConflict: 'id' }));
	await recordAgentEvent({ chatId: linked?.chat_id, wallet, eventType: `renewal.${status}`, source: 'coverraccoon', coverId, metadata: { attemptId } });
	return { attemptId, chatId: linked?.chat_id ?? null };
}

export async function wasWeeklySummarySent(chatId, week) {
	const row = value(await db.from('weekly_summary_log').select('chat_id').match({ chat_id: String(chatId), sent_week: week }).maybeSingle());
	return Boolean(row);
}

export async function recordWeeklySummary(chatId, week) {
	value(await db.from('weekly_summary_log').upsert({ chat_id: String(chatId), sent_week: week, sent_at: new Date().toISOString() }));
}

export async function wasAlertSent(chatId, coverId, endsAt, thresholdDays) {
	const data = value(await db.from('sent_alerts').select('chat_id').match({
		chat_id: String(chatId),
		cover_id: String(coverId),
		ends_at: new Date(endsAt).toISOString(),
		threshold_days: thresholdDays
	}).maybeSingle());
	return Boolean(data);
}

export async function recordAlertSent(chatId, coverId, endsAt, thresholdDays) {
	value(await db.from('sent_alerts').upsert({
		chat_id: String(chatId),
		cover_id: String(coverId),
		ends_at: new Date(endsAt).toISOString(),
		threshold_days: thresholdDays,
		sent_at: new Date().toISOString()
	}, { onConflict: 'chat_id,cover_id,ends_at,threshold_days', ignoreDuplicates: true }));
}
