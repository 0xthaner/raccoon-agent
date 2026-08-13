import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

function secret() {
	const value = process.env.DASHBOARD_SESSION_SECRET?.trim() || process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
	if (!value) throw new Error('Dashboard ist nicht konfiguriert.');
	return value;
}

function sign(payload) {
	return createHmac('sha256', secret()).update(payload).digest('base64url');
}

export function createDashboardChallenge(wallet, now = Date.now()) {
	const data = { type: 'challenge', wallet: wallet.toLowerCase(), nonce: randomBytes(16).toString('hex'), exp: now + 5 * 60_000 };
	const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
	return {
		token: `${payload}.${sign(payload)}`,
		message: ['Raccoon Agent', '', `Wallet: ${wallet}`, 'Zweck: Persönliches Cover-Dashboard öffnen.', `Nonce: ${data.nonce}`, `Gültig bis: ${new Date(data.exp).toISOString()}`, '', 'Dies ist keine Transaktion und erlaubt keinen Zugriff auf Geld.'].join('\n')
	};
}

export function createDashboardSession(wallet, now = Date.now()) {
	const data = { type: 'session', wallet: wallet.toLowerCase(), iat: now, exp: now + 7 * 24 * 60 * 60_000 };
	const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
	return `${payload}.${sign(payload)}`;
}

export function verifyDashboardToken(token) {
	if (typeof token !== 'string') return null;
	const [payload, received] = token.split('.');
	if (!payload || !received || token.split('.').length !== 2 || payload.length > 2048 || received.length > 128) return null;
	const expected = Buffer.from(sign(payload), 'base64url');
	let actual;
	try { actual = Buffer.from(received, 'base64url'); } catch { return null; }
	if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
	try {
		const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
		if (!data || !['challenge', 'session'].includes(data.type) || !/^0x[a-f0-9]{40}$/.test(data.wallet ?? '') || !Number.isFinite(data.exp) || Date.now() > data.exp) return null;
		if (data.type === 'challenge' && !/^[a-f0-9]{32}$/.test(data.nonce ?? '')) return null;
		if (data.type === 'session' && !Number.isFinite(data.iat)) return null;
		return data;
	} catch { return null; }
}

export function verifyDashboardSession(token) {
	const data = verifyDashboardToken(token);
	return data?.type === 'session' ? data : null;
}

export function dashboardMessage(data, wallet = data.wallet) {
	return ['Raccoon Agent', '', `Wallet: ${wallet}`, 'Zweck: Persönliches Cover-Dashboard öffnen.', `Nonce: ${data.nonce}`, `Gültig bis: ${new Date(data.exp).toISOString()}`, '', 'Dies ist keine Transaktion und erlaubt keinen Zugriff auf Geld.'].join('\n');
}
