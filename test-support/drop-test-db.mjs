/*
	Entfernt die Wegwerf-Datenbank eines Echt-Postgres-Tests nach dem Lauf (CRSF Phase 2C).

	Jeder DB-Test legt `<praefix>_<pid>` an. Ohne Aufraeumen haeuft jeder Lauf - und
	jeder Mutationslauf von `npm run security:verify` - eine Datenbank an; in Phase 2B
	waren es 454, bis der Speicher voll war. Nur lokale Wegwerf-Server (die Tests
	pruefen das bereits); `with (force)` beendet noch offene Verbindungen.
*/
export async function dropTestDatabase(pg, adminUrl, dbUrl) {
	if (!pg || !adminUrl || !dbUrl) return;
	const name = dbUrl.split('/').pop();
	if (!/^[a-z0-9_]+$/.test(name) || ['postgres', 'template0', 'template1'].includes(name)) return;
	const admin = new pg.Client({ connectionString: adminUrl });
	await admin.connect();
	try { await admin.query(`drop database if exists ${name} with (force)`); } finally { await admin.end(); }
}
