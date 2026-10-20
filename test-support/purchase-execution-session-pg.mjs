/*
	Nexus P4I (20.10.2026): Bausteine fuer die Tests der dauerhaften Ausfuehrungs-Sitzungen.

	- builtIntent(client): ein echter BUILT-Intent ueber die P4D-Funktionen, mit
	  synthetischen buyCover-Bytes, deren keccak256 der gespeicherte calldata_hash ist;
	- sessionFor(...): eine Sitzung in genau der Form von P4H createExecutionSession,
	  Hash mit dem echten computeExecutionSessionHash. Der Block ist synthetisch
	  (P4F laeuft hier nicht; das deckt test/purchase-execution-session.test.mjs ab);
	- raceAuto(connect, n, fn): n EIGENE Verbindungen warten an einer Schranke
	  (geteilte Advisory-Sperre auf Sitzungsebene, die der Test exklusiv haelt).
	  Freigegeben wird erst, wenn die Datenbank n gleichzeitig wartende Verbindungen
	  dieser Datenbank meldet (pg_locks). Danach ruft jede Verbindung fn ohne offene
	  Transaktion auf - jeder Funktionsaufruf ist seine eigene Transaktion wie spaeter
	  ueber PostgREST, now() ist die Zeit des Aufrufs.

	Nur gegen einen lokalen Wegwerf-Postgres (M1_DB_TEST_PG_URL), nie Produktion.
*/
import { randomUUID } from 'node:crypto';
import { keccak256, encodeAbiParameters } from 'viem';
import { rpcOn, intentFor, freshWallet } from './purchase-intent-pg.mjs';
import { computePurchaseIntentHash } from '../src/purchase-intent.mjs';
import { computeExecutionSessionHash, TOCTOU_RESIDUAL } from '../src/purchase-execution-session.mjs';
import { createIntent, markBuilt } from '../src/purchase-intent-db.mjs';

export const BROKER = '0xcb2b736652d2dbf7d72e4db880cf6b7d99507814';
export const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
export const BARRIER_KEY = 4_242_019;
export const nowS = () => Math.floor(Date.now() / 1000);

/** Synthetische buyCover-Bytes (Selector + Nutzlast), eindeutig je Etikett. */
export const buyData = (label) => `0x7c59cac4${keccak256(new TextEncoder().encode(`buy-${label}`)).slice(2)}${'00'.repeat(32)}`;
/** USDC-Freigabe an den Broker (Selector 0x095ea7b3, Broker, Betrag), genau 68 Bytes. */
export const approveData = (amount = 3_030_584n) => `0x095ea7b3${encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [BROKER, amount]).slice(2)}`;

/** Ein echter BUILT-Intent; calldata_hash = keccak256 der buyCover-Bytes. */
export async function builtIntent(client) {
	const intent = intentFor(freshWallet());
	const c = await createIntent(client, { intent, clientRequestId: randomUUID() });
	if (c.status !== 'created') throw new Error(`createIntent ${c.status} ${c.code}`);
	const data = buyData(intent.id);
	const calldataHash = keccak256(data);
	const b = await markBuilt(client, { intent, calldataHash });
	if (b.status !== 'built') throw new Error(`markBuilt ${b.status} ${b.code}`);
	return { intent, data, calldataHash, intentHash: computePurchaseIntentHash(intent) };
}

let block = 26_230_166n;
/** Sitzung in der Form von P4H createExecutionSession (Hash neu berechnet, nie uebernommen). */
export function sessionFor(built, { kind = 'NEXUS_BUY_COVER', sessionId = randomUUID(), now = nowS(), ttl = 30, verifiedAtBlock = ++block, verifiedAtBlockHash } = {}) {
	const data = kind === 'NEXUS_BUY_COVER' ? built.data : approveData();
	const fields = {
		sessionId, intentId: built.intent.id, intentHash: built.intentHash, calldataHash: built.calldataHash, wallet: built.intent.wallet, chainId: 1,
		transactionKind: kind, to: kind === 'NEXUS_BUY_COVER' ? BROKER : USDC, value: 0n, data,
		verifiedAtBlock, verifiedAtBlockHash: verifiedAtBlockHash ?? keccak256(new TextEncoder().encode(`block-${verifiedAtBlock}`)), expiresAt: now + ttl
	};
	return { ...fields, dataHash: keccak256(data), createdAt: now, singleUse: true, singleUseEnforcement: 'MODEL_ONLY_NOT_PERSISTED', executionSessionHash: computeExecutionSessionHash(fields), toctou: TOCTOU_RESIDUAL };
}

async function waitForWaiters(holder, n, timeoutMs = 15_000) {
	const until = Date.now() + timeoutMs;
	let waiting = 0;
	while (Date.now() < until) {
		waiting = (await holder.query(`select count(*)::int as n from pg_locks where locktype = 'advisory' and database = (select oid from pg_database where datname = current_database()) and objid = $1 and objsubid = 1 and not granted`, [BARRIER_KEY])).rows[0].n;
		if (waiting >= n) return waiting;
		await new Promise((r) => setTimeout(r, 20));
	}
	return waiting;
}

/**
 * fn(client, i, conn) auf n eigenen Verbindungen, gleichzeitig nach der Schranke. Liefert
 * { waiting, pids, maxInFlight, results }: waiting = von der Datenbank gemeldete gleichzeitig
 * wartende Verbindungen, pids = Backend-PIDs, maxInFlight = hoechste Zahl gleichzeitig laufender fn.
 */
export async function raceAuto(connect, n, fn) {
	const conns = await Promise.all(Array.from({ length: n }, () => connect()));
	const holder = await connect();
	await holder.query('select pg_advisory_lock($1)', [BARRIER_KEY]);
	let released = false, inFlight = 0, maxInFlight = 0;
	try {
		const pids = [];
		for (const k of conns) pids.push((await k.query('select pg_backend_pid() as pid')).rows[0].pid);
		const running = conns.map((k, i) => (async () => {
			await k.query('select pg_advisory_lock_shared($1)', [BARRIER_KEY]);
			await k.query('select pg_advisory_unlock_shared($1)', [BARRIER_KEY]);
			inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
			try { return await fn(rpcOn(k), i, k); } finally { inFlight--; }
		})());
		const waiting = await waitForWaiters(holder, n);
		await holder.query('select pg_advisory_unlock($1)', [BARRIER_KEY]);
		released = true;
		const settled = await Promise.allSettled(running);
		const failed = settled.filter((s) => s.status === 'rejected');
		if (failed.length) throw failed[0].reason;
		return { waiting, pids, maxInFlight, results: settled.map((s) => s.value) };
	} finally {
		if (!released) await holder.query('select pg_advisory_unlock($1)', [BARRIER_KEY]).catch(() => {});
		await holder.end().catch(() => {});
		await Promise.allSettled(conns.map((k) => k.end()));
	}
}
