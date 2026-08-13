import { createHmac, timingSafeEqual } from 'node:crypto';
import { DEMO_WALLET } from './covers.mjs';

const COVER_ID = 424242;

function secret() {
	const value = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
	if (!value) throw new Error('Demo-Checkout ist nicht konfiguriert.');
	return value;
}

export function createDemoRenewToken(chatId, now = Date.now()) {
	const payload = Buffer.from(JSON.stringify({ chatId: String(chatId), coverId: COVER_ID, exp: now + 30 * 60_000 })).toString('base64url');
	const signature = createHmac('sha256', secret()).update(payload).digest('base64url');
	return `${payload}.${signature}`;
}

export function verifyDemoRenewToken(token) {
	if (typeof token !== 'string') return null;
	const [payload, received] = token.split('.');
	if (!payload || !received) return null;
	const expected = createHmac('sha256', secret()).update(payload).digest();
	let actual;
	try { actual = Buffer.from(received, 'base64url'); } catch { return null; }
	if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
	try {
		const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
		if (data.coverId !== COVER_ID || Date.now() > data.exp) return null;
		return data;
	} catch { return null; }
}

export const demoRenewal = {
	wallet: DEMO_WALLET,
	coverId: COVER_ID,
	productName: 'Aave v3',
	amount: '15.000 USDC',
	periodDays: 365,
	nexusPremium: '118,50 USDC',
	commission: '6,24 USDC',
	maximum: '124,87 USDC',
	newExpiry: '27. August 2027'
};
