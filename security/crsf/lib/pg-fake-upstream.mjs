/*
	CRSF Phase 2U: a minimal Postgres wire-protocol server for the framework
	self-test ONLY. It lets the self-test exercise the observer and the spoofing
	fixtures without a real database. The executor starts it only when the runner
	asks for it on stdin, and every receipt then carries upstream "selftest-fake",
	which the engine never credits as real-system evidence.

	Behaviour: trust authentication (AuthenticationOk, ReadyForQuery I); every
	simple query is answered after `delayMs` with CommandComplete and
	ReadyForQuery - "T" after BEGIN, "I" after COMMIT/ROLLBACK, else unchanged.
*/
import net from 'node:net';

const msg = (type, body) => { const b = Buffer.alloc(5 + body.length); b.write(type, 0, 'latin1'); b.writeInt32BE(4 + body.length, 1); body.copy(b, 5); return b; };
const int32 = (n) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
const cstr = (s) => Buffer.from(`${s}\0`, 'utf8');

export async function startFakeUpstream({ delayMs = 40 } = {}) {
	const sockets = new Set();
	const server = net.createServer((sock) => {
		sockets.add(sock);
		let buf = Buffer.alloc(0), startup = true, tx = 'I';
		sock.on('error', () => {});
		sock.on('close', () => sockets.delete(sock));
		sock.on('data', (chunk) => {
			buf = Buffer.concat([buf, chunk]);
			for (;;) {
				if (startup) {
					if (buf.length < 8) return;
					const len = buf.readInt32BE(0);
					if (buf.length < len) return;
					const code = buf.readInt32BE(4);
					buf = buf.subarray(len);
					if (code === 80877103) { sock.write('N'); continue; }
					startup = false;
					sock.write(Buffer.concat([msg('R', int32(0)), msg('Z', Buffer.from('I'))]));
					continue;
				}
				if (buf.length < 5) return;
				const len = buf.readInt32BE(1);
				if (buf.length < 1 + len) return;
				const type = String.fromCharCode(buf[0]);
				const text = buf.subarray(5, len).toString('utf8').replace(/\0$/, '').trim().toUpperCase();
				buf = buf.subarray(1 + len);
				if (type === 'X') { sock.end(); return; }
				if (type !== 'Q') continue;
				if (text.startsWith('BEGIN')) tx = 'T'; else if (text.startsWith('COMMIT') || text.startsWith('ROLLBACK')) tx = 'I';
				const reply = Buffer.concat([msg('C', cstr(text.split(/\s+/)[0] || 'SELECT')), msg('Z', Buffer.from(tx))]);
				setTimeout(() => { if (!sock.destroyed) sock.write(reply); }, delayMs);
			}
		});
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	return { port: server.address().port, close: () => new Promise((resolve) => { server.close(() => resolve()); for (const s of sockets) s.destroy(); }) };
}
