/*
	POST /api/nexus/quote - Nexus-Cover-Details und Live-Quote fuer eine
	erkannte Position der angemeldeten Wallet (P3, 18.10.2026). Nur Anzeige.

	Body (JSON, hoechstens 1 KB, gleiche Herkunft):
	  { action: 'details', deploymentKey }
	  { action: 'quote',   deploymentKey, coverAsset, amount, periodDays }
	  { action: 'uniswap-details', tokenId }                         (21.10.2026)
	  { action: 'uniswap-quote',   tokenId, coverAsset, periodDays [, amount] }
	Kein Abfrageparameter, keine Wallet, keine Produkt-ID (400), keine Adresse.
	Die Wallet kommt ausschliesslich aus der verifizierten Dashboard-Sitzung
	(Konflikt- und Widerrufspruefung wie /api/positions); die Position wird
	serverseitig neu aufgeloest, das Produkt nur ueber die strenge Zuordnung
	(EXACT) bestimmt.

	Ratenlimits (je 10 Minuten), damit eine Quote Nexus nicht billig vervielfacht:
	  nexus-cover-ip        30 je IP          beide Aktionen
	  nexus-cover-wallet    20 je Wallet      beide Aktionen
	  nexus-read-global    400 gesamt         vor jedem Lesemodell (Produkt/Kapazitaet, gecacht)
	  nexus-quote-wallet    10 je Wallet      nur vor einem /v2/quote-Abruf
	  nexus-quote-global   200 gesamt         nur vor einem /v2/quote-Abruf (rund 1 je 3 s)
	  positions-lookup-global wie /api/positions (nur bei Positions-Cache-Fehlschlag)
	Freie Quote (29.10.2026): der Aave-Betrag ist nur durch die Nexus-Kapazitaet
	begrenzt, nicht durch das erkannte Engagement (src/nexus-quote.mjs); die
	Antwort traegt angefragte und angebotene Summe getrennt.
	Quote-Budgets werden erst nach allen lokalen Pruefungen gezogen: eine
	ungueltige Anfrage erreicht Nexus nie und kostet kein Quote-Budget.

	Uniswap v3 (Ethereum, Produkt 72): dieselben Pruefungen und dieselben
	Budgets. Das NFT wird im serverseitigen Scan der Sitzungs-Wallet gesucht
	(src/positions/uniswap-v3-service.mjs); Produkt, Pool, Exposure, Betrag und
	Kapazitaet bestimmt der Server. Ohne `amount` gilt die Obergrenze
	min(Exposure umgerechnet ueber Chainlink, Kapazitaet). Eine Uniswap-Quote
	wird hoechstens bis zu ihrem Ablauf (60 s) je Wallet, NFT, Asset, Laufzeit,
	Betrag und Block wiederverwendet; ein Treffer kostet kein Quote-Budget.

	Seit 27.10.2026 hinter UNISWAP_V3_AKTIV (src/pause.mjs, Standard false):
	ausgeschaltet gehen `uniswap-*`-Aktionen durch parseCoverRequest und werden
	wie jede unbekannte Aktion mit 400 INVALID_BODY abgelehnt - vor Sitzung,
	Scan und Wallet-/Quote-Budgets (das IP-Budget zaehlt wie bei jeder Anfrage).

	Keine Transaktion, keine Freigabe, kein Kauf, kein Proof-of-Loss, keine
	Speicherung, keine Vertragsdaten in der Antwort.
*/
import { resolveDashboardSession } from '../../src/dashboard-auth.mjs';
import { isDashboardSessionRevoked } from '../../src/db.mjs';
import { enforceRateLimit, enforceRateLimitFor, requireJson, requireSameOrigin } from '../../src/http-security.mjs';
import { UNISWAP_V3_AKTIV } from '../../src/pause.mjs';
import { getWalletPositions, LookupNotAdmittedError, PositionsBusyError } from '../../src/positions/index.mjs';
import { getNexusReadModel } from '../../src/nexus-read-model.mjs';
import { checkQuoteRequest, coverDetails, parseCoverRequest, QUOTE_TTL_MS, requestCoverQuote } from '../../src/nexus-quote.mjs';
import { queryKeys, queryParams } from '../../src/request-query.mjs';
import { cachedQuote, findScannedPosition, getUniswapScan, parseUniswapBody, prepareUniswapQuote, quoteCacheKey, runUniswapQuote, uniswapDetails, uniswapModelFor } from '../../src/positions/uniswap-v3-service.mjs';

const MAX_BODY_BYTES = 1_024;
export const LIMITS = Object.freeze({
	ip: [30, 600], wallet: [20, 600], readGlobal: [400, 600], quoteWallet: [10, 600], quoteGlobal: [200, 600]
});

const MESSAGES = {
	INVALID_BODY: [400, 'Erwartet wird { action, deploymentKey } bzw. { action, deploymentKey, coverAsset, amount, periodDays }.'],
	PRODUCT_ID_NOT_ACCEPTED: [400, 'Das Produkt bestimmt der Server; eine Produkt-ID wird nicht angenommen.'],
	ASSET_NOT_SUPPORTED: [422, 'Dieses Cover-Asset wird für diese Position nicht unterstützt.'],
	INVALID_AMOUNT: [422, 'Ungültiger Betrag.'],
	AMOUNT_OUT_OF_RANGE: [422, 'Der Betrag liegt außerhalb des zulässigen Bereichs.'],
	PERIOD_OUT_OF_RANGE: [422, 'Die Laufzeit muss zwischen 28 und 365 Tagen liegen.'],
	COVER_NOT_AVAILABLE: [409, 'Die Cover-Verfügbarkeit kann für diese Position derzeit nicht bestimmt werden.'],
	QUOTE_UNAVAILABLE: [503, 'Nexus Mutual hat gerade keine gültige Quote geliefert.'],
	QUOTE_AMOUNT_TOO_SMALL: [422, 'Für diesen sehr kleinen Betrag kann derzeit keine Nexus-Quote erstellt werden.'],
	QUOTE_ROUNDING_EXCEEDED: [422, 'Nexus Mutual würde für diesen Betrag deutlich mehr decken als angefragt (Aufrundung über 5 %); die Quote wird nicht angezeigt.'],
	AMOUNT_ABOVE_EXPOSURE: [422, 'Der Betrag liegt über dem vorgeschlagenen Engagement dieser Position.'],
	CAPACITY_UNAVAILABLE: [503, 'Die Kapazität von Nexus Mutual ist gerade nicht verfügbar.'],
	ZERO_LIQUIDITY: [409, 'Diese Position hat keine aktive Liquidität.'],
	UNSUPPORTED_TOKEN_PRICE: [409, 'Für einen Token dieser Position gibt es keinen geprüften Preis.'],
	STALE_PRICE: [409, 'Ein Preis für diese Position ist gerade nicht aktuell.'],
	PRICE_UNAVAILABLE: [409, 'Ein Preis für diese Position ist gerade nicht verfügbar.'],
	POSITION_STALE: [409, 'Die Position muss neu gelesen werden.'],
	MAPPING_AMBIGUOUS: [409, 'Für diese Position gibt es keine eindeutige Cover-Zuordnung.'],
	NOT_SUPPORTED: [409, 'Diese Position wird nicht unterstützt.'],
	SCAN_INCOMPLETE: [503, 'Die Uniswap-Positionen konnten gerade nicht vollständig gelesen werden.']
};
const UNISWAP_CODES = new Set([...Object.keys(MESSAGES), 'POSITION_NOT_FOUND']);

function sessionIssuedAt(session) {
	return Number.isFinite(session?.iat) ? session.iat : session?.exp - 7 * 24 * 60 * 60_000;
}

const unavailable = (response) => response.status(503).json({ ok: false, code: 'COVER_DETAILS_UNAVAILABLE', error: 'Cover-Details sind gerade nicht verfügbar.' });
const reply = (response, result) => {
	const [status, error] = MESSAGES[result.code] ?? [503, 'Cover-Details sind gerade nicht verfügbar.'];
	const { ok, code, maxAmount, limitedBy } = result;
	// Nur feste, vom Server berechnete Dezimaltexte; bei QUOTE_ROUNDING_EXCEEDED die angefragte und die angebotene Summe.
	const amounts = {};
	for (const key of ['requestedAmount', 'offeredAmount', 'roundingPercent', 'maxRoundingPercent']) if (typeof result[key] === 'string') amounts[key] = result[key];
	return response.status(status).json({ ok, code, error, ...(maxAmount ? { maxAmount } : {}), ...(limitedBy ? { limitedBy } : {}), ...amounts });
};

export function createNexusQuoteHandler(deps) {
	const inner = createInnerHandler(deps);
	// Unerwarteter Fehler (Datenbank, Rate-Limit, Sitzung): 503, nie Daten, nie Interna.
	return async function handler(request, response) {
		try {
			return await inner(request, response);
		} catch {
			if (!response.headersSent) return unavailable(response);
		}
	};
}

function createInnerHandler({
	getPositions, isRevoked, readModel, quote,
	getUniswap = (wallet, options) => getUniswapScan(wallet, options),
	uniswapModel = (found, options) => uniswapModelFor(found, options),
	uniswapQuote = (prepared, model, priceBook, found, options) => runUniswapQuote(prepared, model, priceBook, found, options),
	uniswapEnabled = UNISWAP_V3_AKTIV,
	rateLimit = enforceRateLimit, rateLimitFor = enforceRateLimitFor, resolveSession = resolveDashboardSession,
	sameOrigin = requireSameOrigin, json = requireJson, now = () => Date.now()
}) {
	return async function handler(request, response) {
		response.setHeader('cache-control', 'no-store');
		if (request.method !== 'POST') return response.status(405).json({ ok: false, error: 'Method not allowed' });
		if (queryKeys(queryParams(request)).length) return response.status(400).json({ ok: false, code: 'QUERY_NOT_ALLOWED', error: 'Diese Anfrage nimmt keine Parameter an.' });
		if (!sameOrigin(request, response) || !json(request, response, MAX_BODY_BYTES)) return;
		if (!await rateLimit(request, response, 'nexus-cover-ip', ...LIMITS.ip)) return;
		const uniswap = uniswapEnabled && typeof request.body?.action === 'string' && request.body.action.startsWith('uniswap-');
		const parsed = uniswap ? parseUniswapBody(request.body) : parseCoverRequest(request.body);
		if (!parsed.ok) return reply(response, parsed);

		const resolved = resolveSession(request);
		const session = resolved.conflict ? null : resolved.session;
		if (!session?.wallet) return response.status(401).json({ ok: false, code: 'NO_SESSION', error: 'Keine aktive Dashboard-Sitzung.' });
		let revoked;
		try {
			revoked = await isRevoked(session.wallet, sessionIssuedAt(session));
		} catch {
			return response.status(503).json({ ok: false, code: 'SESSION_CHECK_UNAVAILABLE', error: 'Sitzung konnte gerade nicht geprüft werden.' });
		}
		if (revoked) return response.status(401).json({ ok: false, code: 'SESSION_REVOKED', error: 'Die Wallet-Verbindung wurde vollständig zurückgesetzt.' });
		const wallet = session.wallet.toLowerCase();
		if (!await rateLimitFor(response, 'nexus-cover-wallet', wallet, ...LIMITS.wallet)) return;
		if (uniswap) return uniswapAction(response, parsed, wallet);

		// Die Position wird immer serverseitig neu aufgeloest - nie aus dem Body uebernommen.
		const admit = () => rateLimitFor(response, 'positions-lookup-global', 'all', 200, 600);
		let positions;
		try {
			positions = await getPositions(wallet, { admit });
		} catch (error) {
			if (error instanceof LookupNotAdmittedError) return;
			if (error instanceof PositionsBusyError) response.setHeader('retry-after', '5');
			return response.status(503).json({ ok: false, code: 'POSITIONS_UNAVAILABLE', error: 'DeFi-Positionen konnten gerade nicht geladen werden.' });
		}
		if (String(positions?.wallet ?? '').toLowerCase() !== wallet) return response.status(503).json({ ok: false, code: 'POSITIONS_UNAVAILABLE', error: 'DeFi-Positionen konnten gerade nicht geladen werden.' });
		const position = (positions.positions ?? []).find((entry) => entry?.deploymentKey === parsed.deploymentKey && String(entry.wallet ?? '').toLowerCase() === wallet);
		if (!position) return response.status(404).json({ ok: false, code: 'POSITION_NOT_FOUND', error: 'Für diese Wallet ist in diesem Markt keine Position erkannt.' });

		if (!await rateLimitFor(response, 'nexus-read-global', 'all', ...LIMITS.readGlobal)) return;
		const at = now();
		if (parsed.action === 'details') {
			const model = await readModel(position, { now: at });
			return response.status(200).json(coverDetails(model, position, at));
		}

		// Quote: Lesemodell mit frischer Kapazitaet (hoechstens so alt wie die Quote-Gueltigkeit).
		const model = await readModel(position, { now: at, capacityMaxAgeMs: QUOTE_TTL_MS });
		const checked = checkQuoteRequest(parsed, model, position);
		if (!checked.ok) return reply(response, checked);
		if (!await rateLimitFor(response, 'nexus-quote-wallet', wallet, ...LIMITS.quoteWallet)) return;
		if (!await rateLimitFor(response, 'nexus-quote-global', 'all', ...LIMITS.quoteGlobal)) return;
		const result = await quote(parsed, model, position, { now: at });
		if (!result.ok) return reply(response, result);
		return response.status(200).json({ ok: true, status: 'QUOTED', quote: result.quote });
	};

	/* Uniswap v3: Wallet aus der Sitzung, NFT aus dem eigenen Scan, Produkt 72 fest. */
	async function uniswapAction(response, parsed, wallet) {
		const admit = () => rateLimitFor(response, 'positions-lookup-global', 'all', 200, 600);
		let scan;
		try {
			scan = await getUniswap(wallet, { admit });
		} catch (error) {
			if (error instanceof LookupNotAdmittedError) return;
			if (error instanceof PositionsBusyError) response.setHeader('retry-after', '5');
			return replyUniswap(response, { ok: false, code: 'SCAN_INCOMPLETE' });
		}
		if (scan?.status !== 'OK' || scan.wallet !== wallet) return replyUniswap(response, { ok: false, code: 'SCAN_INCOMPLETE' });
		const found = findScannedPosition(scan, wallet, parsed.tokenId);
		if (!found) return response.status(404).json({ ok: false, code: 'POSITION_NOT_FOUND', error: 'Dieses NFT gehört laut aktuellem Scan nicht zu dieser Wallet.' });

		if (!await rateLimitFor(response, 'nexus-read-global', 'all', ...LIMITS.readGlobal)) return;
		const at = now();
		const resolved = await uniswapModel(found, { now: at });
		if (!resolved.ok) return replyUniswap(response, resolved);
		if (parsed.action === 'uniswap-details') return response.status(200).json(uniswapDetails(found, resolved.model, scan.priceBook, at));

		const prepared = prepareUniswapQuote(parsed, resolved.model, scan.priceBook, { now: at });
		if (!prepared.ok) return replyUniswap(response, prepared);
		const key = quoteCacheKey(wallet, prepared, scan.blockNumber);
		const hit = cachedQuote(key, at);
		if (hit) return response.status(200).json({ ok: true, status: 'QUOTED', quote: hit });
		if (!await rateLimitFor(response, 'nexus-quote-wallet', wallet, ...LIMITS.quoteWallet)) return;
		if (!await rateLimitFor(response, 'nexus-quote-global', 'all', ...LIMITS.quoteGlobal)) return;
		const result = await uniswapQuote(prepared, resolved.model, scan.priceBook, found, { key, now: at });
		if (!result.ok) return replyUniswap(response, result);
		return response.status(200).json({ ok: true, status: 'QUOTED', quote: result.quote });
	}
}

/* Nur feste Codes; alles andere (auch jeder Nexus-Grund) wird QUOTE_UNAVAILABLE. */
const replyUniswap = (response, result) => reply(response, UNISWAP_CODES.has(result.code) ? result : { ok: false, code: 'QUOTE_UNAVAILABLE' });

export default createNexusQuoteHandler({
	getPositions: (wallet, options) => getWalletPositions(wallet, options),
	isRevoked: isDashboardSessionRevoked,
	readModel: (position, options) => getNexusReadModel(position, options),
	quote: (request, model, position, options) => requestCoverQuote(request, model, position, options)
});
