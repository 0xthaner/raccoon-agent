import { isAddress } from 'viem';
import { getPendingLink } from '../src/db.mjs';
import { isTelegramLinkCode, isTelegramLinkRow, signingMessage, telegramTarget } from '../src/linking.mjs';
import { enforceRateLimit, enforceRateLimitFor } from '../src/http-security.mjs';
import { queryParams, singleQueryValue } from '../src/request-query.mjs';
import { ANMELDUNG_PAUSIERT, pauseAntwort } from '../src/pause.mjs';

/*
	Je Code: ein Link-Ablauf liest einmal beim Oeffnen und einmal je Signaturversuch
	(/api/link/verify erlaubt 5 je Code); 10 laesst Luft fuer Neuladen. Global: zwei
	Lesungen je Code, den der Bot in 10 Minuten hoechstens ausgibt
	(LINK_CODE_GLOBAL_LIMIT in src/linking.mjs, 300 -> 600; test/link-read-budget prueft das).
*/
const LINK_READ_CODE_LIMIT = Object.freeze({ max: 10, windowSeconds: 600 });
const LINK_READ_GLOBAL_LIMIT = Object.freeze({ max: 600, windowSeconds: 600 });

export default async function handler(request, response) {
	response.setHeader('cache-control', 'no-store');
	if (request.method !== 'GET') return response.status(405).json({ ok: false, error: 'Method not allowed' });
	if (ANMELDUNG_PAUSIERT) return pauseAntwort(response);
	if (!await enforceRateLimit(request, response, 'wallet-link-read', 30, 600)) return;
	const query = queryParams(request);
	const code = singleQueryValue(query, 'code');
	const wallet = singleQueryValue(query, 'wallet');
	// AUDIT-2026-10-12 F1: nur echte Verknuepfungscodes und -zeilen, siehe linking.mjs.
	if (!isTelegramLinkCode(code)) return response.status(410).json({ ok: false, error: 'Verbindungscode ungültig oder abgelaufen.' });
	/*
		CRSF F-2K-1 / CR-RESOURCE-001 P5, 17.10.2026: vorher lief Telegram getChat
		(telegramTarget, mit dem Bot-Token) nach der IP-Schranke allein - ein
		gueltiger Code liess sich ueber wechselnde IPs beliebig oft abfragen. Jetzt
		zusaetzlich je Code (eigener Schluessel: Lesen soll die Versuche von
		/api/link/verify nicht aufbrauchen) und - erst fuer gueltige, offene Links,
		damit erfundene Codes es nicht leeren - ein globales Budget, beides VOR getChat.
	*/
	if (!await enforceRateLimitFor(response, 'wallet-link-read-code', code, LINK_READ_CODE_LIMIT.max, LINK_READ_CODE_LIMIT.windowSeconds)) return;
	const pending = await getPendingLink(code);
	if (!pending || !isTelegramLinkRow(pending) || pending.used_at || pending.expires_at < Date.now()) {
		return response.status(410).json({ ok: false, error: 'Verbindungscode ungültig oder abgelaufen.' });
	}
	if (wallet && !isAddress(wallet)) return response.status(400).json({ ok: false, error: 'Ungültige Wallet-Adresse.' });
	if (!await enforceRateLimitFor(response, 'wallet-link-read-global', 'all', LINK_READ_GLOBAL_LIMIT.max, LINK_READ_GLOBAL_LIMIT.windowSeconds)) return;
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
	if (!target) return response.status(503).json({ ok: false, code: 'TELEGRAM_TARGET_UNAVAILABLE', error: 'Das Telegram-Konto zu diesem Link konnte gerade nicht bestätigt werden. Bitte gleich erneut versuchen.' });
	return response.status(200).json({
		ok: true,
		telegram: target,
		message: signingMessage({ wallet, nonce: pending.nonce, expiresAt: pending.expires_at, code, target: target.target })
	});
}
