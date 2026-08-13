export default function handler(_request, response) {
	response.setHeader('cache-control', 'no-store');
	response.status(200).json({ reownProjectId: process.env.REOWN_PROJECT_ID?.trim() || '', telegramUsername: process.env.TELEGRAM_BOT_USERNAME?.trim().replace(/^@/, '') || '' });
}
