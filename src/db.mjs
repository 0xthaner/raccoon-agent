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

/*
	Restaudit M1, 15.10.2026: hoechstens MAX_WALLETS_PER_CHAT Wallets je Chat.
	Durchgesetzt wird das in der Datenbank (link_wallet_to_chat_limited, unter
	einem Lock je Chat); dieser Wert muss dort identisch stehen und dient hier nur
	fuer Texte und dafuer, bei vollem Chat keinen Link-Code mehr anzubieten.

	Ergebnis: { status: 'linked' | 'wallet_limit' | 'invalid', chatId }. Am Limit
	ist nichts geschrieben und der Code nicht verbraucht.
*/
export const MAX_WALLETS_PER_CHAT = 10;

export async function consumePendingLink(code, wallet, { client = db } = {}) {
	const outcome = value(await client.rpc('consume_wallet_link_v2', { link_code: code, linked_wallet: wallet.toLowerCase() })) ?? {};
	const chatId = outcome.status === 'linked' ? outcome.chat_id : null;
	if (chatId) {
		value(await client.from('pending_links').delete().like('chat_id', `unlinked:${chatId}:%`));
		return { status: 'linked', chatId };
	}
	if (outcome.status === 'wallet_limit' && outcome.chat_id) return { status: 'wallet_limit', chatId: outcome.chat_id };
	return { status: 'invalid', chatId: null };
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
	if (wallet) value(await db.from('pending_links').delete().like('chat_id', `unlinked:${chatId}:%`));
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

/**
 * META-AUDIT M-3, Modus B: ist die Login-Challenge noch offen (nicht verbraucht,
 * nicht abgelaufen, diese Wallet)? NUR lesen - verbraucht wird ausschliesslich in
 * consumeDashboardChallenge. Spart RPC fuer verbrauchte/abgelaufene Challenges.
 */
export async function isDashboardChallengeOpen(nonce, wallet) {
	const row = value(await db.from('dashboard_challenges')
		.select('nonce')
		.eq('nonce', nonce)
		.eq('wallet', wallet.toLowerCase())
		.is('used_at', null)
		.gt('expires_at', new Date().toISOString())
		.maybeSingle());
	return Boolean(row);
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
	const state = await getWalletLinkStateByWallet(wallet);
	return state.link;
}

// A Wallet kann bewusst mit mehreren Telegram-Chats verbunden sein. Ein
// wallet-authentifiziertes Dashboard darf dann nicht per `limit(1)` zufaellig
// Label oder Einstellungen eines dieser Chats offenlegen. Nur der aggregierte
// Verbindungsstatus ist eindeutig; chatbezogene Metadaten gibt es genau dann,
// wenn exakt eine aktive Zuordnung existiert.
export async function getWalletLinkStateByWallet(wallet) {
	const rows = value(await db.from('monitored_wallets')
		.select('chat_id,wallet,alerts_enabled,label,is_primary,alert_thresholds,weekly_summary')
		.eq('wallet', wallet.toLowerCase())
		.eq('alerts_enabled', true));
	return { linked: rows.length > 0, link: rows.length === 1 ? rows[0] : null };
}

export async function getMonitoredWallets(chatId, { client = db } = {}) {
	return value(await client.from('monitored_wallets').select('*').eq('chat_id', String(chatId)).order('is_primary', { ascending: false }).order('linked_at'));
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

export async function unlinkWallet(chatId, { client = db } = {}) {
	const chat = String(chatId);
	const data = value(await client.from('monitored_wallets').delete().eq('chat_id', chat).select('wallet'));
	value(await client.from('wallet_links').delete().eq('chat_id', chat));
	return data.length > 0;
}

export async function rememberUnlinkedWallet(chatId, wallet, { client = db } = {}) {
	const normalized = wallet.toLowerCase();
	value(await client.from('pending_links').delete().eq('chat_id', `unlinked:${chatId}:${normalized}`));
	value(await client.from('pending_links').insert({
		code: `unlinked_${randomBytes(18).toString('base64url')}`,
		chat_id: `unlinked:${chatId}:${normalized}`,
		nonce: normalized,
		expires_at: new Date(Date.now() + 10 * 365 * 24 * 60 * 60_000).toISOString()
	}));
}

export async function getRememberedWallet(chatId) {
	const rows = value(await db.from('pending_links').select('nonce').like('chat_id', `unlinked:${chatId}:%`).limit(1));
	return rows[0]?.nonce ?? null;
}

export async function getRememberedWallets(chatId, { client = db } = {}) {
	const rows = value(await client.from('pending_links').select('nonce').like('chat_id', `unlinked:${chatId}:%`));
	return [...new Set(rows.map((row) => row.nonce))];
}

export async function forgetRememberedWallet(chatId, { client = db } = {}) {
	value(await client.from('pending_links').delete().like('chat_id', `unlinked:${chatId}:%`));
}

export async function unlinkWalletByWallet(wallet, { client = db } = {}) {
	const normalized = wallet.toLowerCase();
	const matches = value(await client.from('monitored_wallets').select('chat_id,is_primary').eq('wallet', normalized));
	// Ohne eindeutigen Chatkontext gibt es keine sichere Zielzuordnung. Bei
	// mehreren Treffern muss die Trennung im jeweiligen Telegram-Chat erfolgen.
	if (matches.length !== 1) return [];
	const [{ chat_id: chatId, is_primary: wasPrimary }] = matches;
	return [await removeWalletFromChat(chatId, normalized, wasPrimary, { remember: true, client })];
}

/*
	META-AUDIT M-1, 15.10.2026: die AKTUELLE Befugnis einer Contract-Wallet (frisch
	per ERC-1271 bestaetigt, api/dashboard.mjs) trennt die Wallet von ALLEN
	Telegram-Chats - auch von einem, der verknuepft wurde, als sein Nutzer noch
	Owner war. Ohne diesen Weg konnten die aktuellen Owner einen veralteten Chat
	nie entfernen (unlinkWalletByWallet greift nur bei genau einem Chat).
	Betroffen ist je Chat NUR diese eine Wallet; andere Wallets der Chats bleiben.
	Die Chats merken sich die Wallet nicht ("remember: false"): eine entzogene
	Verknuepfung soll keine Spur hinterlassen, aus der der Chat spaeter etwas ableitet.
*/
export async function unlinkWalletFromAllChats(wallet, { client = db } = {}) {
	const normalized = wallet.toLowerCase();
	const matches = value(await client.from('monitored_wallets').select('chat_id,is_primary').eq('wallet', normalized));
	const removed = [];
	for (const { chat_id: chatId, is_primary: wasPrimary } of matches) {
		removed.push(await removeWalletFromChat(chatId, normalized, wasPrimary, { remember: false, client }));
	}
	return removed;
}

/** Entfernt GENAU diese Wallet aus GENAU diesem Chat und richtet dessen Primaer-Wallet neu aus. */
async function removeWalletFromChat(chatId, normalized, wasPrimary, { remember, client }) {
	// Die Walletsignatur autorisiert die Entfernung dieser Wallet, nicht die
	// Loeschung aller anderen Wallets desselben Telegram-Chats.
	value(await client.from('monitored_wallets').delete().match({ chat_id: chatId, wallet: normalized }));
	if (remember) await rememberUnlinkedWallet(chatId, normalized, { client });

	const remaining = value(await client.from('monitored_wallets')
		.select('*')
		.eq('chat_id', chatId)
		.order('is_primary', { ascending: false })
		.order('linked_at'));
	if (!remaining.length) {
		value(await client.from('wallet_links').delete().eq('chat_id', chatId));
		return { chat_id: chatId };
	}
	const primary = remaining.find((item) => item.is_primary) ?? remaining[0];
	if (wasPrimary && !primary.is_primary) {
		value(await client.from('monitored_wallets').update({ is_primary: true, updated_at: new Date().toISOString() }).match({ chat_id: chatId, wallet: primary.wallet }));
	}
	value(await client.from('wallet_links').upsert({
		chat_id: chatId,
		wallet: primary.wallet,
		linked_at: new Date().toISOString(),
		alerts_enabled: primary.alerts_enabled
	}));
	return { chat_id: chatId };
}

export async function revokeDashboardSessions(wallet, now = Date.now()) {
	const cutoff = value(await db.rpc('revoke_dashboard_sessions_atomic', {
		revoke_wallet: wallet.toLowerCase(), requested_cutoff: now
	}));
	if (!Number.isSafeInteger(cutoff) || cutoff < now) throw new Error('Invalid revocation result');
	return cutoff;
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

/*
	Restaudit M1: Erinnerungs-Abos nur noch SEITENWEISE (Keyset ueber chat_id,
	wallet; Datenbank deckelt die Seite auf 200). `after` (exklusiv) und `through`
	(inklusiv) sind [chat_id, wallet] oder null. Der Aufrufer liest, bis eine Seite
	leer ist - nie unter der Annahme, eine Antwort enthalte alles.
*/
export async function listAlertSubscriptionsPage({ after = null, through = null, limit, client = db }) {
	return value(await client.rpc('alert_subscriptions_page', {
		after_chat: after?.[0] ?? null, after_wallet: after?.[1] ?? null,
		through_chat: through?.[0] ?? null, through_wallet: through?.[1] ?? null,
		page_size: limit
	})) ?? [];
}

/** Ein einzelnes aktives Abo (fuer faellige Snoozes) - oder null. */
export async function getAlertSubscription(chatId, wallet, { client = db } = {}) {
	const row = value(await client.from('monitored_wallets').select('chat_id,wallet,label,alert_thresholds,weekly_summary')
		.match({ chat_id: String(chatId), wallet: String(wallet).toLowerCase(), alerts_enabled: true }).maybeSingle());
	if (!row) return null;
	const preference = value(await client.from('user_preferences').select('language').eq('chat_id', row.chat_id).maybeSingle());
	return { ...row, language: preference?.language ?? 'de' };
}

const ALERT_RUN_STATE_ID = 'expiry-alerts';

/** Fortsetzungspunkt des Erinnerungslaufs: [chat_id, wallet] oder null. */
export async function getAlertRunCursor({ client = db } = {}) {
	const row = value(await client.from('alert_run_state').select('cursor_chat_id,cursor_wallet').eq('id', ALERT_RUN_STATE_ID).maybeSingle());
	return row?.cursor_chat_id && row?.cursor_wallet ? [row.cursor_chat_id, row.cursor_wallet] : null;
}

export async function saveAlertRunCursor(cursor, { client = db } = {}) {
	value(await client.from('alert_run_state').upsert({
		id: ALERT_RUN_STATE_ID, cursor_chat_id: cursor?.[0] ?? null, cursor_wallet: cursor?.[1] ?? null, updated_at: new Date().toISOString()
	}));
}

export async function snoozeCoverAlert(chatId, wallet, coverId, remindAt) {
	value(await db.from('alert_snoozes').upsert({ chat_id: String(chatId), wallet: wallet.toLowerCase(), cover_id: String(coverId), remind_at: new Date(remindAt).toISOString(), created_at: new Date().toISOString() }));
}

/** Restaudit M1: faellige Snoozes seitenweise, aelteste zuerst, feste Reihenfolge. */
export async function listDueSnoozesPage(now, limit, { client = db } = {}) {
	return value(await client.from('alert_snoozes').select('chat_id,wallet,cover_id,remind_at').lte('remind_at', new Date(now).toISOString())
		.order('remind_at').order('chat_id').order('wallet').order('cover_id').limit(limit)) ?? [];
}

/** Gescheiterter Snooze: nach hinten, damit er spaetere nicht dauerhaft blockiert. */
export async function rescheduleSnooze(chatId, wallet, coverId, remindAt, { client = db } = {}) {
	value(await client.from('alert_snoozes').update({ remind_at: new Date(remindAt).toISOString() })
		.match({ chat_id: String(chatId), wallet: wallet.toLowerCase(), cover_id: String(coverId) }));
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

/*
	Das zuletzt besprochene Produkt eines privaten Chats, fuer Rueckfragen wie
	"und was ist da versichert?". Gilt 15 Minuten; aeltere Zeilen werden beim
	Schreiben mit aufgeraeumt. Nur Produkt-IDs, kein Text.
*/
export const PRODUCT_CONTEXT_TTL_MS = 15 * 60 * 1000;

export async function getChatProductContext(chatId, now = Date.now()) {
	const row = value(await db.from('chat_product_context').select('product_ids, updated_at').eq('chat_id', String(chatId)).maybeSingle());
	if (!row || now - Date.parse(row.updated_at) > PRODUCT_CONTEXT_TTL_MS) return null;
	return Array.isArray(row.product_ids) ? row.product_ids.filter(Number.isInteger) : null;
}

export async function saveChatProductContext(chatId, productIds) {
	const ids = [...new Set(productIds)].filter(Number.isInteger).slice(0, 5);
	if (!ids.length) return;
	value(await db.from('chat_product_context').upsert({ chat_id: String(chatId), product_ids: ids, updated_at: new Date().toISOString() }, { onConflict: 'chat_id' }));
	value(await db.from('chat_product_context').delete().lt('updated_at', new Date(Date.now() - PRODUCT_CONTEXT_TTL_MS).toISOString()));
}

/*
	Vom Nutzer bestaetigte Cover-Zuordnungen (14.10.2026). Die Wallet kommt in
	jedem Aufruf aus der verifizierten Sitzung bzw. der Ueberwachung - nie aus einer
	Anfrage. Jede Abfrage und jede Loeschung ist auf genau diese Wallet beschraenkt.
	Gespeichert wird nur die Relation, nie Betraege, Nexus-Metadaten oder Signaturen.
*/
const ATTRIBUTION_COLUMNS = 'deployment_key,product_id,cover_id,source,confirmed_at';
export const MAX_ATTRIBUTIONS_PER_WALLET = 60;

export async function listPositionAttributions(wallet) {
	return value(await db.from('position_cover_attributions').select(`wallet,${ATTRIBUTION_COLUMNS}`)
		.eq('wallet', wallet.toLowerCase()).order('confirmed_at').limit(MAX_ATTRIBUTIONS_PER_WALLET));
}

export async function upsertPositionAttribution({ wallet, protocolKey, protocolVersion, deploymentKey, productId, coverId, now = Date.now() }) {
	const at = new Date(now).toISOString();
	const rows = value(await db.from('position_cover_attributions').upsert({
		wallet: wallet.toLowerCase(), protocol_key: protocolKey, protocol_version: protocolVersion,
		deployment_key: deploymentKey, product_id: productId, cover_id: coverId,
		source: 'user_confirmed', confirmed_at: at, updated_at: at
	}, { onConflict: 'wallet,deployment_key,cover_id' }).select(ATTRIBUTION_COLUMNS));
	return rows[0] ?? null;
}

export async function deletePositionAttribution(wallet, deploymentKey, coverId) {
	const rows = value(await db.from('position_cover_attributions').delete()
		.match({ wallet: wallet.toLowerCase(), deployment_key: deploymentKey, cover_id: coverId }).select('cover_id'));
	return rows.length;
}

/*
	Taegliche Bereinigung, angestossen vom Lauf um 8 Uhr (api/alerts.mjs).

	Bis 01.10.2026 wurden Protokolle nie geloescht, obwohl die
	Datenschutzinformation "nur solange erforderlich" verspricht. Jetzt:
	Ereignisse, Zustellprotokolle und Erinnerungs-Nachweise nach 90 Tagen,
	Login-Codes sobald sie abgelaufen sind (danach sind sie wertlos).
	Wallet-Verknuepfungen, Einstellungen und Cover-Abbilder bleiben, bis jemand
	trennt; sie sind keine Protokolle, sondern der Dienst selbst.
*/
export const RETENTION_DAYS = 90;
/** Cover laufen hoechstens 365 Tage plus Grace Period; danach ist keine Zuordnung mehr aktuell. */
export const ATTRIBUTION_RETENTION_DAYS = 400;

export async function purgeOldRecords({ client = db, now = Date.now() } = {}) {
	const cutoff = new Date(now - RETENTION_DAYS * 86_400_000).toISOString();
	const jetzt = new Date(now).toISOString();
	const rules = [
		['agent_events', 'occurred_at', cutoff],
		['telegram_deliveries', 'attempted_at', cutoff],
		['sent_alerts', 'ends_at', cutoff],
		['weekly_summary_log', 'sent_at', cutoff],
		['dashboard_challenges', 'expires_at', jetzt],
		['position_cover_attributions', 'confirmed_at', new Date(now - ATTRIBUTION_RETENTION_DAYS * 86_400_000).toISOString()]
	];
	const result = {};
	for (const [table, column, before] of rules) {
		// Einzeln, damit eine fehlende oder gesperrte Tabelle die anderen nicht aufhaelt.
		try {
			const { error, count } = await client.from(table).delete({ count: 'exact' }).lt(column, before);
			result[table] = error ? `fehler: ${error.message}` : count ?? 0;
		} catch (error) {
			result[table] = `fehler: ${error?.message ?? 'unbekannt'}`;
		}
	}
	return result;
}
