# Harness Subagents & Orchestration

`agy-harness` focuses orchestration on **3 Lean Physically Isolated Subagents** (all running on `model: inherit` with `mcpServers: []` to eliminate cold-start MCP process/schema taxes and tier mismatch churn), coordinated by the `trigger: always_on` workspace rule (`.agents/rules/agy-harness.md`, scaffolded via `/agy-harness:harness-init`).

| Subagent | Model Tier | Tool Isolation | Role |
|----------|------------|----------------|------|
| [arch-redteam](../agents/arch-redteam.md) | `inherit` (`mcpServers: []`) | Read-only (`off`) | Fresh-context pre-code adversarial audit of `.artifacts/SPEC.md` & `PLAN.md` with anti-overengineering guardrails; killed immediately after logging `[RISK-NOTE]`s |
| [slice-builder](../agents/slice-builder.md) | `inherit` (`mcpServers: []`) | Read + Write (`sandbox`) | Vertical-slice TDD builder; runs `scripts/gate-check.sh` before returning; supports `Workspace: "share"` sharding and per-slice `send_message` resume |
| [staff-gatekeeper](../agents/staff-gatekeeper.md) | `inherit` (`mcpServers: []`) | Read-only (`sandbox`) | **4-in-1** unified post-gate reviewer: five-axis quality, complexity pruning, anti-fake-test mutation check, and conditional security/performance audit |

> **Archived personas:** The 4 original single-axis personas (`code-reviewer`, `security-auditor`, `test-engineer`, `web-performance-auditor`) plus consolidated roles ([`repo-scout`](legacy-personas/repo-scout.md) and [`risk-specialist`](legacy-personas/risk-specialist.md)) are preserved under [`docs/legacy-personas/`](legacy-personas/) so `/agents` only exposes the 3 core Harness subagents.

## How Rules, Skills, and Subagents Compose

| Layer | Artifact | Job |
|-------|----------|-----|
| **Coordinator Rule** | `.agents/rules/agy-harness.md` (`trigger: always_on`, via `/agy-harness:harness-init`) | **The *when* & budget router** — performs native parallel discovery (Zero CRG), classifies Tier S/M/L/XL, locks `.artifacts/` contracts, manages per-slice `send_message` closed loops + `manage_subagents(kill)`, and enforces the 2-retry circuit breaker |
| **Software 1.0 Locks** | `.agents/hooks.json` (`harness-approval-gate.sh` & `harness-source-edit-guard.sh`) | **Physical boundaries** — blocks premature `slice-builder`/`swarm` runs before `Proceed`, and prevents top-level parent edits outside unactivated Tier S (`<= 3` files, `<= 150` lines) |
| **Software 1.0 Gate** | `scripts/gate-check.sh` | **Zero-token deterministic filter** — blocks broken builds, failing tests, secrets, and leftover `debugger;` before waking `staff-gatekeeper` |
| **Subagent** | `agents/<name>.md` | **The *who* & Fresh RAM boundary** — isolated context window, `inherit` model speed/reliability, `mcpServers: []`, and hardware tool allowlist |
| **Skill** | `skills/<name>/SKILL.md` (`agy-harness:*`) | **The *how*** — unmodified upstream workflow steps, anti-rationalization tables, and verification gates |

## Design Guardrails

1. **Read-write hardware separation**: `arch-redteam` and `staff-gatekeeper` physically omit `write_to_file`, `replace_file_content`, and `multi_replace_file_content`. Reviewers report `file:line`; only `slice-builder` edits code.
2. **4-in-1 consolidation & No-CRG native discovery**: Turn 1 orientation uses fast parallel `read_file` / `grep_search` / `find_by_name` directly (without CRG or `repo-scout` cold starts), and `staff-gatekeeper` merges quality, simplification, anti-fake-test checks, and security/performance audits in a single pass.
3. **Per-slice closed-loop lifecycle**: Keep `slice-builder` and `staff-gatekeeper` alive via `send_message` across gate fixes, `NO-GO` rework, and `[HOST_CMD_REQUEST]` cycles within Slice `N`; once Slice `N` passes `GO`, `manage_subagents(Action="kill")` destroys Slice `N` subagents before spawning fresh clean-context subagents for Slice `N+1`.
4. **Circuit breaker (`Max Retries = 2`)**: Only `[BLOCKER]` and `[CRITICAL]` findings trigger `NO-GO` rework; `[NIT]` items are logged for human judgement without automatic recompilation loops.
