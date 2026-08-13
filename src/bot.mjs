import { beginTelegramDelivery, consumeTelegramHandoff, finishTelegramDelivery, forgetRememberedWallet, getLanguage, getMonitoredWallets, getRememberedWallets, getWalletLink, recordAgentEvent, rememberUnlinkedWallet, renameMonitoredWallet, revokeDashboardSessions, setLanguage, setPrimaryWallet, setWalletAlertSettings, snoozeCoverAlert, unlinkWallet } from './db.mjs';
import { newDashboardAccess, newLinkRequest } from './linking.mjs';
import { startWebServer } from './web.mjs';
import { CoverDataError, DEMO_WALLET, formatWalletCovers, getWalletCovers, renewalUrl } from './covers.mjs';
import { checkExpiryAlerts } from './alerts.mjs';
import { createDemoRenewToken } from './demo-renew.mjs';
import { classifyAgentIntent } from './agent-intent.mjs';
import { answerProductQuestion } from './agent-knowledge.mjs';

const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
const configuredUsername = process.env.TELEGRAM_BOT_USERNAME?.trim().replace(/^@/, '');
const appBaseUrl = (process.env.APP_BASE_URL?.trim() || 'http://localhost:8787').replace(/\/$/, '');

if (!token) {
	console.error('TELEGRAM_BOT_TOKEN fehlt in .env. Der Bot wurde nicht gestartet.');
	process.exit(1);
}

const apiBase = `https://api.telegram.org/bot${token}`;
let polling = true;
let webServer;
let alertTimer;
let alertCheckRunning = false;
const shutdownController = new AbortController();
const alertIntervalMinutes = Math.max(5, Number(process.env.ALERT_CHECK_INTERVAL_MINUTES) || 60);

function commandOf(text = '') {
	const buttonCommands = new Map([
		['📊 Dashboard', '/dashboard'], ['🛡 Meine Covers', '/covers'], ['🛡 My covers', '/covers'], ['🛡 我的保障', '/covers'],
		['🔄 Verlängerung prüfen', '/renew'], ['🔄 Review renewal', '/renew'], ['🔄 检查续保', '/renew'],
		['⚙️ Einstellungen', '/settings'], ['⚙️ Settings', '/settings'], ['⚙️ 设置', '/settings']
	]);
	if (buttonCommands.has(text.trim())) return buttonCommands.get(text.trim());
	const first = text.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? '';
	return first.split('@', 1)[0];
}

function startCodeOf(text = '') {
	const [, payload = ''] = text.trim().split(/\s+/, 2);
	const match = /^connect_([A-Za-z0-9_-]{24})$/.exec(payload);
	return match?.[1] ?? null;
}

function nextDailyAgentRun(now = Date.now()) {
	const next = new Date(now); next.setUTCDate(next.getUTCDate() + 1); next.setUTCHours(7, 55, 0, 0); return next.getTime();
}

async function dashboardKeyboard(language, wallet, includeCovers = false) {
	const access = wallet ? await newDashboardAccess(wallet) : null;
	const buttons = [{
		text: language === 'zh' ? '打开仪表板' : language === 'de' ? 'Dashboard öffnen' : 'Open dashboard',
		url: access ? `${appBaseUrl}/?access=${encodeURIComponent(access.code)}` : appBaseUrl
	}];
	if (includeCovers) buttons.push({
		text: language === 'zh' ? '我的保障' : language === 'de' ? 'Meine Covers' : 'My covers',
		callback_data: 'show_covers'
	});
	return { inline_keyboard: [buttons] };
}

function navigationKeyboard(language) {
	const labels = language === 'zh'
		? ['📊 Dashboard', '🛡 我的保障', '🔄 检查续保', '⚙️ 设置']
		: language === 'en'
			? ['📊 Dashboard', '🛡 My covers', '🔄 Review renewal', '⚙️ Settings']
			: ['📊 Dashboard', '🛡 Meine Covers', '🔄 Verlängerung prüfen', '⚙️ Einstellungen'];
	return { keyboard: [[{ text: labels[0] }, { text: labels[1] }], [{ text: labels[2] }, { text: labels[3] }]], resize_keyboard: true, is_persistent: true };
}

function settingsKeyboard(language) {
	return { inline_keyboard: [
		[{ text: language === 'zh' ? '⏰ 提醒' : language === 'en' ? '⏰ Reminders' : '⏰ Erinnerungen', callback_data: 'settings:reminders' }, { text: language === 'zh' ? '👛 钱包' : language === 'en' ? '👛 Wallets' : '👛 Wallets', callback_data: 'settings:wallets' }],
		[{ text: language === 'zh' ? '🔔 断开 Telegram' : language === 'en' ? '🔔 Disconnect Telegram' : '🔔 Telegram trennen', callback_data: 'settings:unlink_telegram' }],
		[{ text: language === 'zh' ? '🧹 完全断开钱包' : language === 'en' ? '🧹 Fully disconnect wallet' : '🧹 Wallet vollständig trennen', callback_data: 'settings:unlink_wallet' }],
		[{ text: language === 'zh' ? '🌐 更改语言' : language === 'en' ? '🌐 Change language' : '🌐 Sprache ändern', callback_data: 'settings:language' }, { text: language === 'zh' ? '❓ 帮助' : language === 'en' ? '❓ Help' : '❓ Hilfe', callback_data: 'settings:help' }]
	] };
}

function reminderKeyboard(wallet, language) {
	const active = new Set(wallet.alert_thresholds ?? [30, 14, 7, 3, 1, 0]);
	const labels = [30, 14, 7, 3, 1, 0].map((day) => ({ text: `${active.has(day) ? '✅' : '○'} ${day === 0 ? (language === 'en' ? 'Expiry day' : language === 'zh' ? '到期日' : 'Ablauftag') : `${day} ${language === 'en' ? 'days' : language === 'zh' ? '天' : 'Tage'}`}`, callback_data: `alert:${day}` }));
	return { inline_keyboard: [[labels[0], labels[1]], [labels[2], labels[3]], [labels[4], labels[5]], [{ text: `${wallet.weekly_summary ? '✅' : '○'} ${language === 'en' ? 'Weekly summary' : language === 'zh' ? '每周摘要' : 'Wochenübersicht'}`, callback_data: 'alert:weekly' }]] };
}

async function walletSettingsKeyboard(chatId, language) {
	const wallets = await getMonitoredWallets(chatId);
	const rows = wallets.map((wallet) => [{ text: `${wallet.is_primary ? '⭐' : '○'} ${wallet.label} · ${wallet.wallet.slice(0, 6)}…${wallet.wallet.slice(-4)}`, callback_data: `wallet:primary:${wallet.wallet}` }]);
	const link = await newLinkRequest(chatId);
	rows.push([{ text: language === 'en' ? '＋ Add wallet' : language === 'zh' ? '＋ 添加钱包' : '＋ Wallet hinzufügen', url: `${appBaseUrl}/link?code=${link.code}` }]);
	return { inline_keyboard: rows };
}

async function telegram(method, payload = {}) {
	const response = await fetch(`${apiBase}/${method}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(payload),
		signal: AbortSignal.any([AbortSignal.timeout(35_000), shutdownController.signal])
	});
	const result = await response.json();
	if (!response.ok || !result.ok) {
		throw new Error(`Telegram ${method} fehlgeschlagen: ${result.description ?? response.status}`);
	}
	return result.result;
}

async function sendMessage(chatId, text, options = {}) {
	const { _messageKind = 'bot_response', ...telegramOptions } = options;
	const deliveryId = await beginTelegramDelivery(chatId, _messageKind).catch(() => null);
	try {
		const result = await telegram('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true, ...telegramOptions });
		if (deliveryId) await finishTelegramDelivery(deliveryId, { messageId: result?.message_id }).catch(() => {});
		return result;
	} catch (error) {
		if (deliveryId) await finishTelegramDelivery(deliveryId, { errorCode: 'TELEGRAM_SEND_FAILED', errorMessage: error.message }).catch(() => {});
		throw error;
	}
}

function greeting(firstName, language) {
	const name = firstName ? ` ${firstName}` : '';
	if (language === 'zh') return [
		`欢迎${name}使用 Raccoon Agent。🦝`, '',
		'我会在你的 DeFi 保障到期前及时通知你。', '',
		'当前状态：Telegram MVP，支持钱包绑定和 Coverraccoon 数据。', '',
		'使用 /help 查看可用命令。'
	].join('\n');
	if (language === 'en') return [
		`Welcome${name} to Raccoon Agent. 🦝`, '',
		'I will notify you in time before your DeFi cover expires.', '',
		'Current status: Telegram MVP with wallet linking and Coverraccoon data.', '',
		'Use /help to see the available commands.'
	].join('\n');
	return [
		`Willkommen${name} beim Raccoon Agent. 🦝`,
		'',
		'Ich werde dich später rechtzeitig informieren, bevor dein DeFi-Cover ausläuft.',
		'',
		'Aktueller Stand: Telegram-MVP mit Wallet-Verknüpfung und Coverraccoon-Daten.',
		'',
		'Nutze /help für die verfügbaren Befehle.'
	].join('\n');
}

const helpTextDe = [
	'Raccoon-Agent-Befehle',
	'',
	'/start – Begrüßung anzeigen',
	'/status – aktuellen Teststatus anzeigen',
	'/covers – aktive Covers der verbundenen Wallet anzeigen',
	'/dashboard – persönliches Dashboard öffnen',
	'/renew – Verlängerung für ein aktives Cover prüfen',
	'/rename_wallet Name – aktuelle Primär-Wallet benennen',
	'/test_alert – simulierte Ablaufwarnung senden',
	'/unlink_telegram – nur Telegram-Benachrichtigungen trennen',
	'/unlink_wallet – Wallet vollständig trennen und alle Dashboard-Sitzungen abmelden',
	'/language – Sprache ändern',
	'/help – diese Hilfe anzeigen'
].join('\n');

const helpTextEn = [
	'Raccoon Agent commands', '',
	'/start – show welcome message',
	'/status – show current status',
	'/covers – show active covers for the linked wallet',
	'/dashboard – open your personal dashboard',
	'/renew – review renewal for an active cover',
	'/rename_wallet Name – name the current primary wallet',
	'/test_alert – send a simulated expiry alert',
	'/unlink_telegram – disconnect Telegram notifications only',
	'/unlink_wallet – fully disconnect the wallet and sign out all dashboard sessions',
	'/language – change language',
	'/help – show this help'
].join('\n');

const helpTextZh = [
	'Raccoon Agent 命令', '',
	'/start – 显示欢迎信息',
	'/status – 显示当前状态',
	'/covers – 显示已绑定钱包的有效保障',
	'/dashboard – 打开个人仪表板',
	'/renew – 检查有效保障的续保',
	'/rename_wallet 名称 – 命名当前主钱包',
	'/test_alert – 发送模拟到期提醒',
	'/unlink_telegram – 仅断开 Telegram 通知',
	'/unlink_wallet – 完全断开钱包并退出所有仪表板会话',
	'/language – 更改语言',
	'/help – 显示帮助'
].join('\n');

const languageKeyboard = {
	inline_keyboard: [[
		{ text: '🇩🇪 Deutsch', callback_data: 'language:de' },
		{ text: '🇬🇧 English', callback_data: 'language:en' },
		{ text: '🇨🇳 简体中文', callback_data: 'language:zh' }
	]]
};

async function askLanguage(chatId) {
	await sendMessage(chatId, 'Bitte Sprache wählen / Please choose your language / 请选择语言：', { reply_markup: languageKeyboard });
}

async function statusText(chatId, language) {
	const link = await getWalletLink(chatId);
	const coverMode = process.env.COVER_DATA_MODE?.trim() === 'api' ? 'Coverraccoon API' : 'Testmodus';
	if (language === 'zh') return [
		'状态：Telegram MVP 已启用', '',
		link ? `钱包：${link.wallet}` : '钱包：尚未绑定',
		`保障数据：${coverMode === 'Testmodus' ? '测试模式' : coverMode}`,
		`通知：${link?.alerts_enabled ? '已启用（30、14、7、3、1 天及到期当天）' : '尚未设置'}`
	].join('\n');
	if (language === 'en') return [
		'Status: Telegram MVP active', '',
		link ? `Wallet: ${link.wallet}` : 'Wallet: not linked yet',
		`Cover data: ${coverMode === 'Testmodus' ? 'Test mode' : coverMode}`,
		`Notifications: ${link?.alerts_enabled ? 'enabled (30, 14, 7, 3, 1 days and expiry day)' : 'not configured'}`
	].join('\n');
	return [
		'Status: Telegram-MVP aktiv', '',
		link ? `Wallet: ${link.wallet}` : 'Wallet: noch nicht verbunden',
		`Cover-Daten: ${coverMode}`,
		`Benachrichtigungen: ${link?.alerts_enabled ? 'aktiv (30, 14, 7, 3, 1 Tage und am Ablauftag)' : 'nicht eingerichtet'}`
	].join('\n');
}

function simulatedAlert(language) {
	const end = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
	const date = new Intl.DateTimeFormat('de-AT', {
		dateStyle: 'long',
		timeZone: 'Europe/Vienna'
	}).format(end);
	if (language === 'zh') return [
		'⚠️ 模拟测试提醒', '', '你的测试保障将在 14 天后到期。', '',
		'产品：Aave v3（测试数据）', '保障金额：15,000 USDC（测试数据）',
		`到期日：${new Intl.DateTimeFormat('zh-CN', { dateStyle: 'long', timeZone: 'Europe/Vienna' }).format(end)}`, '',
		'这不是真实的保障信息。未读取任何钱包或保障数据。'
	].join('\n');
	if (language === 'en') return [
		'⚠️ SIMULATED TEST ALERT', '', 'Your test cover expires in 14 days.', '',
		'Product: Aave v3 (test data)', 'Cover amount: 15,000 USDC (test data)',
		`Expiry: ${new Intl.DateTimeFormat('en-GB', { dateStyle: 'long', timeZone: 'Europe/Vienna' }).format(end)}`, '',
		'This is not real cover information. No wallet or cover data was retrieved.'
	].join('\n');
	return [
		'⚠️ SIMULIERTE TESTWARNUNG',
		'',
		'Dein Test-Cover läuft in 14 Tagen ab.',
		'',
		'Produkt: Aave v3 (Testdaten)',
		'Versicherungssumme: 15.000 USDC (Testdaten)',
		`Ablauf: ${date}`,
		'',
		'Dies ist keine echte Cover-Auskunft. Es wurden keine Wallet- oder Cover-Daten abgerufen.'
	].join('\n');
}

async function sendCovers(chatId, language) {
	const wallets = await getMonitoredWallets(chatId);
	if (!wallets.length) {
		await sendMessage(chatId, language === 'zh' ? '尚未绑定钱包。请发送 /start 并选择“绑定钱包”。' : language === 'en' ? 'No wallet linked yet. Send /start and use “Connect wallet”.' : 'Noch keine Wallet verbunden. Sende /start und nutze „Wallet verbinden“.');
		return;
	}
	for (const wallet of wallets) {
		try {
			const covers = await getWalletCovers(wallet.wallet);
			await sendMessage(chatId, `${wallet.is_primary ? '⭐ ' : ''}${wallet.label} · ${wallet.wallet.slice(0, 6)}…${wallet.wallet.slice(-4)}\n\n${formatWalletCovers(covers, language)}`, { reply_markup: await dashboardKeyboard(language, wallet.wallet) });
		} catch (error) {
			const detail = error instanceof CoverDataError ? error.message : 'Cover-Daten konnten gerade nicht geladen werden.';
			await sendMessage(chatId, `⚠️ ${wallet.label}: ${language === 'zh' ? '目前无法加载保障数据。' : language === 'en' ? 'Cover data could not be loaded right now.' : detail}`);
		}
	}
}

async function sendNextExpiry(chatId, language) {
	const wallets = await getMonitoredWallets(chatId);
	if (!wallets.length) {
		await sendMessage(chatId, language === 'en' ? 'No wallet is linked yet.' : language === 'zh' ? '尚未绑定钱包。' : 'Noch keine Wallet verbunden.');
		return;
	}
	try {
		const active = [];
		for (const wallet of wallets) {
			const result = await getWalletCovers(wallet.wallet);
			active.push(...result.covers.filter((cover) => cover.status === 'active' && cover.endsAt).map((cover) => ({ cover, wallet })));
		}
		active.sort((a, b) => Date.parse(a.cover.endsAt) - Date.parse(b.cover.endsAt));
		if (!active.length) {
			await sendMessage(chatId, language === 'en' ? 'I could not find an active cover with an expiry date.' : language === 'zh' ? '未找到带到期日的有效保障。' : 'Ich habe kein aktives Cover mit Ablaufdatum gefunden.');
			return;
		}
		const { cover, wallet } = active[0];
		const days = Math.max(0, Math.ceil((Date.parse(cover.endsAt) - Date.now()) / 86_400_000));
		const date = new Intl.DateTimeFormat(language === 'en' ? 'en-GB' : language === 'zh' ? 'zh-CN' : 'de-AT', { dateStyle: 'long', timeZone: 'Europe/Vienna' }).format(new Date(cover.endsAt));
		await sendMessage(chatId, language === 'en'
			? `Your next expiry is ${cover.productName ?? `Cover #${cover.coverId}`} on ${date} (${days} days).`
			: language === 'zh'
				? `下一个到期保障是 ${cover.productName ?? `保障 #${cover.coverId}`}，到期日为 ${date}（${days} 天）。`
				: `Als Nächstes läuft ${cover.productName ?? `Cover #${cover.coverId}`} am ${date} aus (noch ${days} Tage).`,
		{ reply_markup: await dashboardKeyboard(language, wallet.wallet, true) });
	} catch (error) {
		await sendMessage(chatId, `⚠️ ${language === 'en' ? 'Expiry data could not be loaded right now.' : language === 'zh' ? '目前无法加载到期数据。' : error instanceof CoverDataError ? error.message : 'Ablaufdaten konnten gerade nicht geladen werden.'}`);
	}
}

async function handleNaturalLanguage(message, language) {
	const decision = await classifyAgentIntent(message.text, language);
	await recordAgentEvent({ chatId: message.chat.id, eventType: 'agent.intent', source: 'telegram', command: decision.intent, metadata: { classifier: decision.source } }).catch(() => {});
	switch (decision.intent) {
		case 'show_covers': await sendCovers(message.chat.id, language); return;
		case 'show_next_expiry': await sendNextExpiry(message.chat.id, language); return;
		case 'prepare_renewal': return handleMessage({ ...message, text: '/renew', _agentRouted: true });
		case 'open_dashboard': return handleMessage({ ...message, text: '/dashboard', _agentRouted: true });
		case 'help': return handleMessage({ ...message, text: '/help', _agentRouted: true });
		case 'explain_product': {
			const answer = await answerProductQuestion(message.text, language);
			const wallet = await getWalletLink(message.chat.id);
			const dashboard = wallet ? await newDashboardAccess(wallet.wallet) : null;
			await sendMessage(message.chat.id, answer ?? (language === 'en' ? 'I could not answer that reliably right now. You can find the verified process in the guide.' : language === 'zh' ? '我目前无法可靠地回答这个问题。你可以在使用指南中查看经过核实的流程。' : 'Das kann ich gerade nicht zuverlässig beantworten. Den geprüften Ablauf findest du in der Anleitung.'), {
				reply_markup: { inline_keyboard: [[
					{ text: language === 'en' ? 'Guide' : language === 'zh' ? '使用指南' : 'Anleitung', url: `${appBaseUrl}/anleitung` },
					{ text: language === 'en' ? 'Dashboard' : language === 'zh' ? '仪表板' : 'Dashboard', url: dashboard ? `${appBaseUrl}/?access=${encodeURIComponent(dashboard.code)}` : appBaseUrl }
				]] }
			});
			return;
		}
		case 'show_reminders': {
			const wallet = await getWalletLink(message.chat.id);
			if (!wallet) await sendMessage(message.chat.id, language === 'en' ? 'No wallet linked.' : language === 'zh' ? '尚未绑定钱包。' : 'Keine Wallet verbunden.');
			else await sendMessage(message.chat.id, language === 'en' ? `Reminders for ${wallet.label}:` : language === 'zh' ? `${wallet.label} 的提醒：` : `Erinnerungen für ${wallet.label}:`, { reply_markup: reminderKeyboard(wallet, language) });
			return;
		}
		case 'snooze_tomorrow': {
			const wallet = await getWalletLink(message.chat.id);
			if (!wallet) await sendMessage(message.chat.id, language === 'en' ? 'No wallet linked.' : language === 'zh' ? '尚未绑定钱包。' : 'Keine Wallet verbunden.');
			else await sendMessage(message.chat.id, language === 'en' ? 'Which cover should I remind you about tomorrow? Open renewal to choose it.' : language === 'zh' ? '明天要提醒哪个保障？请打开续保并选择。' : 'Für welches Cover soll ich dich morgen erinnern? Öffne die Verlängerung und wähle es aus.', { reply_markup: { inline_keyboard: [[{ text: language === 'en' ? 'Choose cover' : language === 'zh' ? '选择保障' : 'Cover auswählen', callback_data: 'show_covers' }]] } });
			return;
		}
		default:
			await sendMessage(message.chat.id, language === 'en' ? 'I can help with covers, expiry dates, renewals, reminders and your dashboard. What would you like to know?' : language === 'zh' ? '我可以帮助你查看保障、到期日、续保、提醒和仪表板。你想了解什么？' : 'Ich helfe dir bei Covers, Ablaufdaten, Verlängerungen, Erinnerungen und dem Dashboard. Was möchtest du wissen?', { reply_markup: navigationKeyboard(language) });
	}
}

async function unlinkTelegramFor(chatId, language) {
	const wallets = await getMonitoredWallets(chatId);
	await Promise.all(wallets.map((wallet) => rememberUnlinkedWallet(chatId, wallet.wallet)));
	const removed = wallets.length ? await unlinkWallet(chatId) : false;
	await sendMessage(chatId, removed
		? (language === 'zh' ? 'Telegram 通知已断开。仪表板仍保持登录。' : language === 'en' ? 'Telegram notifications disconnected. Your dashboard remains signed in.' : 'Telegram-Benachrichtigungen wurden getrennt. Dein Dashboard bleibt angemeldet.')
		: (language === 'zh' ? '尚未连接 Telegram。' : language === 'en' ? 'Telegram was not connected.' : 'Telegram war nicht verbunden.'),
	{ reply_markup: navigationKeyboard(language) });
}

async function unlinkWalletFor(chatId, language) {
	const wallets = await getMonitoredWallets(chatId);
	const link = wallets.find((wallet) => wallet.is_primary) ?? wallets[0];
	const remembered = await getRememberedWallets(chatId);
	const walletAddresses = [...new Set([...wallets.map((item) => item.wallet), ...remembered])];
	if (!walletAddresses.length) {
		await sendMessage(chatId, language === 'zh' ? '尚未绑定钱包。' : language === 'en' ? 'No wallet was linked.' : 'Es war keine Wallet verknüpft.', { reply_markup: navigationKeyboard(language) });
		return;
	}
	await Promise.all(walletAddresses.map((item) => revokeDashboardSessions(item)));
	if (link) await unlinkWallet(chatId);
	await forgetRememberedWallet(chatId);
	await sendMessage(chatId, language === 'zh'
		? '钱包已完全断开。Telegram 通知已停止，所有设备上的仪表板会话均已退出。'
		: language === 'en'
			? 'Wallet fully disconnected. Telegram notifications are stopped and dashboard sessions on all devices are signed out.'
			: 'Wallet vollständig getrennt. Telegram-Benachrichtigungen sind gestoppt und die Dashboard-Sitzungen auf allen Geräten wurden abgemeldet.',
	{ reply_markup: navigationKeyboard(language) });
}

async function confirmWalletUnlink(chatId, language) {
	await sendMessage(chatId,
		language === 'zh' ? '这将停止 Telegram 通知并退出所有设备上的仪表板。是否继续？' : language === 'en' ? 'This stops Telegram notifications and signs the dashboard out on every device. Continue?' : 'Dadurch werden Telegram-Benachrichtigungen gestoppt und das Dashboard auf allen Geräten abgemeldet. Fortfahren?',
		{ reply_markup: { inline_keyboard: [[
			{ text: language === 'zh' ? '确认断开' : language === 'en' ? 'Confirm disconnect' : 'Trennung bestätigen', callback_data: 'confirm:unlink_wallet' },
			{ text: language === 'zh' ? '取消' : language === 'en' ? 'Cancel' : 'Abbrechen', callback_data: 'confirm:cancel' }
		]] } }
	);
}

async function handleMessage(message) {
	if (!message?.chat?.id || message.chat.type !== 'private') return;
	if (typeof message.text !== 'string' || !message.text.trim()) return;
	const command = commandOf(message.text);
	if (!command) return;
	const explicitCommand = message.text.trim().startsWith('/') || ['📊 Dashboard', '🛡 Meine Covers', '🛡 My covers', '🛡 我的保障', '🔄 Verlängerung prüfen', '🔄 Review renewal', '🔄 检查续保', '⚙️ Einstellungen', '⚙️ Settings', '⚙️ 设置'].includes(message.text.trim());
	await recordAgentEvent({ chatId: message.chat.id, eventType: explicitCommand ? 'bot.command' : 'bot.free_text', source: 'telegram', command: explicitCommand ? command : 'free_text' }).catch(() => {});
	const startCode = command === '/start' ? startCodeOf(message.text) : null;
	if (startCode) await consumeTelegramHandoff(startCode, message.chat.id);
	const language = await getLanguage(message.chat.id);
	if (!language && command !== '/start' && command !== '/language') {
		await askLanguage(message.chat.id);
		return;
	}
	if (!message._agentRouted && !explicitCommand) {
		await handleNaturalLanguage(message, language);
		return;
	}

	switch (command) {
		case '/start':
			if (!language) {
				await askLanguage(message.chat.id);
				break;
			}
			await sendMessage(message.chat.id, greeting(message.from?.first_name, language), { reply_markup: navigationKeyboard(language) });
			if (!await getWalletLink(message.chat.id)) {
				const link = await newLinkRequest(message.chat.id);
				const walletUrl = `${appBaseUrl}/link?code=${link.code}`;
				await sendMessage(message.chat.id, language === 'zh' ? '绑定钱包（10 分钟内有效）：' : language === 'en' ? 'Connect wallet (valid for 10 minutes):' : 'Wallet verbinden (10 Minuten gültig):', {
					reply_markup: {
						inline_keyboard: [[{ text: language === 'zh' ? '🔗 绑定钱包' : language === 'en' ? '🔗 Connect wallet' : '🔗 Wallet verbinden', url: walletUrl }]]
					}
				});
			} else await sendMessage(message.chat.id,
				language === 'zh' ? '一切设置完毕 🦝\n\n我现在会监控你的保障并及时提醒你。你可以随时在仪表板中查看保障、期限和设置。' : language === 'de' ? 'Alles eingerichtet 🦝\n\nIch überwache jetzt deine Covers und melde mich rechtzeitig. Im Dashboard kannst du Covers, Laufzeiten und Einstellungen jederzeit ansehen.' : 'Everything is set up 🦝\n\nI will now monitor your cover and notify you in time. You can view cover, expiry dates and settings in the dashboard at any time.',
				{ reply_markup: await dashboardKeyboard(language, (await getWalletLink(message.chat.id))?.wallet, true) }
			);
			break;
		case '/help':
			await sendMessage(message.chat.id, language === 'zh' ? helpTextZh : language === 'en' ? helpTextEn : helpTextDe, { reply_markup: await dashboardKeyboard(language, (await getWalletLink(message.chat.id))?.wallet) });
			break;
		case '/status':
			await sendMessage(message.chat.id, await statusText(message.chat.id, language), { reply_markup: await dashboardKeyboard(language, (await getWalletLink(message.chat.id))?.wallet) });
			break;
		case '/covers':
			await sendCovers(message.chat.id, language);
			break;
		case '/dashboard':
			{
			const dashboardLink = await getWalletLink(message.chat.id);
			await sendMessage(message.chat.id,
				language === 'zh' ? '在网页上查看和管理你的保障：' : language === 'de' ? 'Covers im Web ansehen und verwalten:' : 'View and manage your cover on the web:',
				{ reply_markup: await dashboardKeyboard(language, dashboardLink?.wallet) }
			);
			}
			break;
		case '/renew': {
			const wallets = await getMonitoredWallets(message.chat.id);
			if (!wallets.length) {
				await sendMessage(message.chat.id, language === 'zh' ? '尚未绑定钱包。请先发送 /start。' : language === 'en' ? 'No wallet linked yet. Send /start first.' : 'Noch keine Wallet verbunden. Sende zuerst /start.');
				break;
			}
			try {
				const renewable = [];
				for (const wallet of wallets) {
					const result = await getWalletCovers(wallet.wallet);
					renewable.push(...result.covers.filter((cover) => cover.status === 'active' && (cover.demo || renewalUrl(cover))).map((cover) => ({ cover, wallet, url: renewalUrl(cover) })));
				}
				if (!renewable.length) {
					await sendMessage(message.chat.id, language === 'zh' ? '目前没有可续保的有效保障。' : language === 'en' ? 'There is currently no active cover available to renew.' : 'Aktuell gibt es kein aktives Cover, das verlängert werden kann.');
					break;
				}
				await sendMessage(message.chat.id,
					language === 'zh' ? '选择要续保的保障：' : language === 'en' ? 'Choose the cover whose renewal you want to review:' : 'Wähle das Cover, dessen Verlängerung du prüfen möchtest:',
					{ reply_markup: { inline_keyboard: renewable.map(({ cover, wallet, url }) => [{
						text: `${wallet.label} · ${cover.productName ?? `Cover #${cover.coverId}`} · #${cover.coverId}`,
						...(cover.demo ? { callback_data: `demo_renew:${cover.coverId}` } : { url })
					}]) } }
				);
			} catch (error) {
				const detail = error instanceof CoverDataError ? error.message : 'Cover-Daten konnten gerade nicht geladen werden.';
				await sendMessage(message.chat.id, `⚠️ ${language === 'en' ? 'Renewal data could not be loaded right now.' : language === 'zh' ? '目前无法加载续保数据。' : detail}`);
			}
			break;
		}
		case '/test_alert':
			await sendMessage(message.chat.id, simulatedAlert(language));
			break;
		case '/unlink_telegram': {
			await unlinkTelegramFor(message.chat.id, language);
			break;
		}
		case '/unlink_wallet': {
			await confirmWalletUnlink(message.chat.id, language);
			break;
		}
		case '/settings':
			await sendMessage(message.chat.id, language === 'zh' ? '选择设置：' : language === 'en' ? 'Choose a setting:' : 'Wähle eine Einstellung:', { reply_markup: settingsKeyboard(language) });
			break;
		case '/rename_wallet': {
			const label = message.text.trim().split(/\s+/).slice(1).join(' ');
			const wallet = await getWalletLink(message.chat.id);
			if (!wallet || !label) await sendMessage(message.chat.id, language === 'en' ? 'Usage: /rename_wallet My wallet' : language === 'zh' ? '用法：/rename_wallet 我的钱包' : 'Verwendung: /rename_wallet Meine Wallet');
			else { await renameMonitoredWallet(message.chat.id, wallet.wallet, label); await sendMessage(message.chat.id, language === 'en' ? `Wallet renamed to “${label.slice(0, 32)}”.` : language === 'zh' ? `钱包已重命名为“${label.slice(0, 32)}”。` : `Wallet wurde in „${label.slice(0, 32)}“ umbenannt.`); }
			break;
		}
		case '/unlink':
			await sendMessage(message.chat.id, language === 'zh'
				? '请选择：/unlink_telegram 仅断开通知，或 /unlink_wallet 完全重置。'
				: language === 'en'
					? 'Please choose: /unlink_telegram disconnects notifications only; /unlink_wallet performs a full reset.'
					: 'Bitte wähle: /unlink_telegram trennt nur Benachrichtigungen, /unlink_wallet führt einen vollständigen Reset durch.');
			break;
		case '/language':
			await askLanguage(message.chat.id);
			break;
		default:
			await sendMessage(message.chat.id, language === 'zh' ? '我还不认识这个命令。请使用 /help。' : language === 'en' ? 'I do not know that command yet. Use /help.' : 'Diesen Befehl kenne ich noch nicht. Nutze /help.');
	}
}

async function handleCallbackQuery(query) {
	if (!query?.message?.chat?.id || query.message.chat.type !== 'private' || String(query.from?.id) !== String(query.message.chat.id)) return;
	if (query?.message?.chat?.id && query?.data) await recordAgentEvent({
		chatId: query.message.chat.id, eventType: 'bot.callback', source: 'telegram',
		command: String(query.data).split(':', 1)[0], metadata: { action: String(query.data).slice(0, 80) }
	}).catch(() => {});
	if (query?.data?.startsWith('settings:') && query.message?.chat?.id) {
		const chatId = query.message.chat.id;
		const language = await getLanguage(chatId) ?? 'de';
		await telegram('answerCallbackQuery', { callback_query_id: query.id });
		if (query.data === 'settings:unlink_telegram') {
			await unlinkTelegramFor(chatId, language);
			return;
		}
		if (query.data === 'settings:unlink_wallet') {
			await confirmWalletUnlink(chatId, language);
			return;
		}
		if (query.data === 'settings:reminders') {
			const wallet = await getWalletLink(chatId);
			if (!wallet) { await sendMessage(chatId, language === 'en' ? 'No wallet linked.' : language === 'zh' ? '尚未绑定钱包。' : 'Keine Wallet verbunden.'); return; }
			await sendMessage(chatId, language === 'en' ? `Reminders for ${wallet.label}:` : language === 'zh' ? `${wallet.label} 的提醒：` : `Erinnerungen für ${wallet.label}:`, { reply_markup: reminderKeyboard(wallet, language) });
			return;
		}
		if (query.data === 'settings:wallets') {
			await sendMessage(chatId, language === 'en' ? 'Choose the primary wallet or add another:' : language === 'zh' ? '选择主钱包或添加另一个：' : 'Wähle die Primär-Wallet oder füge eine weitere hinzu:', { reply_markup: await walletSettingsKeyboard(chatId, language) });
			return;
		}
		if (query.data === 'settings:language') { await askLanguage(chatId); return; }
		if (query.data === 'settings:help') {
			await sendMessage(chatId, language === 'zh' ? helpTextZh : language === 'en' ? helpTextEn : helpTextDe, { reply_markup: navigationKeyboard(language) });
			return;
		}
	}
	const alertSetting = /^alert:(0|1|3|7|14|30|weekly)$/.exec(query?.data ?? '');
	if (alertSetting && query.message?.chat?.id) {
		const chatId = query.message.chat.id; const language = await getLanguage(chatId) ?? 'de'; const wallet = await getWalletLink(chatId);
		if (!wallet) return;
		if (alertSetting[1] === 'weekly') await setWalletAlertSettings(chatId, wallet.wallet, { weeklySummary: !wallet.weekly_summary });
		else {
			const day = Number(alertSetting[1]); const thresholds = new Set(wallet.alert_thresholds ?? [30, 14, 7, 3, 1, 0]);
			if (thresholds.has(day)) thresholds.delete(day); else thresholds.add(day);
			await setWalletAlertSettings(chatId, wallet.wallet, { thresholds: [...thresholds] });
		}
		const updated = await getWalletLink(chatId);
		await telegram('answerCallbackQuery', { callback_query_id: query.id, text: language === 'en' ? 'Saved' : language === 'zh' ? '已保存' : 'Gespeichert' });
		await sendMessage(chatId, language === 'en' ? 'Your reminder settings:' : language === 'zh' ? '你的提醒设置：' : 'Deine Erinnerungseinstellungen:', { reply_markup: reminderKeyboard(updated, language) });
		return;
	}
	const primaryWallet = /^wallet:primary:(0x[a-fA-F0-9]{40})$/.exec(query?.data ?? '');
	if (primaryWallet && query.message?.chat?.id) {
		const chatId = query.message.chat.id; const language = await getLanguage(chatId) ?? 'de'; const selected = await setPrimaryWallet(chatId, primaryWallet[1]);
		await telegram('answerCallbackQuery', { callback_query_id: query.id, text: selected ? (language === 'en' ? 'Primary wallet changed' : language === 'zh' ? '主钱包已更改' : 'Primär-Wallet geändert') : 'Wallet not found', show_alert: !selected });
		if (selected) await sendMessage(chatId, `${selected.label} · ${selected.wallet.slice(0, 6)}…${selected.wallet.slice(-4)}`, { reply_markup: await walletSettingsKeyboard(chatId, language) });
		return;
	}
	if (query?.data?.startsWith('confirm:') && query.message?.chat?.id) {
		const chatId = query.message.chat.id;
		const language = await getLanguage(chatId) ?? 'de';
		await telegram('answerCallbackQuery', { callback_query_id: query.id });
		if (query.data === 'confirm:unlink_wallet') await unlinkWalletFor(chatId, language);
		else await sendMessage(chatId, language === 'zh' ? '已取消。' : language === 'en' ? 'Cancelled.' : 'Abgebrochen.', { reply_markup: navigationKeyboard(language) });
		return;
	}
	if (query?.data === 'show_covers' && query.message?.chat?.id) {
		const language = await getLanguage(query.message.chat.id) ?? 'de';
		await telegram('answerCallbackQuery', { callback_query_id: query.id });
		await sendCovers(query.message.chat.id, language);
		return;
	}
	const demoRenew = /^demo_renew:(424242)$/.exec(query?.data ?? '');
	if (demoRenew && query.message?.chat?.id) {
		const language = await getLanguage(query.message.chat.id) ?? 'de';
		const wallets = await getMonitoredWallets(query.message.chat.id);
		if (!DEMO_WALLET || !wallets.some((wallet) => wallet.wallet.toLowerCase() === DEMO_WALLET)) {
			await telegram('answerCallbackQuery', { callback_query_id: query.id, text: 'Dieses Cover gehört nicht zu deiner Wallet.', show_alert: true });
			return;
		}
		await telegram('answerCallbackQuery', { callback_query_id: query.id });
		const checkoutUrl = `${appBaseUrl}/demo-renew?token=${encodeURIComponent(createDemoRenewToken(query.message.chat.id))}`;
		await sendMessage(query.message.chat.id, language === 'en'
			? 'Renewal proposal\n\nAave v3 · Cover #424242\nCover amount: 15,000 USDC\nNew term: 365 days\n\nThe final premium is calculated when the owner wallet confirms.\n\nDemo for this wallet · no transaction'
			: language === 'zh'
				? '续保方案\n\nAave v3 · 保障 #424242\n保障金额：15,000 USDC\n新期限：365 天\n\n最终保费将在所有者钱包确认时计算。\n\n仅此钱包演示 · 不会执行交易'
				: 'Verlängerungsangebot\n\nAave v3 · Cover #424242\nVersicherungssumme: 15.000 USDC\nNeue Laufzeit: 365 Tage\n\nDie finale Prämie wird bei Bestätigung durch die Owner-Wallet berechnet.\n\nDemo für diese Wallet · keine Transaktion', {
			reply_markup: { inline_keyboard: [[
				{ text: language === 'en' ? 'Continue with wallet' : language === 'zh' ? '使用钱包继续' : 'Mit Wallet fortfahren', url: checkoutUrl },
				{ text: language === 'en' ? 'Later' : language === 'zh' ? '稍后' : 'Später', callback_data: 'renew_later:424242' }
			]] }
		});
		return;
	}
	const later = /^renew_later:(\d+)(?::(0x[a-fA-F0-9]{40}))?$/.exec(query?.data ?? '');
	if (later && query.message?.chat?.id) {
		const language = await getLanguage(query.message.chat.id) ?? 'de';
		const wallet = later[2] ?? (await getWalletLink(query.message.chat.id))?.wallet;
		if (wallet) await snoozeCoverAlert(query.message.chat.id, wallet, later[1], nextDailyAgentRun());
		await telegram('answerCallbackQuery', { callback_query_id: query.id, text: language === 'zh' ? '好的，我明天提醒你。' : language === 'en' ? 'Okay, I will remind you tomorrow.' : 'Okay, ich erinnere dich morgen.' });
		return;
	}
	const match = /^language:(de|en|zh)$/.exec(query?.data ?? '');
	if (!match || !query.message?.chat?.id) return;
	const language = match[1];
	const chatId = query.message.chat.id;
	await setLanguage(chatId, language);
	await telegram('answerCallbackQuery', { callback_query_id: query.id, text: language === 'zh' ? '语言已保存' : language === 'en' ? 'Language saved' : 'Sprache gespeichert' });
	await sendMessage(chatId, greeting(query.from?.first_name, language), { reply_markup: navigationKeyboard(language) });
	if (!await getWalletLink(chatId)) {
		const link = await newLinkRequest(chatId);
		const walletUrl = `${appBaseUrl}/link?code=${link.code}`;
		await sendMessage(chatId, language === 'zh' ? '绑定钱包（10 分钟内有效）：' : language === 'en' ? 'Connect wallet (valid for 10 minutes):' : 'Wallet verbinden (10 Minuten gültig):', {
			reply_markup: { inline_keyboard: [[{ text: language === 'zh' ? '🔗 绑定钱包' : language === 'en' ? '🔗 Connect wallet' : '🔗 Wallet verbinden', url: walletUrl }]] }
		});
	} else await sendMessage(chatId,
		language === 'zh' ? 'Telegram 通知已连接。你的钱包无需再次连接。' : language === 'en' ? 'Telegram notifications connected. You do not need to connect your wallet again.' : 'Telegram-Benachrichtigungen verbunden. Du musst deine Wallet nicht erneut verbinden.',
		{ reply_markup: await dashboardKeyboard(language, (await getWalletLink(chatId))?.wallet, true) }
	);
}

export async function handleUpdate(update) {
	if (update?.callback_query) await handleCallbackQuery(update.callback_query);
	else await handleMessage(update?.message);
}

async function runAlertCheck() {
	if (alertCheckRunning || !polling) return;
	alertCheckRunning = true;
	try {
		const result = await checkExpiryAlerts({ sendMessage, dashboardUrl: appBaseUrl });
		console.log(`Ablaufprüfung: ${result.subscriptions} Wallet(s), ${result.sent} Warnung(en), ${result.failed} Fehler.`);
	} catch (error) {
		console.error('Ablaufprüfung fehlgeschlagen:', error.message);
	} finally {
		alertCheckRunning = false;
	}
}

async function run() {
	const me = await telegram('getMe');
	if (configuredUsername && configuredUsername.toLowerCase() !== me.username?.toLowerCase()) {
		throw new Error(
			`TELEGRAM_BOT_USERNAME passt nicht zum Token. Erwartet: ${configuredUsername}; Token gehört zu: ${me.username}`
		);
	}

	// Long Polling und Webhook können nicht gleichzeitig aktiv sein.
	await telegram('deleteWebhook', { drop_pending_updates: false });
	webServer = startWebServer({
		onLinked: async (chatId, wallet) => {
			const language = await getLanguage(chatId) ?? 'de';
			return sendMessage(chatId, language === 'zh'
				? `一切设置完毕 🦝\n\n我现在会监控你的保障并及时提醒你。你可以随时在仪表板中查看保障、期限和设置。\n\n钱包：${wallet}`
				: language === 'en'
					? `Everything is set up 🦝\n\nI will now monitor your cover and notify you in time. You can view cover, expiry dates and settings in the dashboard at any time.\n\nWallet: ${wallet}`
					: `Alles eingerichtet 🦝\n\nIch überwache jetzt deine Covers und melde mich rechtzeitig. Im Dashboard kannst du Covers, Laufzeiten und Einstellungen jederzeit ansehen.\n\nWallet: ${wallet}`,
				{ reply_markup: await dashboardKeyboard(language, wallet, true) });
		}
	});
	console.log(`Raccoon Agent läuft als @${me.username}. Beenden mit Strg+C.`);
	console.log(`Automatische Ablaufprüfung alle ${alertIntervalMinutes} Minuten.`);
	alertTimer = setInterval(runAlertCheck, alertIntervalMinutes * 60_000);
	setTimeout(runAlertCheck, 10_000);

	let offset = 0;
	while (polling) {
		try {
			const updates = await telegram('getUpdates', {
				offset,
				timeout: 25,
				allowed_updates: ['message', 'callback_query']
			});
			for (const update of updates) {
				offset = update.update_id + 1;
				try {
					await handleUpdate(update);
				} catch (error) {
					console.error('Nachricht konnte nicht verarbeitet werden:', error.message);
				}
			}
		} catch (error) {
			if (!polling) break;
			console.error('Telegram-Abfrage fehlgeschlagen:', error.message);
			await new Promise((resolve) => setTimeout(resolve, 3_000));
		}
	}
}

for (const signal of ['SIGINT', 'SIGTERM']) {
	process.on(signal, () => {
		if (!polling) return;
		polling = false;
		clearInterval(alertTimer);
		console.log('\nRaccoon Agent wird beendet …');
		shutdownController.abort();
		webServer?.close((error) => {
			if (error) console.error('Webserver konnte nicht sauber beendet werden:', error.message);
		});
	});
}

if (!process.env.VERCEL) {
	run().catch((error) => {
		console.error(error.message);
		process.exitCode = 1;
	});
}
