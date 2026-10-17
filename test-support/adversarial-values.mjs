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

/*
	CRSF Phase 2O: Werte ausserhalb der Domaene privater Telegram-Chat-IDs
	(positive sichere ganze Zahl oder kanonische Dezimalschreibweise ohne
	fuehrende Null). Die Helfer fuer gemerkte Wallets muessen sie selbst abweisen.
*/
export const INVALID_CHAT_IDS = Object.freeze(['%', '_', '1%', '1_', '%1', '_1', '*', '1*', '', ' ', ' 1', '1 ', '\t1', '+1', '-1', '01', '1.0', '1e3', '0x1', '1,2', '0', 0, -1, 1.5, Number.NaN, 2 ** 53, '123456789012345678901', 'unlinked:1:%', "1' or '1'='1", 'eq.1', '1)or(1', null, undefined, {}, [1], true]);
