# Harness Subagents & Orchestration

`agy-harness` (`v0.4.0`) focuses orchestration on **3 Micro-Capsuled Physically Isolated Subagents** (`model: inherit`, `mcpServers: []`, `skills: []` with crisp embedded checklists to save ~12.5k–21.5k preload tokens per spawn), coordinated by the slim `trigger: always_on` workspace rule ([`.agents/rules/agy-harness.md`](../.agents/rules/agy-harness.md), `3,459 B` / `<= 3.5 KB`).

| Subagent | Model, MCP & Skills | Tools & Frontmatter `hooks:` Isolation | Role |
|---|---|---|---|
| [arch-redteam](../agents/arch-redteam.md) | `inherit`, `mcpServers: []`, `skills: []` | **Read-only** (`read_file`, `view_file`, `list_dir`, `grep_search`, `find_by_name`; `commandExecutionPolicy: off`) | Pre-confirmation blank-context adversarial audit of Bug Fix proposals and `.artifacts/{SPEC,PLAN}.md` (catches band-aid patches, Hyrum's Law breaks, OWASP risks, and overengineering); killed before user confirmation |
| [slice-builder](../agents/slice-builder.md) | `inherit`, `mcpServers: []`, `skills: []` | Read + Write + `run_command` + `manage_task` (`sandbox`) + [`slice-builder.hooks.json`](../scripts/hooks/slice-builder.hooks.json) | Vertical-slice TDD builder for parallel/heavy slices; locked out of `.artifacts/{SPEC,CONSTRAINTS,PLAN}.md` (and `.agents/*` / `scripts/harness-*.sh` in target repos), equips `manage_task` + `NotificationTimeoutSeconds: 45` `overwrite` for WS/DB handle self-recovery |
| [staff-gatekeeper](../agents/staff-gatekeeper.md) | `inherit`, `mcpServers: []`, `skills: []` | **Read-only** (`read_file`, `view_file`, `list_dir`, `grep_search`, `find_by_name`, `run_command`; `sandbox`) + [`staff-gatekeeper.hooks.json`](../scripts/hooks/staff-gatekeeper.hooks.json) | **4-in-1** unified post-gate reviewer: contract compliance, Occam complexity pruning, anti-fake-test mutation check, and security/performance audit; `run_command` restricted to short read-only checks |

> **Archived personas:** Legacy single-axis and retired personas ([`repo-scout`](legacy-personas/repo-scout.md), [`risk-specialist`](legacy-personas/risk-specialist.md), etc.) remain archived under [`docs/legacy-personas/`](legacy-personas/) so `/agents` only exposes the 3 core Harness subagents.

## How Rules, Hooks, Skills, and Subagents Compose

| Layer | Artifact | Job |
|---|---|---|
| **Coordinator Rule** | `.agents/rules/agy-harness.md` (`3,459 B` / `<= 3.5 KB`) + [`rules/AGENTS.md`](../rules/AGENTS.md) (`980 B`) | **The *when* & adaptive router** — stays well inside `defaultRulesBudget`; routes `Trivial` / `Bug Fix` / `Contract`, runs pre-confirmation `arch-redteam`, allows warm-cache parent edits post-`Proceed` unless `HARNESS_EXECUTION: SUBAGENT_ONLY`, supports `HARNESS_STATUS: PAUSED`, and pairs `slice-builder` with a `75s` `schedule(TimerCondition)` anti-hang watchdog |
| **Software 1.0 Locks** | Plugin-root [`hooks.json`](../hooks.json) (`--plugin-mode`) + [`scripts/lib/harness-core.{js,py}`](../scripts/lib/harness-core.js) + Agent `hooks:` | **Physical 3-group boundaries** — `harness-contract-approval-gate`, `harness-parent-source-edit-guard` (permits `INACTIVE`/`PAUSED` and warm-cache `ACTIVE_APPROVED`, enforces `SUBAGENT_ONLY` & `ACTIVE_UNAPPROVED`), `harness-lifecycle-guard` (per-conversation `Stop` isolation, Git fingerprint dedup, `isTrivialExemptPath`), and [`harness-subagent-guard.sh`](../scripts/harness-subagent-guard.sh) (`NotificationTimeoutSeconds: 45` `overwrite`) |
| **Software 1.0 Gate** | `scripts/gate-check.sh` | **Zero-token polyglot deduped filter** — auto-detects `pnpm`/`bun`/`yarn`/`npm`, `cargo`, `go`, `ruff`/`pytest`, `dart`/`flutter`; caches Git working-tree SHA-256 fingerprint (`[Gate Dedup]`) so unchanged code is never re-tested twice |
| **Subagent** | `agents/<name>.md` | **The *who* & Fresh RAM boundary** — isolated context window, `inherit` model speed/reliability, `mcpServers: []`, `skills: []` micro-capsules (on-demand `read_file` when deep reference needed) |
| **Skill** | `skills/<name>/SKILL.md` (`agy-harness:*`) | **The *how*** — unmodified upstream workflow steps loaded proportionally to complexity |

## Design Guardrails

1. **Read-write hardware & hook separation**: `arch-redteam` and `staff-gatekeeper` physically omit all write tools. `slice-builder` frontmatter `hooks:` unconditionally locks `.artifacts/{SPEC,CONSTRAINTS,PLAN}.md`, clamps `WaitMsBeforeAsync > 10000` to `10000`, injects `NotificationTimeoutSeconds: 45`, and blocks daemons/containers/installs with `[HOST_CMD_REQUEST]`.
2. **Pre-confirmation falsification & warm-cache execution**: Both `Bug Fix` proposals and `Contract` specs pass read-only `arch-redteam` *before* user confirmation; after `Proceed`, single-thread work can execute directly in the warm-cached parent session unless `PLAN.md` declares `<!-- HARNESS_EXECUTION: SUBAGENT_ONLY -->`.
3. **Dual-layer anti-hang protection**: Subagent `run_command` gets `NotificationTimeoutSeconds: 45` + `manage_task` handle cleanup; coordinator pairs `slice-builder` with `schedule(DurationSeconds: 75, TimerCondition: "<conversationId>")`.
4. **Circuit breaker (`Max Retries = 2`) & Static `Permissions` layering**: Only `[BLOCKER]` and `[CRITICAL]` findings trigger `NO-GO` rework (`[NIT]` items do not loop). Pair AGY native `Permissions` with `agy-harness` Hooks.
5. **Persona lint contract (`scripts/validate-skills.js`)**: Every `agents/<name>.md` must carry valid YAML frontmatter with `name` matching the file stem and a `description`, and end with `## Composition` as its final `##` heading.
