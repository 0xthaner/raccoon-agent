/*
	AGENT-SEC-A7: Sammelstelle fuer CSP-Meldungen.

	Die enge Regel laeuft zuerst als `Content-Security-Policy-Report-Only` neben
	der scharfen. Sie blockiert nichts, meldet aber jeden Verstoss - und faengt
	damit genau das, was ein einzelner Mitschnitt nicht sehen kann: ein anderes
	Wallet, eine andere Kette, ein anderer Relay.

	Gespeichert wird nichts. Die Meldung geht ins Vercel-Log und traegt nur die
	drei Felder, die fuer eine Allowlist zaehlen. Insbesondere landet weder die
	vollstaendige Seitenadresse noch ein Verweis dorthin im Log: `document-uri`
	und `referrer` koennen Codes und Adressen aus der Verknuepfung enthalten.
*/
const MAX = 8 * 1024;

export default async function handler(request, response) {
	response.setHeader('cache-control', 'no-store');
	if (request.method !== 'POST') return response.status(405).end();

	const laenge = Number(request.headers['content-length']);
	if (Number.isFinite(laenge) && laenge > MAX) return response.status(413).end();

	try {
		const roh = request.body;
		const daten = typeof roh === 'string' ? JSON.parse(roh) : roh;
		/* Zwei Formate im Umlauf: das alte `csp-report` und der neue Reporting-Aufbau. */
		const meldungen = Array.isArray(daten) ? daten.map((e) => e.body ?? e) : [daten?.['csp-report'] ?? daten];
		for (const meldung of meldungen.slice(0, 20)) {
			if (!meldung) continue;
			const richtlinie = meldung['effective-directive'] ?? meldung.effectiveDirective ?? meldung['violated-directive'] ?? '?';
			const blockiert = meldung['blocked-uri'] ?? meldung.blockedURL ?? '?';
			let host = String(blockiert).slice(0, 200);
			try { host = new URL(host).origin; } catch { /* 'inline', 'eval', 'data' bleiben, wie sie sind */ }
			console.log(`csp-report richtlinie=${richtlinie} blockiert=${host}`);
		}
	} catch {
		console.log('csp-report unlesbar');
	}
	return response.status(204).end();
}
