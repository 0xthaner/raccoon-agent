/**
 * CRSF-Mutationskatalog: jeder Anker trifft genau einmal (22.10.2026).
 *
 * Anlass: Uniswap (070693b) brachte im Quote-Handler eine zweite, wortgleiche
 * Zeile fuer das globale Quote-Budget. Der Anker von
 * MUT-CR-QUOTE-008-P1-QTGLOBALRATE (Aave-Pfad) traf damit zweimal, der Fall
 * wurde INVALID und das Framework ungueltig - sichtbar erst im teuren
 * security:verify-Lauf. Diese Tests pruefen dasselbe mit dem echten Executor
 * (applyEdits) sofort in test:ci:
 *
 * 1. jeder Fall des Katalogs laesst sich anwenden (jeder Anker genau einmal),
 * 2. die beiden Quote-Global-Faelle treffen je genau ihre eigene Zeile:
 *    Aave entfernt nur die Begrenzung vor `quote(`, Uniswap nur die vor
 *    `uniswapQuote(`; die jeweils andere bleibt stehen.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applyEdits } from '../security/crsf/lib/exec.mjs';

const cases = JSON.parse(readFileSync('security/mutation/cases.json', 'utf8')).cases;
const QUOTE = 'api/nexus/quote.mjs';
const GLOBAL_LIMIT = "\t\tif (!await rateLimitFor(response, 'nexus-quote-global', 'all', ...LIMITS.quoteGlobal)) return;\n";

/** Kopiert die genannten Repository-Dateien in einen Wegwerfordner. */
function copyOf(files) {
	const dir = mkdtempSync(path.join(tmpdir(), 'crsf-anchor-'));
	for (const file of files) {
		mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
		copyFileSync(file, path.join(dir, file));
	}
	return dir;
}

function mutated(id) {
	const c = cases.find((x) => x.id === id);
	assert.ok(c, `${id} not in cases.json`);
	const dir = copyOf([...new Set(c.edits.map((e) => e.file))]);
	try {
		const restore = applyEdits(dir, c.edits);
		const text = readFileSync(path.join(dir, QUOTE), 'utf8');
		restore();
		assert.equal(readFileSync(path.join(dir, QUOTE), 'utf8'), readFileSync(QUOTE, 'utf8'), 'restore brings back the original');
		return { c, text };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const limitBefore = (text, call) => text.includes(`${GLOBAL_LIMIT}\t\tconst result = await ${call}(`);

test('CRSF-ANCHOR every mutation case of the catalogue applies: each anchor occurs exactly once', () => {
	const files = [...new Set(cases.flatMap((c) => c.edits.map((e) => e.file)))];
	const dir = copyOf(files);
	try {
		const invalid = [];
		for (const c of cases) {
			try { applyEdits(dir, c.edits)(); } catch (error) { invalid.push(`${c.id}: ${error.message}`); }
		}
		assert.deepEqual(invalid, []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('CRSF-ANCHOR the quote handler has exactly two global quote limiters: one before quote(, one before uniswapQuote(', () => {
	const source = readFileSync(QUOTE, 'utf8');
	assert.equal(source.split(GLOBAL_LIMIT).length - 1, 2);
	assert.ok(limitBefore(source, 'quote'));
	assert.ok(limitBefore(source, 'uniswapQuote'));
});

test('CRSF-ANCHOR MUT-CR-QUOTE-008-P1-QTGLOBALRATE removes only the Aave global quote limiter', () => {
	const { c, text } = mutated('MUT-CR-QUOTE-008-P1-QTGLOBALRATE');
	assert.equal(c.expected_result, 'KILLED');
	assert.equal(text.split(GLOBAL_LIMIT).length - 1, 1);
	assert.equal(limitBefore(text, 'quote'), false, 'Aave limiter still present');
	assert.equal(limitBefore(text, 'uniswapQuote'), true, 'Uniswap limiter was touched');
});

test('CRSF-ANCHOR MUT-CR-QUOTE-008-P1-UNIGLOBALRATE removes only the Uniswap global quote limiter', () => {
	const { c, text } = mutated('MUT-CR-QUOTE-008-P1-UNIGLOBALRATE');
	assert.equal(c.expected_result, 'KILLED');
	assert.equal(text.split(GLOBAL_LIMIT).length - 1, 1);
	assert.equal(limitBefore(text, 'uniswapQuote'), false, 'Uniswap limiter still present');
	assert.equal(limitBefore(text, 'quote'), true, 'Aave limiter was touched');
});

test('CRSF-ANCHOR the Aave and Uniswap quote-global cases target distinct lines', () => {
	const aave = mutated('MUT-CR-QUOTE-008-P1-QTGLOBALRATE').text;
	const uni = mutated('MUT-CR-QUOTE-008-P1-UNIGLOBALRATE').text;
	assert.notEqual(aave, uni);
});
