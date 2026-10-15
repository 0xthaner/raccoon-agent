/*
	META-AUDIT M-3 (15.10.2026): CoverRaccoon darf eine Safe / Contract-Wallet nur
	dann um eine Signatur bitten, wenn VOR der Anfrage feststeht, dass daraus kein
	Safe-Transaktionsvorschlag (SignMessageLib) entstehen kann.

	Safe{Wallet} entscheidet erst BEIM Signieren (safe-wallet-monorepo @dab2bd9):
	  useSafeWalletProvider.tsx / useCustomAppCommunicator.tsx:
	    offChain = isOffchainEIP1271Supported(safe, chain) && !onChainSigning && settings.offChainSigning
	    sonst -> SignMessageOnChainFlow -> createTx(SignMessageLib.signMessage, DelegateCall)
	  useCustomAppCommunicator.onSetSafeSettings: gibt die ANGEFORDERTEN Settings zurueck
	    ({ ...settings, offChainSigning: !!requested }) - nicht den wirksamen Modus.
	  safe-wallet-provider/index.ts personal_sign: gibt '0x' zurueck, wenn keine Signatur entsteht.
	  apps/mobile WalletConnect constants: personal_sign wird abgelehnt (REJECTED_SIGNING_METHODS).
	Weder Safe-Apps-SDK (getInfo, setSafeSettings) noch WalletConnect
	(wallet_getCapabilities: nur atomicBatch/atomic) machen die Nutzer-Einstellung
	"Always use on-chain signatures" vorher sichtbar. Eine Off-chain-Garantie vor
	der Anfrage gibt es deshalb nicht.

	Die Fixtures unten bilden genau diese Entscheidung nach. Sie zaehlen, wie oft
	eine Signatur angefragt und wie oft ein Transaktionsvorschlag erzeugt wurde.
	Geprueft werden die ECHTEN Ablaeufe: runSafeLogin (Safe App),
	guardedChallengeSignSubmit (WalletConnect / Browser-Wallet, Telegram-Link)
	gegen die echten Server-Handler mit echter Wallet-Klassifizierung (Dual-RPC).
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hashMessage, isAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { simChain, dualProviders, ownerSignature } from '../test-support/dual-rpc-sim.mjs';
import { queryParams, singleQueryValue } from '../src/request-query.mjs';

process.env.APP_BASE_URL = 'https://coverraccoon.com';
process.env.DASHBOARD_SESSION_SECRET = 'safe-offchain-guarantee-secret-0123456789abcdef';
delete process.env.TELEGRAM_BOT_TOKEN;

const auth = await import('../src/dashboard-auth.mjs');
const linking = await import('../src/linking.mjs');
const cs = await import('../src/contract-signature.mjs');
const policy = await import('../src/signing-policy.mjs').catch(() => ({ signingRefusal: () => null, WALLET_TYPE_UNAVAILABLE: {} }));
const { runSafeLogin } = await import('../web/src/safe-app.js');
const { guardedChallengeSignSubmit, eoaLoginTexts } = await import('../web/src/eoa-login.js');

const SAFE = '0x5afe00000000000000000000000000000000a00a';
const HEAD = 20_000_000n;
const chain = () => simChain({ head: HEAD, safes: { [SAFE]: { history: [{ from: 0n, owners: ['b2'], threshold: 1 }] } } });

/* ---------------------------------------------------- Safe{Wallet}-Modell */

/** Die Faelle aus dem Safe-Quellcode. */
export const SAFE_FIXTURES = {
	OFFCHAIN_SUPPORTED: { offchainSupported: true, userOnChainToggle: false, platform: 'web' },      // Normalfall: Version >= 1.3 + Fallback-Handler, Schalter aus
	USER_ONCHAIN_TOGGLE: { offchainSupported: true, userOnChainToggle: true, platform: 'web' },      // "Always use on-chain signatures"
	OLD_SAFE_NO_HANDLER: { offchainSupported: false, userOnChainToggle: false, platform: 'web' },    // isOffchainEIP1271Supported === false
	MOBILE_REJECT: { offchainSupported: true, userOnChainToggle: false, platform: 'mobile' }         // Safe Mobile: personal_sign abgelehnt
};

function safeWallet(fixture) {
	const state = { signRequests: 0, proposals: 0, settings: { offChainSigning: true } };
	const decide = () => (fixture.offchainSupported && !fixture.userOnChainToggle && state.settings.offChainSigning ? 'OFFCHAIN' : 'ONCHAIN_PROPOSAL');
	const sign = (message) => {
		state.signRequests++;
		if (fixture.platform === 'mobile') throw Object.assign(new Error('Method not supported'), { code: 4200 });
		if (decide() === 'ONCHAIN_PROPOSAL') { state.proposals++; return null; } // SignMessageOnChainFlow -> createTx(SignMessageLib)
		return ownerSignature(['b2'], hashMessage(message));
	};
	const sdk = {
		safe: {
			getInfo: async () => ({ safeAddress: SAFE, chainId: 1, threshold: 1, owners: [], isReadOnly: false }),
			getOffChainSignature: async (hash) => state.pendingSignature?.hash === hash ? state.pendingSignature.signature : ''
		},
		eth: {
			// wie useCustomAppCommunicator.onSetSafeSettings: Echo der Anfrage, NICHT der wirksame Modus
			setSafeSettings: async ([requested]) => { state.settings = { ...state.settings, offChainSigning: !!requested.offChainSigning }; return { ...state.settings }; }
		},
		txs: {
			signMessage: async (message) => {
				const signature = sign(message);
				if (!signature) return { safeTxHash: `0x${'5a'.repeat(32)}` };
				const hash = hashMessage(message);
				state.pendingSignature = { hash, signature };
				return { messageHash: hash };
			}
		}
	};
	// wie safe-wallet-provider/index.ts: personal_sign -> Signatur oder '0x'
	const walletConnect = { request: async ({ method, params }) => {
		if (method !== 'personal_sign') throw new Error(`unexpected ${method}`);
		return sign(params[0]) ?? '0x';
	} };
	return { state, sdk, walletConnect };
}

/* --------------------------------------------------- echte Server-Handler */

const res = () => ({ statusCode: null, body: null, headers: {}, status(c) { this.statusCode = c; return this; }, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, json(b) { this.body = b; return this; } });
function fetchVia(handler) {
	return async (url, init = {}) => {
		const r = res();
		const u = new URL(url, 'https://coverraccoon.com');
		const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
		await handler({ method: init.method ?? 'GET', url: u.pathname + u.search, headers, body: init.body ? JSON.parse(init.body) : undefined }, r);
		return { ok: r.statusCode < 400, status: r.statusCode, json: async () => r.body };
	};
}
function server({ alchemy = {}, infura = {} } = {}) {
	const { providers } = dualProviders(chain(), alchemy, infura);
	const challenges = new Map();
	const shared = {
		verifyWalletSiweAuthority: (params) => cs.verifyWalletSiweAuthority(params, { providers }),
		verifyWalletSiweSignature: (params) => cs.verifyWalletSiweSignature(params, { providers }),
		noContractCodeByQuorum: (wallet) => cs.noContractCodeByQuorum(wallet, { providers }),
		contractCodeQuorum: (wallet) => cs.contractCodeQuorum?.(wallet, { providers }),
		signingRefusal: policy.signingRefusal, WALLET_TYPE_UNAVAILABLE: policy.WALLET_TYPE_UNAVAILABLE,
		enforceRateLimit: async () => true, enforceRateLimitFor: async () => true,
		recordSecurityEvent: async () => {}, securityFingerprint: () => 'fp', SECURITY_EVENT: {}
	};
	const strip = (path) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/^import .*;\n/gm, '').replace('export default async function handler', 'async function handler');
	const load = (path, deps) => new Function(...Object.keys(deps), `${strip(path)}\nreturn handler;`)(...Object.values(deps));
	const dashboard = load('../api/dashboard.mjs', {
		isAddress, queryParams, singleQueryValue, ...auth, ...shared,
		isDeployedContract: async (wallet) => (await cs.contractCodeQuorum?.(wallet, { providers })) === 'CONTRACT' || wallet.toLowerCase() === SAFE,
		getWalletCovers: async () => ({ covers: [] }), getWalletLinkStateByWallet: async () => ({ linked: false, link: null }),
		storeDashboardChallenge: async ({ nonce, wallet, expiresAt }) => { challenges.set(nonce, { wallet: wallet.toLowerCase(), expiresAt, used: false }); },
		consumeDashboardChallenge: async (nonce, wallet) => { const row = challenges.get(nonce); if (!row || row.used || row.wallet !== wallet.toLowerCase()) return false; row.used = true; return true; },
		isDashboardSessionRevoked: async () => false, recordAgentEvent: async () => {}, consumeDashboardAccess: async () => null,
		getLanguage: async () => 'de', beginTelegramDelivery: async () => null, finishTelegramDelivery: async () => {},
		revokeDashboardSessions: async () => Date.now(), unlinkWalletByWallet: async () => [], unlinkWalletFromAllChats: async () => [],
		ANMELDUNG_PAUSIERT: false, pauseAntwort: () => {}, requireSameOrigin: () => true, requireJson: () => true
	});
	const LINK_CODE = 'SafeLinkCodeForM3_012345';
	const link = load('../api/link.mjs', {
		isAddress, queryParams, singleQueryValue, ...shared, ANMELDUNG_PAUSIERT: false, pauseAntwort: () => {},
		getPendingLink: async (code) => (code === LINK_CODE ? { code, chat_id: '123456789', nonce: 'ab'.repeat(16), expires_at: Date.now() + 540_000, used_at: null } : null),
		isTelegramLinkCode: linking.isTelegramLinkCode, isTelegramLinkRow: linking.isTelegramLinkRow,
		signingMessage: linking.signingMessage,
		telegramTarget: async () => ({ username: 'owner_b', name: 'B', target: '@owner_b' })
	});
	return { dashboard, link, LINK_CODE, challenges };
}
const texts = eoaLoginTexts('de');

/** WalletConnect-/Browser-Login wie main.js openDashboard: dieselbe Sequenz, dieselben Endpunkte. */
function walletConnectLogin(srv, wallet, signer) {
	const call = fetchVia(srv.dashboard);
	return guardedChallengeSignSubmit({
		texts,
		getChallenge: () => call(`/api/dashboard?wallet=${encodeURIComponent(wallet)}`).then((r) => r.json()),
		sign: (message) => signer(message),
		submit: async (challenge, signature) => {
			const result = await call('/api/dashboard', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ wallet, token: challenge.token, signature }) }).then((r) => r.json());
			if (!result.ok) throw new Error(result.error);
			return result;
		}
	});
}
/** Telegram-Link wie main.js finish(). */
function telegramLink(srv, wallet, signer) {
	const call = fetchVia(srv.link);
	return guardedChallengeSignSubmit({
		texts,
		getChallenge: () => call(`/api/link?code=${encodeURIComponent(srv.LINK_CODE)}&wallet=${encodeURIComponent(wallet)}`).then((r) => r.json()),
		sign: (message) => signer(message),
		submit: async () => ({ ok: true })
	});
}

/* ============================================ T1/T2/T3-T6, T9: Login-Wege */

for (const [name, fixture] of Object.entries(SAFE_FIXTURES)) {
	test(`T1/T3/T4 Safe App (${name}): no signing request reaches the Safe, so no proposal can be created`, async () => {
		const srv = server();
		const wallet = safeWallet(fixture);
		await assert.rejects(runSafeLogin({ sdk: wallet.sdk, info: await wallet.sdk.safe.getInfo(), fetchFn: fetchVia(srv.dashboard), waitFn: async () => {}, pollTimeoutMs: 1 }));
		assert.equal(wallet.state.signRequests, 0, 'keine Signaturanfrage an die Safe');
		assert.equal(wallet.state.proposals, 0, 'kein Transaktionsvorschlag');
	});

	test(`T2/T5/T6/T9 WalletConnect Safe (${name}): no personal_sign is sent to the Safe`, async () => {
		const srv = server();
		const wallet = safeWallet(fixture);
		await assert.rejects(walletConnectLogin(srv, SAFE, (message) => wallet.walletConnect.request({ method: 'personal_sign', params: [message, SAFE] })));
		assert.equal(wallet.state.signRequests, 0);
		assert.equal(wallet.state.proposals, 0);
	});

	test(`T10 Telegram link with a Safe (${name}): no signing request`, async () => {
		const srv = server();
		const wallet = safeWallet(fixture);
		await assert.rejects(telegramLink(srv, SAFE, (message) => wallet.walletConnect.request({ method: 'personal_sign', params: [message, SAFE] })));
		assert.equal(wallet.state.signRequests, 0);
		assert.equal(wallet.state.proposals, 0);
	});
}

test('T4/T6 UNKNOWN wallet type (RPC outage): the server issues no message to sign - nothing is signed', async () => {
	const outage = { behave: { eth_getCode: () => { throw new Error('timeout'); } } };
	const srv = server({ infura: outage });
	const wallet = safeWallet(SAFE_FIXTURES.USER_ONCHAIN_TOGGLE);
	await assert.rejects(walletConnectLogin(srv, SAFE, (m) => wallet.walletConnect.request({ method: 'personal_sign', params: [m, SAFE] })));
	await assert.rejects(telegramLink(srv, SAFE, (m) => wallet.walletConnect.request({ method: 'personal_sign', params: [m, SAFE] })));
	await assert.rejects(runSafeLogin({ sdk: wallet.sdk, info: await wallet.sdk.safe.getInfo(), fetchFn: fetchVia(srv.dashboard), waitFn: async () => {}, pollTimeoutMs: 1 }));
	assert.equal(wallet.state.signRequests, 0);
	const r = await fetchVia(srv.dashboard)(`/api/dashboard?wallet=${SAFE}`);
	assert.equal(r.status, 503);
	assert.equal((await r.json()).code, 'WALLET_TYPE_UNAVAILABLE');
});

test('T9: the server refuses a Safe login challenge with an explicit unsupported code - no token, no message', async () => {
	const r = await fetchVia(server().dashboard)(`/api/dashboard?wallet=${SAFE}`);
	const body = await r.json();
	assert.equal(r.status, 422);
	assert.equal(body.code, 'CONTRACT_SIGNING_UNSUPPORTED');
	assert.equal(body.token, undefined);
	assert.equal(body.message, undefined);
	assert.match(body.error, /keine Signaturanfrage gestartet/);
});

/* ======================================= T11/T12: frische Bestaetigungen */

for (const purpose of ['telegram-disconnect', 'session-revoke']) {
	test(`T11/T12 fresh ${purpose} for an existing Safe session: no action challenge is issued - nothing to sign`, async () => {
		const srv = server();
		const cookie = `${auth.SESSION_COOKIE}=${encodeURIComponent(auth.createDashboardSession(SAFE, Date.now(), 'contract'))}`;
		const r = await fetchVia(srv.dashboard)('/api/dashboard', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ action: purpose }) });
		const body = await r.json();
		assert.equal(r.status, 409);
		assert.equal(body.code, 'CONTRACT_SIGNING_UNSUPPORTED');
		assert.equal(body.token, undefined);
		assert.equal(body.message, undefined);
		assert.equal(srv.challenges.size, 0, 'keine Challenge gespeichert');
	});
}

/* ========================================================== T7/T8: EOA */

test('T7 EOA login still uses personal_sign normally and gets a 7-day session', async () => {
	const srv = server();
	const owner = privateKeyToAccount(generatePrivateKey());
	let signs = 0;
	const result = await walletConnectLogin(srv, owner.address, (message) => { signs++; return owner.signMessage({ message }); });
	assert.equal(result.ok, true);
	assert.equal(signs, 1);
});

test('T7 EOA Telegram link still receives the message to sign', async () => {
	const srv = server();
	const owner = privateKeyToAccount(generatePrivateKey());
	let signs = 0;
	await telegramLink(srv, owner.address, (message) => { signs++; return owner.signMessage({ message }); });
	assert.equal(signs, 1);
});

test('T8 EOA destructive behaviour unchanged: no fresh signature needed, logout revokes', async () => {
	const srv = server();
	const owner = privateKeyToAccount(generatePrivateKey());
	const cookie = `${auth.SESSION_COOKIE}=${encodeURIComponent(auth.createDashboardSession(owner.address, Date.now(), 'eoa'))}`;
	const r = await fetchVia(srv.dashboard)('/api/dashboard', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ action: 'session-revoke' }) });
	assert.deepEqual(await r.json(), { ok: true, freshSignatureRequired: false });
});

/* ===================================================== T15/T16/T13/T14 */

test('T15 an existing Safe session still reads the dashboard (no signing involved)', async () => {
	const cookie = `${auth.SESSION_COOKIE}=${encodeURIComponent(auth.createDashboardSession(SAFE, Date.now(), 'contract'))}`;
	const r = await fetchVia(server().dashboard)('/api/dashboard', { headers: { cookie } });
	assert.equal(r.status, 200);
});

test('T16 backend ERC-1271 is unchanged and fail closed: dual-RPC VALID only with a real owner signature', async () => {
	const { providers } = dualProviders(chain());
	const message = 'coverraccoon login';
	assert.equal(await cs.verifyContractSiweSignature({ address: SAFE, message, signature: ownerSignature(['b2'], hashMessage(message)) }, { providers }), 'VALID');
	assert.equal(await cs.verifyContractSiweSignature({ address: SAFE, message, signature: ownerSignature(['c3'], hashMessage(message)) }, { providers }), 'INVALID_SIGNATURE'); // c3 ist kein Owner
	assert.equal(await cs.verifyContractSiweSignature({ address: SAFE, message, signature: '0x' }, { providers }), 'INVALID_SIGNATURE_FORMAT');
});

test('T9/M4: browser flags (isSafe=false, walletType=eoa, isContract=false) cannot unlock signing for a Safe', async () => {
	const srv = server();
	const wallet = safeWallet(SAFE_FIXTURES.USER_ONCHAIN_TOGGLE);
	const call = fetchVia(srv.dashboard);
	const login = guardedChallengeSignSubmit({
		texts,
		getChallenge: () => call(`/api/dashboard?wallet=${SAFE}&isSafe=false&walletType=eoa&isContract=false&kind=eoa`, { headers: { 'x-wallet-type': 'eoa', 'x-is-safe': 'false' } }).then((r) => r.json()),
		sign: (m) => wallet.walletConnect.request({ method: 'personal_sign', params: [m, SAFE] }),
		submit: async () => ({ ok: true })
	});
	await assert.rejects(login);
	const linkCall = fetchVia(srv.link);
	await assert.rejects(guardedChallengeSignSubmit({
		texts,
		getChallenge: () => linkCall(`/api/link?code=${srv.LINK_CODE}&wallet=${SAFE}&isSafe=false&walletType=eoa`).then((r) => r.json()),
		sign: (m) => wallet.walletConnect.request({ method: 'personal_sign', params: [m, SAFE] }),
		submit: async () => ({ ok: true })
	}));
	assert.equal(wallet.state.signRequests, 0);
	assert.equal(wallet.state.proposals, 0);
});

/* ======================== T10: lokaler Bot-Webserver (npm start, src/web.mjs) */

test('T10 local bot web server (src/web.mjs): a Safe gets no message to sign, an EOA still does', async () => {
	const { providers } = dualProviders(chain());
	const LINK_CODE = 'SafeLinkCodeForM3_012345';
	const source = readFileSync(new URL('../src/web.mjs', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '').replace('export function startWebServer', 'function startWebServer');
	const deps = {
		createServer: (await import('node:http')).createServer, readFile: async () => { throw new Error('no static'); },
		extname: (await import('node:path')).extname, join: (await import('node:path')).join, normalize: (await import('node:path')).normalize,
		isAddress, consumePendingLink: async () => null,
		getPendingLink: async (code) => (code === LINK_CODE ? { code, chat_id: '123456789', nonce: 'ab'.repeat(16), expires_at: Date.now() + 540_000, used_at: null } : null),
		isTelegramLinkCode: linking.isTelegramLinkCode, isTelegramLinkRow: linking.isTelegramLinkRow, linkSiweExpectation: linking.linkSiweExpectation, signingMessage: linking.signingMessage,
		telegramTarget: async () => ({ username: 'owner_b', name: 'B', target: '@owner_b' }),
		contractCodeQuorum: (wallet) => cs.contractCodeQuorum?.(wallet, { providers }),
		verifyWalletSiweSignature: (params) => cs.verifyWalletSiweSignature(params, { providers }),
		signingRefusal: policy.signingRefusal
	};
	const start = new Function(...Object.keys(deps), `${source}\nreturn startWebServer;`)(...Object.values(deps));
	const log = console.log; console.log = () => {};
	const srv = start({ port: 0, onLinked: async () => {} });
	await new Promise((r) => srv.listening ? r() : srv.once('listening', r));
	console.log = log;
	try {
		const base = `http://127.0.0.1:${srv.address().port}`;
		const wallet = safeWallet(SAFE_FIXTURES.USER_ONCHAIN_TOGGLE);
		await assert.rejects(guardedChallengeSignSubmit({
			texts,
			getChallenge: () => fetch(`${base}/api/link?code=${LINK_CODE}&wallet=${SAFE}`).then((r) => r.json()),
			sign: (m) => wallet.walletConnect.request({ method: 'personal_sign', params: [m, SAFE] }),
			submit: async () => ({ ok: true })
		}));
		assert.equal(wallet.state.signRequests, 0);
		assert.equal(wallet.state.proposals, 0);
		const eoa = privateKeyToAccount(generatePrivateKey());
		const body = await fetch(`${base}/api/link?code=${LINK_CODE}&wallet=${eoa.address}`).then((r) => r.json());
		assert.equal(body.ok, true);
		assert.equal(typeof body.message, 'string');
	} finally {
		await new Promise((r) => srv.close(r));
	}
});

/* ================================================ T13/T14: Methoden, AppKit */

const FORBIDDEN = ['eth_sendTransaction', 'eth_signTransaction', 'eth_sign', 'eth_signTypedData', 'eth_signTypedData_v3', 'eth_signTypedData_v4', 'wallet_sendCalls', 'safe_proposeTransaction'];

test('T13 production call trace: only personal_sign (EOA) - no transaction, typed-data or Safe proposal call on any path', async () => {
	const trace = [];
	const record = (name) => (...args) => { trace.push(name); throw new Error(`unexpected ${name}`); };
	for (const fixture of Object.values(SAFE_FIXTURES)) {
		const srv = server();
		const wallet = safeWallet(fixture);
		const sdk = { ...wallet.sdk, txs: new Proxy({}, { get: (_, k) => (k === 'signMessage' ? async (m) => { trace.push('txs.signMessage'); return wallet.sdk.txs.signMessage(m); } : record(`txs.${String(k)}`)) }) };
		const wc = { request: async ({ method, params }) => { trace.push(method); return wallet.walletConnect.request({ method, params }); } };
		await runSafeLogin({ sdk, info: await sdk.safe.getInfo(), fetchFn: fetchVia(srv.dashboard), waitFn: async () => {}, pollTimeoutMs: 1 }).catch(() => {});
		await walletConnectLogin(srv, SAFE, (m) => wc.request({ method: 'personal_sign', params: [m, SAFE] })).catch(() => {});
		await telegramLink(srv, SAFE, (m) => wc.request({ method: 'personal_sign', params: [m, SAFE] })).catch(() => {});
	}
	assert.deepEqual(trace, [], 'kein einziger Wallet-Aufruf an eine Safe');
	const owner = privateKeyToAccount(generatePrivateKey());
	const eoaTrace = [];
	await walletConnectLogin(server(), owner.address, (message) => { eoaTrace.push('personal_sign'); return owner.signMessage({ message }); });
	assert.deepEqual(eoaTrace, ['personal_sign']);
	const { WALLET_METHODEN_ANMELDEN } = await import('../web/src/wallet-methods.js');
	for (const m of FORBIDDEN) assert.ok(!WALLET_METHODEN_ANMELDEN.includes(m), m);
});

test('T14 the real createAppKit options from main.js disable send/receive/swaps/onramp', async () => {
	const main = readFileSync(new URL('../web/src/main.js', import.meta.url), 'utf8');
	const start = main.indexOf('createAppKit({') + 'createAppKit('.length;
	let depth = 0, end = start;
	for (; end < main.length; end++) { if (main[end] === '{') depth++; else if (main[end] === '}' && --depth === 0) break; }
	const literal = main.slice(start, end + 1);
	const { appKitMethoden, WALLET_METHODEN_ANMELDEN } = await import('../web/src/wallet-methods.js');
	const options = new Function('appKitMethoden', 'WALLET_METHODEN_ANMELDEN', 'EthersAdapter', 'mainnet', 'config', 'location', 'walletDebug', `return (${literal});`)(
		appKitMethoden, WALLET_METHODEN_ANMELDEN, class {}, { id: 1 }, { reownProjectId: 'x' }, { origin: 'https://coverraccoon.com' }, false);
	assert.equal(options.features.send, false);
	assert.equal(options.features.receive, false);
	assert.equal(options.features.swaps, false);
	assert.equal(options.features.onramp, false);
	const methods = Object.values(options.universalProviderConfigOverride.methods ?? {}).flat();
	assert.ok(methods.includes('personal_sign'), 'Methodenliste gelesen');
	for (const m of FORBIDDEN) assert.ok(!methods.includes(m), m);
});
