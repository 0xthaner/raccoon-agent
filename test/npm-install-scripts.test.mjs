/**
 * CRSF Phase 2Q, CR-VERIFY-003 - historische Korrekturen b706956/51c0cd4
 * ("Install-Scripts abschalten", .npmrc).
 *
 * Invariante: mit der .npmrc des Projekts fuehrt npm beim Installieren KEINE
 * Lebenszyklus-Skripte aus (preinstall/install/postinstall) - die Datei wirkt fuer
 * jeden npm-Lauf im Projekt, auch fuer Vercels zweiten Installationslauf, der das
 * installCommand nicht beachtet.
 *
 * Geprueft mit dem echten npm in einem leeren Wegwerfprojekt (keine Abhaengigkeiten,
 * --offline: kein Netz). Gegenprobe ohne die .npmrc: dort MUSS das Skript laufen,
 * sonst waere die Probe taub.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

function install({ withProjectNpmrc }) {
	const dir = mkdtempSync(path.join(tmpdir(), 'crsf-npmrc-'));
	try {
		writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
			name: 'crsf-install-script-probe', version: '1.0.0', private: true,
			scripts: { preinstall: 'node -e "require(\'fs\').writeFileSync(\'ran-preinstall\', \'1\')"', postinstall: 'node -e "require(\'fs\').writeFileSync(\'ran-postinstall\', \'1\')"' }
		}));
		if (withProjectNpmrc) copyFileSync('.npmrc', path.join(dir, '.npmrc'));
		const env = { ...process.env };
		for (const key of Object.keys(env)) if (/^npm_config_/i.test(key)) delete env[key];
		const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
		const run = spawnSync(npm, ['install', '--offline', '--no-audit', '--no-fund', '--userconfig', path.join(dir, 'empty-userconfig')], { cwd: dir, encoding: 'utf8', env, timeout: 120_000 });
		return { status: run.status, output: `${run.stdout}${run.stderr}`, ran: ['ran-preinstall', 'ran-postinstall'].filter((f) => existsSync(path.join(dir, f))) };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test('HIST b706956 the project .npmrc stops npm from running install lifecycle scripts', () => {
	const control = install({ withProjectNpmrc: false });
	assert.equal(control.status, 0, control.output.slice(0, 400));
	assert.deepEqual(control.ran, ['ran-preinstall', 'ran-postinstall'], 'control run without .npmrc: scripts did not run (probe is deaf)');
	const guarded = install({ withProjectNpmrc: true });
	assert.equal(guarded.status, 0, guarded.output.slice(0, 400));
	assert.deepEqual(guarded.ran, [], 'install scripts ran despite the project .npmrc');
});
