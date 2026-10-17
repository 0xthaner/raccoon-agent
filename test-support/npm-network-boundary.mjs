/*
	CRSF Phase 2S: Netzgrenze fuer den Registry-Signatur-Test. Wird per
	NODE_OPTIONS=--import in JEDEN Node-Prozess geladen (npm und alles, was es
	startet). Erlaubt sind nur die beiden freigegebenen Lese-Ziele und Loopback;
	jede andere Verbindung wird abgelehnt. Jeder Versuch wird in CRSF_NET_LOG
	protokolliert ("ALLOW host:port" / "DENY host:port"), damit der Test ihn prueft.
*/
import net from 'node:net';
import { appendFileSync } from 'node:fs';

export const ALLOWED_HOSTS = ['tuf-repo-cdn.sigstore.dev', 'registry.npmjs.org'];
const ALLOW = new Set([...ALLOWED_HOSTS, '127.0.0.1', 'localhost', '::1']);
const LOG = process.env.CRSF_NET_LOG;
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
	const first = Array.isArray(args[0]) ? args[0][0] : args[0];
	const o = typeof first === 'object' && first ? first : { port: first, host: typeof args[1] === 'string' ? args[1] : 'localhost' };
	if (o.path) return connect.apply(this, args);
	const host = o.host ?? 'localhost';
	const ok = ALLOW.has(host);
	if (LOG) appendFileSync(LOG, `${ok ? 'ALLOW' : 'DENY'} ${host}:${o.port}\n`);
	if (ok) return connect.apply(this, args);
	queueMicrotask(() => this.destroy(Object.assign(new Error(`CRSF network boundary: ${host} is not allowed`), { code: 'ECONNREFUSED' })));
	return this;
};
