import { isAddress } from 'viem';
import { getPendingLink } from '../src/db.mjs';
import { signingMessage } from '../src/linking.mjs';
import { enforceRateLimit } from '../src/http-security.mjs';

export default async function handler(request, response) {
	response.setHeader('cache-control', 'no-store');
	if (request.method !== 'GET') return response.status(405).json({ ok: false, error: 'Method not allowed' });
	if (!await enforceRateLimit(request, response, 'wallet-link-read', 30, 600)) return;
	const code = typeof request.query.code === 'string' ? request.query.code : '';
	const wallet = typeof request.query.wallet === 'string' ? request.query.wallet : '';
	const pending = code && await getPendingLink(code);
	if (!pending || pending.used_at || pending.expires_at < Date.now()) {
		return response.status(410).json({ ok: false, error: 'Verbindungscode ungültig oder abgelaufen.' });
	}
	if (!isAddress(wallet)) return response.status(400).json({ ok: false, error: 'Ungültige Wallet-Adresse.' });
	return response.status(200).json({
		ok: true,
		message: signingMessage({ wallet, nonce: pending.nonce, expiresAt: pending.expires_at, code })
	});
}
