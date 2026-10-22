/*
	LAUFZEIT-ALLOWLIST: WELCHE LAUFZEITEN COVERRACCOON IN PRODUKTION HAT (22.10.2026).

	Der Stack ist Node.js (ESM) auf Vercel, Supabase/PostgreSQL und
	Browser-JavaScript - siehe docs/RUNTIME-STACK.md. Mehr braucht CoverRaccoon
	nicht. Diese Pruefung schlaegt an, wenn das Repository still eine weitere
	Produktionslaufzeit bekommt: PHP, Ruby, ein Python-Server, Java, ein
	Go-Programm, eine nginx-/Apache-Konfiguration oder eine Vercel-Funktion mit
	einer anderen Laufzeit als Node.

	Nicht, weil diese Sprachen unsicher waeren. Jede zusaetzliche Laufzeit ist
	zusaetzliche Angriffsflaeche mit eigenem Patchzyklus (der Anlass: PHP2Shell,
	CVE-2026-109618/-109619, betraf CoverRaccoon nur deshalb nicht, weil es kein
	PHP gibt). Das soll so bleiben, bis es jemand bewusst aendert.

	Was die Pruefung NICHT tut: Woerter in Dokumentation zaehlen. Markdown und
	Kommentare werden nie nach "php" durchsucht. Gesucht wird nach
	- Dateien, die eine Laufzeit einfuehren (Dateiname/Endung),
	- Befehlen an Befehlsposition in Dateien, die Befehle ausfuehren
	  (package.json-Skripte, vercel.json, Workflows, Dockerfiles, Shellskripte,
	  child_process-Aufrufe im Anwendungscode),
	- Vercel-Laufzeitangaben und Laufzeit-Paketen.
	Entwicklerwerkzeuge (etwa ein `python3 tool.py`) bleiben erlaubt; nur
	Server-Starts und Paketmanager der fremden Laufzeit schlagen an.

	Ausserdem: die Node-Untergrenze. 24.22.1 schliesst die acht 24.x-CVEs des
	Node.js-Sicherheitsrelease vom 21.10.2026 (u. a. CVE-2026-111497, Brotli
	OOB-Write, und drei TLS-Hostnamen-Umgehungen) und bringt den CA-Store ohne
	die kompromittierten eMudhra-Zwischenzertifikate. Bei jedem neuen
	Node-Sicherheitsrelease hier anheben.
*/
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const NODE_UNTERGRENZE = '24.22.1';

/*
	Ausdrueckliche Ausnahmen: Pfad -> Begruendung. Leer. Wer hier etwas eintraegt,
	braucht einen Grund, der im Review besteht (etwa ein Sicherheits-Fixture, das
	nie ausgefuehrt wird).
*/
export const ERLAUBT = new Map();

// Verzeichnisse, die nie Projektquelle sind (gitignored oder fremd).
const NIE = new Set(['node_modules', '.git', 'dist-web', '.vercel', 'data', 'supabase/.temp', 'security/reports/out', 'web/public/fonts']);

/* ------------------------------------------------------- Dateinamen -- */

const DATEIREGELN = [
	[/\.(php\d?|phtml|phar)$/i, 'PHP', 'PHP-Quelltext'],
	[/(^|\/)composer\.(json|lock)$/i, 'PHP', 'Composer-Manifest'],
	[/(^|\/)php(-fpm)?\.ini$|(^|\/)php-fpm(\.d\/.*|\.conf)$/i, 'PHP', 'PHP-/php-fpm-Konfiguration'],
	[/(^|\/)(Gemfile(\.lock)?|config\.ru|[^/]+\.gemspec)$/, 'Ruby', 'Ruby-Manifest'],
	[/(^|\/)(requirements[^/]*\.txt|pyproject\.toml|Pipfile(\.lock)?|uv\.lock|poetry\.lock)$/i, 'Python', 'Python-Manifest (Vercel erkennt daran eine Python-Laufzeit)'],
	[/(^|\/)(pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?)$|\.(jar|war)$/i, 'Java', 'Java-Build oder -Archiv'],
	[/(^|\/)go\.(mod|sum|work)$|\.go$/i, 'Go', 'Go-Modul oder -Quelltext'],
	[/(^|\/)(nginx\.conf|[^/]+\.nginx(\.conf)?|\.htaccess|httpd\.conf|apache2\.conf)$|(^|\/)(sites-available|sites-enabled|conf\.d)\/[^/]+\.conf$/i, 'Webserver', 'nginx-/Apache-Konfiguration']
];

// Vercel waehlt die Laufzeit einer Funktion unter api/ nach der Dateiendung.
const API_ENDUNGEN = /\.(mjs|js|cjs|ts|mts)$/;

/* ---------------------------------------------------------- Befehle -- */

/*
	Ein Befehl zaehlt nur an Befehlsposition: erstes Wort eines Abschnitts nach
	&&, ||, ;, |, Zeilenumbruch oder $( - nach Umgebungszuweisungen und
	Vorsaetzen wie sudo/env/npx. "phpinfo" in einem Satz ist kein Befehl,
	`echo php` auch nicht.
*/
const VORSAETZE = new Set(['sudo', 'env', 'exec', 'npx', 'time', 'nohup', 'command']);

function befehlsVerstoss(woerter) {
	const [kopf, ...rest] = woerter;
	const name = path.posix.basename(kopf ?? '');
	if (/^php(\d+(\.\d+)?)?(-fpm\d*(\.\d+)?|-cgi)?$/.test(name)) return ['PHP', `PHP-Laufzeit '${name}'`];
	if (/^(composer|pecl|pear|phpize)$/.test(name)) return ['PHP', `PHP-Paketmanager '${name}'`];
	if (/^(nginx|openresty|apachectl|apache2|apache2ctl|httpd)$/.test(name)) return ['Webserver', `Webserver '${name}'`];
	if (/^(gunicorn|uvicorn|hypercorn|daphne|waitress-serve|flask)$/.test(name)) return ['Python', `Python-Server '${name}'`];
	if (/^python[\d.]*$/.test(name)) {
		const m = rest.indexOf('-m');
		if (m >= 0 && /^(http\.server|flask|uvicorn|gunicorn|django|hypercorn)$/.test(rest[m + 1] ?? '')) return ['Python', `Python-Server '${name} -m ${rest[m + 1]}'`];
		if (rest.some((w) => /(^|\/)manage\.py$/.test(w)) && rest.includes('runserver')) return ['Python', 'Django-Server'];
	}
	if (/^(rails|rackup|puma|unicorn|bundle|gem)$/.test(name)) return ['Ruby', `Ruby-Werkzeug '${name}'`];
	if (name === 'java' && rest.includes('-jar')) return ['Java', "Java-Programm 'java -jar'"];
	if (name === 'go' && /^(run|build|install)$/.test(rest[0] ?? '')) return ['Go', `Go-Programm 'go ${rest[0]}'`];
	return null;
}

export function befehlsVerstoesse(befehl) {
	const funde = [];
	for (const abschnitt of String(befehl).split(/&&|\|\||[;|\n]|\$\(|`/)) {
		const woerter = abschnitt.trim().split(/\s+/).filter(Boolean);
		while (woerter.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(woerter[0]) || VORSAETZE.has(woerter[0]))) woerter.shift();
		const verstoss = befehlsVerstoss(woerter);
		if (verstoss) funde.push(verstoss);
	}
	return funde;
}

const BASISABBILDER = /^(php|nginx|httpd|openresty|ruby|python|pypy|golang|openjdk|eclipse-temurin|amazoncorretto|tomcat|jetty)(:|@|$)/i;
const LAUFZEITPAKETE = new Set(['vercel-php', '@vercel/python', '@vercel/go', '@vercel/ruby', '@vercel/java']);

/* -------------------------------------------------------- Pruefung -- */

/**
 * Prueft eine Dateiliste. `lies(pfad)` liefert den Inhalt (nur fuer Dateien,
 * die Befehle tragen). Rueckgabe: Liste von { datei, zeile, laufzeit, grund }.
 */
export function pruefeStack(pfade, lies) {
	const funde = [];
	const melde = (datei, zeile, laufzeit, grund) => { if (!ERLAUBT.has(datei)) funde.push({ datei, zeile, laufzeit, grund }); };
	const befehl = (datei, zeile, text) => { for (const [laufzeit, grund] of befehlsVerstoesse(text)) melde(datei, zeile, laufzeit, grund); };

	for (const datei of pfade) {
		for (const [muster, laufzeit, grund] of DATEIREGELN) if (muster.test(datei)) melde(datei, 0, laufzeit, grund);
		if (datei.startsWith('api/') && !API_ENDUNGEN.test(datei)) melde(datei, 0, 'Vercel', 'Datei unter api/ ohne Node-Endung (Vercel wuerde sie mit einer anderen Laufzeit ausliefern)');

		const name = path.posix.basename(datei);
		if (datei === 'package.json') {
			const pkg = JSON.parse(lies(datei));
			for (const [skript, text] of Object.entries(pkg.scripts ?? {})) if (!skript.startsWith('//')) befehl(datei, `scripts.${skript}`, text);
			for (const feld of ['dependencies', 'devDependencies', 'optionalDependencies']) {
				for (const paket of Object.keys(pkg[feld] ?? {})) if (LAUFZEITPAKETE.has(paket)) melde(datei, `${feld}.${paket}`, 'Vercel', `Laufzeitpaket '${paket}'`);
			}
		} else if (datei === 'vercel.json') {
			const cfg = JSON.parse(lies(datei));
			for (const feld of ['installCommand', 'buildCommand', 'devCommand']) if (cfg[feld]) befehl(datei, feld, cfg[feld]);
			for (const [muster, fn] of Object.entries(cfg.functions ?? {})) {
				if (fn?.runtime && !/^@vercel\/node(@|$)/.test(fn.runtime)) melde(datei, `functions.${muster}.runtime`, 'Vercel', `Funktionslaufzeit '${fn.runtime}'`);
			}
			for (const [i, b] of (cfg.builds ?? []).entries()) {
				if (b?.use && !/^@vercel\/(node|static|static-build)(@|$)/.test(b.use)) melde(datei, `builds[${i}].use`, 'Vercel', `Builder '${b.use}'`);
			}
		} else if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(datei) || /\.(sh|bash)$/.test(name) || name === 'Procfile') {
			lies(datei).split('\n').forEach((zeile, i) => {
				const text = zeile.replace(/^\s*-?\s*run:\s*/, '').replace(/^[a-z]+:\s*/, '');
				if (/^\s*#/.test(zeile)) return;
				befehl(datei, i + 1, text);
			});
		} else if (/^(Docker|Container)file(\..*)?$|\.dockerfile$/i.test(name) || /^(docker-)?compose(\.[^.]+)?\.ya?ml$/i.test(name)) {
			lies(datei).split('\n').forEach((zeile, i) => {
				const from = zeile.match(/^\s*FROM\s+(?:--\S+\s+)*(\S+)/i) ?? zeile.match(/^\s*image:\s*['"]?([^'"\s]+)/);
				if (from && BASISABBILDER.test(path.posix.basename(from[1].replace(/^docker\.io\//, '')))) melde(datei, i + 1, 'Container', `Basisabbild '${from[1]}'`);
				const run = zeile.match(/^\s*(?:RUN|CMD|ENTRYPOINT)\s+(.*)$/i);
				if (run) befehl(datei, i + 1, run[1].replace(/[[\]",]/g, ' '));
			});
		} else if (/^(src|api|scripts|web\/src)\//.test(datei) && /\.(mjs|js|cjs)$/.test(name)) {
			// Anwendungscode: nur das Programm eines child_process-Aufrufs, nicht beliebige Zeichenketten.
			// Kommentare werden zeilentreu geleert: sie duerfen erklaeren, was hier verboten ist.
			const quelle = lies(datei)
				.replace(/\/\*[\s\S]*?\*\//g, (t) => t.replace(/[^\n]/g, ' '))
				.replace(/(^|[^:])\/\/[^\n]*/g, (t, vor) => vor + ' '.repeat(t.length - vor.length));
			for (const m of quelle.matchAll(/\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync)\s*\(\s*(['"`])([^'"`]+)\1/g)) {
				befehl(datei, quelle.slice(0, m.index).split('\n').length, m[2]);
			}
		}
	}
	return funde;
}

/** Laeuft die Node-Version, mit der gerade gebaut oder geprueft wird, auf dem gepatchten Stand? */
export function pruefeNode(version = process.version, engines = '24.x') {
	const [maj, min, pat] = version.replace(/^v/, '').split('.').map(Number);
	const [umaj, umin, upat] = NODE_UNTERGRENZE.split('.').map(Number);
	const funde = [];
	const engineMaj = Number(String(engines).match(/^\D*(\d+)/)?.[1]);
	if (maj !== engineMaj) funde.push(`Node ${version} passt nicht zu engines.node "${engines}"`);
	else if (maj === umaj && (min < umin || (min === umin && pat < upat))) funde.push(`Node ${version} liegt unter der Sicherheitsuntergrenze ${NODE_UNTERGRENZE} (Node.js-Sicherheitsrelease 21.10.2026)`);
	return funde;
}

export function projektDateien(wurzel) {
	try {
		const roh = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: wurzel, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
		return roh.split('\0').filter(Boolean).filter((p) => ![...NIE].some((n) => p === n || p.startsWith(`${n}/`)));
	} catch {
		// Ohne git (etwa in der Mutations-Wegwerfkopie): selbst durchlaufen.
		const lauf = (rel) => readdirSync(path.join(wurzel, rel)).flatMap((name) => {
			const p = rel ? `${rel}/${name}` : name;
			if (NIE.has(p) || name === 'node_modules' || name === '.git') return [];
			return statSync(path.join(wurzel, p)).isDirectory() ? lauf(p) : [p];
		});
		return lauf('');
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const wurzel = process.cwd();
	const pkg = JSON.parse(readFileSync(path.join(wurzel, 'package.json'), 'utf8'));
	console.log(`\nLaufzeit: Node ${process.version} (engines ${pkg.engines?.node}, Untergrenze ${NODE_UNTERGRENZE})`);
	const nodeFunde = pruefeNode(process.version, pkg.engines?.node);
	for (const f of nodeFunde) console.error(`  FEHLT ${f}`);
	let stackFunde = [];
	if (!process.argv.includes('--nur-node')) {
		console.log('Laufzeit: keine fremde Produktionslaufzeit (PHP, Ruby, Python-Server, Java, Go, nginx/Apache)');
		stackFunde = pruefeStack(projektDateien(wurzel), (p) => readFileSync(path.join(wurzel, p), 'utf8'));
		for (const f of stackFunde) console.error(`  FEHLT ${f.datei}${f.zeile ? `:${f.zeile}` : ''}\n        ${f.laufzeit}: ${f.grund}`);
	}
	if (nodeFunde.length || stackFunde.length) {
		console.error(`\n${nodeFunde.length + stackFunde.length} Verstoss/Verstoesse. Neue Laufzeit bewusst einfuehren: docs/RUNTIME-STACK.md aendern und den Grund im Review vertreten.`);
		process.exit(1);
	}
	console.log('  ok');
}
