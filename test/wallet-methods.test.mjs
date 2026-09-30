/**
 * AGENT-SEC-W1: Welche Rechte die Wallet-Sitzung ueberhaupt erteilt.
 *
 * Der Waechter in `dashboard-auth-boundaries.test.mjs` prueft, dass UNSER Code
 * nichts Gefaehrliches aufruft. Hier geht es um die Stufe davor: was die
 * ausgehandelte Sitzung hergibt, unabhaengig davon, wer sie spaeter benutzt.
 *
 * Deterministisch und offline: kein Netzwerk, keine Wallet, keine Datenbank.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
	appKitMethoden,
	WALLET_METHODEN_ALLE,
	WALLET_METHODEN_ANMELDEN,
	WALLET_METHODEN_DEMO
} from '../web/src/wallet-methods.js';

function source(relative) {
	return readFileSync(new URL(relative, import.meta.url), 'utf8');
}

/*
	Kommentare duerfen die verbotenen Namen tragen - sie erklaeren ja gerade,
	warum die Methoden fehlen. Geprueft wird nur ausfuehrbarer Text. Dasselbe
	Vorgehen wie in `scripts/check-frontend.mjs`.
*/
function ohneKommentare(quelle) {
	return quelle
		.replace(/\/\*[\s\S]*?\*\//g, (treffer) => treffer.replace(/[^\n]/g, ' '))
		.replace(/(^|[^:])\/\/[^\n]*/g, (treffer, vor) => vor + ' '.repeat(treffer.length - vor.length));
}

const WEB_SRC = fileURLToPath(new URL('../web/src', import.meta.url));

function frontendDateien() {
	return readdirSync(WEB_SRC).flatMap((name) => {
		const pfad = join(WEB_SRC, name);
		if (statSync(pfad).isDirectory()) return [];
		return name.endsWith('.js') ? [pfad] : [];
	});
}

/*
	Die vollstaendige Vorgabe von AppKit 1.8.x, `DEFAULT_METHODS.eip155` aus
	`@reown/appkit-utils`. Sie steht hier ausgeschrieben, damit dieser Test auch
	dann noch etwas aussagt, wenn die Bibliothek ihre Liste spaeter aendert: die
	Frage ist nicht, was AppKit heute vorschlaegt, sondern was wir zulassen.
*/
const APPKIT_VORGABE = [
	'eth_accounts', 'eth_requestAccounts', 'eth_sendRawTransaction', 'eth_sign',
	'eth_signTransaction', 'eth_signTypedData', 'eth_signTypedData_v3',
	'eth_signTypedData_v4', 'eth_sendTransaction', 'personal_sign',
	'wallet_switchEthereumChain', 'wallet_addEthereumChain', 'wallet_getPermissions',
	'wallet_requestPermissions', 'wallet_registerOnboarding', 'wallet_watchAsset',
	'wallet_scanQRCode', 'wallet_getCallsStatus', 'wallet_showCallsStatus',
	'wallet_sendCalls', 'wallet_getCapabilities', 'wallet_grantPermissions',
	'wallet_revokePermissions', 'wallet_getAssets'
];

/** Alles, was Werte bewegen, Rechte delegieren oder blind signieren kann. */
const NIEMALS = [
	'eth_sendTransaction', 'eth_sendRawTransaction', 'eth_signTransaction',
	'eth_sign', 'eth_signTypedData', 'eth_signTypedData_v3', 'eth_signTypedData_v4',
	'wallet_sendCalls', 'wallet_grantPermissions', 'wallet_requestPermissions',
	'wallet_revokePermissions', 'wallet_watchAsset', 'wallet_addEthereumChain'
];

test('W1 die Anmeldung fragt genau eine Signaturmethode an', () => {
	assert.deepEqual(WALLET_METHODEN_ANMELDEN, ['eth_requestAccounts', 'eth_accounts', 'personal_sign']);
});

test('W1 die Demo darf zusaetzlich nur das Netz wechseln', () => {
	assert.deepEqual(
		WALLET_METHODEN_DEMO.filter((m) => !WALLET_METHODEN_ANMELDEN.includes(m)),
		['wallet_switchEthereumChain']
	);
});

test('W1 keine Liste enthaelt eine wertbewegende Methode', () => {
	for (const liste of [WALLET_METHODEN_ANMELDEN, WALLET_METHODEN_DEMO, WALLET_METHODEN_ALLE]) {
		for (const verboten of NIEMALS) {
			assert.equal(liste.includes(verboten), false, verboten);
		}
	}
});

test('W1 jede erlaubte Methode ist eine, die AppKit ueberhaupt aushandelt', () => {
	for (const methode of WALLET_METHODEN_ALLE) {
		assert.ok(APPKIT_VORGABE.includes(methode), `${methode} steht nicht in der AppKit-Vorgabe`);
	}
});

test('W1 die Begrenzung streicht zwanzig der vierundzwanzig Vorgabemethoden', () => {
	const gestrichen = APPKIT_VORGABE.filter((m) => !WALLET_METHODEN_ALLE.includes(m));
	assert.equal(APPKIT_VORGABE.length, 24);
	assert.equal(gestrichen.length, 20);
	assert.equal(WALLET_METHODEN_ALLE.length, 4);
	// Die vier gefaehrlichsten namentlich, damit ihr Wiederauftauchen auffaellt.
	for (const methode of ['eth_sendTransaction', 'eth_sign', 'wallet_sendCalls', 'wallet_grantPermissions']) {
		assert.ok(gestrichen.includes(methode), methode);
	}
});

test('W1 die Form entspricht dem, was createAppKit erwartet', () => {
	assert.deepEqual(appKitMethoden(WALLET_METHODEN_ANMELDEN), {
		methods: { eip155: ['eth_requestAccounts', 'eth_accounts', 'personal_sign'] }
	});
	// Eine Kopie, keine geteilte Referenz: der Aufrufer darf die Liste nicht veraendern.
	const gebaut = appKitMethoden(WALLET_METHODEN_ANMELDEN);
	gebaut.methods.eip155.push('eth_sendTransaction');
	assert.equal(WALLET_METHODEN_ANMELDEN.includes('eth_sendTransaction'), false);
});

test('W1 kein createAppKit ohne Begrenzung', () => {
	let aufrufe = 0;
	for (const pfad of frontendDateien()) {
		const quelle = ohneKommentare(readFileSync(pfad, 'utf8'));
		for (const zeile of quelle.split('\n')) {
			if (!zeile.includes('createAppKit(')) continue;
			aufrufe++;
			assert.ok(
				zeile.includes('universalProviderConfigOverride: appKitMethoden('),
				`${pfad} erzeugt AppKit ohne Methodenbegrenzung`
			);
		}
	}
	assert.equal(aufrufe, 2, 'es gibt genau zwei Stellen, die AppKit erzeugen');
});

test('W1 die Methodenliste steht an genau einer Stelle', () => {
	for (const pfad of frontendDateien()) {
		if (pfad.endsWith('wallet-methods.js')) continue;
		const quelle = ohneKommentare(readFileSync(pfad, 'utf8'));
		assert.equal(
			quelle.includes("'personal_sign'") && quelle.includes('methods:'),
			false,
			`${pfad} baut eine eigene Methodenliste`
		);
	}
	// Und die eine Stelle ist auch wirklich die, die beide Aufrufer benutzen.
	for (const datei of ['../web/src/main.js', '../web/src/demo-renew.js']) {
		assert.ok(source(datei).includes("from './wallet-methods.js'"), datei);
	}
});
