/**
 * Laufzeit-Allowlist (22.10.2026): scripts/check-runtime-stack.mjs.
 *
 * Invariante: das Repository bekommt keine weitere Produktionslaufzeit (PHP,
 * Ruby, Python-Server, Java, Go, nginx/Apache, Nicht-Node-Funktion auf
 * Vercel), ohne dass check:ci scheitert - und Dokumentation oder Woerter, die
 * "php" enthalten, loesen die Pruefung nicht aus. Ausserdem: Node unter der
 * Sicherheitsuntergrenze scheitert.
 *
 * Jede Regel hat eine Gegenprobe; die echte Pruefung laeuft einmal gegen eine
 * Wegwerfkopie mit eingeschleuster PHP-Datei.
 *
 * Die Stack-Fixtures starten die CLI mit --nur-stack: sie pruefen die
 * Allowlist und sollen nicht an der Patchversion des Testrechners scheitern
 * (CI 22.10.2026: setup-node '24' lieferte v24.22.0). Die Untergrenze pruefen
 * eigene Tests mit eingesetzter Version, und der normale Aufruf wird gegen die
 * echte Version des Rechners gegengeprueft. Dass --nur-stack nirgends ausserhalb
 * der Tests benutzt wird, prueft ein eigener Test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { befehlsVerstoesse, pruefeAufruf, pruefeNode, pruefeStack, projektDateien, NODE_UNTERGRENZE } from '../scripts/check-runtime-stack.mjs';

const pruefe = (dateien) => pruefeStack(Object.keys(dateien), (p) => dateien[p]);
const laufzeiten = (funde) => funde.map((f) => f.laufzeit);
const pkg = (scripts, extra = {}) => JSON.stringify({ name: 'x', scripts, ...extra });

const cli = (args, cwd) => spawnSync(process.execPath, ['scripts/check-runtime-stack.mjs', ...args], { cwd, encoding: 'utf8' });
const aufruf = (schalter, version, dateien = {}) => pruefeAufruf(schalter, { version, engines: '24.x', dateien: () => [Object.keys(dateien), (p) => dateien[p]] });

test('RUNTIME-STACK the real repository has no foreign production runtime', () => {
	const r = cli(['--nur-stack']);
	assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('RUNTIME-STACK the normal CLI invocation checks the real Node version of this machine', () => {
	const r = cli([]);
	const unterGrenze = pruefeNode(process.version, '24.x').length > 0;
	assert.match(r.stdout, new RegExp(`Laufzeit: Node ${process.version.replace(/\./g, '\\.')} \\(engines 24\\.x, Untergrenze ${NODE_UNTERGRENZE.replace(/\./g, '\\.')}\\)`));
	assert.equal(r.status, unterGrenze ? 1 : 0, r.stdout + r.stderr);
	if (unterGrenze) assert.match(r.stderr, /liegt unter der Sicherheitsuntergrenze/);
	const nurNode = cli(['--nur-node']);
	assert.match(nurNode.stdout, /Untergrenze/);
	assert.equal(nurNode.status, unterGrenze ? 1 : 0);
});

test('RUNTIME-STACK PHP files, Composer and php.ini are rejected anywhere', () => {
	for (const datei of ['index.php', 'api/x.php', 'web/public/a.phtml', 'tool.phar', 'composer.json', 'sub/composer.lock', 'php.ini', 'etc/php-fpm.conf', 'etc/php-fpm.d/www.conf']) {
		assert.deepEqual(laufzeiten(pruefe({ [datei]: '' })), datei === 'api/x.php' ? ['PHP', 'Vercel'] : ['PHP'], datei);
	}
});

test('RUNTIME-STACK other runtimes are rejected by their manifests', () => {
	const faelle = { 'Gemfile': 'Ruby', 'config.ru': 'Ruby', 'requirements.txt': 'Python', 'pyproject.toml': 'Python', 'pom.xml': 'Java', 'lib/a.jar': 'Java', 'go.mod': 'Go', 'cmd/main.go': 'Go', 'nginx.conf': 'Webserver', 'deploy/site.nginx.conf': 'Webserver', '.htaccess': 'Webserver', 'conf.d/default.conf': 'Webserver' };
	for (const [datei, laufzeit] of Object.entries(faelle)) assert.deepEqual(laufzeiten(pruefe({ [datei]: '' })), [laufzeit], datei);
});

test('RUNTIME-STACK a Vercel function under api/ must be Node', () => {
	assert.deepEqual(laufzeiten(pruefe({ 'api/hook.py': '' })), ['Vercel']);
	assert.deepEqual(laufzeiten(pruefe({ 'api/hook.rb': '' })), ['Vercel']);
	assert.deepEqual(pruefe({ 'api/hook.mjs': '', 'api/link/verify.mjs': '' }), []);
	assert.deepEqual(laufzeiten(pruefe({ 'vercel.json': JSON.stringify({ functions: { 'api/*.php': { runtime: 'vercel-php@0.7.4' } } }) })), ['Vercel']);
	assert.deepEqual(laufzeiten(pruefe({ 'vercel.json': JSON.stringify({ builds: [{ src: 'x', use: '@vercel/python' }] }) })), ['Vercel']);
	assert.deepEqual(pruefe({ 'vercel.json': JSON.stringify({ functions: { 'api/*.mjs': { runtime: '@vercel/node@5', maxDuration: 10 } }, builds: [{ use: '@vercel/static' }] }) }), []);
	assert.deepEqual(laufzeiten(pruefe({ 'package.json': pkg({}, { dependencies: { 'vercel-php': '1' } }) })), ['Vercel']);
});

test('RUNTIME-STACK runtime commands are rejected in every command-bearing file', () => {
	assert.deepEqual(laufzeiten(pruefe({ 'package.json': pkg({ serve: 'php -S localhost:8000' }) })), ['PHP']);
	assert.deepEqual(laufzeiten(pruefe({ 'package.json': pkg({ setup: 'npm ci && composer install' }) })), ['PHP']);
	assert.deepEqual(laufzeiten(pruefe({ 'package.json': pkg({ fpm: 'sudo /usr/sbin/php-fpm8.3 -F' }) })), ['PHP']);
	assert.deepEqual(laufzeiten(pruefe({ 'vercel.json': JSON.stringify({ buildCommand: 'pecl install x; npm run build' }) })), ['PHP']);
	assert.deepEqual(laufzeiten(pruefe({ '.github/workflows/ci.yml': 'jobs:\n  a:\n    steps:\n      - run: sudo apt-get install -y php && php -v\n' })), ['PHP']);
	assert.deepEqual(laufzeiten(pruefe({ 'deploy.sh': 'set -e\nnginx -g "daemon off;"\n' })), ['Webserver']);
	assert.deepEqual(laufzeiten(pruefe({ 'package.json': pkg({ api: 'python3 -m http.server 8080', b: 'gunicorn app:app', c: 'java -jar x.jar', d: 'go build ./cmd/x', e: 'bundle exec rails s' }) })).sort(), ['Go', 'Java', 'Python', 'Python', 'Ruby']);
	assert.deepEqual(laufzeiten(pruefe({ 'src/x.mjs': "import { spawn } from 'node:child_process';\nspawn('php', ['-r', code]);\n" })), ['PHP']);
	assert.deepEqual(laufzeiten(pruefe({ 'Dockerfile': 'FROM php:8.4-fpm\nRUN docker-php-ext-install pdo\n' })), ['Container']);
	assert.deepEqual(laufzeiten(pruefe({ 'Dockerfile': 'FROM node:24\nRUN composer install\nCMD ["nginx", "-g", "daemon off;"]\n' })), ['PHP', 'Webserver']);
	assert.deepEqual(laufzeiten(pruefe({ 'docker-compose.yml': 'services:\n  web:\n    image: nginx:1.31\n' })), ['Container']);
});

test('RUNTIME-STACK no false positives: documentation, words containing "php", developer tooling', () => {
	assert.deepEqual(pruefe({
		'docs/RUNTIME-STACK.md': 'CoverRaccoon has no PHP, no php-fpm, no composer.json and no nginx.conf. Run `php -v` elsewhere.',
		'README.md': 'phpinfo, graphql, Morphology, "php" in prose',
		'package.json': pkg({ test: 'node --test', note: 'echo php composer nginx', lint: 'python3 tools/lint.py', '//doc': 'php -S would be forbidden' }),
		'src/a.mjs': "// spawn('php', ['-v']) explained in a comment\n/* execSync('composer install') */\nconst s = 'php -S';\nconst graphql = 'phpinfo';\nspawn('node', ['x.mjs']);\n",
		'web/src/main.js': "el.textContent = 'composer install';",
		'.github/workflows/ci.yml': '# php -v would be forbidden\n      - run: npm ci --ignore-scripts\n        name: php docs\n',
		'vercel.json': JSON.stringify({ installCommand: 'npm ci --ignore-scripts', buildCommand: 'npm run build:web' }),
		'test/fixtures/usdc/FiatTokenV1.sol': '',
		'supabase/config.toml': '',
		'Dockerfile': 'FROM node:24-alpine\nRUN npm ci\n'
	}), []);
});

test('RUNTIME-STACK Node below the security floor or outside engines fails', () => {
	assert.equal(NODE_UNTERGRENZE, '24.22.1');
	assert.deepEqual(pruefeNode(`v${NODE_UNTERGRENZE}`, '24.x'), []);
	assert.deepEqual(pruefeNode('v24.22.2', '24.x'), []);
	assert.deepEqual(pruefeNode('v24.23.0', '24.x'), []);
	assert.equal(pruefeNode('v24.22.0', '24.x').length, 1);
	assert.equal(pruefeNode('v24.9.9', '24.x').length, 1);
	assert.equal(pruefeNode('v22.23.4', '24.x').length, 1);
	assert.equal(pruefeNode('v26.12.1', '24.x').length, 1);
});

test('RUNTIME-STACK the floor holds in the normal and --nur-node invocation, only --nur-stack skips it', () => {
	for (const schalter of [[], ['--nur-node']]) {
		assert.equal(aufruf(schalter, 'v24.22.0').nodeFunde.length, 1, `24.22.0 ${schalter}`);
		for (const v of ['v24.22.1', 'v24.22.2', 'v24.23.0']) assert.deepEqual(aufruf(schalter, v).nodeFunde, [], `${v} ${schalter}`);
	}
	assert.deepEqual(aufruf(['--nur-stack'], 'v24.22.0').nodeFunde, []);
	assert.equal(aufruf(['--nur-stack'], 'v24.22.0').modus.node, false);
	// Der Stack bleibt in --nur-stack und im normalen Aufruf scharf, --nur-node laesst ihn aus.
	assert.deepEqual(laufzeiten(aufruf(['--nur-stack'], 'v24.22.1', { 'index.php': '' }).stackFunde), ['PHP']);
	assert.deepEqual(laufzeiten(aufruf([], 'v24.22.1', { 'index.php': '' }).stackFunde), ['PHP']);
	assert.deepEqual(aufruf(['--nur-node'], 'v24.22.1', { 'index.php': '' }).stackFunde, []);
});

test('RUNTIME-STACK an invocation that would check nothing or something unknown is refused', () => {
	for (const schalter of [['--nur-node', '--nur-stack'], ['--nur-stack', '--nur-stack'], ['--skip-node'], ['--nur-stack=1'], ['']]) {
		assert.match(aufruf(schalter, 'v24.22.1').fehler ?? '', /unbekannter Aufruf/, JSON.stringify(schalter));
	}
	const r = cli(['--nur-node', '--nur-stack']);
	assert.equal(r.status, 2);
	assert.equal(cli(['--skip-node']).status, 2);
});

test('RUNTIME-STACK --nur-stack is test-only: no script, Vercel command or workflow uses it', () => {
	const p = JSON.parse(readFileSync('package.json', 'utf8'));
	for (const [name, text] of Object.entries(p.scripts)) assert.doesNotMatch(text, /nur-stack/, `package.json scripts.${name}`);
	assert.doesNotMatch(readFileSync('vercel.json', 'utf8'), /nur-stack|check-runtime-stack/);
	for (const w of readdirSync('.github/workflows')) assert.doesNotMatch(readFileSync(`.github/workflows/${w}`, 'utf8'), /nur-stack/, w);
});

test('RUNTIME-STACK every CI job installs an exact Node version at or above the floor', () => {
	const versionen = readdirSync('.github/workflows').flatMap((w) => [...readFileSync(`.github/workflows/${w}`, 'utf8').matchAll(/^\s*node-version:\s*['"]?([^'"\s#]+)/gm)].map((m) => [w, m[1]]));
	assert.ok(versionen.length >= 2, 'both CI jobs set node-version');
	for (const [w, v] of versionen) {
		assert.match(v, /^\d+\.\d+\.\d+$/, `${w}: node-version '${v}' must be exact (a bare '24' resolved to v24.22.0)`);
		assert.deepEqual(pruefeNode(`v${v}`, JSON.parse(readFileSync('package.json', 'utf8')).engines.node), [], `${w}: ${v}`);
	}
	const jobs = readFileSync('.github/workflows/ci.yml', 'utf8').match(/uses: actions\/setup-node@/g) ?? [];
	assert.equal(jobs.length, versionen.filter(([w]) => w === 'ci.yml').length, 'every setup-node step in ci.yml pins node-version');
});

test('RUNTIME-STACK the CLI fails on an injected PHP file in a disposable copy (without git)', () => {
	const dir = mkdtempSync(path.join(tmpdir(), 'runtime-stack-'));
	try {
		for (const p of ['package.json', 'vercel.json', 'scripts', 'api', '.github']) cpSync(p, path.join(dir, p), { recursive: true });
		assert.equal(cli(['--nur-stack'], dir).status, 0, 'control: clean copy must pass');
		assert.ok(projektDateien(dir).includes('vercel.json'));
		writeFileSync(path.join(dir, 'api', 'shell.php'), '<?php system($_GET["c"]);');
		const r = cli(['--nur-stack'], dir);
		assert.equal(r.status, 1);
		assert.match(r.stderr, /api\/shell\.php[\s\S]*PHP/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('RUNTIME-STACK check:ci and build:web run the guard', async () => {
	const { default: p } = await import('../package.json', { with: { type: 'json' } });
	// Ohne jeden Schalter: der normale Aufruf prueft Stack UND Untergrenze.
	assert.match(p.scripts['check:ci'], /&& node scripts\/check-runtime-stack\.mjs &&/);
	assert.match(p.scripts.check, /&& node scripts\/check-runtime-stack\.mjs &&/);
	assert.match(p.scripts['build:web'], /^node scripts\/check-runtime-stack\.mjs --nur-node && /);
});
