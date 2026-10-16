/*
	CRSF evidence probe EV-PROBE-TG-COVERS (finding F-2I-1).

	Question: do the Telegram cover entry points - the /covers command, the
	show_covers callback button and the cover AI intents (show_covers,
	show_next_expiry) - reach the cover provider lookup (getWalletCovers:
	Alchemy NFT index, Nexus, getCovers RPC) without a per-chat and a global
	cover budget, once per linked wallet?

	Real code: src/bot.mjs handleUpdate (commands, callbacks, the local intent
	classifier, the AI per-chat/global limiter of src/ai-budget.mjs), src/db.mjs
	(PostgREST client, check_agent_rate_limit), src/covers.mjs and
	src/cover-chain.mjs up to the wire. Every outbound request goes to a
	recording fetch: Supabase (linked wallets, rate-limit RPC that records the
	limiter scope and denies the step's scope), Telegram, Alchemy NFT index,
	Nexus. No OpenAI key, so the AI route uses the local classifier after the
	real AI limiter. Offline, no real keys. Prints one JSON line.

	History: in CRSF Phase 2J (before the fix) this probe reproduced the defect
	(recorded as a VIOLATION of CR-RESOURCE-007 P1): every entry point made one
	lookup per linked wallet (1 -> 1, 10 -> 10) with no limiter before it except
	the AI budgets on the AI route. Fixed in Phase 2J; since then it is a
	regression proof and exits 0 only when, for every entry point and 1 and 10
	linked wallets,
	- with the chat budget or the global cover budget denied: 0 cover lookups;
	- with both admitting: exactly one lookup per wallet, and both budgets were
	  charged once per wallet before the first lookup.
	A reintroduced bypass makes it exit 1 and the evidence FAIL.
*/
const KEYS = { TELEGRAM_BOT_TOKEN: 'probe-token', TELEGRAM_BOT_USERNAME: 'RaccoonAgentBot', TELEGRAM_WEBHOOK_SECRET: 'probe-webhook-secret', SUPABASE_URL: 'https://supabase.probe.invalid', SUPABASE_SECRET_KEY: 'probe-secret-key', DASHBOARD_SESSION_SECRET: 'crsf-probe-tg-covers-secret-0123456789abcdef', APP_BASE_URL: 'https://coverraccoon.com', ALCHEMY_API_KEY: 'probe-alchemy-key', VERCEL: '1' };
Object.assign(process.env, KEYS);
delete process.env.OPENAI_API_KEY;
delete process.env.DEMO_WALLET;

const CHAT = 4242;
let wallets = [];
let trace = [];
let deny = null;
globalThis.fetch = async (url, options = {}) => {
	const u = new URL(String(url));
	if (u.host === 'supabase.probe.invalid') {
		if (u.pathname === '/rest/v1/rpc/check_agent_rate_limit') { const scope = JSON.parse(options.body).rate_key.split(':')[0]; trace.push(`limit ${scope}`); return Response.json(scope !== deny); }
		if (u.pathname.includes('/rpc/')) return Response.json(true);
		if ((options.method ?? 'GET') !== 'GET') return new Response(null, { status: 201 });
		if (u.pathname === '/rest/v1/monitored_wallets') return Response.json(wallets);
		if (u.pathname === '/rest/v1/user_preferences') return Response.json({ language: 'de' });
		return Response.json([]);
	}
	if (u.host === 'api.telegram.org') return Response.json({ ok: true, result: { message_id: 1 } });
	if (u.host === 'eth-mainnet.g.alchemy.com' && u.pathname.includes('/nft/v3/')) { trace.push('PROVIDER cover lookup'); return Response.json({ ownedNfts: [], totalCount: 0 }); }
	if (u.host === 'api.nexusmutual.io') return Response.json([]);
	throw new Error(`unexpected outbound request to ${u.host}`);
};

const { handleUpdate } = await import('../../../src/bot.mjs');
let updateId = 1;
const from = { id: CHAT, is_bot: false, first_name: 'Probe' };
const chat = { id: CHAT, type: 'private' };
const ENTRY = {
	command: () => ({ message: { message_id: 1, date: Math.floor(Date.now() / 1000), chat, from, text: '/covers' } }),
	callback: () => ({ callback_query: { id: `q${updateId}`, from, data: 'show_covers', message: { message_id: 2, chat } } }),
	ai_show_covers: () => ({ message: { message_id: 3, date: Math.floor(Date.now() / 1000), chat, from, text: 'zeig meine covers' } }),
	ai_next_expiry: () => ({ message: { message_id: 4, date: Math.floor(Date.now() / 1000), chat, from, text: 'wann läuft mein nächstes cover ab?' } })
};
const wallet = (i) => ({ chat_id: String(CHAT), wallet: `0x${(i + 1).toString(16).padStart(40, '0')}`, label: `W${i + 1}`, is_primary: i === 0, linked_at: '2026-10-01T00:00:00Z' });

const observation = { question: 'F-2I-1', runs: {} };
const pairs = (n) => Array.from({ length: n }, () => ['telegram-cover-chat', 'dashboard-read-global']).flat();
for (const n of [1, 10]) {
	wallets = Array.from({ length: n }, (_, i) => wallet(i));
	for (const [name, make] of Object.entries(ENTRY)) {
		for (const step of [null, 'telegram-cover-chat', 'dashboard-read-global']) {
			trace = []; deny = step;
			await handleUpdate({ update_id: updateId++, ...make() });
			const first = trace.indexOf('PROVIDER cover lookup');
			observation.runs[`${name}_${n}_wallets_${step ? `${step}_denied` : 'admitted'}`] = { linked_wallets: n, denied: step, cover_lookups: trace.filter((t) => t === 'PROVIDER cover lookup').length,
				cover_limits_before_first_lookup: (first < 0 ? trace : trace.slice(0, first)).filter((t) => t.startsWith('limit ') && !t.startsWith('limit ai-')).map((t) => t.slice(6)) };
		}
	}
}
const runs = Object.values(observation.runs);
observation.denied_reaches_no_provider = runs.filter((r) => r.denied).every((r) => r.cover_lookups === 0);
observation.admitted_one_lookup_per_wallet = runs.filter((r) => !r.denied).every((r) => r.cover_lookups === r.linked_wallets);
observation.both_budgets_per_wallet_before_lookup = runs.filter((r) => !r.denied).every((r) => JSON.stringify(r.cover_limits_before_first_lookup) === JSON.stringify(pairs(r.linked_wallets)));
process.stdout.write(JSON.stringify(observation) + '\n');
process.exitCode = observation.denied_reaches_no_provider && observation.admitted_one_lookup_per_wallet && observation.both_budgets_per_wallet_before_lookup ? 0 : 1;
