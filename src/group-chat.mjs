const GROUP_TYPES = new Set(['group', 'supergroup']);

export function groupLanguage(message) {
	const code = String(message?.from?.language_code ?? '').toLowerCase();
	if (code.startsWith('zh')) return 'zh';
	if (code.startsWith('en')) return 'en';
	return 'de';
}

export function isGroupMessageForBot(message, botUsername) {
	if (!GROUP_TYPES.has(message?.chat?.type) || typeof message?.text !== 'string') return false;
	const username = String(botUsername ?? '').replace(/^@/, '').toLowerCase();
	if (!username) return false;
	const repliedToBot = message.reply_to_message?.from?.is_bot
		&& String(message.reply_to_message.from.username ?? '').toLowerCase() === username;
	const mentioned = new RegExp(`(^|\\s)@${username}(?=\\s|$|[,.!?;:])`, 'i').test(message.text);
	const addressedCommand = new RegExp(`^\\/[^\\s@]+@${username}(?=\\s|$)`, 'i').test(message.text.trim());
	return Boolean(repliedToBot || mentioned || addressedCommand);
}

export function groupQuestion(message, botUsername) {
	const username = String(botUsername ?? '').replace(/^@/, '');
	return String(message?.text ?? '')
		.replace(new RegExp(`@${username}(?=\\s|$|[,.!?;:])`, 'ig'), '')
		.replace(/^\/[a-z_]+(?:@[a-z0-9_]+)?\s*/i, '')
		.trim();
}

