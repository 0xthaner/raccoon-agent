import { ChainCoverError, getChainWalletCovers } from './cover-chain.mjs';

export const DEMO_WALLET = process.env.DEMO_WALLET?.trim().toLowerCase() || null;

function demoCover() {
	return {
		coverId: 424242,
		productId: 1,
		productName: 'Aave v3',
		status: 'active',
		amount: '15000',
		asset: { id: 6, symbol: 'USDC' },
		startsAt: '2026-05-29T12:00:00.000Z',
		endsAt: '2026-08-27T12:00:00.000Z',
		demo: true
	};
}

export class CoverDataError extends Error {
	constructor(code, message) {
		super(message);
		this.code = code;
	}
}

/*
	Seit 01.10.2026 live von der Kette (siehe cover-chain.mjs), nicht mehr ueber
	CoverRaccoon und dessen Nachtlauf. Ein Fehler bleibt ein Fehler: lieber
	"gerade nicht verfuegbar" als eine leere oder veraltete Liste.
*/
export async function getWalletCovers(wallet, options) {
	let result;
	try {
		result = await getChainWalletCovers(wallet, options);
	} catch (error) {
		if (error instanceof ChainCoverError) throw new CoverDataError('unavailable', `Cover-Daten sind gerade nicht verfügbar: ${error.message}`);
		throw error;
	}
	if (DEMO_WALLET && wallet.toLowerCase() === DEMO_WALLET && !result.covers.some((cover) => cover.status === 'active')) {
		return { ...result, covers: [demoCover(), ...result.covers], demoWallet: true };
	}
	return result;
}

function daysUntil(iso) {
	return Math.ceil((Date.parse(iso) - Date.now()) / 86_400_000);
}

function amountText(cover, language) {
	if (cover.amount == null) return language === 'zh' ? '不可用' : language === 'en' ? 'unavailable' : 'nicht verfügbar';
	const value = Number(cover.amount);
	const number = new Intl.NumberFormat(language === 'en' ? 'en-US' : 'de-AT', { maximumFractionDigits: 4 });
	return `${Number.isFinite(value) ? number.format(value) : cover.amount} ${cover.asset?.symbol ?? ''}`.trim();
}

export function formatWalletCovers(result, language = 'de') {
	const english = language === 'en';
	const chinese = language === 'zh';
	const date = new Intl.DateTimeFormat(chinese ? 'zh-CN' : english ? 'en-GB' : 'de-AT', { dateStyle: 'medium', timeZone: 'Europe/Vienna' });
	const active = result.covers.filter((cover) => cover.status === 'active');
	if (!result.covers.length) {
		if (chinese) return '未找到此钱包的 Nexus Mutual 保障。';
		if (english) return 'No Nexus Mutual covers were found for this wallet.';
		return 'Für diese Wallet wurden keine Nexus-Mutual-Covers gefunden.';
	}
	if (!active.length) return chinese
		? `未找到有效保障。已登记 ${result.covers.length} 个已到期或已续期的保障。`
		: english
		? `No active covers found. ${result.covers.length} expired or renewed cover(s) are registered.`
		: `Keine aktiven Covers gefunden. ${result.covers.length} abgelaufene oder verlängerte Police(n) sind registriert.`;

	const lines = [chinese ? `有效保障：${active.length}` : english ? `Active covers: ${active.length}` : `Aktive Covers: ${active.length}`, ''];
	for (const cover of active) {
		const remaining = cover.endsAt ? daysUntil(cover.endsAt) : null;
		lines.push(`🛡 ${cover.productName ?? `${chinese ? 'Nexus 产品' : english ? 'Nexus product' : 'Nexus-Produkt'} #${cover.productId}`}`);
		lines.push(`Cover #${cover.coverId} · ${amountText(cover, language)}`);
		lines.push(
			cover.endsAt
				? `${chinese ? '到期日' : english ? 'Expiry' : 'Ablauf'}: ${date.format(new Date(cover.endsAt))}${remaining == null ? '' : chinese ? ` · 剩余 ${remaining} 天` : english ? ` · ${remaining} day${remaining === 1 ? '' : 's'} left` : ` · noch ${remaining} Tag${remaining === 1 ? '' : 'e'}`}`
				: chinese ? '到期日：不可用' : english ? 'Expiry: unavailable' : 'Ablauf: nicht verfügbar'
		);
		lines.push('');
	}
	if (result.demoWallet) lines.push(chinese ? '演示：仅适用于此钱包 · 不会执行交易' : english ? 'Demo for this wallet only · no transaction' : 'Demo für diese Wallet · keine Transaktion', '');
	lines.push(chinese ? '数据来源：Nexus Mutual · Ethereum（实时）' : english ? 'Source: Nexus Mutual · Ethereum (live)' : 'Quelle: Nexus Mutual · Ethereum (live)');
	return lines.join('\n');
}
