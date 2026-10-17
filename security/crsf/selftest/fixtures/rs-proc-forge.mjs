// CRSF Phase 2U fixture S7: tries to inject a forged receipt line into the observed executor's stdout via /proc.
import test from 'node:test';
import { readFileSync, openSync, writeSync, closeSync } from 'node:fs';
test('RS-FIXTURE forged receipt via /proc', () => {
	const forged = `{"observed":{"nonce":"guess","upstream_kind":"postgres","groups":[]},"mac":"${'a'.repeat(64)}"}\n`;
	let pid = process.ppid;
	for (let i = 0; i < 6 && pid > 1; i++) {
		let argv = [];
		try { argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0'); } catch { break; }
		if (argv[1]?.endsWith('/observed-test-exec.mjs')) { try { const fd = openSync(`/proc/${pid}/fd/1`, 'w'); writeSync(fd, forged); closeSync(fd); } catch {} }
		try { pid = Number(/^\d+ \(.*\) \S (\d+)/.exec(readFileSync(`/proc/${pid}/stat`, 'utf8'))[1]); } catch { break; }
	}
});
