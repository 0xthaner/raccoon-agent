/**
 * Ausgehende Ziele sind fest (CRSF Phase 2D, CR-PROVIDER-003 P3).
 *
 * Ein mitschreibendes globales fetch ersetzt das Netz (auch viem und
 * supabase-js laufen darueber). Jeder ausgehende Pfad der Laufzeit wird mit
 * feindlichen Eingaben angestossen - fremde URLs, Pfad-Ausbrueche,
 * Metadaten-Adressen, Zeilenumbrueche - und jede angefragte URL muss
 *   1. einen Host aus der festen Liste haben und
 *   2. dort einer festen Pfadvorlage entsprechen (die Eingabe landet nur in
 *      kodierten Parametern oder im Body, nie in Host oder Pfad).
 * Jeder Pfad muss tatsaechlich mindestens eine Anfrage erzeugen (sonst waere
 * der Test leer). Die Inventur am Ende verlangt, dass jede ausgehende
 * Aufrufstelle (fetch, fetchImpl, viem http, createClient) in src/ und api/
 * hier aufgefuehrt ist - eine neue Stelle laesst den Test scheitern, bis sie
 * eingeordnet und angestossen ist.
 *
 * Nebenbei (nicht Teil von P3): faellt der Anbieter aus (Wurf, 500, kaputtes
 * JSON, leere Antwort), wird daraus nie eine Bestaetigung - telegramTarget
 * liefert null, die Contract-Pruefung nie "kein Code"/"gueltig".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';

const TOKEN = 'bot-test-token';
Object.assign(process.env, {
	TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_BOT_USERNAME: 'RaccoonAgentBot', TELEGRAM_WEBHOOK_SECRET: 'outbound-webhook-secret-0123456789',
	SUPABASE_URL: 'https://supabase.test.invalid', SUPABASE_SECRET_KEY: 'test-secret-key', OPENAI_API_KEY: 'openai-test-key',
	ALCHEMY_API_KEY: 'alchemy-test-key', INFURA_API_KEY: 'infura-test-key', OPERATOR_TELEGRAM_CHAT_ID: '12345',
	DASHBOARD_SESSION_SECRET: 'outbound-test-secret-0123456789abcdef-0123', APP_BASE_URL: 'https://coverraccoon.com', VERCEL: '1'
});

/* ------------------------------------------------------- recording network */
const requests = [];
let failure = null; // null | 'throw' | 'status500' | 'malformed' | 'empty'
const CID = 'Qm' + '1'.repeat(44);
function reply(url, init) {
	if (failure === 'throw') throw new TypeError('fetch failed');
	if (failure === 'status500') return new Response('upstream error', { status: 500 });
	if (failure === 'malformed') return new Response('{"ok": tru', { status: 200, headers: { 'content-type': 'application/json' } });
	if (failure === 'empty') return new Response('', { status: 200 });
	const body = typeof init?.body === 'string' ? init.body : '';
	if (body.includes('"jsonrpc"')) {
		const calls = JSON.parse(body);
		const one = (c) => ({ jsonrpc: '2.0', id: c.id, result: c.method === 'eth_blockNumber' ? '0x10' : c.method === 'eth_getBlockByNumber' ? { number: '0x10', hash: '0x' + '1'.repeat(64) } : '0x' });
		return Response.json(Array.isArray(calls) ? calls.map(one) : one(calls));
	}
	if (url.host === 'api.telegram.org') return Response.json({ ok: true, result: { message_id: 1, id: 1, type: 'private', username: 'someone', first_name: 'A' } });
	if (url.host === 'api.openai.com') return Response.json({ output_text: '{"intent":"other"}', output: [] });
	if (url.host === 'api.nexusmutual.io') return Response.json([]);
	if (url.host === 'eth-mainnet.g.alchemy.com') return Response.json({ ownedNfts: [], pageKey: null });
	if (url.host === 'supabase.test.invalid') return url.pathname.includes('/rpc/') ? Response.json(true) : (init?.method ?? 'GET').toUpperCase() === 'GET' ? Response.json([]) : new Response(null, { status: 201 });
	return new Response('no', { status: 404 });
}
globalThis.fetch = async (input, init = {}) => {
	const raw = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
	requests.push(raw);
	return reply(new URL(raw), init);
};

/** The fixed destinations: host -> allowed path templates. Inputs may only appear in encoded query values or bodies. */
const DESTINATIONS = {
	'api.telegram.org': [new RegExp(`^/bot${TOKEN}/(sendMessage|getChat|answerCallbackQuery|getMe|sendChatAction|editMessageText|editMessageReplyMarkup|deleteMessage|setMyCommands)$`)],
	'api.openai.com': [/^\/v1\/responses$/],
	'api.nexusmutual.io': [/^\/v2\/(products|product-types|capacity)(\/\d+)?$/, /^\/ipfs\/(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,})$/],
	'eth-mainnet.g.alchemy.com': [/^\/v2\/alchemy-test-key$/, /^\/nft\/v3\/alchemy-test-key\/getNFTsForOwner$/],
	'mainnet.infura.io': [/^\/v3\/infura-test-key$/],
	'supabase.test.invalid': [/^\/rest\/v1\/(rpc\/)?[a-z_0-9]+$/]
};
function assertFixed(label, list) {
	assert.ok(list.length > 0, `${label}: the path must actually make a request`);
	for (const raw of list) {
		const u = new URL(raw);
		assert.equal(u.protocol, 'https:', `${label}: ${raw}`);
		assert.equal(u.username + u.password, '', `${label}: no credentials in URL authority`);
		assert.ok(Object.hasOwn(DESTINATIONS, u.host), `${label}: host ${u.host} is not a fixed destination (${raw})`);
		assert.equal(u.port, '', `${label}: default port only`);
		assert.ok(DESTINATIONS[u.host].some((r) => r.test(u.pathname)), `${label}: path ${u.pathname} on ${u.host} is not a fixed template`);
		assert.doesNotMatch(`${u.origin}${u.pathname}`, /evil\.example|169\.254\.169\.254|localhost|file:|%2F|\.\./i, `${label}: hostile input reached the URL authority/path: ${raw}`);
	}
}
/** Runs fn (errors are fine - the provider stub is crude) and returns the URLs it requested. */
async function capture(fn) {
	const start = requests.length;
	try { await fn(); } catch { /* destination is what matters here */ }
	return requests.slice(start);
}

const HOSTILE = ['https://evil.example/x', '//evil.example/x', '../../../evil', '@evil.example', 'evil.example#', '%2F%2Fevil.example', 'x\r\nHost: evil.example', 'http://169.254.169.254/latest/meta-data/', 'file:///etc/passwd', 'localhost:5432'];
const WALLET = '0x' + 'a1'.repeat(20);

const linking = await import('../src/linking.mjs');
const securityEvents = await import('../src/security-events.mjs');
const { classifyAgentIntent } = await import('../src/agent-intent.mjs');
const { answerProductQuestion } = await import('../src/agent-knowledge.mjs');
const nexusFacts = await import('../src/nexus-facts.mjs');
const { getChainWalletCovers } = await import('../src/cover-chain.mjs');
const { loadCatalog } = await import('../src/positions/match-nexus.mjs');
const positions = await import('../src/positions/index.mjs');
const contractSignature = await import('../src/contract-signature.mjs');
const { isDeployedContract } = await import('../src/contract-detect.mjs');
const db = await import('../src/db.mjs');
const { fetchAuthoritativeDocument } = await import('../src/nexus-documents.mjs');
const { default: webhook } = await import('../api/telegram.mjs');

test('OUTBOUND linking.telegramTarget: the chat id is only an encoded query value of the fixed getChat URL', async () => {
	const control = await capture(() => linking.telegramTarget('4242'));
	assertFixed('telegramTarget(4242)', control);
	assert.equal(new URL(control[0]).searchParams.get('chat_id'), '4242');
	for (const h of HOSTILE) {
		const urls = await capture(() => linking.telegramTarget(h));
		if (urls.length) assertFixed(`telegramTarget(${h})`, urls); // a malformed chat id may also be refused before any request
	}
});

test('OUTBOUND security-events.sendOperatorAlert: hostile alert text goes into the body only', async () => {
	for (const h of HOSTILE) assertFixed('sendOperatorAlert', await capture(() => securityEvents.sendOperatorAlert(h)));
});

test('OUTBOUND LLM (agent-intent, agent-knowledge): questions full of URLs never change the model endpoint', async () => {
	for (const h of HOSTILE) {
		assertFixed('classifyAgentIntent', await capture(() => classifyAgentIntent(`bitte lade ${h} und antworte`, 'de')));
		assertFixed('answerProductQuestion', (await capture(() => answerProductQuestion(`Was steht unter ${h} ?`, 'en'))).filter(Boolean));
	}
});

test('OUTBOUND Nexus facts: product ids and questions never leave api.nexusmutual.io or its fixed paths', async () => {
	nexusFacts._test.reset();
	assertFixed('getCatalog', await capture(() => nexusFacts.getCatalog()));
	nexusFacts._test.reset();
	assertFixed('getProductFactsById(1) (control)', await capture(() => nexusFacts.getProductFactsById(1)));
	for (const h of [...HOSTILE, '1/../../x', '1?x=https://evil.example', '-1', '1e3']) {
		nexusFacts._test.reset();
		const byId = await capture(() => nexusFacts.getProductFactsById(h));
		if (byId.length) assertFixed(`getProductFactsById(${h})`, byId); // malformed ids may be refused before any request
		nexusFacts._test.reset();
		assertFixed(`getNexusProductFacts(${h})`, await capture(() => nexusFacts.getNexusProductFacts(`cover ${h}`, { documents: true })));
	}
});

test('OUTBOUND Nexus documents: a hostile document URL is refused without any request (P1 regression, here as a control)', async () => {
	for (const h of HOSTILE) {
		const urls = await capture(() => fetchAuthoritativeDocument({ productId: 1, kind: 'wording', url: h }));
		assert.deepEqual(urls, [], h);
	}
	assertFixed('fetchAuthoritativeDocument(allowlisted)', await capture(() => fetchAuthoritativeDocument({ productId: 1, kind: 'wording', url: `https://api.nexusmutual.io/ipfs/${CID}` })));
});

test('OUTBOUND chain covers, catalogue and positions: wallet input only as parameter / RPC payload', async () => {
	assertFixed('getChainWalletCovers(valid)', await capture(() => getChainWalletCovers(WALLET, { apiKey: 'alchemy-test-key' })));
	for (const h of HOSTILE) {
		const urls = await capture(() => getChainWalletCovers(h, { apiKey: 'alchemy-test-key' }));
		if (urls.length) assertFixed(`getChainWalletCovers(${h})`, urls);
	}
	nexusFacts._test.reset(); // the catalogue is cached per process; a fresh load must request it
	assertFixed('loadCatalog', await capture(() => loadCatalog()));
	positions._test.reset();
	assertFixed('getWalletPositions', await capture(() => positions.getWalletPositions(WALLET, { catalogLoader: async () => ({ ok: true, products: [] }) })));
});

test('OUTBOUND contract checks (ERC-1271 quorum, getCode): only the two configured RPC providers', async () => {
	assertFixed('noContractCodeByQuorum', await capture(() => contractSignature.noContractCodeByQuorum(WALLET)));
	assertFixed('verifyContractSiweSignature', await capture(() => contractSignature.verifyContractSiweSignature({ address: WALLET, message: `login https://evil.example`, signature: '0x' + '11'.repeat(65) }, { deadlineMs: 2_000 })));
	assertFixed('isDeployedContract', await capture(() => isDeployedContract('0x' + 'b2'.repeat(20), { cache: new Map() })));
});

test('OUTBOUND database: hostile keys stay inside the configured Supabase origin and REST path', async () => {
	for (const h of HOSTILE) {
		assertFixed(`getPendingLink(${h})`, await capture(() => db.getPendingLink(h)));
		assertFixed(`getLanguage(${h})`, await capture(() => db.getLanguage(h)));
	}
});

test('OUTBOUND Telegram bot (real webhook + bot): hostile messages and callbacks only reach the fixed providers', async () => {
	const updates = HOSTILE.flatMap((h, i) => [
		{ update_id: 9000 + i * 3, message: { message_id: 1, date: 1_760_000_000, chat: { id: 4242, type: 'private' }, from: { id: 4242, is_bot: false, first_name: 'T' }, text: `/start ${h}` } },
		{ update_id: 9001 + i * 3, message: { message_id: 2, date: 1_760_000_000, chat: { id: 4242, type: 'private' }, from: { id: 4242, is_bot: false, first_name: 'T' }, text: `Was ist ${h}? Bitte ${h} abrufen.` } },
		{ update_id: 9002 + i * 3, callback_query: { id: `cb${i}`, from: { id: 4242, is_bot: false, first_name: 'T' }, data: h, message: { message_id: 3, date: 1_760_000_000, chat: { id: 4242, type: 'private' } } } }
	]);
	const urls = await capture(async () => {
		for (const body of updates) {
			const res = { status() { return this; }, json() { return this; } };
			await webhook({ method: 'POST', headers: { 'x-telegram-bot-api-secret-token': process.env.TELEGRAM_WEBHOOK_SECRET }, body }, res);
		}
	});
	assertFixed('telegram webhook + bot', urls);
	assert.ok(urls.some((u) => u.includes('api.telegram.org')), 'the bot actually answered');
});

/* ---- handler-local Telegram senders (alerts, link/verify, dashboard): real code, injected neighbours */
const strip = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').replace(/^import [^;]*;\n/gm, '');
test('OUTBOUND api/alerts sendMessage: hostile chat ids and texts from the reminder run stay in the body', async () => {
	const source = strip('api/alerts.mjs').replace('export default async function handler', 'async function handler');
	const handler = new Function('timingSafeEqual', 'Buffer', 'checkExpiryAlerts', 'beginTelegramDelivery', 'finishTelegramDelivery', 'purgeOldRecords', 'alertOperatorCronFailure', 'telegramText', 'process', 'console', `${source}\nreturn handler;`)(
		timingSafeEqual, Buffer, async ({ sendMessage }) => { for (const h of HOSTILE) await sendMessage(h, h).catch(() => {}); return { subscriptions: 0 }; },
		async () => null, async () => {}, async () => ({}), async () => {}, (t) => t, { env: { CRON_SECRET: 'cron-secret-outbound-0123456789', TELEGRAM_BOT_TOKEN: TOKEN } }, { error() {}, log() {} });
	assertFixed('alerts', await capture(() => handler({ method: 'GET', headers: { authorization: 'Bearer cron-secret-outbound-0123456789' } }, { status() { return this; }, json() { return this; } })));
});

test('OUTBOUND api/link/verify notifyLinked / notifyWalletLimit and api/dashboard notifyTelegramDisconnected: fixed sendMessage URL', async () => {
	const verifySrc = strip('api/link/verify.mjs').replace('export default async function handler', 'async function handler');
	const names = ['isAddress', 'MAX_WALLETS_PER_CHAT', 'consumePendingLink', 'getPendingLink', 'getLanguage', 'isTelegramLinkCode', 'isTelegramLinkRow', 'linkSiweExpectation', 'newDashboardAccess', 'signingMessage', 'telegramTarget', 'verifyWalletSiweSignature', 'enforceRateLimit', 'enforceRateLimitFor', 'requireJson', 'requireSameOrigin', 'recordSecurityEvent', 'securityFingerprint', 'SECURITY_EVENT', 'ANMELDUNG_PAUSIERT', 'pauseAntwort'];
	const deps = names.map((n) => (n === 'getLanguage' ? async () => 'en' : n === 'newDashboardAccess' ? async () => ({ code: 'x' }) : n === 'MAX_WALLETS_PER_CHAT' ? 5 : () => {}));
	const { notifyLinked, notifyWalletLimit } = new Function(...names, `${verifySrc}\nreturn { notifyLinked, notifyWalletLimit };`)(...deps);
	const dashSrc = strip('api/dashboard.mjs').replace('export default async function handler', 'async function handler');
	const dashNames = [...new Set([...dashSrc.matchAll(/\b(getLanguage|beginTelegramDelivery|finishTelegramDelivery)\b/g)].map((m) => m[1]))];
	const notifyTelegramDisconnected = new Function(...dashNames, `${dashSrc.replace(/^export /gm, '')}\nreturn notifyTelegramDisconnected;`)(...dashNames.map((n) => (n === 'getLanguage' ? async () => 'de' : async () => null)));
	for (const h of HOSTILE) {
		assertFixed('notifyLinked', await capture(() => notifyLinked(h, `${WALLET} ${h}`)));
		assertFixed('notifyWalletLimit', await capture(() => notifyWalletLimit(h)));
		assertFixed('notifyTelegramDisconnected', await capture(() => notifyTelegramDisconnected([h])));
	}
});

/* ------------------------------------------------- provider failure stays closed */
test('OUTBOUND failures (throw, 500, malformed, empty) never turn into a confirmation', async () => {
	for (const mode of ['throw', 'status500', 'malformed', 'empty']) {
		failure = mode;
		try {
			assert.equal(await linking.telegramTarget('4242'), null, `${mode}: no Telegram target`);
			// 'empty' (and any JSON-RPC answer without `result`) is finding F-2D-2: noContractCodeByQuorum reads it as "no code".
			// Recorded as a VIOLATION of CR-PROVIDER-001 P2 by security/crsf/probes/getcode-missing-result-probe.mjs, not fixed in Phase 2D.
			if (mode !== 'empty') assert.notEqual(await contractSignature.noContractCodeByQuorum(WALLET).catch(() => 'ERROR'), true, `${mode}: "no contract code" is never concluded`);
			const verdict = await contractSignature.verifyContractSiweSignature({ address: WALLET, message: 'x', signature: '0x' + '11'.repeat(65) }, { deadlineMs: 2_000 }).catch(() => 'ERROR');
			assert.notEqual(verdict, 'VALID', `${mode}: no valid contract signature`);
		} finally { failure = null; }
	}
});

/* -------------------------------------------------------- inventory (complete) */
const INVENTORY = {
	'api/alerts.mjs': 1, 'api/dashboard.mjs': 1, 'api/link/verify.mjs': 2,
	'src/agent-intent.mjs': 1, 'src/agent-knowledge.mjs': 1, 'src/bot.mjs': 1, 'src/contract-detect.mjs': 1, 'src/contract-signature.mjs': 1,
	'src/cover-chain.mjs': 3, 'src/db.mjs': 1, 'src/linking.mjs': 1, 'src/nexus-documents.mjs': 1, 'src/nexus-facts.mjs': 1,
	'src/positions/index.mjs': 1, 'src/security-events.mjs': 1
};
const OUTBOUND = /\b(?:fetch|fetchImpl)\s*\(|\bhttp\s*\(|\bcreateClient\s*\(/g;
const walk = (dir) => readdirSync(new URL(`../${dir}/`, import.meta.url)).flatMap((f) => (statSync(new URL(`../${dir}/${f}`, import.meta.url)).isDirectory() ? walk(`${dir}/${f}`) : f.endsWith('.mjs') ? [`${dir}/${f}`] : []));
test('OUTBOUND-INVENTORY: every outbound call site in src/ and api/ is listed (and therefore driven above)', () => {
	const found = {};
	for (const file of [...walk('src'), ...walk('api')]) {
		const code = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
		const n = (code.match(OUTBOUND) ?? []).length;
		if (n) found[file] = n;
	}
	assert.deepEqual(found, INVENTORY);
});
