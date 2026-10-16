/*
	CRSF test executor (child process).

	Runs the given test files with the Node test runner in the current working
	directory and prints ONE JSON line with every test outcome. Started by
	security/crsf/lib/exec.mjs with a controlled environment; never imported.

	Usage: node node-test-exec.mjs <file> [<file> ...]
	Output: {"results":[{file,name,outcome,message}]}  outcome: pass|fail|cancelled|skip|todo

	The file name deliberately does not match the default `node --test` patterns,
	so the repository test suite never picks it up.
*/
import { run } from 'node:test';
import path from 'node:path';

const files = process.argv.slice(2).map((f) => path.resolve(f));
const relative = (file) => path.relative(process.cwd(), file ?? '').split(path.sep).join('/');
const results = [];
const messageOf = (error) => {
	const inner = error?.cause ?? error;
	return String(inner?.message ?? inner ?? '').split('\n').slice(0, 3).join(' ').slice(0, 400);
};

const stream = run({ files, concurrency: true });
stream.on('test:pass', ({ name, file, skip, todo, details }) => {
	if (details?.type === 'suite') return;
	results.push({ file: relative(file), name, outcome: todo !== undefined ? 'todo' : skip !== undefined ? 'skip' : 'pass', message: '' });
});
stream.on('test:fail', ({ name, file, details }) => {
	if (details?.type === 'suite') return;
	const cancelled = details?.error?.failureType === 'cancelledByParent';
	results.push({ file: relative(file), name, outcome: cancelled ? 'cancelled' : 'fail', message: messageOf(details?.error) });
});
// Drain the stream; the reporter output is not needed.
stream.on('data', () => {});
stream.on('end', () => {
	results.sort((a, b) => (a.file + '\0' + a.name).localeCompare(b.file + '\0' + b.name));
	process.stdout.write(JSON.stringify({ results }) + '\n');
});
