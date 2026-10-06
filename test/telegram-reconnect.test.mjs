/** HARD-004: reconnect always requests a new chat-bound wallet signature. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const bot = readFileSync('src/bot.mjs', 'utf8');
test('legacy direct handoffs cannot bind a wallet', () => {
 assert.doesNotMatch(bot, /consumeTelegramHandoff\(/);
 assert.match(bot, /Boolean\(startCodeOf\(message.text\)\)/);
});
test('explicit connect requests enter signed flow even for an existing chat wallet', () => {
 assert.match(bot, /existingWallet && !connectRequested/);
 assert.match(bot, /connectRequested \|\| !await getWalletLink/);
 assert.match(bot, /newLinkRequest\(message.chat.id\)/);
});
test('ordinary start retains the already-active message', () => {
 assert.match(bot, /Raccoon Agent ist bereits aktiv/);
 assert.match(bot, /Raccoon Agent is already active/);
});
test('disconnect remains scoped to the Telegram chat', () => {
 const db = readFileSync('src/db.mjs', 'utf8');
 const block = db.slice(db.indexOf('export async function unlinkWallet('));
 assert.match(block, /from\('monitored_wallets'\)\.delete\(\)\.eq\('chat_id'/);
 assert.match(block, /from\('wallet_links'\)\.delete\(\)\.eq\('chat_id'/);
});
