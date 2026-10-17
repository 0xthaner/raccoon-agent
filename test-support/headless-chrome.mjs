/*
	Echter Browser fuer CRSF Phase 2P (CR-BROWSER-004 P3): startet ein lokales
	Chrome/Chromium headless mit Wegwerf-Profil und spricht es ueber das
	DevTools-Protokoll an (eingebautes WebSocket von Node 24, keine Abhaengigkeit).

	Kein Netz nach aussen: der Browser laedt nur die Adressen, die der Test ihm
	gibt (127.0.0.1). Findet sich kein Browser, wirft start() - der Test schlaegt
	dann fehl, statt still uebersprungen zu werden (GitHub ubuntu-latest bringt
	google-chrome mit).
*/
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const NAMES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];

export function findChrome(env = process.env) {
	for (const dir of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
		for (const name of NAMES) if (existsSync(path.join(dir, name))) return path.join(dir, name);
	}
	return null;
}

export async function startChrome() {
	const binary = findChrome();
	if (!binary) throw new Error(`no headless browser found on PATH (${NAMES.join(', ')})`);
	const profile = mkdtempSync(path.join(tmpdir(), 'crsf-chrome-'));
	const child = spawn(binary, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu',
		'--disable-extensions', '--disable-background-networking', '--disable-component-update', '--disable-sync',
		'--metrics-recording-only', '--no-sandbox', `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank'],
	{ stdio: ['ignore', 'ignore', 'pipe'] });
	const wsUrl = await new Promise((resolve, reject) => {
		let buffer = '';
		const timer = setTimeout(() => reject(new Error(`browser did not start: ${buffer.slice(0, 300)}`)), 20000);
		child.stderr.on('data', (d) => { buffer += d; const m = /DevTools listening on (ws:\/\/\S+)/.exec(buffer); if (m) { clearTimeout(timer); resolve(m[1]); } });
		child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`browser exited (${code}): ${buffer.slice(0, 300)}`)); });
	});
	const ws = new WebSocket(wsUrl);
	await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
	let id = 0;
	const pending = new Map();
	ws.onmessage = (event) => { const m = JSON.parse(event.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
	const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
		const i = ++id;
		pending.set(i, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
		ws.send(JSON.stringify({ id: i, method, params, sessionId }));
	});

	/** Oeffnet `url` in einem neuen Tab, wartet bis `doneExpression` wahr ist, liefert `resultExpression`. */
	async function visit(url, { doneExpression = 'window.__done === true', resultExpression = 'window.__result', timeoutMs = 15000 } = {}) {
		const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
		const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
		try {
			await send('Page.enable', {}, sessionId);
			await send('Page.navigate', { url }, sessionId);
			const deadline = Date.now() + timeoutMs;
			for (;;) {
				const r = await send('Runtime.evaluate', { expression: `Boolean(${doneExpression})`, returnByValue: true }, sessionId);
				if (r.result.value === true) break;
				if (Date.now() > deadline) throw new Error(`page ${url} did not finish`);
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			const r = await send('Runtime.evaluate', { expression: `JSON.stringify(${resultExpression})`, returnByValue: true }, sessionId);
			return JSON.parse(r.result.value ?? 'null');
		} finally {
			await send('Target.closeTarget', { targetId }).catch(() => {});
		}
	}

	async function close() {
		ws.close();
		if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise((resolve) => child.once('exit', resolve)); }
		rmSync(profile, { recursive: true, force: true });
	}
	return { visit, close, binary };
}
