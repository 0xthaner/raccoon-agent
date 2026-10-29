/*
	AAVE V3 ETHEREUM: SCOPE, SUPPORT-MATRIX UND KAUFBEREITSCHAFT (20.10.2026).

	Was "Aave unterstuetzt" bei CoverRaccoon heisst, steht hier an einer Stelle
	und wird aus den Implementierungs-Konstanten abgeleitet, nicht behauptet:

	  aave-registry.mjs    gepruefte Maerkte (Adressbuch + Provider-Gegenprobe)
	  nexus-mapping.mjs    strenge Zuordnung Markt -> Nexus-Produkt (EXACT/PROBABLE/...)
	  exposure.mjs         AAVE_NET_EXPOSURE_V1, BigInt
	  nexus-pinned.mjs     Produkt 97, Cover-Assets, Proof-of-Loss-Arten

	Rein: kein Netz, keine Datenbank, keine Wallet, keine Uhr (jede Zeit wird
	uebergeben). Dieses Modul baut, signiert und sendet nichts und importiert
	keines der reinen Kauf-Module (die bleiben von Laufzeitcode unerreichbar).

	Kaufbereitschaft: evaluateAavePurchaseReadiness ist die eine serverseitige
	Entscheidung. Sie ist READY nur, wenn ALLE Bedingungen erfuellt sind; die
	externen Blocker (Nexus-Bestaetigungen CR-TERMS-002 und CR-POL-002, die
	fehlende Wallet-Ausfuehrung CR-PURCHASE-008 P3) stehen unten fest als
	UNRESOLVED und lassen sich zur Laufzeit nicht abschalten - es gibt keinen
	Parameter dafuer. Erst eine dokumentierte Antwort von Nexus und eine neue
	Phase duerfen diese Liste aendern (test/aave-cover-readiness.test.mjs
	gleicht sie mit security/crsf/controls.json ab).
*/
import { AAVE_V3_MARKETS, CHAIN_ID } from './positions/aave-registry.mjs';
import { matchPositionToNexus } from './positions/nexus-mapping.mjs';
import { computeAaveExposure } from './positions/exposure.mjs';
import { NEXUS_ASSETS, PINNED_PRODUCTS } from './nexus-pinned.mjs';

export const AAVE_PRODUCT_ID = 97;

/** Hoechstalter von Quote und Kapazitaet fuer jede Entscheidung, die zu einem Senden fuehren koennte (gleich P3/P4A). */
export const MAX_QUOTE_AGE_MS = 60_000;

/*
	Deployment-Klassen. SUPPORTED nur ueber die exakte Registry (Kette, Protokoll,
	Version, Deployment-Kennung UND Pool-Adresse); alles andere faellt geschlossen.
	Die Ausschluesse sind am 20.10.2026 gegen den Nexus-Katalog gelesen:
	Produkt 2 "aave v2" ist DEPRECATED, Produkt 449 "aave v4" ist ein eigenes
	Produkt, das CoverRaccoon nicht abbildet; Horizon ist ein zugangsbeschraenkter
	RWA-Markt ohne gepruefte Zuordnung.
*/
export const DEPLOYMENT_CLASSES = Object.freeze(['SUPPORTED', 'UNSUPPORTED', 'AMBIGUOUS', 'DEPRECATED']);
export const EXCLUDED_AAVE_SCOPES = Object.freeze([
	Object.freeze({ scope: 'aave-v2-ethereum', class: 'DEPRECATED', reason: 'AAVE_V2_NOT_V3; Nexus product 2 (aave v2) is deprecated' }),
	Object.freeze({ scope: 'aave-v4', class: 'UNSUPPORTED', reason: 'AAVE_V4_NOT_MAPPED; Nexus product 449 is a separate product' }),
	Object.freeze({ scope: 'aave-v3-ethereum-horizon', class: 'UNSUPPORTED', reason: 'HORIZON_PERMISSIONED_RWA_MARKET' }),
	Object.freeze({ scope: 'aave-v3-other-chains', class: 'UNSUPPORTED', reason: 'ONLY_ETHEREUM_MAINNET (Arbitrum, Base, Optimism, Polygon, Avalanche and all others excluded)' })
]);

const sameAddress = (a, b) => typeof a === 'string' && typeof b === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a) && a.toLowerCase() === b.toLowerCase();

/**
 * Klasse eines (behaupteten) Aave-Deployments. Nur die exakte Registry-Identitaet ist SUPPORTED;
 * ein bekannter Markt mit widerspruechlichen Angaben ist AMBIGUOUS, v2 DEPRECATED, alles andere UNSUPPORTED.
 */
export function classifyAaveDeployment(candidate) {
	if (candidate === null || typeof candidate !== 'object') return Object.freeze({ class: 'UNSUPPORTED', reason: 'NOT_A_DEPLOYMENT' });
	const { chainId, protocolKey, protocolVersion, deploymentKey, marketAddress } = candidate;
	if (protocolKey !== 'aave') return Object.freeze({ class: 'UNSUPPORTED', reason: 'NOT_AAVE' });
	if (protocolVersion === 'v2') return Object.freeze({ class: 'DEPRECATED', reason: 'AAVE_V2' });
	if (protocolVersion !== 'v3') return Object.freeze({ class: 'UNSUPPORTED', reason: 'UNSUPPORTED_VERSION' });
	if (chainId !== CHAIN_ID) return Object.freeze({ class: 'UNSUPPORTED', reason: 'UNSUPPORTED_CHAIN' });
	const market = AAVE_V3_MARKETS.find((entry) => entry.deploymentKey === deploymentKey);
	if (!market) return Object.freeze({ class: 'UNSUPPORTED', reason: 'UNKNOWN_DEPLOYMENT' });
	if (market.chainId !== chainId || market.protocolVersion !== protocolVersion || !sameAddress(marketAddress, market.pool)) {
		return Object.freeze({ class: 'AMBIGUOUS', reason: 'REGISTRY_CONFLICT' });
	}
	return Object.freeze({ class: 'SUPPORTED', reason: 'EXACT_REGISTRY_MATCH', deploymentKey: market.deploymentKey });
}

/** Strenge Nexus-Zuordnung in drei Klassen: nur MATCHED darf zu Kapazitaet und Quote. */
export function nexusMappingClass(position) {
	const match = matchPositionToNexus(position);
	if (match.status === 'EXACT' && match.productId === AAVE_PRODUCT_ID) return Object.freeze({ class: 'MATCHED', productId: match.productId, reason: match.reason });
	if (match.status === 'PROBABLE' || match.status === 'AMBIGUOUS') return Object.freeze({ class: 'AMBIGUOUS', productId: null, reason: match.reason });
	return Object.freeze({ class: 'UNSUPPORTED', productId: null, reason: match.reason });
}

/*
	Assets. Anzeige und Quote: was Produkt 97 fuehrt UND CoverRaccoon kennt
	(ETH, USDC, cbBTC; am 20.10.2026 live gegen /v2/products/97 bestaetigt).
	Fuer einen spaeteren Abschluss gilt die strengere P4A-Politik: nur USDC
	(der Abgleich mit dem Intent-Modell steht in test/purchase-intent.test.mjs).
*/
export const QUOTE_COVER_ASSETS = Object.freeze(Object.values(NEXUS_ASSETS).map((asset) => asset.symbol));
export const PURCHASE_COVER_ASSETS = Object.freeze(['USDC']);
export const PURCHASE_DEPLOYMENT_KEYS = Object.freeze(['aave-v3-ethereum-core']);

/*
	Externe Blocker. Fest, nicht konfigurierbar. Solange auch nur einer UNRESOLVED
	ist, gibt es keine Kaufbereitschaft.
*/
export const EXTERNAL_BLOCKERS = Object.freeze([
	Object.freeze({ id: 'CR-TERMS-002', area: 'TERMS', status: 'UNRESOLVED', summary: 'Nexus has not confirmed the distributor / point-of-sale wording, the restricted-country acknowledgement and the membership-at-claim text' }),
	Object.freeze({ id: 'CR-POL-002', area: 'PROOF_OF_LOSS', status: 'UNRESOLVED', summary: 'Nexus has not confirmed proof-of-loss metadata semantics for product 97 (claimability without metadata, creator/owner, idempotency, retention)' }),
	Object.freeze({ id: 'CR-PURCHASE-008/P3', area: 'WALLET_EXECUTION', status: 'UNRESOLVED', summary: 'no wallet execution path exists; transaction code is out of scope until Nexus answers' })
]);
const unresolved = (area) => EXTERNAL_BLOCKERS.filter((blocker) => blocker.area === area && blocker.status !== 'RESOLVED');

/** Terms: was technisch bekannt ist (gepinntes Wording, kein Annex) und ob extern alles bestaetigt ist. */
export function termsReadiness() {
	const product = PINNED_PRODUCTS[AAVE_PRODUCT_ID];
	const blockers = unresolved('TERMS');
	return Object.freeze({
		status: blockers.length ? 'TERMS_BLOCKED' : 'TERMS_READY',
		known: Object.freeze({ wordingCid: product.wordingCid, annexCid: product.annexCid }),
		blockers: Object.freeze(blockers.map((blocker) => blocker.id))
	});
}

/**
 * Proof-of-Loss: die erwarteten Arten aus dem Pin; weicht die gelesene Liste ab, ist das ein
 * eigener Blocker. `inputTypes` ist die von Nexus gelesene (verifizierte) Liste oder null.
 */
export function polReadiness(inputTypes) {
	const expected = PINNED_PRODUCTS[AAVE_PRODUCT_ID].proofOfLossInputTypes;
	const reasons = [];
	if (!Array.isArray(inputTypes)) reasons.push('POL_TYPES_UNKNOWN');
	else if (inputTypes.length !== expected.length || inputTypes.some((type, i) => type !== expected[i])) reasons.push('POL_TYPES_UNEXPECTED');
	const blockers = unresolved('PROOF_OF_LOSS').map((blocker) => blocker.id);
	return Object.freeze({
		status: reasons.length || blockers.length ? 'POL_BLOCKED' : 'POL_READY',
		known: Object.freeze({ expectedInputTypes: expected, observedInputTypes: Array.isArray(inputTypes) ? Object.freeze([...inputTypes]) : null }),
		reasons: Object.freeze(reasons),
		blockers: Object.freeze(blockers)
	});
}

const WALLET = /^0x[0-9a-f]{40}$/;
const isTime = (t) => Number.isSafeInteger(t) && t > 0;
const parseTime = (iso) => { const t = Date.parse(iso ?? ''); return Number.isFinite(t) ? t : null; };
/** Frisch heisst: nicht in der Zukunft und juenger als MAX_QUOTE_AGE_MS (exklusiv). */
export const isFreshAt = (fetchedMs, now) => fetchedMs !== null && fetchedMs <= now && now - fetchedMs < MAX_QUOTE_AGE_MS;

function decimalToRaw(text, decimals) {
	const pattern = new RegExp(`^(0|[1-9][0-9]{0,29})(\\.[0-9]{1,${decimals}})?$`);
	if (typeof text !== 'string' || !pattern.test(text)) return null;
	const [whole, fraction = ''] = text.split('.');
	return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
}

export const READINESS_DECISIONS = Object.freeze(['READY_FOR_PURCHASE_EXECUTION', 'BLOCKED']);
const INPUT_KEYS = Object.freeze(['sessionWallet', 'position', 'model', 'bounds', 'quote', 'allocation', 'execution', 'now']);

/**
 * Die eine serverseitige Entscheidung fuer einen Aave-Abschluss. Liefert immer alle Gruende.
 *
 *   sessionWallet  Wallet der verifizierten Sitzung (nie aus dem Body)
 *   position       erkannte Position (aave-v3.mjs), serverseitig neu aufgeloest
 *   model          Nexus-Lesemodell (nexus-read-model.mjs)
 *   bounds         coverBounds(model, position)
 *   quote          quoteView einer Live-Quote oder null
 *   allocation     Ergebnis der Pool-Allokationspruefung oder null
 *   execution      { pinsVerified, unresolvedAttempt, preSendFresh } oder null (nicht geprueft)
 *   now            Serverzeit in ms
 */
export function evaluateAavePurchaseReadiness(input) {
	const reasons = [];
	const add = (code) => { if (!reasons.includes(code)) reasons.push(code); };
	if (!input || typeof input !== 'object' || Array.isArray(input)) add('INVALID_INPUT');
	else for (const key of Object.keys(input)) if (!INPUT_KEYS.includes(key)) add(`UNKNOWN_FIELD:${key}`);
	const { sessionWallet, position, model, bounds, quote, allocation, execution, now } = input && typeof input === 'object' ? input : {};
	if (!isTime(now)) add('INVALID_NOW');

	// 1. Wallet
	const wallet = typeof sessionWallet === 'string' ? sessionWallet.toLowerCase() : null;
	if (!wallet || !WALLET.test(wallet)) add('WALLET_NOT_AUTHENTICATED');
	else if (String(position?.wallet ?? '').toLowerCase() !== wallet) add('WALLET_MISMATCH');

	// 2. Markt
	const deployment = classifyAaveDeployment(position);
	if (deployment.class !== 'SUPPORTED') add(deployment.reason === 'UNSUPPORTED_CHAIN' ? 'CHAIN_MISMATCH' : 'MARKET_NOT_SUPPORTED');
	else if (!PURCHASE_DEPLOYMENT_KEYS.includes(deployment.deploymentKey)) add('MARKET_NOT_IN_PURCHASE_SCOPE');

	// 3. Engagement
	const exposure = position ? computeAaveExposure(position) : null;
	if (exposure?.status !== 'OK') add('EXPOSURE_INVALID');
	else if (exposure.suggestedExposure === '0') add('NO_SUGGESTED_EXPOSURE');

	// 4. Zuordnung und Verfuegbarkeit
	const mapping = nexusMappingClass(position);
	if (mapping.class !== 'MATCHED') add('NEXUS_MAPPING_NOT_MATCHED');
	if (model?.nexusMatch?.status !== 'EXACT' || model?.nexusMatch?.productId !== AAVE_PRODUCT_ID || model?.eligibility?.status !== 'AVAILABLE') add('COVER_NOT_AVAILABLE');

	// 5. Kapazitaet
	const capacityAt = parseTime(model?.capacity?.fetchedAt);
	if (capacityAt === null) add('CAPACITY_MISSING');
	else if (!isTime(now) || !isFreshAt(capacityAt, now)) add('CAPACITY_STALE');

	// 6. Quote: frisch, erlaubtes Asset, innerhalb der Grenzen
	if (!quote || typeof quote !== 'object') add('QUOTE_MISSING');
	else {
		const quotedAt = parseTime(quote.quoteFetchedAt);
		const expiresAt = parseTime(quote.quoteExpiresAt);
		if (quotedAt === null || expiresAt === null || !isTime(now) || !isFreshAt(quotedAt, now) || !(now < expiresAt) || expiresAt - quotedAt > MAX_QUOTE_AGE_MS) add('QUOTE_STALE');
		if (!PURCHASE_COVER_ASSETS.includes(quote.coverAsset) || quote.premiumAsset !== quote.coverAsset) add('PAYMENT_ASSET_NOT_SUPPORTED');
		const asset = Object.values(NEXUS_ASSETS).find((entry) => entry.symbol === quote.coverAsset);
		const bound = Array.isArray(bounds) ? bounds.find((entry) => entry?.symbol === quote.coverAsset) : null;
		// Kaufgrenze (CR-NEXUS-007.P4): die von Nexus ANGEBOTENE Summe (Grundlage der Praemie), nicht die
		// angefragte, gegen min(Engagement, Kapazitaet). Die freie Quote hebt diese Grenze nie auf.
		const amount = asset ? decimalToRaw(quote.offeredAmount, asset.decimals) : null;
		if (!bound?.purchaseSelectable || amount === null || amount <= 0n || amount > BigInt(bound.purchaseMaxRaw ?? '0')) add('QUOTE_OUT_OF_BOUNDS');
		if (!Number.isSafeInteger(quote.periodDays) || quote.periodDays < 28 || quote.periodDays > 365) add('QUOTE_PERIOD_INVALID');
	}

	// 7. Allokation
	if (allocation?.ok !== true) add('ALLOCATION_NOT_VALIDATED');

	// 8. Terms und Proof-of-Loss
	const terms = termsReadiness();
	if (terms.status !== 'TERMS_READY') add('TERMS_BLOCKED');
	const pol = polReadiness(model?.nexusMatch?.proofOfLossInputTypes ?? null);
	if (pol.status !== 'POL_READY') add('POL_BLOCKED');

	// 9. Ausfuehrungszustand (Pins, offene Versuche, Pre-Send) - ohne Pruefung kein Ja
	if (!execution || typeof execution !== 'object') add('EXECUTION_STATE_NOT_CHECKED');
	else {
		if (execution.pinsVerified !== true) add('CONTRACT_PINS_NOT_VERIFIED');
		if (execution.unresolvedAttempt !== false) add('UNRESOLVED_EXECUTION_ATTEMPT');
		if (execution.preSendFresh !== true) add('PRE_SEND_STATE_STALE');
	}

	// 10. Externe Blocker, immer zuletzt und nie abschaltbar
	for (const blocker of EXTERNAL_BLOCKERS) if (blocker.status !== 'RESOLVED') add(`EXTERNAL:${blocker.id}`);

	return Object.freeze({
		decision: reasons.length === 0 ? 'READY_FOR_PURCHASE_EXECUTION' : 'BLOCKED',
		readyForPurchaseExecution: reasons.length === 0,
		reasons: Object.freeze(reasons),
		terms: terms.status,
		proofOfLoss: pol.status
	});
}

/*
	Oeffentliche Form fuer die Anzeige (/api/nexus/quote, action details): nur der
	Status und neutrale Gruende, keine Kauf-Begriffe, keine Interna. Die Anzeige-
	API bleibt ohne Kauf-Oberflaeche (QUOTE-SURFACE in test/nexus-quote.test.mjs).
*/
const PUBLIC_REASONS = Object.freeze({
	TERMS_BLOCKED: 'NEXUS_TERMS_UNCONFIRMED',
	POL_BLOCKED: 'NEXUS_PROOF_OF_LOSS_UNCONFIRMED',
	'EXTERNAL:CR-PURCHASE-008/P3': 'WALLET_EXECUTION_NOT_AVAILABLE',
	MARKET_NOT_IN_PURCHASE_SCOPE: 'MARKET_NOT_IN_SCOPE',
	NO_SUGGESTED_EXPOSURE: 'NO_SUGGESTED_EXPOSURE'
});
export function publicReadiness(readiness) {
	const reasons = [...new Set(readiness.reasons.map((code) => PUBLIC_REASONS[code]).filter(Boolean))];
	return Object.freeze({ status: readiness.decision === 'READY_FOR_PURCHASE_EXECUTION' ? 'READY' : 'BLOCKED', reasons: Object.freeze(reasons) });
}

/*
	Cover-Status einer Aave-Position. Ein Nexus-Cover gehoert NICHT automatisch
	zur erkannten Position: ACTIVE_COVER nur ueber eine vom Wallet-Inhaber
	bestaetigte, gegen den aktuellen Stand gueltige Zuordnung (position-
	attributions.mjs reconcile -> valid) fuer genau diesen Markt, mit einem Cover
	dieser Wallet, Produkt 97, Status active UND endsAt in der Zukunft.
*/
export const COVER_STATES = Object.freeze(['ACTIVE_COVER', 'NO_ACTIVE_COVER', 'UNKNOWN', 'UNSUPPORTED']);

/**
 * `covers` ist { wallet, covers: [...] } oder null (nicht gelesen); `validAttributions` die valid-Liste aus reconcile.
 */
export function aaveCoverStatus({ wallet, position, covers, validAttributions, now }) {
	const owner = typeof wallet === 'string' ? wallet.toLowerCase() : null;
	if (classifyAaveDeployment(position).class !== 'SUPPORTED') return Object.freeze({ state: 'UNSUPPORTED', coverId: null });
	if (!owner || String(position.wallet ?? '').toLowerCase() !== owner) return Object.freeze({ state: 'UNKNOWN', coverId: null, reason: 'WALLET_MISMATCH' });
	if (!covers || !Array.isArray(covers.covers) || String(covers.wallet ?? '').toLowerCase() !== owner || !isTime(now)) return Object.freeze({ state: 'UNKNOWN', coverId: null, reason: 'COVERS_UNAVAILABLE' });
	if (!Array.isArray(validAttributions)) return Object.freeze({ state: 'UNKNOWN', coverId: null, reason: 'ATTRIBUTIONS_UNAVAILABLE' });
	const active = (cover) => cover && cover.demo !== true && cover.status === 'active' && cover.productId === AAVE_PRODUCT_ID && (parseTime(cover.endsAt) ?? 0) > now;
	for (const attribution of validAttributions) {
		if (attribution?.deploymentKey !== position.deploymentKey || attribution.productId !== AAVE_PRODUCT_ID) continue;
		const cover = covers.covers.find((entry) => entry?.coverId === attribution.coverId);
		if (active(cover)) return Object.freeze({ state: 'ACTIVE_COVER', coverId: cover.coverId, endsAt: cover.endsAt });
	}
	// Ein aktives Produkt-97-Cover ohne Zuordnung bleibt ein offener Hinweis, kein Treffer.
	const unattributed = covers.covers.filter(active).length;
	return Object.freeze({ state: 'NO_ACTIVE_COVER', coverId: null, attributionOpen: unattributed > 0 });
}

/** Restlaufzeit eines Covers in ganzen Tagen (aufgerundet), null wenn abgelaufen oder unlesbar. */
export function coverDaysLeft(cover, now) {
	const ends = parseTime(cover?.endsAt);
	if (ends === null || !isTime(now) || ends <= now) return null;
	return Math.ceil((ends - now) / 86_400_000);
}

/*
	Support-Matrix, abgeleitet aus den Konstanten oben. YES/NO/BLOCKED_EXTERNAL/
	SCOPE_UNCONFIRMED sind Aussagen ueber die Implementierung, keine Werbung.
*/
export function aaveSupportMatrix() {
	const terms = termsReadiness().status === 'TERMS_READY' ? 'YES' : 'BLOCKED_EXTERNAL';
	const pol = unresolved('PROOF_OF_LOSS').length ? 'BLOCKED_EXTERNAL' : 'YES';
	const execution = unresolved('WALLET_EXECUTION').length ? 'NO' : 'YES';
	const rows = AAVE_V3_MARKETS.map((market) => {
		const probe = { deploymentKey: market.deploymentKey, chainId: market.chainId, protocolKey: market.protocolKey, protocolVersion: market.protocolVersion, marketAddress: market.pool };
		const mapping = nexusMappingClass(probe);
		const matched = mapping.class === 'MATCHED';
		return Object.freeze({
			deploymentKey: market.deploymentKey,
			market: `Aave v3 Ethereum ${market.label}`,
			class: classifyAaveDeployment(probe).class,
			positionDetection: 'YES',
			exposure: 'YES',
			nexusMapping: mapping.class,
			nexusProductId: matched ? mapping.productId : null,
			capacity: matched ? 'YES' : 'NO',
			quote: matched ? 'YES' : 'NO',
			quoteAssets: matched ? QUOTE_COVER_ASSETS : Object.freeze([]),
			purchaseAssets: matched && PURCHASE_DEPLOYMENT_KEYS.includes(market.deploymentKey) ? PURCHASE_COVER_ASSETS : Object.freeze([]),
			terms: matched ? terms : 'NOT_APPLICABLE',
			proofOfLoss: matched ? pol : 'NOT_APPLICABLE',
			purchaseExecution: matched ? execution : 'NO',
			coverMonitoring: 'YES'
		});
	});
	return Object.freeze({ scope: 'Aave v3 · Ethereum mainnet (chainId 1)', nexusProductId: AAVE_PRODUCT_ID, markets: Object.freeze(rows), excluded: EXCLUDED_AAVE_SCOPES, externalBlockers: EXTERNAL_BLOCKERS });
}
