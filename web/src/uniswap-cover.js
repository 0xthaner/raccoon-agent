/*
	Uniswap v3 (Ethereum) im Dashboard (21.10.2026): eine eigene Karte je
	LP-NFT und eine informative Quote. Nur Anzeige.

	Daten kommen aus GET /api/positions (Abschnitt uniswapV3) und aus
	POST /api/nexus/quote ueber das uebergebene `post`. Dieses Modul importiert
	nichts, kennt keinen Wallet-Provider, keine RPC und keinen Preis-Feed und
	ruft keine Wallet-Methode auf. Alle Werte landen nur ueber textContent im
	DOM; der einzige Link ist eine gepruefte Nexus-IPFS-Adresse.

	Wortwahl: die Exposure ist eine Schaetzung, Gebuehren zaehlen nicht mit,
	Impermanent Loss wird nicht als gedeckt dargestellt, die Quote dient nur
	der Information, ein Abschluss ist noch nicht moeglich. Keine Aktion heisst
	Kaufen, Freigeben oder Bestaetigen.
*/
const IPFS_URL = /^https:\/\/api\.nexusmutual\.io\/ipfs\/(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,})$/;
const PERIOD_MIN = 28;
const PERIOD_MAX = 365;
const PRESETS = [30, 90, 180, 365];

const TEXTS = {
	en: {
		sectionTitle: 'Uniswap v3 · Ethereum', none: 'No Uniswap v3 LP positions found on Ethereum.',
		scanIncomplete: 'Uniswap v3 positions could not be read completely right now. Nothing is shown as zero.',
		pricingIncomplete: 'Some Uniswap v3 positions could not be valued completely, so there is no total.',
		kicker: 'Detected LP position', nft: 'NFT', pair: 'Pair', feeTier: 'Fee tier', range: 'Price range',
		ranges: { IN_RANGE: 'In range', BELOW_RANGE: 'Out of range (below)', ABOVE_RANGE: 'Out of range (above)' },
		amounts: 'Current LP amounts', exposure: 'Suggested exposure',
		exposureHelp: 'Estimate of the current value of the assets in this LP position, valued with Chainlink prices. Not a guaranteed claim amount.',
		fees: 'Uncollected fees', feesNote: 'Not included in suggested exposure',
		provider: 'Nexus Mutual', productLine: 'Uniswap v3 – Single Protocol Cover', viewOptions: 'View cover options',
		notice: 'Impermanent loss and normal market losses are excluded: nothing here suggests they would be reimbursed. Quotes are for information only; cover cannot be taken out through CoverRaccoon yet.',
		states: {
			ZERO_LIQUIDITY: 'This position has no active liquidity, so no cover options are shown.',
			UNSUPPORTED_TOKEN_PRICE: 'A token in this position has no supported price feed, so there is no suggested exposure.',
			STALE_PRICE: 'A price for this position is not current right now, so there is no suggested exposure.',
			PRICE_UNAVAILABLE: 'A price for this position is unavailable right now, so there is no suggested exposure.',
			MAPPING_AMBIGUOUS: 'This position cannot be matched to a cover product unambiguously.',
			NOT_SUPPORTED: 'This position is not supported.',
			UNREADABLE: 'This position could not be read right now.'
		},
		source: 'Source: Uniswap v3 · Ethereum (live), valued with Chainlink price feeds',
		loading: 'Loading cover options…', getQuote: 'Get informational quote', quoting: 'Requesting informational quote…',
		product: 'Product', exposurePanel: 'Suggested exposure (LP principal, fees excluded)', asset: 'Cover asset', duration: 'Duration (days)', days: 'days',
		capacity: 'Available capacity', quoteAmount: 'Amount for the quote', limitedBy: { EXPOSURE: 'limited by the suggested exposure', CAPACITY: 'limited by the available capacity' },
		conversion: 'Converted with Chainlink', premium: 'Premium', annual: 'Annual price', quoteFor: 'Informational quote', fetched: 'Quoted at', validUntil: 'Valid until',
		fresh: 'Informational live quote from Nexus Mutual.', stale: 'This quote has expired. Request a new informational quote.',
		quoteOnly: 'For information only. Cover cannot be taken out through CoverRaccoon yet.',
		readiness: 'Cover through CoverRaccoon', readinessBlocked: 'Not available yet',
		readinessDetail: 'We are finalising the required Nexus Mutual terms and proof-of-loss flow before enabling wallet confirmations.',
		wording: 'Cover wording (Nexus Mutual)', grace: 'Grace period', noAsset: 'No cover asset can be selected for this position.',
		assetReasons: { PRICE_UNAVAILABLE: 'no current price', NO_CAPACITY: 'no capacity', NO_EXPOSURE: 'amount too small' },
		errors: {
			QUOTE_AMOUNT_TOO_SMALL: 'A Nexus quote cannot currently be created for this very small amount.',
			QUOTE_UNAVAILABLE: 'Nexus Mutual could not return a valid quote right now. Please try again shortly.',
			CAPACITY_UNAVAILABLE: 'Nexus Mutual capacity is not available right now.',
			ZERO_LIQUIDITY: 'This position has no active liquidity.',
			UNSUPPORTED_TOKEN_PRICE: 'A token in this position has no supported price feed.',
			STALE_PRICE: 'A price for this position is not current right now.',
			PRICE_UNAVAILABLE: 'A price for this position is unavailable right now.',
			POSITION_STALE: 'The position needs to be read again. Please reload the positions.',
			MAPPING_AMBIGUOUS: 'This position cannot be matched to a cover product unambiguously.',
			NOT_SUPPORTED: 'This position is not supported.',
			SCAN_INCOMPLETE: 'Uniswap v3 positions could not be read completely right now.',
			POSITION_NOT_FOUND: 'This NFT is not held by this wallet according to the latest scan.',
			PERIOD_OUT_OF_RANGE: 'The duration must be between 28 and 365 days.',
			ASSET_NOT_SUPPORTED: 'This cover asset is not supported.',
			AMOUNT_OUT_OF_RANGE: 'The amount is outside the allowed range.',
			AMOUNT_ABOVE_EXPOSURE: 'The amount is above the suggested exposure.',
			COVER_NOT_AVAILABLE: 'Cover availability cannot currently be determined for this position.',
			RATE_LIMITED: 'Too many requests. Please try again in a few minutes.'
		}
	},
	de: {
		sectionTitle: 'Uniswap v3 · Ethereum', none: 'Keine Uniswap-v3-LP-Positionen auf Ethereum gefunden.',
		scanIncomplete: 'Die Uniswap-v3-Positionen konnten gerade nicht vollständig gelesen werden. Nichts wird als null angezeigt.',
		pricingIncomplete: 'Einige Uniswap-v3-Positionen konnten nicht vollständig bewertet werden; daher gibt es keine Summe.',
		kicker: 'Erkannte LP-Position', nft: 'NFT', pair: 'Paar', feeTier: 'Gebührenstufe', range: 'Preisbereich',
		ranges: { IN_RANGE: 'Im Bereich', BELOW_RANGE: 'Außerhalb (darunter)', ABOVE_RANGE: 'Außerhalb (darüber)' },
		amounts: 'Aktuelle LP-Mengen', exposure: 'Vorgeschlagenes Engagement',
		exposureHelp: 'Schätzung des aktuellen Werts der Assets in dieser LP-Position, bewertet mit Chainlink-Preisen. Kein garantierter Schadensbetrag.',
		fees: 'Nicht eingesammelte Gebühren', feesNote: 'Nicht im vorgeschlagenen Engagement enthalten',
		provider: 'Nexus Mutual', productLine: 'Uniswap v3 – Single Protocol Cover', viewOptions: 'Cover-Optionen ansehen',
		notice: 'Impermanent Loss und normale Marktverluste sind ausgenommen: nichts hier legt nahe, dass sie erstattet würden. Quotes dienen nur der Information; ein Abschluss über CoverRaccoon ist noch nicht möglich.',
		states: {
			ZERO_LIQUIDITY: 'Diese Position hat keine aktive Liquidität; daher werden keine Cover-Optionen angezeigt.',
			UNSUPPORTED_TOKEN_PRICE: 'Für einen Token dieser Position gibt es keinen unterstützten Preis-Feed; daher kein vorgeschlagenes Engagement.',
			STALE_PRICE: 'Ein Preis für diese Position ist gerade nicht aktuell; daher kein vorgeschlagenes Engagement.',
			PRICE_UNAVAILABLE: 'Ein Preis für diese Position ist gerade nicht verfügbar; daher kein vorgeschlagenes Engagement.',
			MAPPING_AMBIGUOUS: 'Diese Position lässt sich keinem Cover-Produkt eindeutig zuordnen.',
			NOT_SUPPORTED: 'Diese Position wird nicht unterstützt.',
			UNREADABLE: 'Diese Position konnte gerade nicht gelesen werden.'
		},
		source: 'Quelle: Uniswap v3 · Ethereum (live), bewertet über Chainlink-Preis-Feeds',
		loading: 'Cover-Optionen werden geladen …', getQuote: 'Informative Quote abrufen', quoting: 'Informative Quote wird abgerufen …',
		product: 'Produkt', exposurePanel: 'Vorgeschlagenes Engagement (LP-Kapital, ohne Gebühren)', asset: 'Cover-Asset', duration: 'Laufzeit (Tage)', days: 'Tage',
		capacity: 'Verfügbare Kapazität', quoteAmount: 'Betrag für die Quote', limitedBy: { EXPOSURE: 'begrenzt durch das vorgeschlagene Engagement', CAPACITY: 'begrenzt durch die verfügbare Kapazität' },
		conversion: 'Umgerechnet mit Chainlink', premium: 'Prämie', annual: 'Jahrespreis', quoteFor: 'Informative Quote', fetched: 'Abgerufen um', validUntil: 'Gültig bis',
		fresh: 'Informative Live-Quote von Nexus Mutual.', stale: 'Diese Quote ist abgelaufen. Bitte eine neue informative Quote abrufen.',
		quoteOnly: 'Nur zur Information. Ein Abschluss über CoverRaccoon ist noch nicht möglich.',
		readiness: 'Abschluss über CoverRaccoon', readinessBlocked: 'Noch nicht möglich',
		readinessDetail: 'Wir stellen die erforderlichen Bedingungen von Nexus Mutual und den Ablauf für den Schadensnachweis fertig, bevor Bestätigungen in der Wallet freigeschaltet werden.',
		wording: 'Cover-Bedingungen (Nexus Mutual)', grace: 'Nachfrist', noAsset: 'Für diese Position ist kein Cover-Asset wählbar.',
		assetReasons: { PRICE_UNAVAILABLE: 'kein aktueller Preis', NO_CAPACITY: 'keine Kapazität', NO_EXPOSURE: 'Betrag zu klein' },
		errors: {
			QUOTE_AMOUNT_TOO_SMALL: 'Für diesen sehr kleinen Betrag kann derzeit keine Nexus-Quote erstellt werden.',
			QUOTE_UNAVAILABLE: 'Nexus Mutual konnte gerade keine gültige Quote liefern. Bitte gleich erneut versuchen.',
			CAPACITY_UNAVAILABLE: 'Die Kapazität von Nexus Mutual ist gerade nicht verfügbar.',
			ZERO_LIQUIDITY: 'Diese Position hat keine aktive Liquidität.',
			UNSUPPORTED_TOKEN_PRICE: 'Für einen Token dieser Position gibt es keinen unterstützten Preis-Feed.',
			STALE_PRICE: 'Ein Preis für diese Position ist gerade nicht aktuell.',
			PRICE_UNAVAILABLE: 'Ein Preis für diese Position ist gerade nicht verfügbar.',
			POSITION_STALE: 'Die Position muss neu gelesen werden. Bitte die Positionen neu laden.',
			MAPPING_AMBIGUOUS: 'Diese Position lässt sich keinem Cover-Produkt eindeutig zuordnen.',
			NOT_SUPPORTED: 'Diese Position wird nicht unterstützt.',
			SCAN_INCOMPLETE: 'Die Uniswap-v3-Positionen konnten gerade nicht vollständig gelesen werden.',
			POSITION_NOT_FOUND: 'Dieses NFT gehört laut aktuellem Scan nicht zu dieser Wallet.',
			PERIOD_OUT_OF_RANGE: 'Die Laufzeit muss zwischen 28 und 365 Tagen liegen.',
			ASSET_NOT_SUPPORTED: 'Dieses Cover-Asset wird nicht unterstützt.',
			AMOUNT_OUT_OF_RANGE: 'Der Betrag liegt außerhalb des zulässigen Bereichs.',
			AMOUNT_ABOVE_EXPOSURE: 'Der Betrag liegt über dem vorgeschlagenen Engagement.',
			COVER_NOT_AVAILABLE: 'Die Cover-Verfügbarkeit kann für diese Position derzeit nicht bestimmt werden.',
			RATE_LIMITED: 'Zu viele Anfragen. Bitte in ein paar Minuten erneut versuchen.'
		}
	}
};

export function uniswapTexts(language) { return TEXTS[language] ?? TEXTS.en; }

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

function button(parent, label, onClick, className) {
	const node = el(parent, 'button', className, label);
	node.type = 'button';
	node.addEventListener('click', onClick);
	return node;
}

function formatAmount(value, language) {
	const number = Number(value);
	return typeof value === 'string' && value !== '' && Number.isFinite(number) ? number.toLocaleString(language === 'de' ? 'de-DE' : 'en-GB', { maximumFractionDigits: 6 }) : '—';
}
function formatUsd(value, language) {
	const number = Number(value);
	return typeof value === 'string' && value !== '' && Number.isFinite(number) ? new Intl.NumberFormat(language === 'de' ? 'de-AT' : 'en-GB', { style: 'currency', currency: 'USD' }).format(number) : '—';
}
function formatTime(iso, language) {
	const ms = Date.parse(iso ?? '');
	if (!Number.isFinite(ms)) return '—';
	return new Intl.DateTimeFormat(language === 'de' ? 'de-AT' : 'en-GB', { timeStyle: 'medium', dateStyle: 'short' }).format(new Date(ms));
}
const symbolOf = (token) => (typeof token?.symbol === 'string' ? token.symbol : '?');
const tokenIdOf = (value) => (typeof value === 'string' && /^[1-9][0-9]{0,77}$/.test(value) ? value : null);

/**
 * Der Uniswap-Abschnitt unter den Aave-Positionen. `panelFor(tokenId)` liefert
 * ein offenes Quote-Panel oder null; `openPanel(tokenId)` oeffnet eines.
 */
export function renderUniswapSection(parent, section, { language = 'en', panelFor = () => null, openPanel = () => {} } = {}) {
	const t = uniswapTexts(language);
	const box = el(parent, 'section', 'uniswap-section');
	el(box, 'p', 'positions-subheading', t.sectionTitle);
	if (!section || section.status === 'UNAVAILABLE') {
		el(box, 'div', 'dash-empty position-error uniswap-scan-incomplete', t.scanIncomplete);
		return box;
	}
	const positions = Array.isArray(section.positions) ? section.positions : [];
	const unsupported = Array.isArray(section.unsupported) ? section.unsupported : [];
	if (section.status === 'INCOMPLETE') el(box, 'p', 'position-muted uniswap-incomplete', section.reason === 'SCAN_INCOMPLETE' ? t.scanIncomplete : t.pricingIncomplete);
	if (!positions.length && !unsupported.length) el(box, 'div', 'dash-empty uniswap-none', t.none);
	const grid = el(box, 'div', 'position-grid');
	for (const position of positions) renderUniswapCard(grid, position, { t, language, panelFor, openPanel });
	for (const entry of unsupported) {
		const card = el(grid, 'article', 'position-card position-unavailable uniswap-card');
		el(card, 'h3', 'position-title', `Uniswap v3 · ${t.nft} #${text(tokenIdOf(entry.tokenId))}`);
		el(card, 'p', 'position-muted uniswap-state', t.states[entry.reason] ?? t.states.NOT_SUPPORTED);
	}
	el(box, 'p', 'position-source', t.source);
	return box;
}

function renderUniswapCard(parent, position, { t, language, panelFor, openPanel }) {
	const card = el(parent, 'article', 'position-card uniswap-card');
	const pair = `${symbolOf(position.token0)}/${symbolOf(position.token1)}`;
	el(card, 'h3', 'position-title', `Uniswap v3 · ${pair}`);
	el(card, 'small', 'position-kicker', `${t.kicker} · ${t.nft} #${text(tokenIdOf(position.tokenId))}`);
	const figures = el(card, 'div', 'position-figures');
	row(figures, t.feeTier, `${text(position.feeTierPercent)} %`);
	row(figures, t.range, t.ranges[position.rangeState] ?? '—');
	row(figures, t.amounts, `${formatAmount(position.token0?.amount, language)} ${symbolOf(position.token0)} · ${formatAmount(position.token1?.amount, language)} ${symbolOf(position.token1)}`);
	row(figures, t.exposure, position.suggestedExposureUsd ? formatUsd(position.suggestedExposureUsd, language) : '—', t.exposureHelp);
	row(figures, t.fees, `${formatAmount(position.fees?.token0Amount, language)} ${symbolOf(position.token0)} · ${formatAmount(position.fees?.token1Amount, language)} ${symbolOf(position.token1)}`, t.feesNote);
	if (position.nexus?.mapping === 'MATCHED') row(figures, t.provider, t.productLine);
	if (position.coverOptions !== 'AVAILABLE') {
		el(card, 'p', 'position-muted uniswap-state', t.states[position.coverOptions] ?? t.states.NOT_SUPPORTED);
		return card;
	}
	el(card, 'small', 'figure-help uniswap-notice', t.notice);
	const id = tokenIdOf(position.tokenId);
	const open = id ? panelFor(id) : null;
	if (open) card.appendChild(open.element);
	else if (id) button(card, t.viewOptions, () => openPanel(id), 'cover-action cover-details-action uniswap-options-action');
	return card;
}

/** Nur gepruefte Nexus-IPFS-Adressen werden zu Links. */
function termsLink(parent, label, url) {
	if (typeof url !== 'string' || !IPFS_URL.test(url)) return null;
	const link = el(parent, 'a', 'cover-terms-link', label);
	link.href = url;
	link.target = '_blank';
	link.rel = 'noopener noreferrer';
	return link;
}

/**
 * Quote-Panel fuer genau ein NFT. `post(body)` liefert { status, body } von
 * POST /api/nexus/quote. Gesendet werden nur tokenId, coverAsset und
 * periodDays; Wallet, Produkt und Betrag bestimmt der Server.
 */
export function createUniswapPanel({ tokenId, post, language = 'en', now = () => Date.now(), setTimer = (fn, ms) => setTimeout(fn, ms) }) {
	let t = uniswapTexts(language);
	const root = document.createElement('div');
	root.className = 'cover-panel uniswap-panel';
	const state = { phase: 'loading', details: null, failCode: null, asset: null, period: 90, quote: null, error: null, pending: false };

	const codeOf = (result) => {
		if (result?.status === 429) return 'RATE_LIMITED';
		const code = result?.body?.code;
		return typeof code === 'string' && Object.hasOwn(t.errors, code) ? code : 'QUOTE_UNAVAILABLE';
	};

	function render() {
		root.replaceChildren();
		el(root, 'h4', 'cover-panel-title', t.provider);
		if (state.phase === 'loading') { el(root, 'p', 'position-muted', t.loading); return; }
		if (state.phase === 'failed') { el(root, 'p', 'cover-neutral', t.errors[state.failCode] ?? t.errors.QUOTE_UNAVAILABLE); return; }
		const d = state.details;
		el(root, 'p', 'cover-product', `${text(d.productName)} · ${text(d.productTypeName)}`);
		const figures = el(root, 'div', 'cover-figures');
		row(figures, t.product, `${text(d.productName)} – ${text(d.productTypeName)}`);
		row(figures, t.exposurePanel, formatUsd(d.exposure?.suggestedExposure, language), t.exposureHelp);
		const selectable = (Array.isArray(d.assets) ? d.assets : []).filter((asset) => asset.selectable === true);
		const current = selectable.find((asset) => asset.symbol === state.asset) ?? selectable[0] ?? null;
		if (current) {
			row(figures, t.capacity, `${text(current.capacity)} ${text(current.symbol)}`);
			row(figures, t.quoteAmount, `${text(current.maxAmount)} ${text(current.symbol)}`, `${t.limitedBy[current.limitedBy] ?? ''} · ${t.conversion} ${text(current.conversion?.description)} = ${text(current.conversion?.priceUsd)} USD`);
		}
		row(figures, t.grace, `${text(d.gracePeriodDays)} ${t.days}`);
		row(figures, t.readiness, t.readinessBlocked, t.readinessDetail);
		const terms = el(root, 'div', 'cover-terms');
		termsLink(terms, t.wording, d.wording?.url);
		el(root, 'p', 'cover-disclaimer', t.notice);
		if (!current) {
			const reasons = (Array.isArray(d.assets) ? d.assets : []).map((asset) => `${text(asset.symbol)}: ${t.assetReasons[asset.reason] ?? '—'}`).join(' · ');
			el(root, 'p', 'position-muted', `${t.noAsset} ${reasons}`.trim());
			return;
		}
		renderForm(current, selectable);
		if (state.error) el(root, 'p', 'cover-error', t.errors[state.error] ?? t.errors.QUOTE_UNAVAILABLE);
		if (state.quote) renderQuote(state.quote);
	}

	function renderForm(current, selectable) {
		const form = el(root, 'div', 'cover-form');
		const assets = el(form, 'div', 'cover-assets');
		el(assets, 'span', 'figure-label', t.asset);
		for (const asset of selectable) {
			const node = button(assets, asset.symbol, () => { state.asset = asset.symbol; state.quote = null; state.error = null; render(); }, asset.symbol === current.symbol ? 'cover-asset active' : 'cover-asset');
			node.setAttribute('aria-pressed', String(asset.symbol === current.symbol));
		}
		state.asset = current.symbol;
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
		for (const days of PRESETS) button(presets, `${days} ${t.days}`, () => { state.period = days; render(); }, state.period === days ? 'cover-preset active' : 'cover-preset');
		const action = button(form, state.pending ? t.quoting : t.getQuote, () => requestQuote(Number(period.value)), 'cover-action primary cover-get-quote');
		action.disabled = state.pending;
	}

	function renderQuote(quote) {
		const box = el(root, 'div', 'cover-quote');
		const stale = !(now() < Date.parse(quote.quoteExpiresAt ?? ''));
		el(box, 'strong', stale ? 'cover-quote-stale' : 'cover-quote-fresh', stale ? t.stale : t.fresh);
		row(box, t.quoteFor, `${text(quote.coverAmount)} ${text(quote.coverAsset)} · ${text(quote.periodDays)} ${t.days}`);
		row(box, t.premium, `${text(quote.premium)} ${text(quote.premiumAsset)}`);
		row(box, t.annual, `${text(quote.annualPricePercent)} %`);
		row(box, t.capacity, `${text(quote.capacity)} ${text(quote.coverAsset)}`);
		row(box, t.fetched, formatTime(quote.quoteFetchedAt, language));
		row(box, t.validUntil, formatTime(quote.quoteExpiresAt, language));
		el(box, 'small', 'figure-help', t.quoteOnly);
	}

	async function requestQuote(periodDays) {
		if (state.pending) return;
		state.period = periodDays;
		state.quote = null;
		if (!Number.isInteger(periodDays) || periodDays < PERIOD_MIN || periodDays > PERIOD_MAX) { state.error = 'PERIOD_OUT_OF_RANGE'; render(); return; }
		state.error = null;
		state.pending = true;
		render();
		try {
			const result = await post({ action: 'uniswap-quote', tokenId, coverAsset: state.asset, periodDays });
			if (result?.status === 200 && result.body?.ok === true && result.body.quote) {
				state.quote = result.body.quote;
				const expiresIn = Date.parse(result.body.quote.quoteExpiresAt ?? '') - now();
				if (Number.isFinite(expiresIn)) setTimer(render, Math.max(0, expiresIn) + 50);
			} else {
				state.error = codeOf(result);
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
			const result = await post({ action: 'uniswap-details', tokenId });
			if (result?.status === 200 && result.body?.ok === true && result.body.available === true) { state.details = result.body; state.phase = 'ready'; } else { state.phase = 'failed'; state.failCode = codeOf(result); }
		} catch {
			state.phase = 'failed';
			state.failCode = 'QUOTE_UNAVAILABLE';
		}
		render();
	}

	function setLanguage(next) {
		language = TEXTS[next] ? next : 'en';
		t = TEXTS[language];
		render();
	}

	return { element: root, load, render, setLanguage, state };
}
