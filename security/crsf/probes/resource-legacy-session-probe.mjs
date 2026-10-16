/*
	CRSF evidence probe EV-PROBE-LEGACY-RPC (finding F-2F-1, CRSF Phase 2F).

	Question: on the dashboard action paths, does the provider work of
	freshAuthorityRequired (noContractCodeByQuorum: eth_getCode at Alchemy AND
	Infura) run before the per-wallet and global rate limits?

	The real api/dashboard.mjs handler runs with the real request guards of
	src/http-security.mjs; only the limiter store and the provider call are
	recording stubs. The limiter ADMITS per-IP keys and DENIES every per-wallet
	and global key, i.e. the situation in which CR-RESOURCE-001 requires that
	no provider work happens any more. Offline, no keys, prints one JSON line.

	Exit 0 only while the recorded defect is observed (a legacy session without
	`kind` reaches the provider although every wallet/global budget is
	exhausted) AND the control behaves normally (a session with kind never
	reaches the provider). Once fixed, this probe exits 1 and the VIOLATION
	record in evidence.json must be revisited - it cannot go stale.
*/
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { isAddress } from 'viem';

process.env.DASHBOARD_SESSION_SECRET = 'crsf-probe-legacy-rpc-secret-0123456789abcdef';
process.env.APP_BASE_URL = 'https://coverraccoon.com';
const auth = await import('../../../src/dashboard-auth.mjs');
const { siweOrigin } = await import('../../../src/siwe-auth.mjs');
const { queryParams, singleQueryValue } = await import('../../../src/request-query.mjs');

const WALLET = '0x' + 'a1'.repeat(20);
const strip = (file) => readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8').replace(/^import [^;]*;\n/gm, '');
const SECURITY_EVENT = new Proxy({}, { get: (_t, k) => String(k) });

function world() {
	const trace = [];
	const checkRateLimit = async (key) => { const admitted = !/-wallet:|-global:/.test(key); trace.push(`limit ${key.split(':')[0]} ${admitted ? 'admit' : 'DENY'}`); return admitted; };
	const http = new Function('createHmac', 'checkRateLimit', 'dashboardSecretConfigured', 'siweOrigin', 'recordSecurityEvent', 'SECURITY_EVENT',
		`${strip('src/http-security.mjs').replace(/^export /gm, '')}\nreturn { bodyTooLarge, enforceRateLimit, enforceRateLimitFor, requireJson, requireSameOrigin };`)(
		createHmac, checkRateLimit, auth.dashboardSecretConfigured, siweOrigin, async () => {}, SECURITY_EVENT);
	const deps = {
		isAddress, queryParams, singleQueryValue, ...auth, ...http,
		noContractCodeByQuorum: async () => { trace.push('PROVIDER eth_getCode x2'); return false; },
		verifyWalletSiweAuthority: async () => { trace.push('PROVIDER verify'); return { result: 'INVALID_SIGNATURE', authority: null }; },
		verifyOnchainDashboardLoginApproval: async () => { trace.push('PROVIDER onchain'); return 'RPC_UNAVAILABLE'; },
		isDeployedContract: async () => { trace.push('PROVIDER isDeployedContract'); return false; },
		getWalletCovers: async () => { trace.push('PROVIDER covers'); return { covers: [] }; },
		getWalletLinkStateByWallet: async () => ({ linked: false, link: null }),
		isDashboardSessionRevoked: async () => false, consumeDashboardChallenge: async () => false, isDashboardChallengeOpen: async () => false,
		storeDashboardChallenge: async () => { trace.push('DB store challenge'); }, consumeDashboardAccess: async () => null,
		recordAgentEvent: async () => {}, getLanguage: async () => 'de', beginTelegramDelivery: async () => null, finishTelegramDelivery: async () => {},
		revokeDashboardSessions: async () => { trace.push('DB revoke'); return Date.now(); }, unlinkWalletByWallet: async () => [], unlinkWalletFromAllChats: async () => [],
		ANMELDUNG_PAUSIERT: false, pauseAntwort: () => {}, recordSecurityEvent: async () => {}, securityFingerprint: () => 'fp', SECURITY_EVENT
	};
	const source = strip('api/dashboard.mjs').replace(/export default async function handler/, 'async function handler').replace(/^export /gm, '');
	return { handler: new Function(...Object.keys(deps), `${source}\nreturn handler;`)(...Object.values(deps)), trace };
}

function legacyCookie() {
	const now = Date.now();
	const payload = Buffer.from(JSON.stringify({ type: 'session', wallet: WALLET, iat: now, exp: now + 3_600_000 })).toString('base64url');
	return `${auth.SESSION_COOKIE}=${encodeURIComponent(`${payload}.${createHmac('sha256', process.env.DASHBOARD_SESSION_SECRET).update(payload).digest('base64url')}`)}`;
}
const kindCookie = (kind) => `${auth.SESSION_COOKIE}=${encodeURIComponent(auth.createDashboardSession(WALLET, Date.now(), kind))}`;
const headers = (cookie) => ({ cookie, origin: 'https://coverraccoon.com', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.23' });
const res = () => ({ code: null, setHeader() {}, status(c) { this.code = c; return this; }, json() { return this; } });

async function run(method, cookie, body) {
	const w = world();
	const r = res();
	await w.handler({ method, url: '/api/dashboard', headers: headers(cookie), body }, r);
	const provider = w.trace.findIndex((t) => t.startsWith('PROVIDER'));
	return { status: r.code, trace: w.trace, provider_reached: provider >= 0, wallet_or_global_limit_before_provider: provider >= 0 && w.trace.slice(0, provider).some((t) => / DENY$/.test(t)) };
}

const observation = { question: 'F-2F-1', paths: {} };
observation.paths.action_legacy = await run('POST', legacyCookie(), { action: 'session-revoke' });
observation.paths.delete_legacy = await run('DELETE', legacyCookie(), undefined);
observation.paths.action_kind_eoa = await run('POST', kindCookie('eoa'), { action: 'session-revoke' });
observation.paths.action_kind_contract = await run('POST', kindCookie('contract'), { action: 'session-revoke' });
const p = observation.paths;
observation.controls_ok = !p.action_kind_eoa.provider_reached && !p.action_kind_contract.provider_reached;
observation.provider_work_before_wallet_and_global_limits = [p.action_legacy, p.delete_legacy].some((x) => x.provider_reached && !x.wallet_or_global_limit_before_provider);
process.stdout.write(JSON.stringify(observation) + '\n');
process.exitCode = observation.controls_ok && observation.provider_work_before_wallet_and_global_limits ? 0 : 1;
