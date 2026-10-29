# Contributing

Thanks for your interest. amygdala is pre-alpha and has one maintainer, so please read this first.

**Outside pull requests can't be accepted yet.** The project has no license until one is chosen
before v0.1, and contributed code needs one. Issues, bug reports and ideas are welcome now.

## Never share real confidential data

Not in issues, pull requests, tests, fixtures, logs or screenshots. Use synthetic values such as
`CUST-0001`, or public molecules such as acetaminophen and aspirin. amygdala's audit log holds
counts and actions only, so its lines are safe to paste.

## How a change happens

1. **Open an issue first.** Describe the problem and, for a change in behavior, a table of inputs
   and the output you expect for each. The table is agreed before any code is written.
2. **One issue, one pull request**, about 400 changed lines at most (the lockfile doesn't count).
3. **Test stubs first:** commit skipped tests named after the behaviors in the table, then the
   change that makes them pass.
4. **`npm run check` passes:** types, lint, formatting, and tests with 95% statement, branch,
   function and line coverage.
5. **The pull request** has a [conventional commit](https://www.conventionalcommits.org) title
   (`fix(restore): …`) and a body with Problem, Why, Fix and the evidence. It is squash-merged, so
   the body becomes the commit on `main`.

`CLAUDE.md` holds the same rules for coding agents.

## AI-assisted contributions

Welcome, as long as you have run and understood every line, and you say in the pull request that
you used one. amygdala itself is built with Claude Code.

## Response times

Best effort, usually within a week. Security reports go through [SECURITY.md](SECURITY.md) instead.

## Code of conduct

Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).
