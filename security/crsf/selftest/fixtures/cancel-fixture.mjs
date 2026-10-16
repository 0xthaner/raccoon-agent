// CRSF self-test fixture L: a subtest cancelled by its parent (parent times out). Not part of the repository test suite.
import { test } from 'node:test';
test('CRSF fixture: parent times out while its subtest is still running', { timeout: 200 }, async (t) => {
	await t.test('CRSF fixture: cancelled security subtest', async () => { await new Promise((resolve) => setTimeout(resolve, 2000)); });
});
