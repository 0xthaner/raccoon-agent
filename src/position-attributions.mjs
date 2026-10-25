/*
	VOM NUTZER BESTAETIGTE COVER-ZUORDNUNGEN (14.10.2026).

	Eine gespeicherte Zuordnung sagt nur: der angemeldete Wallet-Inhaber hat
	bestaetigt, dass CoverRaccoon dieses oeffentliche Nexus Cover mit diesem
	erkannten Aave-v3-Markt verknuepfen soll. Sie ist kein Deckungsnachweis, keine
	von Nexus gepruefte Angabe und keine Aussage ueber Claims oder Auszahlungen.

	Hier liegen nur reine Entscheidungen (keine Datenbank, kein Netz):

	- checkRelation: darf eine Relation JETZT geschrieben werden? Nur fuer eine
	  aktuell erkannte, nicht leere Position eines geprueften Markts mit
	  deterministischem Nexus-Match und ein aktives Cover GENAU dieser Wallet mit
	  GENAU derselben numerischen productId. Ist der betroffene Markt oder die
	  Cover-Liste nicht sicher gelesen: nein.

	- reconcile: gespeicherte Zeilen gegen den aktuellen oeffentlichen Stand.
	    valid    - darf als aktuelle Zuordnung gezeigt und genutzt werden
	    stale    - nachweislich nicht mehr gueltig (sicher gelesen) -> loeschen
	    unknown  - nicht entscheidbar (Lesefehler) -> behalten, aber NICHT zeigen
	    unconfirmed - Markt ohne von Nexus bestaetigten Deckungsumfang (Lido/Prime,
	               EtherFi; 25.10.2026) -> behalten, nie loeschen, nie als gueltige
	               Zuordnung zeigen oder nutzen; nur als "nicht bestaetigt" kennzeichnen
	  Ein Lesefehler fuehrt nie zum Loeschen.

	Neue Zuordnungen gibt es nur fuer Maerkte, die die strenge Zuordnung
	(nexus-mapping.mjs) als EXACT fuehrt; sonst COVERAGE_SCOPE_UNCONFIRMED.
*/
import { AAVE_V3_MARKETS, nexusProductIdFor } from './positions/aave-registry.mjs';
import { mappingFor } from './positions/nexus-mapping.mjs';

const scopeConfirmed = (deploymentKey, productId) => {
	const strict = mappingFor(deploymentKey);
	return strict?.status === 'EXACT' && strict.productId === productId;
};

export const ATTRIBUTION_SOURCE = 'user_confirmed';
const MARKETS = new Map(AAVE_V3_MARKETS.map((market) => [market.deploymentKey, market]));
const DEPLOYMENT_KEY = /^[a-z0-9-]{1,64}$/;

export function marketFor(deploymentKey) {
	return MARKETS.get(deploymentKey) ?? null;
}

/**
 * Strenger Request-Body: genau { deploymentKey, coverId }. Alles andere - eine
 * Wallet, eine Quelle, eine productId, Betraege - wird abgelehnt, nicht ignoriert.
 */
export function parseRelationBody(body) {
	if (!body || typeof body !== 'object' || Array.isArray(body) || Object.getPrototypeOf(body) !== Object.prototype) return null;
	const keys = Object.keys(body).sort();
	if (keys.length !== 2 || keys[0] !== 'coverId' || keys[1] !== 'deploymentKey') return null;
	const { deploymentKey, coverId } = body;
	if (typeof deploymentKey !== 'string' || !DEPLOYMENT_KEY.test(deploymentKey)) return null;
	if (typeof coverId !== 'number' || !Number.isSafeInteger(coverId) || coverId <= 0) return null;
	return { deploymentKey, coverId };
}

const hasBalance = (position) => Boolean(position?.supplied?.length || position?.borrowed?.length);

function positionState(positions, deploymentKey) {
	if (!positions || !Array.isArray(positions.checkedDeployments) || !Array.isArray(positions.positions)) return { known: false };
	const checked = positions.checkedDeployments.find((entry) => entry.deploymentKey === deploymentKey);
	if (!checked || checked.status !== 'OK') return { known: false };
	const position = positions.positions.find((entry) => entry.deploymentKey === deploymentKey && hasBalance(entry)) ?? null;
	return { known: true, position };
}

function coverState(covers, coverId) {
	if (!Array.isArray(covers)) return { known: false };
	// Das optionale Demo-Cover (DEMO_WALLET) ist kein echtes Nexus Cover und nie zuordenbar.
	return { known: true, cover: covers.find((entry) => entry.coverId === coverId && entry.demo !== true) ?? null };
}

/** Darf diese Relation fuer diese Wallet jetzt gespeichert werden? */
export function checkRelation({ wallet, deploymentKey, coverId, positions, covers }) {
	const market = marketFor(deploymentKey);
	if (!market) return { ok: false, code: 'UNKNOWN_DEPLOYMENT' };
	if (!positions) return { ok: false, code: 'POSITION_LOOKUP_UNAVAILABLE' };
	if (!covers) return { ok: false, code: 'COVER_LOOKUP_UNAVAILABLE' };
	if (String(positions.wallet ?? '').toLowerCase() !== wallet || String(covers.wallet ?? '').toLowerCase() !== wallet) return { ok: false, code: 'LOOKUP_WALLET_MISMATCH' };
	const pos = positionState(positions, deploymentKey);
	if (!pos.known) return { ok: false, code: 'POSITION_LOOKUP_UNAVAILABLE' };
	if (!pos.position) return { ok: false, code: 'POSITION_NOT_FOUND' };
	const nexus = pos.position.nexus;
	if (nexus?.state === 'SCOPE_UNCONFIRMED') return { ok: false, code: 'COVERAGE_SCOPE_UNCONFIRMED' };
	if (nexus?.state !== 'MATCHED' || !Number.isSafeInteger(nexus.productId)) return { ok: false, code: nexus?.state === 'UNAVAILABLE' ? 'PRODUCT_LOOKUP_UNAVAILABLE' : 'PRODUCT_NOT_MATCHED' };
	if (nexus.productId !== nexusProductIdFor(deploymentKey)) return { ok: false, code: 'PRODUCT_NOT_MATCHED' };
	// Auch wenn eine Position faelschlich MATCHED meldet: die strenge Tabelle entscheidet.
	if (!scopeConfirmed(deploymentKey, nexus.productId)) return { ok: false, code: 'COVERAGE_SCOPE_UNCONFIRMED' };
	const cov = coverState(covers?.covers, coverId);
	if (!cov.known) return { ok: false, code: 'COVER_LOOKUP_UNAVAILABLE' };
	if (!cov.cover) return { ok: false, code: 'COVER_NOT_FOUND' };
	if (cov.cover.status !== 'active') return { ok: false, code: 'COVER_INACTIVE' };
	if (!Number.isSafeInteger(cov.cover.productId) || cov.cover.productId !== nexus.productId) return { ok: false, code: 'PRODUCT_MISMATCH' };
	return {
		ok: true,
		relation: { wallet, protocolKey: market.protocolKey, protocolVersion: market.protocolVersion, deploymentKey, productId: nexus.productId, coverId }
	};
}

/** Eine gespeicherte Zeile in die Form fuer Antworten und Anzeige. */
export function publicAttribution(row) {
	return { deploymentKey: row.deployment_key, coverId: Number(row.cover_id), productId: Number(row.product_id), source: row.source, confirmedAt: row.confirmed_at };
}

/**
 * Gespeicherte Zeilen gegen den aktuellen Stand. `positions` und `covers` duerfen
 * null sein (nicht gelesen): dann ist nichts gueltig und nichts wird geloescht.
 */
export function reconcile(rows, { wallet, positions, covers }) {
	const result = { valid: [], stale: [], unknown: [], unconfirmed: [] };
	for (const row of rows ?? []) {
		// Fremde Zeilen gibt es hier nicht (Abfrage nach Wallet); falls doch: weder zeigen noch loeschen.
		if (String(row?.wallet ?? wallet).toLowerCase() !== wallet) continue;
		const coverId = Number(row.cover_id);
		const productId = Number(row.product_id);
		if (row.source !== ATTRIBUTION_SOURCE || !Number.isSafeInteger(coverId) || !Number.isSafeInteger(productId)) { result.unknown.push({ row, reason: 'MALFORMED' }); continue; }
		const market = marketFor(row.deployment_key);
		if (!market || nexusProductIdFor(row.deployment_key) !== productId) { result.stale.push({ row, reason: 'DEPLOYMENT_UNSUPPORTED' }); continue; }
		const coversKnown = Array.isArray(covers?.covers) && String(covers.wallet ?? '').toLowerCase() === wallet;
		const cov = coversKnown ? coverState(covers.covers, coverId) : { known: false };
		if (cov.known && !cov.cover) { result.stale.push({ row, reason: 'COVER_NOT_IN_WALLET' }); continue; }
		if (cov.known && cov.cover.status !== 'active') { result.stale.push({ row, reason: 'COVER_INACTIVE' }); continue; }
		if (cov.known && (!Number.isSafeInteger(cov.cover.productId) || cov.cover.productId !== productId)) { result.stale.push({ row, reason: 'PRODUCT_MISMATCH' }); continue; }
		const positionsKnown = String(positions?.wallet ?? '').toLowerCase() === wallet;
		const pos = positionsKnown ? positionState(positions, row.deployment_key) : { known: false };
		if (pos.known && !pos.position) { result.stale.push({ row, reason: 'POSITION_NOT_FOUND' }); continue; }
		if (pos.known && pos.position.nexus?.state === 'MATCHED' && pos.position.nexus.productId !== productId) { result.stale.push({ row, reason: 'PRODUCT_MISMATCH' }); continue; }
		if (!cov.known) { result.unknown.push({ row, reason: 'COVER_LOOKUP_UNAVAILABLE' }); continue; }
		if (!pos.known) { result.unknown.push({ row, reason: 'POSITION_LOOKUP_UNAVAILABLE' }); continue; }
		// Vor der Produktpruefung: eine bestehende Lido/EtherFi-Zeile bleibt, wird aber nie gueltig.
		if (!scopeConfirmed(row.deployment_key, productId) || pos.position.nexus?.state === 'SCOPE_UNCONFIRMED') { result.unconfirmed.push({ row, deploymentKey: row.deployment_key, coverId, productId, label: market.label, reason: 'NEXUS_SCOPE_UNCONFIRMED' }); continue; }
		if (pos.position.nexus?.state !== 'MATCHED') { result.unknown.push({ row, reason: 'PRODUCT_LOOKUP_UNAVAILABLE' }); continue; }
		result.valid.push({ row, deploymentKey: row.deployment_key, coverId, productId, label: market.label });
	}
	return result;
}
