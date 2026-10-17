/**
 * CRSF Phase 2Q, CR-VERIFY-003 - historische Korrektur 20f9549 ("Heruntergeladene
 * Fonts gegen SHA-256 pruefen").
 *
 * Invariante: scripts/fetch-fonts.mjs schreibt KEINE Datei, deren SHA-256 nicht dem
 * festgelegten Wert entspricht, und bricht den Build ab (Exit 1) - auch wenn nur
 * eine von mehreren Dateien abweicht (erst alles pruefen, dann schreiben).
 *
 * Das echte Skript laeuft als eigener Prozess in einem leeren Arbeitsordner (ZIEL
 * ist relativ zum Arbeitsordner). Ersetzt ist nur das Netz: ein Vorlade-Modul gibt
 * fetch() ein selbst gebautes ZIP zurueck. Kein Zugriff nach aussen.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/fetch-fonts.mjs', import.meta.url));
const NAMES = ['Satoshi_Complete/Fonts/WEB/fonts/Satoshi-Variable.woff2', 'Satoshi_Complete/Fonts/WEB/fonts/Satoshi-VariableItalic.woff2', 'Satoshi_Complete/License/FFL.txt'];

/** Minimales ZIP (Verfahren 0, gespeichert) mit `entries` [name, Buffer]. */
function zip(entries) {
	const locals = [];
	const central = [];
	let offset = 0;
	for (const [name, data] of entries) {
		const n = Buffer.from(name);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 8);
		local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26);
		const dir = Buffer.alloc(46);
		dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(0, 10);
		dir.writeUInt32LE(data.length, 20); dir.writeUInt32LE(data.length, 24); dir.writeUInt16LE(n.length, 28); dir.writeUInt32LE(offset, 42);
		locals.push(local, n, data);
		central.push(dir, n);
		offset += 30 + n.length + data.length;
	}
	const dirBuf = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(dirBuf.length, 12); end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, dirBuf, end]);
}

function runWith(archive) {
	const dir = mkdtempSync(path.join(tmpdir(), 'crsf-fonts-'));
	try {
		writeFileSync(path.join(dir, 'archive.bin'), archive);
		writeFileSync(path.join(dir, 'fake-net.mjs'), `import { readFileSync } from 'node:fs';
const body = readFileSync(${JSON.stringify(path.join(dir, 'archive.bin'))});
globalThis.fetch = async (url) => { if (String(url) !== 'https://api.fontshare.com/v2/fonts/download/satoshi') throw new Error('unexpected fetch ' + url); return new Response(body); };`);
		const run = spawnSync(process.execPath, ['--import', path.join(dir, 'fake-net.mjs'), SCRIPT], { cwd: dir, encoding: 'utf8', timeout: 60_000 });
		let written = [];
		try { written = readdirSync(path.join(dir, 'web/public/fonts')); } catch { /* nichts geschrieben */ }
		return { status: run.status, output: `${run.stdout}${run.stderr}`, written };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test('HIST 20f9549 fonts whose SHA-256 does not match are never written and the build fails', () => {
	const r = runWith(zip(NAMES.map((name) => [name, Buffer.from(`tampered ${name}`)])));
	assert.equal(r.status, 1, `script exit ${r.status}: ${r.output.slice(0, 300)}`);
	assert.match(r.output, /Pruefsumme stimmt nicht/);
	assert.deepEqual(r.written, [], 'a file with a wrong checksum was written');
});

test('HIST 20f9549 the archive is checked completely before anything is written', () => {
	// Ein fehlendes Archivmitglied: auch die vorhandenen werden nicht geschrieben.
	const r = runWith(zip(NAMES.slice(0, 2).map((name) => [name, Buffer.from('x')])));
	assert.notEqual(r.status, 0);
	assert.deepEqual(r.written, []);
});
