/*
 * Holt Satoshi (Variable, aufrecht + kursiv) nach web/public/fonts/.
 *
 * Warum nicht einfach committen: dieses Repo ist oeffentlich. Die ITF Free Font
 * License erlaubt Self-Hosting fuer die eigene Seite ausdruecklich (§01), untersagt
 * aber, die Dateien ueber "publicly accessible servers ... repository" an Dritte
 * weiterzugeben (§02). Ein oeffentliches Git-Repo faellt darunter. Ausliefern von
 * der eigenen Domain ist gedeckt - das Repo verteilt sie nur eben nicht mit.
 *
 * Warum ueberhaupt selbst hosten: ein <link> auf api.fontshare.com uebertraegt die
 * IP jedes Besuchers an einen Drittserver, bevor er einwilligen konnte.
 *
 * Die Dateien werden unveraendert uebernommen - kein Subsetting, keine Konvertierung,
 * beides untersagt die Lizenz (§02).
 *
 * Das ZIP wird hier selbst gelesen statt ueber `unzip`: der Build laeuft auf einem
 * fremden Image (Vercel), und ein fehlendes Binary waere ein Deploy-Fehler, der mit
 * Schriften nichts zu tun hat. Node bringt mit zlib alles Noetige mit.
 */
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { inflateRawSync } from 'node:zlib';

const ZIP = 'https://api.fontshare.com/v2/fonts/download/satoshi';
const ZIEL = resolve('web/public/fonts');

// Name im Archiv -> Name auf der Platte.
const GEWOLLT = new Map([
	['Satoshi_Complete/Fonts/WEB/fonts/Satoshi-Variable.woff2', 'Satoshi-Variable.woff2'],
	['Satoshi_Complete/Fonts/WEB/fonts/Satoshi-VariableItalic.woff2', 'Satoshi-VariableItalic.woff2'],
	['Satoshi_Complete/License/FFL.txt', 'LICENSE-Satoshi-FFL.txt']
]);

const vorhanden = await readdir(ZIEL).catch(() => []);
if ([...GEWOLLT.values()].every((f) => vorhanden.includes(f))) {
	console.log('Fonts vorhanden, kein Download.');
	process.exit(0);
}

/* Das zentrale Verzeichnis am Ende des Archivs lesen, nicht die lokalen Kopfsaetze:
   nur dort stehen die Groessen verlaesslich, wenn der Packer Streaming benutzt hat. */
function ausZipLesen(buf, gewollt) {
	// End of Central Directory: Signatur 0x06054b50, rueckwaerts suchen (Kommentar am Ende moeglich).
	let eocd = -1;
	for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 0xffff; i--) {
		if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
	}
	if (eocd < 0) throw new Error('Kein ZIP-Verzeichnis gefunden - Download unvollstaendig?');

	const anzahl = buf.readUInt16LE(eocd + 10);
	let p = buf.readUInt32LE(eocd + 16);
	const treffer = new Map();

	for (let i = 0; i < anzahl; i++) {
		if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('ZIP-Verzeichnis beschaedigt');
		const methode = buf.readUInt16LE(p + 10);
		const gepackt = buf.readUInt32LE(p + 20);
		const roh = buf.readUInt32LE(p + 24);
		const nLen = buf.readUInt16LE(p + 28);
		const eLen = buf.readUInt16LE(p + 30);
		const kLen = buf.readUInt16LE(p + 32);
		const versatz = buf.readUInt32LE(p + 42);
		const name = buf.toString('utf8', p + 46, p + 46 + nLen);
		p += 46 + nLen + eLen + kLen;

		if (!gewollt.has(name)) continue;

		// Lokaler Kopfsatz: die Feldlaengen koennen von denen im Verzeichnis abweichen.
		if (buf.readUInt32LE(versatz) !== 0x04034b50) throw new Error(`Kopfsatz fehlt: ${name}`);
		const lnLen = buf.readUInt16LE(versatz + 26);
		const leLen = buf.readUInt16LE(versatz + 28);
		const start = versatz + 30 + lnLen + leLen;
		const daten = buf.subarray(start, start + gepackt);

		let inhalt;
		if (methode === 0) inhalt = daten;                    // gespeichert
		else if (methode === 8) inhalt = inflateRawSync(daten); // deflate
		else throw new Error(`Unbekanntes Packverfahren ${methode} bei ${name}`);

		if (inhalt.length !== roh) throw new Error(`${name}: ${inhalt.length} statt ${roh} Bytes`);
		treffer.set(name, inhalt);
	}
	return treffer;
}

let buf;
for (let versuch = 1; versuch <= 3; versuch++) {
	try {
		console.log(`Lade Satoshi von Fontshare (Versuch ${versuch}/3) ...`);
		const antwort = await fetch(ZIP);
		if (!antwort.ok) throw new Error(`HTTP ${antwort.status}`);
		buf = Buffer.from(await antwort.arrayBuffer());
		break;
	} catch (fehler) {
		if (versuch === 3) {
			// Bewusst hart: eine Seite ohne ihre Hausschrift soll auffallen, nicht
			// stillschweigend auf die Systemschrift zurueckfallen.
			console.error(
				`\nSatoshi konnte nicht geladen werden: ${fehler.message}\n` +
				`Quelle: ${ZIP}\n` +
				`Der Build bricht ab, damit die Seite nicht ohne ihre Schrift ausgeliefert wird.\n`
			);
			process.exit(1);
		}
		await new Promise((r) => setTimeout(r, versuch * 1500));
	}
}

const dateien = ausZipLesen(buf, GEWOLLT);
const fehlend = [...GEWOLLT.keys()].filter((k) => !dateien.has(k));
if (fehlend.length) throw new Error(`Im Archiv nicht gefunden:\n  ${fehlend.join('\n  ')}`);

await mkdir(ZIEL, { recursive: true });
for (const [pfad, inhalt] of dateien) {
	await writeFile(join(ZIEL, GEWOLLT.get(pfad)), inhalt);
}
console.log(`Satoshi nach ${ZIEL} geschrieben (${dateien.size} Dateien).`);
