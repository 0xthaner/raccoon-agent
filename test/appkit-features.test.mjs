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

/*
	basic: true haelt die Fern-Konfiguration von Reown fern (GHSA-mrhx-c7xc-m3w5):
	ohne sie entsteht das eingebettete Reown-Wallet nie, und mit ihm fehlen die
	message-Listener, die fremde postMessage-Daten mit zod 3.22.4 parsen. Die
	letzten beiden Tests halten fest, worauf das beruht - aendert ein AppKit-Update
	das Verhalten, schlagen sie fehl, statt dass die Sperre still entfaellt.
*/
const reown = (pfad) => readFileSync(new URL(`../node_modules/@reown/${pfad}`, import.meta.url), 'utf8');

test('AppKit: basic mode is on, so the remote project configuration is never fetched', () => {
	assert.equal(appKitOptions().basic, true);
});

test('AppKit (installed): the only remote-config fetch is skipped in basic mode', () => {
	const base = reown('appkit/dist/esm/src/client/appkit-base-client.js');
	assert.equal(base.split('ConfigUtil.fetchRemoteFeatures(').length - 1, 1, 'remote features are fetched in more than one place');
	assert.match(base, /if \(!options\.basic && !options\.manualWCControl\) \{\s*this\.remoteFeatures = await ConfigUtil\.fetchRemoteFeatures\(options\);/);
	assert.match(base, /this\.remoteFeatures = \{\};/, 'remoteFeatures no longer start empty');
	assert.equal(base.split('this.remoteFeatures =').length - 1, 2, 'remoteFeatures are set somewhere else');
});

test('AppKit (installed): the embedded wallet with the zod-parsing listeners exists only with email or socials', () => {
	const kit = reown('appkit/dist/esm/src/client/appkit.js');
	assert.equal(kit.split('W3mFrameProviderSingleton.getInstance(').length - 1, 1);
	assert.match(kit, /const isAuthEnabled = isEmailEnabled \|\| isSocialsEnabled;\s*[^]{0,200}if \(!this\.authProvider && this\.options\?\.projectId && isAuthEnabled\) \{\s*this\.authProvider = W3mFrameProviderSingleton\.getInstance\(/);
	assert.match(kit, /const isEmailEnabled = this\.remoteFeatures\?\.email;/);
	assert.match(kit, /const isSocialsEnabled = Array\.isArray\(this\.remoteFeatures\?\.socials\) && this\.remoteFeatures\.socials\.length > 0;/);
	const frame = reown('appkit-wallet/dist/esm/src/W3mFrame.js');
	assert.doesNotMatch(frame.split('export class W3mFrame')[0], /addEventListener/, 'listeners are registered at module load');
});
