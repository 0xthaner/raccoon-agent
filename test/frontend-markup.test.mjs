/*
	Die Konvention aus scripts/check-frontend.mjs, hier als Test festgehalten:
	Fremdwerte werden Text, niemals Markup. Der Waechter laeuft im Build; dieser
	Test haelt fest, dass er auch wirklich anschlaegt und nicht bloss durchwinkt.
*/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

function waechter() {
	try {
		execFileSync('node', ['scripts/check-frontend.mjs'], { encoding: 'utf8', stdio: 'pipe' });
		return { ok: true, ausgabe: '' };
	} catch (fehler) {
		return { ok: false, ausgabe: `${fehler.stdout ?? ''}${fehler.stderr ?? ''}` };
	}
}

test('1 der aktuelle Stand traegt keine Markup-Senke', () => {
	assert.equal(waechter().ok, true);
});

test('2 keine Quelldatei des Frontends greift auf innerHTML zu', () => {
	for (const datei of ['web/src/main.js', 'web/src/guide.js', 'web/src/demo-renew.js']) {
		const quelle = readFileSync(datei, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
		assert.equal(/\.innerHTML|insertAdjacentHTML|document\.write/.test(quelle), false, datei);
	}
});

test('3 ein wiedereingefuehrtes innerHTML laesst den Build fallen', () => {
	const pfad = 'web/src/guide.js';
	const original = readFileSync(pfad, 'utf8');
	try {
		writeFileSync(pfad, `${original}\nziel.innerHTML = wert;\n`);
		const lauf = waechter();
		assert.equal(lauf.ok, false);
		assert.match(lauf.ausgabe, /innerHTML/);
	} finally {
		writeFileSync(pfad, original);
	}
	assert.equal(waechter().ok, true);
});

test('4 ein eingebettetes Skript laesst den Build fallen', () => {
	const pfad = 'web/guide.html';
	const original = readFileSync(pfad, 'utf8');
	try {
		writeFileSync(pfad, original.replace('</main>', '<script>alert(1)</script></main>'));
		assert.equal(waechter().ok, false);
	} finally {
		writeFileSync(pfad, original);
	}
	assert.equal(waechter().ok, true);
});

test('5 die uebersetzten Markup-Stellen sind Textteile, keine Zeichenketten', () => {
	const main = readFileSync('web/src/main.js', 'utf8');
	for (const schluessel of ['online', 'title', 'dashTitle']) {
		assert.match(main, new RegExp(`${schluessel}: \\[`), `${schluessel} muss ein Textteil-Feld sein`);
	}
	const html = readFileSync('web/index.html', 'utf8');
	for (const id of ['online-tag', 'intro-title', 'dash-title']) {
		assert.match(html, new RegExp(`id="${id}"[^>]*>[^<]*<[^>]*data-teil="0"`), id);
	}
});

test('6 telegramUsername wird gegen das Telegram-Format geprueft', () => {
	assert.match(readFileSync('api/config.mjs', 'utf8'), /\^\[A-Za-z0-9_\]\{5,32\}\$/);
	assert.match(readFileSync('web/src/main.js', 'utf8'), /\^\[A-Za-z0-9_\]\{5,32\}\$/);
});

test('7 der Wallet-Dialog oeffnet die Verbindungsansicht mit QR, nicht die Wallet-Liste', () => {
	const main = readFileSync('web/src/main.js', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
	assert.equal(/view: ['"]AllWallets['"]/.test(main), false,
		'AllWallets ueberspringt die Ansicht mit dem QR-Code');
	// Am Rechner der QR, am Handy die Wallet-Liste - ein QR auf dem Geraet, mit
	// dem man ihn scannen soll, ist sinnlos.
	assert.match(main, /modal\.open\(istMobil\(\) \? \{\} : \{ view: ['"]ConnectingWalletConnect['"] \}\)/);
	assert.match(main, /function istMobil\(\)/);
});

test('8 ein Fehlschlag der WalletConnect-Paarung bleibt nicht stumm', () => {
	const main = readFileSync('web/src/main.js', 'utf8');
	const ohneKommentar = main.replace(/\/\*[\s\S]*?\*\//g, '');
	// Die Behandlung darf nicht am Debugmodus haengen - sonst sieht sie niemand.
	const behandlung = ohneKommentar.indexOf('wcError');
	// Der Debugblock des Dialogs, nicht der weiter oben fuer die Ausgabe.
	const debugBlock = ohneKommentar.indexOf("debugWallet('AppKit ready')");
	assert.ok(behandlung > -1, 'der Fehlerfall wird nicht ausgewertet');
	assert.ok(behandlung < debugBlock, 'die Behandlung steht im Debugblock');
	// Genau ein Aufraeumversuch, danach eine Meldung statt einer Schleife.
	assert.match(ohneKommentar, /paarungAufgeraeumt = true/);
	assert.match(ohneKommentar, /await clearWalletStorage\(\)/);
});

test('9 eine blockierte Loeschung wird nicht als Erfolg gewertet', () => {
	const main = readFileSync('web/src/main.js', 'utf8');
	// deleteDatabase wird blockiert, solange eine Verbindung offen ist. Wer das
	// wie einen Erfolg behandelt, raeumt nie auf und merkt es nicht.
	assert.equal(/onsuccess = request\.onerror = request\.onblocked/.test(main), false,
		'onblocked darf nicht mit onsuccess gleichgesetzt werden');
	assert.match(main, /onblocked = \(\) => \{ blockiert = true;/);
	assert.match(main, /return !blockiert;/);
});

test('10 nach blockierter Loeschung wird vor dem naechsten Start aufgeraeumt', () => {
	const main = readFileSync('web/src/main.js', 'utf8');
	assert.match(main, /sessionStorage\.setItem\(RESET_MARKE/);
	// Das Aufraeumen muss VOR createAppKit stehen - danach haelt AppKit die Datenbank.
	const raeumen = main.indexOf('sessionStorage.getItem(RESET_MARKE)');
	const erzeugen = main.indexOf('createAppKit({');
	assert.ok(raeumen > -1 && erzeugen > -1);
	assert.ok(raeumen < erzeugen, 'das Aufraeumen steht hinter createAppKit');
});

test('11 das Aufraeumen filtert IndexedDB nicht nach Namensliste', () => {
	const main = readFileSync('web/src/main.js', 'utf8');
	// Auf dieser Domain gehoert keine Datenbank der Seite selbst. Eine Liste
	// bekannter Namen laesst fremde SDK-Speicher wie cbwsdk stehen.
	assert.equal(/walletDatabase\s*=/.test(main), false, 'die Namensliste steht noch');
	assert.match(main, /databases\.filter\(\(database\) => database\.name\)/);
	// Und der Schluesselfilter kennt die frueher uebersehenen Speicher.
	for (const name of ['cbwsdk', 'mmconnect']) {
		assert.ok(main.includes(name), `${name} fehlt im Filter`);
	}
});
