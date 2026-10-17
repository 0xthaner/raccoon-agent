/*
	CRSF Phase 2Q (CR-VERIFY-003): Register der historischen Sicherheitskorrekturen.

	security/crsf/fix-register.json fuehrt jede Korrektur mit Herkunft, Fehler,
	EINER Invariante, Regressionstest und bekannt-falschen Mutationen. Dieses Modul
	prueft das Register gegen das Repository - in beide Richtungen und fail closed:

	- Entdeckung: jede Kennung einer Pruef-/Korrekturfamilie (AGENT-*, AUDIT-*,
	  "AUDIT X-Yn", META-AUDIT, Restaudit, F-2x-n, HARD-n) im Quelltext MUSS im
	  Register eingeordnet sein. Ein Auffangmuster findet auch Kennungen einer
	  NEUEN Familie (jedes grossgeschriebene AUDIT, Restaudit, META-AUDIT, AGENT-X-,
	  HARD-n), die keine bekannte Familie abdeckt; solche Stellen muessen einzeln
	  eingeordnet sein. Umgekehrt muss jede eingetragene Kennung noch vorkommen.
	- Commits (nur mit vollstaendiger Git-Historie): jeder Commit, dessen Text ein
	  Sicherheits-Stichwort traegt, muss eingeordnet sein.
	- Jede SECURITY_FIX/FRAMEWORK_FIX mit Status PROVEN braucht eine Invariante und
	  mindestens eine Mutation, die als KILLED mit verhaltensbasierter Erkennung
	  erwartet wird; jeder genannte Test ist ein erwartetes Scheitern genau dieser
	  Mutationen ({file, test}: Testdatei der Mutation und Muster ihres erwarteten
	  Scheiterns). Eine Mutation belegt hoechstens eine Korrektur.

	Das Register beweist nicht, dass die Mutationen wirklich KILLED sind - das
	prueft security:verify (Ausfuehrung jeder Mutation). Hier geht es um
	Vollstaendigkeit und Zuordnung.
*/
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export const REGISTER_FILE = 'security/crsf/fix-register.json';

/** Bekannte Kennungsfamilien. Reihenfolge egal; jede Fundstelle wird woertlich eingeordnet. */
export const FAMILIES = [
	['AGENT', /\bAGENT-[A-Z]+-[A-Z]?[0-9]+[a-z]?\b/g],
	['AUDIT-DATED', /\bAUDIT-[0-9]{4}-[0-9]{2}-[0-9]{2}(?: F[0-9]+)?/g],
	['AUDIT-LETTER', /\bAUDIT [A-Z]{1,3}-[A-Z][0-9]+\b/g],
	['META-AUDIT', /\bMETA-AUDIT [A-Z]-[0-9]+\b/g],
	['RESTAUDIT', /\bRestaudit [A-Z][0-9]+\b/g],
	['CRSF-FINDING', /\bF-[0-9][A-Z]-[0-9]+\b/g],
	['HARD', /(?<![A-Z]-)\bHARD-[0-9]+\b/g]
];
/** Auffangmuster: jede Spur einer (auch neuen) Familie, die keine bekannte Familie abdeckt. */
export const CATCH_ALL = /\bAUDIT\b|\bRestaudit\b|\bMETA-AUDIT\b|\bAGENT-[A-Z]+-|\bHARD-[0-9]/;
/** Sicherheits-Stichworte fuer die Commit-Entdeckung (Betreff und Text). */
export const COMMIT_KEYWORDS = /\b(security|sicherheit|harden|haert|härt|xss|csp|audit|vuln|leak|secret|geheim|rate.?limit|revok|widerruf|fail.closed|isolat|privileg|standardrechte|injection|phish|signatur|ignore-scripts|integrit|pr[uü]fsumme|sha-256|supply|exploit|forg|f[aä]lsch|schutz|protect)/i;

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist-web', 'dist', '.vercel', 'coverage']);
const BINARY = /\.(png|jpe?g|gif|ico|woff2?|ttf|otf|pdf|gz|zip|webp)$/i;
/*
	Nicht durchsucht: die CRSF-Definition und ihre erzeugten Berichte (sie zitieren
	Kennungen nur, eingeordnet werden sie hier im Register), der Mutationskatalog
	und die Lockdatei, sowie dieses Modul selbst (es enthaelt die Suchmuster).
	Alles andere - Code, Tests, Migrationen, Konfiguration, Dokumentation - wird
	durchsucht.
*/
const EXCLUDED_FILES = [/^security\/crsf\/[^/]+\.(json|md)$/, /^security\/crsf\/(schema|vendor)\//, /^security\/crsf\/lib\/fix-register\.mjs$/, /^security\/mutation\//, /^package-lock\.json$/];

export function scanFiles(root) {
	const out = [];
	const walk = (dir) => {
		for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
			if (SKIP_DIRS.has(entry.name)) continue;
			const rel = dir ? `${dir}/${entry.name}` : entry.name;
			if (entry.isDirectory()) { walk(rel); continue; }
			if (!entry.isFile() || BINARY.test(entry.name) || EXCLUDED_FILES.some((re) => re.test(rel))) continue;
			if (statSync(path.join(root, rel)).size > 3_000_000) continue;
			out.push(rel);
		}
	};
	walk('');
	return out.sort();
}

/** Alle Fundstellen: `tags` (Familienkennung -> Stellen) und `loose` (Auffangtreffer ausserhalb jeder Familie). */
export function discoverMarkers(root) {
	const tags = new Map();
	const loose = [];
	for (const file of scanFiles(root)) {
		const lines = readFileSync(path.join(root, file), 'utf8').split('\n');
		lines.forEach((line, index) => {
			let rest = line;
			for (const [, re] of FAMILIES) {
				for (const match of line.matchAll(re)) {
					const tag = match[0];
					if (!tags.has(tag)) tags.set(tag, []);
					tags.get(tag).push({ file, line: index + 1 });
				}
				rest = rest.replace(re, ' ');
			}
			if (CATCH_ALL.test(rest)) loose.push({ file, line: index + 1, text: line.trim() });
		});
	}
	return { tags, loose };
}

/** Commit-Entdeckung: FULL nur mit vollstaendiger Historie; flache Klone und Arbeitsbereiche ohne Git melden das. */
export function discoverCommits(root) {
	const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
	try {
		if (git('rev-parse', '--is-inside-work-tree').trim() !== 'true') return { mode: 'UNAVAILABLE', commits: [] };
	} catch {
		return { mode: 'UNAVAILABLE', commits: [] };
	}
	const shallow = git('rev-parse', '--is-shallow-repository').trim() === 'true';
	const raw = git('log', '--format=%H%x1f%s%x1f%b%x1e');
	const commits = raw.split('\x1e').map((r) => r.trim()).filter(Boolean).map((r) => {
		const [hash, subject, body = ''] = r.split('\x1f');
		return { hash, subject, matched: COMMIT_KEYWORDS.test(subject) || COMMIT_KEYWORDS.test(body) };
	});
	return { mode: shallow ? 'SHALLOW' : 'FULL', commits };
}

export const FIX_CLASSES = ['SECURITY_FIX', 'FRAMEWORK_FIX'];
export const OTHER_CLASSES = ['REGRESSION_TEST_ONLY', 'SUPERSEDED', 'REMOVED', 'NOT_SECURITY_FIX', 'NOT_A_FIX', 'TEST_LABEL', 'FRAMEWORK_EVIDENCE', 'PROCESS', 'OPEN_NOTE'];

/**
 * Prueft `register` gegen Entdeckung, Mutationskatalog (`cases`) und Findings
 * (`findingsFixed`: Kennungen aus FINDING_FIXED). Ergebnis: Fehler und Zusammenfassung.
 */
export function validateRegister({ register, discovered, commits = { mode: 'UNAVAILABLE', commits: [] }, cases, findingsFixed = [], root }) {
	const errors = [];
	const err = (code, detail) => errors.push({ code, detail });
	const fixes = register.fixes ?? [];
	const byId = new Map();
	for (const f of fixes) {
		if (byId.has(f.id)) err('DUPLICATE_FIX', f.id);
		byId.set(f.id, f);
	}
	const caseById = new Map(cases.map((c) => [c.id, c]));

	// 1. Kennungen: entdeckt <-> eingeordnet (beide Richtungen).
	const registeredTags = new Map();
	for (const f of fixes) for (const tag of f.tags ?? []) registeredTags.set(tag, f);
	for (const t of register.tag_classifications ?? []) {
		if (!OTHER_CLASSES.includes(t.classification)) err('TAG_CLASS_UNKNOWN', `${t.tag}: ${t.classification}`);
		if (!t.reason) err('TAG_REASON_MISSING', t.tag);
		if (t.refers_to && !byId.has(t.refers_to)) err('TAG_REFERS_TO_UNKNOWN_FIX', `${t.tag} -> ${t.refers_to}`);
		registeredTags.set(t.tag, t);
	}
	for (const [tag, places] of discovered.tags) {
		if (!registeredTags.has(tag)) err('UNCLASSIFIED_SECURITY_TAG', `${tag} (${places.slice(0, 3).map((p) => `${p.file}:${p.line}`).join(', ')})`);
	}
	for (const [tag, entry] of registeredTags) {
		if (!discovered.tags.has(tag) && entry.present !== false) err('STALE_TAG', `${tag} is registered but no longer found in the repository`);
	}

	// 2. Auffangtreffer: jede Stelle einzeln eingeordnet; jeder Eintrag wird noch gefunden.
	const looseEntries = register.loose_markers ?? [];
	for (const hit of discovered.loose) {
		const entry = looseEntries.find((m) => m.file === hit.file && hit.text.includes(m.contains));
		if (!entry) err('UNCLASSIFIED_SECURITY_MARKER', `${hit.file}:${hit.line}: ${hit.text.slice(0, 120)}`);
	}
	for (const m of looseEntries) {
		if (!m.reason || !m.classification) err('MARKER_REASON_MISSING', `${m.file}: ${m.contains}`);
		if (m.refers_to && !byId.has(m.refers_to)) err('MARKER_REFERS_TO_UNKNOWN_FIX', `${m.file} -> ${m.refers_to}`);
		if (!discovered.loose.some((hit) => hit.file === m.file && hit.text.includes(m.contains))) err('STALE_MARKER', `${m.file}: ${m.contains}`);
	}

	// 3. Korrekturen: Invariante, Test, Mutation - und eine Mutation belegt hoechstens eine Korrektur.
	const usedBy = new Map();
	const missing = [];
	for (const f of fixes) {
		const isFix = FIX_CLASSES.includes(f.classification);
		if (!isFix && !OTHER_CLASSES.includes(f.classification)) { err('FIX_CLASS_UNKNOWN', `${f.id}: ${f.classification}`); continue; }
		if (!isFix) { if (!f.reason) err('FIX_REASON_MISSING', f.id); continue; }
		for (const [field, min] of [['origin', 6], ['bug', 12], ['invariant', 12]]) if (typeof f[field] !== 'string' || f[field].trim().length < min) err('FIX_FIELD_MISSING', `${f.id}.${field}`);
		if (!Array.isArray(f.files) || !f.files.length) err('FIX_FIELD_MISSING', `${f.id}.files`);
		for (const file of f.files ?? []) if (root && !existsSync(path.join(root, file))) err('FIX_FILE_MISSING', `${f.id}: ${file}`);
		if (f.status === 'MISSING_EVIDENCE') {
			if (!f.missing_reason) err('FIX_MISSING_REASON', f.id);
			missing.push(f.id);
			continue;
		}
		if (f.status !== 'PROVEN') { err('FIX_STATUS_UNKNOWN', `${f.id}: ${f.status}`); continue; }
		if (f.evidence_level !== 'E4') err('FIX_LEVEL_MISMATCH', `${f.id}: PROVEN needs E4 (known-bad), declared ${f.evidence_level}`);
		if (!Array.isArray(f.mutations) || !f.mutations.length) { err('FIX_WITHOUT_MUTATION', f.id); continue; }
		const expected = new Set();
		for (const id of f.mutations) {
			const m = caseById.get(id);
			if (!m) { err('FIX_MUTATION_UNKNOWN', `${f.id}: ${id}`); continue; }
			if (m.expected_result !== 'KILLED') err('FIX_MUTATION_NOT_KILLED', `${f.id}: ${id} expects ${m.expected_result}`);
			if (m.detection !== 'behavioral') err('FIX_MUTATION_NOT_BEHAVIORAL', `${f.id}: ${id} detection ${m.detection}`);
			if (usedBy.has(id)) err('MUTATION_CLAIMED_TWICE', `${id}: ${usedBy.get(id)} and ${f.id}`);
			usedBy.set(id, f.id);
			for (const e of m.expected_failures ?? []) for (const file of m.tests ?? []) expected.add(`${file}\u0000${e.test}`);
		}
		if (!Array.isArray(f.tests) || !f.tests.length) err('FIX_WITHOUT_TEST', f.id);
		for (const t of f.tests ?? []) {
			if (root && !existsSync(path.join(root, t.file))) err('FIX_TEST_FILE_MISSING', `${f.id}: ${t.file}`);
			if (!expected.has(`${t.file}\u0000${t.test}`)) err('FIX_TEST_NOT_AN_EXPECTED_FAILURE', `${f.id}: ${t.file} :: ${t.test}`);
		}
	}

	// 4. Jede behobene Findings-Kennung (FINDING_FIXED) ist als Korrektur eingetragen.
	for (const id of findingsFixed) {
		if (!fixes.some((f) => FIX_CLASSES.includes(f.classification) && (f.tags ?? []).includes(id))) err('FINDING_FIX_UNREGISTERED', id);
	}

	// 5. Commits (nur mit vollstaendiger Historie).
	const registeredCommits = new Map((register.commits ?? []).map((c) => [c.commit, c]));
	for (const c of register.commits ?? []) {
		if (![...FIX_CLASSES, ...OTHER_CLASSES].includes(c.classification)) err('COMMIT_CLASS_UNKNOWN', `${c.commit}: ${c.classification}`);
		for (const id of c.fixes ?? []) if (!byId.has(id)) err('COMMIT_REFERS_TO_UNKNOWN_FIX', `${c.commit} -> ${id}`);
		if (FIX_CLASSES.includes(c.classification) && !(c.fixes ?? []).length) err('COMMIT_FIX_WITHOUT_ENTRY', c.commit);
		if (!FIX_CLASSES.includes(c.classification) && !c.reason) err('COMMIT_REASON_MISSING', c.commit);
	}
	if (commits.mode === 'FULL') {
		const rules = (register.commit_rules ?? []).map((r) => ({ ...r, re: new RegExp(r.subject) }));
		// Eingetragen als Kurz-Hash (>= 7 Zeichen); Vergleich als Praefix des vollen Hashes.
		const isRegistered = (hash) => [...registeredCommits.keys()].some((short) => short.length >= 7 && hash.startsWith(short));
		for (const c of commits.commits) {
			if (!c.matched || isRegistered(c.hash)) continue;
			if (rules.some((r) => r.re.test(c.subject))) continue;
			err('UNCLASSIFIED_SECURITY_COMMIT', `${c.hash.slice(0, 7)} ${c.subject}`);
		}
		for (const short of registeredCommits.keys()) if (!commits.commits.some((c) => c.hash.startsWith(short))) err('STALE_COMMIT', short);
	}

	const proven = fixes.filter((f) => FIX_CLASSES.includes(f.classification) && f.status === 'PROVEN').map((f) => f.id);
	return {
		errors,
		summary: {
			fixes: fixes.filter((f) => FIX_CLASSES.includes(f.classification)).length,
			proven: proven.length,
			missing,
			complete: errors.length === 0 && missing.length === 0,
			tags_discovered: discovered.tags.size,
			loose_markers: discovered.loose.length,
			commit_discovery: commits.mode
		}
	};
}

/** Alles in einem: Register laden und gegen das Repository unter `root` pruefen. */
export function checkRepository(root, { withCommits = true } = {}) {
	const register = JSON.parse(readFileSync(path.join(root, REGISTER_FILE), 'utf8'));
	const cases = JSON.parse(readFileSync(path.join(root, 'security/mutation/cases.json'), 'utf8')).cases;
	const changes = JSON.parse(readFileSync(path.join(root, 'security/crsf/framework-changes.json'), 'utf8'));
	const findingsFixed = [...new Set(changes.versions.flatMap((v) => v.changes ?? []).filter((c) => c.kind === 'FINDING_FIXED').map((c) => c.id))];
	return validateRegister({ register, discovered: discoverMarkers(root), commits: withCommits ? discoverCommits(root) : undefined, cases, findingsFixed, root });
}
