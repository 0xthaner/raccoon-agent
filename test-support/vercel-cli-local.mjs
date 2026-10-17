/*
	CRSF Phase 2R (CR-VERIFY-003): die ECHTE Vercel-CLI lokal ausfuehren - ohne
	Deployment und ohne Kontakt zu Vercel oder npm.

	- Alle API-Aufrufe gehen per `--api` an einen lokalen Schein-Server
	  (127.0.0.1). Er beantwortet nur, was die CLI vor dem Hochladen braucht
	  (Nutzer, Projekt) und LEHNT jedes Deployment ab (400) - er nimmt dabei die
	  Dateiliste auf, die die CLI hochladen wuerde.
	- Jeder andere Netzverkehr der CLI laeuft ueber HTTP(S)_PROXY an einen lokalen
	  Proxy, der alles ablehnt und jeden Versuch protokolliert (`outbound`).
	- Telemetrie und Update-Pruefung sind abgeschaltet, globale Konfiguration und
	  HOME liegen in einem Wegwerfordner, das Token ist erfunden.
*/
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Version der installierten Vercel-CLI oder null. */
export function vercelCliVersion(env = process.env) {
	try {
		const r = spawnSync('vercel', ['--version'], { encoding: 'utf8', env: { PATH: env.PATH ?? '', HOME: tmpdir(), VERCEL_TELEMETRY_DISABLED: '1', NO_UPDATE_NOTIFIER: '1' }, timeout: 60_000 });
		const m = /(\d+\.\d+\.\d+)/.exec(`${r.stdout}${r.stderr}`);
		return r.status === 0 && m ? m[1] : null;
	} catch {
		return null;
	}
}

export async function startVercelWorld() {
	const requests = [], outbound = [], deployments = [];
	const api = http.createServer(async (req, res) => {
		let body = '';
		for await (const chunk of req) body += chunk;
		requests.push(`${req.method} ${req.url}`);
		const json = (code, value) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
		const { pathname } = new URL(req.url, 'http://local');
		if (/^\/(v2|www)\/user$/.test(pathname)) return json(200, { user: { id: 'crsf-user', uid: 'crsf-user', username: 'crsf', email: 'crsf@example.invalid', defaultTeamId: null, version: 'northstar' } });
		if (req.method === 'GET' && /^\/v\d+\/projects\/[^/]+$/.test(pathname)) return json(200, { id: 'prj_crsf', name: 'crsf-probe', accountId: 'crsf-user', framework: null, rootDirectory: null, link: null, latestDeployments: [] });
		if (req.method === 'POST' && /\/deployments$/.test(pathname)) {
			let files = null;
			try { files = JSON.parse(body).files?.map((f) => f.file) ?? null; } catch { files = null; }
			deployments.push(files);
			return json(400, { error: { code: 'crsf_probe_refused', message: 'CRSF probe: deployment refused by the local fake API' } });
		}
		return json(404, { error: { code: 'not_found', message: `crsf fake api: ${req.method} ${pathname}` } });
	});
	const proxy = http.createServer((req, res) => { outbound.push(`${req.method} ${req.url}`); res.writeHead(403); res.end(); });
	proxy.on('connect', (req, socket) => { outbound.push(`CONNECT ${req.url}`); socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); });
	await new Promise((r) => api.listen(0, '127.0.0.1', r));
	await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
	const home = mkdtempSync(path.join(tmpdir(), 'crsf-vercel-home-'));
	const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
	const env = {
		PATH: process.env.PATH ?? '', HOME: home, TMPDIR: process.env.TMPDIR ?? tmpdir(), CI: '1',
		VERCEL_TELEMETRY_DISABLED: '1', NO_UPDATE_NOTIFIER: '1',
		HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, http_proxy: proxyUrl, https_proxy: proxyUrl, ALL_PROXY: proxyUrl, all_proxy: proxyUrl,
		NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
		// npm (fuer `vercel build`): nur Cache, kein Netz, keine Nutzer-.npmrc
		npm_config_offline: 'true', npm_config_cache: path.join(home, 'npm-cache'), npm_config_userconfig: path.join(home, 'npmrc-empty')
	};
	const run = (args, cwd) => new Promise((resolve) => {
		const child = spawn('vercel', [...args, '--token', 'crsfFakeTokenNotReal', '--api', `http://127.0.0.1:${api.address().port}`, '--global-config', home, '--cwd', cwd], { env, stdio: ['ignore', 'pipe', 'pipe'] });
		let output = '';
		child.stdout.on('data', (d) => (output += d));
		child.stderr.on('data', (d) => (output += d));
		const timer = setTimeout(() => child.kill('SIGKILL'), 180_000);
		child.on('close', (code) => { clearTimeout(timer); resolve({ code, output }); });
	});
	return {
		requests, outbound, deployments, run,
		close() { api.close(); proxy.close(); rmSync(home, { recursive: true, force: true }); }
	};
}
