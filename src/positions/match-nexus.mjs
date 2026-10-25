/*
	ERKANNTE POSITION -> PASSENDES NEXUS-PRODUKT (Phase 1, 11.10.2026).

	Deterministisch ueber die gepruefte Deployment-Kennung und eine feste
	Produkt-ID, nie ueber Namen, Fuzzy-Matching oder ein Sprachmodell. Der
	Produktname aus einem Cover-Objekt ist keine Autoritaet. Zur Laufzeit wird
	der Eintrag im aktuellen Nexus-Katalog (getCatalog, nur oeffentliche
	Produkte) gegengeprueft; weicht seine Identitaet ab, gibt es keinen Treffer.

	MATCHED heisst ausschliesslich: im aktuellen Katalog gibt es ein passendes
	Produkt. Es sagt nichts darueber, ob ein Verlust gedeckt waere.

	SCOPE_UNCONFIRMED (25.10.2026): das Produkt steht im Katalog, aber die strenge
	Zuordnung (nexus-mapping.mjs) haelt den Markt nicht fuer EXACT - Nexus hat nicht
	bestaetigt, dass Produkt 97 Lido/Prime oder EtherFi abdeckt. Vorher stand hier
	fuer alle drei Maerkte MATCHED, und das Dashboard zeigte "Produkt verfuegbar"
	und liess eine Cover-Zuordnung zu. Nur EXACT wird MATCHED.
*/
import { getCatalog } from '../nexus-facts.mjs';
import { nexusProductIdFor } from './aave-registry.mjs';
import { mappingFor } from './nexus-mapping.mjs';

export const MATCH_STATES = Object.freeze(['MATCHED', 'SCOPE_UNCONFIRMED', 'NO_PRODUCT', 'PRODUCT_DEPRECATED', 'UNSUPPORTED', 'UNAVAILABLE']);

// Erwartete Identitaet je fester Produkt-ID. Aendert Nexus sie, faellt der Treffer weg.
const EXPECTED = Object.freeze({
	97: Object.freeze({ normalizedName: 'aave v3', productType: 0, typeName: 'Single Protocol Cover', displayName: 'Aave v3' })
});

/** Eine Zuordnung; `catalog` ist das Ergebnis von getCatalog() oder null, wenn er nicht lesbar war. */
export function matchDeployment(deploymentKey, catalog) {
	const productId = nexusProductIdFor(deploymentKey);
	if (productId == null) return { state: 'UNSUPPORTED', productId: null };
	if (!Array.isArray(catalog)) return { state: 'UNAVAILABLE', productId, reason: 'CATALOG_UNAVAILABLE' };
	const product = catalog.find((entry) => entry.productId === productId);
	if (!product) return { state: 'NO_PRODUCT', productId };
	const expected = EXPECTED[productId];
	if (!expected || product.normalizedName !== expected.normalizedName || product.productType !== expected.productType || product.typeName !== expected.typeName) {
		return { state: 'UNAVAILABLE', productId, reason: 'PRODUCT_IDENTITY_MISMATCH' };
	}
	// Angezeigt wird der festgelegte Name: "officialName" ist Fremdtext und kann sich
	// bei gleichem normalisiertem Namen in Zeichensetzung und Laenge unterscheiden.
	if (product.deprecated || product.status !== 'ACTIVE') return { state: 'PRODUCT_DEPRECATED', productId, productName: expected.displayName };
	const strict = mappingFor(deploymentKey);
	if (strict?.status !== 'EXACT' || strict.productId !== productId) return { state: 'SCOPE_UNCONFIRMED', productId, productName: expected.displayName, reason: 'NEXUS_SCOPE_UNCONFIRMED' };
	return { state: 'MATCHED', productId, productName: expected.displayName };
}

/** Katalog laden; ein Ausfall wird zu null (und damit UNAVAILABLE), nie zu einem Treffer. */
export async function loadCatalog(fetchImpl = fetch) {
	try { return await getCatalog(fetchImpl); } catch { return null; }
}
