/*
	Abfrageparameter aus `request.url` (WHATWG URLSearchParams) statt Vercels
	vorbereitetem Query-Objekt (15.10.2026).

	Vercels Node-Bridge baut dieses Objekt beim ersten Zugriff mit
	`url.parse(req.url, true)` - das loest in Node 24 die Warnung DEP0169 aus.
	Hier wird nur der Abfrageteil der Request-URL gelesen, nie Host oder
	Schema; der Host-Header spielt keine Rolle.

	Gleiche Semantik wie bisher (querystring.parse), gemessen am 15.10.2026:
	- Schluessel und Werte werden gleich dekodiert (`+` und %xx, ungueltige
	  Folgen bleiben stehen), ein `#`-Fragment gehoert nicht dazu.
	- `?code` und `?code=` ergeben den leeren Wert; `??code=1` ergibt wie bisher
	  den Schluessel `?code`.
	- Ein mehrfach angegebener Parameter (gleich oder verschieden) war ein Array
	  und galt deshalb als "nicht gesetzt"; singleQueryValue liefert dann ''.
	Einzige Abweichung: querystring las hoechstens 1000 Paare, URLSearchParams
	alle. Ein Wert nach dem tausendsten Paar wird jetzt gesehen statt ignoriert.
*/

/** Die Abfrageparameter der Anfrage; ohne `?` eine leere Liste. */
export function queryParams(request) {
	const raw = typeof request?.url === 'string' ? request.url : '';
	const start = raw.indexOf('?');
	if (start < 0) return new URLSearchParams();
	const query = raw.slice(start + 1);
	const hash = query.indexOf('#');
	// Das vorangestellte '&' ist ein leeres Segment, das beide Parser ueberspringen.
	// Ohne es entfernte URLSearchParams ein fuehrendes '?' (aus `??code=1` wuerde
	// `code` statt wie bisher `?code`).
	return new URLSearchParams(`&${hash < 0 ? query : query.slice(0, hash)}`);
}

/** Alle Schluessel, jeder einmal (wie Object.keys auf dem frueheren Objekt). */
export function queryKeys(params) {
	return [...new Set(params.keys())];
}

/** Genau ein Wert, sonst '' - wie `typeof query[name] === 'string' ? ... : ''`. */
export function singleQueryValue(params, name) {
	const values = params.getAll(name);
	return values.length === 1 ? values[0] : '';
}
