/*
	Oeffentliche Landingpage (20.10.2026): Texte DE/EN und das Scrollen der
	Abschnittslinks. Reine Darstellung.

	Kein Import, kein Netz, keine Wallet, kein Speicher, keine Adresse. Die
	Sprache kommt von main.js (document.documentElement.lang und dieselben
	DE/EN-Knoepfe); Hero-Titel, Kicker und Lead uebersetzt main.js selbst, weil
	sie dort schon stehen. Alles andere traegt in web/index.html ein `data-l`,
	und genau dessen textContent wird hier gesetzt. Die Anmeldung bleibt das
	bestehende Fenster (#connect) mit seinen Knoepfen; "Dashboard oeffnen"
	scrollt nur dorthin.

	Die Vorschauen (Dashboard, Agent) sind feste Beispielinhalte, als Demo
	beschriftet, ohne Bezug zu echten Nutzerdaten.
*/

const TEXTS = {
	de: {
		principle1: 'NUR LESEN', principle2: 'KEIN TRANSFER', principle3: 'PRIVAT',
		ctaOpen: 'Dashboard öffnen', ctaHow: 'So funktioniert’s',
		previewCaption: 'Beispielansicht mit Demo-Daten', previewDemo: 'Demo',
		pvTitle: 'Cover-Übersicht', pvPositions: 'Positionen', pvActive: 'Aktive Covers', pvUncovered: 'Ohne aktives Cover', pvExpiry: 'Nächster Ablauf', pvExpiryValue: '12 Tage',
		pvAttention: 'Zu beachten', pvItem1: 'Aave v3 · Lido: kein aktives Cover', pvItem2: 'Cover läuft in 12 Tagen ab', pvStatusAttributed: 'Cover zugeordnet', pvStatusNone: 'Kein aktives Cover',
		pvAsk: 'CoverRaccoon fragen …',
		howKicker: 'So funktioniert’s', howTitle: 'Drei Schritte zu deiner Cover-Übersicht',
		how1Title: 'Erkennen', how1Copy: 'Verbinde deine Wallet und sieh deine unterstützten Onchain-Positionen – derzeit Aave v3 auf Ethereum.',
		how2Title: 'Cover prüfen', how2Copy: 'Sieh dir passende Cover-Optionen an und lies die maßgeblichen Bedingungen nach.',
		how3Title: 'Im Blick behalten', how3Copy: 'Behalte aktive Covers, Ablaufdaten und Erinnerungen im Blick.',
		capKicker: 'Funktionen', capTitle: 'Wobei CoverRaccoon dir hilft',
		cap1: 'Unterstützte DeFi-Positionen erkennen', cap1Copy: 'Derzeit Aave v3 auf Ethereum, live aus der Blockchain.',
		cap2: 'Onchain-Exposure verstehen', cap2Copy: 'Einlagen, Schulden und Nettowert je Markt.',
		cap3: 'Passende Cover-Optionen finden', cap3Copy: 'Produkte und Quotes von Nexus Mutual, soweit verfügbar.',
		cap4: 'Cover-Bedingungen nachlesen', cap4Copy: 'Wording und Annex direkt aus der Quelle.',
		cap5: 'Aktive Covers im Blick', cap5Copy: 'Betrag, Asset und Status deiner Covers.',
		cap6: 'Ablaufdaten verfolgen', cap6Copy: 'Was bald ausläuft, siehst du zuerst.',
		cap7: 'Erinnerungen erhalten', cap7Copy: 'Vor dem Ablauf, über Telegram.',
		cap8: 'Den CoverRaccoon Agent fragen', cap8Copy: 'Fragen zu Positionen, Covers und Bedingungen.',
		capNote: 'Nicht jedes Protokoll und nicht jedes Risiko wird unterstützt. Ein passendes Produkt bedeutet nicht, dass ein bestimmter Verlust gedeckt ist; maßgeblich sind allein die Bedingungen des Anbieters.',
		agentKicker: 'CoverRaccoon Agent', agentTitle: 'Frag einfach nach.',
		agentCopy: 'Der Agent kennt deine verbundenen Positionen und Covers und erklärt sie in klaren Worten. Er liest nur und fragt nie nach einer Transaktion.',
		agentWhere: 'Heute antwortet der Agent in deinem privaten Telegram-Chat.',
		agentDemo: 'Beispiel', agentUserLabel: 'Du', agentBotLabel: 'CoverRaccoon',
		agentQ: 'Ist meine Aave-Position derzeit abgedeckt?', agentA: 'Ich habe deine Aave-v3-Position gefunden. Ihr ist derzeit kein aktives Cover zugeordnet.',
		agentFollow: 'Möchtest du passende Cover-Optionen sehen?',
		dashKicker: 'Nach dem Login', dashTitle: 'Das siehst du in deinem Dashboard',
		dash1: 'Übersicht', dash1Copy: 'Kennzahlen, Hinweise und anstehende Abläufe auf einen Blick.',
		dash2: 'Positionen', dash2Copy: 'Deine erkannten Positionen mit Nettowert und Cover-Status.',
		dash3: 'Covers', dash3Copy: 'Aktive, bald ablaufende und vergangene Covers.',
		dash4: 'Agent', dash4Copy: 'Der direkte Weg zu deinem CoverRaccoon Agent.',
		trustKicker: 'Sicherheit', trustTitle: 'Nicht-verwahrend, von Grund auf', trustLead: 'Deine Wallet bleibt deine.',
		trust1: 'Keine privaten Schlüssel', trust1Copy: 'CoverRaccoon kennt und speichert weder private Schlüssel noch Seed Phrases.',
		trust2: 'Keine Verwahrung', trust2Copy: 'Deine Assets bleiben in deiner Wallet. CoverRaccoon bewegt nichts.',
		trust3: 'Eine Signatur zur Anmeldung', trust3Copy: 'Keine Transaktion und keine Token-Freigabe. Was deine Wallet betrifft, bestätigst du selbst; bei einer Safe kann die Bestätigung on-chain Gas kosten.',
		trust4: 'Cover von Drittanbietern', trust4Copy: 'Covers stammen von Nexus Mutual. Es gelten allein deren Bedingungen; CoverRaccoon verkauft und vermittelt nichts.',
		trustNote: 'CoverRaccoon ist experimentell und in Entwicklung. Angezeigte Daten ohne Gewähr.',
		provKicker: 'Datenquellen', provTitle: 'Cover-Optionen von Protokollen wie Nexus Mutual',
		provCopy: 'Positionen und Covers werden live von Ethereum und von Nexus Mutual gelesen. CoverRaccoon ist ein unabhängiges Werkzeug. Nexus Mutual ist keine Versicherung.',
		provPositions: 'Positionen', provCovers: 'Cover',
		finalKicker: 'Loslegen', finalTitle: 'Sieh deine Cover-Übersicht', finalCopy: 'Verbinde deine Wallet, um deine unterstützten Positionen und verfügbaren Cover-Optionen zu sehen.',
		finalPoint1: 'Eine Signatur, keine Transaktion', finalPoint2: 'Kein Konto, keine E-Mail', finalPoint3: 'Abmelden jederzeit'
	},
	en: {
		principle1: 'READ ONLY', principle2: 'NO TRANSFER', principle3: 'PRIVATE',
		ctaOpen: 'Open Dashboard', ctaHow: 'How it works',
		previewCaption: 'Example view with demo data', previewDemo: 'Demo',
		pvTitle: 'Protection overview', pvPositions: 'Positions', pvActive: 'Active covers', pvUncovered: 'Without active cover', pvExpiry: 'Next expiry', pvExpiryValue: '12 days',
		pvAttention: 'Needs attention', pvItem1: 'Aave v3 · Lido: no active cover', pvItem2: 'Cover expires in 12 days', pvStatusAttributed: 'Cover attributed', pvStatusNone: 'No active cover',
		pvAsk: 'Ask CoverRaccoon …',
		howKicker: 'How it works', howTitle: 'Three steps to your cover overview',
		how1Title: 'Detect', how1Copy: 'Connect your wallet and see your supported onchain positions – currently Aave v3 on Ethereum.',
		how2Title: 'Explore', how2Copy: 'Explore available cover options and review the relevant terms.',
		how3Title: 'Monitor', how3Copy: 'Keep track of active cover, expiry dates and reminders.',
		capKicker: 'Capabilities', capTitle: 'What CoverRaccoon helps you with',
		cap1: 'Detect supported DeFi positions', cap1Copy: 'Currently Aave v3 on Ethereum, read live from the chain.',
		cap2: 'Understand onchain exposure', cap2Copy: 'Supplied, borrowed and net value per market.',
		cap3: 'Find relevant cover options', cap3Copy: 'Products and quotes from Nexus Mutual, where available.',
		cap4: 'Review cover terms', cap4Copy: 'Wording and annex straight from the source.',
		cap5: 'Monitor active cover', cap5Copy: 'Amount, asset and status of your covers.',
		cap6: 'Track expiry dates', cap6Copy: 'What ends soon comes first.',
		cap7: 'Receive reminders', cap7Copy: 'Before expiry, via Telegram.',
		cap8: 'Ask the CoverRaccoon Agent', cap8Copy: 'Questions about positions, covers and terms.',
		capNote: 'Not every protocol and not every risk is supported. A matching product does not mean that a particular loss is covered; only the provider’s terms apply.',
		agentKicker: 'CoverRaccoon Agent', agentTitle: 'Just ask.',
		agentCopy: 'The agent knows your connected positions and covers and explains them in plain words. It only reads and never asks for a transaction.',
		agentWhere: 'Today the agent answers in your private Telegram chat.',
		agentDemo: 'Example', agentUserLabel: 'You', agentBotLabel: 'CoverRaccoon',
		agentQ: 'Is my Aave position currently covered?', agentA: 'I found your Aave v3 position. There is currently no active cover associated with it.',
		agentFollow: 'Would you like to see matching cover options?',
		dashKicker: 'After login', dashTitle: 'What you see in your dashboard',
		dash1: 'Overview', dash1Copy: 'Key figures, notices and upcoming expiries at a glance.',
		dash2: 'Positions', dash2Copy: 'Your detected positions with net value and cover status.',
		dash3: 'Covers', dash3Copy: 'Active, expiring soon and past covers.',
		dash4: 'Agent', dash4Copy: 'The direct way to your CoverRaccoon Agent.',
		trustKicker: 'Security', trustTitle: 'Non-custodial by design', trustLead: 'Your wallet stays yours.',
		trust1: 'No private keys', trust1Copy: 'CoverRaccoon never knows or stores private keys or seed phrases.',
		trust2: 'No custody', trust2Copy: 'Your assets stay in your wallet. CoverRaccoon moves nothing.',
		trust3: 'One signature to sign in', trust3Copy: 'No transaction and no token approval. Anything that touches your wallet is confirmed by you; with a Safe, the confirmation may cost gas on-chain.',
		trust4: 'Third-party cover', trust4Copy: 'Covers come from Nexus Mutual. Only their terms apply; CoverRaccoon does not sell or arrange anything.',
		trustNote: 'CoverRaccoon is experimental and under development. Data shown without warranty.',
		provKicker: 'Data sources', provTitle: 'Cover options from protocols such as Nexus Mutual',
		provCopy: 'Positions and covers are read live from Ethereum and from Nexus Mutual. CoverRaccoon is an independent tool. Nexus Mutual is not insurance.',
		provPositions: 'Positions', provCovers: 'Cover',
		finalKicker: 'Get started', finalTitle: 'See your protection overview', finalCopy: 'Connect your wallet to see supported positions and available protection options.',
		finalPoint1: 'One signature, no transaction', finalPoint2: 'No account, no email', finalPoint3: 'Sign out any time'
	}
};

export const LANDING_TEXTS = TEXTS;

/** Setzt jeden `data-l`-Knoten auf den Text der Sprache; unbekannte Schluessel bleiben stehen. */
export function applyLandingLanguage(doc, language) {
	const t = TEXTS[language] ?? TEXTS.en;
	for (const node of doc.querySelectorAll('[data-l]')) {
		const value = t[node.dataset?.l];
		if (typeof value === 'string') node.textContent = value;
	}
}

/* Abschnittslinks scrollen, ohne das URL-Fragment zu aendern: das Fragment gehoert der Dashboard-Navigation. */
function scrollToSection(doc, win, id) {
	const target = doc.getElementById(id);
	if (!target) return false;
	const reduced = win?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
	target.scrollIntoView?.({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
	target.focus?.({ preventScroll: true });
	return true;
}

export function mountLanding(doc, win) {
	applyLandingLanguage(doc, doc.documentElement?.lang);
	for (const button of doc.querySelectorAll('[data-language]')) {
		button.addEventListener('click', () => applyLandingLanguage(doc, doc.documentElement?.lang));
	}
	for (const link of doc.querySelectorAll('[data-scroll]')) {
		link.addEventListener('click', (event) => {
			if (scrollToSection(doc, win, link.dataset?.scroll)) event.preventDefault();
		});
	}
}

if (typeof document !== 'undefined') mountLanding(document, typeof window === 'undefined' ? undefined : window);
