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
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { befehlsVerstoesse, pruefeNode, pruefeStack, projektDateien, NODE_UNTERGRENZE } from '../scripts/check-runtime-stack.mjs';

const pruefe = (dateien) => pruefeStack(Object.keys(dateien), (p) => dateien[p]);
const laufzeiten = (funde) => funde.map((f) => f.laufzeit);
const pkg = (scripts, extra = {}) => JSON.stringify({ name: 'x', scripts, ...extra });

test('RUNTIME-STACK the real repository has no foreign production runtime', () => {
	const r = spawnSync(process.execPath, ['scripts/check-runtime-stack.mjs'], { encoding: 'utf8' });
	assert.equal(r.status, 0, r.stdout + r.stderr);
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
	assert.deepEqual(pruefeNode(`v${NODE_UNTERGRENZE}`, '24.x'), []);
	assert.deepEqual(pruefeNode('v24.23.0', '24.x'), []);
	assert.equal(pruefeNode('v24.22.0', '24.x').length, 1);
	assert.equal(pruefeNode('v24.9.9', '24.x').length, 1);
	assert.equal(pruefeNode('v22.23.4', '24.x').length, 1);
	assert.equal(pruefeNode('v26.12.1', '24.x').length, 1);
});

test('RUNTIME-STACK the CLI fails on an injected PHP file in a disposable copy (without git)', () => {
	const dir = mkdtempSync(path.join(tmpdir(), 'runtime-stack-'));
	try {
		for (const p of ['package.json', 'vercel.json', 'scripts', 'api', '.github']) cpSync(p, path.join(dir, p), { recursive: true });
		assert.equal(spawnSync(process.execPath, ['scripts/check-runtime-stack.mjs'], { cwd: dir, encoding: 'utf8' }).status, 0, 'control: clean copy must pass');
		assert.ok(projektDateien(dir).includes('vercel.json'));
		writeFileSync(path.join(dir, 'api', 'shell.php'), '<?php system($_GET["c"]);');
		const r = spawnSync(process.execPath, ['scripts/check-runtime-stack.mjs'], { cwd: dir, encoding: 'utf8' });
		assert.notEqual(r.status, 0);
		assert.match(r.stderr, /api\/shell\.php[\s\S]*PHP/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('RUNTIME-STACK check:ci and build:web run the guard', async () => {
	const { default: p } = await import('../package.json', { with: { type: 'json' } });
	assert.match(p.scripts['check:ci'], /node scripts\/check-runtime-stack\.mjs(?! --nur-node)/);
	assert.match(p.scripts.check, /node scripts\/check-runtime-stack\.mjs(?! --nur-node)/);
	assert.match(p.scripts['build:web'], /^node scripts\/check-runtime-stack\.mjs --nur-node && /);
});
