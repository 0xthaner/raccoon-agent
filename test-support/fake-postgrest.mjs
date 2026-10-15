/*
	Testhilfe: ein kleiner In-Memory-Ersatz fuer den Supabase/PostgREST-Client,
	gerade genug fuer die Telegram-Verknuepfungs-Helfer in src/db.mjs (select,
	eq, in, like, match, order, limit, insert, update, upsert, delete mit
	optionalem select). So laeuft der ECHTE Helfer-Code mit seinen echten
	Filtern; ein fehlender oder falscher Filter loescht hier wie in der
	Datenbank zu viel und faellt im Test auf.

	Primaerschluessel wie in den Migrationen: monitored_wallets (chat_id, wallet),
	wallet_links (chat_id), pending_links (code), user_preferences (chat_id).
*/
const PRIMARY_KEYS = {
	monitored_wallets: ['chat_id', 'wallet'],
	wallet_links: ['chat_id'],
	pending_links: ['code'],
	user_preferences: ['chat_id']
};

const likeToRegex = (pattern) => new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.')}$`);

export function fakePostgrest(initial = {}) {
	const tables = Object.fromEntries(Object.entries(initial).map(([name, rows]) => [name, rows.map((row) => ({ ...row }))]));
	const table = (name) => (tables[name] ??= []);

	function builder(name) {
		const filters = [];
		let op = 'select';
		let payload = null;
		let returning = false;
		let projection = '*';
		let limit = Infinity;
		const api = {
			select(cols = '*') { if (op === 'select') projection = cols; else returning = true; projection = cols; return api; },
			eq(key, val) { filters.push((row) => String(row[key]) === String(val)); return api; },
			is(key, val) { filters.push((row) => (row[key] ?? null) === val); return api; },
			in(key, vals) { filters.push((row) => vals.map(String).includes(String(row[key]))); return api; },
			like(key, pattern) { const re = likeToRegex(pattern); filters.push((row) => re.test(String(row[key]))); return api; },
			lt(key, val) { filters.push((row) => String(row[key]) < String(val)); return api; },
			match(obj) { for (const [k, v] of Object.entries(obj)) api.eq(k, v); return api; },
			order() { return api; },
			limit(n) { limit = n; return api; },
			delete() { op = 'delete'; return api; },
			insert(obj) { op = 'insert'; payload = obj; return api; },
			update(obj) { op = 'update'; payload = obj; return api; },
			upsert(obj) { op = 'upsert'; payload = obj; return api; },
			then(resolve, reject) { try { resolve(run()); } catch (error) { reject(error); } }
		};
		const project = (row) => (projection === '*' ? { ...row } : Object.fromEntries(projection.split(',').map((c) => c.trim()).map((c) => [c, row[c]])));
		const matches = () => table(name).filter((row) => filters.every((f) => f(row)));
		function run() {
			if (op === 'select') return { data: matches().slice(0, limit).map(project), error: null };
			if (op === 'delete') {
				const gone = matches();
				tables[name] = table(name).filter((row) => !gone.includes(row));
				return { data: returning ? gone.map(project) : null, error: null };
			}
			if (op === 'insert') {
				for (const row of [].concat(payload)) table(name).push({ ...row });
				return { data: null, error: null };
			}
			if (op === 'update') {
				const hit = matches();
				for (const row of hit) Object.assign(row, payload);
				return { data: returning ? hit.map(project) : null, error: null };
			}
			if (op === 'upsert') {
				const keys = PRIMARY_KEYS[name] ?? ['id'];
				for (const row of [].concat(payload)) {
					const existing = table(name).find((r) => keys.every((k) => String(r[k]) === String(row[k])));
					if (existing) Object.assign(existing, row); else table(name).push({ ...row });
				}
				return { data: null, error: null };
			}
			throw new Error(`unsupported op ${op}`);
		}
		return api;
	}

	return { from: (name) => builder(name), tables, rows: (name) => table(name).map((row) => ({ ...row })) };
}
