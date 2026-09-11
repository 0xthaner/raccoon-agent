const status = document.querySelector('#status');
const wcButton = document.querySelector('#walletconnect');
const injectedButton = document.querySelector('#injected');
const searchParams = new URLSearchParams(location.search);
const code = searchParams.get('code');
const access = searchParams.get('access');
const walletDebug = searchParams.get('debug') === 'wallet';
const translations = {
	de: {
		online: ['Private Cover-Überwachung · ', 'online'], kicker: 'Unabhängige DeFi-Cover-Überwachung', title: ['Schutz, ', 'immer im Blick.'], lead: 'Öffne dein persönliches Dashboard und aktiviere auf Wunsch Telegram-Erinnerungen.', walletUntouched: 'Wallet bleibt unberührt', signature: 'Nur eine Signatur', alerts: 'Hinweise über Telegram', step: '01 · Identität', connectTitle: 'Wallet verbinden', connectCopy: 'Eine Signatur bestätigt die Wallet und öffnet dein persönliches Dashboard.', connect: 'Mit Wallet verbinden', injected: 'Browser-Wallet verwenden', security: 'Keine Transaktion, keine Freigabe und keine Gasgebühr.', dashKicker: 'Persönliches Dashboard', dashTitle: ['Dein Cover,', 'immer im Blick.'], switchWallet: 'Wallet wechseln', logout: 'Abmelden', activeLabel: 'Aktive Covers', expiryLabel: 'Nächster Ablauf', telegramLabel: 'Telegram-Überwachung', telegramTitle: 'Telegram-Benachrichtigungen', protection: 'Dein Schutz', footer: 'Unterstützt durch Coverraccoon Intelligence', footerExplainer: 'Bündelt Cover-Daten für Überwachung, Ablauf und Verlängerung.', active: 'aktiv', noCover: 'Kein aktives Cover', days: 'Tage', telegramActive: 'Aktiv', notConnected: 'Nicht verbunden', tgConnected: '● Telegram verbunden', tgDisconnected: 'Telegram nicht verbunden', tgOnCopy: 'Ablauf- und Verlängerungshinweise sind aktiv. Öffne Telegram, um mit deinem Agenten zu sprechen.', tgOffCopy: 'Erhalte Ablauf- und Verlängerungshinweise, ohne laufend das Dashboard prüfen zu müssen.', openTelegram: 'Telegram öffnen', connectTelegram: 'Telegram aktivieren', updated: 'Aktualisiert', empty: 'Für diese Wallet wurde kein aktives Nexus-Mutual-Cover gefunden.', product: 'Produkt', protectionAmount: 'Schutz', expiry: 'Ablauf', status: 'Status', review: 'Verlängerung ansehen', moreCover: 'Weiteres Cover entdecken', getCover: 'Cover abschließen', renewalTitle: 'Nächste Verlängerung', renewalAction: 'Verlängerung prüfen', renewalCopy: (name, days) => `${name} läuft in ${days} Tagen aus. Angebot und Owner-Wallet werden vor der Bestätigung nochmals geprüft.`, linkTitle: 'Telegram mit deiner Wallet verbinden', linkCopy: 'Einmal signieren, um Erinnerungen für diese Wallet zu aktivieren.', linkStep: '01 · Telegram einrichten', linkSecurity: 'Eine Signatur. Keine Transaktion, Gasgebühr oder Tokenfreigabe. Der Link ist zehn Minuten gültig.', success: 'Alles eingerichtet.', successCopy: 'Deine Telegram-Erinnerungen sind aktiv. Du kannst jetzt zum Raccoon Agent zurückkehren.', backTelegram: 'Zurück zum Raccoon Agent', openDashboard: 'Dashboard öffnen', disconnectTelegram: 'Telegram trennen', confirmDisconnect: 'Telegram-Benachrichtigungen für diese Wallet wirklich trennen?'
	},
	en: {
		online: ['Private cover monitoring · ', 'online'], kicker: 'Independent DeFi cover monitor', title: ['Protection, ', 'kept in sight.'], lead: 'Open your personal dashboard and optionally activate Telegram reminders.', walletUntouched: 'Wallet stays untouched', signature: 'Signature only', alerts: 'Alerts via Telegram', step: '01 · Identity', connectTitle: 'Connect your wallet', connectCopy: 'A signature confirms the wallet and opens your personal dashboard.', connect: 'Connect wallet', injected: 'Use browser wallet', security: 'No transaction, approval or gas fee.', dashKicker: 'Personal dashboard', dashTitle: ['Your cover,', 'under watch.'], switchWallet: 'Switch wallet', logout: 'Sign out', activeLabel: 'Active covers', expiryLabel: 'Next expiry', telegramLabel: 'Telegram monitoring', telegramTitle: 'Telegram notifications', protection: 'Your protection', footer: 'Powered by Coverraccoon intelligence', footerExplainer: 'Brings cover data together for monitoring, expiry and renewal.', active: 'active', noCover: 'No active cover', days: 'days', telegramActive: 'Active', notConnected: 'Not connected', tgConnected: '● Telegram connected', tgDisconnected: 'Telegram not connected', tgOnCopy: 'Expiry and renewal notices are active. Open Telegram to talk to your agent.', tgOffCopy: 'Get expiry and renewal notices without having to check the dashboard.', openTelegram: 'Open Telegram', connectTelegram: 'Connect Telegram', updated: 'Updated', empty: 'No active Nexus Mutual cover was found for this wallet.', product: 'Product', protectionAmount: 'Protection', expiry: 'Expiry', status: 'Status', review: 'Review renewal', moreCover: 'Explore more cover', getCover: 'Get cover', renewalTitle: 'Next renewal', renewalAction: 'Review renewal', renewalCopy: (name, days) => `${name} expires in ${days} days. The offer and owner wallet are checked again before confirmation.`, linkTitle: 'Connect Telegram to your wallet', linkCopy: 'Sign once to activate reminders for this wallet.', linkStep: '01 · Telegram setup', linkSecurity: 'One signature. No transaction, gas fee or token approval. The link is valid for ten minutes.', success: 'Everything is set up.', successCopy: 'Your Telegram reminders are active. You can now return to Raccoon Agent.', backTelegram: 'Return to Raccoon Agent', openDashboard: 'Open dashboard', disconnectTelegram: 'Disconnect Telegram', confirmDisconnect: 'Disconnect Telegram notifications for this wallet?'
	}
};
let language = localStorage.getItem('raccoon_language') || (navigator.language?.toLowerCase().startsWith('de') ? 'de' : 'en');
let t = translations[language] || translations.en;
if (code) document.body.classList.add('link-mode');
const show = (message) => { status.textContent = message; };
const disable = () => { wcButton.disabled = true; injectedButton.disabled = true; };
const TELEGRAM_NAME = /^[A-Za-z0-9_]{5,32}$/;
let config = {};
const configPromise = fetch('/api/config')
	.then((res) => {
		if (!res.ok) throw new Error('App-Konfiguration konnte nicht geladen werden.');
		return res.json();
	})
	.then((value) => (config = value));

function applyLanguage(next) {
	language = translations[next] ? next : 'en'; t = translations[language];
	localStorage.setItem('raccoon_language', language); document.documentElement.lang = language;
	document.querySelectorAll('[data-language]').forEach((button) => button.classList.toggle('active', button.dataset.language === language));
	/*
		AGENT-SEC-F1: hier stand ein Helfer, der eine Zeichenkette per innerHTML in
		ein Element geschrieben hat. Er wurde nur mit festen Uebersetzungen
		gefuettert, sass aber Zeile an Zeile neben Werten aus /api/* - und wer
		spaeter einen davon durchreicht, baut sich unbemerkt eine XSS-Luecke.

		Ersatz: das Markup steht fest in index.html, jedes Textstueck traegt dort
		ein `data-teil`. Uebersetzt werden nur die Textknoten, ueber textContent.
		Es gibt keinen Weg mehr, ueber diese Funktion Markup einzuschleusen.
	*/
	const teile = (selector, values) => {
		const wurzel = document.querySelector(selector);
		if (!wurzel) return;
		values.forEach((value, index) => {
			const ziel = wurzel.querySelector(`[data-teil="${index}"]`);
			if (ziel) ziel.textContent = value;
		});
	};
	const text = (selector, value) => { document.querySelector(selector).textContent = value; };
	teile('#online-tag', t.online); text('#intro-kicker', t.kicker); teile('#intro-title', t.title); text('#intro-lead', t.lead);
	text('#guide-link', language === 'de' ? 'Anleitung' : 'Guide');
	text('#footer-guide-link', language === 'de' ? 'Anleitung' : 'Guide');
	text('#principle-wallet', t.walletUntouched); text('#principle-signature', t.signature); text('#principle-alerts', t.alerts);
	text('.step', code ? t.linkStep : t.step); text('.panel h2', code ? t.linkTitle : t.connectTitle); text('.panel-copy', code ? t.linkCopy : t.connectCopy);
	text('#walletconnect', t.connect); text('#injected', t.injected); text('.security span', code ? t.linkSecurity : t.security);
	text('#dash-kicker', t.dashKicker); teile('#dash-title', t.dashTitle); text('#switch-wallet', t.switchWallet); text('#logout', t.logout);
	text('#label-active', t.activeLabel); text('#label-expiry', t.expiryLabel); text('#label-telegram', t.telegramLabel); text('#telegram-title', t.telegramTitle); text('#protection-title', t.protection); text('#footer-copy', t.footer); text('#footer-explainer', t.footerExplainer);
}
document.querySelectorAll('[data-language]').forEach((button) => button.addEventListener('click', () => { applyLanguage(button.dataset.language); if (window.dashboardData) renderDashboard(window.dashboardData); }));
applyLanguage(language);

let debugOutput;
function debugWallet(label, value) {
	if (!walletDebug) return;
	if (!debugOutput) {
		debugOutput = document.createElement('pre');
		debugOutput.style.cssText = 'margin-top:14px;padding:12px;max-height:220px;overflow:auto;white-space:pre-wrap;border:1px solid rgba(255,255,255,.12);border-radius:9px;color:#a2a5a2;font:11px/1.5 ui-monospace,monospace';
		status.after(debugOutput);
	}
	const safe = value instanceof Error ? value.message : value && typeof value === 'object'
		? JSON.stringify(value, (key, item) => /^(uri|wcUri|topic|signature|token|symKey)$/i.test(key) ? '[hidden]' : item)
		: String(value ?? '');
	debugOutput.textContent += `${new Date().toLocaleTimeString()} ${label}${safe ? `: ${safe}` : ''}\n`;
}
if (walletDebug) {
	window.addEventListener('error', (event) => debugWallet('window error', event.error ?? event.message));
	window.addEventListener('unhandledrejection', (event) => debugWallet('unhandled rejection', event.reason));
}

function daysUntil(iso) { return Math.max(0, Math.ceil((Date.parse(iso) - Date.now()) / 86_400_000)); }
function shortWallet(wallet) { return `${wallet.slice(0, 6)}…${wallet.slice(-4)}`; }
function formatDate(iso) { return iso ? new Intl.DateTimeFormat(language === 'de' ? 'de-AT' : 'en-GB', { dateStyle: 'medium' }).format(new Date(iso)) : '—'; }
function safeHttpsUrl(value) {
	try {
		const url = new URL(value, location.origin);
		return ['https:', ...(location.hostname === 'localhost' ? ['http:'] : [])].includes(url.protocol) ? url.href : null;
	} catch { return null; }
}
function addTextElement(parent, tag, value, className = '') {
	const element = document.createElement(tag);
	if (className) element.className = className;
	element.textContent = String(value ?? '');
	parent.appendChild(element);
	return element;
}

function renderDashboard(data) {
	window.dashboardData = data;
	document.body.classList.add('dashboard-mode');
	document.querySelector('#dash-wallet').textContent = shortWallet(data.wallet);
	const active = data.covers.filter((cover) => cover.status === 'active');
	const next = active.filter((cover) => cover.endsAt).sort((a, b) => Date.parse(a.endsAt) - Date.parse(b.endsAt))[0];
	document.querySelector('#metric-active').textContent = active.length ? `${active.length} ${t.active}` : t.noCover;
	document.querySelector('#metric-expiry').textContent = next ? `${daysUntil(next.endsAt)} ${t.days}` : '—';
	document.querySelector('#metric-telegram').textContent = data.telegramLinked ? t.telegramActive : t.notConnected;
	const renewable = active.filter((cover) => cover.endsAt && cover.renewalUrl).sort((a, b) => Date.parse(a.endsAt) - Date.parse(b.endsAt))[0];
	const renewalCard = document.querySelector('#renewal-card');
	renewalCard.hidden = !renewable;
	if (renewable) {
		document.querySelector('#renewal-title').textContent = t.renewalTitle;
		document.querySelector('#renewal-copy').textContent = t.renewalCopy(renewable.productName ?? `Cover #${renewable.coverId}`, daysUntil(renewable.endsAt));
		const renewalAction = document.querySelector('#renewal-action');
		const renewalHref = safeHttpsUrl(renewable.renewalUrl);
		renewalAction.textContent = t.renewalAction;
		renewalAction.hidden = !renewalHref;
		if (renewalHref) renewalAction.href = renewalHref;
	}
	const telegramState = document.querySelector('#telegram-state');
	const telegramCopy = document.querySelector('#telegram-copy');
	const telegramAction = document.querySelector('#telegram-action');
	telegramState.textContent = data.telegramLinked ? t.tgConnected : t.tgDisconnected;
	telegramState.classList.toggle('connected', data.telegramLinked);
	telegramCopy.textContent = data.telegramLinked
		? t.tgOnCopy : t.tgOffCopy;
	if (data.telegramLinked && data.agentSettings) {
		const thresholds = (data.agentSettings.alertThresholds ?? []).map((day) => day === 0 ? (language === 'de' ? 'Ablauftag' : 'expiry day') : `${day} ${t.days}`).join(', ');
		telegramCopy.textContent += ` ${language === 'de' ? 'Erinnerungen' : 'Reminders'}: ${thresholds || '—'}${data.agentSettings.weeklySummary ? ` · ${language === 'de' ? 'Wochenübersicht aktiv' : 'weekly summary active'}` : ''}.`;
	}
	if (config.telegramUsername) {
		telegramAction.hidden = false;
		telegramAction.href = data.telegramLinked
			? `https://t.me/${config.telegramUsername}`
			: `https://t.me/${config.telegramUsername}?start=connect_${data.telegramStartCode}`;
		telegramAction.target = '_blank';
		telegramAction.rel = 'noopener';
		telegramAction.textContent = data.telegramLinked ? t.openTelegram : t.connectTelegram;
		telegramAction.classList.toggle('primary', !data.telegramLinked);
	} else {
		telegramAction.hidden = true;
	}
	document.querySelector('#checked-at').textContent = `${t.updated} ${new Intl.DateTimeFormat(language === 'de' ? 'de-AT' : 'en-GB', { hour: '2-digit', minute: '2-digit' }).format(new Date(data.checkedAt))}`;
	const list = document.querySelector('#cover-list');
	list.replaceChildren();
	if (!active.length) addTextElement(list, 'div', t.empty, 'dash-empty');
	for (const cover of active) {
		const card = document.createElement('article'); card.className = 'cover-card';
		const name = document.createElement('div'); name.className = 'cover-name';
		addTextElement(name, 'small', t.product);
		addTextElement(name, 'strong', cover.productName ?? `Nexus product #${cover.productId}`);
		const coverId = addTextElement(name, 'small', `Cover #${cover.coverId}`); coverId.style.marginTop = '8px';
		card.appendChild(name);
		const amount = document.createElement('div'); addTextElement(amount, 'small', t.protectionAmount);
		const numericAmount = Number(cover.amount);
		addTextElement(amount, 'strong', `${Number.isFinite(numericAmount) ? numericAmount.toLocaleString(language === 'de' ? 'de-AT' : 'en-GB') : '—'} ${cover.asset?.symbol ?? ''}`.trim()); card.appendChild(amount);
		const expiry = document.createElement('div'); addTextElement(expiry, 'small', t.expiry); addTextElement(expiry, 'strong', formatDate(cover.endsAt)); card.appendChild(expiry);
		const state = document.createElement('div'); addTextElement(state, 'small', t.status); addTextElement(state, 'strong', `● ${t.active}`, 'active-state'); card.appendChild(state);
		const renewalHref = cover.renewalUrl && safeHttpsUrl(cover.renewalUrl);
		if (renewalHref) { const link = addTextElement(card, 'a', t.review, 'cover-action'); link.href = renewalHref; }
		else card.appendChild(document.createElement('span'));
		list.appendChild(card);
	}
	const actions = document.querySelector('#dash-actions'); actions.replaceChildren();
	const coverLink = document.createElement('a'); coverLink.href = 'https://coverraccoon.com/cover/buy'; coverLink.className = 'primary'; coverLink.textContent = active.length ? t.moreCover : t.getCover; actions.appendChild(coverLink);
	if (data.telegramLinked) { const unlink = document.createElement('button'); unlink.className = 'text-action'; unlink.textContent = t.disconnectTelegram; unlink.addEventListener('click', disconnectTelegram); actions.appendChild(unlink); }
}

/**
 * AGENT-SEC-A2: die vom Zugangslink erwartete Wallet.
 *
 * Die Sicherheitsgrenze liegt auf dem Server: ohne gueltige Signatur DIESER
 * Wallet entsteht keine Session. Diese Pruefung verhindert zusaetzlich das
 * stille Umschalten auf eine andere Adresse, wenn die Wallet-App eine andere
 * liefert als der Link erwartet.
 */
let expectedWallet = null;

async function openDashboard(wallet, sign) {
	if (expectedWallet && String(wallet).toLowerCase() !== expectedWallet) {
		throw new Error(language === 'de'
			? `Diese Wallet passt nicht zum Dashboard-Link. Erwartet wird ${shortWallet(expectedWallet)}. Wechsle die Wallet oder fordere in Telegram einen neuen Link an.`
			: `This wallet does not match the dashboard link. Expected ${shortWallet(expectedWallet)}. Switch wallet or request a new link in Telegram.`);
	}
	show('Persönlicher Bereich wird vorbereitet …');
	const challenge = await fetch(`/api/dashboard?wallet=${encodeURIComponent(wallet)}`, { signal: AbortSignal.timeout(15000) }).then((res) => res.json());
	debugWallet('Challenge geholt', { ok: challenge.ok, laenge: challenge.message?.length, fehler: challenge.error });
	if (!challenge.ok) throw new Error(challenge.error);
	show('Bitte bestätige die Signatur in deiner Wallet …');
	debugWallet('Signatur wird angefordert');
	const signature = await sign(challenge.message);
	debugWallet('Signatur erhalten', { laenge: signature?.length });
	show('Cover-Daten werden geladen …');
	const dashboard = await fetch('/api/dashboard', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ wallet, token: challenge.token, signature }) }).then((res) => res.json());
	if (!dashboard.ok) throw new Error(dashboard.error);
	await configPromise;
	renderDashboard(dashboard);
}

async function finish(wallet, sign) {
	if (!code) return openDashboard(wallet, sign);
	show('Signaturnachricht wird vorbereitet …');
	const details = await fetch(`/api/link?code=${encodeURIComponent(code)}&wallet=${encodeURIComponent(wallet)}`).then((res) => res.json());
	if (!details.ok) throw new Error(details.error);
	const signature = await sign(details.message);
	show('Signatur wird geprüft …');
	const verified = await fetch('/api/link/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, wallet, signature }) }).then((res) => res.json());
	if (!verified.ok) throw new Error(verified.error);
	await configPromise.catch(() => null);
	/*
		AGENT-SEC-F1: vorher eine zusammengebaute HTML-Zeichenkette. Der Aufbau ist
		derselbe geblieben, nur entsteht er jetzt aus Elementen - der Text kann
		kein Markup mehr werden, egal woher er spaeter stammt.
	*/
	status.replaceChildren();
	const erfolg = document.createElement('strong');
	erfolg.textContent = t.success;
	const erfolgCopy = document.createElement('p');
	erfolgCopy.textContent = t.successCopy;
	status.append(erfolg, erfolgCopy);
	/*
		AGENT-SEC-F2: `telegramUsername` kommt aus /api/config und ist damit ein
		Fremdwert. Er landet in einer Adresse, also wird er gegen das Telegram-Format
		geprueft, bevor er sie bildet. Haelt er es nicht ein, gibt es den Verweis
		nicht - lieber ein fehlender Knopf als eine gebaute Adresse.
	*/
	if (TELEGRAM_NAME.test(config.telegramUsername ?? '')) {
		const back = document.createElement('a');
		back.href = `https://t.me/${config.telegramUsername}`;
		back.textContent = t.backTelegram;
		status.appendChild(back);
	} else {
		const hint = document.createElement('p');
		hint.textContent = 'You can now return to Telegram.';
		status.appendChild(hint);
	}
	const dashboard = document.createElement('a'); dashboard.href = '/'; dashboard.textContent = t.openDashboard; dashboard.className = 'secondary-link'; status.appendChild(dashboard);
	disable();
}

if (code) applyLanguage(language);

injectedButton.addEventListener('click', async () => {
	try {
		if (!window.ethereum) throw new Error('Keine Browser-Wallet gefunden. Nutze „Connect mobile wallet“.');
		show('Browser-Wallet wird verbunden …');
		const [wallet] = await window.ethereum.request({ method: 'eth_requestAccounts' });
		await finish(wallet, (message) => window.ethereum.request({ method: 'personal_sign', params: [message, wallet] }));
	} catch (error) { show(error.message); }
});

async function setupWalletConnect() {
	const [{ createAppKit }, { EthersAdapter }, { mainnet }] = await Promise.all([import('@reown/appkit'), import('@reown/appkit-adapter-ethers'), import('@reown/appkit/networks')]);
	await configPromise;
	if (!config.reownProjectId) throw new Error('Mobile Wallet-Verbindung ist nicht konfiguriert.');
	/*
		themeVariables setzt die Schrift des Wallet-Fensters - und schaltet damit acht
		Fremdanfragen ab. AppKit haengt beim Start acht <link rel="preload"> auf
		fonts.reown.com in den Head, aber nur solange keine eigene Schrift gesetzt ist
		(initializeTheming in @reown/appkit-ui, Zweig `if (!hasCustomFont)`). Diese
		Preloads feuern sofort, nicht erst beim Klick, und uebertragen die IP jedes
		Besuchers an einen Dritten - dasselbe Problem wie zuvor bei Google Fonts.
		Mit gesetzter Schrift entfaellt der ganze Zweig, und das Fenster traegt
		dieselbe Schrift wie der Rest der Seite.
	*/
	if (sessionStorage.getItem(RESET_MARKE)) {
		sessionStorage.removeItem(RESET_MARKE);
		debugWallet('raeume WalletConnect-Speicher vor dem Start auf');
		await clearWalletStorage();
	}
	/*
		Drei Dinge, an denen die Initialisierung von AppKit still scheitern kann,
		und die sich von aussen nicht ansehen lassen: eine fehlende oder falsche
		Projekt-ID, eine nicht verfuegbare Krypto-Schnittstelle, und liegengebliebene
		Datenbanken. Statt danach zu fragen, sagt es die Seite selbst.
	*/
	if (walletDebug) {
		const id = config.reownProjectId ?? '';
		const datenbanken = indexedDB.databases ? await indexedDB.databases().catch(() => []) : [];
		debugWallet('Umgebung', {
			projectIdLaenge: id.length,
			projectIdAnfang: id.slice(0, 6),
			subtleCrypto: Boolean(globalThis.crypto?.subtle),
			sichererKontext: globalThis.isSecureContext,
			datenbanken: datenbanken.map((d) => d.name).join(',') || 'keine',
			wcSchluessel: Object.keys(localStorage).filter((k) => /^wc@2:/.test(k)).length
		});
	}
	const modal = createAppKit({ themeVariables: { '--apkt-font-family': "'Satoshi', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif" }, adapters: [new EthersAdapter()], networks: [mainnet], projectId: config.reownProjectId, metadata: { name: 'Raccoon Agent', description: 'Personal DeFi cover monitoring', url: location.origin, icons: [`${location.origin}/holo-raccoon.svg`] }, allWallets: 'SHOW', enableCoinbase: false, features: { analytics: false, email: false, socials: [] }, debug: walletDebug });
	/*
		AGENT-UX-3: schlaegt die WalletConnect-Paarung fehl, gibt es keine
		Paarungsadresse - und damit keinen QR-Code. Der Dialog schloss sich dann
		wortlos, und fuer die Person davor sah es aus, als sei der Knopf kaputt.
		Kein Hinweis, kein Fehler, nichts.

		Haeufigste Ursache ist ein liegengebliebener WalletConnect-Zustand im
		Browserspeicher. Deshalb: beim ersten Fehlschlag genau EINMAL aufraeumen und
		neu versuchen, und wenn es dann immer noch klemmt, es auch sagen.
	*/
	let paarungAufgeraeumt = false;
	modal.subscribeWalletConnectUri(async () => {
		if (!modal.getWalletConnectUri().wcError) return;
		if (paarungAufgeraeumt) {
			show('Die Verbindung zu WalletConnect kam nicht zustande. Bitte erneut versuchen oder die Browser-Wallet verwenden.');
			enable();
			return;
		}
		paarungAufgeraeumt = true;
		debugWallet('wc pairing failed, clearing stale state');
		show('Verbindung wird neu aufgebaut …');
		const geloescht = await clearWalletStorage();
		if (!geloescht) {
			sessionStorage.setItem(RESET_MARKE, '1');
			location.reload();
			return;
		}
		try { await modal.open(istMobil() ? {} : { view: 'ConnectingWalletConnect' }); } catch { /* der Dialog meldet sich selbst */ }
	});

	if (walletDebug) {
		/*
			`wcError` ist nur die Flagge. Die Ursache wirft AppKit als Ausnahme weiter
			(ConnectionController: `catch (error) { state.wcError = true; ... throw error }`)
			und niemand faengt sie sichtbar. Im Diagnosemodus wird sie deshalb hier
			abgegriffen - sonst sucht man die Ursache im Dunkeln.
		*/
		window.addEventListener('unhandledrejection', (ereignis) => {
			const grund = ereignis.reason;
			debugWallet('unbehandelt', grund?.stack?.split('\n').slice(0, 3).join(' | ') ?? grund?.message ?? String(grund));
		});
		window.addEventListener('error', (ereignis) => debugWallet('fehler', `${ereignis.message} @ ${ereignis.filename}:${ereignis.lineno}`));
		debugWallet('AppKit ready');
		modal.subscribeState((state) => debugWallet('state', { open: state.open, loading: state.loading, selectedNetworkId: state.selectedNetworkId }));
		modal.subscribeAccount((account) => debugWallet('account', { status: account?.status, isConnected: account?.isConnected, address: account?.address }));
		modal.subscribeEvents((event) => debugWallet('event', event?.data ?? event));
		modal.subscribeConnections((connection) => debugWallet('connection', {
			status: connection.status,
			wcFetchingUri: connection.wcFetchingUri,
			wcError: connection.wcError,
			buffering: connection.buffering,
			pairingExpiresIn: connection.wcPairingExpiry ? Math.max(0, connection.wcPairingExpiry - Math.floor(Date.now() / 1000)) : undefined
		}));
		modal.subscribeWalletConnectUri(() => {
			const snapshot = modal.getWalletConnectUri();
			const uri = snapshot.wcUri;
			let uriInfo;
			try {
				const [protocol, query = ''] = uri?.split('?') ?? [];
				const params = new URLSearchParams(query);
				uriInfo = uri ? { protocol: protocol?.split(':')[0], version: protocol?.split('@')[1], relayProtocol: params.get('relay-protocol'), hasSymKey: Boolean(params.get('symKey')) } : null;
			} catch { uriInfo = { malformed: true }; }
			debugWallet('wc pairing', { fetching: snapshot.wcFetchingUri, error: snapshot.wcError, details: uriInfo });
		});
	}
	return modal;
}

let walletConnectPromise;
function getWalletConnectModal() {
	walletConnectPromise ??= setupWalletConnect();
	return walletConnectPromise;
}

function withTimeout(promise, milliseconds, message) {
	return Promise.race([
		promise,
		new Promise((_, reject) => setTimeout(() => reject(new Error(message)), milliseconds))
	]);
}

async function resetRestoredConnection(modal) {
	show('Gespeicherte Wallet-Verbindung wird getrennt …');
	try { await withTimeout(modal.disconnect(), 5000, 'disconnect timeout'); } catch {}
	if (modal.getAddress()) {
		await clearWalletStorage();
		location.reload();
		throw new Error('Wallet-Verbindung wurde zurückgesetzt.');
	}
}

async function clearWalletStorage() {
	const walletKey = /(^wc@2:|walletconnect|@w3m|appkit|reown)/i;
	for (const key of Object.keys(localStorage)) if (walletKey.test(key)) localStorage.removeItem(key);
	for (const key of Object.keys(sessionStorage)) if (walletKey.test(key)) sessionStorage.removeItem(key);
	if (!indexedDB.databases) return;
	const databases = await indexedDB.databases().catch(() => []);
	/*
		Diese Seite legt selbst nichts in IndexedDB ab - jede Datenbank auf dieser
		Herkunft gehoert einem Wallet-SDK. Deshalb wird nicht mehr nach Namen
		gefiltert: eine Liste bekannter Namen ist genau der Fehler, der uns
		hierher gebracht hat (cbwsdk und mmconnect-kv-store standen nicht drauf).
	*/
	/*
		AGENT-UX-4: `onblocked` wurde hier wie ein Erfolg behandelt. Das ist es
		nicht - `deleteDatabase` wird blockiert, solange irgendeine Verbindung zur
		Datenbank offen ist, und WalletConnect haelt seine offen, sobald AppKit
		lebt. Die Datenbank blieb also liegen, waehrend die Funktion Vollzug
		meldete. Genau daran ist das Aufraeumen bisher gescheitert.

		Jetzt wird der Unterschied zurueckgegeben, damit der Aufrufer reagieren
		kann - loeschen laesst sie sich nur vor dem Erzeugen von AppKit.
	*/
	let blockiert = false;
	await Promise.all(databases.filter((database) => database.name).map((database) => new Promise((resolve) => {
		const request = indexedDB.deleteDatabase(database.name);
		request.onsuccess = request.onerror = () => resolve();
		request.onblocked = () => { blockiert = true; resolve(); };
	})));
	return !blockiert;
}

/*
	Konnte die Datenbank nicht geloescht werden, weil AppKit sie offen haelt,
	hilft nur ein neuer Seitenaufbau: dann raeumt `setupWalletConnect` auf, BEVOR
	es AppKit erzeugt - zu diesem Zeitpunkt haelt niemand die Datenbank.
*/
const RESET_MARKE = 'raccoon_wc_reset';

/*
	Grob, aber fuer diese eine Entscheidung ausreichend: es geht nur darum, ob ein
	QR-Code auf diesem Geraet sinnvoll ist. Ein Tablet mit Wallet-App faellt
	richtig zu "mobil", ein Rechner mit Touchscreen bleibt "Rechner".
*/
function istMobil() {
	return /Android|iPhone|iPad|iPod|Mobile|Silk/i.test(navigator.userAgent);
}

async function connectWithModal(modal) {
	show('Wallet-Auswahl wird geöffnet …');
	const walletPromise = new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error('Wallet-Verbindung hat zu lange gedauert.')), 120000);
		let unsubscribe = () => {};
		unsubscribe = modal.subscribeAccount((state) => {
			if (state.isConnected && state.address) { clearTimeout(timeout); unsubscribe(); resolve(state.address); }
		});
	});
	/*
		AGENT-UX-2: hier stand `{ view: 'AllWallets' }`. Damit oeffnete der Dialog
		direkt die Wallet-Liste und uebersprang die Verbindungsansicht - und genau
		dort sitzt der QR-Code. Zwei Folgen: vom Rechner aus liess sich kein
		Handy-Wallet verbinden, und die Auswahl eines installierten Wallets sprang
		in die Browsererweiterung, wodurch dieser Knopf dasselbe tat wie
		"Browser-Wallet verwenden" daneben.

		Jetzt haengt die Ansicht am Geraet, und zwar aus einem einfachen Grund:

		Am Rechner ist der QR das einzige, was der Knopf daneben nicht kann -
		"Browser-Wallet verwenden" deckt die Erweiterung ab. Also direkt den QR.

		Am Handy waere ein QR sinnlos: gescannt wird er mit genau dem Geraet, auf
		dem er steht. Dort gehoert die Wallet-Liste hin, aus der heraus die App per
		Deeplink aufgeht. Diese Wahl trifft AppKit von selbst richtig, deshalb wird
		dort keine Ansicht vorgegeben.
	*/
	await modal.open(istMobil() ? {} : { view: 'ConnectingWalletConnect' });
	debugWallet('Connect modal opened');
	const wallet = await walletPromise;
	const provider = modal.getWalletProvider();
	debugWallet('Provider', provider ? {
		typ: provider.constructor?.name,
		istWalletConnect: Boolean(provider.isWalletConnect ?? provider.session ?? provider.signer),
		hatRequest: typeof provider.request === 'function'
	} : 'fehlt');
	if (!provider) throw new Error('WalletConnect-Provider fehlt.');
	await modal.close();
	return { wallet, provider };
}

wcButton.addEventListener('click', async () => {
	try {
		debugWallet('Connect clicked');
		wcButton.disabled = true;
		show('Wallet-Auswahl wird geladen …');
		await dashboardRestorePromise;
		const modal = await getWalletConnectModal();
		if (modal.getAddress()) {
			debugWallet('Clearing restored account before new login', modal.getAddress());
			show('Wallet-Auswahl wird vorbereitet …');
			await resetRestoredConnection(modal);
		}
		const { wallet, provider } = await connectWithModal(modal);
		debugWallet('Account received', wallet);
		await finish(wallet, (message) => withTimeout(provider.request({ method: 'personal_sign', params: [message, wallet] }), 60000, 'Die Wallet hat nicht auf die Signaturanfrage reagiert.'));
	} catch (error) {
		debugWallet('Connection error', error);
		show(error.message);
	} finally {
		wcButton.disabled = false;
	}
});

async function endSession({ disconnect = false } = {}) {
	if (disconnect) show('Wallet-Verbindung wird getrennt …');
	await fetch('/api/dashboard', { method: 'DELETE' });
	if (disconnect) {
		if (walletConnectPromise) {
			try { const modal = await walletConnectPromise; if (modal.getAddress()) await withTimeout(modal.disconnect(), 5000, 'disconnect timeout'); } catch {}
		}
		await clearWalletStorage();
		location.reload();
		return;
	}
	window.dashboardData = null; document.body.classList.remove('dashboard-mode'); status.textContent = ''; enable(); applyLanguage(language);
}
function enable() { wcButton.disabled = false; injectedButton.disabled = false; }
async function disconnectTelegram() {
	if (!confirm(t.confirmDisconnect)) return;
	const response = await fetch('/api/dashboard?telegram=1', { method: 'DELETE' });
	const result = await response.json(); if (!result.ok) return show(result.error);
	if (window.dashboardData) renderDashboard({ ...window.dashboardData, telegramLinked: false, telegramStartCode: null });
	await restoreDashboard();
}
document.querySelector('#logout').addEventListener('click', () => endSession({ disconnect: true }));
document.querySelector('#switch-wallet').addEventListener('click', () => endSession({ disconnect: true }));

async function restoreDashboard() {
	if (code) return;
	try {
		// AGENT-SEC-A2: der Code verlaesst die sichtbare URL SOFORT, vor dem
		// Netzaufruf. Vorher geschah das erst nach der Antwort; in diesem Fenster
		// stand er in der Adresszeile und haette bei einer Navigation mitgehen
		// koennen. Er wird nirgends gespeichert.
		if (access) history.replaceState({}, '', '/');
		const response = await fetch(access ? `/api/dashboard?access=${encodeURIComponent(access)}` : '/api/dashboard', { signal: AbortSignal.timeout(10000) });
		if (!response.ok) {
			const failure = await response.json().catch(() => ({}));
			if (failure.code === 'SESSION_REVOKED' || failure.code === 'NO_SESSION') {
				await withTimeout(clearWalletStorage(), 1500, 'wallet cleanup timeout').catch(() => {});
			}
			if (access) show(failure.error || (language === 'de' ? 'Der Dashboard-Link ist abgelaufen. Öffne /dashboard erneut in Telegram.' : 'The dashboard link has expired. Open /dashboard again in Telegram.'));
			return;
		}
		const dashboard = await response.json();
		if (!dashboard.ok) {
			// AGENT-SEC-A2: der Zugangslink authentifiziert nicht mehr. Er nennt
			// nur die erwartete Wallet; angemeldet wird ueber den bestehenden
			// Signaturflow.
			if (dashboard.code === 'WALLET_SIGNATURE_REQUIRED' && typeof dashboard.wallet === 'string') {
				expectedWallet = dashboard.wallet.toLowerCase();
				show(language === 'de'
					? `Verbinde ${shortWallet(expectedWallet)} und signiere die Anmeldung. Es ist keine Transaktion.`
					: `Connect ${shortWallet(expectedWallet)} and sign in. This is not a transaction.`);
			}
			return;
		}
		await configPromise;
		renderDashboard(dashboard);
	} catch { /* Ohne gespeicherte Sitzung bleibt die Wallet-Auswahl sichtbar. */ }
}

const dashboardRestorePromise = restoreDashboard();
