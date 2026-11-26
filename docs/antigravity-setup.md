# Using `agy-harness` with Google Antigravity (`agy` CLI, IDE & App 2.0)

`agy-harness` (`v0.4.0`) pairs the 25 unmodified upstream `addyosmani/agent-skills` workflows with an **Adaptive Generate-and-Falsify Engineering Harness** for Google Antigravity (`agy` CLI `1.5.13+`, Antigravity App `v2.34+` / IDE, and Orchestrator Plan–Execute surfaces).

Instead of rigid file-count ceremony or duplicate test loops, `agy-harness` enforces:
1. **3-Mode Adaptive Complexity & Bug-Rigor Routing (`Trivial` / `Bug Fix` / `Contract`)**:
   - **Trivial**: Literal/constant/style/copy/locale/1:1 field pass-throughs (no logic or security risk) edit directly in warm cache and skip `Stop` full-gate loops (`isTrivialExemptPath` / `isTierXsExemptPath`).
   - **Bug Fix**: Every non-literal bug follows read-only root-cause diagnosis -> pre-confirmation `arch-redteam` -> user confirmation of **[Root Cause + Proposal]** -> minimal fix + regression test + deduplicated gate pass (supports `<!-- HARNESS_STATUS: PAUSED -->` for mid-feature side-quests).
   - **Contract**: Business encapsulation/abstraction changes, schema/API design, design forks, or any high-risk security/auth/input/crypto/billing/concurrency path (even 1 file) draft lean `.artifacts/{SPEC,CONSTRAINTS,PLAN}.md`, run **pre-confirmation `arch-redteam`**, and lock via 1-click `Proceed`.
2. **Git-Fingerprint-Deduplicated Software 1.0 Gate (`scripts/gate-check.sh`)**: Auto-detects `pnpm`/`bun`/`yarn`/`npm`, `cargo`, `go`, `ruff`/`pytest`, and `dart`/`flutter`; caches a SHA-256 working-tree fingerprint on full pass (`[Gate Dedup]`, `--force` bypasses, `--fast` runs incremental checks); and isolates `Stop` checks to the current conversation's own edits.
3. **Slim `always_on` Rules (`3,459 B` / `<= 3.5 KB`) & Global `hooks.json` (`--plugin-mode`)**: Registers `.agents/rules/agy-harness.md` (`3,459 B`) backed by global [`rules/AGENTS.md`](../rules/AGENTS.md) (`980 B`) and plugin-root [`hooks.json`](../hooks.json) backed by shared [`scripts/lib/harness-core.js`](../scripts/lib/harness-core.js) + [`harness-core.py`](../scripts/lib/harness-core.py).
4. **3 Micro-Capsuled Subagents (`skills: []`) & Dual-Layer Anti-Hang Watchdog**: Subagents embed crisp checklists (`skills: []`, eliminating ~12.5k–21.5k preload tokens), equip `slice-builder` with `manage_task` + `NotificationTimeoutSeconds: 45` `overwrite` for WS/DB handle cleanup, and pair subagent delegations with a 0-cost-on-reply `75s` coordinator `schedule` watchdog.

---

## 1. Installation & Avoiding Duplicate Catalog Tax

```bash
agy plugin install https://github.com/JsonLee12138/agy-harness.git
# Disable standalone agent-skills so 25 skill descriptions aren't duplicated:
agy plugin disable agent-skills
agy plugin list
```

> **Global Zero-Intrusion Fallback (`hooks.json`)**: Installing the plugin enables plugin-root [`hooks.json`](../hooks.json) (`--plugin-mode`) globally. Scripts immediately no-op (`allow` / `{}`) in repositories lacking `.agents/rules/agy-harness.md` and `.artifacts/{SPEC,PLAN}.md`, and `harness-lifecycle-hook.sh --plugin-mode` yields if a workspace provides its own `.agents/hooks.json` with `harness-lifecycle-guard`.

---

## 2. Clean-Room Initialization (`/agy-harness:harness-init`)

In any target repository, run `/agy-harness:harness-init` or execute:

```bash
# Default clean-room mode (uses global plugin hooks; removes legacy v0.1-v0.3 clutter):
bash ~/.gemini/config/plugins/agy-harness/scripts/init-harness.sh /path/to/your-project

# Standalone offline mode (places hooks, core libs, and local agents cleanly under .agents/):
bash /path/to/agy-harness/scripts/init-harness.sh /path/to/your-project --standalone
```

What default clean-room mode writes & cleans:
- **Writes/Updates**: `.agents/rules/agy-harness.md` (`3,459 B`, `<= 3.5 KB`), `scripts/gate-check.sh` (preserved if customized), and lean `.artifacts/{SPEC,CONSTRAINTS,PLAN}.md` (gitignored).
- **Automatically Cleans Legacy v0.1–v0.3 Clutter**: Deletes old `scripts/harness-*.sh`, `scripts/hooks/*.hooks.json`, unfilled `.artifacts/context-brief.md`, harness hook keys in `.agents/hooks.json` (preserving user hooks), and retired `.agents/agents/*`.

### 3-Group Hook Architecture & Native `Permissions` Layering

| Hook Group | Trigger & Matcher | Enforced Software 1.0 Boundary |
|---|---|---|
| `harness-contract-approval-gate` ([`harness-approval-gate.sh`](../scripts/harness-approval-gate.sh)) | `PreToolUse`: `invoke_subagent\|define_subagent\|swarm\|run_workflow\|exit_plan_mode` | Allowlists read-only subagents (`arch-redteam`, `staff-gatekeeper`, `research`) pre- and post-`Proceed`; gates `slice-builder`, `define_subagent(EnableWriteTools=true)`, `swarm(add)`, and `run_workflow` behind active approved contracts (`PAUSED` blocks gated writes cleanly); on `exit_plan_mode`, emits `force_ask` only when unapproved contracts or contractless `slice-builder`/`swarm` plans lack a Phase 1 confirmation stop. |
| `harness-parent-source-edit-guard` ([`harness-source-edit-guard.sh`](../scripts/harness-source-edit-guard.sh)) | `PreToolUse`: `write_file\|edit_file\|create_file\|delete_file\|sed_file\|write_to_file\|replace_file_content\|multi_replace_file_content\|run_command` | Uses 2-rule `isParent` detection. Allows parent edits when `INACTIVE` (including `PAUSED`/`ARCHIVED`/`DONE`) AND when `ACTIVE_APPROVED` (warm-cache parent editing!), unless `.artifacts/PLAN.md` declares `<!-- HARNESS_EXECUTION: SUBAGENT_ONLY -->`. Blocks parent edits & shell write bypasses while `ACTIVE_UNAPPROVED`. |
| `harness-lifecycle-guard` ([`harness-lifecycle-hook.sh`](../scripts/harness-lifecycle-hook.sh)) | `PreInvocation`, `PostToolUse`, `Stop` | `PreInvocation`: deduplicated 3-mode routing reminder (`INACTIVE_ROUTING_3MODE_V04`). `PostToolUse`: tracks per-conversation & workspace edits (exempting `isTrivialExemptPath`: docs, lockfiles, manifests, static assets, `.css/.scss/.sass/.less`, `.env.example/.sample/.template`, locale JSONs) and records Git working-tree fingerprints on full `gate-check.sh` passes. `Stop`: ignores conversations that did not mutate non-exempt files (fixing cross-conversation hijack), immediately `allow`s when the Git fingerprint matches a verified pass, and guards against forced continuation loops (`continuationActive` / `executionNum > 0`). |

> **Pair AGY Native `Permissions` with `agy-harness` Hooks**: Use Antigravity static `Permissions` (`Deny > Ask > Allow`) for invariant security policies (denying `.env*` reads/writes or gating `git push --force`), and let `agy-harness` Hooks enforce contract state, subagent boundaries, and anti-hang timeouts.

---

## 3. Adaptive 3-Mode Routing, Anti-Hang Watchdog & Subagent Matrix

| Mode | Trigger Scope | Pipeline & Checkpoints |
|---|---|---|
| **Trivial** | Literal/constant/style/copy/locale JSON/static config or 1:1 field pass-through (no logic branches, abstraction changes, or security risk) | Direct warm-cache edit + fast check (`isTrivialExemptPath` skips `Stop` full-gate loops; allowed mid-contract when `PAUSED`) |
| **Bug Fix** | Any non-literal bug (errors, state/async/race/crash defects, including mid-feature side-quests) | Read-only root-cause diagnosis (pause active contract via `HARNESS_STATUS: PAUSED` if needed) -> **pre-confirmation `arch-redteam`** -> user confirms **[Root Cause + Proposal]** -> minimal fix + regression test + deduped `gate-check.sh` |
| **Contract** | Business encapsulation/shared hooks/SDK/middleware, multi-state workflows, DB/API schema, design forks, or **any high-risk security/auth/input/crypto/billing/concurrency path (even 1 file)** | Draft `.artifacts/{SPEC,PLAN}.md` -> **pre-confirmation `arch-redteam`** -> 1-click `Proceed` -> warm-cache parent or `SUBAGENT_ONLY` `slice-builder` (`75s` watchdog) -> deduped `gate-check.sh` -> 4-in-1 `staff-gatekeeper` -> `kill` |

### Subagent, Frontmatter `hooks:` & Dual-Layer Watchdog Matrix

| Subagent (`agents/*.md`) | Model, MCP & Skills | Tools & Guardrails | Role |
|---|---|---|---|
| [`arch-redteam`](../agents/arch-redteam.md) | `inherit`, `mcpServers: []`, `skills: []` | Read-only (`read_file` + legacy aliases; `off`) | Pre-confirmation adversarial audit of Bug Fix proposals & `.artifacts/{SPEC,PLAN}.md`; killed immediately after logging |
| [`slice-builder`](../agents/slice-builder.md) | `inherit`, `mcpServers: []`, `skills: []` | Read + Write + `run_command` + `manage_task` (`sandbox`) + [`slice-builder.hooks.json`](../scripts/hooks/slice-builder.hooks.json) | Cohesive TDD builder; `harness-subagent-guard.sh` clamps `WaitMsBeforeAsync > 10000` -> `10000`, auto-injects `NotificationTimeoutSeconds: 45` via `overwrite`, locks contracts, and delegates containers/installs/daemons via `[HOST_CMD_REQUEST]`. Paired with coordinator `75s` `schedule(TimerCondition)` watchdog. |
| [`staff-gatekeeper`](../agents/staff-gatekeeper.md) | `inherit`, `mcpServers: []`, `skills: []` | Read-only + `run_command` (`sandbox`) + [`staff-gatekeeper.hooks.json`](../scripts/hooks/staff-gatekeeper.hooks.json) | 4-in-1 post-gate reviewer (contract, Occam pruning, anti-fake-test mutation check, security/perf); `run_command` limited to short read-only checks with `NotificationTimeoutSeconds: 45` `overwrite`. |

---

## 4. Validation & Golden Eval

```bash
node scripts/validate-versions.js && \
node scripts/validate-skills.js && \
node scripts/validate-reference-links.js && \
node scripts/validate-artifact-paths.js && \
node scripts/validate-commands.js && \
CI=true node --test scripts/*test.js && \
node scripts/run-evals.js && \
agy plugin validate . && \
bash scripts/gate-check.sh --force && \
bash scripts/gate-check.sh
```
