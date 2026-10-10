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
	  - Deckungs- und Leistungszusagen ("das ist gedeckt", "dein Claim wird
	    bezahlt", "Nexus zahlt", "you are covered") werden durch einen festen
	    Hinweis ersetzt: ob ein Claim anerkannt oder gezahlt wird, entscheidet
	    das Claims-Assessment von Nexus Mutual, nie der Agent. Bewusst eng:
	    gefiltert wird nur Subjekt + Zusage im selben Satzteil und nur ohne
	    Einschraenkung ("ob", "whether", "nicht", "entscheidet", "depends").
	    Beschreibungen des Wordings ("listed as a Covered Event", "als
	    gedecktes Ereignis genannt") bleiben unberuehrt.
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

// Zusagen: Subjekt + Zusage, optional mit Verstaerker. Nur positive Aussagen.
const VERSTAERKER_DE = String.raw`(?:(?:dann|damit|also|in diesem fall|sicher|auf jeden fall|definitiv|garantiert|voll|vollst(?:ä|ae)ndig|ganz|komplett|selbstverst(?:ä|ae)ndlich|bestimmt|ja)\s+)*`;
const VERSTAERKER_EN = String.raw`(?:(?:then|definitely|certainly|surely|fully|absolutely|guaranteed to be|always|still|of course)\s+)*`;
const ZUSAGEN = {
	de: [
		String.raw`\b(?:das|dies|es|der|dein|ihr|euer|so ein|ein|dieser)\s*(?:schaden|verlust|vorfall|hack|angriff|exploit|fall|ereignis)?\s+(?:ist|w(?:ä|ae)re|wird)\s+${VERSTAERKER_DE}(?:gedeckt|versichert|abgedeckt|abgesichert|erstattet)\b`,
		String.raw`\b(?:du\s+bist|sie\s+sind|ihr\s+seid|bist\s+du|sind\s+sie)\s+${VERSTAERKER_DE}(?:gedeckt|versichert|abgesichert|gesch(?:ü|ue)tzt)\b`,
		String.raw`\b(?:der|dein|ihr|euer|ein|jeder)\s+(?:claim|schadensfall|anspruch)\s+wird\s+${VERSTAERKER_DE}(?:angenommen|genehmigt|anerkannt|bezahlt|ausgezahlt|ausbezahlt|erstattet|akzeptiert)\b`,
		String.raw`\bnexus(?:\s+mutual)?\s+(?:zahlt|erstattet|ersetzt|wird\s+(?:dir\s+|ihnen\s+|euch\s+)?${VERSTAERKER_DE}(?:(?:den|deinen|ihren|euren)\s+(?:schaden|verlust)\s+|(?:das|dein|ihr|euer)\s+geld\s+)?${VERSTAERKER_DE}(?:zahlen|bezahlen|auszahlen|erstatten|ersetzen|eine\s+auszahlung\s+leisten))\b`,
		String.raw`\b(?:du|sie|ihr)\s+(?:bekommst|bekommen|bekommt|erh(?:ä|ae)ltst|erhalten|erhaltet|kriegst)\s+${VERSTAERKER_DE}(?:eine\s+|dein\s+|ihr\s+|das\s+|den\s+)?(?:auszahlung|erstattung|entsch(?:ä|ae)digung|geld|verlust\s+ersetzt|schaden\s+ersetzt)`,
		String.raw`\bf(?:ä|ae)llt\s+(?:sicher|auf jeden fall|garantiert|definitiv|bestimmt)\s+unter\s+(?:das|dein|den|ihr)\s+(?:cover|versicherungsschutz|deckung)`,
		String.raw`\b(?:garantierte|sichere)\s+(?:auszahlung|deckung|erstattung|leistung)`
	],
	en: [
		String.raw`\b(?:this|that|it|your\s+(?:loss|claim|incident|damage|hack|case)|the\s+(?:loss|incident|damage|hack|exploit|attack))\s+(?:is|'s|would\s+be|will\s+be)\s+${VERSTAERKER_EN}(?:covered|insured|reimbursed)\b`,
		String.raw`\byou(?:\s+are|'re|\s+would\s+be|\s+will\s+be)\s+${VERSTAERKER_EN}(?:covered|insured|protected)\b`,
		String.raw`\b(?:your|the|a|any)\s+claim\s+(?:will|would|is\s+going\s+to)\s+(?:definitely\s+|certainly\s+|surely\s+)?be\s+(?:paid|approved|accepted|honou?red|reimbursed)\b`,
		String.raw`\byou\s+(?:will|would|'ll)\s+(?:definitely\s+|certainly\s+|surely\s+)?(?:get|receive)\s+(?:a\s+|your\s+|the\s+)?(?:payout|reimbursement|refund|compensation|money\s+back)`,
		String.raw`\bnexus(?:\s+mutual)?\s+(?:will|would|is\s+going\s+to)\s+(?:definitely\s+|certainly\s+|surely\s+)?(?:pay|reimburse|compensate)\b`,
		String.raw`\bguaranteed\s+(?:payout|coverage|reimbursement)`
	]
};
const ZUSAGE = Object.fromEntries(Object.entries(ZUSAGEN).map(([sprache, muster]) => [sprache, new RegExp(muster.join('|'), 'i')]));
// Einschraenkung im selben Satzteil: Frage nach "ob", Verneinung, Verweis auf die Entscheidung.
const EINSCHRAENKUNG = /\b(?:ob|whether|nicht|not|kein\w*|no|never|nie|niemals|cannot|can't|isn't|aren't|won't|entscheid\w*|decide\w*|decision|determin\w*|depend\w*|h(?:ä|ae)ngt|abh(?:ä|ae)ngig|assessment|pr(?:ü|ue)fung)\b/i;
const ZUSAGE_ERSATZ = {
	de: 'Ob ein konkreter Vorfall die Bedingungen erfüllt und ein Claim anerkannt oder ausgezahlt wird, entscheidet das Claims-Assessment von Nexus Mutual, nicht der Raccoon Agent; eine Deckungs- oder Leistungszusage kann der Raccoon Agent nicht geben.',
	en: 'Whether a specific incident meets the conditions and whether a claim is accepted or paid is determined by Nexus Mutual’s claims assessment, not by Raccoon Agent; Raccoon Agent cannot give a coverage or payout commitment.'
};

/** Saetze mit einer uneingeschraenkten Deckungs- oder Zahlungszusage ersetzen. */
function zusagenNeutralisieren(text) {
	let ersetzt = 0;
	const gesehen = new Set();
	// Satzende nur bei Punkt usw. vor Leerraum: "2.2" und Adressen bleiben ein Satz.
	const ergebnis = text.replace(/(?:[^.!?\n]|[.!?](?=[^\s.!?]))+[.!?]*/g, (satz) => {
		const teile = satz.split(/[,;:–—]|\s-\s|\b(?:aber|but|jedoch|however)\b/i);
		const sprache = teile.map((teil) => ['de', 'en'].find((s) => ZUSAGE[s].test(teil) && !EINSCHRAENKUNG.test(teil))).find(Boolean);
		if (!sprache) return satz;
		ersetzt++;
		const fuehrend = satz.match(/^\s*/)[0];
		if (gesehen.has(sprache)) return fuehrend;
		gesehen.add(sprache);
		return fuehrend + ZUSAGE_ERSATZ[sprache];
	});
	return { text: ersetzt ? ergebnis.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+$/gm, '') : text, ersetzt };
}

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
	const { text: ohneZusagen, ersetzt } = zusagenNeutralisieren(gefiltert);
	return { text: ohneZusagen, entfernt, zusagenErsetzt: ersetzt };
}
