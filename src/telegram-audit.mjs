/*
	NUR PRIVATE CHATS (10.10.2026).

	Der Bot arbeitet ausschliesslich im 1:1-Chat. Gruppen, Supergruppen,
	Kanaele, anonyme Admins (sender_chat), unbekannte Chat-Typen und jede
	andere Update-Art werden verworfen, bevor irgendetwas passiert: kein
	KI-Aufruf, kein Nexus-Abruf, keine Datenbank, keine Antwort. Das gilt auch
	dann, wenn der Bot in BotFather versehentlich fuer Gruppen freigegeben ist.
*/
function privateSender(chat, from) {
	return chat?.type === 'private'
		&& Number.isSafeInteger(chat.id) && chat.id > 0
		&& Number.isSafeInteger(from?.id) && from.id === chat.id
		&& from.is_bot !== true;
}

/** true nur fuer genau eine Nachricht oder einen Button-Klick aus einem privaten Chat. */
export function isPrivateChatUpdate(update) {
	if (!update || typeof update !== 'object' || Array.isArray(update)) return false;
	const kinds = Object.keys(update).filter((key) => key !== 'update_id');
	if (kinds.length !== 1) return false;
	if (kinds[0] === 'message') {
		const message = update.message;
		return privateSender(message?.chat, message?.from) && message.sender_chat == null;
	}
	if (kinds[0] === 'callback_query') {
		const query = update.callback_query;
		return privateSender(query?.message?.chat, query?.from) && query.message.sender_chat == null;
	}
	return false;
}

export function authenticPrivateMessage(message) {
	if (message?.chat?.type !== 'private') return true;
	return Number.isSafeInteger(message?.chat?.id)
		&& Number.isSafeInteger(message?.from?.id)
		&& message.chat.id === message.from.id;
}

export function telegramTimingMetadata(message, updateId, receivedAt = Date.now()) {
	const sentAtMs = Number.isSafeInteger(message?.date) && message.date >= 0 ? message.date * 1_000 : null;
	const delaySeconds = sentAtMs == null ? null : Math.max(0, Math.round((receivedAt - sentAtMs) / 1_000));
	return {
		...(Number.isSafeInteger(updateId) && updateId >= 0 ? { updateId: String(updateId) } : {}),
		...(sentAtMs == null ? {} : { telegramSentAt: new Date(sentAtMs).toISOString(), deliveryDelaySeconds: delaySeconds })
	};
}
