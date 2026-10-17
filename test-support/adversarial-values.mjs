/*
	Feindselige Werte fuer CR-INPUT-004 (CRSF Phase 2N): SQL- und PostgREST-
	Syntax, Platzhalter, Kodierungen, JSON, Unicode. Jeder <= 20 Zeichen, damit
	kein Helfer kuerzt (label 32, asset_symbol 20). Kein NUL: Postgres-Text kann
	es nicht speichern (das waere ein sicherer Fehler, kein Strukturtest).
*/
export const ADVERSARIAL = Object.freeze([
	"'", "''", "';--", '"', '\\', "' or '1'='1", '; drop table x; --', '/* c */', '%', '_', '*',
	'a,b', 'x)', '(y', 'eq.1', 'or=(a.eq.1)', '&select=*', '%2C', 'a&b=c', '?x=1#y', 'true', 'null',
	'{"a":1}', '[1]', 'NOT.is.null', '🦝 Ünïcødé ✓'
]);
