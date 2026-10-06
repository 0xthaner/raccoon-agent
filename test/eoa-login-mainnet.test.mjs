/*
	AGENT-UX-5: der injizierte EOA-Login stellt die Wallet VOR der Challenge auf
	Ethereum Mainnet, liest den aktiven Account danach ERNEUT und bricht fail
	closed ab, wenn Netz/Account auseinanderlaufen oder ein chainChanged den
	Versuch entwertet. WalletConnect-Methodenliste und der native Safe-App-Pfad
	bleiben unberuehrt.
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WALLET_METHODEN_ANMELDEN } from '../web/src/wallet-methods.js';
import { ensureMainnetAccount, eoaLoginTexts, normalizeAddress, guardedChallengeSignSubmit } from '../web/src/eoa-login.js';

const main = readFileSync(new URL('../web/src/main.js', import.meta.url), 'utf8');
const eoa = readFileSync(new URL('../web/src/eoa-login.js', import.meta.url), 'utf8');
const safeApp = readFileSync(new URL('../web/src/safe-app.js', import.meta.url), 'utf8');
const T = eoaLoginTexts('en');

const ACC_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ACC_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

// Mock eines injizierten EIP-1193-Providers mit sequenzierten Antworten.
function mockProvider({ chainSeq, accountsSeq, rejectSwitch = false }) {
	let ci = 0;
	let ai = 0;
	const calls = [];
	return {
		calls,
		request: async ({ method }) => {
			calls.push(method);
			if (method === 'eth_chainId') return chainSeq[Math.min(ci++, chainSeq.length - 1)];
			if (method === 'wallet_switchEthereumChain') { if (rejectSwitch) throw new Error('user rejected'); return null; }
			if (method === 'eth_accounts') return accountsSeq[Math.min(ai++, accountsSeq.length - 1)];
			throw new Error('unexpected method ' + method);
		}
	};
}

/* ----------------------------- Behavioral ------------------------------- */

test('A: bereits Mainnet -> kein switch, gleicher Account, Login darf fortsetzen', async () => {
	const p = mockProvider({ chainSeq: ['0x1'], accountsSeq: [[ACC_A]] });
	const account = await ensureMainnetAccount(p, ACC_A, { texts: T });
	assert.equal(account, ACC_A);
	assert.equal(p.calls.includes('wallet_switchEthereumChain'), false);
	assert.ok(p.calls.includes('eth_accounts')); // Account wird auch hier erneut gelesen
});

test('B: Polygon -> switch 0x1 -> recheck 0x1 -> eth_accounts erneut -> gleicher Account', async () => {
	const p = mockProvider({ chainSeq: ['0x89', '0x1'], accountsSeq: [[ACC_A]] });
	const account = await ensureMainnetAccount(p, ACC_A, { texts: T });
	assert.equal(account, ACC_A);
	assert.ok(p.calls.includes('wallet_switchEthereumChain'));
	// eth_accounts wird NACH dem switch gelesen
	assert.ok(p.calls.lastIndexOf('eth_accounts') > p.calls.indexOf('wallet_switchEthereumChain'));
});

test('C: User lehnt switch ab -> STOP, kein eth_accounts (keine Challenge/Signatur)', async () => {
	const p = mockProvider({ chainSeq: ['0x89'], accountsSeq: [[ACC_A]], rejectSwitch: true });
	await assert.rejects(() => ensureMainnetAccount(p, ACC_A, { texts: T }), (e) => e.message === T.switchFailed);
	assert.equal(p.calls.includes('eth_accounts'), false);
});

test('D: switch resolved, Recheck != 0x1 -> STOP, kein eth_accounts', async () => {
	const p = mockProvider({ chainSeq: ['0x89', '0x89'], accountsSeq: [[ACC_A]] });
	await assert.rejects(() => ensureMainnetAccount(p, ACC_A, { texts: T }), (e) => e.message === T.notMainnet);
	assert.equal(p.calls.includes('eth_accounts'), false);
});

test('E: Account nach Switch geaendert -> STOP (keine stille Alt-Adresse)', async () => {
	const p = mockProvider({ chainSeq: ['0x89', '0x1'], accountsSeq: [[ACC_B]] });
	await assert.rejects(() => ensureMainnetAccount(p, ACC_A, { texts: T }), (e) => e.message === T.accountChanged);
	// auch ohne switch (bereits Mainnet) muss ein geaenderter Account abbrechen
	const p2 = mockProvider({ chainSeq: ['0x1'], accountsSeq: [[ACC_B]] });
	await assert.rejects(() => ensureMainnetAccount(p2, ACC_A, { texts: T }), (e) => e.message === T.accountChanged);
});

test('F: chainChanged auf Polygon waehrend Login -> invalidiert, kein eth_accounts', async () => {
	const p = mockProvider({ chainSeq: ['0x89', '0x1'], accountsSeq: [[ACC_A]] });
	await assert.rejects(() => ensureMainnetAccount(p, ACC_A, { texts: T, isAborted: () => true }), (e) => e.message === T.chainChanged);
	assert.equal(p.calls.includes('eth_accounts'), false);
});

test('kein Account mehr vorhanden -> STOP', async () => {
	const p = mockProvider({ chainSeq: ['0x1'], accountsSeq: [[]] });
	await assert.rejects(() => ensureMainnetAccount(p, ACC_A, { texts: T }), (e) => e.message === T.noAccount);
});

test('normalizeAddress: nur gueltige 40-hex-Adresse, lowercase; sonst null', () => {
	assert.equal(normalizeAddress('0x' + 'A'.repeat(40)), '0x' + 'a'.repeat(40));
	assert.equal(normalizeAddress('0x123'), null);
	assert.equal(normalizeAddress(null), null);
});

/* --------------------------- Source invariants -------------------------- */

function koerper(quelle, start) {
	const i = quelle.indexOf(start);
	return i < 0 ? '' : quelle.slice(i, quelle.indexOf('\n}\n', i));
}

test('injizierter Login: Mainnet-Account-Check vor der Signatur, Listener sauber', () => {
	const fn = koerper(main, 'async function verbindeBrowserWallet() {');
	assert.ok(fn, 'verbindeBrowserWallet gefunden');
	const ensurePos = fn.indexOf('ensureMainnetAccount(');
	const signPos = fn.indexOf("method: 'personal_sign'");
	assert.ok(ensurePos > 0 && signPos > 0 && ensurePos < signPos, 'ensureMainnetAccount steht vor der Signatur');
	// der verifizierte (neu gelesene) Account wird fuer die Signatur verwendet, nicht die Alt-Adresse
	assert.match(fn, /personal_sign', params: \[message, konto\]/);
	assert.match(fn, /finish\(konto,/);
	// chainChanged-Listener nur fuer diesen Versuch, im finally entfernt
	assert.match(fn, /\.on\?\.\('chainChanged'/);
	assert.match(fn, /removeListener\?\.\('chainChanged'/);
});

test('eoa-login.js schaltet genau auf 0x1 und liest eth_accounts erneut', () => {
	assert.match(eoa, /method: 'wallet_switchEthereumChain', params: \[\{ chainId: MAINNET_HEX \}\]/);
	assert.match(eoa, /method: 'eth_accounts'/);
	assert.match(eoa, /export const MAINNET_HEX = '0x1'/);
	assert.equal(eoa.includes('wallet_addEthereumChain'), false);
});

test('WalletConnect-Methodenliste unveraendert (kein switch-Recht in der Session)', () => {
	assert.deepEqual(WALLET_METHODEN_ANMELDEN, ['eth_requestAccounts', 'eth_accounts', 'personal_sign']);
});

test('nativer Safe-App-Pfad unveraendert (kein chain switch / chainChanged)', () => {
	assert.equal(safeApp.includes('wallet_switchEthereumChain'), false);
	assert.equal(safeApp.includes('chainChanged'), false);
});

/* ------------------------- chainChanged race ---------------------------- */

function rec(impl) {
	const f = async (...args) => { f.calls += 1; return impl ? impl(...args) : undefined; };
	f.calls = 0;
	return f;
}

test('D: normaler Mainnet-Flow -> Challenge, Signatur, POST laufen, Ergebnis zurueck', async () => {
	const getChallenge = rec(async () => ({ ok: true, message: 'm', token: 't' }));
	const sign = rec(async () => '0xsig');
	const submit = rec(async () => ({ ok: true, wallet: ACC_A }));
	const out = await guardedChallengeSignSubmit({ texts: T, getChallenge, sign, submit });
	assert.equal(getChallenge.calls, 1);
	assert.equal(sign.calls, 1);
	assert.equal(submit.calls, 1);
	assert.deepEqual(out, { ok: true, wallet: ACC_A });
});

test('A: chainChanged vor der Challenge -> kein Signieren, kein POST', async () => {
	const getChallenge = rec(async () => ({ ok: true, message: 'm', token: 't' }));
	const sign = rec(async () => '0xsig');
	const submit = rec(async () => ({ ok: true }));
	await assert.rejects(
		() => guardedChallengeSignSubmit({ texts: T, isAborted: () => true, getChallenge, sign, submit }),
		(e) => e.message === T.chainChanged
	);
	assert.equal(sign.calls, 0);
	assert.equal(submit.calls, 0);
});

test('B: chainChanged nach Challenge, vor Signatur -> kein personal_sign, kein POST', async () => {
	let aborted = false;
	const getChallenge = rec(async () => { aborted = true; return { ok: true, message: 'm', token: 't' }; });
	const sign = rec(async () => '0xsig');
	const submit = rec(async () => ({ ok: true }));
	await assert.rejects(
		() => guardedChallengeSignSubmit({ texts: T, isAborted: () => aborted, getChallenge, sign, submit }),
		(e) => e.message === T.chainChanged
	);
	assert.equal(getChallenge.calls, 1);
	assert.equal(sign.calls, 0);
	assert.equal(submit.calls, 0);
});

test('C: chainChanged nach Signatur, vor POST -> Verifikation-POST laeuft nicht', async () => {
	let aborted = false;
	const getChallenge = rec(async () => ({ ok: true, message: 'm', token: 't' }));
	const sign = rec(async () => { aborted = true; return '0xsig'; });
	const submit = rec(async () => ({ ok: true }));
	await assert.rejects(
		() => guardedChallengeSignSubmit({ texts: T, isAborted: () => aborted, getChallenge, sign, submit }),
		(e) => e.message === T.chainChanged
	);
	assert.equal(sign.calls, 1);
	assert.equal(submit.calls, 0);
});

test('nicht-ok Challenge -> Abbruch vor Signatur', async () => {
	const sign = rec(async () => '0xsig');
	const submit = rec(async () => ({ ok: true }));
	await assert.rejects(() => guardedChallengeSignSubmit({ texts: T, getChallenge: async () => ({ ok: false, error: 'boom' }), sign, submit }), /boom/);
	assert.equal(sign.calls, 0);
	assert.equal(submit.calls, 0);
});

test('Source: openDashboard/finish sind abbrechbar und nutzen den Kombinator', () => {
	assert.match(main, /async function openDashboard\(wallet, sign, isAborted = \(\) => false\)/);
	assert.match(main, /async function finish\(wallet, sign, isAborted = \(\) => false\)/);
	assert.ok((main.match(/guardedChallengeSignSubmit\(/g) ?? []).length >= 2);
	// der injizierte Weg reicht das Abbruch-Praedikat an finish
	const fn = koerper(main, 'async function verbindeBrowserWallet() {');
	assert.match(fn, /await finish\(konto, signiere, \(\) => abgebrochen\)/);
});

test('Source: injizierter Signer prueft Abbruch UND eth_chainId vor personal_sign', () => {
	const fn = koerper(main, 'async function verbindeBrowserWallet() {');
	const sigDef = fn.indexOf('const signiere = async');
	const abortCheck = fn.indexOf('if (abgebrochen) throw', sigDef);
	const chainCheck = fn.indexOf("method: 'eth_chainId'", sigDef);
	const signCall = fn.indexOf("method: 'personal_sign'", sigDef);
	assert.ok(sigDef > 0, 'Signer-Closure vorhanden');
	assert.ok(abortCheck > sigDef && abortCheck < signCall, 'Abbruch-Check vor der Signatur');
	assert.ok(chainCheck > sigDef && chainCheck < signCall, 'eth_chainId-Check vor der Signatur');
});
