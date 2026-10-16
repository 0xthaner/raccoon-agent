/**
 * AGENT-HARD-001: Schranken gegen unauth. Alchemy-Kosten-Amplifikation.
 *
 * Deterministisch und offline, wie link-code-rate-limit.test.mjs: `src/db.mjs`
 * zieht beim Import Supabase-Zugangsdaten und laesst sich hier nicht laden.
 * Geprueft wird deshalb die Form der Grenze - dass es sie gibt, woran sie
 * haengt und an welcher Stelle sie greift. Das Zaehlen erledigt
 * `check_agent_rate_limit` in der Datenbank.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const dashboard = readFileSync('api/dashboard.mjs', 'utf8');

test('1 Challenge-Erzeugung begrenzt pro IP UND pro Wallet', () => {
	assert.match(dashboard, /enforceRateLimit\(request, response, 'dashboard-challenge', \d+, \d+\)/);
	assert.match(dashboard, /enforceRateLimitFor\(response, 'dashboard-challenge-wallet', wallet\.toLowerCase\(\), \d+, \d+\)/);
});

test('2 die Wallet-Schranke greift VOR dem Alchemy-getCode und dem DB-Insert', () => {
	const schranke = dashboard.indexOf("enforceRateLimitFor(response, 'dashboard-challenge-wallet'");
	const getCode = dashboard.indexOf('isDeployedContract(wallet)');
	const insert = dashboard.indexOf('storeDashboardChallenge(');
	assert.ok(schranke > -1 && getCode > -1 && insert > -1);
	assert.ok(schranke < getCode, 'die Schranke steht hinter dem getCode-Aufruf');
	assert.ok(schranke < insert, 'die Schranke steht hinter dem DB-Insert');
});

test('3 nur gueltige Adressen erreichen die Challenge-Wallet-Schranke', () => {
	const addrCheck = dashboard.indexOf("if (!isAddress(wallet)) return response.status(400)");
	const schranke = dashboard.indexOf("enforceRateLimitFor(response, 'dashboard-challenge-wallet'");
	assert.ok(addrCheck > -1, 'die Adresspruefung fehlt');
	assert.ok(addrCheck < schranke, 'malformed Strings koennten sonst Limiter-Keys erzeugen');
});

test('4 Login-Verifikation begrenzt pro IP UND pro Wallet', () => {
	assert.match(dashboard, /enforceRateLimit\(request, response, 'dashboard-login', \d+, \d+\)/);
	assert.match(dashboard, /enforceRateLimitFor\(response, 'dashboard-login-wallet', wallet\.toLowerCase\(\), \d+, \d+\)/);
});

test('5 die Login-Wallet-Schranke greift VOR der teuren Signatur-/ERC-1271-Pruefung', () => {
	const schranke = dashboard.indexOf("enforceRateLimitFor(response, 'dashboard-login-wallet'");
	// Die Login-Pruefung (nicht die spaetere frische Bestaetigung, AUDIT SA-L1).
	const verify = dashboard.indexOf('const { result: verified, authority } = await verifyWalletSiweAuthority({');
	assert.ok(schranke > -1 && verify > -1);
	assert.ok(schranke < verify, 'die Schranke steht hinter der Signaturpruefung');
});

test('6 die Login-Wallet-Schranke steht NACH der billigen Strukturpruefung', () => {
	// Nur challenge-gebundene, gueltige Adressen duerfen den Wallet-Key erreichen.
	const struktur = dashboard.indexOf('challenge.wallet !== wallet.toLowerCase()');
	const schranke = dashboard.indexOf("enforceRateLimitFor(response, 'dashboard-login-wallet'");
	assert.ok(struktur > -1 && schranke > -1);
	assert.ok(struktur < schranke, 'die Strukturpruefung muss vor der Schranke stehen');
});

test('7 die Wallet-Schranken sind nicht weiter als die IP-Schranken', () => {
	const chalIp = /enforceRateLimit\(request, response, 'dashboard-challenge', (\d+), (\d+)\)/.exec(dashboard);
	const chalWallet = /enforceRateLimitFor\(response, 'dashboard-challenge-wallet', wallet\.toLowerCase\(\), (\d+), (\d+)\)/.exec(dashboard);
	const loginIp = /enforceRateLimit\(request, response, 'dashboard-login', (\d+), (\d+)\)/.exec(dashboard);
	const loginWallet = /enforceRateLimitFor\(response, 'dashboard-login-wallet', wallet\.toLowerCase\(\), (\d+), (\d+)\)/.exec(dashboard);
	assert.ok(chalIp && chalWallet && loginIp && loginWallet);
	assert.ok(Number(chalWallet[1]) <= Number(chalIp[1]), 'Challenge: pro Wallet nicht mehr als pro IP');
	assert.ok(Number(loginWallet[1]) <= Number(loginIp[1]), 'Login: pro Wallet nicht mehr als pro IP');
});

test('8 die Wallet-Schranken verwenden die gemeinsame Infrastruktur, keinen Ad-hoc-Limiter', () => {
	// enforceRateLimitFor ist DB-gestuetzt und faellt ohne Secret zu (fail closed).
	assert.match(dashboard, /enforceRateLimitFor,/);
	// Kein eigener In-Memory-Zaehler fuer Wallet-Limits. Restaudit M2: die einzigen Maps
	// sind der Cover-Cache und die laufenden Abfragen (Optimierung je Instanz) - kein
	// Zaehler, keine Grenze. Die Lese-Budgets laufen ueber enforceRateLimitFor.
	assert.deepEqual([...dashboard.matchAll(/const (\w+) = new Map\(\)/g)].map((m) => m[1]), ['coverCache', 'coverLookups']);
	assert.equal(/(coverCache|coverLookups)\.set\([^;]*\+\s*1/.test(dashboard), false, 'keine Map als Zaehler');
	for (const scope of ['dashboard-read-wallet', 'dashboard-read-global']) assert.match(dashboard, new RegExp(`enforceRateLimitFor\\(response, '${scope}'`));
});
