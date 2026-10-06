/*
	FILTER FUER JEDE KI-ANTWORT, BEVOR SIE TELEGRAM ERREICHT.

	Die Anweisungen sagen der KI, keine Links zu erfinden. Anweisungen lassen
	sich aber mit geschickten Nachrichten aushebeln, besonders in Gruppen, wo
	JEDER den Bot ansprechen kann. Der realistische Schaden: der offizielle Bot
	postet einen Phishing-Link oder eine "Einzahlungsadresse" in eine Gruppe.

	Deshalb gilt nach der KI, unabhaengig von ihr:
	  - Links und nackte Domains bleiben nur, wenn sie auf eine erlaubte Adresse
	    zeigen. Externe Fakten autorisieren keine Kontaktziele. Produktnamen mit
	    Punkt werden bei Bedarf sichtbar erhalten, aber nicht mehr verlinkbar.
	  - Telegram-Mentions bleiben nur fuer den konfigurierten eigenen Bot;
	    tg://-Links werden immer entfernt.
	  - Wallet-Adressen (0x + 40 Hex) werden immer entfernt. Der Bot hat in einer
	    Antwort nie einen Grund, eine Adresse zu nennen.
*/

const ERLAUBTE_HOSTS = new Set([
	'coverraccoon.com',
	'docs.nexusmutual.io',
	'api.nexusmutual.io',
	'nexusmutual.io',
	't.me'
]);

// Explizite Links (mit Schema oder www.) und nackte Domains, wie Telegram sie selbst verlinkt.
const LINK = /\b(?:https?:\/\/|www\.)[^\s<>()"'`]+|\b(?:[a-z0-9-]+\.)+[a-z][a-z0-9-]{1,23}(?:\/[^\s<>()"'`]*)?/gi;
const TG_LINK = /\btg:\/\/[^\s<>()"'`]+/gi;
const MENTION = /@[a-z0-9_]+/gi;
const ADRESSE = /\b0x[a-fA-F0-9]{40}\b/g;

function hostOf(treffer) {
	try {
		const url = new URL(/^https?:\/\//i.test(treffer) ? treffer : `https://${treffer}`);
		return url.hostname.toLowerCase().replace(/^www\./, '');
	} catch {
		return null;
	}
}

/** Nur Produktnamen als nicht-klickbare Beschriftung erhalten, nie als Linkfreigabe. */
function produktWoerter(kontext) {
	const woerter = new Set();
	const labels = typeof kontext === 'object' && kontext !== null
		? (kontext.PRODUCT_RESOLUTION === 'UNAMBIGUOUS' ? [kontext.PRODUCT_IDENTITY] : kontext.CANDIDATES ?? [])
			.filter((p) => Number.isSafeInteger(p?.productId) && typeof p?.officialName === 'string')
			.map((p) => `Product: ${p.officialName} (Nexus Mutual product ID ${p.productId})`).join('\n')
		: String(kontext ?? '');
	for (const match of labels.matchAll(/^Product: (.+?) \(Nexus Mutual product ID \d+\)/gm)) {
		for (const wort of match[1].match(LINK) ?? []) {
			if (!/[/:?#@]/.test(wort) && !/^www\./i.test(wort)) woerter.add(wort.toLowerCase());
		}
	}
	return woerter;
}

export function filterAnswer(text, { kontext = '', botUsername = '' } = {}) {
	if (typeof text !== 'string') return text;
	const produkte = produktWoerter(kontext);
	const bot = String(botUsername ?? '').replace(/^@/, '').toLowerCase();
	let entfernt = 0;
	const gefiltert = text
		.replace(TG_LINK, () => { entfernt++; return '[Link entfernt]'; })
		.replace(LINK, (treffer) => {
			const sauber = treffer.replace(/[.,;:!?]+$/, '');
			const rest = treffer.slice(sauber.length);
			const host = hostOf(sauber);
			if (!host) { entfernt++; return `[Link entfernt]${rest}`; }
			if (host === 't.me') {
				const pfad = sauber.split(/t\.me\//i)[1]?.split(/[/?#]/)[0]?.toLowerCase() ?? '';
				if (bot && pfad === bot) return treffer;
			} else if (ERLAUBTE_HOSTS.has(host)) {
				return treffer;
			}
			if (produkte.has(sauber.toLowerCase()) && !/[/:?#@]/.test(sauber) && !/^www\./i.test(sauber)) {
				return sauber.replace(/\./g, '.\u200b') + rest;
			}
			// Kein Link: ein Wort ohne Punkt-Endung wie "z.B" faellt nie hierher,
			// weil LINK eine Endung aus mindestens zwei Buchstaben verlangt.
			entfernt++;
			return `[Link entfernt]${rest}`;
		})
		.replace(MENTION, (mention) => {
			if (bot && mention.slice(1).toLowerCase() === bot) return mention;
			entfernt++;
			return '[Kontakt entfernt]';
		})
		.replace(ADRESSE, () => {
			entfernt++;
			return '[Adresse entfernt]';
		});
	return { text: gefiltert, entfernt };
}
