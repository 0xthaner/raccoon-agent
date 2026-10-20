/*
	Dashboard-Schale (20.10.2026): Navigation und die Ansichten Uebersicht,
	Positionen (Tabelle), Covers (bald ablaufend, vergangen), Agent und
	Einstellungen. Reine Darstellung.

	Dieses Modul importiert nichts, ruft kein fetch und keine Wallet auf und
	kennt keinen Kauf. Es bekommt von main.js genau die Daten, die das Dashboard
	ohnehin schon hat (/api/dashboard, /api/positions und die Cover-Zuordnung)
	und schreibt sie nur ueber textContent in feste
	Knoten aus web/index.html. Neue Elemente nur aus der Liste, die
	test/browser-render-sinks.test.mjs zulaesst (div, span, small, strong, p, a,
	button, article, section, h3, h4).

	Wortwahl wie im Rest des Dashboards: nichts, was Deckung, Schutz, einen
	Anspruch oder eine Garantie nahelegt. "Cover zugeordnet" heisst nur: die
	oeffentlichen Daten oder der Nutzer ordnen ein aktives Cover dieser Position
	zu. Interne Kennungen (deploymentKey, Produktnummer) erscheinen hier nie.
*/

export const DASHBOARD_VIEWS = Object.freeze(['overview', 'positions', 'covers', 'agent', 'settings']);
export const EXPIRING_SOON_DAYS = 30;
const DAY_MS = 86_400_000;

const TEXTS = {
	de: {
		nav: { overview: 'Übersicht', positions: 'Positionen', covers: 'Covers', agent: 'Agent', settings: 'Einstellungen' },
		navLabel: 'Dashboard-Navigation',
		overviewLead: 'Deine Positionen, Covers und anstehenden Abläufe auf einen Blick.',
		positionsLabel: 'Erkannte Positionen', uncoveredLabel: 'Ohne aktives Cover', positionsScope: 'Aave v3 · Ethereum',
		uncoveredNote: 'Positionen ohne zugeordnetes aktives Cover', expiryNoteNone: 'Kein aktives Cover', loadingShort: 'wird gelesen …', unavailableShort: 'nicht verfügbar',
		attentionTitle: 'Zu beachten', attentionNone: 'Gerade gibt es nichts, worum du dich kümmern musst.',
		attentionNoCover: { one: '1 Position ohne aktives Cover für das passende Nexus-Produkt.', many: '{n} Positionen ohne aktives Cover für das passende Nexus-Produkt.' },
		attentionConfirm: { one: 'Bei 1 Position wartet die Cover-Zuordnung auf deine Bestätigung.', many: 'Bei {n} Positionen wartet die Cover-Zuordnung auf deine Bestätigung.' },
		attentionExpiring: '{cover} läuft in {days} ab ({date}).', attentionExpiringToday: '{cover} läuft heute ab ({date}).',
		attentionUnknown: 'Einige Positions- oder Cover-Angaben sind gerade nicht verfügbar.',
		attentionTelegram: 'Ablauf-Erinnerungen über Telegram sind nicht verbunden.',
		actionPositions: 'Positionen ansehen', actionCovers: 'Covers ansehen', actionSettings: 'Einstellungen öffnen',
		previewTitle: 'Positionen', previewLink: 'Alle Positionen ansehen', previewMore: '+ {n} weitere',
		askTitle: 'CoverRaccoon fragen', askPlaceholder: 'Frag nach deinen Positionen, Cover-Optionen oder Bedingungen …', askLink: 'Zum Agent',
		activityTitle: 'Letzte Aktivität', activityNone: 'Noch keine Aktivität in dieser Sitzung.',
		activityCovers: 'Covers von Ethereum gelesen', activityPositions: 'Positionen gelesen (Aave v3 · Ethereum)', activityTelegram: 'Telegram-Erinnerungen verbunden',
		activityTelegramState: 'Status',
		columns: { protocol: 'Protokoll', network: 'Netzwerk', position: 'Position', exposure: 'Nettowert', status: 'Cover-Status' },
		positionsLead: 'Erkannte DeFi-Positionen dieser Wallet und ob dafür ein aktives Cover zugeordnet ist.',
		positionsDetails: 'Details und Cover-Zuordnung',
		positionsLoading: 'Positionen werden gelesen …', positionsError: 'Positionen konnten gerade nicht geladen werden.', positionsNone: 'Keine Positionen gefunden.',
		supplied: 'eingezahlt', borrowed: 'geliehen',
		status: { ATTRIBUTED: 'Cover zugeordnet', CONFIRM: 'Zuordnung offen', NO_ACTIVE_COVER: 'Kein aktives Cover', UNAVAILABLE: 'Derzeit kein Cover verfügbar', UNKNOWN: 'Cover-Status unbekannt', NOT_READ: 'Nicht lesbar' },
		product: { yes: 'Passendes Nexus-Produkt verfügbar', no: 'Kein passendes Nexus-Produkt', unknown: 'Nexus-Katalog nicht prüfbar' },
		coversActive: 'Aktiv', coversExpiring: 'Läuft bald ab', coversPast: 'Vergangen',
		coversExpiringNone: 'Kein Cover läuft in den nächsten 30 Tagen ab.', coversExpiringHint: 'Aktive Covers, die innerhalb von 30 Tagen ablaufen.',
		coversPastNone: 'Keine vergangenen Covers für diese Wallet gefunden.',
		coversNote: 'CoverRaccoon zeigt Covers nur an und verkauft nichts. Bei einer Position mit passendem Produkt öffnet „Cover-Details ansehen“ eine reine Quote-Anzeige.',
		coverEnded: 'Abgelaufen', coverReplaced: 'Ersetzt', coverAmount: 'Cover-Betrag', coverEnds: 'Ablauf', coverEndedOn: 'Endete', coverRemaining: 'Verbleibend',
		daysOne: '1 Tag', daysMany: '{n} Tagen', daysLeftOne: 'noch 1 Tag', daysLeftMany: 'noch {n} Tage', today: 'heute',
		agentTitle: 'CoverRaccoon Agent', agentLead: 'Frag nach deinen Positionen, Cover-Optionen und Bedingungen.',
		agentWhere: 'Der Agent antwortet in deinem privaten Telegram-Chat. Dort erinnert er dich auch vor Abläufen.',
		agentLinked: 'Telegram ist mit dieser Wallet verbunden.', agentUnlinked: 'Verbinde Telegram, um mit dem Agent zu sprechen.',
		agentOpen: 'Agent in Telegram öffnen', agentConnect: 'Telegram verbinden', agentMissing: 'Der Telegram-Link ist gerade nicht verfügbar.',
		agentExamplesTitle: 'Zum Beispiel', agentExamples: ['Wann läuft mein Aave-Cover ab?', 'Welche meiner Positionen haben kein aktives Cover?', 'Was verlangt Nexus Mutual als Proof of Loss?'],
		agentSafety: 'Der Agent liest nur. Er fragt nie nach einer Transaktion, einer Freigabe oder deiner Seed Phrase.',
		settingsTitle: 'Einstellungen', settingsWallet: 'Wallet', settingsWalletCopy: 'Mit dieser Wallet bist du angemeldet.',
		settingsTelegram: 'Telegram', settingsNotifications: 'Benachrichtigungen', settingsSecurity: 'Sicherheit',
		notifyThresholds: 'Erinnerungen', notifyWeekly: 'Wochenübersicht', notifyOn: 'aktiv', notifyOff: 'aus', notifyExpiryDay: 'Ablauftag', notifyDays: '{n} Tage vorher',
		notifyUnlinked: 'Erinnerungen gibt es, sobald Telegram verbunden ist.', notifyChange: 'Ändern kannst du sie im Telegram-Chat mit dem Agent.',
		securityCopy: 'Angemeldet bist du über eine Wallet-Signatur, nicht über eine Transaktion. CoverRaccoon fragt nie nach einer Freigabe oder deiner Seed Phrase.',
		securitySignOut: '„Abmelden“ beendet die Dashboard-Sitzung und trennt die Wallet-Verbindung in diesem Browser.'
	},
	en: {
		nav: { overview: 'Overview', positions: 'Positions', covers: 'Covers', agent: 'Agent', settings: 'Settings' },
		navLabel: 'Dashboard navigation',
		overviewLead: 'See your positions, covers and upcoming actions.',
		positionsLabel: 'Positions detected', uncoveredLabel: 'Without active cover', positionsScope: 'Aave v3 · Ethereum',
		uncoveredNote: 'Positions with no active cover attributed', expiryNoteNone: 'No active cover', loadingShort: 'reading …', unavailableShort: 'not available',
		attentionTitle: 'Needs attention', attentionNone: 'Nothing needs your attention right now.',
		attentionNoCover: { one: '1 position has no active cover for the matching Nexus product.', many: '{n} positions have no active cover for the matching Nexus product.' },
		attentionConfirm: { one: 'The cover attribution of 1 position is waiting for your confirmation.', many: 'The cover attribution of {n} positions is waiting for your confirmation.' },
		attentionExpiring: '{cover} expires in {days} ({date}).', attentionExpiringToday: '{cover} expires today ({date}).',
		attentionUnknown: 'Some position or cover information is not available right now.',
		attentionTelegram: 'Telegram expiry reminders are not connected.',
		actionPositions: 'View positions', actionCovers: 'View covers', actionSettings: 'Open settings',
		previewTitle: 'Positions', previewLink: 'View all positions', previewMore: '+ {n} more',
		askTitle: 'Ask CoverRaccoon', askPlaceholder: 'Ask about your positions, cover options or terms …', askLink: 'Go to Agent',
		activityTitle: 'Recent activity', activityNone: 'No activity in this session yet.',
		activityCovers: 'Covers read from Ethereum', activityPositions: 'Positions read (Aave v3 · Ethereum)', activityTelegram: 'Telegram reminders connected',
		activityTelegramState: 'Status',
		columns: { protocol: 'Protocol', network: 'Network', position: 'Position', exposure: 'Net value', status: 'Cover status' },
		positionsLead: 'DeFi positions detected for this wallet and whether an active cover is attributed to them.',
		positionsDetails: 'Details and cover attribution',
		positionsLoading: 'Reading positions …', positionsError: 'Positions could not be loaded right now.', positionsNone: 'No positions found.',
		supplied: 'supplied', borrowed: 'borrowed',
		status: { ATTRIBUTED: 'Cover attributed', CONFIRM: 'Attribution open', NO_ACTIVE_COVER: 'No active cover', UNAVAILABLE: 'Cover not currently available', UNKNOWN: 'Cover unknown', NOT_READ: 'Could not be read' },
		product: { yes: 'Matching Nexus product available', no: 'No matching Nexus product', unknown: 'Nexus catalogue not checkable' },
		coversActive: 'Active', coversExpiring: 'Expiring soon', coversPast: 'Past',
		coversExpiringNone: 'No cover expires within the next 30 days.', coversExpiringHint: 'Active covers that end within 30 days.',
		coversPastNone: 'No past covers found for this wallet.',
		coversNote: 'CoverRaccoon only shows covers and sells nothing. For a position with a matching product, “View cover details” opens a quote display only.',
		coverEnded: 'Expired', coverReplaced: 'Replaced', coverAmount: 'Cover amount', coverEnds: 'Expiry', coverEndedOn: 'Ended', coverRemaining: 'Remaining',
		daysOne: '1 day', daysMany: '{n} days', daysLeftOne: '1 day left', daysLeftMany: '{n} days left', today: 'today',
		agentTitle: 'CoverRaccoon Agent', agentLead: 'Ask about your positions, cover options and terms.',
		agentWhere: 'The agent answers in your private Telegram chat. That is also where it reminds you before expiries.',
		agentLinked: 'Telegram is connected to this wallet.', agentUnlinked: 'Connect Telegram to talk to the agent.',
		agentOpen: 'Open the agent in Telegram', agentConnect: 'Connect Telegram', agentMissing: 'The Telegram link is not available right now.',
		agentExamplesTitle: 'For example', agentExamples: ['When does my Aave cover expire?', 'Which of my positions have no active cover?', 'What does Nexus Mutual require as proof of loss?'],
		agentSafety: 'The agent only reads. It never asks for a transaction, an approval or your seed phrase.',
		settingsTitle: 'Settings', settingsWallet: 'Wallet', settingsWalletCopy: 'You are signed in with this wallet.',
		settingsTelegram: 'Telegram', settingsNotifications: 'Notifications', settingsSecurity: 'Security',
		notifyThresholds: 'Reminders', notifyWeekly: 'Weekly summary', notifyOn: 'on', notifyOff: 'off', notifyExpiryDay: 'expiry day', notifyDays: '{n} days before',
		notifyUnlinked: 'Reminders become available once Telegram is connected.', notifyChange: 'You can change them in the Telegram chat with the agent.',
		securityCopy: 'You are signed in with a wallet signature, not a transaction. CoverRaccoon never asks for an approval or your seed phrase.',
		securitySignOut: '“Sign out” ends the dashboard session and disconnects the wallet in this browser.'
	}
};

const textsFor = (language) => TEXTS[language] ?? TEXTS.en;
const plural = (forms, n) => (n === 1 ? forms.one : forms.many.replace('{n}', String(n)));
const isText = (value) => typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));

/** Gueltige Ansicht aus dem URL-Fragment, sonst die Uebersicht. */
export function viewFromHash(hash) {
	const name = String(hash ?? '').replace(/^#/, '');
	return DASHBOARD_VIEWS.includes(name) ? name : 'overview';
}

/** Ganze verbleibende Tage bis `iso` (0 am Ablauftag), null ohne lesbares Datum. */
export function daysLeft(iso, now = Date.now()) {
	if (typeof iso !== 'string') return null;
	const ms = Date.parse(iso) - now;
	return Number.isFinite(ms) ? Math.max(0, Math.ceil(ms / DAY_MS)) : null;
}

/*
	Cover-Status je erkannter Position. Grundlage ist allein die Zuordnung, die
	main.js schon berechnet (currentAttribution); hier wird nichts neu entschieden.
*/
export function positionStatus(position, attribution) {
	const state = position?.nexus?.state;
	if (state === 'NO_PRODUCT' || state === 'UNSUPPORTED' || state === 'PRODUCT_DEPRECATED') return 'UNAVAILABLE';
	if (state !== 'MATCHED') return 'UNKNOWN';
	const entry = attribution?.byPosition?.get?.(position.deploymentKey);
	if (!entry) return 'UNKNOWN';
	if (entry.state === 'AUTO_UNAMBIGUOUS' || entry.state === 'USER_CONFIRMED') return 'ATTRIBUTED';
	if (entry.state === 'USER_CONFIRMATION_REQUIRED') return 'CONFIRM';
	if (entry.state === 'NO_ACTIVE_COVER') return 'NO_ACTIVE_COVER';
	return 'UNKNOWN';
}

function productSupport(position) {
	const state = position?.nexus?.state;
	if (state === 'MATCHED') return 'yes';
	if (state === 'NO_PRODUCT' || state === 'UNSUPPORTED' || state === 'PRODUCT_DEPRECATED') return 'no';
	return 'unknown';
}

const symbols = (assets) => (Array.isArray(assets) ? assets.map((asset) => asset?.symbol).filter(isText).map(String) : []);

/** Die Zeilen der Positionstabelle: erkannte Positionen, danach nicht lesbare Maerkte. */
export function positionRows(positionsState, attribution) {
	if (positionsState?.status !== 'ok' || !positionsState.data) return [];
	const { positions = [], checkedDeployments = [] } = positionsState.data;
	const rows = (Array.isArray(positions) ? positions : []).map((position) => ({
		protocol: 'Aave v3', network: 'Ethereum',
		market: isText(position?.label) ? String(position.label) : '—',
		supplied: symbols(position?.supplied), borrowed: symbols(position?.borrowed),
		netUsd: position?.totals?.netUsd,
		status: positionStatus(position, attribution),
		product: productSupport(position)
	}));
	for (const market of Array.isArray(checkedDeployments) ? checkedDeployments : []) {
		if (market?.status === 'OK') continue;
		rows.push({ protocol: 'Aave v3', network: 'Ethereum', market: isText(market?.label) ? String(market.label) : '—', supplied: [], borrowed: [], netUsd: null, status: 'NOT_READ', product: 'unknown' });
	}
	return rows;
}

const coverList = (data) => (Array.isArray(data?.covers) ? data.covers.filter((cover) => cover && typeof cover === 'object') : []);

/** Aktive Covers, die innerhalb von EXPIRING_SOON_DAYS enden, frueheste zuerst. */
export function expiringCovers(data, now = Date.now()) {
	return coverList(data)
		.filter((cover) => cover.status === 'active')
		.map((cover) => ({ cover, days: daysLeft(cover.endsAt, now) }))
		.filter((entry) => entry.days !== null && entry.days <= EXPIRING_SOON_DAYS)
		.sort((a, b) => Date.parse(a.cover.endsAt) - Date.parse(b.cover.endsAt));
}

/** Abgelaufene oder ersetzte Covers, zuletzt beendete zuerst. */
export function pastCovers(data) {
	return coverList(data)
		.filter((cover) => cover.status === 'expired' || cover.status === 'superseded')
		.sort((a, b) => (Date.parse(b.endsAt) || 0) - (Date.parse(a.endsAt) || 0));
}

/** Kennzahlen und Hinweise der Uebersicht, rein aus den uebergebenen Daten. */
export function summarize({ data, positionsState, attribution, now = Date.now() }) {
	const rows = positionRows(positionsState, attribution);
	const detected = rows.filter((row) => row.status !== 'NOT_READ');
	const count = (status) => detected.filter((row) => row.status === status).length;
	const positionsOk = positionsState?.status === 'ok';
	const attention = [];
	const noCover = count('NO_ACTIVE_COVER');
	if (noCover) attention.push({ kind: 'NO_ACTIVE_COVER', count: noCover, view: 'positions' });
	const confirm = count('CONFIRM');
	if (confirm) attention.push({ kind: 'CONFIRM', count: confirm, view: 'positions' });
	for (const { cover, days } of expiringCovers(data, now)) attention.push({ kind: 'EXPIRING', cover, days, view: 'covers' });
	const unknown = positionsState?.status === 'error' || rows.some((row) => row.status === 'NOT_READ' || row.status === 'UNKNOWN');
	if (unknown) attention.push({ kind: 'UNKNOWN', view: 'positions' });
	if (data && data.telegramLinked !== true) attention.push({ kind: 'TELEGRAM', view: 'settings' });
	return {
		rows,
		positionsDetected: positionsOk ? detected.length : null,
		withoutActiveCover: positionsOk ? noCover + count('UNAVAILABLE') : null,
		attention,
		positionsStatus: positionsState?.status ?? 'idle'
	};
}

/* ------------------------------------------------------------ Darstellung -- */

function formatUsd(value, language) {
	const number = Number(value);
	return value !== null && value !== undefined && value !== '' && Number.isFinite(number)
		? new Intl.NumberFormat(language === 'de' ? 'de-AT' : 'en-GB', { style: 'currency', currency: 'USD' }).format(number) : '—';
}
function formatAmount(value, language) {
	const number = Number(value);
	return isText(value) && Number.isFinite(number) ? number.toLocaleString(language === 'de' ? 'de-DE' : 'en-GB', { maximumFractionDigits: 6 }) : '—';
}
function formatDate(iso, language) {
	const time = typeof iso === 'string' ? Date.parse(iso) : NaN;
	return Number.isFinite(time) ? new Intl.DateTimeFormat(language === 'de' ? 'de-AT' : 'en-GB', { dateStyle: 'medium' }).format(new Date(time)) : '—';
}
function formatTime(iso, language) {
	const time = typeof iso === 'string' ? Date.parse(iso) : NaN;
	return Number.isFinite(time) ? new Intl.DateTimeFormat(language === 'de' ? 'de-AT' : 'en-GB', { hour: '2-digit', minute: '2-digit' }).format(new Date(time)) : '';
}
const coverName = (cover) => {
	const name = isText(cover?.productName) ? String(cover.productName) : 'Nexus';
	return Number.isSafeInteger(cover?.coverId) ? `${name} · Cover #${cover.coverId}` : name;
};
const coverAmount = (cover, language) => `${formatAmount(cover?.amount, language)} ${isText(cover?.asset?.symbol) ? cover.asset.symbol : ''}`.trim();

function make(doc, parent, tag, className = '', text = null) {
	const node = doc.createElement(tag);
	if (className) node.className = className;
	if (text !== null) node.textContent = String(text);
	parent.appendChild(node);
	return node;
}
function setText(doc, selector, value) {
	const node = doc.querySelector(selector);
	if (node) node.textContent = String(value);
}
/* Status nie nur als Farbe: jedes Abzeichen traegt seinen Text und ein eigenes Zeichen. */
const STATUS_MARK = { ATTRIBUTED: '●', CONFIRM: '◐', NO_ACTIVE_COVER: '○', UNAVAILABLE: '–', UNKNOWN: '?', NOT_READ: '!' };
function badge(doc, parent, status, t) {
	const node = make(doc, parent, 'span', `status-badge status-${status.toLowerCase().replaceAll('_', '-')}`);
	make(doc, node, 'span', 'status-mark', STATUS_MARK[status] ?? '·').setAttribute('aria-hidden', 'true');
	make(doc, node, 'span', '', t.status[status] ?? status);
	return node;
}
/*
	Wechsel zu einer anderen Ansicht als Knopf, nicht als neu gebaute Adresse:
	gesetzt wird nur das Fragment, und nur ein festes aus DASHBOARD_VIEWS.
	Die Links der Seitenleiste stehen fest in web/index.html.
*/
let navigate = (view) => view;
function viewButton(doc, parent, view, label, className) {
	const button = make(doc, parent, 'button', className, label);
	button.type = 'button';
	button.addEventListener('click', () => navigate(view));
	return button;
}
function empty(doc, parent, text) { return make(doc, parent, 'p', 'dash-empty compact', text); }

function positionText(row, t) {
	const parts = [];
	if (row.supplied.length) parts.push(`${row.supplied.join(', ')} ${t.supplied}`);
	if (row.borrowed.length) parts.push(`${row.borrowed.join(', ')} ${t.borrowed}`);
	return parts.join(' · ');
}

function renderTable(doc, container, rows, t, language, { limit = Infinity } = {}) {
	container.replaceChildren();
	const table = make(doc, container, 'div', 'pos-table');
	table.setAttribute('role', 'table');
	table.setAttribute('aria-label', t.previewTitle);
	const head = make(doc, table, 'div', 'pos-row pos-head');
	head.setAttribute('role', 'row');
	for (const key of ['protocol', 'network', 'position', 'exposure', 'status']) make(doc, head, 'span', `pos-cell pos-${key}`, t.columns[key]).setAttribute('role', 'columnheader');
	for (const row of rows.slice(0, limit)) {
		const line = make(doc, table, 'div', `pos-row${row.status === 'NOT_READ' ? ' pos-unread' : ''}`);
		line.setAttribute('role', 'row');
		const cell = (key, label) => { const node = make(doc, line, 'div', `pos-cell pos-${key}`); node.setAttribute('role', 'cell'); make(doc, node, 'span', 'pos-label', label).setAttribute('aria-hidden', 'true'); return node; };
		make(doc, cell('protocol', t.columns.protocol), 'strong', 'pos-value', row.protocol);
		make(doc, cell('network', t.columns.network), 'span', 'pos-value', row.network);
		const position = cell('position', t.columns.position);
		make(doc, position, 'span', 'pos-value', row.market);
		const detail = positionText(row, t);
		if (detail) make(doc, position, 'small', 'pos-sub', detail);
		make(doc, cell('exposure', t.columns.exposure), 'span', 'pos-value pos-number', row.status === 'NOT_READ' ? '—' : formatUsd(row.netUsd, language));
		const status = cell('status', t.columns.status);
		badge(doc, status, row.status, t);
		if (row.status !== 'NOT_READ') make(doc, status, 'small', 'pos-sub', t.product[row.product]);
	}
	if (rows.length > limit) make(doc, container, 'p', 'pos-more', t.previewMore.replace('{n}', String(rows.length - limit)));
}

function positionsPlaceholder(doc, container, status, t) {
	container.replaceChildren();
	if (status === 'error') empty(doc, container, t.positionsError);
	else if (status === 'ok') empty(doc, container, t.positionsNone);
	else empty(doc, container, t.positionsLoading);
}

function renderAttention(doc, container, items, t, language) {
	container.replaceChildren();
	if (!items.length) {
		const ok = make(doc, container, 'div', 'attention-item attention-clear');
		make(doc, ok, 'span', 'attention-mark', '✓').setAttribute('aria-hidden', 'true');
		make(doc, ok, 'p', 'attention-text', t.attentionNone);
		return;
	}
	for (const item of items) {
		const row = make(doc, container, 'div', `attention-item attention-${item.kind.toLowerCase().replaceAll('_', '-')}`);
		make(doc, row, 'span', 'attention-mark', item.kind === 'EXPIRING' ? '◷' : item.kind === 'TELEGRAM' ? '➤' : '!').setAttribute('aria-hidden', 'true');
		let text;
		let action;
		if (item.kind === 'NO_ACTIVE_COVER') { text = plural(t.attentionNoCover, item.count); action = t.actionPositions; }
		else if (item.kind === 'CONFIRM') { text = plural(t.attentionConfirm, item.count); action = t.actionPositions; }
		else if (item.kind === 'EXPIRING') {
			const days = item.days === 1 ? t.daysOne : t.daysMany.replace('{n}', String(item.days));
			text = (item.days === 0 ? t.attentionExpiringToday : t.attentionExpiring).replace('{cover}', coverName(item.cover)).replace('{days}', days).replace('{date}', formatDate(item.cover.endsAt, language));
			action = t.actionCovers;
		} else if (item.kind === 'UNKNOWN') { text = t.attentionUnknown; action = t.actionPositions; }
		else { text = t.attentionTelegram; action = t.actionSettings; }
		make(doc, row, 'p', 'attention-text', text);
		viewButton(doc, row, item.view, action, 'attention-action');
	}
}

function renderActivity(doc, container, { data, positionsState }, t, language) {
	container.replaceChildren();
	const entries = [];
	if (data?.checkedAt) entries.push([t.activityCovers, formatTime(data.checkedAt, language)]);
	if (positionsState?.status === 'ok') entries.push([t.activityPositions, formatTime(positionsState.data?.fetchedAt, language)]);
	if (data?.telegramLinked === true) entries.push([t.activityTelegram, t.activityTelegramState]);
	if (!entries.length) { empty(doc, container, t.activityNone); return; }
	for (const [label, when] of entries) {
		const row = make(doc, container, 'div', 'activity-item');
		make(doc, row, 'span', 'activity-dot').setAttribute('aria-hidden', 'true');
		make(doc, row, 'span', 'activity-text', label);
		if (when) make(doc, row, 'small', 'activity-time', when);
	}
}

function coverRow(doc, parent, cover, t, language, { past = false, days = null } = {}) {
	const card = make(doc, parent, 'article', `cover-line${past ? ' cover-past' : ''}`);
	const name = make(doc, card, 'div', 'cover-line-name');
	make(doc, name, 'strong', '', coverName(cover));
	if (past) make(doc, name, 'span', 'status-badge status-past', cover.status === 'superseded' ? t.coverReplaced : t.coverEnded);
	const facts = make(doc, card, 'div', 'cover-line-facts');
	const fact = (label, value) => { const node = make(doc, facts, 'div', 'cover-fact'); make(doc, node, 'small', '', label); make(doc, node, 'span', '', value); };
	fact(t.coverAmount, coverAmount(cover, language) || '—');
	fact(past ? t.coverEndedOn : t.coverEnds, formatDate(cover.endsAt, language));
	if (!past && days !== null) fact(t.coverRemaining, days === 0 ? t.today : days === 1 ? t.daysLeftOne : t.daysLeftMany.replace('{n}', String(days)));
	return card;
}

function renderCovers(doc, data, t, language, now) {
	const expiring = doc.querySelector('#covers-expiring');
	if (expiring) {
		expiring.replaceChildren();
		const list = expiringCovers(data, now);
		if (!list.length) empty(doc, expiring, t.coversExpiringNone);
		for (const { cover, days } of list) coverRow(doc, expiring, cover, t, language, { days });
	}
	const past = doc.querySelector('#covers-past');
	if (past) {
		past.replaceChildren();
		const list = pastCovers(data);
		if (!list.length) empty(doc, past, t.coversPastNone);
		for (const cover of list) coverRow(doc, past, cover, t, language, { past: true });
	}
}

function renderAgent(doc, data, t) {
	setText(doc, '#agent-title', t.agentTitle);
	setText(doc, '#agent-lead', t.agentLead);
	setText(doc, '#agent-where', t.agentWhere);
	setText(doc, '#agent-examples-title', t.agentExamplesTitle);
	t.agentExamples.forEach((example, index) => setText(doc, `#agent-example-${index + 1}`, example));
	setText(doc, '#agent-safety', t.agentSafety);
	const linked = data?.telegramLinked === true;
	setText(doc, '#agent-state', linked ? t.agentLinked : t.agentUnlinked);
	const state = doc.querySelector('#agent-state');
	state?.classList.toggle('connected', linked);
	// Die Adresse setzt main.js mit demselben Ausdruck wie beim Telegram-Knopf (renderDashboard); hier nur der Text.
	const action = doc.querySelector('#agent-action');
	if (action) action.textContent = linked ? t.agentOpen : t.agentConnect;
	setText(doc, '#agent-missing', action && !action.hidden ? '' : t.agentMissing);
}

function renderNotifications(doc, data, t) {
	const box = doc.querySelector('#notify-details');
	if (!box) return;
	box.replaceChildren();
	const settings = data?.agentSettings;
	if (data?.telegramLinked !== true || !settings) { make(doc, box, 'p', 'settings-copy', t.notifyUnlinked); return; }
	const days = (Array.isArray(settings.alertThresholds) ? settings.alertThresholds : []).filter((day) => Number.isSafeInteger(day) && day >= 0).sort((a, b) => b - a);
	const row = (label, value) => { const node = make(doc, box, 'div', 'settings-row'); make(doc, node, 'span', 'settings-label', label); make(doc, node, 'strong', 'settings-value', value); };
	row(t.notifyThresholds, days.length ? days.map((day) => (day === 0 ? t.notifyExpiryDay : t.notifyDays.replace('{n}', String(day)))).join(', ') : '—');
	row(t.notifyWeekly, settings.weeklySummary === true ? t.notifyOn : t.notifyOff);
	make(doc, box, 'p', 'settings-copy', t.notifyChange);
}

/** Ansicht umschalten: genau eine sichtbar, die Navigation markiert sie. */
export function showView(doc, view, { focus = false } = {}) {
	const name = DASHBOARD_VIEWS.includes(view) ? view : 'overview';
	for (const key of DASHBOARD_VIEWS) {
		const section = doc.querySelector(`#view-${key}`);
		if (section) section.hidden = key !== name;
	}
	for (const link of doc.querySelectorAll('[data-view-link]')) {
		if (link.dataset?.viewLink === name) link.setAttribute('aria-current', 'page');
		else link.removeAttribute('aria-current');
	}
	if (focus) doc.querySelector(`#view-${name} [data-view-heading]`)?.focus?.();
	return name;
}

/** Navigation ueber das URL-Fragment (#positions ...): Zurueck-Taste und Lesezeichen funktionieren. */
export function mountDashboardNav(doc, win) {
	const current = () => viewFromHash(win?.location?.hash);
	showView(doc, current());
	navigate = (view) => {
		const name = DASHBOARD_VIEWS.includes(view) ? view : 'overview';
		if (win?.location && viewFromHash(win.location.hash) !== name) win.location.hash = name;
		else showView(doc, name, { focus: true });
		return name;
	};
	win?.addEventListener?.('hashchange', () => {
		showView(doc, current(), { focus: true });
		win.scrollTo?.(0, 0);
	});
}

/** Alles, was die Schale zeigt, aus dem aktuellen Seitenzustand. */
export function renderDashboardShell(doc, { language, data, positionsState, attribution, now = Date.now() }) {
	const t = textsFor(language);
	for (const key of DASHBOARD_VIEWS) setText(doc, `#nav-${key}`, t.nav[key]);
	doc.querySelector('#dash-nav')?.setAttribute('aria-label', t.navLabel);
	setText(doc, '#overview-lead', t.overviewLead);
	setText(doc, '#label-positions', t.positionsLabel);
	setText(doc, '#label-uncovered', t.uncoveredLabel);
	setText(doc, '#attention-title', t.attentionTitle);
	setText(doc, '#preview-title', t.previewTitle);
	setText(doc, '#preview-link', t.previewLink);
	setText(doc, '#ask-title', t.askTitle);
	setText(doc, '#ask-placeholder', t.askPlaceholder);
	setText(doc, '#ask-link', t.askLink);
	setText(doc, '#activity-title', t.activityTitle);
	setText(doc, '#positions-lead', t.positionsLead);
	setText(doc, '#positions-details-title', t.positionsDetails);
	setText(doc, '#covers-active-title', t.coversActive);
	setText(doc, '#covers-expiring-title', t.coversExpiring);
	setText(doc, '#covers-expiring-hint', t.coversExpiringHint);
	setText(doc, '#covers-past-title', t.coversPast);
	setText(doc, '#covers-note', t.coversNote);
	setText(doc, '#settings-title', t.settingsTitle);
	setText(doc, '#settings-wallet-title', t.settingsWallet);
	setText(doc, '#settings-wallet-copy', t.settingsWalletCopy);
	setText(doc, '#settings-telegram-title', t.settingsTelegram);
	setText(doc, '#settings-notifications-title', t.settingsNotifications);
	setText(doc, '#settings-security-title', t.settingsSecurity);
	setText(doc, '#security-copy', t.securityCopy);
	setText(doc, '#security-signout', t.securitySignOut);

	const summary = summarize({ data, positionsState, attribution, now });
	const pending = summary.positionsStatus === 'loading' || summary.positionsStatus === 'idle';
	setText(doc, '#metric-positions', summary.positionsDetected ?? '—');
	setText(doc, '#metric-positions-note', pending ? t.loadingShort : summary.positionsDetected === null ? t.unavailableShort : t.positionsScope);
	setText(doc, '#metric-uncovered', summary.withoutActiveCover ?? '—');
	setText(doc, '#metric-uncovered-note', pending ? t.loadingShort : summary.withoutActiveCover === null ? t.unavailableShort : t.uncoveredNote);
	const next = coverList(data).filter((cover) => cover.status === 'active' && Number.isFinite(Date.parse(cover.endsAt))).sort((a, b) => Date.parse(a.endsAt) - Date.parse(b.endsAt))[0];
	setText(doc, '#metric-expiry-note', next ? formatDate(next.endsAt, language) : t.expiryNoteNone);

	const attentionList = doc.querySelector('#attention-list');
	if (attentionList) renderAttention(doc, attentionList, summary.attention, t, language);
	const preview = doc.querySelector('#positions-preview');
	const table = doc.querySelector('#positions-table');
	for (const [container, limit] of [[preview, 3], [table, Infinity]]) {
		if (!container) continue;
		if (summary.rows.length) renderTable(doc, container, summary.rows, t, language, { limit });
		else positionsPlaceholder(doc, container, summary.positionsStatus, t);
	}
	const activity = doc.querySelector('#activity-list');
	if (activity) renderActivity(doc, activity, { data, positionsState }, t, language);
	renderCovers(doc, data, t, language, now);
	renderAgent(doc, data, t);
	renderNotifications(doc, data, t);
	return summary;
}
