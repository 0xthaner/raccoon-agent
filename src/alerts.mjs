import { getWalletCovers, renewalUrl } from './covers.mjs';
import { newDashboardAccess } from './linking.mjs';
import { clearSnooze, getCoverSnapshots, listAlertSubscriptions, listDueSnoozes, recordAlertSent, recordRenewalEvent, recordWeeklySummary, saveCoverSnapshot, wasAlertSent, wasWeeklySummarySent } from './db.mjs';

export const ALERT_THRESHOLDS_DAYS = [0, 1, 3, 7, 14, 30];
const DAY_MS = 86_400_000;

export function dueThreshold(endsAt, now = Date.now(), thresholds = ALERT_THRESHOLDS_DAYS) {
	const remainingMs = Date.parse(endsAt) - now;
	if (!Number.isFinite(remainingMs) || remainingMs < 0) return null;
	return [...thresholds].sort((a, b) => a - b).find((days) => remainingMs <= days * DAY_MS) ?? null;
}

function lifecycleText(kind, cover, previous, language) {
	const product = cover.productName ?? `Cover #${cover.coverId}`;
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

async function syncCoverLifecycle(subscription, covers, sendMessage, dashboardUrl) {
	const snapshots = await getCoverSnapshots(subscription.chat_id, subscription.wallet);
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
		else if (previous && String(previous.amount ?? '') !== String(cover.amount ?? '')) kind = 'coverage';
		if (kind) {
			if (kind === 'renewed') {
				const renewedCoverId = previous?.cover_id ?? snapshots.find((item) => item.product_id === String(cover.productId) && item.ends_at && cover.startsAt && Math.abs(Date.parse(cover.startsAt) - Date.parse(item.ends_at)) <= 7 * DAY_MS)?.cover_id;
				if (renewedCoverId) await recordRenewalEvent({
					wallet: subscription.wallet, coverId: renewedCoverId, productId: cover.productId,
					amount: cover.amount, coverAssetId: cover.asset?.id, status: 'confirmed',
					buyTxHash: cover.purchaseTx, metadata: { detectedCoverId: cover.coverId, detectedBy: 'cover_snapshot' }
				}).catch(() => {});
			}
			const rows = [];
			if (dashboardUrl) {
				const access = await newDashboardAccess(subscription.wallet);
				rows.push([{ text: subscription.language === 'en' ? 'Open dashboard' : subscription.language === 'zh' ? '打开仪表板' : 'Dashboard öffnen', url: `${dashboardUrl}/?access=${encodeURIComponent(access.code)}` }]);
			}
			await sendMessage(subscription.chat_id, lifecycleText(kind, cover, previous, subscription.language), { ...(rows.length ? { reply_markup: { inline_keyboard: rows } } : {}), _messageKind: `cover_${kind}` });
		}
		await saveCoverSnapshot(subscription.chat_id, subscription.wallet, cover);
	}
}

function weekKey(now) {
	const date = new Date(now); const first = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
	return `${date.getUTCFullYear()}-${String(Math.ceil((((date - first) / DAY_MS) + first.getUTCDay() + 1) / 7)).padStart(2, '0')}`;
}

async function sendWeeklySummaries(subscriptions, results, sendMessage, now) {
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
		if (await wasWeeklySummarySent(chatId, week)) continue;
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
		await sendMessage(chatId, text, { _messageKind: 'weekly_summary' }); await recordWeeklySummary(chatId, week); sent++;
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

export function formatExpiryAlert(cover, thresholdDays, language = 'de') {
	const locale = language === 'zh' ? 'zh-CN' : language === 'en' ? 'en-GB' : 'de-AT';
	const expiry = new Intl.DateTimeFormat(locale, {
		dateStyle: 'long',
		timeStyle: 'short',
		timeZone: 'Europe/Vienna'
	}).format(new Date(cover.endsAt));
	const product = cover.productName ?? (language === 'zh' ? `Nexus 产品 #${cover.productId}` : language === 'en' ? `Nexus product #${cover.productId}` : `Nexus-Produkt #${cover.productId}`);

	const demo = cover.demo ? (language === 'zh' ? '演示：仅适用于此钱包 · 不会执行交易' : language === 'en' ? 'Demo for this wallet only · no transaction' : 'Demo für diese Wallet · keine Transaktion') : null;

	if (language === 'zh') return [
		'⚠️ 保障即将到期', '',
		thresholdDays === 0 ? '你的保障将在今天到期。' : `你的保障将在 ${thresholdDays} 天内到期。`, '',
		`产品：${product}`,
		`保障编号：#${cover.coverId}`,
		`保障金额：${formatAmount(cover, language)}`,
		`到期时间：${expiry}`, '', ...(demo ? [demo, ''] : []),
		'数据来源：Coverraccoon · Nexus Mutual · Ethereum'
	].join('\n');

	if (language === 'en') return [
		'⚠️ Cover expiry reminder', '',
		thresholdDays === 0 ? 'Your cover expires today.' : `Your cover expires within ${thresholdDays} days.`, '',
		`Product: ${product}`,
		`Cover: #${cover.coverId}`,
		`Cover amount: ${formatAmount(cover, language)}`,
		`Expiry: ${expiry}`, '', ...(demo ? [demo, ''] : []),
		'Source: Coverraccoon · Nexus Mutual · Ethereum'
	].join('\n');

	return [
		'⚠️ Cover-Ablaufwarnung', '',
		thresholdDays === 0 ? 'Dein Cover läuft heute aus.' : `Dein Cover läuft innerhalb der nächsten ${thresholdDays} Tage aus.`, '',
		`Produkt: ${product}`,
		`Cover: #${cover.coverId}`,
		`Versicherungssumme: ${formatAmount(cover, language)}`,
		`Ablauf: ${expiry}`, '', ...(demo ? [demo, ''] : []),
		'Quelle: Coverraccoon · Nexus Mutual · Ethereum'
	].join('\n');
}

export async function checkExpiryAlerts({ sendMessage, dashboardUrl, now = Date.now(), logger = console }) {
	const subscriptions = await listAlertSubscriptions();
	let sent = 0;
	let failed = 0;
	const results = new Map();

	for (const subscription of subscriptions) {
		try {
			const result = await getWalletCovers(subscription.wallet);
			results.set(`${subscription.chat_id}:${subscription.wallet}`, result);
			await syncCoverLifecycle(subscription, result.covers, sendMessage, dashboardUrl);
			for (const cover of result.covers) {
				if (cover.status !== 'active' || !cover.endsAt) continue;
				const threshold = dueThreshold(cover.endsAt, now, subscription.alert_thresholds);
				if (threshold == null || await wasAlertSent(subscription.chat_id, cover.coverId, cover.endsAt, threshold)) continue;
				const renew = renewalUrl(cover);
				const renewButton = cover.demo
					? { text: subscription.language === 'zh' ? '检查续保' : subscription.language === 'en' ? 'Review renewal' : 'Verlängerung prüfen', callback_data: `demo_renew:${cover.coverId}` }
					: renew ? { text: subscription.language === 'zh' ? '检查续保' : subscription.language === 'en' ? 'Review renewal' : 'Verlängerung prüfen', url: renew } : null;
				const rows = renewButton ? [[
						renewButton,
						{ text: subscription.language === 'zh' ? '明天提醒' : subscription.language === 'en' ? 'Remind tomorrow' : 'Morgen erinnern', callback_data: `renew_later:${cover.coverId}:${subscription.wallet}` }
					]] : [];
				if (dashboardUrl) {
					const access = await newDashboardAccess(subscription.wallet);
					rows.push([{ text: subscription.language === 'zh' ? '打开仪表板' : subscription.language === 'en' ? 'Open dashboard' : 'Dashboard öffnen', url: `${dashboardUrl}/?access=${encodeURIComponent(access.code)}` }]);
				}
				await sendMessage(subscription.chat_id, formatExpiryAlert(cover, threshold, subscription.language), { ...(rows.length ? { reply_markup: { inline_keyboard: rows } } : {}), _messageKind: 'expiry_alert' });
				await recordAlertSent(subscription.chat_id, cover.coverId, cover.endsAt, threshold);
				sent++;
			}
		} catch (error) {
			failed++;
			logger.error(`Ablaufprüfung für Wallet ${subscription.wallet} fehlgeschlagen:`, error.message);
		}
	}

	for (const snooze of await listDueSnoozes(now)) {
		try {
			const subscription = subscriptions.find((item) => item.chat_id === snooze.chat_id && item.wallet === snooze.wallet);
			if (!subscription) { await clearSnooze(snooze.chat_id, snooze.wallet, snooze.cover_id); continue; }
			const result = results.get(`${subscription.chat_id}:${subscription.wallet}`) ?? await getWalletCovers(subscription.wallet);
			const cover = result.covers.find((item) => String(item.coverId) === snooze.cover_id && item.status === 'active');
			if (cover) await sendMessage(subscription.chat_id, `${subscription.language === 'en' ? '⏰ Reminder as requested' : subscription.language === 'zh' ? '⏰ 按要求提醒' : '⏰ Erinnerung wie gewünscht'}\n\n${formatExpiryAlert(cover, Math.max(0, Math.ceil((Date.parse(cover.endsAt) - now) / DAY_MS)), subscription.language)}`, { _messageKind: 'snoozed_alert' });
			await clearSnooze(snooze.chat_id, snooze.wallet, snooze.cover_id); sent++;
		} catch (error) { failed++; logger.error('Snooze-Prüfung fehlgeschlagen:', error.message); }
	}
	const summaries = await sendWeeklySummaries(subscriptions, results, sendMessage, now);

	return { subscriptions: subscriptions.length, sent, summaries, failed };
}
