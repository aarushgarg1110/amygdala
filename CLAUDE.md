# CLAUDE.md: working on amygdala

amygdala is a local TLS-intercepting proxy for Claude Code. It replaces confidential strings with
placeholders before requests reach Anthropic and restores them in the response. This file is for
coding agents working on the code.

## Rules

- **Never commit real confidential values.** No real customer IDs, compound IDs, chemical
  structures, company or project names, keys, tokens or certificates. Tests use synthetic values
  (`CUST-0001`) and public molecules (acetaminophen, aspirin).
- **Develop against the sandbox:** `AMYGDALA_DIR=~/.amygdala-dev`, never the real `~/.amygdala`.
- **Fail closed.** A code path that can't scan a request must block it, never forward it.
- **Dependencies are pinned exactly and install scripts are blocked** (`.npmrc`). A new dependency
  needs a reason in its PR, and versions younger than 7 days wait.

## Commands

```bash
npm ci                 # install exactly what the lockfile says
npm run check          # typecheck, lint, format check, tests with coverage (the local gate)
npm test               # tests only
npm run build          # compile src/ to dist/
npm run format:fix     # apply Prettier
```

## Workflow

One issue = one PR, about 400 changed lines at most (the lockfile doesn't count).

1. The issue holds a table of inputs and expected outputs, agreed before any code (spec gate).
2. Commit skipped test stubs named after the behaviors first, then the change.
3. `npm run check` passes: 95% statements, branches, functions and lines.
4. The PR title is a conventional commit; the body is Problem / Why / Fix with the evidence, because
   squash-merging makes it the commit on `main`. It is approved before merging (preview gate).

## Code

- Strict TypeScript. Parse untrusted input into `unknown` and narrow it with type guards.
- I/O stays at the edges: logic returns values and the entry point writes them.
- UPPER_CASE named limits; comments say why; no commented-out code; rules are never disabled inline.
- A promise is always awaited or explicitly handled (`no-floating-promises` is an error).
