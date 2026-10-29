# amygdala

> [!WARNING]
> **Pre-alpha.** Nothing here works yet. Don't rely on it to protect real data before v0.1.

Keep your confidential strings out of what Claude Code sends to Anthropic.

amygdala is a local proxy for [Claude Code](https://code.claude.com). Before a request leaves your
machine, it replaces each protected value (a customer ID, an account number, a project codename, a
chemical structure) with a stable placeholder such as `CUST_7k2q…`. As the reply streams back, it
puts the real values back, so your terminal, your files and the commands Claude runs see the
originals, while Anthropic only ever sees placeholders.

Detection is deterministic: patterns you define, and keyed hashes of your own denylist, never a
model's guess. That means a security team can verify it by inspecting the bytes that leave the
machine instead of taking it on trust.

The name comes from the brain's threat detector.

## Status

Built in the open. Progress is tracked in the
[v0.1 milestone](https://github.com/aarushgarg1110/amygdala/milestone/1).

## License

Not chosen yet; it will be decided before v0.1. Until then, all rights are reserved.
