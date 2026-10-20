#!/usr/bin/env node
import { run } from '../src/cli.js';

const controller = new AbortController();
let interrupted = 0;
for (const [name, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.once(name, () => { interrupted = code; controller.abort(); });
}
process.stdout.on('error', error => {
  if (error.code === 'EPIPE') process.exit(0);
  throw error;
});
process.exitCode = await run(process.argv.slice(2), { signal: controller.signal });
if (interrupted) process.exitCode = interrupted;
