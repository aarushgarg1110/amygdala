#!/usr/bin/env node
import { main } from './run.ts';

const outcome = await main(process.argv.slice(2));
process.stdout.write(outcome.stdout);
process.stderr.write(outcome.stderr);
process.exitCode = outcome.exitCode;
