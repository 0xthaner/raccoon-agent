/*
	FILTER FUER JEDE KI-ANTWORT, BEVOR SIE TELEGRAM ERREICHT.

	Die Anweisungen sagen der KI, keine Links zu erfinden. Anweisungen lassen
	sich aber mit geschickten Nachrichten aushebeln, besonders in Gruppen, wo
	JEDER den Bot ansprechen kann. Der realistische Schaden: der offizielle Bot
	postet einen Phishing-Link oder eine "Einzahlungsadresse" in eine Gruppe.

	Deshalb gilt nach der KI, unabhaengig von ihr:
	  - Links und nackte Domains bleiben nur, wenn sie auf eine erlaubte Adresse
	    zeigen oder woertlich im Kontext standen, den der Bot gerade bekommen hat
	    (Nexus-Fakten, Grundwissen). Alles andere wird ersetzt.
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
const ADRESSE = /\b0x[a-fA-F0-9]{40}\b/g;

function hostOf(treffer) {
	try {
		const url = new URL(/^https?:\/\//i.test(treffer) ? treffer : `https://${treffer}`);
		return url.hostname.toLowerCase().replace(/^www\./, '');
	} catch {
		return null;
	}
}

/** Domain-artige Woerter aus dem Kontext, z. B. ein Produktname wie "Ether.fi". */
function kontextWoerter(kontext) {
	return new Set((String(kontext ?? '').match(LINK) ?? []).map((w) => w.toLowerCase().replace(/[.,;:!?]+$/, '')));
}

export function filterAnswer(text, { kontext = '', botUsername = '' } = {}) {
	if (typeof text !== 'string') return text;
	const ausKontext = kontextWoerter(kontext);
	const bot = String(botUsername ?? '').replace(/^@/, '').toLowerCase();
	let entfernt = 0;
	const gefiltert = text
		.replace(LINK, (treffer) => {
			const sauber = treffer.replace(/[.,;:!?]+$/, '');
			const rest = treffer.slice(sauber.length);
			if (ausKontext.has(sauber.toLowerCase())) return treffer;
			const host = hostOf(sauber);
			if (!host) return treffer;
			if (host === 't.me') {
				const pfad = sauber.split(/t\.me\//i)[1]?.split(/[/?#]/)[0]?.toLowerCase() ?? '';
				if (bot && pfad === bot) return treffer;
			} else if (ERLAUBTE_HOSTS.has(host)) {
				return treffer;
			}
			// Kein Link: ein Wort ohne Punkt-Endung wie "z.B" faellt nie hierher,
			// weil LINK eine Endung aus mindestens zwei Buchstaben verlangt.
			entfernt++;
			return `[Link entfernt]${rest}`;
		})
		.replace(ADRESSE, () => {
			entfernt++;
			return '[Adresse entfernt]';
		});
	return { text: gefiltert, entfernt };
}
