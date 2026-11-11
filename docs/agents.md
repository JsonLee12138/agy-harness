# Harness Subagents & Orchestration

`agy-harness` replaces fragmented single-axis review personas with **5 physically isolated Subagents** orchestrated by the workspace Coordinator Rule (`.agents/rules/agy-harness.md`, scaffolded via `/agy-harness:harness-init`).

| Subagent | Model Tier | Tool Isolation | Role |
|----------|------------|----------------|------|
| [repo-scout](../agents/repo-scout.md) | `flash` | Read-only (`off`) | Fast codebase & official-doc fact anchoring (`<= 2K` token Context Brief) |
| [arch-redteam](../agents/arch-redteam.md) | `pro` | Read-only (`off`) | Fresh-context pre-code adversarial audit of `.artifacts/SPEC.md` & `PLAN.md` with anti-overengineering guardrails |
| [slice-builder](../agents/slice-builder.md) | `inherit` | Read + Write (`sandbox`) | Vertical-slice TDD builder; runs `scripts/gate-check.sh` before returning; supports `Workspace: "share"` worktree sharding |
| [staff-gatekeeper](../agents/staff-gatekeeper.md) | `pro` | Read-only (`sandbox`) | 3-in-1 post-gate reviewer: five-axis quality, complexity pruning, and anti-fake-test mutation check |
| [risk-specialist](../agents/risk-specialist.md) | `pro` | Read-only (`sandbox`) | Conditional security (OWASP) & performance (N+1, CWV, hot-loop) auditor triggered by high-risk diff paths |

> **Archived upstream personas:** The 4 original single-axis personas (`code-reviewer`, `security-auditor`, `test-engineer`, `web-performance-auditor`) are preserved under [`docs/legacy-personas/`](legacy-personas/) so `/agents` only exposes the 5 Harness subagents.

## How Rules, Skills, and Subagents Compose

| Layer | Artifact | Job |
|-------|----------|-----|
| **Coordinator Rule** | `.agents/rules/agy-harness.md` (via `/agy-harness:harness-init`) | **The *when* & budget router** — classifies Tier S/M/L/XL, locks `.artifacts/` contracts, enforces the 2-retry circuit breaker |
| **Software 1.0 Gate** | `scripts/gate-check.sh` | **Zero-token deterministic filter** — blocks broken builds, failing tests, secrets, and leftover `debugger;` before waking `pro` reviewers |
| **Subagent** | `agents/<name>.md` | **The *who* & Fresh RAM boundary** — isolated context window, model tier, and hardware tool allowlist |
| **Skill** | `skills/<name>/SKILL.md` (`agy-harness:*`) | **The *how*** — unmodified upstream workflow steps, anti-rationalization tables, and verification gates |

## Design Guardrails

1. **Read-write hardware separation**: `repo-scout`, `arch-redteam`, `staff-gatekeeper`, and `risk-specialist` physically omit `write_to_file`, `replace_file_content`, and `multi_replace_file_content`. Reviewers report `file:line`; only `slice-builder` edits code.
2. **Merge by shared input, not job title**: `staff-gatekeeper` combines `code-review-and-quality`, `code-simplification`, and `test-driven-development` in one pass over `SPEC.md + CONSTRAINTS.md + git diff`, saving ~60% duplicate prefix tokens and preventing conflicting nitpicks.
3. **Subagents never spawn subagents**: All delegation (including Tier XL parallel `Workspace: "share"` slices or Native `Swarm` handoffs) is owned by the main session.
4. **Circuit breaker (`Max Retries = 2`)**: Only `[BLOCKER]` and `[CRITICAL]` findings trigger `NO-GO` rework; `[NIT]` items are logged for human judgement without automatic recompilation loops.
