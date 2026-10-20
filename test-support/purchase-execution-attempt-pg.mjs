/*
	Nexus P4J (20.10.2026): Bausteine fuer die Tests der Ausfuehrungsversuche.

	authorized(client, opts): echter BUILT-Intent (P4D), echte Sitzung (P4I persist +
	consume) und ein angelegter Versuch AUTHORIZED - alles ueber die echten Helfer.
	Der Wallet-Aufruf selbst existiert nicht; die Tests schreiben nur, was ein
	spaeterer Wallet-Schritt ueber seinen Versuch melden wuerde.

	Nur gegen einen lokalen Wegwerf-Postgres (M1_DB_TEST_PG_URL), nie Produktion.
*/
import { randomUUID } from 'node:crypto';
import { builtIntent, sessionFor } from './purchase-execution-session-pg.mjs';
import { hash32 } from './purchase-intent-pg.mjs';
import { persistExecutionSession, consumeExecutionSession } from '../src/purchase-execution-session-db.mjs';
import { openExecutionAttempt } from '../src/purchase-execution-attempt-db.mjs';

/** Verbrauchte Sitzung (P4I) fuer einen Intent; liefert Sitzung und consumer_request_id. */
export async function consumedSession(client, built, opts = {}) {
	const session = sessionFor(built, opts);
	const p = await persistExecutionSession(client, { session });
	if (p.status !== 'created') throw new Error(`persist ${p.status} ${p.code}`);
	const key = randomUUID();
	const c = await consumeExecutionSession(client, { sessionId: session.sessionId, sessionHash: session.executionSessionHash, intentId: session.intentId, consumerRequestId: key });
	if (c.status !== 'CONSUMED') throw new Error(`consume ${c.status} ${c.code}`);
	return { session, key };
}

/** BUILT-Intent (oder der uebergebene), verbrauchte Sitzung und Versuch AUTHORIZED. */
export async function authorized(client, { built, kind = 'NEXUS_BUY_COVER', ttl = 30, verifiedAtBlock } = {}) {
	const b = built ?? await builtIntent(client);
	const { session, key } = await consumedSession(client, b, { kind, ttl, ...(verifiedAtBlock ? { verifiedAtBlock } : {}) });
	const attemptId = randomUUID();
	const o = await openExecutionAttempt(client, { attemptId, sessionId: session.sessionId, consumerRequestId: key });
	if (o.status !== 'CREATED') throw new Error(`open ${o.status} ${o.code}`);
	return { built: b, session, key, attemptId, attempt: o.attempt };
}

/** Ein Ketten-Hash, eindeutig je Etikett. */
export const txHashFor = (label) => hash32(`chain-tx-${label}`);
