/**
 * Covers einer Wallet, live von der Kette (src/cover-chain.mjs).
 *
 * Offline: Index und Vertrag werden ersetzt. Die Zahlen der Fixture stammen aus
 * einem echten Lauf am 01.10.2026 (Wallet 0xa179f6..., Covers 5081 und 5543,
 * wobei 5081 durch 5543 ersetzt wurde).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { COVER_NFT, ChainCoverError, getChainWalletCovers, serializeChainCover, _test } from '../src/cover-chain.mjs';
import { amountsDiffer } from '../src/alerts.mjs';

const WALLET = '0xa179f67882711957307edf3df0c9ee4f63026a12';
const NOW = Date.parse('2026-10-01T10:00:00Z');

const ROWS = {
	5081n: { coverId: 5081n, productId: 355n, coverAsset: 7n, amount: 1000000688n, start: 1784073600n, period: 6652800n, gracePeriod: 2592000n, originalCoverId: 5081n, latestCoverId: 5543n },
	5543n: { coverId: 5543n, productId: 355n, coverAsset: 7n, amount: 1000000962n, start: 1790726400n, period: 7862400n, gracePeriod: 2592000n, originalCoverId: 5081n, latestCoverId: 5543n }
};

function indexAntwort(ownedNfts, extra = {}) {
	return { ok: true, status: 200, json: async () => ({ ownedNfts, totalCount: ownedNfts.length, ...extra }) };
}

function fetchStub(seiten) {
	const aufrufe = [];
	return {
		aufrufe,
		fetchImpl: async (url) => {
			const adresse = String(url);
			aufrufe.push(adresse);
			if (adresse.startsWith('https://api.nexusmutual.io/')) return { ok: true, json: async () => [{ id: 355, name: 'Yield Basis' }] };
			return seiten.shift();
		}
	};
}

const client = {
	readContract: async ({ args: [ids] }) => ids.map((id) => ROWS[id])
};

test.beforeEach(() => _test.resetProductCache());

test('liest die Covers einer Wallet und erkennt ersetzte', async () => {
	const { fetchImpl } = fetchStub([indexAntwort([
		{ contractAddress: COVER_NFT, tokenId: '5543' },
		{ contractAddress: COVER_NFT, tokenId: '5081' }
	])]);
	const r = await getChainWalletCovers(WALLET, { apiKey: 'k', fetchImpl, client, now: NOW });
	assert.equal(r.apiVersion, 'agent.v1');
	assert.deepEqual(r.covers.map((c) => [c.coverId, c.status]), [[5081, 'superseded'], [5543, 'active']]);
	assert.equal(r.activeCount, 1);
	assert.equal(r.covers[1].productName, 'Yield Basis');
	assert.equal(r.covers[1].asset.symbol, 'cbBTC');
	assert.equal(r.covers[1].amount, '10.00000962');
	assert.equal(r.covers[1].amountUsd, null, 'kein Kurs, kein Dollarbetrag');
	assert.equal(r.source.live, true);
});

test('das Feld contractAddress ohne Metadaten wird erkannt (der Fehler der ersten Fassung)', async () => {
	// Die erste Fassung las nur contract.address und lieferte deshalb leer.
	const { fetchImpl } = fetchStub([indexAntwort([{ contractAddress: COVER_NFT, tokenId: '5543' }])]);
	const r = await getChainWalletCovers(WALLET, { apiKey: 'k', fetchImpl, client, now: NOW });
	assert.equal(r.count, 1);
	const mitMetadaten = fetchStub([indexAntwort([{ contract: { address: COVER_NFT }, tokenId: '5543' }])]);
	assert.equal((await getChainWalletCovers(WALLET, { apiKey: 'k', fetchImpl: mitMetadaten.fetchImpl, client, now: NOW })).count, 1);
});

test('ein fremder oder fehlender Vertrag ist ein Fehler, kein stiller Ausschluss', async () => {
	for (const eintrag of [{ contractAddress: '0x0000000000000000000000000000000000000001', tokenId: '1' }, { tokenId: '5543' }]) {
		const { fetchImpl } = fetchStub([indexAntwort([eintrag])]);
		await assert.rejects(getChainWalletCovers(WALLET, { apiKey: 'k', fetchImpl, client, now: NOW }), ChainCoverError);
	}
});

test('weniger gelesen als der Index meldet ist ein Fehler', async () => {
	const { fetchImpl } = fetchStub([indexAntwort([{ contractAddress: COVER_NFT, tokenId: '5543' }], { totalCount: 2 })]);
	await assert.rejects(getChainWalletCovers(WALLET, { apiKey: 'k', fetchImpl, client, now: NOW }), /unvollstaendig gelesen/);
});

test('mehrere Seiten werden vollstaendig gelesen', async () => {
	const { fetchImpl, aufrufe } = fetchStub([
		{ ok: true, json: async () => ({ ownedNfts: [{ contractAddress: COVER_NFT, tokenId: '5081' }], totalCount: 2, pageKey: 'weiter' }) },
		{ ok: true, json: async () => ({ ownedNfts: [{ contractAddress: COVER_NFT, tokenId: '5543' }], totalCount: 2 }) }
	]);
	const r = await getChainWalletCovers(WALLET, { apiKey: 'k', fetchImpl, client, now: NOW });
	assert.equal(r.count, 2);
	assert.ok(aufrufe.some((a) => a.includes('pageKey=weiter')));
});

test('ein Ausfall von Index oder Kette wirft, statt leer zu liefern', async () => {
	const kaputt = fetchStub([{ ok: false, status: 503, json: async () => ({}) }]);
	await assert.rejects(getChainWalletCovers(WALLET, { apiKey: 'k', fetchImpl: kaputt.fetchImpl, client, now: NOW }), ChainCoverError);
	const ok = fetchStub([indexAntwort([{ contractAddress: COVER_NFT, tokenId: '5543' }])]);
	const kaputteKette = { readContract: async () => { throw new Error('rpc https://eth-mainnet.g.alchemy.com/v2/GEHEIM'); } };
	await assert.rejects(
		getChainWalletCovers(WALLET, { apiKey: 'GEHEIM', fetchImpl: ok.fetchImpl, client: kaputteKette, now: NOW }),
		(error) => error instanceof ChainCoverError && !error.message.includes('GEHEIM')
	);
});

test('ohne Schluessel oder mit ungueltiger Wallet gibt es keinen Aufruf', async () => {
	const { fetchImpl, aufrufe } = fetchStub([]);
	await assert.rejects(getChainWalletCovers(WALLET, { apiKey: '', fetchImpl, client }), /ALCHEMY_API_KEY/);
	await assert.rejects(getChainWalletCovers('0x123', { apiKey: 'k', fetchImpl, client }), ChainCoverError);
	assert.equal(aufrufe.length, 0);
});

test('fehlt der Produktkatalog, fehlt nur der Name', async () => {
	const seiten = [indexAntwort([{ contractAddress: COVER_NFT, tokenId: '5543' }])];
	const fetchImpl = async (url) => (String(url).startsWith('https://api.nexusmutual.io/') ? { ok: false, status: 500 } : seiten.shift());
	const r = await getChainWalletCovers(WALLET, { apiKey: 'k', fetchImpl, client, now: NOW });
	assert.equal(r.count, 1);
	assert.equal(r.covers[0].productName, null);
});

test('Status, Ablauf und Nachfrist werden aus Start und Laufzeit gerechnet', () => {
	const c = serializeChainCover({ coverId: 1n, productId: 97n, coverAsset: 6n, amount: 14500261915n, start: 1790800000n, period: 86400n * 70n, gracePeriod: 86400n * 30n, originalCoverId: 0n, latestCoverId: 0n }, 'Aave v3', NOW);
	assert.equal(c.amount, '14500.261915');
	assert.equal(c.amountUsd, 14500.261915);
	assert.equal(Date.parse(c.endsAt) - Date.parse(c.startsAt), 70 * 86_400_000);
	assert.equal(Date.parse(c.graceEndsAt) - Date.parse(c.endsAt), 30 * 86_400_000);
	assert.equal(c.status, 'active');
	assert.equal(c.latestCoverId, null, '0 heisst nie bearbeitet');
	assert.equal(c.superseded, false);
	const abgelaufen = serializeChainCover({ ...ROWS[5081n], latestCoverId: 5081n }, null, NOW);
	assert.equal(abgelaufen.status, 'expired');
});

test('abgeschnittene Altbetraege gelten nicht als geaenderte Deckungssumme', () => {
	assert.equal(amountsDiffer('10', '10.00000962'), false);
	assert.equal(amountsDiffer('500.0007', '500.000747102780356473'), false);
	assert.equal(amountsDiffer('10', '12'), true);
	assert.equal(amountsDiffer(null, '10'), true);
	assert.equal(amountsDiffer(null, null), false);
});
