import { timingSafeEqual } from 'node:crypto';
import { recordRenewalEvent } from '../src/db.mjs';

function authorized(header) {
	const expected = process.env.COVER_AGENT_API_KEY?.trim() ?? '';
	if (!expected || typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
	const supplied = Buffer.from(header.slice(7));
	const wanted = Buffer.from(expected);
	return supplied.length === wanted.length && timingSafeEqual(supplied, wanted);
}

export default async function handler(request, response) {
	response.setHeader('cache-control', 'no-store');
	if (request.method !== 'POST') return response.status(405).json({ ok: false });
	if (!authorized(request.headers.authorization)) return response.status(404).json({ ok: false });
	try {
		const result = await recordRenewalEvent(request.body ?? {});
		return response.status(200).json({ ok: true, ...result });
	} catch (error) {
		return response.status(400).json({ ok: false, error: error.message });
	}
}
