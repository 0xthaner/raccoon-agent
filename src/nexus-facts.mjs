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
	const typeById = new Map(types.filter((t) => Number.isInteger(t?.id)).map((t) => [t.id, t]));
	const value = products
		.filter((p) => Number.isInteger(p?.id) && typeof p?.name === 'string' && !p.isPrivate)
		.map((p) => {
			const type = typeById.get(p.productType);
			return {
				id: p.id,
				name: p.name,
				keys: [...new Set([normalize(p.name), normalize(p.name.replace(/\([^)]*\)/g, ' '))])].filter((k) => k.length >= 3),
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
export function matchProducts(question, catalog) {
	const q = ` ${normalize(question)} `;
	if (q.trim().length < 3) return [];
	const hits = catalog
		.map((p) => ({ p, key: p.keys.filter((k) => q.includes(` ${k} `)).sort((a, b) => b.length - a.length)[0] }))
		.filter((hit) => hit.key)
		.sort((a, b) => b.key.length - a.key.length);
	const kept = hits.filter((hit, i) => !hits.slice(0, i).some((longer) => longer.key !== hit.key && longer.key.includes(hit.key))).map((hit) => hit.p);
	const live = kept.filter((p) => !p.deprecated);
	if (kept.length) return (live.length ? live : kept).slice(0, MAX_CANDIDATES);
	/*
		Rueckfall: "Aave" statt "Aave v3". Passt kein voller Name, aber das erste
		Wort eines Namens (mindestens vier Zeichen), werden die laufenden
		Produkte dazu Kandidaten; mit mehreren fragt der Bot nach.
	*/
	const words = new Set(q.trim().split(' ').filter((w) => w.length >= 4));
	return catalog
		.filter((p) => !p.deprecated && p.keys.some((k) => words.has(k.split(' ')[0])))
		.sort((a, b) => a.name.localeCompare(b.name))
		.slice(0, MAX_CANDIDATES);
}

async function getCapacity(productId, fetchImpl, now) {
	const cached = capacityCache.get(productId);
	if (cached && now - cached.at < CAPACITY_TTL_MS) return cached.value;
	const raw = await fetchJson(`${API}/v2/capacity/${productId}`, fetchImpl);
	if (raw?.productId !== productId || !Array.isArray(raw.availableCapacity)) throw new Error('Nexus-Kapazitaet im unbekannten Format');
	const value = {
		available: raw.availableCapacity
			.filter((c) => c?.asset?.symbol && c.asset.symbol !== 'NXM' && Number.isInteger(c.asset.decimals))
			.map((c) => ({ symbol: c.asset.symbol, amount: units(c.amount, c.asset.decimals) })),
		minAnnualPricePct: pct(raw.minAnnualPrice),
		maxAnnualPricePct: pct(raw.maxAnnualPrice)
	};
	capacityCache.set(productId, { at: now, value });
	return value;
}

function units(raw, decimals) {
	try {
		const big = BigInt(raw);
		const whole = big / 10n ** BigInt(decimals);
		return Number(whole);
	} catch {
		return null;
	}
}

function pct(ratio) {
	const value = Number(ratio);
	return Number.isFinite(value) ? Math.round(value * 10_000) / 100 : null;
}

async function fetchJson(url, fetchImpl) {
	const response = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8_000) });
	if (!response.ok) throw new Error(`Nexus antwortete mit HTTP ${response.status}`);
	return response.json();
}

/**
 * Der Fakten-Block fuer die Antwort auf eine Produktfrage. `null`, wenn die
 * Frage kein Produkt nennt; ein Hinweis, wenn Nexus nicht erreichbar ist.
 */
export async function getNexusProductFacts(question, { fetchImpl = fetch, now = Date.now() } = {}) {
	let catalog;
	try {
		catalog = await getCatalog(fetchImpl, now);
	} catch {
		return 'Nexus Mutual product data is unavailable right now.';
	}
	const matches = matchProducts(question, catalog);
	if (!matches.length) return null;
	const retrievedAt = new Date(now).toISOString();
	const blocks = await Promise.all(matches.map(async (p) => {
		let capacity = null;
		// Eingestellte Produkte meldet Nexus mit Preis und Kapazitaet 0. Das ist
		// kein Preis, sondern "nicht kaeuflich"; deshalb wird es gar nicht erst geholt.
		if (!p.deprecated) {
			try { capacity = await getCapacity(p.id, fetchImpl, now); } catch { /* Kapazitaet fehlt, der Rest bleibt */ }
		}
		return [
			`Product: ${p.name} (Nexus Mutual product ID ${p.id})${p.deprecated ? ' - DEPRECATED, no longer sold' : ''}`,
			p.typeName ? `Cover type: ${p.typeName}` : null,
			p.category ? `Category: ${p.category}` : null,
			p.coverAssets.length ? `Cover can be denominated in: ${p.coverAssets.join(', ')}` : null,
			p.gracePeriodDays != null ? `Claim grace period after expiry: ${p.gracePeriodDays} days` : null,
			...(p.deprecated
				? ['Price and capacity: none, the product is no longer sold. Existing covers keep running until they expire.']
				: [
					capacity && capacity.minAnnualPricePct != null && capacity.maxAnnualPricePct != null
						? `Annual price range quoted by Nexus right now: ${capacity.minAnnualPricePct}% to ${capacity.maxAnnualPricePct}% of the cover amount (the actual price depends on amount and term)`
						: 'Price: unavailable right now',
					capacity?.available.length
						? `Available capacity right now: ${capacity.available.map((c) => `${c.amount?.toLocaleString('en-US') ?? '?'} ${c.symbol}`).join(', ')}`
						: 'Capacity: unavailable right now'
				]),
			p.wordingUrl ? `Official cover wording (authoritative): ${p.wordingUrl}` : 'Official cover wording: no link available',
			p.annexUrl ? `Official product annex: ${p.annexUrl}` : null
		].filter(Boolean).join('\n');
	}));
	const header = matches.length > 1
		? `Several Nexus Mutual products match the question. Ask which one is meant before going into detail.`
		: 'One Nexus Mutual product matches the question.';
	return `${header}\nSource: api.nexusmutual.io, retrieved ${retrievedAt}\n\n${blocks.join('\n\n')}`;
}

export const _test = { reset: () => { catalogCache = null; capacityCache.clear(); } };
