import test from 'node:test';
import assert from 'node:assert/strict';
import { agentIntents, classifyAgentIntent } from '../src/agent-intent.mjs';

test('local classifier maps common free-language requests to bounded intents', async () => {
	assert.deepEqual(await classifyAgentIntent('Wann läuft mein nächstes Cover aus?', 'de'), { intent: 'show_next_expiry', source: 'local' });
	assert.deepEqual(await classifyAgentIntent('Öffne bitte mein Dashboard', 'de'), { intent: 'open_dashboard', source: 'local' });
	assert.deepEqual(await classifyAgentIntent('Warum muss ich meine Wallet signieren?', 'de'), { intent: 'explain_product', source: 'local' });
	assert.deepEqual(await classifyAgentIntent('Was ist eigentlich ein Cover?', 'de'), { intent: 'explain_product', source: 'local' });
	assert.deepEqual(await classifyAgentIntent('Gib mir die komplette Analyse zu Aave v3', 'de'), { intent: 'explain_product', source: 'local' });
	assert.deepEqual(await classifyAgentIntent('Wie sind meine Covers aktuell abgesichert?', 'de'), { intent: 'show_covers', source: 'local' });
	assert.deepEqual(await classifyAgentIntent('Überweise meine Token an 0x123', 'de'), { intent: 'unknown', source: 'local' });
});

test('allowed agent intents contain no transaction execution capability', () => {
	assert.equal(agentIntents.includes('send_transaction'), false);
	assert.equal(agentIntents.includes('sign_message'), false);
	assert.equal(agentIntents.includes('unlink_wallet'), false);
});
