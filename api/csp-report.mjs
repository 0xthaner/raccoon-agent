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
import { bodyTooLarge, enforceRateLimit } from '../src/http-security.mjs';

const MAX = 8 * 1024;

/*
	AUDIT E-L4, 14.10.2026: beide Felder kommen vom Absender und landen im Log.
	Mit einem Zeilenumbruch in `effective-directive` liessen sich bisher
	gefaelschte Logzeilen schreiben. Jetzt gilt eine Allowlist der FORM: eine
	CSP-Direktive ist klein geschrieben mit Bindestrichen (`script-src`,
	`style-src-elem`), alles andere wird `?`. Die blockierte Adresse erscheint
	nur als URL-Origin oder als CSP-Schluesselwort (`inline`, `eval`, `data`).
	Kein CR, LF, Tab oder anderes Steuerzeichen erreicht das Log.
*/
const DIRECTIVE = /^[a-z-]{1,40}$/;
const KEYWORD = /^[a-z-]{1,20}$/;
const ORIGIN = /^[a-z][a-z0-9+.-]*:\/\/[A-Za-z0-9.-]{1,180}(?::[0-9]{1,5})?$/;

export function cspLogFields(meldung) {
	const rawDirective = meldung?.['effective-directive'] ?? meldung?.effectiveDirective ?? meldung?.['violated-directive'];
	const richtlinie = typeof rawDirective === 'string' && DIRECTIVE.test(rawDirective) ? rawDirective : '?';
	const rawBlocked = meldung?.['blocked-uri'] ?? meldung?.blockedURL;
	let blockiert = '?';
	if (typeof rawBlocked === 'string' && rawBlocked.length <= 2048) {
		if (KEYWORD.test(rawBlocked)) blockiert = rawBlocked;
		else {
			try {
				const origin = new URL(rawBlocked).origin;
				if (ORIGIN.test(origin)) blockiert = origin;
			} catch { /* bleibt '?' */ }
		}
	}
	return { richtlinie, blockiert };
}

export default async function handler(request, response) {
	response.setHeader('cache-control', 'no-store');
	if (request.method !== 'POST') return response.status(405).end();

	// AGENT-API-002: leichtes Limit gegen Log-Flutung. Legitime Reports (selten
	// pro Browser) bleiben unberuehrt; die bestehende Infrastruktur zaehlt pro IP.
	if (!await enforceRateLimit(request, response, 'csp-report', 60, 600)) return;

	// AGENT-API-001: Groesse header-unabhaengig pruefen (8 KB).
	if (bodyTooLarge(request, MAX)) return response.status(413).end();

	try {
		const roh = request.body;
		const daten = typeof roh === 'string' ? JSON.parse(roh) : roh;
		/* Zwei Formate im Umlauf: das alte `csp-report` und der neue Reporting-Aufbau. */
		const meldungen = Array.isArray(daten) ? daten.map((e) => e.body ?? e) : [daten?.['csp-report'] ?? daten];
		for (const meldung of meldungen.slice(0, 20)) {
			if (!meldung) continue;
			const { richtlinie, blockiert } = cspLogFields(meldung);
			console.log(`csp-report richtlinie=${richtlinie} blockiert=${blockiert}`);
		}
	} catch {
		console.log('csp-report unlesbar');
	}
	return response.status(204).end();
}
