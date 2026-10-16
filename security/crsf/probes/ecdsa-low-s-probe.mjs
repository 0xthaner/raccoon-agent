/*
	CRSF evidence probe EV-PROBE-LOW-S (answers Q-CRYPTO-LOW-S).

	Question: does the ECDSA recovery stack used for SIWE (viem verifyMessage ->
	@noble/curves) enforce or normalise low-s signatures?

	Offline, deterministic key (not a real wallet). Prints one JSON line; exit 0
	whenever the observation could be made, exit 1 if the probe itself broke.
	Characterisation only: it asserts nothing about what the answer should be.
*/
import { verifyMessage } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const account = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const message = 'CRSF low-s probe (no authority)';
const signature = await account.signMessage({ message });
const r = signature.slice(2, 66);
const s = BigInt(`0x${signature.slice(66, 130)}`);
const v = parseInt(signature.slice(130), 16);
const twin = `0x${r}${(N - s).toString(16).padStart(64, '0')}${(v === 27 ? 28 : 27).toString(16)}`;

const original = await verifyMessage({ address: account.address, message, signature });
let highS;
try { highS = await verifyMessage({ address: account.address, message, signature: twin }); } catch { highS = false; }
const observation = { question: 'Q-CRYPTO-LOW-S', original_is_low_s: s <= N / 2n, original_valid: original, high_s_twin_accepted: highS };
process.stdout.write(JSON.stringify(observation) + '\n');
process.exitCode = original === true && observation.original_is_low_s ? 0 : 1;
