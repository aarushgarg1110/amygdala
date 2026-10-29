# Security policy

amygdala is pre-alpha: no version is supported yet, and nothing should rely on it to protect real
data before v0.1. Security fixes land on `main` until then.

## Reporting a vulnerability

Report it privately through GitHub's
[**Report a vulnerability**](https://github.com/aarushgarg1110/amygdala/security/advisories/new)
form. Please don't open a public issue.

**Use synthetic values only.** Never include real confidential data in a report, a reproduction,
a log or a screenshot. A made-up value such as `CUST-0001`, or a public molecule such as aspirin,
shows the problem just as well.

amygdala has one maintainer. You'll get an acknowledgement within 7 days; the time to a fix
depends on severity. Reporters are credited in the advisory unless they'd rather not be.

## In scope

amygdala's job is to keep protected values out of everything Claude Code sends to Anthropic, so
these are vulnerabilities:

- A protected value reaching any non-local host from a session started through amygdala, in any
  request shape or encoding.
- A request that amygdala couldn't parse or scan being forwarded anyway (failing open).
- A real value restored into a tool or host that isn't on the trusted list.
- The key, the certificate authority or the token map reaching disk, logs or error messages.
- The proxy accepting connections from other machines, or forwarding to hosts it shouldn't.
- A problem in the published package or its release process.

## Out of scope, by design

These are documented limits, not vulnerabilities:

- Images and PDFs, which aren't scanned yet (planned for v2).
- Confidential values described in words rather than written out.
- Sessions not started through amygdala, and other applications.
- Anything sent before amygdala was installed.
- Exposing the proxy beyond `127.0.0.1`, or disabling its checks.
- Other programs running as the same user reading the keychain.
