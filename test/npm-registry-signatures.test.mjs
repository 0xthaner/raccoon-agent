/**
 * CRSF Phase 2S, CR-VERIFY-003 - historische Korrektur b706956
 * ("Registry-Signaturen pruefen": `npm audit signatures` in der check-Kette).
 *
 * Invariante: check:ci prueft die npm-Registry-Signaturen der installierten
 * Abhaengigkeiten und schlaegt bei einer ungueltigen Signatur fehl.
 *
 * Geprueft mit dem ECHTEN npm und dem ECHTEN Pruefpfad, ohne npm zu veraendern:
 * - Vertrauensanker: npm aktualisiert die Sigstore-TUF-Metadaten online
 *   (tuf-repo-cdn.sigstore.dev) und holt die Registry-Schluessel als TUF-Ziel
 *   registry.npmjs.org/keys.json; pacote prueft jede dist.signatures gegen
 *   "<name>@<version>:<dist.integrity>" mit diesen Schluesseln.
 * 1. Positivprobe: `npm run check:ci` mit leerem Wegwerf-Cache gegen die echte
 *    Registry - muss durchlaufen, ohne ungueltige Signatur.
 * 2. Gegenprobe: derselbe Cache, prefer-offline - laeuft ebenfalls durch (der
 *    Cache-Pfad selbst macht nichts kaputt).
 * 3. Bekannt-falsch: im Wegwerf-Cache wird fuer EIN installiertes Paket nur
 *    dist.integrity veraendert (ein manipulierter Tarball-Hash; eine direkte
 *    Abhaengigkeit, damit es in jedem node_modules-Layout geprueft wird); die echte
 *    Registry-Signatur bleibt. prefer-offline liest diese Metadaten, der TUF-
 *    Abgleich laeuft trotzdem online. check:ci MUSS mit "invalid registry
 *    signature" fuer genau dieses Paket fehlschlagen.
 * Netz: nur tuf-repo-cdn.sigstore.dev und registry.npmjs.org, nur lesend
 * (test-support/npm-network-boundary.mjs lehnt alles andere ab und protokolliert
 * es); keine Anmeldung (leere Nutzer- und globale npmrc), nichts wird
 * veroeffentlicht oder in der Registry veraendert.
 *
 * Nur mit CRSF_NETWORK_EVIDENCE=1 (ausdrueckliche Freigabe fuer Netz-Evidenz);
 * sonst erlaubter Skip (scripts/skip-policy.mjs), in security:verify NOT_RUN.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { ALLOWED_HOSTS } from '../test-support/npm-network-boundary.mjs';

const skip = process.env.CRSF_NETWORK_EVIDENCE === '1' ? false : 'CRSF_NETWORK_EVIDENCE=1 nicht gesetzt (Netz-Evidenz: tuf-repo-cdn.sigstore.dev, registry.npmjs.org)';
const BOUNDARY = fileURLToPath(new URL('../test-support/npm-network-boundary.mjs', import.meta.url));
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/** npm's own bundled cache library (the cache format npm itself reads). */
function npmCacache() {
	const globalRoot = spawnSync(NPM, ['root', '-g'], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', npm_config_update_notifier: 'false' } }).stdout.trim();
	return createRequire(path.join(globalRoot, 'npm', 'package.json'))('cacache');
}

function checkCi(work, cache, { preferOffline }) {
	const log = path.join(work, `net-${Date.now()}-${Math.random().toString(16).slice(2)}.log`);
	writeFileSync(log, '');
	const env = {
		PATH: process.env.PATH ?? '', HOME: work, TMPDIR: process.env.TMPDIR ?? tmpdir(), LANG: 'C.UTF-8',
		NODE_OPTIONS: `--import ${BOUNDARY}`, CRSF_NET_LOG: log,
		npm_config_cache: cache, npm_config_userconfig: path.join(work, 'no-user-npmrc'), npm_config_globalconfig: path.join(work, 'no-global-npmrc'),
		npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false',
		...(preferOffline ? { npm_config_prefer_offline: 'true' } : {})
	};
	const r = spawnSync(NPM, ['run', 'check:ci'], { encoding: 'utf8', env, timeout: 280_000 });
	const hosts = readFileSync(log, 'utf8').split('\n').filter(Boolean);
	return { status: r.status, output: `${r.stdout}${r.stderr}`, hosts };
}

const deniedOrUnexpected = (hosts) => hosts.filter((h) => !h.startsWith('ALLOW ') || !ALLOWED_HOSTS.includes(h.slice(6).replace(/:\d+$/, '')));

test('NPM-SIGNATURES b706956 check:ci verifies registry signatures with the real npm and fails on a tampered package', { skip, timeout: 900_000 }, async () => {
	const work = mkdtempSync(path.join(tmpdir(), 'crsf-npmsig-'));
	try {
		const cache = path.join(work, 'cache');
		// 1. real registry, real TUF, fresh cache
		const positive = checkCi(work, cache, { preferOffline: false });
		assert.equal(positive.status, 0, `positive control: check:ci failed against the real registry: ${positive.output.slice(-800)}`);
		assert.match(positive.output, /\d+ packages? ha(s|ve) verified registry signatures?/, 'check:ci verified no registry signature (the signature check is not part of the chain)');
		assert.doesNotMatch(positive.output, /invalid registry signature/);
		assert.ok(positive.hosts.some((h) => h.startsWith('ALLOW tuf-repo-cdn.sigstore.dev')), 'positive control: the Sigstore TUF trust root was not contacted');
		assert.deepEqual(deniedOrUnexpected(positive.hosts), [], 'unexpected network access');

		// 2. same cache, prefer-offline, untouched: still passes
		const offline = checkCi(work, cache, { preferOffline: true });
		assert.equal(offline.status, 0, `control (cached, untouched) failed: ${offline.output.slice(-800)}`);

		// 3. tamper exactly one installed DIRECT dependency's dist.integrity in the disposable cache
		//    (direct: npm audits it in every layout, also with a symlinked node_modules in the mutation sandbox)
		const name = '@vercel/analytics';
		assert.ok(JSON.parse(readFileSync('package.json', 'utf8')).dependencies[name], `${name} is no longer a direct dependency`);
		const version = JSON.parse(readFileSync(`node_modules/${name}/package.json`, 'utf8')).version;
		const bad = path.join(work, 'cache-tampered');
		cpSync(cache, bad, { recursive: true });
		const cacache = npmCacache();
		const key = `make-fetch-happen:request-cache:https://registry.npmjs.org/${name.replace('/', '%2f')}`;
		const store = path.join(bad, '_cacache');
		const info = await cacache.get.info(store, key);
		assert.ok(info, `the packument of ${name} is not in the cache`);
		const packument = JSON.parse((await cacache.get(store, key)).data.toString('utf8'));
		const dist = packument.versions[version].dist;
		assert.ok(dist.signatures?.length, `${name}@${version} carries no registry signature`);
		dist.integrity = `sha512-${createHash('sha512').update('crsf tampered tarball').digest('base64')}`;
		await cacache.put(store, key, Buffer.from(JSON.stringify(packument)), { metadata: info.metadata });

		const tampered = checkCi(work, bad, { preferOffline: true });
		assert.notEqual(tampered.status, 0, `check:ci accepted a package whose registry signature no longer matches: ${tampered.output.slice(-800)}`);
		assert.match(tampered.output, /1 package has an invalid registry signature/);
		assert.ok(tampered.output.includes(`${name}@${version} (https://registry.npmjs.org/)`), `the tampered package was not named: ${tampered.output.slice(-600)}`);
		assert.ok(tampered.hosts.some((h) => h.startsWith('ALLOW tuf-repo-cdn.sigstore.dev')), 'known-bad run: the real TUF trust root was not refreshed online');
		assert.deepEqual(deniedOrUnexpected(tampered.hosts), [], 'unexpected network access');
		for (const r of [positive, offline, tampered]) assert.doesNotMatch(r.output, /ENEEDAUTH|E401|authToken/i, 'npm asked for credentials');
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
});
