/*
	/api/position-attributions - vom Nutzer bestaetigte Zuordnung erkannter
	DeFi-Markt <-> oeffentliches Nexus Cover (14.10.2026).

	Die Wallet kommt AUSSCHLIESSLICH aus der verifizierten Dashboard-Sitzung
	(Strict-Cookie oder - im Safe-App-iframe - partitioniertes Safe-App-Cookie), mit derselben Konflikt- und
	Widerrufspruefung wie /api/positions. Kein Abfrageparameter, keine Wallet im
	Body. Der Body nennt nur { deploymentKey, coverId }; alles andere leitet der
	Server selbst ab und prueft es gegen den aktuellen oeffentlichen Stand.

	GET    gespeicherte Zuordnungen dieser Wallet, abgeglichen: nur aktuell gueltige
	       werden geliefert; nachweislich veraltete werden geloescht; bei einem
	       Lesefehler wird nichts geloescht und nichts als aktuell gezeigt.
	POST   eine Relation bestaetigen (idempotent). Nur nach erfolgreicher
	       Pruefung von Position und Cover.
	DELETE eine eigene Relation entfernen (idempotent).

	Keine Transaktion, keine Signatur, keine Nexus-Metadaten. Automatische
	1:1-Zuordnungen werden hier nie gespeichert.
*/
import { resolveDashboardSession } from '../src/dashboard-auth.mjs';
import { deletePositionAttribution, isDashboardSessionRevoked, listPositionAttributions, upsertPositionAttribution } from '../src/db.mjs';
import { enforceRateLimit, enforceRateLimitFor, requireJson, requireSameOrigin } from '../src/http-security.mjs';
import { getWalletPositions, LookupNotAdmittedError } from '../src/positions/index.mjs';
import { getWalletCovers } from '../src/covers.mjs';
import { checkRelation, parseRelationBody, publicAttribution, reconcile } from '../src/position-attributions.mjs';
import { queryKeys, queryParams } from '../src/request-query.mjs';

const MAX_BODY_BYTES = 1_024;
const RETRYABLE = new Set(['POSITION_LOOKUP_UNAVAILABLE', 'PRODUCT_LOOKUP_UNAVAILABLE', 'COVER_LOOKUP_UNAVAILABLE', 'LOOKUP_WALLET_MISMATCH']);

function sessionIssuedAt(session) {
	return Number.isFinite(session?.iat) ? session.iat : session?.exp - 7 * 24 * 60 * 60_000;
}

const unavailable = (response) => response.status(503).json({ ok: false, code: 'ATTRIBUTIONS_UNAVAILABLE', error: 'Cover-Zuordnungen sind gerade nicht verfügbar.' });

export function createAttributionsHandler(deps) {
	const inner = createInnerHandler(deps);
	// Faellt eine Pruefung (Datenbank, Widerruf, Rate-Limit) unerwartet aus: 503, nie Daten, nie Interna.
	return async function handler(request, response) {
		try {
			return await inner(request, response);
		} catch {
			if (!response.headersSent) return unavailable(response);
		}
	};
}

function createInnerHandler({
	getPositions, getCovers, listRows, upsertRow, deleteRow, isRevoked,
	rateLimit = enforceRateLimit, rateLimitFor = enforceRateLimitFor, resolveSession = resolveDashboardSession,
	sameOrigin = requireSameOrigin, json = requireJson, now = () => Date.now()
}) {
	/** Sitzung + Widerruf; liefert die normalisierte Wallet oder schreibt bereits die Antwort. */
	async function sessionWallet(request, response) {
		const resolved = resolveSession(request);
		const session = resolved.conflict ? null : resolved.session;
		if (!session?.wallet) { response.status(401).json({ ok: false, code: 'NO_SESSION', error: 'Keine aktive Dashboard-Sitzung.' }); return null; }
		let revoked;
		try {
			revoked = await isRevoked(session.wallet, sessionIssuedAt(session));
		} catch {
			response.status(503).json({ ok: false, code: 'SESSION_CHECK_UNAVAILABLE', error: 'Sitzung konnte gerade nicht geprüft werden.' });
			return null;
		}
		if (revoked) { response.status(401).json({ ok: false, code: 'SESSION_REVOKED', error: 'Die Wallet-Verbindung wurde vollständig zurückgesetzt.' }); return null; }
		return session.wallet.toLowerCase();
	}

	/** Positionen und Covers der Sitzungs-Wallet; null bei jeder Unsicherheit (nie "leer"). */
	async function currentState(wallet, response) {
		const admit = () => rateLimitFor(response, 'positions-lookup-global', 'all', 200, 600);
		let positions = null;
		let covers = null;
		try {
			positions = await getPositions(wallet, { admit });
		} catch (error) {
			if (error instanceof LookupNotAdmittedError) return { aborted: true };
			positions = null;
		}
		try {
			covers = await getCovers(wallet);
		} catch {
			covers = null;
		}
		return { positions, covers };
	}

	return async function handler(request, response) {
		response.setHeader('cache-control', 'no-store');
		if (!['GET', 'POST', 'DELETE'].includes(request.method)) return response.status(405).json({ ok: false, error: 'Method not allowed' });
		// Kein Parameter veraendert diese Anfrage; insbesondere keine Wallet.
		if (queryKeys(queryParams(request)).length) {
			return response.status(400).json({ ok: false, code: 'QUERY_NOT_ALLOWED', error: 'Diese Anfrage nimmt keine Parameter an.' });
		}

		if (request.method === 'GET') {
			if (!await rateLimit(request, response, 'attributions-read', 60, 600)) return;
			const wallet = await sessionWallet(request, response);
			if (!wallet) return;
			if (!await rateLimitFor(response, 'attributions-wallet', wallet, 60, 600)) return;
			let rows;
			try { rows = await listRows(wallet); } catch { return unavailable(response); }
			if (!rows.length) return response.status(200).json({ ok: true, attributions: [], pending: 0 });
			const state = await currentState(wallet, response);
			if (state.aborted) return;
			const { valid, stale, unknown } = reconcile(rows, { wallet, ...state });
			// Nur nachweislich veraltete Zeilen loeschen; ein Loeschfehler aendert die Antwort nicht.
			let removed = 0;
			for (const { row } of stale) {
				try { removed += await deleteRow(wallet, row.deployment_key, Number(row.cover_id)); } catch { /* bleibt bis zum naechsten Abgleich */ }
			}
			return response.status(200).json({ ok: true, attributions: valid.map(({ row }) => publicAttribution(row)), pending: unknown.length, removed });
		}

		// Schreiben: nur gleiche Herkunft, nur JSON, kleiner Body.
		if (!sameOrigin(request, response) || !json(request, response, MAX_BODY_BYTES)) return;
		if (!await rateLimit(request, response, 'attributions-write', 30, 600)) return;
		const relation = parseRelationBody(request.body);
		if (!relation) return response.status(400).json({ ok: false, code: 'INVALID_BODY', error: 'Erwartet wird genau { deploymentKey, coverId }.' });
		const wallet = await sessionWallet(request, response);
		if (!wallet) return;
		if (!await rateLimitFor(response, 'attributions-write-wallet', wallet, 30, 600)) return;

		if (request.method === 'DELETE') {
			let deleted;
			try { deleted = await deleteRow(wallet, relation.deploymentKey, relation.coverId); } catch { return unavailable(response); }
			return response.status(200).json({ ok: true, deleted: deleted > 0 });
		}

		// POST: erst alles serverseitig pruefen, dann schreiben.
		const state = await currentState(wallet, response);
		if (state.aborted) return;
		const check = checkRelation({ wallet, deploymentKey: relation.deploymentKey, coverId: relation.coverId, positions: state.positions, covers: state.covers });
		if (!check.ok) {
			// Lesefehler -> 503 (spaeter erneut versuchen); inhaltlich unzulaessig -> 422.
			const retry = RETRYABLE.has(check.code);
			return response.status(retry ? 503 : 422).json({ ok: false, code: check.code, error: retry ? 'Position oder Cover konnten gerade nicht sicher gelesen werden.' : 'Diese Zuordnung ist für die angemeldete Wallet gerade nicht möglich.' });
		}
		// Restaudit L1: das Limit (MAX_ATTRIBUTIONS_PER_WALLET) prueft die Datenbank im selben
		// gesperrten Schritt wie das Schreiben - kein Zaehlen hier, das gleichzeitige Anfragen
		// alle bestehen wuerden. Eine schon gespeicherte Relation zaehlt nicht neu.
		let saved;
		try { saved = await upsertRow({ ...check.relation, now: now() }); } catch { return unavailable(response); }
		if (saved?.status === 'limit') return response.status(409).json({ ok: false, code: 'TOO_MANY_ATTRIBUTIONS', error: 'Zu viele gespeicherte Zuordnungen.' });
		if (!saved?.row) return unavailable(response);
		return response.status(200).json({ ok: true, attribution: publicAttribution(saved.row) });
	};
}

export default createAttributionsHandler({
	getPositions: (wallet, options) => getWalletPositions(wallet, options),
	getCovers: (wallet) => getWalletCovers(wallet),
	listRows: (wallet) => listPositionAttributions(wallet),
	upsertRow: (relation) => upsertPositionAttribution(relation),
	deleteRow: (wallet, deploymentKey, coverId) => deletePositionAttribution(wallet, deploymentKey, coverId),
	isRevoked: isDashboardSessionRevoked
});
