/*
	GET /api/positions - DeFi-Positionen der angemeldeten Dashboard-Wallet
	(Phase 1: Aave v3, Ethereum, 11.10.2026).

	Die Wallet kommt AUSSCHLIESSLICH aus der verifizierten Dashboard-Sitzung
	(Strict-Cookie oder - im Safe-App-iframe - partitioniertes Safe-App-Cookie), mit derselben Konflikt- und
	Widerrufspruefung wie /api/dashboard. Ein `wallet`-Parameter wird
	abgelehnt: der Endpunkt ist kein Auskunftsdienst fuer beliebige Adressen.
	Keine neue Signatur, keine Transaktion, keine Speicherung der Positionen.

	Getrennt von /api/dashboard: faellt die Positionsabfrage aus, bleiben
	Covers und Anmeldung unberuehrt.

	Uniswap v3 auf Ethereum (21.10.2026): eigener Abschnitt `uniswapV3`
	(protocol, chainId, status, positions), parallel zu Aave gelesen und nur
	als bereinigte Ansicht (uniswapSection). Faellt der Uniswap-Scan aus, bleibt
	die Aave-Antwort unveraendert und der Abschnitt meldet UNAVAILABLE.
	`protocols` nennt beide Abschnitte mit ihrem Status.
*/
import { resolveDashboardSession } from '../src/dashboard-auth.mjs';
import { isDashboardSessionRevoked } from '../src/db.mjs';
import { enforceRateLimit, enforceRateLimitFor } from '../src/http-security.mjs';
import { getWalletPositions, LookupNotAdmittedError, PositionsBusyError } from '../src/positions/index.mjs';
import { queryKeys, queryParams } from '../src/request-query.mjs';
import { getUniswapScan, uniswapSection } from '../src/positions/uniswap-v3-service.mjs';

function sessionIssuedAt(session) {
	return Number.isFinite(session?.iat) ? session.iat : session?.exp - 7 * 24 * 60 * 60_000;
}

/* Antwort-Attrappe fuer ein Budget, dessen Nein keine eigene Antwort schreibt. */
const SILENT = Object.freeze({ status() { return this; }, json() { return this; }, setHeader() {} });
const unavailable = (response) => response.status(503).json({ ok: false, code: 'POSITIONS_UNAVAILABLE', error: 'DeFi-Positionen konnten gerade nicht geladen werden.' });

export function createPositionsHandler(deps) {
	const inner = createInnerHandler(deps);
	// Faellt die Rate-Limit- oder Widerrufspruefung (Datenbank) aus, gibt es 503 -
	// nie Daten und nie eine Fehlermeldung mit Interna.
	return async function handler(request, response) {
		try {
			return await inner(request, response);
		} catch {
			return unavailable(response);
		}
	};
}

function createInnerHandler({ getPositions, isRevoked, getUniswap = async () => null, rateLimit = enforceRateLimit, rateLimitFor = enforceRateLimitFor, resolveSession = resolveDashboardSession }) {
	return async function handler(request, response) {
		response.setHeader('cache-control', 'no-store');
		if (request.method !== 'GET') return response.status(405).json({ ok: false, error: 'Method not allowed' });
		// Kein Parameter veraendert diese Abfrage; insbesondere keine Wallet.
		const queryNames = queryKeys(queryParams(request));
		if (queryNames.length) {
			const walletParameter = queryNames.some((key) => /wallet/i.test(key));
			return response.status(400).json(walletParameter
				? { ok: false, code: 'WALLET_PARAMETER_NOT_ALLOWED', error: 'Positionen gibt es nur für die angemeldete Wallet.' }
				: { ok: false, code: 'QUERY_NOT_ALLOWED', error: 'Diese Abfrage nimmt keine Parameter an.' });
		}
		if (!await rateLimit(request, response, 'positions-read', 60, 600)) return;
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
		if (!await rateLimitFor(response, 'positions-wallet', wallet, 30, 600)) return;
		if (!await rateLimitFor(response, 'positions-global', 'all', 1_200, 600)) return;
		// Zweites, engeres Budget nur fuer echte Kette-Abfragen (Cache-Fehlschlag) ueber
		// alle Wallets: viele angemeldete Wallets koennen die RPC so nicht vervielfachen.
		const admit = () => rateLimitFor(response, 'positions-lookup-global', 'all', 200, 600);
		// Eigenes Budget fuer kalte Uniswap-Scans; ein Nein dort schreibt kein 429, der Abschnitt bleibt nur leer.
		const admitUniswap = () => rateLimitFor(SILENT, 'positions-uniswap-lookup-global', 'all', 200, 600);
		const uniswap = Promise.resolve().then(() => getUniswap(wallet, { admit: admitUniswap })).catch(() => null);
		try {
			const positions = await getPositions(wallet, { admit });
			const section = uniswapSection(await uniswap);
			const aaveStatus = positions?.complete ? 'OK' : (positions?.checkedDeployments ?? []).some((entry) => entry.status === 'OK') ? 'INCOMPLETE' : 'UNAVAILABLE';
			return response.status(200).json({
				...positions,
				protocols: [{ protocol: 'Aave v3', chainId: 1, status: aaveStatus }, { protocol: section.protocol, chainId: section.chainId, status: section.status }],
				uniswapV3: section
			});
		} catch (error) {
			if (error instanceof LookupNotAdmittedError) return; // 429 ist bereits geschrieben
			if (error instanceof PositionsBusyError) {
				response.setHeader('retry-after', '5');
				return response.status(503).json({ ok: false, code: 'POSITIONS_BUSY', error: 'DeFi-Positionen werden gerade stark abgefragt. Bitte gleich erneut versuchen.' });
			}
			return unavailable(response);
		}
	};
}

export default createPositionsHandler({
	getPositions: (wallet, options) => getWalletPositions(wallet, options),
	getUniswap: (wallet, options) => getUniswapScan(wallet, options),
	isRevoked: isDashboardSessionRevoked
});
