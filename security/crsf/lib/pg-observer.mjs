/*
	CRSF Phase 2U (F-2T-1): runner-side Postgres observer.

	A transparent TCP relay between the tests of ONE real-system evidence item
	and the disposable Postgres. It runs in the executor process that the runner
	starts (security/crsf/lib/observed-test-exec.mjs), never inside a test. The
	tests receive only the relay address; the receipt it produces stays in the
	executor and is signed for the runner there.

	It reads the wire protocol in both directions and records only what the
	SERVER confirms:
	- an authenticated connection: the server sent AuthenticationOk;
	- a completed statement: the server sent CommandComplete on such a connection;
	- busy intervals: a connection is busy from its first query message (Q/P/B/E/F)
	  until the server reports ReadyForQuery "idle" (I). ReadyForQuery "in
	  transaction" (T/E) keeps it busy, so open transactions count as active.
	- overlap: a connection becomes busy while another authenticated connection to
	  the same database is busy. Counted per database, with the peak number of
	  simultaneously busy connections.

	Client bytes alone never count; a TLS-upgraded connection is opaque and is
	not credited. What the observer cannot show: that the observed statements
	are the ones relevant to the claimed property (that is what the mutation
	cases are for).
*/
import net from 'node:net';

const QUERY_START = new Set(['Q', 'P', 'B', 'E', 'F']);
const SSL_REQUEST = 80877103, GSS_REQUEST = 80877104, CANCEL_REQUEST = 80877102;

/** Pure summary of a receipt under the profile thresholds. */
export function summarizeReceipt(receipt, { min_concurrent_connections = 2, min_overlap_events = 2 } = {}) {
	const dbs = Object.values(receipt?.databases ?? {});
	const postgres_use = dbs.some((d) => d.authenticated >= 1 && d.completed >= 1);
	const concurrency = dbs.some((d) => d.authenticated >= 2 && d.max_busy >= min_concurrent_connections && d.overlap_events >= min_overlap_events);
	return { postgres_use, concurrency };
}

/**
 * Starts the relay. `upstream` is { host, port } of the disposable Postgres (or a
 * function returning a connected socket, used by the self-test's fake server).
 */
export async function startPgObserver({ upstream }) {
	const databases = {};
	const live = new Set();
	const sockets = new Set();
	let connectionsTotal = 0, opaque = 0;
	const db = (name) => (databases[name] ??= { authenticated: 0, completed: 0, max_busy: 0, overlap_events: 0 });
	const busyIn = (name) => [...live].filter((c) => c.authenticated && c.busy && c.database === name).length;

	const server = net.createServer((client) => {
		connectionsTotal++;
		const conn = { database: null, authenticated: false, busy: false, opaque: false };
		live.add(conn);
		const up = typeof upstream === 'function' ? upstream() : net.connect(upstream.port, upstream.host);
		sockets.add(client); sockets.add(up);
		let clientBuf = Buffer.alloc(0), serverBuf = Buffer.alloc(0);
		let clientStartup = true, awaitSslByte = false;
		const close = () => { live.delete(conn); client.destroy(); up.destroy(); };
		client.on('error', close); up.on('error', close); client.on('close', close); up.on('close', close);

		const startBusy = () => {
			if (conn.busy || !conn.authenticated) return;
			if (busyIn(conn.database) >= 1) db(conn.database).overlap_events++;
			conn.busy = true;
			const d = db(conn.database);
			d.max_busy = Math.max(d.max_busy, busyIn(conn.database));
		};

		client.on('data', (chunk) => {
			up.write(chunk);
			if (conn.opaque) return;
			clientBuf = Buffer.concat([clientBuf, chunk]);
			for (;;) {
				if (clientStartup) {
					if (clientBuf.length < 8) return;
					const len = clientBuf.readInt32BE(0);
					if (clientBuf.length < len) return;
					const code = clientBuf.readInt32BE(4);
					const body = clientBuf.subarray(8, len);
					clientBuf = clientBuf.subarray(len);
					if (code === SSL_REQUEST || code === GSS_REQUEST) { awaitSslByte = true; continue; }
					if (code === CANCEL_REQUEST) continue;
					const parts = body.toString('utf8').split('\0');
					const params = {};
					for (let i = 0; i + 1 < parts.length; i += 2) if (parts[i]) params[parts[i]] = parts[i + 1];
					conn.database = params.database ?? params.user ?? '';
					clientStartup = false;
					continue;
				}
				if (clientBuf.length < 5) return;
				const len = clientBuf.readInt32BE(1);
				if (clientBuf.length < 1 + len) return;
				const type = String.fromCharCode(clientBuf[0]);
				clientBuf = clientBuf.subarray(1 + len);
				if (QUERY_START.has(type)) startBusy();
			}
		});

		up.on('data', (chunk) => {
			client.write(chunk);
			if (conn.opaque) return;
			serverBuf = Buffer.concat([serverBuf, chunk]);
			for (;;) {
				if (awaitSslByte) {
					if (serverBuf.length < 1) return;
					const answer = String.fromCharCode(serverBuf[0]);
					serverBuf = serverBuf.subarray(1);
					awaitSslByte = false;
					if (answer === 'S' || answer === 'G') { conn.opaque = true; opaque++; return; }
					continue;
				}
				if (serverBuf.length < 5) return;
				const len = serverBuf.readInt32BE(1);
				if (serverBuf.length < 1 + len) return;
				const type = String.fromCharCode(serverBuf[0]);
				const body = serverBuf.subarray(5, 1 + len);
				serverBuf = serverBuf.subarray(1 + len);
				if (type === 'R' && body.length >= 4 && body.readInt32BE(0) === 0 && !conn.authenticated && conn.database !== null) {
					conn.authenticated = true;
					db(conn.database).authenticated++;
				} else if (type === 'C' && conn.authenticated) db(conn.database).completed++;
				else if (type === 'Z' && conn.authenticated) {
					const status = String.fromCharCode(body[0]);
					if (status === 'I') conn.busy = false;
					else startBusy();
				}
			}
		});
	});
	await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
	return {
		port: server.address().port,
		receipt: () => ({ observer: 'crsf-pg-observer/1', connections_total: connectionsTotal, connections_opaque: opaque, databases: JSON.parse(JSON.stringify(databases)) }),
		close: () => new Promise((resolve) => { server.close(() => resolve()); for (const s of sockets) s.destroy(); })
	};
}
