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
