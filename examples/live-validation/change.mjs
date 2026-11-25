import { writeFileSync } from 'node:fs';

// The source change each live run asks the model to diagram: requests now go
// through a queue before reaching the worker. handle stays on lines 3-5.
const source = new URL('./src/', import.meta.url);
writeFileSync(new URL('api.js', source), `import { enqueue } from "./queue.js";

export function handle(request) {
  return enqueue(request.body);
}
`);
writeFileSync(new URL('queue.js', source), `import { run } from "./worker.js";

const pending = [];

export function enqueue(job) {
  pending.push(job);
  return run(pending.shift());
}
`);
