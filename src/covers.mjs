const mode = process.env.COVER_DATA_MODE?.trim() || 'mock';
const baseUrl = (process.env.COVER_DATA_BASE_URL?.trim() || 'https://coverraccoon.com').replace(/\/$/, '');
const apiKey = process.env.COVER_AGENT_API_KEY?.trim() || '';
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

export function renewalUrl(cover, periodDays = 365) {
	if (cover?.demo || cover?.status !== 'active' || !cover.productId || !cover.coverId || cover.amount == null || cover.asset?.id == null) return null;
	const url = new URL('/cover/buy', 'https://coverraccoon.com');
	url.searchParams.set('action', 'renew');
	url.searchParams.set('productId', String(cover.productId));
	url.searchParams.set('coverId', String(cover.coverId));
	url.searchParams.set('amount', String(cover.amount));
	url.searchParams.set('assetId', String(cover.asset.id));
	url.searchParams.set('periodDays', String(periodDays));
	return url.toString();
}

export async function getWalletCovers(wallet) {
	if (mode !== 'api') throw new CoverDataError('mock_mode', 'Cover-Datenquelle steht noch im Testmodus.');
	if (!apiKey) throw new CoverDataError('not_configured', 'COVER_AGENT_API_KEY fehlt.');
	const response = await fetch(`${baseUrl}/api/agent/v1/wallets/${encodeURIComponent(wallet)}/covers`, {
		headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
		signal: AbortSignal.timeout(15_000)
	});
	if (response.status === 404) throw new CoverDataError('unauthorized', 'Coverraccoon-Zugriff wurde abgelehnt.');
	if (!response.ok) throw new CoverDataError('unavailable', `Coverraccoon ist derzeit nicht verfügbar (HTTP ${response.status}).`);
	const result = await response.json();
	if (result.apiVersion !== 'agent.v1' || !Array.isArray(result.covers)) {
		throw new CoverDataError('invalid_response', 'Coverraccoon lieferte ein unbekanntes Datenformat.');
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
		const incomplete = result.source?.historicalBackfillThroughBlock == null;
		if (chinese) return incomplete
			? '尚未找到此钱包的保障。历史数据同步仍在进行中。'
			: '未找到此钱包的 Nexus Mutual 保障。';
		if (english) return incomplete
			? 'No covers have been found for this wallet yet. The historical data sync is still running.'
			: 'No Nexus Mutual covers were found for this wallet.';
		return incomplete ? 'Für diese Wallet wurden noch keine Covers gefunden. Der historische Datenabgleich läuft derzeit noch.' : 'Für diese Wallet wurden keine Nexus-Mutual-Covers gefunden.';
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
	lines.push(chinese ? '数据来源：Coverraccoon · Nexus Mutual · Ethereum' : english ? 'Source: Coverraccoon · Nexus Mutual · Ethereum' : 'Quelle: Coverraccoon · Nexus Mutual · Ethereum');
	return lines.join('\n');
}
