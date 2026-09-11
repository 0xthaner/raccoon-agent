/*
	WAS IM FRONTEND NICHT VORKOMMEN DARF.

	Die Regel dahinter ist eine Konvention, keine Geschmacksfrage:

		telegramUsername, Wallet-Adresse, ENS-Name und JEDES Feld aus einer
		/api/*-Antwort werden als TEXT ausgegeben - ueber textContent oder
		document.createElement. Niemals in eine HTML-Zeichenkette interpoliert,
		niemals ueber innerHTML.

	Muss ein Element Markup tragen, steht das Markup fest in der HTML-Vorlage und
	die Textstuecke bekommen ein `data-teil`; gesetzt wird nur deren textContent.

	Diese Pruefung faengt den Rueckfall. Sie laeuft im Build, damit eine
	wiedereingefuehrte Senke nicht erst im Review auffaellt - oder gar nicht.
*/
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SENKEN = [
	['innerHTML', 'schreibt eine Zeichenkette als Markup in den Baum'],
	['outerHTML', 'ersetzt ein Element durch geparste Zeichenkette'],
	['insertAdjacentHTML', 'fuegt geparste Zeichenkette ein'],
	['document.write', 'schreibt ungefiltert in das Dokument'],
	['Range.createContextualFragment', 'parst eine Zeichenkette zu Knoten']
];

let fehler = 0;
function melde(datei, zeile, text, grund) {
	fehler++;
	console.error(`  FEHLT ${datei}:${zeile}\n        ${text.trim().slice(0, 100)}\n        ${grund}`);
}

/*
	Kommentare erklaeren oft genau die Senke, die hier entfernt wurde - sie
	duerfen das Wort tragen, ohne die Pruefung auszuloesen. Zeichenketten werden
	bewusst NICHT ausgenommen: ein Vorkommen dort ist praktisch immer ein
	dynamisch gebauter Zugriff.
*/
function ohneKommentare(quelle) {
	return quelle
		.replace(/\/\*[\s\S]*?\*\//g, (treffer) => treffer.replace(/[^\n]/g, ' '))
		.replace(/(^|[^:])\/\/[^\n]*/g, (treffer, vor) => vor + ' '.repeat(treffer.length - vor.length));
}

function dateien(verzeichnis, endung) {
	return readdirSync(verzeichnis).flatMap((name) => {
		const pfad = join(verzeichnis, name);
		if (statSync(pfad).isDirectory()) return name === 'node_modules' ? [] : dateien(pfad, endung);
		return pfad.endsWith(endung) ? [pfad] : [];
	});
}

console.log('\nFrontend: keine Markup-Senken');
for (const datei of dateien('web/src', '.js')) {
	const roh = readFileSync(datei, 'utf8');
	const quelle = ohneKommentare(roh);
	quelle.split('\n').forEach((zeile, index) => {
		for (const [senke, grund] of SENKEN) {
			if (zeile.includes(senke)) melde(datei, index + 1, zeile, grund);
		}
	});
}

/*
	Keine eingebetteten Skripte und keine Ereignisattribute: beides braeuchte
	`unsafe-inline` in der CSP, und genau das soll die Seite nicht brauchen.
*/
console.log('Frontend: keine eingebetteten Skripte');
for (const datei of [...dateien('web', '.html')].filter((p) => !p.includes('node_modules'))) {
	const quelle = readFileSync(datei, 'utf8');
	quelle.split('\n').forEach((zeile, index) => {
		if (/<script(?![^>]*\bsrc=)[^>]*>\s*\S/.test(zeile)) melde(datei, index + 1, zeile, 'eingebettetes Skript braeuchte unsafe-inline');
		const attribut = /\son(click|error|load|mouseover|focus|blur|submit|change|input)\s*=/i.exec(zeile);
		if (attribut) melde(datei, index + 1, zeile, `Ereignisattribut ${attribut[0].trim()} braeuchte unsafe-inline`);
	});
}

console.log(fehler === 0 ? '\n  ok    keine Senke, kein eingebettetes Skript\n' : `\n${fehler} Fund(e) - kein Build.\n`);
process.exit(fehler === 0 ? 0 : 1);
