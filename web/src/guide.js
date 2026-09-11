const en = {
	back: '← Back to dashboard', eyebrow: 'User guide', title: ['Start simply.', 'Stay protected.'],
	lead: 'How to connect your wallet, activate Telegram and renew cover. At every step you can see whether a signature or a real transaction follows.',
	quickStart: 'Quick start', quickStartCopy: 'Open wallet and dashboard', quickTgCopy: 'Activate reminders', quickRenew: 'Renew', quickRenewCopy: 'Review and complete an offer',
	expect: 'What your wallet shows', source: 'Data source', result: 'Result', tip: 'Tip', proof: 'Your proof',
	s1Title: 'Connect wallet', s1Copy: 'Open the Agent, choose your wallet and confirm the login message. This only proves that you control the address.', s1Expect: 'A signature request. No transaction, token approval or gas fee.',
	s2Title: 'Review dashboard', s2Copy: 'The Agent loads your cover data from Cover Raccoon. You see active cover, protected amount, expiry and available renewals.', s2Expect: 'Cover Raccoon · Nexus Mutual · Ethereum. The Agent does not alter on-chain data.',
	s3Title: 'Activate Telegram', s3Copy: 'Select “Connect Telegram” in the dashboard and start the bot. Your verified wallet is transferred securely – no second signature is needed.', s3Expect: 'Expiry reminders, renewal notices and a direct route back to the dashboard.',
	capLanding: '1. Open the Agent and select “Connect wallet”.', capWallets: '2. Open your preferred wallet from the secure selector.', capSignature: '3. Review and sign the login message – without gas or approval.',
	capDashboard: 'The dashboard brings cover, expiry, Telegram status and renewals together in one place.',
	capTgStart: '1. Telegram opens the correct Raccoon Agent bot.', capTgVerify: '2. Verify the bot name and official username.', capTgReady: '3. After starting, Dashboard, Covers, Renewal and Settings appear as buttons.',
	s4Title: 'Set reminders', s4Copy: 'In Settings, enable notices 30, 14, 7, 3 or 1 day before expiry and on expiry day. A weekly summary is optional.', s4Expect: '“Remind tomorrow” postpones one notice without changing your general settings.',
	s5Title: 'Renew cover', s5Copy: 'Review amount, period, live premium, commission, cover wording and product annex. Only then confirm with the owner wallet.', s5Expect: 'For ERC-20, potentially an “Approve” first, followed by “buyCover”. With ETH, normally only the purchase transaction is needed.',
	s6Title: 'Wait for confirmation', s6Copy: 'The renewal is complete only after Ethereum confirms the transaction. The Agent detects the new cover and monitors its new period automatically.', s6Expect: 'The transaction hash on Etherscan and updated cover in the dashboard and Telegram.',
	securityEyebrow: 'Security', securityTitle: 'What the Agent will never request', sec1: 'No seed phrase or private key.', sec2: 'No payment for login or Telegram linking.', sec3: 'Cover Raccoon never holds customer funds.', sec4: 'A real transaction is always clearly announced first.',
	disconnectTitle: 'Disconnecting', unlinkTg: 'Disconnect Telegram', unlinkTgCopy: 'Stops notifications. Your existing dashboard session remains active.', unlinkWallet: 'Fully disconnect wallet', unlinkWalletCopy: 'Stops Telegram and signs out every dashboard session for this wallet.',
	cta: 'Ready? Open your personal area and connect your wallet.', ctaButton: 'Open Agent'
};
/*
	AGENT-SEC-F1: hier wurde das Instagram-Zeichen zur Laufzeit per innerHTML
	ersetzt. Der Inhalt war fest, aber ein innerHTML-Zugriff bleibt eine Tuer,
	die spaeter jemand mit einem Fremdwert aufstoesst. Die Umrissfassung steht
	jetzt unveraendert in guide.html - kein Skript noetig.
*/
const de = Object.fromEntries([...document.querySelectorAll('[data-i18n]')].map((node) => [node.dataset.i18n, node.textContent]));
const deTeile = Object.fromEntries([...document.querySelectorAll('[data-i18n-teile]')]
	.map((node) => [node.dataset.i18nTeile, [...node.querySelectorAll('[data-teil]')].map((teil) => teil.textContent)]));
const language = localStorage.getItem('raccoon_language') || (navigator.language?.toLowerCase().startsWith('de') ? 'de' : 'en');
function apply(next) {
	const lang = next === 'de' ? 'de' : 'en'; localStorage.setItem('raccoon_language', lang); document.documentElement.lang = lang;
	document.querySelectorAll('[data-language]').forEach((button) => button.classList.toggle('active', button.dataset.language === lang));
	document.querySelectorAll('[data-i18n]').forEach((node) => { node.textContent = lang === 'en' ? (en[node.dataset.i18n] ?? node.textContent) : (de[node.dataset.i18n] ?? node.textContent); });
	document.querySelectorAll('[data-i18n-teile]').forEach((node) => {
		const schluessel = node.dataset.i18nTeile;
		const werte = lang === 'en' ? en[schluessel] : deTeile[schluessel];
		if (!Array.isArray(werte)) return;
		werte.forEach((wert, index) => {
			const ziel = node.querySelector(`[data-teil="${index}"]`);
			if (ziel) ziel.textContent = wert;
		});
	});
	document.title = lang === 'de' ? 'Raccoon Agent · Anleitung' : 'Raccoon Agent · Guide';
}
document.querySelectorAll('[data-language]').forEach((button) => button.addEventListener('click', () => apply(button.dataset.language)));
apply(language);
