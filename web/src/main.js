import { appKitMethoden, WALLET_METHODEN_ANMELDEN } from './wallet-methods.js';
import { ensureMainnetAccount, ensureAppKitMainnetAccount, eoaLoginTexts, guardedChallengeSignSubmit, normalizeAddress } from './eoa-login.js';
import { submitDashboardLogin } from './onchain-login.js';
import { startAnalytics } from './analytics.js';
import { mountEye } from './eye.js';
import { createCoverPanel } from './nexus-cover.js';
import { createUniswapPanel, renderUniswapSection } from './uniswap-cover.js';
import { mountDashboardNav, renderDashboardShell } from './dashboard-shell.js';

const status = document.querySelector('#status');
const wcButton = document.querySelector('#walletconnect');
const injectedButton = document.querySelector('#injected');
const searchParams = new URLSearchParams(location.search);
const code = searchParams.get('code');
const access = searchParams.get('access');
const walletDebug = searchParams.get('debug') === 'wallet';
const translations = {
	de: {
		online: ['Private Cover-Überwachung · ', 'online'], kicker: 'Unabhängige DeFi-Cover-Überwachung', title: ['Onchain-Risiken verstehen. ', 'Cover finden. Im Blick behalten.'], lead: 'CoverRaccoon zeigt dir deine DeFi-Positionen, passende Cover-Optionen und deine aktiven Covers – ohne deine Assets zu verwahren.', walletUntouched: 'Wallet bleibt unberührt', signature: 'Nur eine Signatur', alerts: 'Hinweise über Telegram', step: '01 · Identität', connectTitle: 'Wallet verbinden', connectCopy: 'Eine Signatur bestätigt die Wallet und öffnet dein persönliches Dashboard.', connect: 'Mit Wallet verbinden', injected: 'Browser-Wallet verwenden', security: 'Keine Transaktion und keine Freigabe. Gas nur, wenn eine Safe die Anmeldung on-chain bestätigt.', dashKicker: 'Persönliches Dashboard', dashTitle: ['Cover-Übersicht'], switchWallet: 'Wallet wechseln', logout: 'Abmelden', activeLabel: 'Aktive Covers', expiryLabel: 'Nächster Ablauf', telegramLabel: 'Telegram-Überwachung', telegramTitle: 'Telegram-Benachrichtigungen', protection: 'Deine Covers', footer: 'Daten: Nexus Mutual · Ethereum', footerExplainer: 'Covers live von der Blockchain, ohne Bewertung und ohne Verkauf.', active: 'aktiv', noCover: 'Kein aktives Cover', days: 'Tage', telegramActive: 'Aktiv', notConnected: 'Nicht verbunden', tgConnected: '● Telegram verbunden', tgDisconnected: 'Telegram nicht verbunden', tgOnCopy: 'Ablaufhinweise sind aktiv. Öffne Telegram, um mit deinem Agenten zu sprechen.', tgOffCopy: 'Erhalte Ablaufhinweise, ohne laufend das Dashboard prüfen zu müssen.', openTelegram: 'Telegram öffnen', connectTelegram: 'Telegram aktivieren', updated: 'Aktualisiert', empty: 'Für diese Wallet wurde kein aktives Nexus-Mutual-Cover gefunden.', product: 'Produkt', protectionAmount: 'Cover-Betrag', expiry: 'Ablauf', status: 'Status', linkTitle: 'Telegram mit deiner Wallet verbinden', linkCopy: 'Einmal signieren, um Erinnerungen für diese Wallet zu aktivieren.', linkStep: '01 · Telegram einrichten', linkSecurity: 'Eine Signatur. Keine Transaktion, keine Tokenfreigabe. Safes: nur mit Off-chain-Signatur. Der Link ist zehn Minuten gültig.', success: 'Alles eingerichtet.', successCopy: 'Deine Telegram-Erinnerungen sind aktiv. Du kannst jetzt zum Raccoon Agent zurückkehren.', backTelegram: 'Zurück zum Raccoon Agent', openDashboard: 'Dashboard öffnen', disconnectTelegram: 'Telegram trennen', confirmDisconnect: 'Telegram-Benachrichtigungen für diese Wallet wirklich trennen?', disclaimerTitle: 'Bevor du dich verbindest', disclaimer: ['Der Raccoon Agent ist experimentell und befindet sich in Entwicklung. Fehler, Ausfälle und unvollständige oder falsche Daten sind möglich. Wer sich auf Anzeigen oder Erinnerungen verlässt, etwa wenn eine Ablauf-Erinnerung ausbleibt, kann dadurch Nachteile oder Verluste erleiden. DeFi und Onchain-Cover sind mit erheblichen Risiken bis hin zum Totalverlust verbunden.', 'Der Raccoon Agent zeigt Informationen zu deinen Nexus-Mutual-Covers an und erinnert an Abläufe. Er verkauft und vermittelt nichts und ist keine Versicherungs-, Rechts- oder Anlageberatung.', 'Nexus Mutual ist keine Versicherung. Es besteht kein Rechtsanspruch auf eine Auszahlung; maßgeblich sind allein die Bedingungen von Nexus Mutual.', 'Angezeigte Daten werden live aus der Blockchain und von Nexus Mutual gelesen. Wir übernehmen keine Gewähr für Richtigkeit, Vollständigkeit oder Aktualität.', 'Soweit gesetzlich zulässig, ist unsere Haftung für Schäden aus der Nutzung ausgeschlossen, insbesondere für leichte Fahrlässigkeit sowie für Ausfälle oder Fehler von Blockchain, Wallets, Nexus Mutual und anderen Drittdiensten. Unberührt bleibt die Haftung für Vorsatz und grobe Fahrlässigkeit, für Personenschäden und nach zwingenden gesetzlichen Vorschriften.', 'Du bestätigst nur eine Anmelde-Signatur. Der Agent fragt nie nach einer Transaktion, einer Freigabe oder deiner Seed Phrase.'], disclaimerLabel: ['Ich habe die Hinweise gelesen und akzeptiere sie sowie die ', 'Datenschutzerklärung', '.'], disclaimerImprint: 'Impressum', disclaimerContinue: 'Weiter zur Wallet', disclaimerCancel: 'Abbrechen', verifyTitle: 'Woran erkenne ich eine echte Anfrage?', verify: ['Es ist eine Signatur, keine Transaktion: kein Betrag, keine Freigabe. Bei einer Safe kann Safe{Wallet} daraus eine SignMessageLib-On-chain-Bestätigung machen: Sie kann Gas kosten, bewegt aber keinen Wert und erteilt keine Tokenfreigabe.', 'Die Nachricht beginnt mit „coverraccoon.com wants you to sign in“, und die Adresszeile zeigt coverraccoon.com.', 'Kein „Permit“, kein „Approve“, kein Token-Betrag und kein unlesbarer Hex-Text. Siehst du so etwas, brich ab.', 'Links zum Verbinden einer Wallet kommen nur aus deinem privaten Chat mit dem Raccoon-Agent-Bot.']
	},
	en: {
		online: ['Private cover monitoring · ', 'online'], kicker: 'Independent DeFi cover monitor', title: ['Understand your onchain risks. ', 'Find cover. Keep it in sight.'], lead: 'CoverRaccoon helps you understand DeFi exposures, explore available cover and keep track of your cover – without taking custody of your assets.', walletUntouched: 'Wallet stays untouched', signature: 'Signature only', alerts: 'Alerts via Telegram', step: '01 · Identity', connectTitle: 'Connect your wallet', connectCopy: 'A signature confirms the wallet and opens your personal dashboard.', connect: 'Connect wallet', injected: 'Use browser wallet', security: 'No transaction and no approval. Gas only if a Safe confirms the sign-in on-chain.', dashKicker: 'Personal dashboard', dashTitle: ['Protection overview'], switchWallet: 'Switch wallet', logout: 'Sign out', activeLabel: 'Active covers', expiryLabel: 'Next expiry', telegramLabel: 'Telegram monitoring', telegramTitle: 'Telegram notifications', protection: 'Your covers', footer: 'Data: Nexus Mutual · Ethereum', footerExplainer: 'Covers read live from the blockchain, no ratings and no sales.', active: 'active', noCover: 'No active cover', days: 'days', telegramActive: 'Active', notConnected: 'Not connected', tgConnected: '● Telegram connected', tgDisconnected: 'Telegram not connected', tgOnCopy: 'Expiry notices are active. Open Telegram to talk to your agent.', tgOffCopy: 'Get expiry notices without having to check the dashboard.', openTelegram: 'Open Telegram', connectTelegram: 'Connect Telegram', updated: 'Updated', empty: 'No active Nexus Mutual cover was found for this wallet.', product: 'Product', protectionAmount: 'Cover amount', expiry: 'Expiry', status: 'Status', linkTitle: 'Connect Telegram to your wallet', linkCopy: 'Sign once to activate reminders for this wallet.', linkStep: '01 · Telegram setup', linkSecurity: 'One signature. No transaction, no token approval. Safes: off-chain signature only. The link is valid for ten minutes.', success: 'Everything is set up.', successCopy: 'Your Telegram reminders are active. You can now return to Raccoon Agent.', backTelegram: 'Return to Raccoon Agent', openDashboard: 'Open dashboard', disconnectTelegram: 'Disconnect Telegram', confirmDisconnect: 'Disconnect Telegram notifications for this wallet?', disclaimerTitle: 'Before you connect', disclaimer: ['Raccoon Agent is experimental and under development. Errors, outages and incomplete or wrong data are possible. Relying on what it shows or on its reminders, for example if an expiry reminder does not arrive, can lead to disadvantages or losses. DeFi and onchain cover carry significant risks, up to total loss.', 'Raccoon Agent shows information about your Nexus Mutual covers and reminds you of expiries. It does not sell or arrange anything and is not insurance, legal or investment advice.', 'Nexus Mutual is not insurance. There is no legal right to a payout; only the terms of Nexus Mutual apply.', 'Data shown is read live from the blockchain and from Nexus Mutual. We give no warranty for accuracy, completeness or timeliness.', 'To the extent permitted by law, our liability for damage arising from use is excluded, in particular for slight negligence and for outages or errors of the blockchain, wallets, Nexus Mutual and other third-party services. Liability for intent and gross negligence, for personal injury and under mandatory statutory provisions remains unaffected.', 'You only confirm a sign-in signature. The agent never asks for a transaction, an approval or your seed phrase.'], disclaimerLabel: ['I have read and accept these notes and the ', 'privacy policy', '.'], disclaimerImprint: 'Imprint', disclaimerContinue: 'Continue to wallet', disclaimerCancel: 'Cancel', verifyTitle: 'How do I recognise a genuine request?', verify: ['It is a signature, not a transaction: no amount, no approval. With a Safe, Safe{Wallet} may turn this into a SignMessageLib on-chain confirmation: it can cost gas, but it moves no value and grants no token approval.', 'The message starts with “coverraccoon.com wants you to sign in”, and the address bar shows coverraccoon.com.', 'No “Permit”, no “Approve”, no token amount and no unreadable hex text. If you see any of that, cancel.', 'Links to connect a wallet only come from your private chat with the Raccoon Agent bot.']
	}
};
/*
	DeFi-Positionen (Phase 1: Aave v3, Ethereum). Drei Bloecke bleiben getrennt:
	erkannte Position, passendes Nexus-Produkt, vorhandene Covers dieser Wallet.
	Keine Wortwahl, die Deckung, Schutz oder einen Anspruch nahelegt, und keine
	Rechnung "Position minus Cover".
*/
Object.assign(translations.de, {
	positionsTitle: 'DeFi-Positionen', positionsLoading: 'DeFi-Positionen werden gelesen …', positionsError: 'DeFi-Positionen konnten gerade nicht geladen werden.',
	positionsNone: 'Keine Aave-v3-Positionen auf Ethereum gefunden.', positionsChecked: 'Geprüft: Aave v3 und Uniswap v3 auf Ethereum',
	marketUnavailableHelp: 'Dieser Markt konnte nicht gelesen werden und ist in den Summen nicht enthalten.', notAvailable: 'Nicht verfügbar',
	allMarketsUnavailable: 'Die Aave-v3-Positionen konnten gerade nicht gelesen werden.',
	totalsIncompleteOne: '{markets} konnte derzeit nicht gelesen werden. Die Summen enthalten nur verfügbare Märkte.',
	totalsIncompleteMany: '{markets} konnten derzeit nicht gelesen werden. Die Summen enthalten nur verfügbare Märkte.', listAnd: 'und',
	totalSupplied: 'Gesamt eingezahlt', totalBorrowed: 'Gesamt geliehen', netHelp: 'Eingezahlter Wert minus geliehener Wert', positionsHeading: 'Positionen',
	coverDetailsAction: 'Cover-Details ansehen', nexusLabel: 'Nexus Mutual', cardNexusLabel: 'Nexus', productAvailableShort: 'Passendes Produkt verfügbar', walletCoverStatusLabel: 'Wallet-Cover-Status', walletCoverLabel: 'Wallet-Cover',
	activeCoverFound: 'Aktives Aave-v3-Cover gefunden', activeCoversFound: '{n} aktive Aave-v3-Covers gefunden', coversFoundOne: '1 aktives Cover gefunden', coversFoundMany: '{n} aktive Covers gefunden', noActiveCover: 'Kein aktives passendes Cover erkannt',
	attributionLabel: 'Cover-Zuordnung', attributionAuto: 'Eindeutig · 1:1', attributionRequired: 'Bestätigung erforderlich', attributionConfirmed: 'Vom Nutzer bestätigt', attributionNone: '—',
	attributionAutoHelp: 'Eine aktive passende Position und ein aktives passendes Nexus Cover wurden erkannt.',
	attributionAutoNote: 'Diese Zuordnung ergibt sich aus einer eindeutigen 1:1-Konstellation der öffentlich verfügbaren Daten. Sie ist keine Aussage über die Berechtigung eines Claims oder eine Auszahlung.',
	attributionConfirmedHelp: 'Diese Zuordnung wurde von dir bestätigt und basiert nicht auf privaten Nexus-Metadaten.',
	attributionConfirmedNote: 'Diese Zuordnung wurde von dir bestätigt. CoverRaccoon hat keine privaten Proof-of-Loss-Daten eingesehen.',
	summaryCoverNote: 'Ein aktives Cover für das passende Nexus-Produkt bedeutet nicht automatisch, dass jede erkannte Aave-Position diesem Cover zugeordnet ist.',
	attributionRequiredNote: 'Die öffentlichen Daten ergeben keine eindeutige 1:1-Zuordnung. Ordne das Cover bei der passenden Position selbst zu; CoverRaccoon legt das nicht fest.',
	attributionIncompleteNote: 'Nicht alle unterstützten Märkte konnten gelesen werden; eine eindeutige Zuordnung ist deshalb nicht möglich.',
	assignAction: 'Cover zuordnen', changeAssignment: 'Zuordnung ändern', removeAssignment: 'Zuordnung entfernen', assignThisCover: 'Dieser Position zuordnen', assignCancel: 'Abbrechen',
	assignIntro: 'Wähle das aktive Nexus Cover (Produkt #{id}), das du dieser Position zuordnest. CoverRaccoon speichert nur diese Zuordnung für deine Wallet, bis du sie entfernst oder das Cover nicht mehr aktiv ist.', assignedCover: 'zugeordnet', daysLeft: 'noch {n} Tage',
	attributionSaving: 'Wird gespeichert …', attributionSaveError: 'Die Zuordnung konnte nicht gespeichert werden. Bitte erneut versuchen.', attributionRemoveError: 'Die Zuordnung konnte nicht entfernt werden. Bitte erneut versuchen.',
	attributionLoadError: 'Gespeicherte Cover-Zuordnungen konnten gerade nicht geladen werden.',
	viewCoverAction: 'Cover bei Nexus ansehen', viewProductAction: 'Produkt bei Nexus ansehen',
	positionsSource: 'Quelle: Aave v3 · Ethereum (live), bewertet über das Aave-Preisorakel', detectedPosition: 'Erkannte DeFi-Position', supplied: 'Eingezahlt', borrowed: 'Geliehen',
	netPosition: 'Nettoposition', healthFactor: 'Health Factor', noDebt: 'keine Schulden', collateral: 'als Sicherheit', notCollateral: 'nicht als Sicherheit', none: 'keine',
	matchingProduct: 'Passendes Nexus-Produkt', productAvailable: 'Passendes Nexus-Produkt verfügbar', productDeprecated: 'Nexus-Produkt eingestellt', productNone: 'Kein passendes Nexus-Produkt im aktuellen Katalog',
	productUnavailable: 'Nexus-Katalog gerade nicht prüfbar', productUnsupported: 'Kein zugeordnetes Nexus-Produkt', productWord: 'Produkt',
	positionsNote: 'Ein passendes Nexus-Produkt bedeutet nicht, dass ein konkreter Verlust gedeckt oder ein bestimmter Betrag erstattungsfähig ist. Maßgeblich sind die Produktbedingungen und der Claims-Prozess von Nexus Mutual.'
});
Object.assign(translations.en, {
	positionsTitle: 'DeFi Positions', positionsLoading: 'Reading DeFi positions …', positionsError: 'DeFi positions could not be loaded right now.',
	positionsNone: 'No Aave v3 positions found on Ethereum.', positionsChecked: 'Checked: Aave v3 and Uniswap v3 on Ethereum',
	marketUnavailableHelp: 'This market could not be read and is not included in the totals.', notAvailable: 'Not available',
	allMarketsUnavailable: 'The Aave v3 positions could not be read right now.',
	totalsIncompleteOne: '{markets} could not be read right now. The totals include only available markets.',
	totalsIncompleteMany: '{markets} could not be read right now. The totals include only available markets.', listAnd: 'and',
	totalSupplied: 'Total supplied', totalBorrowed: 'Total borrowed', netHelp: 'Supplied value minus borrowed value', positionsHeading: 'Positions',
	coverDetailsAction: 'View cover details', nexusLabel: 'Nexus Mutual', cardNexusLabel: 'Nexus', productAvailableShort: 'Matching product available', walletCoverStatusLabel: 'Wallet cover status', walletCoverLabel: 'Wallet cover',
	activeCoverFound: 'Active Aave v3 cover found', activeCoversFound: '{n} active Aave v3 covers found', coversFoundOne: '1 active cover found', coversFoundMany: '{n} active covers found', noActiveCover: 'No active matching cover detected',
	attributionLabel: 'Cover attribution', attributionAuto: 'Unambiguous · 1:1', attributionRequired: 'Confirmation required', attributionConfirmed: 'Confirmed by you', attributionNone: '—',
	attributionAutoHelp: 'One active matching position and one active matching Nexus cover were detected.',
	attributionAutoNote: 'This attribution follows from an unambiguous 1:1 constellation in the publicly available data. It is not a statement about claim eligibility or a payout.',
	attributionConfirmedHelp: 'You confirmed this attribution; it is not based on private Nexus metadata.',
	attributionConfirmedNote: 'You confirmed this attribution. CoverRaccoon has not seen any private proof-of-loss data.',
	summaryCoverNote: 'An active cover for the matching Nexus product does not automatically mean that every detected Aave position is attributed to that cover.',
	attributionRequiredNote: 'The public data does not give an unambiguous 1:1 attribution. Assign the cover at the matching position yourself; CoverRaccoon does not decide this.',
	attributionIncompleteNote: 'Not all supported markets could be read, so an unambiguous attribution is not possible.',
	assignAction: 'Assign cover', changeAssignment: 'Change attribution', removeAssignment: 'Remove attribution', assignThisCover: 'Assign to this position', assignCancel: 'Cancel',
	assignIntro: 'Choose the active Nexus cover (product #{id}) you want to assign to this position. CoverRaccoon stores only this attribution for your wallet until you remove it or the cover is no longer active.', assignedCover: 'assigned', daysLeft: '{n} days left',
	attributionSaving: 'Saving …', attributionSaveError: 'The attribution could not be saved. Please try again.', attributionRemoveError: 'The attribution could not be removed. Please try again.',
	attributionLoadError: 'Saved cover attributions could not be loaded right now.',
	viewCoverAction: 'View cover on Nexus', viewProductAction: 'View product on Nexus',
	positionsSource: 'Source: Aave v3 · Ethereum (live), valued with the Aave price oracle', detectedPosition: 'Detected DeFi position', supplied: 'Supplied', borrowed: 'Borrowed',
	netPosition: 'Net position', healthFactor: 'Health factor', noDebt: 'no debt', collateral: 'as collateral', notCollateral: 'not as collateral', none: 'none',
	matchingProduct: 'Matching Nexus product', productAvailable: 'Matching Nexus product available', productDeprecated: 'Nexus product discontinued', productNone: 'No matching Nexus product in the current catalogue',
	productUnavailable: 'Nexus catalogue cannot be checked right now', productUnsupported: 'No mapped Nexus product', productWord: 'Product',
	positionsNote: 'A matching Nexus product does not mean that a specific loss is covered or that a particular amount is reimbursable. Only the product terms and the Nexus Mutual claims process apply.'
});
let language = localStorage.getItem('raccoon_language') || (navigator.language?.toLowerCase().startsWith('de') ? 'de' : 'en');
let t = translations[language] || translations.en;
if (code) document.body.classList.add('link-mode');
const show = (message) => { status.textContent = message; };
const disable = () => { wcButton.disabled = true; injectedButton.disabled = true; };

/*
	Safe-App-Sitzung (15.10.2026): Es gibt kein JS-lesbares Sitzungstoken mehr. Im
	normalen Browser traegt das Strict-Cookie die Sitzung, in der eingebetteten Safe
	App das partitionierte HttpOnly-Cookie - beides schickt der Browser selbst mit.
	authFetch bleibt als einzige Aufrufstelle fuer authentisierte Anfragen bestehen.
*/
function authFetch(url, options = {}) {
	return fetch(url, options);
}

/*
	Hinweise vor dem Verbinden, als Overlay. Wer "Mit Wallet verbinden" oder
	"Browser-Wallet verwenden" drueckt, sieht zuerst die Hinweise; "Weiter zur
	Wallet" ist erst nach dem Haekchen frei und startet dann genau den Weg, der
	gedrueckt wurde, im selben Klick (Wallets oeffnen sich nur auf eine echte
	Nutzeraktion hin). Der Browser merkt sich die Zustimmung je Textfassung;
	aendert sich der Text, erscheint das Overlay wieder. Gespeichert wird nur
	hier im Browser, nicht auf dem Server.
*/
const HINWEISE_FASSUNG = 'hinweise-2026-10-01';
let hinweiseAkzeptiert = false;
try { hinweiseAkzeptiert = localStorage.getItem('raccoon_hinweise') === HINWEISE_FASSUNG; } catch { /* kein Speicher: neu bestaetigen */ }
const hinweisFenster = document.querySelector('#disclaimer-overlay');
const hinweisHaken = document.querySelector('#disclaimer-ok');
const hinweisWeiter = document.querySelector('#disclaimer-continue');
let wartendeAktion = null;
let fokusVorher = null;

function schliesseHinweise() {
	hinweisFenster.hidden = true;
	document.body.classList.remove('overlay-open');
	wartendeAktion = null;
	fokusVorher?.focus?.();
}

function mitHinweisen(aktion) {
	if (config.anmeldungPausiert) return zeigeAnmeldungPausiert();
	if (hinweiseAkzeptiert) return aktion();
	wartendeAktion = aktion;
	fokusVorher = document.activeElement;
	hinweisHaken.checked = false;
	hinweisWeiter.disabled = true;
	hinweisFenster.hidden = false;
	document.body.classList.add('overlay-open');
	hinweisHaken.focus();
}

hinweisHaken.addEventListener('change', () => { hinweisWeiter.disabled = !hinweisHaken.checked; });
hinweisWeiter.addEventListener('click', () => {
	if (!hinweisHaken.checked) return;
	hinweiseAkzeptiert = true;
	try { localStorage.setItem('raccoon_hinweise', HINWEISE_FASSUNG); } catch { /* gilt dann nur fuer diesen Besuch */ }
	const aktion = wartendeAktion;
	wartendeAktion = null;
	hinweisFenster.hidden = true;
	document.body.classList.remove('overlay-open');
	aktion?.();
});
document.querySelector('#disclaimer-cancel').addEventListener('click', schliesseHinweise);
hinweisFenster.addEventListener('click', (event) => { if (event.target === hinweisFenster) schliesseHinweise(); });
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !hinweisFenster.hidden) schliesseHinweise(); });
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
	text('#disclaimer-title', t.disclaimerTitle); t.disclaimer.forEach((punkt, index) => text(`#disclaimer-${index + 1}`, punkt)); teile('#disclaimer-label', t.disclaimerLabel); text('#disclaimer-imprint', t.disclaimerImprint); text('#disclaimer-continue', t.disclaimerContinue); text('#disclaimer-cancel', t.disclaimerCancel);
	text('#verify-title', t.verifyTitle); t.verify.forEach((punkt, index) => text(`#verify-${index + 1}`, punkt));
	text('#dash-kicker', t.dashKicker); teile('#dash-title', t.dashTitle); text('#switch-wallet', t.switchWallet); text('#logout', t.logout);
	text('#label-active', t.activeLabel); text('#label-expiry', t.expiryLabel); text('#label-telegram', t.telegramLabel); text('#telegram-title', t.telegramTitle); text('#protection-title', t.protection); text('#footer-copy', t.footer); text('#footer-explainer', t.footerExplainer);
}
document.querySelectorAll('[data-language]').forEach((button) => button.addEventListener('click', () => {
	applyLanguage(button.dataset.language);
	// Offene Cover-Panels behalten ihren Zustand (Quote, Eingaben) und folgen nur der Sprache.
	for (const panel of [...coverPanels.values(), ...uniswapPanels.values()]) panel.setLanguage(language);
	if (window.dashboardData) renderDashboard(window.dashboardData);
}));
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
function addTextElement(parent, tag, value, className = '') {
	const element = document.createElement(tag);
	if (className) element.className = className;
	element.textContent = String(value ?? '');
	parent.appendChild(element);
	return element;
}

/*
	Positionen kommen aus /api/positions, getrennt vom Dashboard: faellt die
	Abfrage aus, bleibt der Rest stehen. Bewusst getrennt (13.10.2026): die
	Aave-v3-Zusammenfassung mit Produkt, Wallet-Cover-Status und der einen
	Erklaerung, die einzelnen Markt-Positionen (nur kurze Statuszeilen) und die
	Covers selbst - die stehen genau einmal, oben unter "Deine Covers". Eine
	Cover-Zuordnung entsteht nur auf zwei Wegen: automatisch 1:1, wenn die
	oeffentlichen Daten eindeutig sind, oder durch Bestaetigung des
	Wallet-Inhabers. Beides ist keine Pruefung durch Nexus und kein Nachweis einer
	Deckung. Gehalten nur im Modul-Speicher, nie in
	localStorage. Alle Werte gehen als Text in den Baum (addTextElement).
*/
let positionsState = { wallet: null, status: 'idle', data: null };

async function loadPositions(wallet) {
	// Jede Positionsabfrage beginnt ohne Cover-Zuordnungen; die gespeicherten kommen frisch vom Server.
	resetAttributionState();
	positionsState = { wallet, status: 'loading', data: null };
	renderPositions();
	// Lokale Dev-Fixture: nur im Vite-Entwicklungsserver (import.meta.env.DEV) und nur
	// fuer die Platzhalter-Wallet der Fixture. Im Produktions-Build ist DEV false;
	// dieser Zweig und das Fixture-Modul fallen aus dem Bundle.
	if (import.meta.env.DEV && import.meta.env.VITE_POSITIONS_FIXTURE) {
		const fixture = await import('./fixtures/positions-fixture.js');
		const data = fixture.positionsFixture(import.meta.env.VITE_POSITIONS_FIXTURE, wallet);
		if (data) {
			attributionApi = fixture.fixtureAttributionApi();
			positionsState = { wallet, status: 'ok', data };
			renderPositions();
			loadAttributions(wallet);
			return;
		}
	}
	try {
		const response = await authFetch('/api/positions', { signal: AbortSignal.timeout(25000) });
		const body = await response.json().catch(() => null);
		if (positionsState.wallet !== wallet) return;
		positionsState = response.ok && body?.ok && String(body.wallet).toLowerCase() === wallet
			? { wallet, status: 'ok', data: body }
			: { wallet, status: 'error', data: null };
		if (positionsState.status === 'ok') loadAttributions(wallet);
	} catch {
		if (positionsState.wallet !== wallet) return;
		positionsState = { wallet, status: 'error', data: null };
	}
	renderPositions();
}

function formatAmount(value) {
	const number = Number(value);
	// de-DE statt de-AT: de-AT gruppiert Zahlen mit Leerzeichen, Waehrungen aber mit Punkt.
	return Number.isFinite(number) ? number.toLocaleString(language === 'de' ? 'de-DE' : 'en-GB', { maximumFractionDigits: 6 }) : '—';
}
function formatUsd(value) {
	const number = Number(value);
	return Number.isFinite(number) ? new Intl.NumberFormat(language === 'de' ? 'de-AT' : 'en-GB', { style: 'currency', currency: 'USD' }).format(number) : '—';
}

/** USD-Dezimalzeichenkette aus der API (hoechstens 8 Stellen) als ganze 10^-8-Einheiten. */
function usdUnits(value) {
	const match = /^(-?)(\d+)(?:\.(\d{1,8}))?$/.exec(String(value ?? ''));
	if (!match) return null;
	const units = BigInt(match[2]) * 100_000_000n + BigInt((match[3] ?? '').padEnd(8, '0'));
	return match[1] ? -units : units;
}
const unitsToUsd = (units) => formatUsd(Number(units) / 1e8);

function element(parent, tag, className = '') {
	const node = document.createElement(tag);
	if (className) node.className = className;
	parent.appendChild(node);
	return node;
}

/** Beschriftung und Wert als eigene Zeile; optional ein kleiner Hilfetext. */
function figureRow(parent, label, value, help = '') {
	const row = element(parent, 'div', 'figure-row');
	addTextElement(row, 'span', label, 'figure-label');
	addTextElement(row, 'strong', value, 'figure-value');
	if (help) addTextElement(row, 'small', help, 'figure-help');
	return row;
}

/** Ein Asset je Zeile: Symbol, Menge, USD-Wert, optional Sicherheiten-Hinweis. */
function assetGroup(parent, label, assets, withCollateral) {
	const group = element(parent, 'div', 'asset-group');
	addTextElement(group, 'h4', label, 'asset-group-title');
	if (!assets.length) { addTextElement(group, 'p', '—', 'position-muted'); return group; }
	for (const asset of assets) {
		const row = element(group, 'div', 'asset-row');
		addTextElement(row, 'span', asset.symbol, 'asset-symbol');
		addTextElement(row, 'span', `${formatAmount(asset.amount)} ${asset.symbol}`, 'asset-amount');
		addTextElement(row, 'span', formatUsd(asset.usdValue), 'asset-value');
		if (withCollateral) addTextElement(row, 'small', asset.isCollateral ? t.collateral : t.notCollateral, 'asset-flag');
	}
	return group;
}

function productText(nexus) {
	if (nexus?.state === 'MATCHED') return t.productAvailable;
	if (nexus?.state === 'PRODUCT_DEPRECATED') return t.productDeprecated;
	if (nexus?.state === 'NO_PRODUCT') return t.productNone;
	if (nexus?.state === 'UNSUPPORTED') return t.productUnsupported;
	return t.productUnavailable;
}

/*
	Offizielle Nexus-Produktseite (12.10.2026). Die Route /cover/product/<productId>
	verlinkt Nexus selbst (Blog "Upfront Proof of Loss", 31.08.2026: Produkte 438,
	463-466); deren IDs sind genau die Katalog-IDs. Nur fest eingetragene IDs, nie aus
	Namen, API- oder Token-Daten gebaut.
*/
const NEXUS_PRODUCT_PAGES = Object.freeze({ 97: 'https://app.nexusmutual.io/cover/product/97' });
const NEXUS_PRODUCT_PAGE = /^https:\/\/app\.nexusmutual\.io\/cover\/product\/(\d+)$/;

/** Link nur fuer ein verfuegbares, fest eingetragenes Produkt; sonst null. */
function nexusProductUrl(product) {
	if (product?.state !== 'MATCHED') return null;
	const url = Object.prototype.hasOwnProperty.call(NEXUS_PRODUCT_PAGES, product.productId) ? NEXUS_PRODUCT_PAGES[product.productId] : null;
	const match = typeof url === 'string' ? NEXUS_PRODUCT_PAGE.exec(url) : null;
	return match && Number(match[1]) === product.productId ? url : null;
}

/** Aktive Covers dieser Wallet fuer genau dieses Produkt (nach productId, nie nach Name). */
function activeProductCovers(product) {
	if (product?.state !== 'MATCHED') return [];
	return (window.dashboardData?.covers ?? []).filter((cover) => cover.productId === product.productId && cover.status === 'active');
}

/*
	Cover-Zuordnung (14.10.2026, nach Rueckmeldung von Nexus Mutual): die Proof of
	Loss bleibt privat; es gibt keinen Lesezugriff fuer Dritte und es wird keiner
	gebraucht. Zugeordnet wird nur aus oeffentlichen Daten und - wo die nicht
	eindeutig sind - durch den Nutzer selbst.

	Einheit ist die erkannte Markt-Position (deploymentKey), nie ein einzelnes
	Asset. Kandidaten sind ausschliesslich: erkannte Positionen, die auf GENAU
	diese productId zeigen, und aktive Covers dieser Wallet mit GENAU dieser
	(numerischen) productId. Nie Name, Betrag, Asset oder Wert.

	  keine aktiven Covers                         -> NO_ACTIVE_COVER
	  1 Position, 1 Cover, alle Maerkte gelesen    -> AUTO_UNAMBIGUOUS
	  sonst (mind. 1 Cover)                        -> USER_CONFIRMATION_REQUIRED
	  vom Nutzer gewaehlt                          -> USER_CONFIRMED

	Ist ein unterstuetzter Markt nicht lesbar, koennte dort eine weitere Position
	liegen: dann nie "eindeutig". Einen von CoverRaccoon bestaetigten Zustand
	gibt es nicht, weil CoverRaccoon die privaten Nexus-Daten nicht kennt.

	Vom Nutzer bestaetigte Zuordnungen speichert der Server (/api/position-attributions),
	gebunden an die Wallet der Sitzung, und liefert nur aktuell gueltige zurueck.
	Hier im Browser liegen davon nur eine Kopie fuer die Anzeige und rein
	vergaengliche Zustaende (Auswahl offen, Anfrage laeuft, Fehler). Abmelden, eine
	andere Wallet oder neu laden setzen die Kopie zurueck. Automatische
	1:1-Zuordnungen werden nie gespeichert.
*/
const ATTRIBUTION = Object.freeze({ AUTO: 'AUTO_UNAMBIGUOUS', REQUIRED: 'USER_CONFIRMATION_REQUIRED', CONFIRMED: 'USER_CONFIRMED', NONE: 'NO_ACTIVE_COVER' });

let attributionStore = { wallet: null, status: 'idle', links: new Map() };
let attributionChooser = null;
let attributionPending = null;
let attributionError = null;

function resetAttributionState() {
	coverPanels = new Map();
	uniswapPanels = new Map();
	attributionStore = { wallet: null, status: 'idle', links: new Map() };
	attributionChooser = null;
	attributionPending = null;
	attributionError = null;
}

/** Gespeicherte Zuordnungen GENAU dieser Wallet; jede andere Wallet bekommt keine. */
function persistedLinksFor(wallet) {
	return wallet && attributionStore.wallet === wallet && attributionStore.status === 'ok' ? attributionStore.links : new Map();
}

/*
	Nexus-Cover-Details und Quote (P3): nur Anzeige ueber POST /api/nexus/quote.
	Das Panel kennt keinen Wallet-Provider; Produkt und Grenzen bestimmt der Server.
*/
let coverPanels = new Map();
// Uniswap v3: ein informatives Quote-Panel je LP-NFT (tokenId), gleiche Route, gleiche Sprache.
let uniswapPanels = new Map();
const nexusQuoteApi = {
	post: (body) => authFetch('/api/nexus/quote', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(25000) })
		.then(async (response) => ({ status: response.status, body: await response.json().catch(() => null) }))
};

function renderCoverDetails(card, position) {
	const key = position.deploymentKey;
	const open = coverPanels.get(key);
	if (open) { card.appendChild(open.element); return; }
	actionButton(card, t.coverDetailsAction, () => {
		const panel = createCoverPanel({ deploymentKey: key, post: nexusQuoteApi.post, language });
		coverPanels.set(key, panel);
		renderPositions();
		panel.load();
	}, 'cover-action cover-details-action');
}

function renderUniswapPositions(list) {
	renderUniswapSection(list, positionsState.data?.uniswapV3, {
		language,
		panelFor: (tokenId) => uniswapPanels.get(tokenId) ?? null,
		openPanel: (tokenId) => {
			const panel = createUniswapPanel({ tokenId, post: nexusQuoteApi.post, language });
			uniswapPanels.set(tokenId, panel);
			renderPositions();
			panel.load();
		}
	});
}

/* Server-Zugriff; die DEV-Fixture ersetzt ihn durch einen Speicher im Arbeitsspeicher. */
let attributionApi = {
	list: () => authFetch('/api/position-attributions', { signal: AbortSignal.timeout(25000) }),
	save: (relation) => authFetch('/api/position-attributions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(relation), signal: AbortSignal.timeout(25000) }),
	remove: (relation) => authFetch('/api/position-attributions', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify(relation), signal: AbortSignal.timeout(25000) })
};

async function loadAttributions(wallet) {
	attributionStore = { wallet, status: 'loading', links: new Map() };
	let body = null;
	let ok = false;
	try {
		const response = await attributionApi.list();
		body = await response.json().catch(() => null);
		ok = response.ok && body?.ok === true && Array.isArray(body.attributions);
	} catch { ok = false; }
	if (attributionStore.wallet !== wallet) return;
	const links = new Map();
	if (ok) {
		for (const entry of body.attributions) {
			if (typeof entry?.deploymentKey !== 'string' || !Number.isSafeInteger(entry.coverId) || entry.source !== 'user_confirmed') continue;
			if (!links.has(entry.deploymentKey)) links.set(entry.deploymentKey, new Set());
			links.get(entry.deploymentKey).add(entry.coverId);
		}
	}
	attributionStore = { wallet, status: ok ? 'ok' : 'error', links };
	renderPositions();
}

function attributionCandidates(product, positions, covers) {
	if (product?.state !== 'MATCHED' || !Number.isSafeInteger(product.productId) || !Array.isArray(covers)) return null;
	const candidatePositions = positions.filter((position) => position.nexus?.state === 'MATCHED' && position.nexus.productId === product.productId
		&& typeof position.deploymentKey === 'string' && (position.supplied?.length || position.borrowed?.length));
	const candidateCovers = covers.filter((cover) => cover.status === 'active' && cover.demo !== true && Number.isSafeInteger(cover.productId) && cover.productId === product.productId && Number.isSafeInteger(cover.coverId));
	return candidatePositions.length ? { candidatePositions, candidateCovers } : null;
}

/** Zustand je Position fuer genau diese Wallet; null, wenn es nichts zuzuordnen gibt. */
function resolveAttribution({ product, positions, covers, complete, wallet, links = new Map() }) {
	const candidates = attributionCandidates(product, positions, covers);
	if (!candidates || !wallet) return null;
	const { candidatePositions, candidateCovers } = candidates;
	const byPosition = new Map();
	if (!candidateCovers.length) {
		for (const position of candidatePositions) byPosition.set(position.deploymentKey, { state: ATTRIBUTION.NONE, covers: [] });
	} else if (candidatePositions.length === 1 && candidateCovers.length === 1 && complete === true) {
		// Live aus oeffentlichen Daten; gespeicherte Bestaetigungen aendern daran nichts.
		byPosition.set(candidatePositions[0].deploymentKey, { state: ATTRIBUTION.AUTO, covers: [candidateCovers[0]] });
	} else {
		for (const position of candidatePositions) {
			const chosen = links.get(position.deploymentKey);
			const confirmed = chosen ? candidateCovers.filter((cover) => chosen.has(cover.coverId)) : [];
			byPosition.set(position.deploymentKey, { state: confirmed.length ? ATTRIBUTION.CONFIRMED : ATTRIBUTION.REQUIRED, covers: confirmed });
		}
	}
	return { candidatePositions, candidateCovers, byPosition, wallet };
}

/** Die aktuelle Zuordnung aus dem Seitenzustand; nur wenn Dashboard und Positionen zur selben Wallet gehoeren. */
function currentAttribution() {
	if (positionsState.status !== 'ok') return null;
	const wallet = String(window.dashboardData?.wallet ?? '').toLowerCase();
	if (!wallet || wallet !== String(positionsState.wallet ?? '').toLowerCase() || String(positionsState.data?.wallet ?? '').toLowerCase() !== wallet) return null;
	const positions = positionsState.data.positions ?? [];
	return resolveAttribution({ product: protocolProduct(positions), positions, covers: window.dashboardData?.covers, complete: positionsState.data.complete, wallet, links: persistedLinksFor(wallet) });
}

/** Ob eine Bestaetigung fuer diese Position gerade angefragt werden darf. */
function assignableEntry(attribution, deploymentKey, coverId) {
	const entry = attribution?.byPosition.get(deploymentKey);
	if (!entry || (entry.state !== ATTRIBUTION.REQUIRED && entry.state !== ATTRIBUTION.CONFIRMED)) return null;
	if (!attribution.candidateCovers.some((cover) => cover.coverId === coverId)) return null;
	if (attributionStore.status !== 'ok' || attributionStore.wallet !== attribution.wallet || attributionPending) return null;
	return entry;
}

/** Nutzer bestaetigt: erst nach erfolgreicher Antwort des Servers gilt sie als bestaetigt. */
async function assignCover(deploymentKey, coverId) {
	const attribution = currentAttribution();
	if (!assignableEntry(attribution, deploymentKey, coverId)) return false;
	const wallet = attribution.wallet;
	attributionPending = deploymentKey;
	attributionError = null;
	renderPositions();
	let saved = false;
	try {
		const response = await attributionApi.save({ deploymentKey, coverId });
		const body = await response.json().catch(() => null);
		saved = response.ok && body?.ok === true && body.attribution?.deploymentKey === deploymentKey && body.attribution?.coverId === coverId && body.attribution?.source === 'user_confirmed';
	} catch { saved = false; }
	if (attributionStore.wallet !== wallet) return false;
	attributionPending = null;
	if (saved) {
		if (!attributionStore.links.has(deploymentKey)) attributionStore.links.set(deploymentKey, new Set());
		attributionStore.links.get(deploymentKey).add(coverId);
		attributionChooser = null;
	} else {
		attributionError = { deploymentKey, text: t.attributionSaveError };
	}
	renderPositions();
	return saved;
}

/** Eine eigene, gespeicherte Bestaetigung entfernen. */
async function removeCoverAssignment(deploymentKey, coverId) {
	const attribution = currentAttribution();
	const entry = attribution?.byPosition.get(deploymentKey);
	if (entry?.state !== ATTRIBUTION.CONFIRMED || !entry.covers.some((cover) => cover.coverId === coverId) || attributionPending) return false;
	const wallet = attribution.wallet;
	attributionPending = deploymentKey;
	attributionError = null;
	renderPositions();
	let removed = false;
	try {
		const response = await attributionApi.remove({ deploymentKey, coverId });
		const body = await response.json().catch(() => null);
		removed = response.ok && body?.ok === true;
	} catch { removed = false; }
	if (attributionStore.wallet !== wallet) return false;
	attributionPending = null;
	if (removed) {
		attributionStore.links.get(deploymentKey)?.delete(coverId);
		if (!attributionStore.links.get(deploymentKey)?.size) attributionStore.links.delete(deploymentKey);
	} else {
		attributionError = { deploymentKey, text: t.attributionRemoveError };
	}
	renderPositions();
	return removed;
}

function coverDaysLeft(iso) {
	const ms = Date.parse(iso) - Date.now();
	return Number.isFinite(ms) ? Math.max(0, Math.ceil(ms / 86_400_000)) : null;
}

function actionButton(parent, label, onClick, className = 'attribution-action') {
	const button = document.createElement('button');
	button.type = 'button';
	button.className = className;
	button.textContent = label;
	button.addEventListener('click', onClick);
	parent.appendChild(button);
	return button;
}

/* Genau eine Nexus-Aktion, auf Protokollebene: ohne aktives Cover hervorgehoben, sonst leise. */
function nexusLink(parent, product, primary) {
	const url = nexusProductUrl(product);
	if (!url) return null;
	const link = document.createElement('a');
	link.href = url;
	link.target = '_blank';
	link.rel = 'noopener noreferrer';
	link.className = primary ? 'nexus-action primary' : 'nexus-action';
	link.textContent = primary ? t.viewCoverAction : t.viewProductAction;
	parent.appendChild(link);
	return link;
}

/** Ein Nexus-Ergebnis fuer das ganze Protokoll: alle gleich und MATCHED, sonst der erste andere Zustand. */
function protocolProduct(positions) {
	const results = positions.map((position) => position.nexus).filter(Boolean);
	if (!results.length) return null;
	return results.find((nexus) => nexus.state !== 'MATCHED' || nexus.productId !== results[0].productId) ?? results[0];
}

function renderSummary(list, positions, unavailableLabels, product, attribution) {
	const card = element(list, 'section', 'protocol-summary');
	const head = element(card, 'div', 'summary-head');
	addTextElement(head, 'h3', 'Aave v3', 'summary-title');
	addTextElement(head, 'span', 'Ethereum', 'summary-chain');
	let supplied = 0n, borrowed = 0n, net = 0n;
	for (const position of positions) {
		supplied += usdUnits(position.totals.suppliedUsd) ?? 0n;
		borrowed += usdUnits(position.totals.debtUsd) ?? 0n;
		net += usdUnits(position.totals.netUsd) ?? 0n;
	}
	const figures = element(card, 'div', 'summary-figures');
	figureRow(figures, t.totalSupplied, unitsToUsd(supplied));
	figureRow(figures, t.totalBorrowed, unitsToUsd(borrowed));
	figureRow(figures, t.netPosition, unitsToUsd(net), t.netHelp);
	if (unavailableLabels.length) {
		const names = unavailableLabels.length === 1 ? unavailableLabels[0] : `${unavailableLabels.slice(0, -1).join(', ')} ${t.listAnd} ${unavailableLabels.at(-1)}`;
		addTextElement(card, 'p', (unavailableLabels.length === 1 ? t.totalsIncompleteOne : t.totalsIncompleteMany).replace('{markets}', names), 'summary-warning');
	}
	if (product) {
		const status = element(card, 'div', 'summary-status');
		const block = element(status, 'div', 'summary-product');
		addTextElement(block, 'small', t.nexusLabel);
		addTextElement(block, 'strong', productText(product), product.state === 'MATCHED' ? 'position-match' : 'position-muted');
		if (product.productId != null && product.productName) addTextElement(block, 'span', `${product.productName} · ${t.productWord} #${product.productId}`, 'summary-product-id');
		if (product.state === 'MATCHED') {
			const wallet = element(status, 'div', 'summary-product');
			addTextElement(wallet, 'small', t.walletCoverStatusLabel);
			const count = activeProductCovers(product).length;
			addTextElement(wallet, 'strong', count === 0 ? t.noActiveCover : count === 1 ? t.coversFoundOne : t.coversFoundMany.replace('{n}', String(count)));
			// Die eine Nexus-Aktion: ohne aktives Cover hervorgehoben, mit Cover leise.
			nexusLink(card, product, count === 0);
			// Die Zuordnungs-Erklaerung steht nur hier, nicht in jeder Karte.
			const states = attribution ? [...attribution.byPosition.values()].map((entry) => entry.state) : [];
			if (states.includes(ATTRIBUTION.AUTO)) addTextElement(card, 'p', t.attributionAutoNote, 'summary-note');
			if (states.includes(ATTRIBUTION.REQUIRED)) {
				addTextElement(card, 'p', `${t.summaryCoverNote} ${t.attributionRequiredNote}`, 'summary-note');
				if (attribution.candidatePositions.length === 1 && attribution.candidateCovers.length === 1) addTextElement(card, 'p', t.attributionIncompleteNote, 'summary-note');
			}
			if (states.includes(ATTRIBUTION.CONFIRMED)) addTextElement(card, 'p', t.attributionConfirmedNote, 'summary-note');
		}
		addTextElement(card, 'p', t.positionsNote, 'summary-note');
	}
}

/*
	Status je Markt, immer dieselben drei Zeilen: Produkt -> Cover in dieser Wallet
	-> Cover-Zuordnung. Betrag und Ablauf stehen nur oben unter "Deine Covers" und
	in der Auswahl; die Karte nennt hoechstens die Nummer des zugeordneten Covers.
*/
function renderMarketStatus(card, position, attribution) {
	const product = position.nexus;
	if (!product) return;
	const box = element(card, 'div', 'market-status');
	figureRow(box, t.cardNexusLabel, product.state === 'MATCHED' ? t.productAvailableShort : productText(product));
	const entry = attribution?.byPosition.get(position.deploymentKey);
	if (product.state !== 'MATCHED' || !entry) return;
	const count = attribution.candidateCovers.length;
	figureRow(box, t.walletCoverLabel, count === 0 ? t.noActiveCover : count === 1 ? t.activeCoverFound : t.activeCoversFound.replace('{n}', String(count)));
	if (entry.state === ATTRIBUTION.NONE) {
		figureRow(box, t.attributionLabel, t.attributionNone);
	} else if (entry.state === ATTRIBUTION.AUTO) {
		figureRow(box, t.attributionLabel, t.attributionAuto, t.attributionAutoHelp).className += ' attribution-auto';
	} else if (entry.state === ATTRIBUTION.CONFIRMED) {
		figureRow(box, t.attributionLabel, `${t.attributionConfirmed} · ${entry.covers.map((cover) => `Cover #${cover.coverId}`).join(', ')}`, t.attributionConfirmedHelp).className += ' attribution-confirmed';
		const actions = element(box, 'div', 'attribution-actions');
		actionButton(actions, t.changeAssignment, () => { attributionChooser = position.deploymentKey; attributionError = null; renderPositions(); }).disabled = Boolean(attributionPending);
		if (entry.covers.length === 1) actionButton(actions, t.removeAssignment, () => removeCoverAssignment(position.deploymentKey, entry.covers[0].coverId)).disabled = Boolean(attributionPending);
	} else {
		figureRow(box, t.attributionLabel, t.attributionRequired).className += ' attribution-required';
		if (attributionChooser !== position.deploymentKey) {
			const open = actionButton(box, t.assignAction, () => { attributionChooser = position.deploymentKey; attributionError = null; renderPositions(); });
			open.ariaExpanded = 'false';
			open.disabled = attributionStore.status !== 'ok' || Boolean(attributionPending);
		}
		if (attributionStore.status === 'error') addTextElement(box, 'p', t.attributionLoadError, 'attribution-error');
	}
	if (attributionError?.deploymentKey === position.deploymentKey) addTextElement(box, 'p', attributionError.text, 'attribution-error');
	if (attributionChooser === position.deploymentKey && (entry.state === ATTRIBUTION.REQUIRED || entry.state === ATTRIBUTION.CONFIRMED)) renderCoverChooser(box, position, attribution, entry);
}

/** Nur die Kandidaten-Covers (exakte productId, aktiv) mit ihren oeffentlichen Daten. */
function renderCoverChooser(parent, position, attribution, entry) {
	const chooser = element(parent, 'div', 'attribution-chooser');
	addTextElement(chooser, 'p', t.assignIntro.replace('{id}', String(position.nexus.productId)), 'attribution-intro');
	for (const cover of attribution.candidateCovers) {
		const option = element(chooser, 'div', 'attribution-option');
		addTextElement(option, 'strong', `Cover #${cover.coverId}`, 'attribution-option-id');
		addTextElement(option, 'span', `${cover.productName ?? t.productWord} · ${t.productWord} #${cover.productId}`, 'attribution-option-product');
		addTextElement(option, 'span', `${formatAmount(cover.amount)} ${cover.asset?.symbol ?? ''}`.trim(), 'attribution-option-amount');
		const days = coverDaysLeft(cover.endsAt);
		addTextElement(option, 'span', `${t.expiry} ${formatDate(cover.endsAt)}${days == null ? '' : ` · ${t.daysLeft.replace('{n}', String(days))}`}`, 'attribution-option-expiry');
		const busy = Boolean(attributionPending) || attributionStore.status !== 'ok';
		if (entry.covers.some((chosen) => chosen.coverId === cover.coverId)) {
			addTextElement(option, 'small', t.assignedCover, 'attribution-option-current');
			actionButton(option, t.removeAssignment, () => removeCoverAssignment(position.deploymentKey, cover.coverId)).disabled = busy;
		} else {
			actionButton(option, t.assignThisCover, () => assignCover(position.deploymentKey, cover.coverId)).disabled = busy;
		}
	}
	if (attributionPending === position.deploymentKey) addTextElement(chooser, 'p', t.attributionSaving, 'attribution-intro');
	actionButton(chooser, t.assignCancel, () => { attributionChooser = null; renderPositions(); }, 'attribution-action quiet');
}

function renderMarketCard(parent, position, attribution) {
	const card = element(parent, 'article', 'position-card');
	addTextElement(card, 'h3', `Aave v3 · ${position.label}`, 'position-title');
	addTextElement(card, 'small', t.detectedPosition, 'position-kicker');
	assetGroup(card, t.supplied, position.supplied, true);
	assetGroup(card, t.borrowed, position.borrowed, false);
	const figures = element(card, 'div', 'position-figures');
	figureRow(figures, t.netPosition, formatUsd(position.totals.netUsd), t.netHelp);
	figureRow(figures, t.healthFactor, position.totals.healthFactor == null ? t.noDebt : formatAmount(position.totals.healthFactor));
	renderMarketStatus(card, position, attribution);
	if (position.nexus?.state === 'MATCHED') renderCoverDetails(card, position);
}

function renderUnavailableCard(parent, market) {
	const card = element(parent, 'article', 'position-card position-unavailable');
	addTextElement(card, 'h3', `Aave v3 · ${market.label}`, 'position-title');
	// Als Text, nicht nur als Farbe oder Rahmen: kein Null-Saldo, keine leere Position.
	figureRow(card, t.status, t.notAvailable).className += ' unavailable-status';
	addTextElement(card, 'small', t.marketUnavailableHelp, 'unavailable-help');
}

/*
	"Deine Covers" (oben) ist die einzige Cover-Liste. Jede aktive Cover-Karte dort
	hat einen leeren Platz fuer die Cover-Zuordnung; gefuellt wird er nur fuer
	Kandidaten-Covers (exakte productId, aktiv) und nur, wenn Positionen dafuer
	erkannt sind.
*/
let coverAttributionSlots = [];

function renderCoverAttributions(attribution) {
	for (const { cover, slot } of coverAttributionSlots) {
		slot.replaceChildren();
		const candidate = attribution?.candidateCovers.find((entry) => entry.coverId === cover.coverId && entry.productId === cover.productId);
		slot.hidden = !candidate;
		if (!candidate) continue;
		const entries = [...attribution.byPosition.entries()].filter(([, entry]) => entry.covers.some((chosen) => chosen.coverId === cover.coverId));
		const label = (key) => attribution.candidatePositions.find((position) => position.deploymentKey === key)?.label ?? '';
		addTextElement(slot, 'small', t.attributionLabel);
		if (entries.some(([, entry]) => entry.state === ATTRIBUTION.AUTO)) {
			addTextElement(slot, 'strong', `${t.attributionAuto} · Aave v3 · ${label(entries[0][0])}`, 'attribution-auto');
		} else if (entries.length) {
			addTextElement(slot, 'strong', `${t.attributionConfirmed} · ${entries.map(([key]) => label(key)).join(', ')}`, 'attribution-confirmed');
		} else {
			addTextElement(slot, 'strong', t.attributionRequired, 'attribution-required');
		}
	}
}

/*
	Dashboard-Schale (web/src/dashboard-shell.js, 20.10.2026): Uebersicht,
	Positionstabelle, Covers, Agent und Einstellungen. Sie liest denselben
	Seitenzustand und wird bei jeder Darstellung der Positionen neu gezeichnet;
	gesetzt wird sie erst beim Start der Seite. Ein Fehler darin laesst das
	Dashboard selbst stehen.
*/
let shellRenderer = null;
function refreshShell() {
	if (!shellRenderer) return;
	try { shellRenderer(); } catch (error) { console.error('dashboard shell', error); }
}

function renderPositions() {
	refreshShell();
	const list = document.querySelector('#position-list');
	if (!list) return;
	document.querySelector('#positions-title').textContent = t.positionsTitle;
	document.querySelector('#positions-checked').textContent = positionsState.status === 'ok' ? t.positionsChecked : '';
	list.replaceChildren();
	renderCoverAttributions(null);
	if (positionsState.status === 'loading' || positionsState.status === 'idle') { addTextElement(list, 'div', t.positionsLoading, 'dash-empty'); return; }
	if (positionsState.status !== 'ok') { addTextElement(list, 'div', t.positionsError, 'dash-empty position-error'); return; }
	const { positions = [], checkedDeployments = [] } = positionsState.data;
	const unavailable = checkedDeployments.filter((entry) => entry.status !== 'OK');
	const readMarkets = checkedDeployments.length - unavailable.length;
	if (!readMarkets) {
		// Kein Markt lesbar: keine Summen, die wie "null" aussehen.
		addTextElement(list, 'div', t.allMarketsUnavailable, 'dash-empty position-error');
	} else if (!positions.length && !unavailable.length) {
		addTextElement(list, 'div', t.positionsNone, 'dash-empty');
	} else {
		const product = protocolProduct(positions);
		const attribution = currentAttribution();
		if (positions.length) renderSummary(list, positions, unavailable.map((entry) => entry.label), product, attribution);
		// Eyebrow, keine Ueberschrift: die Marktkarten (h3) stehen direkt unter "DeFi-Positionen" (h2).
		addTextElement(list, 'p', t.positionsHeading, 'positions-subheading');
		const grid = element(list, 'div', 'position-grid');
		for (const position of positions) renderMarketCard(grid, position, attribution);
		for (const market of unavailable) renderUnavailableCard(grid, market);
		if (!positions.length) addTextElement(list, 'p', t.positionsNone, 'position-muted');
		if (positions.length) renderCoverAttributions(attribution);
	}
	addTextElement(list, 'p', t.positionsSource, 'position-source');
	// Eigener Abschnitt, nie mit Aave zusammengelegt; faellt er aus, bleibt Aave stehen.
	renderUniswapPositions(list);
}

function renderDashboard(data) {
	window.dashboardData = data;
	document.body.classList.add('dashboard-mode');
	mountEye(document.querySelector('#dash-eye'));
	document.querySelector('#dash-wallet').textContent = shortWallet(data.wallet);
	const active = data.covers.filter((cover) => cover.status === 'active');
	const next = active.filter((cover) => cover.endsAt).sort((a, b) => Date.parse(a.endsAt) - Date.parse(b.endsAt))[0];
	document.querySelector('#metric-active').textContent = active.length ? `${active.length} ${t.active}` : t.noCover;
	document.querySelector('#metric-expiry').textContent = next ? `${daysUntil(next.endsAt)} ${t.days}` : '—';
	document.querySelector('#metric-telegram').textContent = data.telegramLinked ? t.telegramActive : t.notConnected;
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
	// Derselbe Telegram-Link auch auf der Agent-Seite (#agent-action); deren Text setzt die Dashboard-Schale.
	const agentAction = document.querySelector('#agent-action');
	if (config.telegramUsername) {
		for (const action of [telegramAction, agentAction].filter(Boolean)) {
			action.hidden = false;
			action.href = data.telegramLinked
				? `https://t.me/${config.telegramUsername}`
				: `https://t.me/${config.telegramUsername}?start=connect`;
			action.target = '_blank';
			action.rel = 'noopener';
		}
		telegramAction.textContent = data.telegramLinked ? t.openTelegram : t.connectTelegram;
		telegramAction.classList.toggle('primary', !data.telegramLinked);
	} else {
		telegramAction.hidden = true;
		if (agentAction) agentAction.hidden = true;
	}
	document.querySelector('#checked-at').textContent = `${t.updated} ${new Intl.DateTimeFormat(language === 'de' ? 'de-AT' : 'en-GB', { hour: '2-digit', minute: '2-digit' }).format(new Date(data.checkedAt))}`;
	const list = document.querySelector('#cover-list');
	list.replaceChildren();
	coverAttributionSlots = [];
	if (!active.length) addTextElement(list, 'div', t.empty, 'dash-empty');
	for (const cover of active) {
		const card = document.createElement('article'); card.className = 'cover-card';
		const name = document.createElement('div'); name.className = 'cover-name';
		addTextElement(name, 'small', t.product);
		addTextElement(name, 'strong', cover.productName ?? `Nexus product #${cover.productId}`);
		const coverId = addTextElement(name, 'small', `Cover #${cover.coverId}`); coverId.style.marginTop = '8px';
		card.appendChild(name);
		const amount = document.createElement('div'); addTextElement(amount, 'small', t.protectionAmount);
		addTextElement(amount, 'strong', `${formatAmount(cover.amount)} ${cover.asset?.symbol ?? ''}`.trim()); card.appendChild(amount);
		const expiry = document.createElement('div'); addTextElement(expiry, 'small', t.expiry); addTextElement(expiry, 'strong', formatDate(cover.endsAt));
		const left = coverDaysLeft(cover.endsAt);
		if (left !== null) addTextElement(expiry, 'small', t.daysLeft.replace('{n}', String(left)), 'cover-remaining');
		card.appendChild(expiry);
		const state = document.createElement('div'); addTextElement(state, 'small', t.status); addTextElement(state, 'strong', `● ${t.active}`, 'active-state'); card.appendChild(state);
		card.appendChild(document.createElement('span'));
		// Cover-Zuordnung: gefuellt von renderCoverAttributions, sobald Positionen da sind.
		const attribution = document.createElement('div'); attribution.className = 'cover-attribution'; attribution.hidden = true; card.appendChild(attribution);
		coverAttributionSlots.push({ cover, slot: attribution });
		list.appendChild(card);
	}
	const owner = String(data.wallet).toLowerCase();
	if (positionsState.wallet !== owner) loadPositions(owner); else renderPositions();
	const actions = document.querySelector('#dash-actions'); actions.replaceChildren();
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

async function openDashboard(wallet, sign, isAborted = () => false) {
	if (expectedWallet && String(wallet).toLowerCase() !== expectedWallet) {
		throw new Error(language === 'de'
			? `Diese Wallet passt nicht zum Dashboard-Link. Erwartet wird ${shortWallet(expectedWallet)}. Wechsle die Wallet oder fordere in Telegram einen neuen Link an.`
			: `This wallet does not match the dashboard link. Expected ${shortWallet(expectedWallet)}. Switch wallet or request a new link in Telegram.`);
	}
	show('Persönlicher Bereich wird vorbereitet …');
	// AGENT-UX-5: an jeder Grenze (vor Challenge, vor Signatur, vor POST) auf
	// chainChanged-Abbruch pruefen. WalletConnect uebergibt kein isAborted -> no-op.
	const dashboard = await guardedChallengeSignSubmit({
		isAborted,
		texts: eoaLoginTexts(language),
		getChallenge: async () => {
			const challenge = await fetch(`/api/dashboard?wallet=${encodeURIComponent(wallet)}`, { signal: AbortSignal.timeout(15000) }).then((res) => res.json());
			debugWallet('Challenge geholt', { ok: challenge.ok, laenge: challenge.message?.length, fehler: challenge.error });
			return challenge;
		},
		sign: async (message) => {
			show('Bitte bestätige die Signatur in deiner Wallet …');
			debugWallet('Signatur wird angefordert');
			const signature = await sign(message);
			debugWallet('Signatur erhalten', { laenge: signature?.length });
			return signature;
		},
		submit: async (challenge, signature) => {
			show('Cover-Daten werden geladen …');
			// META-AUDIT M-3, Modus B: '0x' heisst, Safe{Wallet} hat eine SignMessageLib-
			// On-chain-Bestaetigung vorgeschlagen. Dann nur noch read-only abfragen.
			return submitDashboardLogin({
				wallet, token: challenge.token, signature, fetchFn: fetch,
				onPending: () => show(language === 'de'
					? 'Safe hat eine On-chain-Bestätigung (SignMessageLib) vorgeschlagen. Sobald die Owner sie ausgeführt haben, wirst du automatisch angemeldet. CoverRaccoon fragt dafür nur lesend ab.'
					: 'Safe proposed an on-chain confirmation (SignMessageLib). Once the owners have executed it, you are signed in automatically. CoverRaccoon only reads to check.')
			});
		}
	});
	await configPromise;
	renderDashboard(dashboard);
}

async function finish(wallet, sign, isAborted = () => false) {
	if (!code) return openDashboard(wallet, sign, isAborted);
	show('Signaturnachricht wird vorbereitet …');
	// AGENT-UX-5: dieselbe abbrechbare Sequenz fuer den Telegram-Link-Flow.
	await guardedChallengeSignSubmit({
		isAborted,
		texts: eoaLoginTexts(language),
		getChallenge: () => fetch(`/api/link?code=${encodeURIComponent(code)}&wallet=${encodeURIComponent(wallet)}`).then((res) => res.json()),
		sign,
		submit: async (details, signature) => {
			show('Signatur wird geprüft …');
			const verified = await fetch('/api/link/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, wallet, signature }) }).then((res) => res.json());
			if (!verified.ok) throw new Error(verified.error);
			return verified;
		}
	});
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

/*
	Verknuepfungsmodus: vor dem Signieren zeigen, mit WELCHEM Telegram-Konto die
	Wallet verbunden wird. Ein fremder Link ("bitte kurz bestaetigen") faellt so
	auf, bevor jemand seine Wallet an einen fremden Chat haengt.
*/
async function zeigeTelegramKonto() {
	const feld = document.querySelector('#link-account');
	if (!code || !feld) return;
	const de = language === 'de';
	const info = await fetch(`/api/link?code=${encodeURIComponent(code)}`).then((res) => res.json()).catch(() => null);
	feld.replaceChildren();
	if (!info?.ok) {
		feld.classList.add('warn');
		feld.textContent = info?.error || (de ? 'Der Verknüpfungslink konnte nicht geprüft werden.' : 'The link could not be checked.');
		feld.hidden = false;
		return;
	}
	const konto = info.telegram;
	if (!konto) {
		feld.classList.add('warn');
		feld.textContent = de
			? 'Das Telegram-Konto zu diesem Link ließ sich nicht anzeigen. Verbinde nur, wenn du den Link gerade selbst im Raccoon-Agent-Bot angefordert hast.'
			: 'The Telegram account for this link could not be shown. Only connect if you just requested this link yourself in the Raccoon Agent bot.';
		feld.hidden = false;
		return;
	}
	// AUDIT E-L2: genau die Kennung, die auch im signierten Text steht ("for Telegram ...").
	const kennung = typeof konto.target === 'string' ? konto.target : '';
	const anzeige = konto.username && konto.name ? `${kennung} (${konto.name})` : kennung;
	feld.append(document.createTextNode(de ? 'Deine Wallet wird mit diesem Telegram-Konto verknüpft: ' : 'Your wallet will be linked to this Telegram account: '));
	const fett = document.createElement('strong');
	fett.textContent = anzeige;
	feld.append(fett, document.createTextNode(de
		? `. Dieselbe Angabe („for Telegram ${kennung}“) steht in der Nachricht, die deine Wallet zum Signieren zeigt. Ist das nicht dein eigenes Konto, brich hier ab.`
		: `. The same detail ("for Telegram ${kennung}") appears in the message your wallet asks you to sign. If this is not your own account, stop here.`));
	feld.hidden = false;
}
zeigeTelegramKonto();

/*
	Anmeldung pausiert (src/pause.mjs, ueber /api/config gemeldet): statt der
	Knoepfe steht ein Hinweis. Der Server lehnt neue Anmeldungen ohnehin ab;
	das hier erspart nur den Klick ins Leere. Eine bestehende Sitzung zeigt
	weiter das Dashboard.
*/
function zeigeAnmeldungPausiert() {
	const hinweis = document.querySelector('#login-paused');
	if (!hinweis) return;
	hinweis.textContent = language === 'de'
		? (code ? 'Das Verknüpfen neuer Wallets ist derzeit pausiert. Bereits verbundene Wallets werden weiter überwacht.' : 'Neue Anmeldungen sind derzeit pausiert. Bereits verbundene Wallets werden weiter überwacht.')
		: (code ? 'Connecting new wallets is paused for now. Wallets that are already connected keep being monitored.' : 'New sign-ins are paused for now. Wallets that are already connected keep being monitored.');
	hinweis.hidden = false;
	for (const auswahl of ['.actions', '.security', '.verify', '#link-account']) {
		const element = document.querySelector(auswahl);
		if (element) element.hidden = true;
	}
}
configPromise.then(() => { if (config.anmeldungPausiert) zeigeAnmeldungPausiert(); }).catch(() => {});

/*
	AGENT-SEC-W3: dasselbe wie W2, fuer die Browser-Erweiterung. Dort gibt es
	keine WalletConnect-Sitzung, aber die Erweiterung merkt sich die Seite als
	"verbunden" - und eine verbundene Seite darf ohne neue Rueckfrage Konten
	lesen und Anfragen stellen. Nach der Signatur wird diese Freigabe wieder
	entzogen (EIP-2255, von MetaMask unterstuetzt). Wallets, die das nicht
	kennen, lehnen ab; das wird still hingenommen, der Login ist dann trotzdem
	gueltig. Folge: beim naechsten Login fragt die Erweiterung wieder, ob sie
	sich verbinden soll. Das ist gewollt.
*/
async function trenneBrowserWallet() {
	try {
		await withTimeout(window.ethereum.request({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] }), 5000, 'revoke timeout');
		debugWallet('Browser-Wallet-Freigabe entzogen');
	} catch (error) {
		debugWallet('Browser-Wallet-Freigabe nicht entzogen', error?.message ?? error);
	}
}

/*
	AGENT-UX-5: der EOA-Login ist an Chain ID 1 gebunden (SIWE), aber eine
	Browser-Erweiterung zeigt beim `personal_sign` das gerade gewaehlte Netz an
	(z. B. Polygon). Deshalb VOR der Challenge auf Ethereum Mainnet stellen und
	den aktiven Account danach erneut lesen (ensureMainnetAccount). Nur der
	injizierte Pfad: WalletConnect ist ueber AppKit `networks:[mainnet]` ohnehin
	auf eip155:1 ausgehandelt, der native Safe-App-Pfad laeuft nicht hierueber.
	Ein chainChanged auf Nicht-Mainnet waehrend des Versuchs entwertet ihn; der
	Listener gilt nur fuer diesen Versuch und wird im finally entfernt.
*/
async function verbindeBrowserWallet() {
	if (!hinweiseAkzeptiert) return;
	let verbunden = false;
	let abgebrochen = false;
	const beiChainChanged = (cid) => { if (cid !== '0x1') abgebrochen = true; };
	try {
		if (!window.ethereum) throw new Error('Keine Browser-Wallet gefunden. Nutze „Connect mobile wallet“.');
		show('Browser-Wallet wird verbunden …');
		const [wallet] = await window.ethereum.request({ method: 'eth_requestAccounts' });
		verbunden = true;
		window.ethereum.on?.('chainChanged', beiChainChanged);
		const texts = eoaLoginTexts(language);
		const konto = await ensureMainnetAccount(window.ethereum, wallet, { texts, isAborted: () => abgebrochen });
		// Signer faellt fail closed: kein personal_sign bei Abbruch, und unmittelbar
		// vor dem Signieren noch einmal eth_chainId === 0x1 verlangen.
		const signiere = async (message) => {
			if (abgebrochen) throw new Error(texts.chainChanged);
			const cid = await window.ethereum.request({ method: 'eth_chainId' }).catch(() => null);
			if (cid !== '0x1') throw new Error(texts.notMainnet);
			return window.ethereum.request({ method: 'personal_sign', params: [message, konto] });
		};
		await finish(konto, signiere, () => abgebrochen);
	} catch (error) { show(error.message); } finally {
		window.ethereum?.removeListener?.('chainChanged', beiChainChanged);
		if (verbunden) await trenneBrowserWallet();
	}
}
injectedButton.addEventListener('click', () => mitHinweisen(verbindeBrowserWallet));

let appKitMainnet = null;
async function setupWalletConnect() {
	const [{ createAppKit }, { EthersAdapter }, { mainnet }] = await Promise.all([import('@reown/appkit'), import('@reown/appkit-adapter-ethers'), import('@reown/appkit/networks')]);
	appKitMainnet = mainnet; // fuer switchNetwork im WC-Login (AGENT-UX-5)
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
	/*
		basic: true schaltet die Fern-Konfiguration ab. Ohne sie holt AppKit beim
		Start /appkit/v1/config von api.web3modal.org, und was dort im Reown-Dashboard
		steht, ueberschreibt die `features` unten (ConfigUtil.processFeature); scheitert
		die Verarbeitung, gelten Reowns Vorgaben mit E-Mail- und Social-Login. Beides
		erzeugt das eingebettete Reown-Wallet (W3mFrameProvider), dessen message-
		Listener fremde postMessage-Daten ohne Origin-Pruefung mit zod 3.22.4 parsen
		(GHSA-mrhx-c7xc-m3w5). Mit basic bleibt remoteFeatures leer, das eingebettete
		Wallet entsteht nie - unabhaengig vom Dashboard. Die Wallet-Liste zeigt dann
		nur Wallets mit WalletConnect-Unterstuetzung; der Browser-Wallet-Knopf laeuft
		ohnehin nicht ueber AppKit.
	*/
	const modal = createAppKit({ universalProviderConfigOverride: appKitMethoden(WALLET_METHODEN_ANMELDEN), themeVariables: { '--apkt-font-family': "'Satoshi', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif" }, adapters: [new EthersAdapter()], networks: [mainnet], projectId: config.reownProjectId, metadata: { name: 'Raccoon Agent', description: 'Personal DeFi cover monitoring', url: location.origin, icons: [`${location.origin}/holo-raccoon.svg`] }, allWallets: 'SHOW', enableCoinbase: false, basic: true, features: { analytics: false, email: false, socials: [], send: false, receive: false, swaps: false, onramp: false }, debug: walletDebug });
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

/*
	AGENT-SEC-W2: nach der Signatur wird die WalletConnect-Sitzung getrennt,
	egal ob die Anmeldung geklappt hat. Angemeldet bleibt man ueber das
	Sitzungscookie; die Wallet wird nur fuer die eine Signatur gebraucht.

	Grund: die Methodenliste aus W1 ist nur eine Bitte. MetaMask Mobile
	genehmigt trotzdem seine volle Liste, das Senden von Transaktionen
	eingeschlossen (am 30.09.2026 in der ausgehandelten Sitzung nachgesehen). Eine Sitzung, die
	nach dem Login offen bleibt, traegt diese Rechte also weiter. Eine getrennte
	traegt gar keine.
*/
async function trenneWalletConnect(modal) {
	if (!modal?.getAddress()) return;
	debugWallet('Trenne WalletConnect nach der Signatur');
	try { await withTimeout(modal.disconnect(), 5000, 'disconnect timeout'); } catch {}
}

async function verbindeWalletConnect() {
	if (!hinweiseAkzeptiert) return;
	let modal;
	try {
		debugWallet('Connect clicked');
		wcButton.disabled = true;
		show('Wallet-Auswahl wird geladen …');
		await dashboardRestorePromise;
		modal = await getWalletConnectModal();
		if (modal.getAddress()) {
			debugWallet('Clearing restored account before new login', modal.getAddress());
			show('Wallet-Auswahl wird vorbereitet …');
			await resetRestoredConnection(modal);
		}
		const { wallet, provider } = await connectWithModal(modal);
		debugWallet('Account received', wallet);
		const texts = eoaLoginTexts(language);
		// AGENT-UX-5: Wallet IMMER auf Ethereum Mainnet synchronisieren (auch wenn
		// AppKit die Chain schon als 1 meldet - MetaMask kann visuell auf Polygon
		// stehen). switchNetwork reicht wallet_switchEthereumChain an die Wallet.
		show(language === 'de' ? 'Bitte Ethereum Mainnet in der Wallet bestätigen …' : 'Please confirm Ethereum Mainnet in your wallet …');
		const konto = await ensureAppKitMainnetAccount({ modal, network: appKitMainnet, expectedAddress: wallet, texts });
		// Race: ein Netzwechsel waehrend des laufenden Versuchs entwertet ihn.
		let abgebrochen = false;
		const unsubscribe = modal.subscribeNetwork?.((state) => { const id = state?.chainId; if (id !== undefined && Number(id) !== 1) abgebrochen = true; });
		try {
			const signiere = async (message) => {
				if (abgebrochen) throw new Error(texts.chainChanged);
				if (Number(modal.getChainId()) !== 1) throw new Error(texts.notMainnet); // finaler Pre-Sign-Check (defense in depth)
				const current = normalizeAddress(modal.getAddress());
				if (!current || current !== konto) throw new Error(texts.accountChanged);
				return withTimeout(provider.request({ method: 'personal_sign', params: [message, konto] }), 60000, 'Die Wallet hat nicht auf die Signaturanfrage reagiert.');
			};
			await finish(konto, signiere, () => abgebrochen);
		} finally {
			unsubscribe?.();
		}
	} catch (error) {
		debugWallet('Connection error', error);
		show(error.message);
	} finally {
		await trenneWalletConnect(modal);
		wcButton.disabled = false;
	}
}
wcButton.addEventListener('click', () => mitHinweisen(verbindeWalletConnect));

/*
	AUDIT SA-L1, 14.10.2026: frische Bestaetigung fuer destruktive Aktionen einer
	Contract-Wallet (Safe). Der SERVER sagt, ob sie noetig ist (Sitzungsart); fuer
	EOA-Sitzungen kommt "nicht noetig" zurueck und es gibt keine neue Signatur.
	Sonst: sichtbare Rueckfrage, dann signiert die Safe den serverseitigen Text -
	in der Safe App off-chain (signSafeMessage), sonst ueber WalletConnect mit
	personal_sign. Keine Transaktion, kein Typed Data, keine weitere Methode.
	Rueckgabe: null = nicht noetig, false = abgelehnt, sonst { token, signature }.
*/
let safeContext = null;
async function frischeBestaetigung(purpose) {
	const de = language === 'de';
	const response = await authFetch('/api/dashboard', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: purpose }) });
	const challenge = await response.json().catch(() => null);
	if (!response.ok || !challenge?.ok) throw new Error(challenge?.error || (de ? 'Die Bestätigung konnte nicht vorbereitet werden.' : 'The confirmation could not be prepared.'));
	if (challenge.freshSignatureRequired !== true) return null;
	const was = purpose === 'session-revoke'
		? (de ? 'die Abmeldung auf allen Geräten' : 'signing out on all devices')
		: (de ? 'das Trennen der Telegram-Benachrichtigungen' : 'disconnecting Telegram notifications');
	if (!confirm(de
		? `Bitte bestätige ${was} mit deiner Safe. CoverRaccoon fragt nur eine Signatur an, keine Transaktion: keine Übertragung, keine Token-Freigabe. Diese Aktion braucht eine Off-chain-Signatur. Macht Safe{Wallet} daraus eine SignMessageLib-On-chain-Bestätigung (Gas, kein Wert, keine Freigabe), wird die Aktion nicht ausgeführt - lehne sie dann ab.`
		: `Please confirm ${was} with your Safe. CoverRaccoon only requests a signature, not a transaction: no transfer, no token approval. This action needs an off-chain signature. If Safe{Wallet} turns it into a SignMessageLib on-chain confirmation (gas, no value, no approval), the action is not carried out - reject it in that case.`)) return false;
	const signature = safeContext
		? await (await import('./safe-app.js')).signSafeMessage({ sdk: safeContext.sdk, message: challenge.message, threshold: safeContext.info?.threshold, onState: renderSafeState, pollTimeoutMs: 5 * 60_000 })
		: await signiereMitWalletConnect(window.dashboardData?.wallet, challenge.message);
	return { token: challenge.token, signature };
}

/** Eine einzelne Signatur ueber WalletConnect fuer genau die angemeldete Wallet; danach wird getrennt. */
async function signiereMitWalletConnect(expectedWallet, message) {
	const texts = eoaLoginTexts(language);
	const expected = normalizeAddress(expectedWallet);
	if (!expected) throw new Error(texts.accountChanged);
	let modal;
	try {
		modal = await getWalletConnectModal();
		if (modal.getAddress()) await resetRestoredConnection(modal);
		const { wallet, provider } = await connectWithModal(modal);
		const konto = await ensureAppKitMainnetAccount({ modal, network: appKitMainnet, expectedAddress: wallet, texts });
		// Nur die angemeldete Wallet, nur Mainnet - sonst keine Signaturanfrage.
		if (konto !== expected || normalizeAddress(modal.getAddress()) !== expected) throw new Error(texts.accountChanged);
		if (Number(modal.getChainId()) !== 1) throw new Error(texts.notMainnet);
		return await withTimeout(provider.request({ method: 'personal_sign', params: [message, konto] }), 5 * 60_000, language === 'de' ? 'Die Wallet hat nicht auf die Signaturanfrage reagiert.' : 'The wallet did not respond to the signature request.');
	} finally {
		await trenneWalletConnect(modal);
	}
}

async function endSession({ disconnect = false } = {}) {
	if (disconnect) show('Wallet-Verbindung wird getrennt …');
	// AUDIT SA-L1: Safe -> "ueberall abmelden" nur mit frischer Bestaetigung. Lehnt
	// jemand ab oder scheitert sie, wird nur DIESES Geraet abgemeldet.
	let authorization = null;
	try { authorization = await frischeBestaetigung('session-revoke'); } catch (error) { debugWallet('Frische Bestaetigung nicht erhalten', error?.message ?? error); authorization = false; }
	try {
		const response = await authFetch('/api/dashboard', authorization ? { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify(authorization) } : { method: 'DELETE' });
		const result = await response.json();
		if (!response.ok || result.ok !== true) throw new Error('Logout failed');
	} catch {
		show(language === 'de' ? 'Abmeldung konnte nicht abgeschlossen werden. Bitte erneut versuchen.' : 'Sign-out could not be completed. Please retry.');
		return;
	}
	if (disconnect) {
		if (walletConnectPromise) {
			try { const modal = await walletConnectPromise; if (modal.getAddress()) await withTimeout(modal.disconnect(), 5000, 'disconnect timeout'); } catch {}
		}
		await clearWalletStorage();
		location.reload();
		return;
	}
	window.dashboardData = null; positionsState = { wallet: null, status: 'idle', data: null }; resetAttributionState(); document.body.classList.remove('dashboard-mode'); status.textContent = ''; enable(); applyLanguage(language);
}
function enable() { wcButton.disabled = false; injectedButton.disabled = false; }
async function disconnectTelegram() {
	if (!confirm(t.confirmDisconnect)) return;
	// AUDIT SA-L1: Safe -> nur mit frischer Bestaetigung fuer genau diese Aktion.
	let authorization;
	try { authorization = await frischeBestaetigung('telegram-disconnect'); } catch (error) { return show(error.message); }
	if (authorization === false) return;
	const response = await authFetch('/api/dashboard?telegram=1', authorization ? { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify(authorization) } : { method: 'DELETE' });
	const result = await response.json(); if (!result.ok) return show(result.error);
	if (window.dashboardData) renderDashboard({ ...window.dashboardData, telegramLinked: false, telegramStartCode: null });
	await restoreDashboard();
}
document.querySelector('#logout').addEventListener('click', () => endSession({ disconnect: true }));
document.querySelector('#switch-wallet').addEventListener('click', () => endSession({ disconnect: true }));

async function restoreDashboard() {
	if (code) return;
	try {
		if (access) {
			// AGENT-SEC-A2: der Code verlaesst die sichtbare URL SOFORT, vor dem
			// Netzaufruf. Er wird nirgends gespeichert.
			// AGENT-AUTH-002: eingeloest wird der Code per POST (same-origin, JSON),
			// nicht mehr per GET - ein GET darf keinen Einmalcode verbrauchen. Es
			// entsteht weiterhin KEINE Session: zurueck kommt nur die erwartete
			// Wallet, angemeldet wird ueber den bestehenden Signaturflow.
			history.replaceState({}, '', '/');
			const response = await fetch('/api/dashboard', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ access }),
				signal: AbortSignal.timeout(10000)
			});
			const handoff = await response.json().catch(() => ({}));
			if (!response.ok) {
				show(handoff.error || (language === 'de' ? 'Der Dashboard-Link ist abgelaufen. Öffne /dashboard erneut in Telegram.' : 'The dashboard link has expired. Open /dashboard again in Telegram.'));
				return;
			}
			if (handoff.code === 'WALLET_SIGNATURE_REQUIRED' && typeof handoff.wallet === 'string') {
				expectedWallet = handoff.wallet.toLowerCase();
				show(language === 'de'
					? `Verbinde ${shortWallet(expectedWallet)} und signiere die Anmeldung. Es ist keine Transaktion.`
					: `Connect ${shortWallet(expectedWallet)} and sign in. This is not a transaction.`);
			}
			return;
		}
		const response = await fetch('/api/dashboard', { signal: AbortSignal.timeout(10000) });
		if (!response.ok) {
			const failure = await response.json().catch(() => ({}));
			if (failure.code === 'SESSION_REVOKED' || failure.code === 'NO_SESSION') {
				await withTimeout(clearWalletStorage(), 1500, 'wallet cleanup timeout').catch(() => {});
			}
			return;
		}
		const dashboard = await response.json();
		if (!dashboard.ok) {
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

/*
	Safe-App-Pfad. Nur versucht, wenn CoverRaccoon in einem iframe laeuft (Safe
	Apps laufen eingebettet). Top-Level-Browser laden das Safe-SDK nie. Erkennung
	ist reine UX/Routing - die Identitaet entscheidet serverseitig ERC-1271.
*/
function renderSafeState(state, detail = {}) {
	const de = language === 'de';
	const n = detail.threshold;
	switch (state) {
		case 'SAFE_CONTEXT_DETECTED': show(de ? 'Safe erkannt.' : 'Safe detected.'); break;
		case 'CHALLENGE_CREATED': show(de ? 'Anmeldung wird vorbereitet …' : 'Preparing sign-in …'); break;
		case 'SIGNATURE_PENDING': show(de ? 'Bitte im Safe signieren …' : 'Please sign in your Safe …'); break;
		case 'ONCHAIN_APPROVAL_PENDING': show(de
			? 'Safe hat eine On-chain-Bestätigung (SignMessageLib) vorgeschlagen: kein Wert, keine Freigabe, aber Gas. Sobald die Owner sie ausgeführt haben, wirst du automatisch angemeldet.'
			: 'Safe proposed an on-chain confirmation (SignMessageLib): no value, no approval, but gas. Once the owners have executed it, you are signed in automatically.'); break;
		case 'WAITING_FOR_OWNERS':
			show(n ? (de ? `Warte auf Bestätigungen (${n} erforderlich) …` : `Waiting for confirmations (${n} required) …`)
				: (de ? 'Warte auf weitere Bestätigung …' : 'Waiting for more confirmations …'));
			break;
		case 'SIGNATURE_READY': show(de ? 'Signatur vollständig.' : 'Signature complete.'); break;
		case 'VERIFYING': show(de ? 'Anmeldung wird geprüft …' : 'Verifying sign-in …'); break;
		case 'AUTHENTICATED': break; // Dashboard wird gerendert
		case 'EXPIRED': show(de ? 'Das Signaturfenster ist abgelaufen. Bitte neu starten.' : 'The signing window expired. Please restart.'); break;
		case 'REJECTED':
			show(detail.reason === 'chain'
				? (de ? 'CoverRaccoon Safe Login ist derzeit nur auf Ethereum Mainnet verfügbar.' : 'CoverRaccoon Safe login is currently only available on Ethereum Mainnet.')
				: (de ? 'Anmeldung abgelehnt.' : 'Sign-in rejected.'));
			break;
	}
}

async function runSafeAppLogin(ctx) {
	const { startSafeApp } = await import('./safe-app.js');
	document.body.classList.add('safe-mode');
	for (const selector of ['.actions', '.security', '.verify', '#link-account']) {
		const element = document.querySelector(selector);
		if (element) element.hidden = true;
	}
	try {
		// Erst eine bestehende Sitzung derselben Safe uebernehmen (Cookie, ohne Signatur),
		// sonst der Login. Kein Token im Speicher - die Sitzung liegt im HttpOnly-Cookie.
		const { dashboard } = await startSafeApp({ sdk: ctx.sdk, info: ctx.info, fetchFn: fetch, onState: renderSafeState });
		safeContext = ctx; // fuer frische Bestaetigungen (AUDIT SA-L1), ebenfalls nur im Speicher
		await configPromise.catch(() => null);
		renderDashboard(dashboard);
	} catch (error) {
		show(error.message);
	}
}

async function bootstrap() {
	// Lokale Dev-Fixture (siehe loadPositions): zeigt das Dashboard mit erfundenen
	// Daten ueber die echten Render-Funktionen, ohne Backend und ohne Sitzung.
	// Einschalten nur per VITE_POSITIONS_FIXTURE beim Start des Vite-Entwicklungsservers.
	if (import.meta.env.DEV && import.meta.env.VITE_POSITIONS_FIXTURE) {
		const fixture = await import('./fixtures/positions-fixture.js');
		const variant = fixture.fixtureVariant(import.meta.env.VITE_POSITIONS_FIXTURE);
		if (variant) {
			document.title = `[DEV-FIXTURE] ${document.title}`;
			renderDashboard(fixture.dashboardFixture(variant));
			return;
		}
	}
	if (code) return restoreDashboard(); // Telegram-Link-Modus: unveraendert
	const inIframe = (() => { try { return window.self !== window.top; } catch { return true; } })();
	if (inIframe) {
		try {
			const { detectSafeContext } = await import('./safe-app.js');
			const ctx = await detectSafeContext(() => import('@safe-global/safe-apps-sdk').then((module) => module.default));
			if (ctx) return runSafeAppLogin(ctx);
		} catch { /* kein Safe-Kontext: normaler Flow */ }
	}
	return restoreDashboard();
}

shellRenderer = () => renderDashboardShell(document, { language, data: window.dashboardData, positionsState, attribution: currentAttribution() });
mountDashboardNav(document, window);

startAnalytics(); // anonyme Seitenaufruf-Statistik, URL ohne Query (analytics.js)
const dashboardRestorePromise = bootstrap();
