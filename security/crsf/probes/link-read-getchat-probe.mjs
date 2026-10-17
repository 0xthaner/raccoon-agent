/*
	CRSF evidence probe EV-PROBE-LINK-READ (finding F-2K-1).

	Question: does GET /api/link?code=... trigger Telegram provider work
	(Bot API getChat via telegramTarget) behind only the per-IP limit, i.e.
	without a per-key (link code) and a global limit, unlike its sibling
	POST /api/link/verify (IP -> wallet-link-code -> wallet-link-verify-global)?

	Real code: api/link.mjs, src/http-security.mjs (enforceRateLimit),
	src/db.mjs (PostgREST client, check_agent_rate_limit, getPendingLink),
	src/linking.mjs (telegramTarget). Every outbound request goes to a
	recording fetch: Supabase (one valid pending link; the rate-limit RPC
	records the scope and denies according to the step) and Telegram (getChat
	is counted). Offline, no real keys. Prints one JSON line.

	Exit 0 only while the defect is observed: with every limiter scope except
	the per-IP one denied, 20 requests from 20 different IPs with one valid
	code still make 20 getChat calls, and only the per-IP scope runs before
	each. Control: with the per-IP scope denied there is no getChat.
*/
Object.assign(process.env, { TELEGRAM_BOT_TOKEN: 'probe-token', SUPABASE_URL: 'https://supabase.probe.invalid', SUPABASE_SECRET_KEY: 'probe-secret-key', DASHBOARD_SESSION_SECRET: 'crsf-probe-link-read-secret-0123456789abcdef', APP_BASE_URL: 'https://coverraccoon.com' });

const CODE = 'AbCdEfGhIjKlMnOpQrStUv01';
let trace = [];
let admit = () => true;
globalThis.fetch = async (url, options = {}) => {
	const u = new URL(String(url));
	if (u.host === 'supabase.probe.invalid') {
		if (u.pathname === '/rest/v1/rpc/check_agent_rate_limit') { const scope = JSON.parse(options.body).rate_key.split(':')[0]; const ok = admit(scope); trace.push(`limit ${scope} ${ok ? 'admit' : 'DENY'}`); return Response.json(ok); }
		if (u.pathname.includes('/rpc/')) return Response.json(true);
		if (u.pathname === '/rest/v1/pending_links') { trace.push('DB pending_links'); return Response.json({ code: CODE, chat_id: '4242', nonce: 'n'.repeat(16), expires_at: Date.now() + 300_000, used_at: null }); }
		return (options.method ?? 'GET') === 'GET' ? Response.json([]) : new Response(null, { status: 201 });
	}
	if (u.host === 'api.telegram.org' && u.pathname.endsWith('/getChat')) { trace.push('PROVIDER telegram getChat'); return Response.json({ ok: true, result: { id: 4242, type: 'private', first_name: 'Probe' } }); }
	throw new Error(`unexpected outbound request to ${u.host}`);
};
const { default: handler } = await import('../../../api/link.mjs');

async function get(ip) {
	const r = { code: null, setHeader() {}, status(c) { this.code = c; return this; }, json() { return this; } };
	await handler({ method: 'GET', url: `/api/link?code=${CODE}`, headers: { 'x-forwarded-for': ip } }, r);
	return r.code;
}
const observation = { question: 'F-2K-1', steps: {} };
trace = []; admit = (scope) => scope !== 'wallet-link-read';
observation.steps.control_ip_denied = { status: await get('198.51.100.1'), getchat: trace.filter((t) => t.startsWith('PROVIDER')).length, trace };
trace = []; admit = (scope) => scope === 'wallet-link-read';
const statuses = [];
for (let i = 0; i < 20; i++) statuses.push(await get(`198.51.100.${i + 10}`));
const before = [...new Set(trace.filter((t) => t.startsWith('limit ')))];
observation.steps.rotating_ips_all_non_ip_scopes_denied = { requests: 20, statuses: [...new Set(statuses)], getchat: trace.filter((t) => t.startsWith('PROVIDER')).length, distinct_limits_seen: before };
const s = observation.steps;
observation.controls_ok = s.control_ip_denied.status === 429 && s.control_ip_denied.getchat === 0;
observation.getchat_without_per_key_or_global_limit = s.rotating_ips_all_non_ip_scopes_denied.getchat === 20 && before.length === 1 && before[0] === 'limit wallet-link-read admit';
process.stdout.write(JSON.stringify(observation) + '\n');
process.exitCode = observation.controls_ok && observation.getchat_without_per_key_or_global_limit ? 0 : 1;
