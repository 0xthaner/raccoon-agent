import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { isAddress } from 'viem';
import { consumePendingLink, getPendingLink } from './db.mjs';
import { linkSiweExpectation, signingMessage } from './linking.mjs';
import { verifyExpectedSiweSignature } from './siwe-auth.mjs';

const publicDir = join(process.cwd(), 'dist-web');
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

async function staticFile(pathname, res) {
	const relative = pathname === '/link' ? 'index.html' : pathname.replace(/^\//, '');
	const safe = normalize(relative);
	if (safe.startsWith('..')) return false;
	try {
		const content = await readFile(join(publicDir, safe));
		res.writeHead(200, { 'content-type': mime[extname(safe)] ?? 'application/octet-stream', 'cache-control': safe === 'index.html' ? 'no-store' : 'public, max-age=31536000, immutable' });
		res.end(content); return true;
	} catch { return false; }
}

function json(res, status, value) {
	res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
	res.end(JSON.stringify(value));
}

async function bodyOf(req) {
	let body = '';
	for await (const chunk of req) {
		body += chunk;
		if (body.length > 20_000) throw new Error('Request too large');
	}
	return JSON.parse(body || '{}');
}

export function startWebServer({ port = 8787, onLinked }) {
	const server = createServer(async (req, res) => {
		try {
			const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
			if (req.method === 'GET' && url.pathname === '/link') {
				if (await staticFile('/link', res)) return;
			}
			if (req.method === 'GET' && url.pathname === '/api/config') return json(res, 200, { reownProjectId: process.env.REOWN_PROJECT_ID?.trim() || '' });
			if (req.method === 'GET' && url.pathname === '/api/link') {
				const code = url.searchParams.get('code');
				const wallet = url.searchParams.get('wallet');
				const pending = code && await getPendingLink(code);
				if (!pending || pending.used_at || pending.expires_at < Date.now()) return json(res, 410, { ok: false, error: 'Verbindungscode ungültig oder abgelaufen.' });
				if (!wallet || !isAddress(wallet)) return json(res, 400, { ok: false, error: 'Ungültige Wallet-Adresse.' });
				return json(res, 200, { ok: true, message: signingMessage({ wallet, nonce: pending.nonce, expiresAt: pending.expires_at, code }) });
			}
			if (req.method === 'POST' && url.pathname === '/api/link/verify') {
				const { code, wallet, signature } = await bodyOf(req);
				const pending = code && await getPendingLink(code);
				if (!pending || pending.used_at || pending.expires_at < Date.now()) return json(res, 410, { ok: false, error: 'Verbindungscode ungültig oder abgelaufen.' });
				if (!isAddress(wallet) || typeof signature !== 'string') return json(res, 400, { ok: false, error: 'Ungültige Signaturdaten.' });
				// AGENT-SEC-A3: derselbe Vertrag wie im Vercel-Handler.
				const expected = linkSiweExpectation({ wallet, nonce: pending.nonce, expiresAt: pending.expires_at, code });
				const message = signingMessage({ wallet, nonce: pending.nonce, expiresAt: pending.expires_at, code });
				if (await verifyExpectedSiweSignature({ message, signature, expected }) !== 'VALID') {
					return json(res, 401, { ok: false, error: 'Signatur konnte nicht bestätigt werden.' });
				}
				const chatId = await consumePendingLink(code, wallet);
				if (!chatId) return json(res, 409, { ok: false, error: 'Verbindungscode wurde bereits verwendet.' });
				await onLinked(chatId, wallet);
				return json(res, 200, { ok: true });
			}
			if (req.method === 'GET' && await staticFile(url.pathname, res)) return;
			json(res, 404, { ok: false, error: 'Not found' });
		} catch (error) {
			json(res, 400, { ok: false, error: error.message });
		}
	});
	server.listen(port, '127.0.0.1', () => console.log(`Wallet-Verknüpfung: http://localhost:${port}/link`));
	return server;
}
