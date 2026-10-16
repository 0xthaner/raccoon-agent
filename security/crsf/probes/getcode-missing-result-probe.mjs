/*
	CRSF evidence probe EV-PROBE-GETCODE (finding F-2D-2, CRSF Phase 2D).

	Question: does noContractCodeByQuorum (src/contract-signature.mjs) treat an
	eth_getCode answer WITHOUT a result as "no contract code"?

	Both providers are viem clients with an offline fetch that answers each
	JSON-RPC call in a fixed way; no network, no keys. Prints one JSON line.

	Exit 0 only while the observation is the recorded defect AND the controls
	behave normally (real code -> false, real 0x -> true, RPC error -> false).
	Once the defect is fixed this probe exits 1, the evidence FAILs and the
	VIOLATION record in evidence.json must be revisited - it cannot go stale.
*/
import { createPublicClient, http } from 'viem';
import { mainnet } from 'viem/chains';
import { noContractCodeByQuorum } from '../../../src/contract-signature.mjs';

const ADDRESS = '0x' + 'a1'.repeat(20);
const ANSWERS = {
	contract_code: (id) => ({ jsonrpc: '2.0', id, result: '0x6080604052' }),
	empty_code_0x: (id) => ({ jsonrpc: '2.0', id, result: '0x' }),
	rpc_error: (id) => ({ jsonrpc: '2.0', id, error: { code: -32000, message: 'unavailable' } }),
	result_missing: (id) => ({ jsonrpc: '2.0', id }),
	result_null: (id) => ({ jsonrpc: '2.0', id, result: null }),
	empty_http_body: null
};
const observation = { question: 'F-2D-2', viem_getCode_no_code_for: {} };
for (const [label, make] of Object.entries(ANSWERS)) {
	const fetchFn = async (_url, init) => (make ? Response.json(make(JSON.parse(init.body).id)) : new Response('', { status: 200 }));
	const client = (url) => createPublicClient({ chain: mainnet, transport: http(url, { fetchFn, retryCount: 0 }) });
	const providers = { alchemy: client('https://eth-mainnet.g.alchemy.com/v2/probe'), infura: client('https://mainnet.infura.io/v3/probe') };
	observation.viem_getCode_no_code_for[label] = await noContractCodeByQuorum(ADDRESS, { providers }).catch(() => 'THROWS');
}
const o = observation.viem_getCode_no_code_for;
observation.controls_ok = o.contract_code === false && o.empty_code_0x === true && o.rpc_error === false;
observation.missing_result_read_as_no_code = o.result_missing === true || o.result_null === true || o.empty_http_body === true;
process.stdout.write(JSON.stringify(observation) + '\n');
process.exitCode = observation.controls_ok && observation.missing_result_read_as_no_code ? 0 : 1;
