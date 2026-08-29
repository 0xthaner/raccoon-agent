/**
 * AGENT-SEC-A4: kryptografischer End-to-End-Vertrag der SIWE-Anmeldung.
 *
 * Hier wird wirklich signiert und wirklich verifiziert, ueber dieselbe
 * Produktionsfunktion, die auch die Handler benutzen. Kein Netzwerk, keine
 * Datenbank, kein RPC, keine Chain.
 *
 * Es werden weder Schluessel noch Signaturen, Nonces oder Request-IDs
 * ausgegeben.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';
import {
	DASHBOARD_RESOURCE_PATH,
	DASHBOARD_STATEMENT,
	PRODUCTION_ORIGIN,
	SIWE_VERIFICATION_RESULTS,
	TELEGRAM_RESOURCE_PATH,
	TELEGRAM_STATEMENT,
	dashboardExpectation,
	dashboardSiweMessage,
	telegramExpectation,
	telegramRequestId,
	telegramSiweMessage,
	verifyExpectedSiweSignature
} from '../src/siwe-auth.mjs';

/*
 * OEFFENTLICHE TESTFIXTUREN, KEINE GEHEIMNISSE.
 *
 * Die beiden Schluessel sind die weithin veroeffentlichten Standardkonten
 * lokaler Entwicklungsketten. Sie sind ausdruecklich UNSICHER, halten keine
 * Mittel, stammen NICHT aus einer Environmentvariablen, werden in KEINER
 * Produktionsdatei importiert und nirgends ausgegeben. Sie dienen einzig
 * dazu, echte EOA-Signaturen deterministisch zu erzeugen.
 */
const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const OTHER_TEST_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

const signer = privateKeyToAccount(TEST_KEY);
const otherSigner = privateKeyToAccount(OTHER_TEST_KEY);

const NONCE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const REQUEST_ID = 'ffeeddccbbaa99887766554433221100';
const CODE = 'test-pending-link-code';
const ISSUED_AT = 1_800_000_000_000;
const EXPIRES_AT = ISSUED_AT + 5 * 60_000;
const NOW = ISSUED_AT + 1_000;

function withEnv(values, run) {
	const previous = {};
	for (const [key, value] of Object.entries(values)) {
		previous[key] = process.env[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		return run();
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

/** Nur die Nachrichtenerzeugung braucht die trusted Origin. */
function inProduction(run) {
	return withEnv({ APP_BASE_URL: PRODUCTION_ORIGIN, NODE_ENV: undefined, VERCEL_ENV: 'production' }, run);
}

function dashboardPair(overrides = {}) {
	return inProduction(() => {
		const build = { wallet: signer.address, nonce: NONCE, issuedAt: ISSUED_AT, expiresAt: EXPIRES_AT, requestId: REQUEST_ID, ...overrides };
		return { message: dashboardSiweMessage(build), expected: dashboardExpectation(build) };
	});
}

function telegramPair(overrides = {}) {
	return inProduction(() => {
		const build = { wallet: signer.address, nonce: NONCE, issuedAt: ISSUED_AT, expiresAt: EXPIRES_AT, code: CODE, ...overrides };
		return { message: telegramSiweMessage(build), expected: telegramExpectation(build) };
	});
}

function source(relative) {
	return readFileSync(new URL(relative, import.meta.url), 'utf8');
}

/* ------------------------------------------------------------------------- *
 * 1 bis 6, Dashboard positiv
 * ------------------------------------------------------------------------- */

test('1 bis 4 die Test-Wallet signiert die Dashboard-Nachricht und wird akzeptiert', async () => {
	const { message, expected } = dashboardPair();
	const signature = await signer.signMessage({ message });
	assert.equal(await verifyExpectedSiweSignature({ message, signature, expected, now: NOW }), 'VALID');
	// Die verifizierte Adresse ist die erwartete Wallet.
	assert.equal(String(expected.wallet).toLowerCase(), signer.address.toLowerCase());
	assert.ok(message.includes(signer.address));
});

test('5 die Signaturpruefung ist deterministisch', async () => {
	const { message, expected } = dashboardPair();
	const signature = await signer.signMessage({ message });
	const first = await verifyExpectedSiweSignature({ message, signature, expected, now: NOW });
	const second = await verifyExpectedSiweSignature({ message, signature, expected, now: NOW });
	assert.equal(first, 'VALID');
	assert.equal(second, first);
});

test('6 die Verifikation verbraucht keine Nonce', async () => {
	// Die Grenze prueft nur; der atomare Verbrauch bleibt in der Datenbank und
	// geschieht im Handler NACH dieser Pruefung.
	const { message, expected } = dashboardPair();
	const signature = await signer.signMessage({ message });
	assert.equal(await verifyExpectedSiweSignature({ message, signature, expected, now: NOW }), 'VALID');
	assert.equal(await verifyExpectedSiweSignature({ message, signature, expected, now: NOW }), 'VALID');

	const code = source('../src/siwe-auth.mjs');
	for (const forbidden of ['consumeDashboardChallenge', 'consumePendingLink', 'db.mjs']) {
		assert.equal(code.includes(forbidden), false, forbidden);
	}
});

/* ------------------------------------------------------------------------- *
 * 7 bis 18, Dashboard negativ
 * ------------------------------------------------------------------------- */

test('7 die Signatur einer anderen Wallet wird abgelehnt', async () => {
	const { message, expected } = dashboardPair();
	const signature = await otherSigner.signMessage({ message });
	assert.notEqual(otherSigner.address, signer.address);
	assert.equal(await verifyExpectedSiweSignature({ message, signature, expected, now: NOW }), 'INVALID_SIGNATURE');
});

test('8 bis 14 eine gueltig signierte, aber veraenderte Nachricht wird abgelehnt', async () => {
	const { message, expected } = dashboardPair();
	const cases = [
		['DOMAIN_MISMATCH', message.replace('agent.coverraccoon.com wants you', 'evil.tld wants you')],
		['URI_MISMATCH', message.replace(`URI: ${PRODUCTION_ORIGIN}\n`, 'URI: https://evil.tld\n')],
		['CHAIN_MISMATCH', message.replace('Chain ID: 1\n', 'Chain ID: 137\n')],
		['STATEMENT_MISMATCH', message.replace(DASHBOARD_STATEMENT, TELEGRAM_STATEMENT)],
		['NONCE_MISMATCH', message.replace(`Nonce: ${NONCE}`, 'Nonce: ffffffffffffffffffffffffffffffff')],
		['REQUEST_ID_MISMATCH', message.replace(`Request ID: ${REQUEST_ID}`, 'Request ID: 00000000000000000000000000000000')],
		['RESOURCE_MISMATCH', message.replace(`- ${PRODUCTION_ORIGIN}${DASHBOARD_RESOURCE_PATH}`, `- ${PRODUCTION_ORIGIN}${TELEGRAM_RESOURCE_PATH}`)]
	];
	for (const [reason, forged] of cases) {
		assert.notEqual(forged, message, reason);
		// Der Angreifer signiert seine eigene Fassung KORREKT.
		const signature = await signer.signMessage({ message: forged });
		const result = await verifyExpectedSiweSignature({ message: forged, signature, expected, now: NOW });
		assert.equal(result, reason, reason);
	}
});

test('15 bis 17 unbrauchbare Signaturformate werden abgelehnt', async () => {
	const { message, expected } = dashboardPair();
	const signature = await signer.signMessage({ message });
	const broken = [
		signature.slice(0, -2),
		`${signature}ff`,
		`0x${'z'.repeat(130)}`,
		signature.slice(2),
		'',
		'0x',
		undefined,
		null,
		42
	];
	for (const value of broken) {
		const result = await verifyExpectedSiweSignature({ message, signature: value, expected, now: NOW });
		assert.equal(result, 'INVALID_SIGNATURE_FORMAT', String(value).slice(0, 12));
	}
});

test('18 die Signatur einer abgelaufenen Nachricht wird abgelehnt', async () => {
	const { message, expected } = dashboardPair();
	const signature = await signer.signMessage({ message });
	assert.equal(await verifyExpectedSiweSignature({ message, signature, expected, now: EXPIRES_AT }), 'EXPIRED');
	assert.equal(await verifyExpectedSiweSignature({ message, signature, expected, now: EXPIRES_AT + 60_000 }), 'EXPIRED');
});

/* ------------------------------------------------------------------------- *
 * 19 bis 22, Telegram positiv
 * ------------------------------------------------------------------------- */

test('19 und 20 die Test-Wallet signiert die Telegram-Nachricht und wird akzeptiert', async () => {
	const { message, expected } = telegramPair();
	const signature = await signer.signMessage({ message });
	assert.equal(await verifyExpectedSiweSignature({ message, signature, expected, now: NOW }), 'VALID');
	assert.ok(message.includes(TELEGRAM_STATEMENT));
	assert.ok(message.includes(`- ${PRODUCTION_ORIGIN}${TELEGRAM_RESOURCE_PATH}`));
});

test('21 und 22 die Telegram-Verifikation erzeugt weder Session noch Cookie', () => {
	const code = source('../api/link/verify.mjs');
	assert.equal(/set-cookie/i.test(code), false);
	assert.equal(code.includes('createDashboardSession'), false);
	assert.equal(code.includes('sessionCookieHeader'), false);
	assert.ok(code.includes('verifyExpectedSiweSignature'));
});

/* ------------------------------------------------------------------------- *
 * 23 bis 27, Zwecktrennung mit echten Signaturen
 * ------------------------------------------------------------------------- */

test('23 und 24 eine Signatur des einen Zwecks gilt nicht fuer den anderen', async () => {
	const dashboard = dashboardPair();
	const telegram = telegramPair();
	const dashboardSignature = await signer.signMessage({ message: dashboard.message });
	const telegramSignature = await signer.signMessage({ message: telegram.message });

	assert.notEqual(
		await verifyExpectedSiweSignature({ message: dashboard.message, signature: dashboardSignature, expected: telegram.expected, now: NOW }),
		'VALID'
	);
	assert.notEqual(
		await verifyExpectedSiweSignature({ message: telegram.message, signature: telegramSignature, expected: dashboard.expected, now: NOW }),
		'VALID'
	);
});

test('25 und 26 Ressource und Request-ID des einen Zwecks ersetzen den anderen nicht', async () => {
	const dashboard = dashboardPair();

	// Dashboardnachricht mit der Telegram-Request-ID, korrekt signiert.
	const swapped = dashboardPair({ requestId: telegramRequestId(CODE) });
	const swappedSignature = await signer.signMessage({ message: swapped.message });
	assert.equal(
		await verifyExpectedSiweSignature({ message: swapped.message, signature: swappedSignature, expected: dashboard.expected, now: NOW }),
		'REQUEST_ID_MISMATCH'
	);

	// Und die Ressource des einen passt nie auf die Erwartung des anderen.
	assert.notEqual(dashboard.expected.resource, telegramPair().expected.resource);
	assert.notEqual(dashboard.expected.statement, telegramPair().expected.statement);
});

test('27 dieselbe Wallet hebt die Zwecktrennung nicht auf', async () => {
	const dashboard = dashboardPair();
	const telegram = telegramPair();
	assert.equal(dashboard.expected.wallet, telegram.expected.wallet);
	const signature = await signer.signMessage({ message: telegram.message });
	assert.equal(
		await verifyExpectedSiweSignature({ message: telegram.message, signature, expected: dashboard.expected, now: NOW }),
		'STATEMENT_MISMATCH'
	);
});

/* ------------------------------------------------------------------------- *
 * 28 bis 33, Handlergrenze
 * ------------------------------------------------------------------------- */

test('28 bis 30 alle drei Handler nutzen dieselbe eine Verifikationsgrenze', () => {
	for (const file of ['../api/dashboard.mjs', '../api/link/verify.mjs', '../src/web.mjs']) {
		const code = source(file);
		assert.ok(code.includes('verifyExpectedSiweSignature'), file);
		// Keine zweite Verifikationslogik daneben.
		assert.equal(code.includes('verifyMessage'), false, file);
		assert.equal(code.includes('checkSiweMessage'), false, file);
	}
	// Und die Bibliotheksfunktion wird ausschliesslich zentral bezogen.
	assert.ok(source('../src/siwe-auth.mjs').includes("import { verifyMessage } from 'viem'"));
});

test('31 bis 33 die interne Ursache verlaesst den Server nicht', () => {
	// Kein Handler gibt das Ergebnis der Verifikation aus oder loggt es.
	for (const file of ['../api/dashboard.mjs', '../api/link/verify.mjs', '../src/web.mjs']) {
		const code = source(file);
		assert.equal(/json\([^)]*verified/.test(code), false, file);
		assert.equal(/console\.[a-z]+\([^)]*(signature|message|verified)/i.test(code), false, file);
		for (const reason of SIWE_VERIFICATION_RESULTS.filter((value) => value !== 'VALID')) {
			assert.equal(code.includes(reason), false, `${file}:${reason}`);
		}
	}
});

test('33b der Fehlerpfad gibt einen festen Satz aus, keine Signatur', () => {
	// Die Challenge-Antwort enthaelt die SIWE-Nachricht bewusst, der Client muss
	// sie ja signieren. Geprueft wird hier der FEHLERPFAD: er nennt weder
	// Signatur noch Ursache, sondern einen unveraenderlichen Satz.
	const dashboard = source('../api/dashboard.mjs');
	assert.ok(dashboard.includes("error: 'Wallet-Signatur konnte nicht bestätigt werden.'"));
	assert.equal(/json\(\{[^}]*signature/.test(dashboard), false);
	assert.equal(/json\(\{[^}]*verified/.test(dashboard), false);
});

/* ------------------------------------------------------------------------- *
 * EOA-Grenze
 * ------------------------------------------------------------------------- */

test('R die EOA-Grenze bleibt ausdruecklich dokumentiert und ohne Fallback', () => {
	const code = source('../src/siwe-auth.mjs');
	assert.ok(code.includes('ERC-1271 CONTRACT-WALLET VERIFICATION NOT IMPLEMENTED'));
	// Keine Chain-, RPC- oder Public-Client-Anbindung.
	for (const forbidden of ['createPublicClient', 'http(', 'publicClient', 'transport', 'rpcUrl']) {
		assert.equal(code.includes(forbidden), false, forbidden);
	}
});

test('R das Ergebnisvokabular kennt keine Gesamtklasse', () => {
	for (const forbidden of ['TRUSTED', 'SECURE', 'PROVEN']) {
		assert.equal(SIWE_VERIFICATION_RESULTS.includes(forbidden), false, forbidden);
	}
	assert.ok(SIWE_VERIFICATION_RESULTS.includes('VALID'));
	assert.ok(SIWE_VERIFICATION_RESULTS.includes('INVALID_SIGNATURE'));
	assert.ok(SIWE_VERIFICATION_RESULTS.includes('INVALID_SIGNATURE_FORMAT'));
	assert.equal(new Set(SIWE_VERIFICATION_RESULTS).size, SIWE_VERIFICATION_RESULTS.length);
});
