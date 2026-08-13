import test from 'node:test';
import assert from 'node:assert/strict';
import { groupLanguage, groupQuestion, isGroupMessageForBot } from '../src/group-chat.mjs';

const groupMessage = (text, extra = {}) => ({ chat: { id: -1001, type: 'supergroup' }, text, ...extra });

test('group bot reacts only to mentions, addressed commands, or replies to itself', () => {
	assert.equal(isGroupMessageForBot(groupMessage('Hallo zusammen'), 'RaccoonBot'), false);
	assert.equal(isGroupMessageForBot(groupMessage('Hey @RaccoonBot, alles fit?'), 'RaccoonBot'), true);
	assert.equal(isGroupMessageForBot(groupMessage('/help@RaccoonBot'), 'RaccoonBot'), true);
	assert.equal(isGroupMessageForBot(groupMessage('Und warum?', { reply_to_message: { from: { is_bot: true, username: 'RaccoonBot' } } }), 'RaccoonBot'), true);
	assert.equal(isGroupMessageForBot({ chat: { id: 1, type: 'private' }, text: '@RaccoonBot hi' }, 'RaccoonBot'), false);
});

test('group prompt removes the bot address and command wrapper', () => {
	assert.equal(groupQuestion(groupMessage('@RaccoonBot wie funktioniert das?'), 'RaccoonBot'), 'wie funktioniert das?');
	assert.equal(groupQuestion(groupMessage('/help@RaccoonBot bitte'), 'RaccoonBot'), 'bitte');
});

test('group language uses Telegram language without persisting a group profile', () => {
	assert.equal(groupLanguage({ from: { language_code: 'en-US' } }), 'en');
	assert.equal(groupLanguage({ from: { language_code: 'zh-hans' } }), 'zh');
	assert.equal(groupLanguage({ from: { language_code: 'de' } }), 'de');
});
