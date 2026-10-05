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
*/
import { createPublicClient, http } from 'viem';
import { mainnet } from 'viem/chains';
import { verifyExpectedSiweSignature } from './siwe-auth.mjs';

/** Mögliche interne Ergebnisse. Nach aussen bleibt die Meldung generisch. */
export const WALLET_SIG_RESULTS = Object.freeze([
	'VALID',
	'INVALID_SIGNATURE',
	'INVALID_SIGNATURE_FORMAT',
	'RPC_UNAVAILABLE'
]);

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

/** Der serverseitige Mainnet-Public-Client, oder null ohne Alchemy-Schlüssel. */
function defaultClient() {
	const apiKey = process.env.ALCHEMY_API_KEY?.trim();
	if (!apiKey) return null;
	return createPublicClient({
		chain: mainnet,
		transport: http(`https://eth-mainnet.g.alchemy.com/v2/${apiKey}`, { timeout: 10_000 })
	});
}

/**
 * ERC-1271-Verifikation gegen die erwartete Wallet-Adresse.
 *
 * `getCode`/`verify` sind für Tests injizierbar; im Betrieb kommen sie aus dem
 * Mainnet-Public-Client (getCode + verifyMessage-Action). Letztere kapselt die
 * standardkonforme Prüfung: hashMessage(message) (EIP-191, identisch zum
 * personal_sign-Flow) → isValidSignature(bytes32,bytes), Erfolg nur bei Magic
 * `0x1626ba7e`. Keine eigene Magic-Value-Heuristik.
 */
export async function verifyContractSiweSignature({ address, message, signature }, { getCode = null, verify = null, client } = {}) {
	// Formatgate ZUERST, ohne RPC.
	if (!isContractSignatureCandidate(signature)) return 'INVALID_SIGNATURE_FORMAT';

	let codeOf = getCode;
	let verifyMsg = verify;
	if (!codeOf || !verifyMsg) {
		const c = client ?? defaultClient();
		if (!c) return 'RPC_UNAVAILABLE'; // kein Schlüssel -> Contract-Status nicht feststellbar
		codeOf = codeOf ?? ((addr) => c.getCode({ address: addr }));
		verifyMsg = verifyMsg ?? ((params) => c.verifyMessage(params));
	}

	let code;
	try {
		code = await codeOf(address);
	} catch {
		return 'RPC_UNAVAILABLE'; // Status nicht feststellbar -> fail closed
	}
	// Kein deployter Contract (EOA oder undeployed/6492): kein 1271, fail closed.
	if (!code || code === '0x') return 'INVALID_SIGNATURE';

	try {
		const ok = await verifyMsg({ address, message, signature });
		return ok === true ? 'VALID' : 'INVALID_SIGNATURE';
	} catch {
		// revert/leer/malformed werden von viem als false gemeldet; ein Wurf ist
		// ein Infrastrukturfehler -> fail closed.
		return 'RPC_UNAVAILABLE';
	}
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
export async function verifyWalletSiweSignature({ message, signature, expected, now = Date.now() }, deps = {}) {
	const { verifyOffline = verifyExpectedSiweSignature, ...contractDeps } = deps;
	const offline = await verifyOffline({ message, signature, expected, now });
	if (offline === 'VALID') return 'VALID';
	// Nur signaturbezogene Fehlschläge (nach bestandener Feldprüfung) kommen für
	// den Contract-Pfad in Frage. Feldfehler (DOMAIN_MISMATCH, NONCE_MISMATCH, …)
	// werden unverändert zurückgegeben.
	if (offline !== 'INVALID_SIGNATURE' && offline !== 'INVALID_SIGNATURE_FORMAT') return offline;
	return verifyContractSiweSignature({ address: expected.wallet, message, signature }, contractDeps);
}
