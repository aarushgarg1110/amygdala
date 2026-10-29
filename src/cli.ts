#!/usr/bin/env node
import { run } from './run.ts';

const outcome = run(process.argv.slice(2));
process.stdout.write(outcome.stdout);
process.stderr.write(outcome.stderr);
process.exitCode = outcome.exitCode;
