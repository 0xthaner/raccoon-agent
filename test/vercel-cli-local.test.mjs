/**
 * CRSF Phase 2R, CR-VERIFY-003: historische Korrekturen, deren Wirkung die
 * Vercel-CLI entscheidet - geprueft mit der ECHTEN installierten CLI, lokal,
 * ohne Deployment und ohne Kontakt zu Vercel oder npm (test-support/vercel-cli-local.mjs).
 *
 * cad24d4 (.vercelignore): `vercel deploy` darf lokale Geheimnisdateien (.env,
 *   .env.*) nicht hochladen; .env.example bleibt. Die echte CLI berechnet die
 *   Upload-Liste und meldet sie dem (lokalen, ablehnenden) API-Server. Gegenprobe
 *   ohne .vercelignore: dieselbe CLI wuerde .env und .env.production hochladen -
 *   die Probe ist nicht taub, und die CLI-Voreinstellung schuetzt nicht.
 *
 * b647281 (installCommand npm ci): `vercel build` fuehrt das installCommand aus
 *   der echten vercel.json aus, und das erzwingt das Lockfile - ein Lockfile, das
 *   nicht zur package.json passt, bricht den Build ab und bleibt unveraendert.
 *   Gegenprobe mit passendem Lockfile: derselbe Build laeuft durch.
 *
 * Nicht bewiesen: das Verhalten der Vercel-Build-Plattform selbst (sie fuehrt
 * dieselbe CLI-Logik aus, aber das ist hier nicht beobachtbar), Vercels zweiter
 * Installationslauf fuer Funktionen (abgedeckt durch die .npmrc, 51c0cd4).
 *
 * Ohne installierte Vercel-CLI werden beide Tests uebersprungen (erlaubter Skip,
 * scripts/skip-policy.mjs; in security:verify NOT_RUN, nie PASS).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startVercelWorld, vercelCliVersion } from '../test-support/vercel-cli-local.mjs';

const version = vercelCliVersion();
const skip = version ? false : 'Vercel CLI nicht installiert (npm i -g vercel) - echte CLI noetig';

function fixture(prefix) {
	const dir = mkdtempSync(path.join(tmpdir(), prefix));
	mkdirSync(path.join(dir, '.vercel'));
	writeFileSync(path.join(dir, '.vercel/project.json'), JSON.stringify({ orgId: 'crsf-user', projectId: 'prj_crsf', settings: { framework: null, installCommand: null, buildCommand: null, outputDirectory: null, rootDirectory: null, devCommand: null, nodeVersion: '24.x' } }));
	return dir;
}

const SECRET_FILES = ['.env', '.env.production', '.env.preview', '.env.development', '.env.local', 'api/.env'];

async function uploadSet(withProjectIgnore) {
	const world = await startVercelWorld();
	const dir = fixture('crsf-vercel-upload-');
	try {
		if (withProjectIgnore) copyFileSync('.vercelignore', path.join(dir, '.vercelignore'));
		mkdirSync(path.join(dir, 'api'));
		for (const f of SECRET_FILES) writeFileSync(path.join(dir, f), 'SEEDED_SECRET=crsf-not-a-real-secret\n');
		writeFileSync(path.join(dir, '.env.example'), 'SEEDED_SECRET=\n');
		writeFileSync(path.join(dir, 'index.html'), '<p>crsf</p>\n');
		const run = await world.run(['deploy', '--yes', '--non-interactive'], dir);
		return { run, files: world.deployments[0] ?? null, requests: [...world.requests], outbound: [...world.outbound] };
	} finally {
		world.close();
		rmSync(dir, { recursive: true, force: true });
	}
}

test('VERCEL-CLI cad24d4 the real CLI upload set excludes .env and .env.* (except .env.example)', { skip, timeout: 300_000 }, async () => {
	const control = await uploadSet(false);
	assert.ok(Array.isArray(control.files), `control: the CLI reported no upload set: ${control.run.output.slice(-400)}`);
	assert.ok(control.files.includes('.env') && control.files.includes('.env.production'), `control without .vercelignore would not upload .env (probe deaf?): ${control.files}`);

	const guarded = await uploadSet(true);
	assert.ok(Array.isArray(guarded.files), `the CLI reported no upload set: ${guarded.run.output.slice(-400)}`);
	const leaked = guarded.files.filter((f) => /(^|\/)\.env(\.|$)/.test(f) && f !== '.env.example');
	assert.deepEqual(leaked, [], `the real Vercel CLI (${version}) would upload secret files`);
	assert.ok(guarded.files.includes('.env.example') && guarded.files.includes('index.html'), `expected files missing from the upload set: ${guarded.files}`);
	for (const r of [control, guarded]) {
		assert.notEqual(r.run.code, 0, 'the fake API refuses every deployment');
		assert.deepEqual(r.outbound, [], 'the CLI tried to reach the network');
		assert.ok(r.requests.every((q) => !/^POST \/v\d+\/files/.test(q)), 'no file was uploaded');
	}
});

async function build(vercelJson, inSync) {
	const world = await startVercelWorld();
	const dir = fixture('crsf-vercel-build-');
	try {
		writeFileSync(path.join(dir, 'vercel.json'), vercelJson);
		mkdirSync(path.join(dir, 'crsf-local'));
		writeFileSync(path.join(dir, 'crsf-local/package.json'), JSON.stringify({ name: 'crsf-local', version: '1.0.0' }));
		// build:web ist der buildCommand der echten vercel.json; hier ein lokaler Ersatz ohne Netz.
		writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'crsf-vbuild', version: '1.0.0', private: true, dependencies: { 'crsf-local': 'file:crsf-local' },
			scripts: { 'build:web': "node -e \"require('fs').mkdirSync('dist-web',{recursive:true});require('fs').writeFileSync('dist-web/index.html','<p>ok</p>')\"" } }));
		const root = { name: 'crsf-vbuild', version: '1.0.0' };
		const lock = inSync
			? { ...root, lockfileVersion: 3, requires: true, packages: { '': { ...root, dependencies: { 'crsf-local': 'file:crsf-local' } }, 'crsf-local': { version: '1.0.0' }, 'node_modules/crsf-local': { resolved: 'crsf-local', link: true } } }
			: { ...root, lockfileVersion: 3, requires: true, packages: { '': root } };
		const lockText = JSON.stringify(lock, null, 2);
		writeFileSync(path.join(dir, 'package-lock.json'), lockText);
		const run = await world.run(['build', '--yes'], dir);
		return { run, built: existsSync(path.join(dir, '.vercel/output/static/index.html')), lockUnchanged: readFileSync(path.join(dir, 'package-lock.json'), 'utf8') === lockText, outbound: [...world.outbound] };
	} finally {
		world.close();
		rmSync(dir, { recursive: true, force: true });
	}
}

test('VERCEL-CLI b647281 vercel build runs the installCommand of vercel.json and it refuses a lockfile that does not match', { skip, timeout: 300_000 }, async () => {
	const vercelJson = readFileSync('vercel.json', 'utf8');
	const control = await build(vercelJson, true);
	assert.equal(control.run.code, 0, `control build with a matching lockfile failed: ${control.run.output.slice(-600)}`);
	assert.ok(control.built, 'control build produced no output');

	const drift = await build(vercelJson, false);
	assert.notEqual(drift.run.code, 0, `the real Vercel build (${version}) installed despite a lockfile that does not match package.json: ${drift.run.output.slice(-600)}`);
	assert.ok(!drift.built, 'a build output exists although the install must have failed');
	assert.ok(drift.lockUnchanged, 'the install rewrote package-lock.json instead of enforcing it');
	assert.match(drift.run.output, /npm ci\b/, 'the failing install was not npm ci');
	for (const r of [control, drift]) assert.deepEqual(r.outbound, [], 'the CLI or npm tried to reach the network');
});
