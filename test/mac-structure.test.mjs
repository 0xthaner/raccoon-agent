/**
 * Strukturpruefung MAC-Primitive (CRSF Phase 2D, CR-SESSION-001 P2/P3, profile.structural_property_rule).
 *
 * QUELLTEXT-Pruefung, bewusst als solche gekennzeichnet (Evidenzstufe E1,
 * "structurally verified", nicht im Verhalten mutationsgeprueft). Sie haelt die
 * in security/crsf/evidence.json eingetragene Aufrufstelle (Datei:Zeile) an den
 * Code: steht dort nicht mehr das genannte Primitiv aus node:crypto, mit festem
 * Algorithmus und Server-Schluessel, scheitert sie - der Eintrag kann nicht
 * still veralten.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const evidence = JSON.parse(readFileSync(new URL('../security/crsf/evidence.json', import.meta.url), 'utf8')).evidence;
const structural = evidence.filter((e) => e.structural);
const lineAt = (site) => { const [file, n] = site.split(':'); return readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').split('\n')[Number(n) - 1] ?? ''; };
const SOURCE = readFileSync(new URL('../src/dashboard-auth.mjs', import.meta.url), 'utf8');
const body = (name) => { const start = SOURCE.indexOf(`function ${name}(`); return SOURCE.slice(start, SOURCE.indexOf('\n}\n', start)); };

test('MAC-STRUCTURE: both primitives are imported from the Node standard library, not re-implemented or wrapped', () => {
	assert.match(SOURCE, /^import \{[^}]*\bcreateHmac\b[^}]*\btimingSafeEqual\b[^}]*\} from 'node:crypto';$/m);
	assert.doesNotMatch(SOURCE, /function (createHmac|timingSafeEqual)\b|(const|let) (createHmac|timingSafeEqual)\b/);
});

test('MAC-STRUCTURE: the recorded call sites still hold the recorded primitives', () => {
	assert.deepEqual(structural.map((e) => e.id).sort(), ['EV-STRUCT-MAC-ALG', 'EV-STRUCT-MAC-CMP'], 'exactly these structural evidence items exist');
	for (const { id, structural: s } of structural) {
		const line = lineAt(s.call_site);
		assert.ok(line.includes(s.primitive_call), `${id}: ${s.call_site} must contain "${s.primitive_call}", found: ${line.trim()}`);
		assert.ok(s.primitive.startsWith('node:crypto.'), `${id}: standard-library primitive`);
	}
});

test('MAC-STRUCTURE P3: sign() uses the literal algorithm sha256 and the server secret only', () => {
	const sign = body('sign');
	assert.match(sign, /createHmac\('sha256', secret\(\)\)/);
	assert.doesNotMatch(sign, /payload\)?\.(alg|kid|key)|JSON\.parse/, 'nothing from the token selects algorithm or key');
	assert.equal((SOURCE.match(/createHmac\(/g) ?? []).length, 1, 'a single HMAC construction in the module');
});

test('MAC-STRUCTURE P2: verifyDashboardToken compares MAC bytes only via timingSafeEqual (no ===, equals or compare on the MAC)', () => {
	const verify = body('verifyDashboardToken');
	assert.match(verify, /actual\.length !== expected\.length \|\| !timingSafeEqual\(actual, expected\)/);
	assert.doesNotMatch(verify, /received\s*===|===\s*received|expected\s*===|===\s*expected|\.equals\(|Buffer\.compare|sign\(payload\)\s*===|===\s*sign\(payload\)/);
});
