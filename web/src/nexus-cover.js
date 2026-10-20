/*
	Nexus-Cover-Details und Quote im Dashboard (P3, 18.10.2026). Nur Anzeige.

	Spricht ausschliesslich mit POST /api/nexus/quote (ueber das uebergebene
	`post`); kennt keinen Wallet-Provider und ruft keine Wallet-Methode auf.
	Alle Texte von Nexus (Produktname, Typ, Fehler) sind fremde Daten und
	landen nur ueber textContent im DOM; Links nur auf gepruefte Nexus-IPFS-
	Adressen. Es gibt hier keinen Kauf: nur "Cover-Details ansehen" und
	"Quote abrufen".
*/
const IPFS_URL = /^https:\/\/api\.nexusmutual\.io\/ipfs\/(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,})$/;
const PERIOD_MIN = 28;
const PERIOD_MAX = 365;
const PRESETS = [30, 90, 180, 365];

const TEXTS = {
	en: {
		provider: 'Nexus Mutual', loading: 'Loading cover details…', getQuote: 'Get quote', quoting: 'Requesting quote…',
		neutral: 'Cover availability cannot currently be determined for this position.',
		failed: 'Cover details could not be loaded right now.',
		protocol: 'Position protocol', network: 'Network', exposure: 'Suggested exposure (deposits − debt)', suggested: 'Suggested cover amount',
		asset: 'Cover asset', amount: 'Cover amount', duration: 'Duration (days)', days: 'days', premium: 'Premium', annual: 'Annual price',
		capacity: 'Available capacity', maxAmount: 'Maximum selectable', proofOfLoss: 'Proof of loss requirement', grace: 'Grace period',
		wording: 'Cover wording (Nexus Mutual)', annex: 'Product annex', terms: 'Terms', noAsset: 'No cover asset can be selected for this position.',
		conversion: 'Converted with the Aave oracle price', quoteFor: 'Quote', fetched: 'Quoted at', validUntil: 'Valid until',
		stale: 'This quote has expired. Request a new quote.', fresh: 'Indicative live quote from Nexus Mutual.',
		pol: { address: 'Wallet address(es) must be designated when cover is purchased.' },
		readiness: 'Cover through CoverRaccoon', readinessBlocked: 'Not available yet',
		readinessDetail: 'We are finalising the required Nexus Mutual terms and proof-of-loss flow before enabling wallet confirmations.',
		readinessReasons: {
			MARKET_NOT_IN_SCOPE: 'Not offered for this market yet.',
			NO_SUGGESTED_EXPOSURE: 'No suggested exposure for this position.'
		},
		quoteOnly: 'For information only. Cover cannot be taken out through CoverRaccoon yet.',
		mapping: 'Cover mapping is not available for this market yet.',
		supplied: 'Supplied', debt: 'Debt',
		polOther: 'Required proof-of-loss input:',
		disclaimer: 'Suggested cover amount is an estimate based on detected economic exposure. It does not guarantee that the same amount would be payable in a claim. Nexus Mutual terms and claim assessment govern.',
		termsNote: 'The linked wording and annex are the binding terms; nothing on this page replaces them.',
		errors: {
			AMOUNT_OUT_OF_RANGE: 'The amount is outside the allowed range.', INVALID_AMOUNT: 'Please enter a valid amount.',
			PERIOD_OUT_OF_RANGE: 'The duration must be between 28 and 365 days.', ASSET_NOT_SUPPORTED: 'This cover asset is not supported.',
			COVER_NOT_AVAILABLE: 'Cover availability cannot currently be determined for this position.', QUOTE_UNAVAILABLE: 'Nexus Mutual did not return a valid quote right now.'
		}
	},
	de: {
		provider: 'Nexus Mutual', loading: 'Cover-Details werden geladen …', getQuote: 'Quote abrufen', quoting: 'Quote wird abgerufen …',
		neutral: 'Die Cover-Verfügbarkeit kann für diese Position derzeit nicht bestimmt werden.',
		failed: 'Cover-Details konnten gerade nicht geladen werden.',
		protocol: 'Protokoll der Position', network: 'Netzwerk', exposure: 'Vorgeschlagenes Engagement (Einlagen − Schulden)', suggested: 'Vorgeschlagene Cover-Summe',
		asset: 'Cover-Asset', amount: 'Cover-Summe', duration: 'Laufzeit (Tage)', days: 'Tage', premium: 'Prämie', annual: 'Jahrespreis',
		capacity: 'Verfügbare Kapazität', maxAmount: 'Höchstens wählbar', proofOfLoss: 'Nachweis im Schadensfall', grace: 'Nachfrist',
		wording: 'Cover-Bedingungen (Nexus Mutual)', annex: 'Produkt-Anhang', terms: 'Bedingungen', noAsset: 'Für diese Position ist kein Cover-Asset wählbar.',
		conversion: 'Umgerechnet mit dem Aave-Orakelpreis', quoteFor: 'Quote', fetched: 'Abgerufen um', validUntil: 'Gültig bis',
		stale: 'Diese Quote ist abgelaufen. Bitte eine neue Quote abrufen.', fresh: 'Unverbindliche Live-Quote von Nexus Mutual.',
		pol: { address: 'Beim Abschluss des Covers müssen Wallet-Adresse(n) angegeben werden.' },
		readiness: 'Abschluss über CoverRaccoon', readinessBlocked: 'Noch nicht möglich',
		readinessDetail: 'Wir stellen die erforderlichen Bedingungen von Nexus Mutual und den Ablauf für den Schadensnachweis fertig, bevor Bestätigungen in der Wallet freigeschaltet werden.',
		readinessReasons: {
			MARKET_NOT_IN_SCOPE: 'Für diesen Markt noch nicht angeboten.',
			NO_SUGGESTED_EXPOSURE: 'Für diese Position gibt es kein vorgeschlagenes Engagement.'
		},
		quoteOnly: 'Nur zur Information. Ein Abschluss über CoverRaccoon ist noch nicht möglich.',
		mapping: 'Für diesen Markt gibt es noch keine Cover-Zuordnung.',
		supplied: 'Einlagen', debt: 'Schulden',
		polOther: 'Erforderliche Angaben für den Nachweis:',
		disclaimer: 'Die vorgeschlagene Cover-Summe ist eine Schätzung auf Basis des erkannten wirtschaftlichen Engagements. Sie garantiert nicht, dass im Schadensfall derselbe Betrag ausgezahlt würde. Es gelten die Bedingungen und die Schadensprüfung von Nexus Mutual.',
		termsNote: 'Verbindlich sind die verlinkten Bedingungen und der Anhang; nichts auf dieser Seite ersetzt sie.',
		errors: {
			AMOUNT_OUT_OF_RANGE: 'Der Betrag liegt außerhalb des zulässigen Bereichs.', INVALID_AMOUNT: 'Bitte einen gültigen Betrag eingeben.',
			PERIOD_OUT_OF_RANGE: 'Die Laufzeit muss zwischen 28 und 365 Tagen liegen.', ASSET_NOT_SUPPORTED: 'Dieses Cover-Asset wird nicht unterstützt.',
			COVER_NOT_AVAILABLE: 'Die Cover-Verfügbarkeit kann für diese Position derzeit nicht bestimmt werden.', QUOTE_UNAVAILABLE: 'Nexus Mutual hat gerade keine gültige Quote geliefert.'
		}
	}
};

const text = (value) => (typeof value === 'string' || typeof value === 'number' ? String(value) : '—');

function el(parent, tag, className = '', value = null) {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (value !== null) node.textContent = text(value);
	if (parent) parent.appendChild(node);
	return node;
}

function row(parent, label, value, help = '') {
	const line = el(parent, 'div', 'figure-row');
	el(line, 'span', 'figure-label', label);
	el(line, 'strong', 'figure-value', value);
	if (help) el(line, 'small', 'figure-help', help);
	return line;
}

/** Nur gepruefte Nexus-IPFS-Adressen werden zu Links; sonst Text ohne Link. */
function termsLink(parent, label, url) {
	if (typeof url !== 'string' || !IPFS_URL.test(url)) return null;
	const link = el(parent, 'a', 'cover-terms-link', label);
	link.href = url;
	link.target = '_blank';
	link.rel = 'noopener noreferrer';
	return link;
}

function formatTime(iso, language) {
	const ms = Date.parse(iso ?? '');
	if (!Number.isFinite(ms)) return '—';
	return new Intl.DateTimeFormat(language === 'de' ? 'de-AT' : 'en-GB', { timeStyle: 'medium', dateStyle: 'short' }).format(new Date(ms));
}

/**
 * Ein Panel fuer genau eine Position. `post(body)` liefert { status, body }
 * von POST /api/nexus/quote.
 */
export function createCoverPanel({ deploymentKey, post, language = 'en', now = () => Date.now(), setTimer = (fn, ms) => setTimeout(fn, ms) }) {
	const t = TEXTS[language] ?? TEXTS.en;
	const root = document.createElement('div');
	root.className = 'cover-panel';
	const state = { phase: 'loading', details: null, asset: null, amount: '', period: 90, quote: null, error: null, pending: false };

	function render() {
		root.replaceChildren();
		el(root, 'h4', 'cover-panel-title', t.provider);
		if (state.phase === 'loading') { el(root, 'p', 'position-muted', t.loading); return; }
		if (state.phase === 'failed') { el(root, 'p', 'position-muted', t.failed); return; }
		const d = state.details;
		if (!d?.available) { el(root, 'p', 'cover-neutral', d?.status === 'AMBIGUOUS' ? t.mapping : t.neutral); return; }

		el(root, 'p', 'cover-product', `${text(d.productName)} · ${text(d.productTypeName)}`);
		const figures = el(root, 'div', 'cover-figures');
		row(figures, t.protocol, d.position?.protocol);
		row(figures, t.network, d.position?.network);
		row(figures, t.supplied, `${text(d.exposure?.grossExposure)} USD`);
		row(figures, t.debt, `${text(d.exposure?.debt)} USD`);
		row(figures, t.exposure, `${text(d.exposure?.suggestedExposure)} USD`);
		const selectable = (d.assets ?? []).filter((asset) => asset.selectable);
		const current = selectable.find((asset) => asset.symbol === state.asset) ?? selectable[0] ?? null;
		if (current) {
			row(figures, t.suggested, `${text(current.maxFromExposure)} ${text(current.symbol)}`, `${t.conversion}: 1 ${text(current.conversion?.referenceToken)} = ${text(current.conversion?.priceUsd)} USD`);
			row(figures, t.capacity, `${text(current.capacity)} ${text(current.symbol)}`);
		}
		row(figures, t.proofOfLoss, proofOfLossText(d.proofOfLoss?.inputTypes));
		row(figures, t.grace, `${text(d.gracePeriodDays)} ${t.days}`);
		// Es gibt keinen Abschluss-Pfad im Browser: der Hinweis steht immer, auch ohne Bereitschaftsfeld.
		const reasons = (Array.isArray(d.readiness?.reasons) ? d.readiness.reasons : []).map((code) => t.readinessReasons[code]).filter(Boolean);
		row(figures, t.readiness, t.readinessBlocked, [...reasons, t.readinessDetail].join(' '));

		const terms = el(root, 'div', 'cover-terms');
		el(terms, 'small', 'figure-label', t.terms);
		termsLink(terms, t.wording, d.wording?.url);
		if (d.annex) termsLink(terms, t.annex, d.annex.url);
		el(terms, 'small', 'figure-help', t.termsNote);

		el(root, 'p', 'cover-disclaimer', t.disclaimer);

		if (!current) { el(root, 'p', 'position-muted', t.noAsset); return; }
		renderForm(current, selectable);
		if (state.error) el(root, 'p', 'cover-error', t.errors[state.error] ?? t.errors.QUOTE_UNAVAILABLE);
		if (state.quote) renderQuote(state.quote);
	}

	function proofOfLossText(types) {
		const list = Array.isArray(types) ? types.filter((type) => typeof type === 'string') : [];
		if (list.length === 1 && t.pol[list[0]]) return t.pol[list[0]];
		return `${t.polOther} ${list.join(', ') || '—'}`;
	}

	function renderForm(current, selectable) {
		const form = el(root, 'div', 'cover-form');
		const assets = el(form, 'div', 'cover-assets');
		el(assets, 'span', 'figure-label', t.asset);
		for (const asset of selectable) {
			const button = el(assets, 'button', asset.symbol === current.symbol ? 'cover-asset active' : 'cover-asset', asset.symbol);
			button.type = 'button';
			button.setAttribute('aria-pressed', String(asset.symbol === current.symbol));
			button.addEventListener('click', () => { state.asset = asset.symbol; state.amount = asset.maxAmount; state.quote = null; state.error = null; render(); });
		}
		if (state.asset !== current.symbol) { state.asset = current.symbol; state.amount = current.maxAmount; }

		const amountLabel = el(form, 'label', 'cover-field');
		el(amountLabel, 'span', 'figure-label', `${t.amount} (${current.symbol})`);
		const amount = el(amountLabel, 'input', 'cover-amount');
		amount.type = 'text';
		amount.inputMode = 'decimal';
		amount.value = state.amount;
		amount.addEventListener('input', () => { state.amount = amount.value; });
		el(amountLabel, 'small', 'figure-help', `${t.maxAmount}: ${text(current.maxAmount)} ${text(current.symbol)}`);

		const periodLabel = el(form, 'label', 'cover-field');
		el(periodLabel, 'span', 'figure-label', t.duration);
		const period = el(periodLabel, 'input', 'cover-period');
		period.type = 'number';
		period.min = String(PERIOD_MIN);
		period.max = String(PERIOD_MAX);
		period.step = '1';
		period.value = String(state.period);
		period.addEventListener('input', () => { state.period = Number(period.value); });
		const presets = el(form, 'div', 'cover-presets');
		for (const days of PRESETS) {
			const button = el(presets, 'button', state.period === days ? 'cover-preset active' : 'cover-preset', `${days} ${t.days}`);
			button.type = 'button';
			button.addEventListener('click', () => { state.period = days; render(); });
		}

		const action = el(form, 'button', 'cover-action primary cover-get-quote', state.pending ? t.quoting : t.getQuote);
		action.type = 'button';
		action.disabled = state.pending;
		action.addEventListener('click', () => requestQuote(amount.value, Number(period.value)));
	}

	function renderQuote(quote) {
		const box = el(root, 'div', 'cover-quote');
		const stale = !(now() < Date.parse(quote.quoteExpiresAt ?? ''));
		el(box, 'strong', stale ? 'cover-quote-stale' : 'cover-quote-fresh', stale ? t.stale : t.fresh);
		row(box, t.quoteFor, `${text(quote.coverAmount)} ${text(quote.coverAsset)} · ${text(quote.periodDays)} ${t.days}`);
		row(box, t.premium, `${text(quote.premium)} ${text(quote.premiumAsset)}`);
		row(box, t.annual, `${text(quote.annualPricePercent)} %`);
		row(box, t.fetched, formatTime(quote.quoteFetchedAt, language));
		row(box, t.validUntil, formatTime(quote.quoteExpiresAt, language));
		el(box, 'small', 'figure-help', t.quoteOnly);
	}

	async function requestQuote(amount, periodDays) {
		if (state.pending) return;
		state.amount = amount;
		state.period = periodDays;
		state.quote = null;
		if (!Number.isInteger(periodDays) || periodDays < PERIOD_MIN || periodDays > PERIOD_MAX) { state.error = 'PERIOD_OUT_OF_RANGE'; render(); return; }
		state.error = null;
		state.pending = true;
		render();
		try {
			const result = await post({ action: 'quote', deploymentKey, coverAsset: state.asset, amount: String(amount).trim(), periodDays });
			if (result?.status === 200 && result.body?.ok === true && result.body.quote) {
				state.quote = result.body.quote;
				const expiresIn = Date.parse(result.body.quote.quoteExpiresAt ?? '') - now();
				if (Number.isFinite(expiresIn)) setTimer(render, Math.max(0, expiresIn) + 50);
			} else {
				state.error = typeof result?.body?.code === 'string' && t.errors[result.body.code] ? result.body.code : 'QUOTE_UNAVAILABLE';
			}
		} catch {
			state.error = 'QUOTE_UNAVAILABLE';
		}
		state.pending = false;
		render();
	}

	async function load() {
		state.phase = 'loading';
		render();
		try {
			const result = await post({ action: 'details', deploymentKey });
			if (result?.status === 200 && result.body?.ok === true) { state.details = result.body; state.phase = 'ready'; } else state.phase = 'failed';
		} catch {
			state.phase = 'failed';
		}
		render();
	}

	return { element: root, load, render, state };
}
