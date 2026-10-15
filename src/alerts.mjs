import { getWalletCovers } from './covers.mjs';
import { newDashboardAccess } from './linking.mjs';
import { boundedDisplayText } from './display-text.mjs';
import { clearSnooze, getAlertRunCursor, getAlertSubscription, getCoverSnapshots, listAlertSubscriptionsPage, listDueSnoozesPage, listPositionAttributions, recordAgentEvent, recordAlertSent, recordRenewalEvent, recordWeeklySummary, rescheduleSnooze, saveAlertRunCursor, saveCoverSnapshot, wasAlertSent, wasWeeklySummarySent } from './db.mjs';
import { getWalletPositions } from './positions/index.mjs';
import { reconcile } from './position-attributions.mjs';

/*
	Bis 01.10.2026 kamen Betraege ueber den CoverRaccoon-Nachtlauf, auf vier
	Nachkommastellen abgeschnitten; seither kommen sie exakt von der Kette. Ein
	reiner Stringvergleich hielte "1.2345" gegen "1.234567..." fuer eine
	Aenderung der Deckungssumme und meldete sie. Echte Aenderungen liegen um
	Groessenordnungen darueber.
*/
export function amountsDiffer(previous, current) {
	const a = Number(previous), b = Number(current);
	if (previous != null && current != null && Number.isFinite(a) && Number.isFinite(b)) return Math.abs(a - b) >= 0.0001;
	return String(previous ?? '') !== String(current ?? '');
}

export const ALERT_THRESHOLDS_DAYS = [0, 1, 3, 7, 14, 30];
const DAY_MS = 86_400_000;

export function dueThreshold(endsAt, now = Date.now(), thresholds = ALERT_THRESHOLDS_DAYS) {
	const remainingMs = Date.parse(endsAt) - now;
	if (!Number.isFinite(remainingMs) || remainingMs < 0) return null;
	return [...thresholds].sort((a, b) => a - b).find((days) => remainingMs <= days * DAY_MS) ?? null;
}

function lifecycleText(kind, cover, previous, language) {
	const product = boundedDisplayText(cover.productName) ?? `Cover #${cover.coverId}`;
	if (language === 'en') {
		if (kind === 'renewed') return `✅ Renewal confirmed\n\n${product} · Cover #${cover.coverId}\nNew expiry: ${new Intl.DateTimeFormat('en-GB', { dateStyle: 'long' }).format(new Date(cover.endsAt))}\n\nYour monitoring continues automatically.`;
		if (kind === 'new') return `🛡 New cover detected\n\n${product} · Cover #${cover.coverId}\nMonitoring and expiry reminders are active.`;
		if (kind === 'coverage') return `ℹ️ Cover amount changed\n\n${product} · Cover #${cover.coverId}\n${previous.amount ?? '—'} ${previous.asset_symbol ?? ''} → ${formatAmount(cover, language)}`;
		return `ℹ️ Cover status changed\n\n${product} · Cover #${cover.coverId}\n${previous.status} → ${cover.status}`;
	}
	if (language === 'zh') {
		if (kind === 'renewed') return `✅ 续保已确认\n\n${product} · 保障 #${cover.coverId}\n新到期日：${new Intl.DateTimeFormat('zh-CN', { dateStyle: 'long' }).format(new Date(cover.endsAt))}\n\n监控将自动继续。`;
		if (kind === 'new') return `🛡 检测到新保障\n\n${product} · 保障 #${cover.coverId}\n监控和到期提醒已启用。`;
		if (kind === 'coverage') return `ℹ️ 保障金额已更改\n\n${product} · 保障 #${cover.coverId}\n${previous.amount ?? '—'} ${previous.asset_symbol ?? ''} → ${formatAmount(cover, language)}`;
		return `ℹ️ 保障状态已更改\n\n${product} · 保障 #${cover.coverId}\n${previous.status} → ${cover.status}`;
	}
	if (kind === 'renewed') return `✅ Verlängerung bestätigt\n\n${product} · Cover #${cover.coverId}\nNeuer Ablauf: ${new Intl.DateTimeFormat('de-AT', { dateStyle: 'long' }).format(new Date(cover.endsAt))}\n\nDie Überwachung läuft automatisch weiter.`;
	if (kind === 'new') return `🛡 Neues Cover erkannt\n\n${product} · Cover #${cover.coverId}\nÜberwachung und Ablaufwarnungen sind aktiv.`;
	if (kind === 'coverage') return `ℹ️ Deckungssumme geändert\n\n${product} · Cover #${cover.coverId}\n${previous.amount ?? '—'} ${previous.asset_symbol ?? ''} → ${formatAmount(cover, language)}`;
	return `ℹ️ Cover-Status geändert\n\n${product} · Cover #${cover.coverId}\n${previous.status} → ${cover.status}`;
}

async function syncCoverLifecycle(subscription, covers, sendMessage, dashboardUrl, store = ALERT_STORE) {
	const snapshots = await store.getCoverSnapshots(subscription.chat_id, subscription.wallet);
	const previousById = new Map(snapshots.map((cover) => [String(cover.cover_id), cover]));
	const initialized = snapshots.length > 0;
	for (const cover of covers) {
		const previous = previousById.get(String(cover.coverId));
		let kind = null;
		if (initialized && !previous) {
			const predecessor = snapshots.find((item) => item.product_id === String(cover.productId) && item.ends_at && cover.startsAt && Math.abs(Date.parse(cover.startsAt) - Date.parse(item.ends_at)) <= 7 * DAY_MS);
			kind = predecessor ? 'renewed' : 'new';
		}
		else if (previous && cover.endsAt && previous.ends_at && Date.parse(cover.endsAt) > Date.parse(previous.ends_at) + DAY_MS) kind = 'renewed';
		else if (previous && previous.status !== cover.status) kind = 'status';
		else if (previous && amountsDiffer(previous.amount, cover.amount)) kind = 'coverage';
		if (kind) {
			if (kind === 'renewed') {
				const renewedCoverId = previous?.cover_id ?? snapshots.find((item) => item.product_id === String(cover.productId) && item.ends_at && cover.startsAt && Math.abs(Date.parse(cover.startsAt) - Date.parse(item.ends_at)) <= 7 * DAY_MS)?.cover_id;
				if (renewedCoverId) await store.recordRenewalEvent({
					wallet: subscription.wallet, coverId: renewedCoverId, productId: cover.productId,
					amount: cover.amount, coverAssetId: cover.asset?.id, status: 'confirmed',
					buyTxHash: cover.purchaseTx, metadata: { detectedCoverId: cover.coverId, detectedBy: 'cover_snapshot' }
				}).catch(() => {});
			}
			const rows = [];
			if (dashboardUrl) {
				const access = await store.newAccess(subscription.wallet);
				rows.push([{ text: subscription.language === 'en' ? 'Open dashboard' : subscription.language === 'zh' ? '打开仪表板' : 'Dashboard öffnen', url: `${dashboardUrl}/?access=${encodeURIComponent(access.code)}` }]);
			}
			await sendMessage(subscription.chat_id, lifecycleText(kind, cover, previous, subscription.language), { ...(rows.length ? { reply_markup: { inline_keyboard: rows } } : {}), _messageKind: `cover_${kind}` });
		}
		await store.saveCoverSnapshot(subscription.chat_id, subscription.wallet, cover);
	}
}

function weekKey(now) {
	const date = new Date(now); const first = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
	return `${date.getUTCFullYear()}-${String(Math.ceil((((date - first) / DAY_MS) + first.getUTCDay() + 1) / 7)).padStart(2, '0')}`;
}

async function sendWeeklySummaries(subscriptions, results, sendMessage, now, store = ALERT_STORE, timeLeft = () => true, onTimeUp = () => {}, onFailure = () => {}) {
	if (new Date(now).getUTCDay() !== 1) return 0;
	const grouped = new Map();
	for (const subscription of subscriptions.filter((item) => item.weekly_summary)) {
		const result = results.get(`${subscription.chat_id}:${subscription.wallet}`);
		if (!result) continue;
		const entry = grouped.get(subscription.chat_id) ?? { language: subscription.language, wallets: [] };
		entry.wallets.push({ subscription, covers: result.covers.filter((cover) => cover.status === 'active') }); grouped.set(subscription.chat_id, entry);
	}
	let sent = 0; const week = weekKey(now);
	for (const [chatId, entry] of grouped) {
		if (!timeLeft()) { onTimeUp(); break; }
		// Restaudit M1: ein Chat, an den der Versand scheitert (etwa Bot blockiert), stoppt
		// nicht mehr die Uebersichten aller weiteren Chats und nicht den ganzen Lauf.
		try {
			if (await store.wasWeeklySummarySent(chatId, week)) continue;
			const active = entry.wallets.flatMap((wallet) => wallet.covers);
			const next = active.filter((cover) => cover.endsAt).sort((a, b) => Date.parse(a.endsAt) - Date.parse(b.endsAt))[0];
			const totals = new Map();
			for (const cover of active) { const symbol = cover.asset?.symbol || 'Cover'; totals.set(symbol, (totals.get(symbol) ?? 0) + (Number(cover.amount) || 0)); }
			const totalText = [...totals].map(([symbol, amount]) => `${amount.toLocaleString(entry.language === 'en' ? 'en-US' : entry.language === 'zh' ? 'zh-CN' : 'de-AT')} ${symbol}`).join(' · ') || '—';
			const text = entry.language === 'en'
				? `📋 Weekly cover summary\n\n${entry.wallets.length} wallet(s) monitored\n${active.length} active cover(s)\nTotal cover: ${totalText}${next ? `\nNext expiry: ${new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' }).format(new Date(next.endsAt))}` : ''}`
				: entry.language === 'zh'
					? `📋 每周保障摘要\n\n监控 ${entry.wallets.length} 个钱包\n${active.length} 个有效保障\n保障总额：${totalText}${next ? `\n最近到期：${new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium' }).format(new Date(next.endsAt))}` : ''}`
					: `📋 Wöchentliche Cover-Übersicht\n\n${entry.wallets.length} Wallet(s) überwacht\n${active.length} aktive Cover(s)\nGesamte Deckung: ${totalText}${next ? `\nNächster Ablauf: ${new Intl.DateTimeFormat('de-AT', { dateStyle: 'medium' }).format(new Date(next.endsAt))}` : ''}`;
			await sendMessage(chatId, text, { _messageKind: 'weekly_summary' }); await store.recordWeeklySummary(chatId, week); sent++;
		} catch (error) { onFailure(error); }
	}
	return sent;
}

function formatAmount(cover, language) {
	if (cover.amount == null) return language === 'zh' ? '不可用' : language === 'en' ? 'unavailable' : 'nicht verfügbar';
	const locale = language === 'zh' ? 'zh-CN' : language === 'en' ? 'en-US' : 'de-AT';
	const value = Number(cover.amount);
	const amount = Number.isFinite(value)
		? new Intl.NumberFormat(locale, { maximumFractionDigits: 4 }).format(value)
		: cover.amount;
	return `${amount} ${cover.asset?.symbol ?? ''}`.trim();
}

/*
	Vom Nutzer bestaetigte Zuordnung als OPTIONALER Kontext (14.10.2026): nur wenn
	sie gerade gueltig ist (Quelle user_confirmed, Cover aktiv und in dieser Wallet,
	gleiche productId, Position im sicher gelesenen Markt vorhanden). Sonst bleibt
	es beim allgemeinen Satz. Nie "versichert", "gedeckt" oder "geschuetzt".
*/
function expirySentence(thresholdDays, language, context) {
	const labels = context?.positions ?? [];
	if (!labels.length) {
		if (language === 'zh') return thresholdDays === 0 ? '你的保障将在今天到期。' : `你的保障将在 ${thresholdDays} 天内到期。`;
		if (language === 'en') return thresholdDays === 0 ? 'Your cover expires today.' : `Your cover expires within ${thresholdDays} days.`;
		return thresholdDays === 0 ? 'Dein Cover läuft heute aus.' : `Dein Cover läuft innerhalb der nächsten ${thresholdDays} Tage aus.`;
	}
	if (language === 'zh') return `你分配给 Aave v3 仓位 ${labels.join('、')} 的保障将${thresholdDays === 0 ? '在今天到期' : `在 ${thresholdDays} 天内到期`}。`;
	if (language === 'en') return `The cover you assigned to your Aave v3 position${labels.length > 1 ? 's' : ''} ${labels.join(' and ')} expires ${thresholdDays === 0 ? 'today' : `within ${thresholdDays} days`}.`;
	return `Das Cover, das du ${labels.length > 1 ? 'deinen Aave-v3-Positionen' : 'deiner Aave-v3-Position'} ${labels.join(' und ')} zugeordnet hast, läuft ${thresholdDays === 0 ? 'heute' : `innerhalb der nächsten ${thresholdDays} Tage`} aus.`;
}

export function formatExpiryAlert(cover, thresholdDays, language = 'de', context = null) {
	const locale = language === 'zh' ? 'zh-CN' : language === 'en' ? 'en-GB' : 'de-AT';
	const expiry = new Intl.DateTimeFormat(locale, {
		dateStyle: 'long',
		timeStyle: 'short',
		timeZone: 'Europe/Vienna'
	}).format(new Date(cover.endsAt));
	const product = boundedDisplayText(cover.productName) ?? (language === 'zh' ? `Nexus 产品 #${cover.productId}` : language === 'en' ? `Nexus product #${cover.productId}` : `Nexus-Produkt #${cover.productId}`);

	const demo = cover.demo ? (language === 'zh' ? '演示：仅适用于此钱包 · 不会执行交易' : language === 'en' ? 'Demo for this wallet only · no transaction' : 'Demo für diese Wallet · keine Transaktion') : null;

	if (language === 'zh') return [
		'⚠️ 保障即将到期', '',
		expirySentence(thresholdDays, language, context), '',
		`产品：${product}`,
		`保障编号：#${cover.coverId}`,
		`保障金额：${formatAmount(cover, language)}`,
		`到期时间：${expiry}`, '', ...(demo ? [demo, ''] : []),
		'数据来源：Coverraccoon · Nexus Mutual · Ethereum'
	].join('\n');

	if (language === 'en') return [
		'⚠️ Cover expiry reminder', '',
		expirySentence(thresholdDays, language, context), '',
		`Product: ${product}`,
		`Cover: #${cover.coverId}`,
		`Cover amount: ${formatAmount(cover, language)}`,
		`Expiry: ${expiry}`, '', ...(demo ? [demo, ''] : []),
		'Source: Coverraccoon · Nexus Mutual · Ethereum'
	].join('\n');

	return [
		'⚠️ Cover-Ablaufwarnung', '',
		expirySentence(thresholdDays, language, context), '',
		`Produkt: ${product}`,
		`Cover: #${cover.coverId}`,
		`Cover-Betrag: ${formatAmount(cover, language)}`,
		`Ablauf: ${expiry}`, '', ...(demo ? [demo, ''] : []),
		'Quelle: Coverraccoon · Nexus Mutual · Ethereum'
	].join('\n');
}

/**
 * Kontext fuer eine Ablaufwarnung aus vom Nutzer bestaetigten Zuordnungen - oder
 * null. Ein Fehler beim Lesen ergibt null; die Erinnerung geht trotzdem raus.
 */
export async function attributionContext(wallet, cover, coversResult, cache, { loadAttributions, loadPositions }) {
	try {
		const normalized = String(wallet).toLowerCase();
		if (!cache.rows) cache.rows = await loadAttributions(normalized);
		const rows = cache.rows.filter((row) => Number(row.cover_id) === cover.coverId);
		if (!rows.length) return null;
		if (!('positions' in cache)) cache.positions = await Promise.resolve().then(() => loadPositions(normalized)).catch(() => null);
		const { valid } = reconcile(rows, { wallet: normalized, positions: cache.positions, covers: coversResult });
		const labels = [...new Set(valid.filter((entry) => entry.coverId === cover.coverId && entry.productId === cover.productId).map((entry) => entry.label))];
		return labels.length ? { positions: labels } : null;
	} catch {
		return null;
	}
}

/**
 * Ablaufwarnungen fuer EIN Abo (Chat + Wallet).
 *
 * AUDIT E-L3, 14.10.2026: jedes Cover fuer sich. Vorher brach ein einziger
 * gescheiterter Versand (etwa eine zu lange Nachricht) die Schleife ab, und alle
 * weiteren faelligen Covers dieses Abos blieben ohne Warnung - jeden Tag wieder.
 * Jetzt wird der Fehler protokolliert und gezaehlt, das naechste Cover kommt
 * trotzdem dran. Als gesendet vermerkt wird ein Cover ausschliesslich NACH
 * erfolgreichem Versand; ein gescheitertes wird beim naechsten Lauf erneut versucht.
 */
export async function sendExpiryAlertsFor(subscription, result, { sendMessage, dashboardUrl, now = Date.now(), logger = console, loadAttributions = listPositionAttributions, loadPositions = (wallet) => getWalletPositions(wallet), wasSent = wasAlertSent, recordSent = recordAlertSent, newAccess = newDashboardAccess }) {
	let sent = 0;
	let failed = 0;
	const attributionCache = {};
	for (const cover of result.covers) {
		try {
			if (cover.status !== 'active' || !cover.endsAt) continue;
			const threshold = dueThreshold(cover.endsAt, now, subscription.alert_thresholds);
			if (threshold == null || await wasSent(subscription.chat_id, cover.coverId, cover.endsAt, threshold)) continue;
			// Der Callback heisst aus Kompatibilitaet mit bereits verschickten Knoepfen weiter `renew_later`.
			const rows = [[
				{ text: subscription.language === 'zh' ? '明天提醒' : subscription.language === 'en' ? 'Remind tomorrow' : 'Morgen erinnern', callback_data: `renew_later:${cover.coverId}:${subscription.wallet}` }
			]];
			if (dashboardUrl) {
				const access = await newAccess(subscription.wallet);
				rows.push([{ text: subscription.language === 'zh' ? '打开仪表板' : subscription.language === 'en' ? 'Open dashboard' : 'Dashboard öffnen', url: `${dashboardUrl}/?access=${encodeURIComponent(access.code)}` }]);
			}
			const context = await attributionContext(subscription.wallet, cover, result, attributionCache, { loadAttributions, loadPositions });
			await sendMessage(subscription.chat_id, formatExpiryAlert(cover, threshold, subscription.language, context), { ...(rows.length ? { reply_markup: { inline_keyboard: rows } } : {}), _messageKind: 'expiry_alert' });
			await recordSent(subscription.chat_id, cover.coverId, cover.endsAt, threshold);
			sent++;
		} catch (error) {
			failed++;
			logger.error(`Ablaufwarnung für Cover ${cover?.coverId} (Wallet ${subscription.wallet}) fehlgeschlagen:`, error?.message);
		}
	}
	return { sent, failed };
}

/*
	Restaudit M1, 15.10.2026: der taegliche Lauf ist begrenzt und fair.

	Vorher lud er ALLE Abos und alle faelligen Snoozes in einem Zug (PostgREST
	kappt still bei max_rows) und machte je Abo eine Cover-Abfrage ohne Obergrenze
	fuer Anzahl, RPC-Aufrufe oder Laufzeit. Wer viele Wallets verknuepfte, konnte
	den Lauf ausdehnen, bis er abbrach - und spaetere Nutzer bekamen still keine
	Erinnerung mehr.

	Jetzt:
	- Abos seitenweise (Keyset, feste Sortierung chat_id, wallet), bis eine Seite
	  leer ist oder ein Budget erschoepft ist. Snoozes ebenso, aelteste zuerst.
	- Budgets je Lauf, alle serverseitig gezaehlt: Abos, Cover-/Positions-Abfragen
	  (externe RPC-Folgen), Snoozes und Laufzeit. Fuer Snoozes und die
	  Wochenuebersicht bleibt ein fester Teil von Abfragen und Zeit reserviert,
	  damit die Abos sie nie ganz verdraengen. Geprueft wird VOR jeder
	  Arbeitseinheit; eine einzelne Abfrage ist durch die Provider-Timeouts begrenzt.
	- Fairness: endet ein Lauf am Budget, merkt er sich die letzte bearbeitete
	  Zeile; der naechste beginnt dahinter und laeuft ueber das Ende wieder nach
	  vorn. Ein gescheiterter Snooze wandert nach hinten (remind_at + 12 h).
	- Budget-Ende ist kein stiller Erfolg: EIN Ereignis alerts.run_budget_exhausted
	  je Lauf (nur Zaehler und Budget-Art, keine Wallet, keine Chat-ID) und die
	  Angabe im Ergebnis.
	- Ein einzelnes Abo oder ein Snooze, das scheitert, bricht den Lauf nicht ab.
	  Scheitert das Lesen einer Seite oder des Cursors (Datenbank), scheitert der
	  ganze Lauf - wie bisher mit Operator-Alarm in api/alerts.mjs.
	- Laeuft alles durch, ist das Ergebnis dasselbe wie vorher.
*/
export const ALERT_RUN_LIMITS = Object.freeze({
	// Weit unter PostgREST max_rows (1000) und der Seitenobergrenze der Datenbank (200).
	subscriptionPageSize: 100,
	snoozePageSize: 50,
	maxSubscriptions: 500,
	// Cover- und Positions-Abfragen zusammen; jede ist eine Folge externer RPC-Aufrufe.
	maxCoverLookups: 250,
	snoozeLookupReserve: 50,
	maxSnoozes: 200,
	// Die Funktion darf laenger laufen (Vercel-Standard 300 s); 45 s lassen Luft
	// fuer die Bereinigung danach und fuer eine einzelne langsame Abfrage (Timeout 10 s).
	maxRunMs: 45_000,
	snoozePhaseMs: 10_000,
	summaryPhaseMs: 5_000
});
export const ALERT_RUN_BUDGET_EVENT = 'alerts.run_budget_exhausted';
const SNOOZE_RETRY_MS = 12 * 60 * 60 * 1000;

export const ALERT_STORE = Object.freeze({
	subscriptionsPage: (options) => listAlertSubscriptionsPage(options),
	loadCursor: () => getAlertRunCursor(),
	saveCursor: (cursor) => saveAlertRunCursor(cursor),
	dueSnoozesPage: (now, limit) => listDueSnoozesPage(now, limit),
	subscriptionFor: (chatId, wallet) => getAlertSubscription(chatId, wallet),
	clearSnooze, rescheduleSnooze,
	getCoverSnapshots, saveCoverSnapshot, recordRenewalEvent,
	wasSent: wasAlertSent, recordSent: recordAlertSent, newAccess: newDashboardAccess,
	wasWeeklySummarySent, recordWeeklySummary
});

const keyOf = (row) => `${row.chat_id}:${row.wallet}`;

export async function checkExpiryAlerts({ sendMessage, dashboardUrl, now = Date.now(), logger = console, loadAttributions = listPositionAttributions, loadPositions = (wallet) => getWalletPositions(wallet), lookupCovers = getWalletCovers, store = {}, limits = ALERT_RUN_LIMITS, clock = Date.now, recordEvent = recordAgentEvent }) {
	const data = { ...ALERT_STORE, ...store };
	const startedAt = clock();
	const elapsed = () => clock() - startedAt;
	const used = { subscriptions: 0, lookups: 0, snoozes: 0 };
	const exhausted = [];
	const exhaust = (budget) => { if (!exhausted.includes(budget)) exhausted.push(budget); };
	let lookupReserve = limits.snoozeLookupReserve;
	const lookupAllowed = () => used.lookups < limits.maxCoverLookups - lookupReserve;
	const coversFor = (wallet) => { used.lookups++; return lookupCovers(wallet); };
	// Positionen nur als optionaler Kontext: ohne Budget keine Abfrage, die Warnung geht trotzdem raus.
	const budgetedPositions = (wallet) => {
		if (!lookupAllowed()) { exhaust('cover_lookups'); return null; }
		used.lookups++;
		return loadPositions(wallet);
	};
	let sent = 0;
	let failed = 0;
	const results = new Map();
	const processed = [];

	/* ------------------------------------------------------------ Abos */
	const subscriptionDeadline = limits.maxRunMs - limits.snoozePhaseMs - limits.summaryPhaseMs;
	const cursor = await data.loadCursor();
	// Ab dem Cursor bis zum Ende, dann von vorn bis einschliesslich Cursor.
	const passes = cursor ? [{ after: cursor, through: null }, { after: null, through: cursor }] : [{ after: null, through: null }];
	let stopped = null;
	pages: for (const pass of passes) {
		let after = pass.after;
		for (;;) {
			const page = await data.subscriptionsPage({ after, through: pass.through, limit: limits.subscriptionPageSize });
			if (!page.length) break;
			for (const subscription of page) {
				stopped = used.subscriptions >= limits.maxSubscriptions ? 'subscriptions'
					: !lookupAllowed() ? 'cover_lookups'
						: elapsed() >= subscriptionDeadline ? 'time' : null;
				if (stopped) { exhaust(stopped); break pages; }
				used.subscriptions++;
				processed.push(subscription);
				try {
					const result = await coversFor(subscription.wallet);
					results.set(keyOf(subscription), result);
					await syncCoverLifecycle(subscription, result.covers, sendMessage, dashboardUrl, data);
					const counts = await sendExpiryAlertsFor(subscription, result, { sendMessage, dashboardUrl, now, logger, loadAttributions, loadPositions: budgetedPositions, wasSent: data.wasSent, recordSent: data.recordSent, newAccess: data.newAccess });
					sent += counts.sent;
					failed += counts.failed;
				} catch (error) {
					failed++;
					logger.error(`Ablaufprüfung für Wallet ${subscription.wallet} fehlgeschlagen:`, error?.message);
				}
			}
			after = [page.at(-1).chat_id, page.at(-1).wallet];
		}
	}
	// Abgebrochen: hinter der letzten bearbeiteten Zeile weitermachen. Durchgelaufen: von vorn.
	if (stopped && processed.length) await data.saveCursor([processed.at(-1).chat_id, processed.at(-1).wallet]);
	else if (!stopped && cursor) await data.saveCursor(null);

	/* --------------------------------------------------------- Snoozes */
	lookupReserve = 0;
	const snoozeDeadline = limits.maxRunMs - limits.summaryPhaseMs;
	const subscriptionsByKey = new Map(processed.map((subscription) => [keyOf(subscription), subscription]));
	const snoozeCovers = new Map();
	const seen = new Set();
	snoozes: for (;;) {
		const page = await data.dueSnoozesPage(now, limits.snoozePageSize);
		const fresh = page.filter((snooze) => !seen.has(`${keyOf(snooze)}:${snooze.cover_id}`));
		if (!fresh.length) break;
		for (const snooze of fresh) {
			const budget = used.snoozes >= limits.maxSnoozes ? 'snoozes' : elapsed() >= snoozeDeadline ? 'time' : null;
			if (budget) { exhaust(budget); break snoozes; }
			seen.add(`${keyOf(snooze)}:${snooze.cover_id}`);
			used.snoozes++;
			try {
				const subscription = subscriptionsByKey.get(keyOf(snooze)) ?? await data.subscriptionFor(snooze.chat_id, snooze.wallet);
				if (!subscription) { await data.clearSnooze(snooze.chat_id, snooze.wallet, snooze.cover_id); continue; }
				let result = results.get(keyOf(subscription)) ?? snoozeCovers.get(subscription.wallet);
				if (!result) {
					if (!lookupAllowed()) { exhaust('cover_lookups'); used.snoozes--; break snoozes; }
					result = await coversFor(subscription.wallet);
					snoozeCovers.set(subscription.wallet, result);
				}
				const cover = result.covers.find((item) => String(item.coverId) === snooze.cover_id && item.status === 'active');
				if (cover) await sendMessage(subscription.chat_id, `${subscription.language === 'en' ? '⏰ Reminder as requested' : subscription.language === 'zh' ? '⏰ 按要求提醒' : '⏰ Erinnerung wie gewünscht'}\n\n${formatExpiryAlert(cover, Math.max(0, Math.ceil((Date.parse(cover.endsAt) - now) / DAY_MS)), subscription.language)}`, { _messageKind: 'snoozed_alert' });
				await data.clearSnooze(snooze.chat_id, snooze.wallet, snooze.cover_id); sent++;
			} catch (error) {
				failed++;
				logger.error('Snooze-Prüfung fehlgeschlagen:', error?.message);
				// Nach hinten; scheitert schon das, ist die Datenbank weg und der Lauf scheitert.
				await data.rescheduleSnooze(snooze.chat_id, snooze.wallet, snooze.cover_id, now + SNOOZE_RETRY_MS);
			}
		}
	}

	/* ---------------------------------------------- Wochenuebersicht */
	// Nur Chats, deren Wallets in DIESEM Lauf vollstaendig bearbeitet wurden. Nach
	// einem Abbruch sind das alle ausser dem angeschnittenen ersten und letzten.
	const partial = new Set(stopped ? [cursor?.[0], processed.at(-1)?.chat_id].filter(Boolean) : []);
	const summaries = await sendWeeklySummaries(processed.filter((subscription) => !partial.has(subscription.chat_id)), results, sendMessage, now, data,
		() => elapsed() < limits.maxRunMs, () => exhaust('time'), (error) => { failed++; logger.error('Wochenübersicht fehlgeschlagen:', error?.message); });

	const result = { subscriptions: used.subscriptions, sent, summaries, failed, snoozes: used.snoozes, lookups: used.lookups, budgetExhausted: exhausted[0] ?? null, continuation: Boolean(stopped) };
	if (exhausted.length) {
		logger.warn?.(`Erinnerungslauf am Budget beendet: ${exhausted.join(', ')}`);
		try {
			await recordEvent({ eventType: ALERT_RUN_BUDGET_EVENT, source: 'cron', metadata: { budget: exhausted[0], budgets: exhausted.join(','), subscriptions: used.subscriptions, lookups: used.lookups, snoozes: used.snoozes, continuation: Boolean(stopped) } });
		} catch {
			logger.error('Budget-Ereignis konnte nicht gespeichert werden.');
		}
	}
	return result;
}
