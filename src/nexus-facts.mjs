/*
	PRODUKTFAKTEN DIREKT VON NEXUS MUTUAL.

	Bis 01.10.2026 bekam der Bot fuer Produktfragen drei Bloecke von
	CoverRaccoon: Grundwissen, Analyse-Seiten und einen Deckungs-Check
	("gedeckt / bedingt / ausgeschlossen", Raccoon Score, Red Flags). Die
	Bewertungen sind bewusst weggefallen: eine Einstufung, die sich im
	Schadensfall als falsch herausstellt, ist Beratungshaftung. Geblieben sind
	Fakten, und die kommen jetzt von der Stelle, die sie festlegt:

	  - api.nexusmutual.io/v2/products       Name, Kategorie, Cover-Assets, Status
	  - api.nexusmutual.io/v2/product-types  Typ, Nachfrist, Wording (IPFS-CID)
	  - api.nexusmutual.io/v2/capacity/{id}  freie Kapazitaet, Jahrespreis-Spanne

	Das Wording verweist auf api.nexusmutual.io/ipfs/<CID>, die offizielle
	Ablage von Nexus. Es wird verlinkt, nicht ausgelesen oder zusammengefasst:
	massgeblich ist der Text selbst, keine Lesart davon.

	Kein personenbezogenes Datum verlaesst den Agenten; angefragt wird nur ein
	Produkt. Faellt Nexus aus, gibt es keinen Fakten-Block, und der Bot sagt,
	dass er die Daten gerade nicht hat.
*/

const API = 'https://api.nexusmutual.io';
const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
const CAPACITY_TTL_MS = 10 * 60 * 1000;
const MAX_CANDIDATES = 5;

let catalogCache = null;
const capacityCache = new Map();

export function normalize(text) {
	return String(text ?? '')
		.toLowerCase()
		.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}

function ipfsUrl(cid) {
	return typeof cid === 'string' && /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,})$/.test(cid) ? `${API}/ipfs/${cid}` : null;
}

/** Produkt-Anhang: historisch mal leerer String, mal CID, mal Objekt mit `annex`. */
function annexCid(metadata) {
	if (typeof metadata === 'string') return metadata || null;
	if (metadata && typeof metadata === 'object' && typeof metadata.annex === 'string') return metadata.annex;
	return null;
}

export async function getCatalog(fetchImpl = fetch, now = Date.now()) {
	if (catalogCache && now - catalogCache.at < CATALOG_TTL_MS) return catalogCache.value;
	const [products, types] = await Promise.all([
		fetchJson(`${API}/v2/products`, fetchImpl),
		fetchJson(`${API}/v2/product-types`, fetchImpl)
	]);
	if (!Array.isArray(products) || !Array.isArray(types)) throw new Error('Nexus-Katalog im unbekannten Format');
	if (new Set(products.map(p => p?.id)).size !== products.length) throw new Error('Duplicate Nexus product IDs');
	const typeById = new Map(types.filter((t) => Number.isInteger(t?.id)).map((t) => [t.id, t]));
	const value = products
		.filter((p) => Number.isSafeInteger(p?.id) && p.id >= 0 && typeof p?.name === 'string' && !p.isPrivate)
		.map((p) => {
			const type = typeById.get(p.productType);
			return {
				id: p.id,
				name: p.name,
				productId: p.id,
				officialName: p.name,
				normalizedName: normalize(p.name),
				aliases: [...new Set([normalize(p.name), normalize(p.name.replace(/\([^)]*\)/g, ' '))])].filter(Boolean),
				familyAlias: normalize(p.name).match(/^(.+?) v\d+(?: |$)/)?.[1] ?? null,
				status: p.isDeprecated ? 'DEPRECATED' : 'ACTIVE',
				productType: Number.isInteger(p.productType) ? p.productType : null,
				catalogFetchedAt: new Date(now).toISOString(),
				category: typeof p.category === 'string' ? p.category : null,
				deprecated: Boolean(p.isDeprecated),
				coverAssets: Array.isArray(p.coverAssets) ? p.coverAssets.map((a) => a?.assetSymbol).filter((s) => typeof s === 'string') : [],
				typeName: typeof type?.name === 'string' ? type.name : null,
				gracePeriodDays: Number.isFinite(Number(type?.gracePeriod)) ? Math.round(Number(type.gracePeriod) / 86_400) : null,
				wordingUrl: ipfsUrl(type?.metadata),
				annexUrl: ipfsUrl(annexCid(p.metadata))
			};
		});
	catalogCache = { at: now, value };
	return value;
}

/**
 * Produkte, deren Name in der Frage vorkommt. Laengere Namen zuerst, damit
 * "Aave v3" vor "Aave" gewinnt; ein Treffer, der in einem laengeren Treffer
 * steckt, faellt weg. Eingestellte Produkte nur, wenn sonst nichts passt.
 */
const AMBIGUOUS_PRODUCT_NAMES = new Set(['current', 'exactly']);

function explicitProductReference(q, key) {
	if (!AMBIGUOUS_PRODUCT_NAMES.has(key)) return true;
	return ['cover', 'product', 'produkt'].some((label) =>
		q.includes(` ${key} ${label} `) || q.includes(` ${label} ${key} `));
}

export function matchProducts(question, catalog) {
	const q = ` ${normalize(question)} `;
	if (q.trim().length < 3) return [];
	const hits = catalog
		.map((p) => ({ p, key: p.aliases.filter((k) => q.includes(` ${k} `) && explicitProductReference(q, k)).sort((a, b) => b.length - a.length)[0] }))
		.filter((hit) => hit.key)
		.sort((a, b) => b.key.length - a.key.length);
	const kept = hits.filter((hit, i) => !hits.slice(0, i).some((longer) => longer.key !== hit.key && longer.key.includes(hit.key))).map((hit) => hit.p);
	// A full name must not hide an independently named protocol family.
	// A specific version still suppresses fallback siblings of that family.
	const families = catalog.filter((p) => !p.deprecated && p.familyAlias
		&& q.includes(` ${p.familyAlias} `)
		&& !kept.some((hit) => hit.familyAlias === p.familyAlias));
	const candidates = [...new Map([...kept, ...families].map((p) => [p.productId, p])).values()];
	const live = candidates.filter((p) => !p.deprecated);
	return (live.length ? live : candidates)
		.sort((a, b) => a.name.localeCompare(b.name))
		.slice(0, MAX_CANDIDATES);
}

export function resolveProduct(question, catalog) {
	const candidates = matchProducts(question, catalog);
	if (!candidates.length) return { state: 'NO_MATCH' };
	if (candidates.length > 1) return { state: 'AMBIGUOUS', candidates };
	return { state: 'UNAMBIGUOUS', productId: candidates[0].productId, product: candidates[0] };
}

/** Narrow catalogue requests; product resolution always takes precedence. */
export function isCatalogDiscovery(question) {
	const q = normalize(question);
	if (/\b(mein\w*|my|unser\w*|our|habe ich|hab ich|do i have)\b/.test(q)) return false;
	return /\bwelche (?:produkte|covers)\b/.test(q)
		|| /\bwas kann (?:ich|man|nexus)(?: bei nexus)? (?:versichern|absichern|abdecken)\b/.test(q)
		|| /\bwhat (?:products|covers) (?:are available|does nexus offer)\b/.test(q)
		|| /\b(?:show|list)(?: me)?(?: the)?(?: available)? nexus products\b/.test(q)
		|| /\bwhat can (?:i|nexus) cover\b/.test(q);
}

export function classifyNexusQuery(question, catalog) {
	const resolution = resolveProduct(question, catalog);
	if (resolution.state === 'AMBIGUOUS') return 'PRODUCT_FAMILY';
	if (resolution.state === 'UNAMBIGUOUS') return isCatalogDiscovery(question) ? 'PRODUCT_FAMILY' : 'PRODUCT_DETAIL';
	return isCatalogDiscovery(question) ? 'CATALOG_DISCOVERY' : 'GENERAL';
}

function catalogDiscoveryContext(catalog) {
	const active = catalog.filter(p => p.status === 'ACTIVE')
		.sort((a, b) => a.officialName.localeCompare(b.officialName) || a.productId - b.productId);
	const products = active.slice(0, 12).map(p => ({
		productId: p.productId, officialName: p.officialName, status: p.status,
		productType: p.productType, typeName: p.typeName, category: p.category
	}));
	return {
		QUERY_MODE: 'CATALOG_DISCOVERY', PRODUCT_RESOLUTION: 'NO_MATCH',
		CATALOG: {
			products, totalActive: active.length, additionalProducts: active.length - products.length,
			fetchedAt: catalog[0]?.catalogFetchedAt ?? null, sourceEndpoint: `${API}/v2/products`
		}
	};
}

export async function getProductFactsById(productId, fetchImpl = fetch, now = Date.now()) {
	if (!Number.isSafeInteger(productId) || productId < 0) throw new Error('Invalid product ID');
	const cached = capacityCache.get(productId);
	if (cached && now - cached.at < CAPACITY_TTL_MS) return cached.value;
	const raw = await fetchJson(`${API}/v2/capacity/${productId}`, fetchImpl);
	if (raw?.productId !== productId || !Array.isArray(raw.availableCapacity)) throw new Error('Nexus-Kapazitaet im unbekannten Format');
	const value = {
		productId,
		fetchedAt: new Date(now).toISOString(),
		sourceEndpoint: `${API}/v2/capacity/${productId}`,
		sourceType: 'NEXUS_CAPACITY',
		rawSnapshot: raw, // Provenance only; never copied into the model context.
		available: raw.availableCapacity
			.filter((c) => c?.asset?.symbol && c.asset.symbol !== 'NXM' && Number.isInteger(c.asset.decimals))
			.map((c) => ({ symbol: c.asset.symbol, amount: units(c.amount, c.asset.decimals) })),
		minAnnualPricePct: pct(raw.minAnnualPrice),
		maxAnnualPricePct: pct(raw.maxAnnualPrice)
	};
	if (value.minAnnualPricePct == null || value.maxAnnualPricePct == null
		|| value.minAnnualPricePct < 0 || value.maxAnnualPricePct < value.minAnnualPricePct
		|| value.available.some((c) => c.amount == null)) throw new Error('Invalid Nexus facts');
	capacityCache.set(productId, { at: now, value });
	return value;
}

function units(raw, decimals) {
	try {
		if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36 || !/^\d+$/.test(String(raw))) return null;
		const big = BigInt(raw);
		const whole = big / 10n ** BigInt(decimals);
		return whole <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(whole) : null;
	} catch {
		return null;
	}
}

function pct(ratio) {
	if (ratio == null || ratio === '') return null;
	const value = Number(ratio);
	return Number.isFinite(value) ? Math.round(value * 10_000) / 100 : null;
}

async function fetchJson(url, fetchImpl) {
	const response = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8_000) });
	if (!response.ok) throw new Error(`Nexus antwortete mit HTTP ${response.status}`);
	return response.json();
}

/** Structured public context. Only canonical IDs can attach live facts/documents. */
export async function getNexusProductFacts(question, { fetchImpl = fetch, now = Date.now(), previousProductIds = null, onProducts = null } = {}) {
	let catalog;
	try { catalog = await getCatalog(fetchImpl, now); }
	catch { return { PRODUCT_RESOLUTION: 'UNAVAILABLE', reason: 'CATALOG_UNAVAILABLE' }; }
	let resolution = resolveProduct(question, catalog);
	if (isCatalogDiscovery(question)) {
		if (resolution.state === 'NO_MATCH') return catalogDiscoveryContext(catalog);
		const candidates = resolution.state === 'AMBIGUOUS' ? resolution.candidates : [resolution.product];
		if (onProducts) await Promise.resolve(onProducts(candidates.map(p => p.productId))).catch(() => {});
		return {
			QUERY_MODE: 'PRODUCT_FAMILY', PRODUCT_RESOLUTION: 'AMBIGUOUS',
			CANDIDATES: candidates.map(p => ({ productId: p.productId, officialName: p.officialName, status: p.status }))
		};
	}
	let fromContext = false;
	if (resolution.state === 'NO_MATCH' && Array.isArray(previousProductIds)) {
		const candidates = catalog.filter((p) => previousProductIds.includes(p.productId)).slice(0, MAX_CANDIDATES);
		if (candidates.length) {
			fromContext = true;
			resolution = candidates.length === 1
				? { state: 'UNAMBIGUOUS', productId: candidates[0].productId, product: candidates[0] }
				: { state: 'AMBIGUOUS', candidates };
		}
	}
	if (resolution.state === 'NO_MATCH') return { PRODUCT_RESOLUTION: 'NO_MATCH' };
	const selected = resolution.state === 'AMBIGUOUS' ? resolution.candidates : [resolution.product];
	if (onProducts) await Promise.resolve(onProducts(selected.map((p) => p.productId))).catch(() => {});
	if (resolution.state === 'AMBIGUOUS') return {
		PRODUCT_RESOLUTION: 'AMBIGUOUS',
		CANDIDATES: selected.map((p) => ({ productId: p.productId, officialName: p.officialName, status: p.status }))
	};
	const p = resolution.product;
	const context = {
		PRODUCT_RESOLUTION: 'UNAMBIGUOUS',
		PRODUCT_IDENTITY: {
			productId: p.productId, officialName: p.officialName, status: p.status,
			productType: p.productType, typeName: p.typeName, category: p.category,
			coverAssets: p.coverAssets, gracePeriodDays: p.gracePeriodDays,
			catalogFetchedAt: p.catalogFetchedAt, sourceEndpoint: `${API}/v2/products`, fromContext
		},
		AUTHORITATIVE_WORDING: { productId: p.productId, status: p.wordingUrl ? 'AVAILABLE' : 'UNAVAILABLE', wordingUrl: p.wordingUrl, annexUrl: p.annexUrl, fetchedAt: p.catalogFetchedAt, sourceEndpoints: [`${API}/v2/products`, `${API}/v2/product-types`] },
		LIVE_FACTS: { productId: p.productId, officialName: p.officialName, status: p.deprecated ? 'NOT_SOLD' : 'UNAVAILABLE' }
	};
	if (!p.wordingUrl) return { ...context, verification: 'WORDING_UNAVAILABLE' };
	if (!p.deprecated) {
		try {
			const facts = await getProductFactsById(p.productId, fetchImpl, now);
			const supportedAssets = new Set(p.coverAssets.map((symbol) => symbol.trim().toUpperCase()));
			const capacity = facts.available.filter(({ symbol }) => {
				const normalized = symbol.trim().toUpperCase();
				return normalized !== 'NXM' && supportedAssets.has(normalized);
			});
			context.LIVE_FACTS = {
				productId: facts.productId, officialName: p.officialName, status: 'AVAILABLE',
				fetchedAt: facts.fetchedAt, sourceEndpoint: facts.sourceEndpoint, sourceType: facts.sourceType,
				capacity,
				capacityStatus: supportedAssets.size ? 'AVAILABLE' : 'UNAVAILABLE',
				pricing: { minAnnualPricePct: facts.minAnnualPricePct, maxAnnualPricePct: facts.maxAnnualPricePct }
			};
		} catch { /* Controlled unavailable state; never substitute another product. */ }
	}
	return context;
}

export const _test = { reset: () => { catalogCache = null; capacityCache.clear(); } };
