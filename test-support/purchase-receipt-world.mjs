/*
	Nexus P4G (20.10.2026): die KONSTRUIERTE P4E-Kette fuer Tests der Bestaetigungs-Orchestrierung.

	Eigenstaendige Kopie der synthetischen Welt aus test/purchase-receipt.test.mjs (dort
	unveraendert), hier mit dem Kaeufer als Parameter: ein Kauf, wie ihn CoverRaccoon
	erzeugen wuerde, gebaut aus der verifizierten ABI und den echten, gepinnten
	Laufzeit-Bytecodes. KEIN Mainnet-Beleg; belegt nur Verhalten (E3).

	Die Leser sind Attrappen mit request({ method, params }); Zustand nur am Belegblock.
	Kopf BLOCK + 100 und finalisiert BLOCK + 10: die P4E-Produktionspolitik
	(finalisiert, >= 64 Bestaetigungen) ist ohne Abkuerzung erfuellt.
*/
import { readFileSync } from 'node:fs';
import { encodeAbiParameters, encodeFunctionData, keccak256, pad, parseAbi, toEventSelector, toFunctionSelector, toHex } from 'viem';

const runtime = (name) => readFileSync(new URL(`../test/fixtures/nexus/${name}`, import.meta.url), 'utf8').trim();
const CODE = { broker: runtime('runtime-coverbroker-cb2b7366.hex'), proxy: runtime('runtime-cover-proxy-cafeac0f.hex'), implementation: runtime('runtime-cover-impl-cafeaff1.hex') };

export const SYNTHETIC = 'SYNTHETIC / CONSTRUCTED from the verified ABI - not a mainnet receipt';
export const WALLET = '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed';
export const OTHER = '0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359';
const BROKER = '0xcb2b736652d2dbf7d72e4db880cf6b7d99507814';
const COVER = '0xcafeac0ff5da0a2777d915531bfa6b29d282ee62';
const IMPL = '0xcafeaff1a21418f530feb00c6baef07523979c05';
const NFT = '0xcafeaca76be547f14d0220482667b42d8e7bc3eb';
const POOL = '0xcafea91714e55756c125b509274ede9bc91697cb';
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const ZERO = '0x0000000000000000000000000000000000000000';
/** keccak256("org.govblocks.proxy.implementation") */
const GOVBLOCKS_SLOT = '0x7fb5080a7084f4c60aade0a78fc13ba4ba6555b60e554360d005f0d684cea186';
const T0 = 1_792_400_000;
/** NUR TEST: CIDv0 der UTF-8-Bytes 'coverraccoon-p4c-test-fixture: not a Nexus proof-of-loss record'. Keine Proof-of-Loss-CID. */
export const TEST_CID = 'QmQPWELjoGp6zqfrELz2xeafuPgtSBfvVF1pjX3DvuFsah';
const WORDING_CID = 'QmQQ88vaZkgEY9qXKPtq7Se6caSjB2RTqF1GAnBLW1k8EY';

/** Kanonischer P4A-Intent (feste Zeiten; fuer die Datenbank liefert test-support/purchase-intent-pg.mjs frische). */
export const intent = (patch = {}) => ({
	id: '0b9e6f1c-3d2a-4f5b-8c7d-1e2f3a4b5c6d', wallet: WALLET, chainId: 1, deploymentKey: 'aave-v3-ethereum-core', productId: 97, productTypeId: 0, coverAssetId: 6,
	amountRaw: '1000000000', periodDays: 30, quotePremiumRaw: '3000578', maxPremiumRaw: '3030584', quoteFetchedAt: T0, capacityFetchedAt: T0, wordingCid: WORDING_CID,
	annexCid: null, termsHash: keccak256('0x01'), proofOfLossCid: TEST_CID, commissionRatio: 0, commissionDestination: ZERO, pinVersion: 'nexus-pin-1:broker-v2.12.1:cover-v3.3.0',
	acknowledgedAt: T0 + 10, expiresAt: T0 + 610, ...patch
});

const SOL = parseAbi([
	'struct BuyCoverParams { uint256 coverId; address owner; uint24 productId; uint8 coverAsset; uint96 amount; uint32 period; uint256 maxPremiumInAsset; uint8 paymentAsset; uint16 commissionRatio; address commissionDestination; string ipfsData; }',
	'struct PoolAllocationRequest { uint256 poolId; uint256 coverAmountInAsset; }',
	'function buyCover(BuyCoverParams params, PoolAllocationRequest[] poolAllocationRequests) payable returns (uint256)'
]);
const PARAMS = { coverId: 0n, productId: 97, coverAsset: 6, amount: 1_000_000_000n, period: 2_592_000, maxPremiumInAsset: 3_030_584n, paymentAsset: 6, commissionRatio: 0, commissionDestination: ZERO, ipfsData: TEST_CID };
const ALLOC = [{ poolId: 2n, coverAmountInAsset: 1_000_192_871n }];
export const calldata = (owner = WALLET) => encodeFunctionData({ abi: SOL, functionName: 'buyCover', args: [{ ...PARAMS, owner }, ALLOC] });
/** calldata_hash, wie P4D ihn fuer den Build dieses Kaeufers speichern wuerde. */
export const calldataHashFor = (owner = WALLET) => keccak256(calldata(owner));

const q = (n) => toHex(BigInt(n));
const word = (n) => encodeAbiParameters([{ type: 'uint256' }], [BigInt(n)]);
const addr = (a) => pad(a, { size: 32 });
export const txHashFor = (label) => keccak256(toHex(`p4g-synthetic-transaction:${label}`));
export const TX_HASH = txHashFor('A');
const BLOCK_HASH = keccak256(toHex('p4g-synthetic-block'));
export const BLOCK = 30_000_000n;
export const COVER_ID = 7001n;
const TS = 1_792_500_000n, PREMIUM = 3_000_578n, MAX_PREMIUM = 3_030_584n;
const TOPIC = { CoverBought: toEventSelector('CoverBought(uint256 indexed coverId, uint256 indexed originalCoverId, uint256 indexed buyerMemberId, uint256 productId)'), Transfer: toEventSelector('Transfer(address indexed from, address indexed to, uint256 value)') };
const SEL = { getCoverData: toFunctionSelector('getCoverData(uint256)'), getCoverReference: toFunctionSelector('getCoverReference(uint256)'), getCoverMetadata: toFunctionSelector('getCoverMetadata(uint256)'), ownerOf: toFunctionSelector('ownerOf(uint256)') };
const COVER_DATA = [{ type: 'tuple', components: ['uint24', 'uint8', 'uint96', 'uint32', 'uint32', 'uint32', 'uint16', 'uint16'].map((type) => ({ type })) }];
const REFERENCE = [{ type: 'tuple', components: [{ type: 'uint32' }, { type: 'uint32' }] }];

const log = (address, topics, data) => ({ address, topics, data });
const usdc = (from, to, value) => log(USDC, [TOPIC.Transfer, addr(from), addr(to)], word(value));
const coverBought = (coverId) => log(COVER, [TOPIC.CoverBought, word(coverId), word(coverId), word(9301n)], word(97n));
const mint = (to, id) => log(NFT, [TOPIC.Transfer, addr(ZERO), addr(to), word(id)], '0x');

/** Eine vollstaendige, konsistente SYNTHETISCHE Kette fuer einen Kauf von `buyer`; Tests veraendern sie gezielt. */
export function world({ buyer = WALLET, txHash = TX_HASH, coverId = COVER_ID } = {}) {
	return {
		label: SYNTHETIC,
		chainId: '0x1', head: BLOCK + 100n, finalized: BLOCK + 10n,
		tx: { hash: txHash, from: buyer, to: BROKER, input: calldata(buyer), value: '0x0', chainId: '0x1', blockHash: BLOCK_HASH, blockNumber: q(BLOCK), nonce: '0x4', gas: '0x7a120', type: '0x2' },
		receipt: { transactionHash: txHash, status: '0x1', from: buyer, to: BROKER, blockHash: BLOCK_HASH, blockNumber: q(BLOCK), gasUsed: '0x5208', logs: [
			usdc(buyer, BROKER, MAX_PREMIUM), mint(buyer, coverId), usdc(BROKER, POOL, PREMIUM), coverBought(coverId), usdc(BROKER, buyer, MAX_PREMIUM - PREMIUM)
		] },
		blocks: { [q(BLOCK)]: { number: q(BLOCK), hash: BLOCK_HASH, timestamp: q(TS), parentHash: keccak256('0x02') } },
		code: { [BROKER]: CODE.broker, [COVER]: CODE.proxy, [IMPL]: CODE.implementation },
		slot: addr(IMPL),
		covers: { [coverId]: { productId: 97, coverAsset: 6, amount: 1_000_192_871n, start: Number(TS), period: 2_592_000, gracePeriod: 2_592_000, original: coverId, metadata: TEST_CID, owner: buyer } }
	};
}

/** Attrappe eines Lesers; `seen` sammelt jede Methode. Zustandsabfragen NUR am Belegblock. */
export function reader(w, seen = []) {
	const atBlock = (tag) => { if (tag !== w.receipt?.blockNumber) throw new Error(`state read at ${tag}, not at the receipt block`); };
	const cover = (data) => { const c = w.covers[BigInt(`0x${data.slice(10)}`)]; if (!c) throw new Error('execution reverted'); return c; };
	return {
		async request({ method, params }) {
			seen.push(method);
			if (w.fail?.[method]) throw new Error(`reader down: ${method}`);
			switch (method) {
				case 'eth_chainId': return w.chainId;
				case 'eth_getTransactionByHash': return w.tx && params[0] === w.tx.hash ? structuredClone(w.tx) : null;
				case 'eth_getTransactionReceipt': {
					if (!w.receipt || params[0] !== w.receipt.transactionHash) return null;
					const r = structuredClone(w.receipt);
					r.logs = r.logs.map((l, i) => ({ blockHash: r.blockHash, transactionHash: r.transactionHash, logIndex: q(i + 40), removed: false, ...l }));
					return r;
				}
				case 'eth_blockNumber': return q(w.head);
				case 'eth_getBlockByNumber': return params[0] === 'finalized' ? { number: q(w.finalized), hash: keccak256('0x03'), timestamp: '0x0' } : structuredClone(w.blocks[params[0]] ?? null);
				case 'eth_getCode': atBlock(params[1]); return w.code[params[0].toLowerCase()] ?? '0x';
				case 'eth_getStorageAt': atBlock(params[2]); return params[0].toLowerCase() === COVER && params[1] === GOVBLOCKS_SLOT ? w.slot : pad('0x0', { size: 32 });
				case 'eth_call': {
					atBlock(params[1]);
					const { to, data } = params[0];
					const sel = data.slice(0, 10);
					if (to === NFT && sel === SEL.ownerOf) return addr(cover(data).owner);
					if (to !== COVER) throw new Error('execution reverted');
					const c = cover(data);
					if (sel === SEL.getCoverData) return encodeAbiParameters(COVER_DATA, [[c.productId, c.coverAsset, c.amount, c.start, c.period, c.gracePeriod, 5000, 20000]]);
					if (sel === SEL.getCoverReference) return encodeAbiParameters(REFERENCE, [[Number(c.original), Number(BigInt(`0x${data.slice(10)}`))]]);
					if (sel === SEL.getCoverMetadata) return encodeAbiParameters([{ type: 'string' }], [c.metadata]);
					throw new Error('execution reverted');
				}
				default: throw new Error(`unexpected method ${method}`);
			}
		}
	};
}
