/*
	Minimal strict JSON Schema validator (subset of draft 2020-12) for the CRSF
	definition files. No dependency on purpose: the verifier must run from a clean
	checkout with the existing lockfile.

	Supported keywords: type, enum, const, required, properties,
	additionalProperties (boolean or schema), items, minItems, uniqueItems,
	minLength, pattern, minimum, maximum, $ref (local "#/$defs/..."), oneOf, $defs.
	Unknown keywords in a schema are a schema-authoring error (fail closed).
*/
const KNOWN = new Set(['$schema', '$id', '$defs', 'title', 'description', 'type', 'enum', 'const', 'required', 'properties', 'additionalProperties', 'items', 'minItems', 'uniqueItems', 'minLength', 'pattern', 'minimum', 'maximum', '$ref', 'oneOf']);

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
const typeMatches = (want, v) => {
	const t = typeOf(v);
	return want === t || (want === 'number' && t === 'integer');
};

export function validate(schema, value, root = schema, at = '$') {
	const errors = [];
	for (const key of Object.keys(schema)) if (!KNOWN.has(key)) errors.push(`${at}: schema uses unsupported keyword "${key}"`);
	if (schema.$ref) {
		const target = schema.$ref.replace(/^#\/\$defs\//, '');
		const sub = root.$defs?.[target];
		if (!sub) return [`${at}: unresolved $ref ${schema.$ref}`];
		return validate(sub, value, root, at);
	}
	if (schema.oneOf) {
		const passing = schema.oneOf.filter((s) => validate(s, value, root, at).length === 0).length;
		if (passing !== 1) errors.push(`${at}: matches ${passing} of oneOf alternatives (exactly 1 required)`);
	}
	if (schema.type) {
		const types = [].concat(schema.type);
		if (!types.some((t) => typeMatches(t, value))) return [...errors, `${at}: expected ${types.join('|')}, got ${typeOf(value)}`];
	}
	if (schema.const !== undefined && JSON.stringify(value) !== JSON.stringify(schema.const)) errors.push(`${at}: must equal ${JSON.stringify(schema.const)}`);
	if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) errors.push(`${at}: ${JSON.stringify(value)} not in enum`);
	if (typeof value === 'string') {
		if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${at}: shorter than ${schema.minLength}`);
		if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${at}: does not match ${schema.pattern}`);
	}
	if (typeof value === 'number') {
		if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${at}: below ${schema.minimum}`);
		if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${at}: above ${schema.maximum}`);
	}
	if (Array.isArray(value)) {
		if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${at}: fewer than ${schema.minItems} items`);
		if (schema.uniqueItems && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) errors.push(`${at}: items not unique`);
		if (schema.items) value.forEach((v, i) => errors.push(...validate(schema.items, v, root, `${at}[${i}]`)));
	}
	if (typeOf(value) === 'object') {
		for (const key of schema.required ?? []) if (!(key in value)) errors.push(`${at}: missing required "${key}"`);
		for (const [key, v] of Object.entries(value)) {
			if (schema.properties?.[key]) errors.push(...validate(schema.properties[key], v, root, `${at}.${key}`));
			else if (schema.additionalProperties === false) errors.push(`${at}: unknown property "${key}"`);
			else if (typeof schema.additionalProperties === 'object') errors.push(...validate(schema.additionalProperties, v, root, `${at}.${key}`));
		}
	}
	return errors;
}
