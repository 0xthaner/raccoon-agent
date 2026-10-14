/*
	LOKALE DEV-FIXTURE FUER DIE DEFI-POSITIONEN (12.10.2026).

	Nur fuer den Vite-Entwicklungsserver: main.js laedt dieses Modul ausschliesslich
	hinter `import.meta.env.DEV && import.meta.env.VITE_POSITIONS_FIXTURE`. Im
	Produktions-Build ist DEV false; der Import faellt samt diesem Modul aus dem
	Bundle. Kein Abfrageparameter, kein Speicher, kein Cookie und kein Header kann
	es einschalten.

	Reine Daten in genau der Form von /api/dashboard und /api/positions, damit die
	ECHTEN Render-Funktionen sie zeigen. Alle Werte sind erfunden; die Adresse ist
	eine offensichtliche Platzhalter-Adresse, keine echte Wallet.

	Varianten (Wert von VITE_POSITIONS_FIXTURE):
	  true      Core mit vorhandenem Cover (productId 97), Lido/Prime, EtherFi nicht lesbar
	  no-cover  dieselben Positionen, aber keine Covers in der Wallet
*/

export const FIXTURE_WALLET = '0x000000000000000000000000000000000000f1c5';

const VARIANTS = new Set(['true', 'no-cover']);

/** Gueltige Variante oder null; alles andere schaltet die Fixture nicht ein. */
export function fixtureVariant(value) {
	return VARIANTS.has(value) ? value : null;
}

/** Antwort wie GET /api/dashboard fuer die Platzhalter-Wallet. */
export function dashboardFixture(variant, now = Date.now()) {
	const covers = variant === 'no-cover' ? [] : [{
		coverId: 900001,
		productId: 97,
		productName: 'Aave v3',
		status: 'active',
		amount: '10000',
		asset: { id: 6, symbol: 'USDC' },
		endsAt: new Date(now + 45 * 86_400_000).toISOString()
	}];
	return {
		ok: true,
		wallet: FIXTURE_WALLET,
		covers,
		telegramLinked: false,
		telegramStartCode: null,
		agentSettings: null,
		checkedAt: new Date(now).toISOString(),
		demoWallet: false
	};
}

/** Antwort wie GET /api/positions; nur fuer die Platzhalter-Wallet, sonst null. */
export function positionsFixture(variant, wallet, now = Date.now()) {
	if (!fixtureVariant(variant) || String(wallet).toLowerCase() !== FIXTURE_WALLET) return null;
	const detectedAt = new Date(now).toISOString();
	const base = { wallet: FIXTURE_WALLET, chainId: 1, protocolKey: 'aave', protocolVersion: 'v3', valueKind: 'DERIVED_FROM_AAVE_ORACLE', blockNumber: '21000000', detectedAt, status: 'OK' };
	const nexus = { state: 'MATCHED', productId: 97, productName: 'Aave v3' };
	return {
		ok: true,
		wallet: FIXTURE_WALLET,
		chainId: 1,
		scope: { protocol: 'aave', version: 'v3', chain: 'eip155:1' },
		complete: false,
		checkedDeployments: [
			{ deploymentKey: 'aave-v3-ethereum-core', protocolKey: 'aave', protocolVersion: 'v3', label: 'Core', status: 'OK' },
			{ deploymentKey: 'aave-v3-ethereum-lido', protocolKey: 'aave', protocolVersion: 'v3', label: 'Lido / Prime', status: 'OK' },
			{ deploymentKey: 'aave-v3-ethereum-etherfi', protocolKey: 'aave', protocolVersion: 'v3', label: 'EtherFi', status: 'UNAVAILABLE', reason: 'RPC_TIMEOUT' }
		],
		positions: [
			{
				...base,
				deploymentKey: 'aave-v3-ethereum-core',
				label: 'Core',
				marketAddress: '0x0000000000000000000000000000000000000c0e',
				supplied: [
					{ asset: '0x000000000000000000000000000000000000a001', symbol: 'USDC', decimals: 6, amount: '8250', amountRaw: '8250000000', usdValue: '8250', isCollateral: true },
					{ asset: '0x000000000000000000000000000000000000a002', symbol: 'WETH', decimals: 18, amount: '1.35', amountRaw: '1350000000000000000', usdValue: '4180', isCollateral: true }
				],
				borrowed: [
					{ asset: '0x000000000000000000000000000000000000a003', symbol: 'USDT', decimals: 6, amount: '2000', amountRaw: '2000000000', usdValue: '2000' }
				],
				totals: { suppliedUsd: '12430', debtUsd: '2000', netUsd: '10430', healthFactor: '2.31' },
				pricing: { source: 'aave-oracle', oracle: '0x0000000000000000000000000000000000000c01', baseCurrency: 'USD', baseUnitDecimals: 8 },
				sourceContracts: [],
				nexus
			},
			{
				...base,
				deploymentKey: 'aave-v3-ethereum-lido',
				label: 'Lido / Prime',
				marketAddress: '0x0000000000000000000000000000000000000c1d',
				supplied: [
					{ asset: '0x000000000000000000000000000000000000a004', symbol: 'wstETH', decimals: 18, amount: '0.8', amountRaw: '800000000000000000', usdValue: '2960', isCollateral: false }
				],
				borrowed: [],
				totals: { suppliedUsd: '2960', debtUsd: '0', netUsd: '2960', healthFactor: null },
				pricing: { source: 'aave-oracle', oracle: '0x0000000000000000000000000000000000000c02', baseCurrency: 'USD', baseUnitDecimals: 8 },
				sourceContracts: [],
				nexus
			}
		],
		blockNumber: '21000000',
		fetchedAt: detectedAt
	};
}
