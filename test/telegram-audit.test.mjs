import test from 'node:test';
import assert from 'node:assert/strict';
import { authenticPrivateMessage, telegramTimingMetadata } from '../src/telegram-audit.mjs';

test('private Telegram messages require the sender to match the private chat', () => {
	assert.equal(authenticPrivateMessage({ chat: { id: 42, type: 'private' }, from: { id: 42 } }), true);
	assert.equal(authenticPrivateMessage({ chat: { id: 42, type: 'private' }, from: { id: 7 } }), false);
	assert.equal(authenticPrivateMessage({ chat: { id: -42, type: 'group' }, from: { id: 7 } }), true);
});

test('Telegram audit stores timing but no message contents', () => {
	const metadata = telegramTimingMetadata({ date: 1_000, text: '/start secret' }, 123, 1_090_000);
	assert.deepEqual(metadata, { updateId: '123', telegramSentAt: '1970-01-01T00:16:40.000Z', deliveryDelaySeconds: 90 });
	assert.equal(JSON.stringify(metadata).includes('secret'), false);
});
