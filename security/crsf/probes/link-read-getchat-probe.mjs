/*
	CRSF evidence probe EV-PROBE-LINK-READ (finding F-2K-1, CR-RESOURCE-001 P5).

	History: in Phase 2K this probe reproduced F-2K-1 - GET /api/link?code=...
	called Telegram getChat (telegramTarget, with the bot token) behind only the
	per-IP limit wallet-link-read; 20 requests from 20 IPs with one valid code made
	20 getChat calls with every non-IP limiter scope denied. Fixed in Phase 2L;
	the probe is now a regression proof.

	Real code: api/link.mjs, src/http-security.mjs (enforceRateLimit[For]),
	src/db.mjs (PostgREST client, check_agent_rate_limit, getPendingLink),
	src/linking.mjs (telegramTarget). Every outbound request goes to a recording
	fetch: Supabase (one valid pending link; the rate-limit RPC counts per key in a
	fixed window like check_agent_rate_limit and denies the step's scope) and
	Telegram (getChat is counted). Offline, no real keys. Prints one JSON line.

	Exit 0 only when: IP, per-code and global denial each yield 0 getChat; 20
	requests from 20 IPs with one valid code make at most the per-code budget of
	getChat calls (and some are refused); an admitted request answers 200 with the
	Telegram target after exactly one getChat. Reintroducing the defect fails it.
*/
Object.assign(process.env, { TELEGRAM_BOT_TOKEN: 'probe-token', SUPABASE_URL: 'https://supabase.probe.invalid', SUPABASE_SECRET_KEY: 'probe-secret-key', DASHBOARD_SESSION_SECRET: 'crsf-probe-link-read-secret-0123456789abcdef', APP_BASE_URL: 'https://coverraccoon.com' });

const CODE = 'AbCdEfGhIjKlMnOpQrStUv01';
const PER_CODE_BOUND = 10;
let trace = [];
let counts = new Map();
let deny = null;
globalThis.fetch = async (url, options = {}) => {
	const u = new URL(String(url));
	if (u.host === 'supabase.probe.invalid') {
		if (u.pathname === '/rest/v1/rpc/check_agent_rate_limit') {
			const { rate_key: key, max_requests: max } = JSON.parse(options.body);
			const scope = key.split(':')[0];
			const n = (counts.get(key) ?? 0) + 1;
			counts.set(key, n);
			const ok = scope !== deny && n <= max;
			trace.push(`limit ${scope} ${ok ? 'admit' : 'DENY'}`);
			return Response.json(ok);
		}
		if (u.pathname.includes('/rpc/')) return Response.json(true);
		if (u.pathname === '/rest/v1/pending_links') { trace.push('DB pending_links'); return Response.json([{ code: CODE, chat_id: '4242', nonce: 'n'.repeat(16), expires_at: new Date(Date.now() + 300_000).toISOString(), used_at: null }]); }
		return (options.method ?? 'GET') === 'GET' ? Response.json([]) : new Response(null, { status: 201 });
	}
	if (u.host === 'api.telegram.org' && u.pathname.endsWith('/getChat')) { trace.push('PROVIDER telegram getChat'); return Response.json({ ok: true, result: { id: 4242, type: 'private', first_name: 'Probe' } }); }
	throw new Error(`unexpected outbound request to ${u.host}`);
};
const { default: handler } = await import('../../../api/link.mjs');

async function get(ip) {
	const r = { code: null, body: null, setHeader() {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
	await handler({ method: 'GET', url: `/api/link?code=${CODE}`, headers: { 'x-forwarded-for': ip } }, r);
	return r;
}
const getchat = () => trace.filter((t) => t.startsWith('PROVIDER')).length;
const fresh = (scope) => { trace = []; counts = new Map(); deny = scope; };
const observation = { question: 'F-2K-1 regression', steps: {} };
for (const [step, scope] of [['ip_denied', 'wallet-link-read'], ['code_denied', 'wallet-link-read-code'], ['global_denied', 'wallet-link-read-global']]) {
	fresh(scope);
	const r = await get('198.51.100.1');
	observation.steps[step] = { status: r.code, getchat: getchat(), trace };
}
fresh(null);
const admitted = await get('198.51.100.2');
observation.steps.admitted = { status: admitted.code, telegram: Boolean(admitted.body?.telegram), getchat: getchat(), limits_before_getchat: trace.slice(0, trace.indexOf('PROVIDER telegram getChat')).filter((t) => t.startsWith('limit wallet-link')) };
fresh(null);
const statuses = [];
for (let i = 0; i < 20; i++) statuses.push((await get(`198.51.100.${i + 10}`)).code);
observation.steps.rotating_ips_same_code = { requests: 20, getchat: getchat(), refused: statuses.filter((s) => s === 429).length, bound: PER_CODE_BOUND };
const s = observation.steps;
observation.denials_block_getchat = ['ip_denied', 'code_denied', 'global_denied'].every((k) => s[k].status === 429 && s[k].getchat === 0);
observation.admitted_works = s.admitted.status === 200 && s.admitted.telegram && s.admitted.getchat === 1
	&& JSON.stringify(s.admitted.limits_before_getchat) === JSON.stringify(['limit wallet-link-read admit', 'limit wallet-link-read-code admit', 'limit wallet-link-read-global admit']);
observation.rotating_ip_bounded = s.rotating_ips_same_code.getchat <= PER_CODE_BOUND && s.rotating_ips_same_code.refused > 0;
process.stdout.write(JSON.stringify(observation) + '\n');
process.exitCode = observation.denials_block_getchat && observation.admitted_works && observation.rotating_ip_bounded ? 0 : 1;
