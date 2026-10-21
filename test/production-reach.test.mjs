/*
	Produktions-Erreichbarkeit vor dem Kauf (20.10.2026).

	Ausgangspunkt sind alle Vercel-Funktionen (api/**) und alle Skripte, die
	web/index.html laedt. Von dort wird der statische Import-Graph (relative
	Importe, auch dynamische mit Literal) vollstaendig verfolgt.

	  - PROD-REACH-PURCHASE: kein erreichbares Modul ist ein Kauf-Modul
	    (src/purchase-*), und kein erreichbares Modul importiert eines.
	  - PROD-REACH-TX: im erreichbaren Code (ohne Kommentare) gibt es keine
	    Transaktions- oder Typed-Data-Methode, kein buyCover, kein approve,
	    kein writeContract und keine Safe-Transaktion.
	  - PROD-REACH-WALLET: jede Anfrage per .request() nennt ihre Methode als
	    Literal; im Browser nur Methoden der Anmeldung, auf dem Server nur
	    lesende RPC-Methoden.
	  - PROD-REACH-DYNAMIC: es gibt keinen Import mit berechnetem Ziel, der den
	    Graphen unvollstaendig machen koennte.
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rel = (file) => path.relative(REPO, file).split(path.sep).join('/');
const walk = (dir) => readdirSync(dir).flatMap((name) => {
	const full = path.join(dir, name);
	return statSync(full).isDirectory() ? walk(full) : [full];
});
const withoutComments = (code) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');

function productionGraph() {
	const entries = walk(path.join(REPO, 'api')).filter((file) => /\.m?js$/.test(file));
	const html = readFileSync(path.join(REPO, 'web/index.html'), 'utf8');
	for (const [, src] of html.matchAll(/<script[^>]*\ssrc="\/([^"]+)"/g)) entries.push(path.join(REPO, 'web', src));
	const files = new Map();
	const dynamic = [];
	const stack = [...entries];
	while (stack.length) {
		const file = stack.pop();
		if (files.has(file)) continue;
		const code = readFileSync(file, 'utf8');
		const imports = [];
		for (const m of code.matchAll(/(?:^|[;\s])(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s*['"]([^'"]+)['"]/gm)) {
			const spec = m[1] ?? m[2] ?? m[3];
			if (!spec.startsWith('.')) continue;
			const target = path.resolve(path.dirname(file), spec);
			assert.ok(existsSync(target), `${rel(file)} imports missing ${spec}`);
			imports.push(target);
			stack.push(target);
		}
		for (const m of withoutComments(code).matchAll(/import\(\s*([^'")\s][^)]*)\)/g)) dynamic.push(`${rel(file)}: ${m[1].slice(0, 60)}`);
		files.set(file, { code, imports });
	}
	return { entries: entries.map(rel), files, dynamic };
}

const graph = productionGraph();
const reachable = [...graph.files.keys()].map(rel).sort();

test('PROD-REACH-PURCHASE no purchase module is reachable from api/** or the web entry scripts', () => {
	assert.ok(graph.entries.includes('api/nexus/quote.mjs') && graph.entries.includes('web/src/main.js'), 'entries found');
	assert.ok(reachable.includes('src/aave-cover-readiness.mjs'), 'the graph reaches the readiness module (sanity)');
	// Uniswap v3 (21.10.2026): der lesende Pfad ist erreichbar - und damit auch von den Pruefungen unten erfasst.
	for (const file of ['src/positions/uniswap-v3-service.mjs', 'src/positions/uniswap-v3-nexus.mjs', 'src/positions/uniswap-v3-ethereum.mjs', 'src/positions/price-reference.mjs', 'web/src/uniswap-cover.js']) assert.ok(reachable.includes(file), `${file} is reachable (sanity)`);
	const purchase = reachable.filter((file) => /(^|\/)purchase-/.test(file));
	assert.deepEqual(purchase, [], 'purchase modules reachable from production');
	for (const [file, { code }] of graph.files) assert.doesNotMatch(withoutComments(code), /purchase-(intent|tx-builder|tx-decode|pre-send|receipt|confirmation|runtime-loader|execution|db|intent-db)/, rel(file));
});

test('PROD-REACH-TX reachable code has no transaction, typed-data, approve, buyCover, writeContract or Safe transaction call', () => {
	const forbidden = /eth_sendTransaction|eth_sendRawTransaction|wallet_sendCalls|sendTransaction|sendRawTransaction|writeContract|signTypedData|eth_signTypedData|buyCover|functionName:\s*['"]approve['"]|\.approve\(|txs\.send|createWalletClient|walletActions/;
	const hits = [];
	for (const [file, { code }] of graph.files) {
		const match = withoutComments(code).match(forbidden);
		if (match) hits.push(`${rel(file)}: ${match[0]}`);
	}
	assert.deepEqual(hits, []);
});

test('PROD-REACH-WALLET every browser wallet request names a literal sign-in method; server RPC requests only read', () => {
	const wallet = new Set(['personal_sign', 'eth_chainId', 'eth_accounts', 'eth_requestAccounts', 'wallet_switchEthereumChain', 'wallet_revokePermissions']);
	const serverRead = new Set(['eth_blockNumber', 'eth_chainId', 'eth_getBlockByNumber', 'eth_getCode']);
	let requests = 0;
	for (const [file, { code }] of graph.files) {
		const allowed = rel(file).startsWith('web/') ? wallet : serverRead;
		const body = withoutComments(code);
		for (const m of body.matchAll(/\.request\(\s*([^)]{0,120})/g)) {
			requests += 1;
			const method = m[1].match(/^\{\s*method:\s*'([A-Za-z_]+)'/);
			assert.ok(method, `${rel(file)}: wallet request without a literal method: ${m[1].slice(0, 60)}`);
			assert.ok(allowed.has(method[1]), `${rel(file)}: ${method[1]}`);
		}
	}
	assert.ok(requests >= 5, 'the sign-in requests were found (sanity)');
});

test('PROD-REACH-DYNAMIC no computed import target in production code', () => {
	assert.deepEqual(graph.dynamic, []);
});
