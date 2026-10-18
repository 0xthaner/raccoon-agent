/*
	POSITION -> NEXUS-PRODUKT, STRENG (P2, 18.10.2026).

	Strenger als match-nexus.mjs: jene Zuordnung sagt nur "im Katalog gibt es
	ein Produkt" und bleibt fuer die Anzeige unveraendert. Diese hier entscheidet,
	ob ein Produkt fuer eine Position als verfuegbar gelten DARF, und prueft
	dafuer jede Identitaet einzeln:

	  Kette (1) - Deployment-Kennung - Protokoll (aave) - Version (v3) -
	  Pool-Adresse aus der Registry - feste Produkt-ID - gepinnte Produktidentitaet

	Nie ueber Namen, Fuzzy-Matching oder ein Sprachmodell.

	  EXACT       gepruefte Deployment-Kennung, deren Zugehoerigkeit zum Produkt
	              feststeht (nur Aave v3 Ethereum Core -> 97)
	  PROBABLE    gleiche Marke und gleicher Code, aber von Nexus nicht ausdruecklich
	              bestaetigt (Lido/Prime, EtherFi) - nie verfuegbar
	  AMBIGUOUS   die Angaben der Position widersprechen sich oder der Registry
	  NO_LISTING  keine unterstuetzte Zuordnung (andere Protokolle, Versionen, Ketten)

	Nur EXACT kann spaeter "verfuegbar" werden.
*/
import { AAVE_V3_MARKETS, CHAIN_ID } from './aave-registry.mjs';
import { NEXUS_CHAIN_ID, PINNED_PRODUCTS } from '../nexus-pinned.mjs';

export const MATCH_STATUSES = Object.freeze(['EXACT', 'PROBABLE', 'AMBIGUOUS', 'NO_LISTING']);

const MAPPING = Object.freeze({
	'aave-v3-ethereum-core': Object.freeze({ status: 'EXACT', productId: 97, reason: 'PINNED_DEPLOYMENT' }),
	'aave-v3-ethereum-lido': Object.freeze({ status: 'PROBABLE', productId: 97, reason: 'NEXUS_SCOPE_UNCONFIRMED' }),
	'aave-v3-ethereum-etherfi': Object.freeze({ status: 'PROBABLE', productId: 97, reason: 'NEXUS_SCOPE_UNCONFIRMED' })
});

function result(status, reason, productId = null, verified = null) {
	const pinned = productId == null ? null : PINNED_PRODUCTS[productId];
	const facts = status === 'EXACT' && verified?.productId === productId ? verified : null;
	return Object.freeze({
		status,
		productId: pinned ? productId : null,
		productTypeId: pinned ? pinned.productTypeId : null,
		reason,
		supportedCoverAssets: facts ? Object.freeze(facts.supportedCoverAssets.map((asset) => asset.symbol)) : null,
		proofOfLossInputTypes: facts ? Object.freeze([...facts.proofOfLossInputTypes]) : null
	});
}

const sameAddress = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

/**
 * `position` ist eine erkannte Aave-v3-Position (aave-v3.mjs). `verified` ist
 * optional das Ergebnis von verifyPinnedProduct; ohne bleiben Assets und
 * Proof-of-Loss-Arten leer (null), der Status aendert sich dadurch nicht.
 */
export function matchPositionToNexus(position, verified = null) {
	if (position === null || typeof position !== 'object' || typeof position.deploymentKey !== 'string') return result('NO_LISTING', 'NOT_A_POSITION');
	const market = AAVE_V3_MARKETS.find((entry) => entry.deploymentKey === position.deploymentKey);
	if (!market) return result('NO_LISTING', 'UNSUPPORTED_DEPLOYMENT');
	if (position.chainId !== CHAIN_ID || position.chainId !== NEXUS_CHAIN_ID) return result('AMBIGUOUS', 'CHAIN_CONFLICT');
	if (position.protocolKey !== market.protocolKey || position.protocolVersion !== market.protocolVersion) return result('AMBIGUOUS', 'PROTOCOL_CONFLICT');
	if (!sameAddress(position.marketAddress, market.pool)) return result('AMBIGUOUS', 'MARKET_CONFLICT');
	const mapping = MAPPING[market.deploymentKey];
	if (!mapping || !PINNED_PRODUCTS[mapping.productId]) return result('NO_LISTING', 'NO_PINNED_PRODUCT');
	return result(mapping.status, mapping.reason, mapping.productId, verified);
}
