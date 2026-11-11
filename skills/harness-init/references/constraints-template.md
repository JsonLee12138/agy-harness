# Project Quality & Anti-Bloat Constraints (CONSTRAINTS)

> Enforced by `scripts/gate-check.sh`, `arch-redteam`, `staff-gatekeeper`, and `risk-specialist`.

## 1. Hard Quality Bars (Software 1.0)
- Diff per vertical slice should stay focused (`<= 400` changed lines recommended).
- Zero new linter/typecheck suppressions (`@ts-ignore`, `eslint-disable`, `# type: ignore`) without documented justification.
- Zero skipped or tautological mock-only tests; deleting core logic must make a test fail.
- Zero hardcoded credentials, tokens, or leftover `debugger;` statements.

## 2. Anti-Overengineering Contract (Software 2.0 Guardrail)
- Prefer the boring, obvious solution that satisfies `.artifacts/SPEC.md` at current scale.
- Reviewers (`arch-redteam`, `staff-gatekeeper`, `risk-specialist`) MUST NOT demand extra middleware, distributed locks, or speculative abstractions beyond `SPEC.md` unless proving a deterministic crash, security exploit, or data-loss path.
