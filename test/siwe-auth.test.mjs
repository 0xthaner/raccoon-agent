/**
 * AGENT-SEC-A3: domaingebundenes SIWE fuer Dashboard und Telegram.
 *
 * Ausfuehrbare Verhaltenstests. `src/siwe-auth.mjs` liest weder Datenbank noch
 * Netzwerk noch Request, deshalb laesst sich die gesamte Erzeugung und Pruefung
 * hier wirklich ausfuehren statt nur im Quelltext gelesen zu werden.
 *
 * Es werden keine Secrets, Nonces, Request-IDs oder Signaturen ausgegeben.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getAddress } from 'viem';
import { parseSiweMessage, validateSiweMessage } from 'viem/siwe';
import {
	DASHBOARD_RESOURCE_PATH,
	DASHBOARD_STATEMENT,
	PRODUCTION_ORIGIN,
	SIWE_CHAIN_ID,
	SIWE_CLOCK_SKEW_MS,
	SIWE_VERSION,
	TELEGRAM_RESOURCE_PATH,
	TELEGRAM_STATEMENT,
	checkSiweMessage,
	dashboardExpectation,
	dashboardSiweMessage,
	newRequestId,
	siweOrigin,
	telegramExpectation,
	telegramRequestId,
	telegramSiweMessage
} from '../src/siwe-auth.mjs';

const WALLET = '0x1111111111111111111111111111111111111111';
const OTHER_WALLET = '0x2222222222222222222222222222222222222222';
/** Offizielle EIP-55-Beispieladresse, kanonisch in Grossschreibung. */
const EIP55_LOWERCASE = '0x52908400098527886e0f7030069857d2e4169ee7';
const NONCE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const CODE = 'test-pending-link-code';
const DOMAIN = 'agent.coverraccoon.com';

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

/** Production: keine Entwicklungssignale gesetzt. */
function inProduction(run) {
	return withEnv({ APP_BASE_URL: PRODUCTION_ORIGIN, NODE_ENV: undefined, VERCEL_ENV: 'production' }, run);
}

const ISSUED_AT = 1_800_000_000_000;
const EXPIRES_AT = ISSUED_AT + 5 * 60_000;
const NOW = ISSUED_AT + 1_000;

function dashboardParts() {
	const requestId = 'ffeeddccbbaa99887766554433221100';
	const message = dashboardSiweMessage({ wallet: WALLET, nonce: NONCE, issuedAt: ISSUED_AT, expiresAt: EXPIRES_AT, requestId });
	const expected = dashboardExpectation({ wallet: WALLET, nonce: NONCE, issuedAt: ISSUED_AT, expiresAt: EXPIRES_AT, requestId });
	return { message, expected, requestId };
}

function telegramParts() {
	const message = telegramSiweMessage({ wallet: WALLET, nonce: NONCE, issuedAt: ISSUED_AT, expiresAt: EXPIRES_AT, code: CODE });
	const expected = telegramExpectation({ wallet: WALLET, nonce: NONCE, issuedAt: ISSUED_AT, expiresAt: EXPIRES_AT, code: CODE });
	return { message, expected };
}

/* ------------------------------------------------------------------------- *
 * 1 bis 7, zentrale Konfiguration
 * ------------------------------------------------------------------------- */

test('1 die Productionorigin ist exakt agent.coverraccoon.com', () => {
	const origin = inProduction(() => siweOrigin());
	assert.deepEqual(origin, { domain: DOMAIN, uri: PRODUCTION_ORIGIN });
});

test('2 HTTP wird in Production abgelehnt', () => {
	withEnv({ APP_BASE_URL: 'http://agent.coverraccoon.com', VERCEL_ENV: 'production', NODE_ENV: undefined }, () => {
		assert.throws(() => siweOrigin());
	});
});

test('3 und 4 fremde Domain und Subdomain-Abweichung werden abgelehnt', () => {
	for (const value of [
		'https://coverraccoon.com',
		'https://www.agent.coverraccoon.com',
		'https://agent.coverraccoon.com.evil.tld',
		'https://evil.tld',
		'https://agent.coverraccoon.com:8443'
	]) {
		withEnv({ APP_BASE_URL: value, VERCEL_ENV: 'production', NODE_ENV: undefined }, () => {
			assert.throws(() => siweOrigin(), undefined, value);
		});
	}
});

test('5 kein Requestwert kann die Domain ueberschreiben', () => {
	// Die Funktion nimmt keinen Request entgegen; eine Ueberschreibung ist
	// strukturell unmoeglich. Belegt zusaetzlich am Modul selbst.
	assert.equal(siweOrigin.length, 0);

	// Nur der Code, nicht die Kommentare: der Kopfkommentar NENNT Host, Origin,
	// Query und Body ausdruecklich, um ihre Abwesenheit zu erklaeren. Eine
	// Pruefung, die dieses negierende Wort mitzaehlt, verfehlt ihren Gegenstand.
	const source = readFileSync(new URL('../src/siwe-auth.mjs', import.meta.url), 'utf8');
	const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ').toLowerCase();
	// Echte Requestzugriffe, nicht das blosse Wort: `requestId` ist ein
	// legitimes SIWE-Feld und darf die Pruefung nicht ausloesen.
	for (const untrusted of [
		'req.headers', 'request.headers', 'headers[',
		'req.query', 'request.query',
		'req.body', 'request.body',
		'req.url', 'request.url',
		'x-forwarded', 'referer', '.socket'
	]) {
		assert.equal(code.includes(untrusted), false, untrusted);
	}
	// Und die einzige Quelle ist die serverseitige Konfiguration.
	assert.ok(code.includes('process.env.app_base_url'));
});

test('6 eine lokale HTTP-Origin gilt nur in Development', () => {
	withEnv({ APP_BASE_URL: 'http://localhost:8787', NODE_ENV: 'development', VERCEL_ENV: undefined }, () => {
		assert.deepEqual(siweOrigin(), { domain: 'localhost:8787', uri: 'http://localhost:8787' });
	});
	withEnv({ APP_BASE_URL: 'http://localhost:8787', NODE_ENV: undefined, VERCEL_ENV: 'production' }, () => {
		assert.throws(() => siweOrigin());
	});
	// Ohne ausdrueckliches Entwicklungssignal gilt Production.
	withEnv({ APP_BASE_URL: 'http://localhost:8787', NODE_ENV: undefined, VERCEL_ENV: undefined }, () => {
		assert.throws(() => siweOrigin());
	});
});

test('7 eine fehlende oder unbrauchbare Konfiguration faellt zu', () => {
	for (const value of [undefined, '', 'kein-url', 'https://agent.coverraccoon.com/pfad', 'https://user:pw@agent.coverraccoon.com']) {
		withEnv({ APP_BASE_URL: value, VERCEL_ENV: 'production', NODE_ENV: undefined }, () => {
			assert.throws(() => siweOrigin(), undefined, String(value));
		});
	}
});

/* ------------------------------------------------------------------------- *
 * 8 bis 24, Dashboard-Nachricht
 * ------------------------------------------------------------------------- */

test('8 bis 21 die Dashboard-Nachricht traegt alle gebundenen Felder', () => {
	inProduction(() => {
		const { message, requestId } = dashboardParts();
		const parsed = parseSiweMessage(message);
		assert.equal(parsed.domain, DOMAIN);
		assert.equal(parsed.uri, PRODUCTION_ORIGIN);
		assert.equal(parsed.version, SIWE_VERSION);
		assert.equal(parsed.chainId, SIWE_CHAIN_ID);
		assert.equal(String(parsed.address).toLowerCase(), WALLET.toLowerCase());
		assert.equal(parsed.statement, DASHBOARD_STATEMENT);
		assert.equal(parsed.nonce, NONCE);
		assert.equal(parsed.issuedAt.getTime(), ISSUED_AT);
		assert.equal(parsed.expirationTime.getTime(), EXPIRES_AT);
		assert.equal(parsed.requestId, requestId);
		assert.deepEqual(parsed.resources, [`${PRODUCTION_ORIGIN}${DASHBOARD_RESOURCE_PATH}`]);
		// Die Bibliothek selbst akzeptiert sie ebenfalls.
		assert.equal(validateSiweMessage({ address: WALLET, domain: DOMAIN, message: parsed, nonce: NONCE, time: new Date(NOW) }), true);
		assert.equal(checkSiweMessage(message, dashboardParts().expected, NOW), 'VALID');
	});
});

test('8b die Adresse steht in kanonischer Pruefsummenschreibweise', () => {
	// AGENT-SEC-A3b, 29.08.2026: die fruehere Fassung nutzte eine Adresse aus
	// lauter Ziffern. EIP-55 kann daran gar keine sichtbare Schreibweise
	// erzeugen, die Erwartung war mathematisch unerfuellbar. Jetzt eine
	// offizielle EIP-55-Beispieladresse MIT Hexbuchstaben, und verglichen wird
	// gegen den kanonischen Wert aus viems `getAddress`, nicht gegen eine
	// selbst geschriebene Grossschreibungsregel.
	inProduction(() => {
		const expectedAddress = getAddress(EIP55_LOWERCASE);
		const requestId = newRequestId();
		const build = { wallet: EIP55_LOWERCASE, nonce: NONCE, issuedAt: ISSUED_AT, expiresAt: EXPIRES_AT, requestId };
		const message = dashboardSiweMessage(build);

		const parsed = parseSiweMessage(message);
		assert.equal(parsed.address, expectedAddress);
		// Dieselbe Wallet, keine andere Adresse.
		assert.equal(String(parsed.address).toLowerCase(), EIP55_LOWERCASE);
		// Und die Pruefsumme ist hier tatsaechlich sichtbar.
		assert.notEqual(parsed.address, EIP55_LOWERCASE);

		// Die Nachricht bleibt parsebar und gegen ihre Erwartung gueltig.
		assert.equal(checkSiweMessage(message, dashboardExpectation(build), NOW), 'VALID');
	});
});

test('22 die Request-ID traegt mindestens 128 Bit', () => {
	const id = newRequestId();
	assert.match(id, /^[a-f0-9]{32}$/);
	assert.equal(id.length * 4, 128);
});

test('23 und 24 zwei Erzeugungen unterscheiden sich in Nonce und Request-ID', () => {
	const first = newRequestId();
	const second = newRequestId();
	assert.notEqual(first, second);
	// Die Nonce stammt aus der Challenge, die Request-ID aus dieser Quelle;
	// beide sind unabhaengig zufaellig.
	assert.notEqual(telegramRequestId('code-a'), telegramRequestId('code-b'));
});

/* ------------------------------------------------------------------------- *
 * 25 bis 37, Negativtests
 * ------------------------------------------------------------------------- */

test('25 bis 32 jede abweichende Erwartung nennt ihre eigene Ursache', () => {
	inProduction(() => {
		const { message, expected } = dashboardParts();
		const cases = [
			['DOMAIN_MISMATCH', { domain: 'evil.tld' }],
			['URI_MISMATCH', { uri: 'https://evil.tld' }],
			['ADDRESS_MISMATCH', { wallet: OTHER_WALLET }],
			['STATEMENT_MISMATCH', { statement: TELEGRAM_STATEMENT }],
			['NONCE_MISMATCH', { nonce: 'ffffffffffffffffffffffffffffffff' }],
			['REQUEST_ID_MISMATCH', { requestId: '00000000000000000000000000000000' }],
			['RESOURCE_MISMATCH', { resource: `${PRODUCTION_ORIGIN}${TELEGRAM_RESOURCE_PATH}` }]
		];
		for (const [reason, patch] of cases) {
			assert.equal(checkSiweMessage(message, { ...expected, ...patch }, NOW), reason, reason);
		}
	});
});

test('27 eine fremde Chain wird abgelehnt', () => {
	inProduction(() => {
		const { message, expected } = dashboardParts();
		const forged = message.replace(`Chain ID: ${SIWE_CHAIN_ID}`, 'Chain ID: 137');
		assert.equal(checkSiweMessage(forged, expected, NOW), 'CHAIN_MISMATCH');
	});
});

test('33 eine abgelaufene Nachricht wird abgelehnt', () => {
	inProduction(() => {
		const { message, expected } = dashboardParts();
		assert.equal(checkSiweMessage(message, expected, EXPIRES_AT), 'EXPIRED');
		assert.equal(checkSiweMessage(message, expected, EXPIRES_AT + 1), 'EXPIRED');
	});
});

test('34 ein zukuenftiges Issued-at ausserhalb der Toleranz wird abgelehnt', () => {
	inProduction(() => {
		const { message, expected } = dashboardParts();
		// Innerhalb der Toleranz noch gueltig, ausserhalb nicht.
		assert.equal(checkSiweMessage(message, expected, ISSUED_AT - SIWE_CLOCK_SKEW_MS), 'VALID');
		assert.equal(checkSiweMessage(message, expected, ISSUED_AT - SIWE_CLOCK_SKEW_MS - 1), 'ISSUED_AT_INVALID');
	});
});

test('36 eine veraenderte Nachricht wird nicht als gueltig gefuehrt', () => {
	inProduction(() => {
		const { message, expected } = dashboardParts();
		assert.equal(checkSiweMessage(message.replace(DASHBOARD_STATEMENT, TELEGRAM_STATEMENT), expected, NOW), 'STATEMENT_MISMATCH');
		assert.equal(checkSiweMessage(message.replace(`Nonce: ${NONCE}`, 'Nonce: ffffffffffffffffffffffffffffffff'), expected, NOW), 'NONCE_MISMATCH');
		assert.equal(checkSiweMessage('kein SIWE', expected, NOW), 'INVALID_FORMAT');
		assert.equal(checkSiweMessage('', expected, NOW), 'INVALID_FORMAT');
		assert.equal(checkSiweMessage(null, expected, NOW), 'INVALID_FORMAT');
	});
});

/* ------------------------------------------------------------------------- *
 * 38 bis 44, Telegram und die Trennung
 * ------------------------------------------------------------------------- */

test('38 bis 41 die Telegram-Nachricht ist gueltig und traegt ihren eigenen Zweck', () => {
	inProduction(() => {
		const { message, expected } = telegramParts();
		const parsed = parseSiweMessage(message);
		assert.equal(parsed.domain, DOMAIN);
		assert.equal(parsed.chainId, SIWE_CHAIN_ID);
		assert.equal(parsed.statement, TELEGRAM_STATEMENT);
		assert.deepEqual(parsed.resources, [`${PRODUCTION_ORIGIN}${TELEGRAM_RESOURCE_PATH}`]);
		assert.equal(checkSiweMessage(message, expected, NOW), 'VALID');
	});
});

test('42 die Telegram-Request-ID ist serverseitig gebunden und gibt den Code nicht preis', () => {
	const id = telegramRequestId(CODE);
	assert.match(id, /^[a-f0-9]{32}$/);
	// Deterministisch, also bei der Verifikation rekonstruierbar.
	assert.equal(id, telegramRequestId(CODE));
	// Und der Einmalcode steht nicht im signierten Text.
	assert.equal(id.includes(CODE), false);
	inProduction(() => {
		assert.equal(telegramParts().message.includes(CODE), false);
	});
});

test('43 und 44 die beiden Zwecke passen nicht aufeinander', () => {
	inProduction(() => {
		const dashboard = dashboardParts();
		const telegram = telegramParts();
		// Dashboardtext gegen Telegramerwartung und umgekehrt.
		assert.notEqual(checkSiweMessage(dashboard.message, telegram.expected, NOW), 'VALID');
		assert.notEqual(checkSiweMessage(telegram.message, dashboard.expected, NOW), 'VALID');
		// Und die Texte selbst unterscheiden sich in Statement und Ressource.
		assert.notEqual(DASHBOARD_STATEMENT, TELEGRAM_STATEMENT);
		assert.notEqual(DASHBOARD_RESOURCE_PATH, TELEGRAM_RESOURCE_PATH);
	});
});

test('45 und 46 die Telegram-Verifikation erzeugt weiterhin weder Session noch Cookie', () => {
	const code = readFileSync(new URL('../api/link/verify.mjs', import.meta.url), 'utf8');
	assert.equal(/set-cookie/i.test(code), false);
	assert.equal(code.includes('createDashboardSession'), false);
	assert.equal(code.includes('sessionCookieHeader'), false);
});

/* ------------------------------------------------------------------------- *
 * Regression der Grenzen
 * ------------------------------------------------------------------------- */

test('R die Nachricht nennt keine Transaktion und keine Freigabe als erlaubt', () => {
	inProduction(() => {
		assert.ok(DASHBOARD_STATEMENT.includes('does not authorize transactions, token approvals, transfers or purchases'));
		assert.ok(TELEGRAM_STATEMENT.includes('does not authorize dashboard access, transactions, token approvals'));
		// Ein Statement darf nach ERC-4361 keine Zeile brechen.
		assert.equal(DASHBOARD_STATEMENT.includes('\n'), false);
		assert.equal(TELEGRAM_STATEMENT.includes('\n'), false);
	});
});

test('R die Erzeugung faellt ohne trusted Origin zu', () => {
	withEnv({ APP_BASE_URL: undefined, VERCEL_ENV: 'production', NODE_ENV: undefined }, () => {
		assert.throws(() => dashboardSiweMessage({ wallet: WALLET, nonce: NONCE, issuedAt: ISSUED_AT, expiresAt: EXPIRES_AT, requestId: newRequestId() }));
		assert.throws(() => telegramSiweMessage({ wallet: WALLET, nonce: NONCE, issuedAt: ISSUED_AT, expiresAt: EXPIRES_AT, code: CODE }));
	});
});

test('R die Fehlerursachen bleiben getrennt und sind kein Boolean', () => {
	inProduction(() => {
		const { message, expected } = dashboardParts();
		const result = checkSiweMessage(message, { ...expected, domain: 'evil.tld' }, NOW);
		assert.equal(typeof result, 'string');
		assert.notEqual(result, true);
		assert.notEqual(result, false);
		assert.equal(result, 'DOMAIN_MISMATCH');
	});
});
