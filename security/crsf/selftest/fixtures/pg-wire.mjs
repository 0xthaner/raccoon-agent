// CRSF Phase 2U self-test helper: a minimal Postgres wire client (startup, simple query). No dependency.
import net from 'node:net';

export function connectPg(url) {
	const u = new URL(url);
	return new Promise((resolve, reject) => {
		const sock = net.connect(Number(u.port || 5432), u.hostname);
		let buf = Buffer.alloc(0), waiting = null;
		const params = Buffer.from(`user\0${decodeURIComponent(u.username || 'postgres')}\0database\0${u.pathname.slice(1) || 'postgres'}\0\0`);
		const start = Buffer.alloc(8); start.writeInt32BE(8 + params.length, 0); start.writeInt32BE(196608, 4);
		sock.on('error', (e) => (waiting ? waiting.reject(e) : reject(e)));
		sock.on('data', (chunk) => {
			buf = Buffer.concat([buf, chunk]);
			while (buf.length >= 5 && buf.length >= 1 + buf.readInt32BE(1)) {
				const type = String.fromCharCode(buf[0]);
				buf = buf.subarray(1 + buf.readInt32BE(1));
				if (type === 'Z' && waiting) { const w = waiting; waiting = null; w.resolve(); }
				if (type === 'E' && waiting) { const w = waiting; waiting = null; w.reject(new Error('server error')); }
			}
		});
		const client = {
			query(text) {
				return new Promise((res, rej) => {
					waiting = { resolve: res, reject: rej };
					const body = Buffer.from(`${text}\0`);
					const m = Buffer.alloc(5); m.write('Q', 0, 'latin1'); m.writeInt32BE(4 + body.length, 1);
					sock.write(Buffer.concat([m, body]));
				});
			},
			end() { const x = Buffer.alloc(5); x.write('X', 0, 'latin1'); x.writeInt32BE(4, 1); sock.end(x); }
		};
		waiting = { resolve: () => resolve(client), reject };
		sock.write(Buffer.concat([start, params]));
	});
}
