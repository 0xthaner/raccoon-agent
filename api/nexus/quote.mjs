/*
	POST /api/nexus/quote - Nexus-Cover-Details und Live-Quote fuer eine
	erkannte Position der angemeldeten Wallet (P3, 18.10.2026). Nur Anzeige.

	Body (JSON, hoechstens 1 KB, gleiche Herkunft):
	  { action: 'details', deploymentKey }
	  { action: 'quote',   deploymentKey, coverAsset, amount, periodDays }
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
	Quote-Budgets werden erst nach allen lokalen Pruefungen gezogen: eine
	ungueltige Anfrage erreicht Nexus nie und kostet kein Quote-Budget.

	Keine Transaktion, keine Freigabe, kein Kauf, kein Proof-of-Loss, keine
	Speicherung, keine Vertragsdaten in der Antwort.
*/
import { resolveDashboardSession } from '../../src/dashboard-auth.mjs';
import { isDashboardSessionRevoked } from '../../src/db.mjs';
import { enforceRateLimit, enforceRateLimitFor, requireJson, requireSameOrigin } from '../../src/http-security.mjs';
import { getWalletPositions, LookupNotAdmittedError, PositionsBusyError } from '../../src/positions/index.mjs';
import { getNexusReadModel } from '../../src/nexus-read-model.mjs';
import { checkQuoteRequest, coverDetails, parseCoverRequest, QUOTE_TTL_MS, requestCoverQuote } from '../../src/nexus-quote.mjs';
import { queryKeys, queryParams } from '../../src/request-query.mjs';

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
	QUOTE_UNAVAILABLE: [503, 'Nexus Mutual hat gerade keine gültige Quote geliefert.']
};

function sessionIssuedAt(session) {
	return Number.isFinite(session?.iat) ? session.iat : session?.exp - 7 * 24 * 60 * 60_000;
}

const unavailable = (response) => response.status(503).json({ ok: false, code: 'COVER_DETAILS_UNAVAILABLE', error: 'Cover-Details sind gerade nicht verfügbar.' });
const reply = (response, result) => {
	const [status, error] = MESSAGES[result.code] ?? [503, 'Cover-Details sind gerade nicht verfügbar.'];
	const { ok, code, maxAmount, limitedBy } = result;
	return response.status(status).json({ ok, code, error, ...(maxAmount ? { maxAmount } : {}), ...(limitedBy ? { limitedBy } : {}) });
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
	rateLimit = enforceRateLimit, rateLimitFor = enforceRateLimitFor, resolveSession = resolveDashboardSession,
	sameOrigin = requireSameOrigin, json = requireJson, now = () => Date.now()
}) {
	return async function handler(request, response) {
		response.setHeader('cache-control', 'no-store');
		if (request.method !== 'POST') return response.status(405).json({ ok: false, error: 'Method not allowed' });
		if (queryKeys(queryParams(request)).length) return response.status(400).json({ ok: false, code: 'QUERY_NOT_ALLOWED', error: 'Diese Anfrage nimmt keine Parameter an.' });
		if (!sameOrigin(request, response) || !json(request, response, MAX_BODY_BYTES)) return;
		if (!await rateLimit(request, response, 'nexus-cover-ip', ...LIMITS.ip)) return;
		const parsed = parseCoverRequest(request.body);
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
			return response.status(200).json(coverDetails(model, position));
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
}

export default createNexusQuoteHandler({
	getPositions: (wallet, options) => getWalletPositions(wallet, options),
	isRevoked: isDashboardSessionRevoked,
	readModel: (position, options) => getNexusReadModel(position, options),
	quote: (request, model, position, options) => requestCoverQuote(request, model, position, options)
});
