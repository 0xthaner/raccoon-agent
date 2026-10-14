/*
	ERC-1271-Verifikation fuer DEPLOYTE Smart-Contract-Wallets (z. B. Safe),
	zusaetzlich zum bestehenden EOA-Pfad. AGENT-AUTH-001.

	`src/siwe-auth.mjs` bleibt bewusst netzwerk-/DB-frei und unveraendert; die
	Chain-Lesevorgaenge liegen hier. Es werden ausschliesslich bereits vorhandene
	viem-Funktionen genutzt (keine neue Dependency): derselbe Mainnet-Public-
	Client + Alchemy-Transport wie in cover-chain.mjs.

	SICHERHEIT:
	- Chain ist fest Ethereum Mainnet (chainId 1), serverseitig. Kein Client-Input
	  bestimmt RPC-URL, Chain, Provider oder Contract-Adresse.
	- Die geprüfte Contract-Adresse ist AUSSCHLIESSLICH `expected.wallet` aus dem
	  bereits validierten SIWE-Kontext.
	- Alles fail closed: jeder RPC-/Decode-/Contract-Fehler authentifiziert NIE.
	- Kein EOA-Fallback, sobald die Wallet als deployter Contract erkannt ist.
	- Kein ERC-6492 / keine Deployment-Simulation in dieser Phase.

	ZWEI UNABHAENGIGE PROVIDER (14.10.2026): Ein einzelner kompromittierter,
	veralteter oder gestoerter RPC-Provider darf eine Contract-Wallet nie
	anmelden. Alchemy (A) und Infura (B) pruefen dasselbe - dieselbe Adresse,
	denselben EIP-191-Hash, dieselbe Signatur - auf DEMSELBEN Block:

	  1. eth_chainId == 1 und eth_blockNumber bei beiden; die Koepfe duerfen
	     hoechstens MAX_HEAD_DIFFERENCE Bloecke auseinanderliegen.
	  2. Gemeinsamer Block N = min(Kopf A, Kopf B) - STATE_DEPTH. Beide muessen
	     fuer N denselben Block-Hash melden (sonst Fork/Luege -> Ablehnung).
	  3. getCode(N) bei beiden: beide Code, und derselbe Code.
	  4. isValidSignature(hash, signature) bei N direkt am Contract, bei beiden.
	     VALID nur, wenn BEIDE den Magic-Wert 0x1626ba7e liefern.

	Jede Abweichung, jeder Ausfall, jede unlesbare Antwort: nicht VALID. Kein
	Fallback-Transport, kein "erster gewinnt", kein Ergebnis-Cache. Fehlt einer der
	beiden Schluessel, gibt es KEINE Contract-Anmeldung (kein Rueckfall auf einen
	Provider). Der EOA-Pfad bleibt offline und fragt keinen Provider.

	Bewusst NICHT mehr viem verifyMessage: dessen deployless ERC-6492-Validator
	laeuft gegen `latest`, macht Netzwerkfehler zu "ungueltig" und hat einen
	ecrecover-Rueckfall. Der direkte ERC-1271-Aufruf ist an Block N gebunden und
	trennt Revert/leere Antwort (INVALID) sauber von Infrastrukturfehlern.
	Zwei kompromittierte Provider schuetzt das nicht.
*/
import { BaseError, ContractFunctionRevertedError, ContractFunctionZeroDataError, createPublicClient, hashMessage, http, parseAbi, toHex } from 'viem';
import { mainnet } from 'viem/chains';
import { verifyExpectedSiweSignature } from './siwe-auth.mjs';

/** Mögliche interne Ergebnisse. Nach aussen bleibt die Meldung generisch. */
export const WALLET_SIG_RESULTS = Object.freeze([
	'VALID',
	'INVALID_SIGNATURE',
	'INVALID_SIGNATURE_FORMAT',
	'RPC_UNAVAILABLE',
	'RPC_DISAGREEMENT'
]);

/** Hoechstens so viele Bloecke duerfen die beiden Provider-Koepfe auseinanderliegen. */
export const MAX_HEAD_DIFFERENCE = 3;
/** So viele Bloecke hinter dem niedrigeren Kopf wird geprueft (Schutz vor Kopf-Reorgs). */
export const STATE_DEPTH = 2;
/** Zeitlimit je RPC-Versuch. viem wiederholt (Standard, bewusst - siehe rpc-retries.test.mjs). */
export const RPC_TIMEOUT_MS = 6_000;
/** Gesamtfrist der Contract-Pruefung: danach RPC_UNAVAILABLE, egal wie langsam ein Provider ist. */
export const ERC1271_DEADLINE_MS = 20_000;
export const ERC1271_PROVIDERS = Object.freeze(['alchemy', 'infura']);
const ERC1271_ABI = parseAbi(['function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)']);
const ERC1271_MAGIC = '0x1626ba7e';
const HEX_QUANTITY = /^0x[0-9a-fA-F]{1,64}$/;
const BLOCK_HASH = /^0x[0-9a-fA-F]{64}$/;
const CODE_HEX = /^0x(?:[0-9a-fA-F]{2})*$/;

/*
	Defensives Größenlimit für eine Contract-Signatur, BEVOR ein RPC ausgelöst
	wird: 4096 Byte. Begründung: eine ERC-1271-Signatur selbst eines sehr grossen
	Safe-Multisigs (z. B. 50+ Owner, je 65 Byte, plus Contract-Signature-Offsets)
	bleibt deutlich darunter; 4096 Byte liegen zugleich klar unter dem bestehenden
	HTTP-Body-Limit (requireJson 16 KB), sodass Müll/oversized Blobs hier offline
	abgewiesen werden und keine unnötigen Alchemy-Requests erzeugen.
*/
export const MAX_CONTRACT_SIGNATURE_BYTES = 4096;
const HEX_ONLY = /^0x[0-9a-fA-F]*$/;

/**
 * Syntaktisch gültiger Contract-Signature-Candidate? String, `0x`, nur Hex,
 * nicht leer, gerade Byte-Länge, innerhalb des Größenlimits. Sonst wird gar
 * nicht erst ein RPC versucht.
 */
export function isContractSignatureCandidate(signature) {
	if (typeof signature !== 'string' || !HEX_ONLY.test(signature)) return false;
	const hex = signature.slice(2);
	if (hex.length === 0 || hex.length % 2 !== 0) return false;
	if (hex.length / 2 > MAX_CONTRACT_SIGNATURE_BYTES) return false;
	return true;
}

/**
 * Die beiden unabhaengigen Mainnet-Clients - oder null, wenn auch nur ein
 * Schluessel fehlt. Getrennte Transporte, kein Fallback, keine Wiederholung.
 * Die URLs (mit Schluessel) verlassen diese Funktion nie in Logs oder Antworten.
 */
export function erc1271Providers() {
	const alchemy = process.env.ALCHEMY_API_KEY?.trim();
	const infura = process.env.INFURA_API_KEY?.trim();
	if (!alchemy || !infura) return null;
	// Wiederholungen bleiben bewusst an (viem-Standard): die Anmeldung wartet auf die
	// Antwort, und ein einzelner 503 soll keine Safe-Anmeldung kosten. Die Gesamtfrist
	// ERC1271_DEADLINE_MS begrenzt die Wartezeit trotzdem.
	const client = (url) => createPublicClient({ chain: mainnet, transport: http(url, { timeout: RPC_TIMEOUT_MS }) });
	return {
		alchemy: client(`https://eth-mainnet.g.alchemy.com/v2/${alchemy}`),
		infura: client(`https://mainnet.infura.io/v3/${infura}`)
	};
}

/** Beide Provider parallel; jedes Ergebnis bleibt seinem Provider zugeordnet. Fehler -> { ok: false }. */
async function perProvider(providers, fn) {
	const settle = (client) => Promise.resolve().then(() => fn(client)).then((value) => ({ ok: true, value }), () => ({ ok: false }));
	const [alchemy, infura] = await Promise.all([settle(providers.alchemy), settle(providers.infura)]);
	return { alchemy, infura };
}

function quantity(value) {
	if (typeof value !== 'string' || !HEX_QUANTITY.test(value)) throw new Error('malformed quantity');
	return BigInt(value);
}

/**
 * Der gemeinsame Block, an dem beide Provider pruefen:
 * { status: 'OK', blockNumber } | { status: 'RPC_UNAVAILABLE' } | { status: 'RPC_DISAGREEMENT' }.
 */
export async function commonBlock(providers) {
	const heads = await perProvider(providers, async (client) => {
		// Beide abwarten (allSettled): keine Wiederholungen laufen ungesehen im Hintergrund weiter.
		const [chainId, head] = await Promise.allSettled([client.request({ method: 'eth_chainId' }), client.request({ method: 'eth_blockNumber' })]);
		if (chainId.status !== 'fulfilled' || head.status !== 'fulfilled') throw new Error('unavailable');
		if (quantity(chainId.value) !== 1n) throw new Error('wrong chain');
		return quantity(head.value);
	});
	if (!heads.alchemy.ok || !heads.infura.ok) return { status: 'RPC_UNAVAILABLE' };
	const a = heads.alchemy.value;
	const b = heads.infura.value;
	// Ein Provider haengt zurueck oder meldet einen unplausiblen Kopf: nicht pruefbar.
	if ((a > b ? a - b : b - a) > BigInt(MAX_HEAD_DIFFERENCE)) return { status: 'RPC_UNAVAILABLE' };
	const blockNumber = (a < b ? a : b) - BigInt(STATE_DEPTH);
	if (blockNumber <= 0n) return { status: 'RPC_UNAVAILABLE' };
	const hashes = await perProvider(providers, async (client) => {
		const block = await client.request({ method: 'eth_getBlockByNumber', params: [toHex(blockNumber), false] });
		if (!block || typeof block.hash !== 'string' || !BLOCK_HASH.test(block.hash) || quantity(block.number) !== blockNumber) throw new Error('malformed block');
		return block.hash.toLowerCase();
	});
	if (!hashes.alchemy.ok || !hashes.infura.ok) return { status: 'RPC_UNAVAILABLE' };
	// Verschiedene Bloecke unter derselben Nummer: Fork oder Luege -> nie pruefen.
	if (hashes.alchemy.value !== hashes.infura.value) return { status: 'RPC_DISAGREEMENT' };
	return { status: 'OK', blockNumber };
}

/** isValidSignature bei Block N an genau einem Provider: 'VALID' | 'INVALID' | 'UNAVAILABLE'. */
async function erc1271Verdict(client, { address, hash, signature, blockNumber }) {
	try {
		const result = await client.readContract({ address, abi: ERC1271_ABI, functionName: 'isValidSignature', args: [hash, signature], blockNumber });
		return typeof result === 'string' && result.toLowerCase() === ERC1271_MAGIC ? 'VALID' : 'INVALID';
	} catch (error) {
		// Revert oder leere Antwort: der Contract sagt nein. Alles andere (Netz,
		// Zeitlimit, unlesbare Antwort): nicht feststellbar. Nie VALID.
		const contractSaidNo = error instanceof BaseError && error.walk((e) => e instanceof ContractFunctionRevertedError || e instanceof ContractFunctionZeroDataError);
		return contractSaidNo ? 'INVALID' : 'UNAVAILABLE';
	}
}

/** VALID ausschliesslich bei Einigkeit auf VALID. */
export function combineErc1271Verdicts(alchemy, infura) {
	if (alchemy === 'VALID' && infura === 'VALID') return 'VALID';
	if ((alchemy === 'VALID' && infura === 'INVALID') || (alchemy === 'INVALID' && infura === 'VALID')) return 'RPC_DISAGREEMENT';
	if (alchemy === 'UNAVAILABLE' || infura === 'UNAVAILABLE' || alchemy === 'VALID' || infura === 'VALID') return 'RPC_UNAVAILABLE';
	return 'INVALID_SIGNATURE';
}

/**
 * ERC-1271-Verifikation gegen die erwartete Wallet-Adresse, mit Konsens zweier
 * unabhaengiger Provider auf einem gemeinsamen Block (siehe Kopfkommentar).
 * `providers` ist fuer Tests injizierbar ({ alchemy, infura } als viem-Clients);
 * im Betrieb kommen beide aus erc1271Providers(). Fehlt einer: RPC_UNAVAILABLE.
 */
export async function verifyContractSiweSignature({ address, message, signature }, { providers, deadlineMs = ERC1271_DEADLINE_MS } = {}) {
	// Formatgate ZUERST, ohne RPC.
	if (!isContractSignatureCandidate(signature)) return 'INVALID_SIGNATURE_FORMAT';
	const p = providers === undefined ? erc1271Providers() : providers;
	if (!p?.alchemy || !p?.infura) return 'RPC_UNAVAILABLE'; // nie nur ein Provider
	let timer;
	const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve('RPC_UNAVAILABLE'), deadlineMs); });
	try {
		return await Promise.race([consensus(p, { address, message, signature }), deadline]);
	} finally {
		clearTimeout(timer);
	}
}

async function consensus(p, { address, message, signature }) {
	const state = await commonBlock(p);
	if (state.status !== 'OK') return state.status;
	const { blockNumber } = state;

	const codes = await perProvider(p, async (client) => {
		const code = await client.getCode({ address, blockNumber });
		const value = code ?? '0x';
		if (typeof value !== 'string' || !CODE_HEX.test(value)) throw new Error('malformed code');
		return value.toLowerCase();
	});
	if (!codes.alchemy.ok || !codes.infura.ok) return 'RPC_UNAVAILABLE';
	const hasA = codes.alchemy.value !== '0x';
	const hasB = codes.infura.value !== '0x';
	// Kein deployter Contract (EOA oder undeployed/6492) nach Ansicht beider: kein 1271.
	if (!hasA && !hasB) return 'INVALID_SIGNATURE';
	// Nur einer meldet Code, oder verschiedener Code am selben Block: fail closed.
	if (hasA !== hasB || codes.alchemy.value !== codes.infura.value) return 'RPC_DISAGREEMENT';

	const hash = hashMessage(message);
	const [a, b] = await Promise.all([
		erc1271Verdict(p.alchemy, { address, hash, signature, blockNumber }),
		erc1271Verdict(p.infura, { address, hash, signature, blockNumber })
	]);
	return combineErc1271Verdicts(a, b);
}

/**
 * Fuer Entscheidungen "ist eine frische Bestaetigung noetig?" (api/dashboard.mjs,
 * Alt-Sitzungen ohne Art): true NUR, wenn BEIDE Provider fuer die Adresse
 * keinen Code melden. Ein einzelner Provider kann eine Bestaetigung so nur
 * erzwingen (Ablehnung), nie wegnehmen. Jeder Fehler -> false.
 */
export async function noContractCodeByQuorum(address, { providers } = {}) {
	const p = providers === undefined ? erc1271Providers() : providers;
	if (!p?.alchemy || !p?.infura) return false;
	const codes = await perProvider(p, async (client) => {
		const code = (await client.getCode({ address })) ?? '0x';
		if (typeof code !== 'string' || !CODE_HEX.test(code)) throw new Error('malformed code');
		return code;
	});
	return codes.alchemy.ok && codes.infura.ok && codes.alchemy.value === '0x' && codes.infura.value === '0x';
}

/**
 * Dünner Orchestrator: erst der unveränderte Offline-EOA-Pfad, dann - nur wenn
 * die SIWE-Felder bereits korrekt waren und die Signatur ein gültiger
 * Contract-Candidate ist - der ERC-1271-Pfad.
 *
 * Eine gültige EOA-Signatur kehrt ohne jeden RPC mit VALID zurück. Ein
 * Feld-Mismatch (Domain/URI/Chain/Nonce/…) wird unverändert durchgereicht und
 * führt NIE zu einem RPC.
 */
export async function verifyWalletSiweSignature(params, deps = {}) {
	return (await verifyWalletSiweAuthority(params, deps)).result;
}

/**
 * Wie verifyWalletSiweSignature, nennt aber zusaetzlich, WORAUF die Gueltigkeit
 * beruht (AUDIT SA-L1, 14.10.2026):
 *   authority 'eoa'      - Schluessel der Adresse, offline per ECDSA bewiesen
 *   authority 'contract' - ERC-1271 des deployten Contracts (z. B. Safe), live gelesen
 *   authority null       - nicht gueltig
 * Der Dashboard-Login leitet daraus die Sitzungsart ab: eine Contract-Autoritaet
 * kann sich spaeter aendern (Owner entfernt), ein Schluessel nicht. Kein
 * Request-Wert, kein SDK-Wert und kein Header fliesst ein.
 */
export async function verifyWalletSiweAuthority({ message, signature, expected, now = Date.now() }, deps = {}) {
	const { verifyOffline = verifyExpectedSiweSignature, ...contractDeps } = deps;
	const offline = await verifyOffline({ message, signature, expected, now });
	if (offline === 'VALID') return { result: 'VALID', authority: 'eoa' };
	// Nur signaturbezogene Fehlschläge (nach bestandener Feldprüfung) kommen für
	// den Contract-Pfad in Frage. Feldfehler (DOMAIN_MISMATCH, NONCE_MISMATCH, …)
	// werden unverändert zurückgegeben.
	if (offline !== 'INVALID_SIGNATURE' && offline !== 'INVALID_SIGNATURE_FORMAT') return { result: offline, authority: null };
	const result = await verifyContractSiweSignature({ address: expected.wallet, message, signature }, contractDeps);
	return { result, authority: result === 'VALID' ? 'contract' : null };
}
