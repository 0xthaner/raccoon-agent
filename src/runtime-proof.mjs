/*
	Laufzeit-Nachweis (23.10.2026): welche Node-Version fuehrt die Funktionen aus?

	Das Projekt sagt nur "24.x", Vercel rollt Patchversionen selbst aus, und die
	Build-Pruefung (scripts/check-runtime-stack.mjs) sieht nur die Build-Umgebung.
	Die Funktionslaufzeit belegt allein ein Log aus der Funktion selbst. Deshalb
	schreibt jede Instanz beim Kaltstart genau eine Zeile ins Vercel-Log:

	  runtime node=v24.22.1

	Nur die Version - kein Secret, keine Variable, kein Request. Nichts davon geht
	in eine HTTP-Antwort. Ausserhalb von Vercel (Tests, lokal) bleibt es still.
	Die Untergrenze selbst steht in scripts/check-runtime-stack.mjs.
*/

let gemeldet = false;

/** Eine Zeile pro Instanz. Rueckgabe: ob gerade geloggt wurde. */
export function meldeLaufzeit({ env = process.env, version = process.version, log = console.info } = {}) {
	if (gemeldet || env.VERCEL !== '1') return false;
	gemeldet = true;
	log(`runtime node=${version}`);
	return true;
}

meldeLaufzeit();
