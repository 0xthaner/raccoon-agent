/*
	META-AUDIT M-3 (Verteidigung in der Tiefe): AppKit bietet ohne eigene Angabe
	Senden, Empfangen, Swaps und Onramp im Wallet-Fenster an. Nichts davon gehoert
	zu einer Anmeldung. Geprueft wird das ECHTE Optionsobjekt aus main.js (das
	Literal wird ausgewertet), nicht ein Textmuster.
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { appKitMethoden, WALLET_METHODEN_ANMELDEN } from '../web/src/wallet-methods.js';

const FORBIDDEN = ['eth_sendTransaction', 'eth_signTransaction', 'eth_sign', 'eth_signTypedData', 'eth_signTypedData_v3', 'eth_signTypedData_v4', 'wallet_sendCalls', 'wallet_grantPermissions'];

function appKitOptions() {
	const main = readFileSync(new URL('../web/src/main.js', import.meta.url), 'utf8');
	const start = main.indexOf('createAppKit({') + 'createAppKit('.length;
	let depth = 0, end = start;
	for (; end < main.length; end++) { if (main[end] === '{') depth++; else if (main[end] === '}' && --depth === 0) break; }
	return new Function('appKitMethoden', 'WALLET_METHODEN_ANMELDEN', 'EthersAdapter', 'mainnet', 'config', 'location', 'walletDebug', `return (${main.slice(start, end + 1)});`)(
		appKitMethoden, WALLET_METHODEN_ANMELDEN, class {}, { id: 1 }, { reownProjectId: 'x' }, { origin: 'https://coverraccoon.com' }, false);
}

test('AppKit: send, receive, swaps and onramp are disabled', () => {
	const { features } = appKitOptions();
	assert.equal(features.send, false);
	assert.equal(features.receive, false);
	assert.equal(features.swaps, false);
	assert.equal(features.onramp, false);
});

test('AppKit: the requested methods contain personal_sign and no transaction or typed-data method', () => {
	const methods = Object.values(appKitOptions().universalProviderConfigOverride.methods).flat();
	assert.ok(methods.includes('personal_sign'));
	for (const m of FORBIDDEN) assert.ok(!methods.includes(m), m);
});
