/*
	Testhilfe fuer Echt-Postgres-Tests: der ECHTE supabase-js-Client aus src/db.mjs
	spricht per fetch "PostgREST"; hier wird jede Anfrage in genau das eine Statement
	uebersetzt, das PostgREST dafuer ausfuehrt (eine Anfrage = ein Statement in einer
	eigenen Transaktion, READ COMMITTED), und auf einer EIGENEN Verbindung ausgefuehrt.

	Eine Schranke gibt Anfragen derselben Art erst frei, wenn `size` Stueck angekommen
	sind - so laufen gleichzeitige Aufrufe wirklich gleichzeitig. Kommen nicht alle an
	(ein Teil der Aufrufer endet vorher), loest eine Frist nach 1 s; gezaehlt in
	`timeouts`, damit ein Haenger nie als Gleichzeitigkeit durchgeht.

	Unterstuetzt nur, was die getesteten Helfer brauchen: select/insert/upsert/update/
	delete mit eq, gt, lt, like, is.null, order, limit, sowie RPC mit benannten Argumenten.
	Alles andere wirft - ein unbekanntes Muster faellt im Test auf, statt still falsch
	uebersetzt zu werden.
*/
const COLUMN = /^[a-z_][a-z_0-9]*$/;
const column = (name) => { if (!COLUMN.test(name)) throw new Error(`Spalte ${name}`); return name; };

export function statementFor(method, path, params, body, prefer = '') {
	const values = [];
	const push = (value) => { values.push(value); return `$${values.length}`; };
	if (path.startsWith('rpc/')) {
		const fn = column(path.slice(4));
		const args = Object.entries(body ?? {}).map(([name, value]) => `${column(name)} => ${push(value)}`);
		return { rpc: true, text: `select public.${fn}(${args.join(', ')}) as result`, values };
	}
	const table = column(path);
	const where = [];
	let select = '*';
	let order = '';
	let limit = '';
	let onConflict = null;
	for (const [key, raw] of params) {
		if (key === 'select') { select = raw === '*' ? '*' : raw.split(',').map(column).join(', '); continue; }
		if (key === 'columns') continue;
		if (key === 'on_conflict') { onConflict = raw.split(',').map(column); continue; }
		if (key === 'order') { order = ` order by ${raw.split(',').map((part) => { const [c, dir] = part.split('.'); return `${column(c)}${dir === 'desc' ? ' desc' : ''}`; }).join(', ')}`; continue; }
		if (key === 'limit') { limit = ` limit ${Number.parseInt(raw, 10)}`; continue; }
		column(key);
		const dot = raw.indexOf('.');
		const operator = raw.slice(0, dot);
		const value = raw.slice(dot + 1);
		if (operator === 'eq') where.push(`${key} = ${push(value)}`);
		else if (operator === 'gt') where.push(`${key} > ${push(value)}`);
		else if (operator === 'lt') where.push(`${key} < ${push(value)}`);
		else if (operator === 'like') where.push(`${key} like ${push(value.replace(/\*/g, '%'))}`);
		else if (operator === 'is' && value === 'null') where.push(`${key} is null`);
		else throw new Error(`Filter ${key}=${raw}`);
	}
	const filter = where.length ? ` where ${where.join(' and ')}` : '';
	if (method === 'GET') return { text: `select ${select} from public.${table}${filter}${order}${limit}`, values };
	if (method === 'DELETE') return { text: `delete from public.${table}${filter} returning ${select}`, values };
	if (method === 'PATCH') {
		const sets = Object.entries(body).map(([c, value]) => `${column(c)} = ${push(value)}`);
		return { text: `update public.${table} set ${sets.join(', ')}${filter} returning ${select}`, values };
	}
	if (method === 'POST') {
		const rows = [].concat(body);
		const columns = Object.keys(rows[0]).map(column);
		const tuples = rows.map((row) => `(${columns.map((c) => push(row[c])).join(', ')})`);
		let conflict = '';
		if (prefer.includes('resolution=merge-duplicates')) {
			if (!onConflict) throw new Error('upsert ohne on_conflict');
			conflict = ` on conflict (${onConflict.join(', ')}) do update set ${columns.filter((c) => !onConflict.includes(c)).map((c) => `${c} = excluded.${c}`).join(', ')}`;
		}
		return { text: `insert into public.${table} (${columns.join(', ')}) values ${tuples.join(', ')}${conflict} returning ${select}`, values };
	}
	throw new Error(`Methode ${method}`);
}

/** fetch-Ersatz fuer genau einen Host. `connect` liefert eine neue pg-Verbindung. */
export function postgrestOverPg({ host, connect, maxConnections }) {
	const idle = [];
	const all = [];
	const state = { barrier: null, timeouts: 0, requests: [] };
	const acquire = async () => idle.pop() ?? (async () => { const c = await connect(); all.push(c); return c; })();

	async function arrive(kind) {
		const barrier = state.barrier;
		if (!barrier) return;
		const slot = (barrier[kind] ??= { count: 0, waiters: [], timer: null });
		slot.count++;
		const release = () => { clearTimeout(slot.timer); for (const go of slot.waiters.splice(0)) go(); };
		if (slot.count >= barrier.size) { release(); return; }
		slot.timer ??= setTimeout(() => { state.timeouts++; release(); }, 1_000);
		await new Promise((resolve) => slot.waiters.push(resolve));
	}

	async function fetchImpl(input, init = {}) {
		const url = new URL(typeof input === 'string' ? input : input.url);
		if (url.hostname !== host) throw new Error(`unerwarteter Abruf ${url.hostname}`);
		const method = (init.method ?? 'GET').toUpperCase();
		const path = url.pathname.replace('/rest/v1/', '');
		const prefer = new Headers(init.headers).get('prefer') ?? '';
		state.requests.push(`${method} ${path}`);
		await arrive(`${method} ${path}`);
		const client = await acquire();
		try {
			const statement = statementFor(method, path, url.searchParams, init.body ? JSON.parse(init.body) : null, prefer);
			const { rows } = await client.query(statement.text, statement.values);
			if (statement.rpc) return Response.json(rows[0]?.result ?? null);
			if (method !== 'GET' && !prefer.includes('return=representation')) return new Response(null, { status: method === 'POST' ? 201 : 204 });
			return Response.json(rows, { status: method === 'POST' ? 201 : 200 });
		} catch (error) {
			return Response.json({ message: error.message, code: error.code }, { status: 400 });
		} finally {
			idle.push(client);
		}
	}

	return {
		fetch: fetchImpl,
		state,
		/** Vorab N Verbindungen oeffnen, damit eine Runde nie auf einen Verbindungsaufbau wartet. */
		async warm(n = maxConnections) { while (idle.length < n) { const c = await connect(); all.push(c); idle.push(c); } },
		/** N gleichzeitige Aufrufe mit Schranke fuer genau diese Runde. */
		async race(size, fn) {
			state.barrier = { size };
			try { return await Promise.all(Array.from({ length: size }, (_, i) => fn(i))); }
			finally { state.barrier = null; }
		},
		async close() { await Promise.allSettled(all.map((c) => c.end())); }
	};
}
