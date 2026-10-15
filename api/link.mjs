import { isAddress } from 'viem';
import { getPendingLink } from '../src/db.mjs';
import { isTelegramLinkCode, isTelegramLinkRow, signingMessage, telegramTarget } from '../src/linking.mjs';
import { enforceRateLimit, enforceRateLimitFor } from '../src/http-security.mjs';
import { contractCodeQuorum } from '../src/contract-signature.mjs';
import { signingRefusal } from '../src/signing-policy.mjs';
import { queryParams, singleQueryValue } from '../src/request-query.mjs';
import { ANMELDUNG_PAUSIERT, pauseAntwort } from '../src/pause.mjs';

export default async function handler(request, response) {
	response.setHeader('cache-control', 'no-store');
	if (request.method !== 'GET') return response.status(405).json({ ok: false, error: 'Method not allowed' });
	if (ANMELDUNG_PAUSIERT) return pauseAntwort(response);
	if (!await enforceRateLimit(request, response, 'wallet-link-read', 30, 600)) return;
	const query = queryParams(request);
	const code = singleQueryValue(query, 'code');
	const wallet = singleQueryValue(query, 'wallet');
	// AUDIT-2026-10-12 F1: nur echte Verknuepfungscodes und -zeilen, siehe linking.mjs.
	const pending = isTelegramLinkCode(code) ? await getPendingLink(code) : null;
	if (!pending || !isTelegramLinkRow(pending) || pending.used_at || pending.expires_at < Date.now()) {
		return response.status(410).json({ ok: false, error: 'Verbindungscode ungültig oder abgelaufen.' });
	}
	/*
		Ohne Wallet: nur sagen, MIT WELCHEM Telegram-Konto verknuepft wird.
		Sonst kann jemand einem anderen seinen eigenen Verknuepfungslink schicken
		("bitte kurz bestaetigen"), und dessen Wallet haengt danach an fremdem
		Chat. Der Name kommt live von Telegram und wird nicht gespeichert.
		AUDIT E-L2: dieselbe Zielbeschreibung steht auch im Signaturtext; ohne sie
		gibt es keinen Text zum Signieren.
	*/
	const target = await telegramTarget(pending.chat_id);
	if (!wallet) {
		return response.status(200).json({ ok: true, telegram: target });
	}
	if (!isAddress(wallet)) return response.status(400).json({ ok: false, error: 'Ungültige Wallet-Adresse.' });
	if (!target) return response.status(503).json({ ok: false, code: 'TELEGRAM_TARGET_UNAVAILABLE', error: 'Das Telegram-Konto zu diesem Link konnte gerade nicht bestätigt werden. Bitte gleich erneut versuchen.' });
	// META-AUDIT M-3: den Text zum Signieren gibt es nur fuer eine EOA (beide Provider
	// ohne Code). Fuer eine Safe / Contract-Wallet oder bei unklarer Art keine
	// Nachricht - so startet keine Signaturanfrage, aus der Safe{Wallet} einen
	// Transaktionsvorschlag machen koennte (src/signing-policy.mjs). Globales Budget
	// VOR den beiden getCode-Aufrufen (wie M-2).
	if (!await enforceRateLimitFor(response, 'wallet-link-read-global', 'all', 300, 600)) return;
	const refusal = signingRefusal(await contractCodeQuorum(wallet));
	if (refusal) return response.status(refusal.status).json(refusal.body);
	return response.status(200).json({
		ok: true,
		telegram: target,
		message: signingMessage({ wallet, nonce: pending.nonce, expiresAt: pending.expires_at, code, target: target.target })
	});
}
