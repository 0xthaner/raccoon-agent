/*
	CRSF test executor (child process).

	Runs the given test files with the Node test runner in the current working
	directory and prints ONE JSON line with every test outcome. Started by
	security/crsf/lib/exec.mjs with a controlled environment; never imported.

	Usage: node node-test-exec.mjs <file> [<file> ...]
	Output: {"results":[{file,name,outcome,message}]}  outcome: pass|fail|cancelled|skip|todo
	A file without any test case yields a failing result named "(no test cases)".

	The file name deliberately does not match the default `node --test` patterns,
	so the repository test suite never picks it up.
*/
import { run } from 'node:test';
import path from 'node:path';
import { createFileAccounting } from '../../../scripts/file-case-accounting.mjs';

const files = process.argv.slice(2).map((f) => path.resolve(f));
const relative = (file) => path.relative(process.cwd(), file ?? '').split(path.sep).join('/');
const results = [];
const messageOf = (error) => {
	const inner = error?.cause ?? error;
	return String(inner?.message ?? inner ?? '').split('\n').slice(0, 3).join(' ').slice(0, 400);
};

const accounting = createFileAccounting();

const stream = run({ files, concurrency: true });
stream.on('test:enqueue', accounting.discover);
stream.on('test:pass', (event) => {
	// Suites and the per-file wrapper are not test cases (an empty file is reported as one passing wrapper, F-2C-1).
	if (!accounting.observe(event)) return;
	const { name, file, skip, todo } = event;
	results.push({ file: relative(file), name, outcome: todo !== undefined ? 'todo' : skip !== undefined ? 'skip' : 'pass', message: '' });
});
stream.on('test:fail', (event) => {
	accounting.observe(event);
	const { name, file, details } = event;
	if (details?.type === 'suite') return;
	const cancelled = details?.error?.failureType === 'cancelledByParent';
	results.push({ file: relative(file), name, outcome: cancelled ? 'cancelled' : 'fail', message: messageOf(details?.error) });
});
// Drain the stream; the reporter output is not needed.
stream.on('data', () => {});
stream.on('end', () => {
	for (const file of accounting.emptyFiles()) results.push({ file: relative(file), name: '(no test cases)', outcome: 'fail', message: 'test file contains no test cases' });
	results.sort((a, b) => (a.file + '\0' + a.name).localeCompare(b.file + '\0' + b.name));
	process.stdout.write(JSON.stringify({ results }) + '\n');
});
