import test from 'node:test';
import assert from 'node:assert/strict';
import { dueThreshold, formatExpiryAlert } from '../src/alerts.mjs';

const DAY = 86_400_000;
const NOW = Date.parse('2026-08-13T08:00:00.000Z');

test('dueThreshold respects each wallet selection', () => {
	assert.equal(dueThreshold(new Date(NOW + 6 * DAY).toISOString(), NOW, [30, 7, 1, 0]), 7);
	assert.equal(dueThreshold(new Date(NOW + 6 * DAY).toISOString(), NOW, [3, 1, 0]), null);
	assert.equal(dueThreshold(new Date(NOW + DAY / 2).toISOString(), NOW, [1, 0]), 1);
});

test('expiry messages include cover identity and selected threshold', () => {
	const text = formatExpiryAlert({ coverId: 42, productId: 1, productName: 'Aave v3', amount: '15000', asset: { symbol: 'USDC' }, endsAt: new Date(NOW + 7 * DAY).toISOString() }, 7, 'de');
	assert.match(text, /Cover: #42/);
	assert.match(text, /7 Tage/);
	assert.match(text, /15(?:\.|\s| )000 USDC/);
});
