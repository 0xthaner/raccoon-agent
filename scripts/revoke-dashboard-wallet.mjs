import { pathToFileURL } from 'node:url';

// Run from an authorized operator environment with existing Supabase credentials:
// node --env-file=<protected-config> scripts/revoke-dashboard-wallet.mjs WALLET [INCIDENT]
// cli-operator identifies the mechanism, not an authenticated human identity.
// Never supply credentials, tokens or signatures as arguments.
export async function runOperatorRevoke(args, { load = () => import('../src/db.mjs'), write = console.log } = {}) {
	const [wallet, incident] = args;
	if (args.length < 1 || args.length > 2 || !/^0x[0-9a-fA-F]{40}$/.test(wallet ?? '') ||
		(incident !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(incident))) {
		write('Invalid arguments. Expected WALLET [incident reference: 1-64 letters, digits, dots, underscores or hyphens].');
		return 1;
	}
	let effectiveCutoff;
	let db;
	try {
		db = await load();
		effectiveCutoff = await db.revokeDashboardSessions(wallet.toLowerCase());
	} catch {
		write('Revocation not confirmed; retry or investigate.');
		return 1;
	}
	try {
		await db.recordAgentEvent({ wallet: wallet.toLowerCase(), eventType: 'dashboard.sessions_revoked_by_operator', source: 'system',
			metadata: { effectiveCutoff, operatorSource: 'cli-operator', ...(incident ? { incidentReference: incident } : {}) } });
	} catch {
		write('revoked; audit incomplete');
		return 2;
	}
	write(`Wallet sessions revoked; effective cutoff ${effectiveCutoff}.`);
	return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	process.exitCode = await runOperatorRevoke(process.argv.slice(2));
}
