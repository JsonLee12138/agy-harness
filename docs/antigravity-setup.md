# Using `agy-harness` with Google Antigravity (`agy` CLI, IDE & App 2.0)

`agy-harness` upgrades the 25 upstream `addyosmani/agent-skills` workflows (with **zero lines modified** in upstream `SKILL.md` files) into a budget-governed **Generate-and-Falsify Engineering Harness** for Google Antigravity (`agy` CLI `1.5.13+`, Antigravity App `v2.34+` / IDE, and Orchestrator Plan–Execute surfaces).

Instead of manually invoking skills one by one—or letting a single polluted context review its own code—`agy-harness` enforces:
1. **Disk SSoT Contracts (`.artifacts/`)**: `context-brief.md`, `SPEC.md`, `CONSTRAINTS.md`, and `PLAN.md` with automatic completion/archive detection.
2. **Software 1.0 Zero-Token Hard Gate (`scripts/gate-check.sh`)**: Diff-size check, typecheck/lint, deterministic tests, and secret/`debugger;` scan before spending review tokens.
3. **Slim `always_on` Rules (`<= 3.5 KB`) & 3-Group Lifecycle Hooks**: Registers [`agy-harness.md`](../.agents/rules/agy-harness.md) (`3,484 B` within AGY's `20,000`-token `defaultRulesBudget`) and [`.agents/hooks.json`](../.agents/hooks.json), backed globally by plugin-root [`hooks.json`](../hooks.json) (`--plugin-mode` zero-intrusion fallback).
4. **3 Lean Physically Isolated Subagents (`agents/*.md`)**: Canonical AGY tools (`read_file`, `write_file`, `edit_file`, `create_file`) with legacy aliases, strict read-only separation, Agent Frontmatter `hooks:` ([`slice-builder.hooks.json`](../scripts/hooks/slice-builder.hooks.json), [`staff-gatekeeper.hooks.json`](../scripts/hooks/staff-gatekeeper.hooks.json)), `model: inherit` + `mcpServers: []`, and per-slice `send_message` reuse + `manage_subagents(kill)` teardown.

---

## 1. Installation & Avoiding Duplicate Catalog Tax

### Step 1: Install `agy-harness`

```bash
# From remote repository:
agy plugin install https://github.com/JsonLee12138/agy-harness.git

# Or from local checkout:
agy plugin install /path/to/agy-harness
```

### Step 2: Disable Standalone `agent-skills` (Important)

Because `agy-harness` already bundles all 25 unmodified upstream skills plus `harness-init` under the `agy-harness:*` namespace, keeping both `agent-skills` and `agy-harness` enabled duplicates 25 skill descriptions in every turn's progressive-disclosure catalog (~2.5K wasted prefix tokens per turn).

```bash
agy plugin disable agent-skills
agy plugin list
```

> **Global Zero-Intrusion Fallback (`hooks.json`)**: Installing the plugin enables plugin-root [`hooks.json`](../hooks.json) (`--plugin-mode`) across workspaces. Scripts immediately no-op (`allow` / `{}`) in any repository lacking `.agents/rules/agy-harness.md` and `.artifacts/{SPEC,PLAN}.md`, and `harness-lifecycle-hook.sh --plugin-mode` automatically yields if the workspace's own `.agents/hooks.json` already registers `harness-lifecycle-guard` (preventing duplicate injection).

---

## 2. Initializing a Target Project (`/agy-harness:harness-init`)

Open any target project in Antigravity IDE, App `v2.34+`, or `agy` CLI and run:

```text
/agy-harness:harness-init
```

Or run the deterministic bootstrap script directly (`scripts/init-harness.sh` delegates to [`skills/harness-init/scripts/init-harness.sh`](../skills/harness-init/scripts/init-harness.sh)):

```bash
# Recommended when agy-harness plugin is installed globally:
bash ~/.gemini/config/plugins/agy-harness/scripts/init-harness.sh /path/to/your-project

# Standalone mode (also copies the 3 core subagents into .agents/agents/ and rewrites ../scripts/hooks/ -> ../../scripts/hooks/):
bash /path/to/agy-harness/scripts/init-harness.sh /path/to/your-project --with-local-agents
```

Re-running without `--force` refreshes harness-managed rules, hook configs, guard scripts, and existing `.agents/agents/*.md` files in-place while preserving active `.artifacts/` contracts, customized `scripts/gate-check.sh`, and sibling hooks in `.agents/hooks.json`:
- **`.agents/rules/agy-harness.md`** (`3,484 B`, `<= 3.5 KB` / `4,096 B` cap) — `trigger: always_on` Coordinator Rule governing 5-tier (`Tier XS` / `Tier S` / `Tier M` / `Tier L` / `Tier XL`) routing, Orchestrator Plan Mode (`exit_plan_mode`) alignment, CRG coexistence (native direct reads default; honors `.agents/rules/crg.md` when enabled), auto-archive unlock, and `Proceed` (`RequestFeedback: true`) gates. Global [`rules/AGENTS.md`](../rules/AGENTS.md) (`1,331 B`, `< 1,500 B`) stays similarly lean so combined rules never hit `defaultRulesBudget` pointer demotion.
- **`.agents/hooks.json`** + **`scripts/harness-{approval-gate,source-edit-guard,lifecycle-hook,subagent-guard}.sh`** + **`scripts/hooks/{slice-builder,staff-gatekeeper}.hooks.json`** — Mirrors plugin-root `hooks.json` (without `--plugin-mode`) so repositories without the global plugin get identical Software 1.0 enforcement.
- **`scripts/gate-check.sh`** — Software 1.0 zero-token pre-review gate (supports `--fast` for intermediate checks).
- **`.artifacts/{context-brief.md,SPEC.md,CONSTRAINTS.md,PLAN.md}`** — Local Disk SSoT contract templates, automatically gitignored via `.gitignore` and `.artifacts/.gitignore`.

### 3-Group Hook Architecture & Native `Permissions` Layering

| Hook Group | Trigger & Matcher | Enforced Software 1.0 Boundary |
|---|---|---|
| `harness-contract-approval-gate` ([`harness-approval-gate.sh`](../scripts/harness-approval-gate.sh)) | `PreToolUse`: `invoke_subagent\|define_subagent\|swarm\|run_workflow\|exit_plan_mode` | Allowlists read-only subagents (`arch-redteam`, `staff-gatekeeper`, `research`); gates all other `invoke_subagent` calls (including `slice-builder` and custom definitions), `define_subagent(EnableWriteTools=true)`, `swarm(action="add")`, and `run_workflow` behind explicit user approval (questions/comments never unlock). On Orchestrator `exit_plan_mode`, never hard-`deny`s prose—emits `force_ask` only when an unapproved active contract invokes `slice-builder`/`swarm`/`run_workflow` (or has unapproved comments) or a contractless plan clearly exceeds Tier S (`>= 5` non-`isTierXsExemptPath` code/test paths or `Tier M/L/XL`/`slice-builder`/`swarm` without a Phase 1 stop, allowing `Tier XS` multi-doc/manifest plans). |
| `harness-parent-source-edit-guard` ([`harness-source-edit-guard.sh`](../scripts/harness-source-edit-guard.sh)) | `PreToolUse`: `write_file\|edit_file\|create_file\|delete_file\|sed_file\|write_to_file\|replace_file_content\|multi_replace_file_content\|run_command` | Uses deterministic 2-rule `isParent` detection across `transcript.jsonl` (first `SYSTEM_MESSAGE` containing `[Message]` + `sender=` -> subagent `false`; else any `USER_INPUT` or `USER_EXPLICIT` -> parent `true`; else `false`). When `.artifacts/` is `INACTIVE`, immediately `allow`s parent edits and `run_command` (no cumulative `git status` dirty-tree lock blocking `Tier XS` / `Tier S`). When active, fails closed (`force_ask`) on unrecognized edit targets, blocks parent edits (incl. `sed_file`), and intercepts `run_command` shell write bypasses (`>`/`>>`, `tee`, `sed -i`, `perl -i`, `patch`, `dd of=`, `truncate`, `install`, `rm`/`mv`/`cp`, mutating `git`, inline/heredoc `node`/`python` writes, exempting `.artifacts/`, `.agents/`, `/tmp/`, `/dev/null`) with zero false positives on read-only/test/gate commands. |
| `harness-lifecycle-guard` ([`harness-lifecycle-hook.sh`](../scripts/harness-lifecycle-hook.sh)) | `PreInvocation`, `PostToolUse` (edit tools incl. `sed_file` + `run_command`), `Stop` | `PreInvocation`: skips `!isParent` subagents and injects deduplicated 1-line state reminders (`ACTIVE_UNAPPROVED`, `ACTIVE_APPROVED`, or `INACTIVE_ROUTING_5TIER` for 5-tier `XS / S / M/L/XL` routing). `PostToolUse`: tracks `workspaceRoot`-scoped `lastSourceEditAtMs` ONLY when touching non-harness, non-`isTierXsExemptPath` files or untargeted workspace mutations (so `Tier XS` doc/manifest/version/lockfile/asset edits never trigger `Stop` loops). `Stop`: returns `decision: "continue"` until full `bash scripts/gate-check.sh` passes and 0 subagents remain, with `continuationActive`/`continuation_active` anti-loop and Phase 1 (`ACTIVE_UNAPPROVED`) exemptions. |

> **Pair AGY Native `Permissions` with `agy-harness` Hooks**: Use Antigravity's native static `Permissions` (`Deny > Ask > Allow`) for invariant security policies (such as denying `.env*`/credential file reads & writes or gating `git push --force`), and let `agy-harness` Hooks enforce dynamic workflow state (`.artifacts/` contract approval, `INACTIVE` dirty-tree unlock with `isTierXsExemptPath` `Stop` gate differentiation, and subagent physical boundaries).

---

## 3. 5-Tier (`Tier XS / S / M / L / XL`) Budget Routing, Human `Proceed` Gates & Subagent Matrix

### Alignment-First Human Confirmation, Orchestrator Mode & Auto-Archive

Because workspace files cannot carry `ArtifactMetadata`, the main session mirrors every contract checkpoint to `<ArtifactDir>/harness_plan.md` with `ArtifactMetadata: { UserFacing: true, RequestFeedback: true }` and stops its turn so Antigravity renders the native **`Proceed`** button:
- **Orchestrator Plan–Execute Compatibility**: `Tier XS` and `Tier S` execute directly via Plan–Execute without `.artifacts/` or `Proceed` stop (unless escalating). For `Tier M / L / XL` in Plan Mode, stay read-only—align in chat or limit Phase 1 `exit_plan_mode` strictly to drafting `.artifacts/{SPEC,PLAN}.md` + `<ArtifactDir>/harness_plan.md` (`RequestFeedback: true`) and stopping; never edit code or invoke `slice-builder`/`swarm`/`run_workflow` before `Proceed`.
- **Tier Checkpoints**: **Tier XS** and **Tier S** require **0 `Proceed` clicks** (unless `XS -> S` or `S -> M` escalates); **Tier M** requires **1 `Proceed` click**; **Tier L / XL** default to **1 `Proceed` click** (pausing for a 2nd only if `arch-redteam` surfaces a scope/contract `[BLOCKER]`).
- **Contract-Only Re-Confirmation**: Substantive edits to `.artifacts/SPEC.md` or `.artifacts/PLAN.md` contract sections re-lock execution, while progress checkboxes (`- [x]`, `Status:`) and `## Implementation Notes / Guardrails` / `<!-- non-contract -->` pass without re-locking.
- **Automatic Contract Archiving**: Adding `<!-- HARNESS_STATUS: ARCHIVED -->` / `<!-- HARNESS_STATUS: DONE -->` to `SPEC.md` or `PLAN.md`, OR completing all checkboxes (`>= 1` `- [x]` with `0` `- [ ]` in `SPEC.md` and `>= 1` `[x]` status with `0` `[ ]`/`[/]` in `PLAN.md`), automatically marks the contract inactive and unlocks subsequent independent `Tier XS` / `Tier S` tasks (while `slice-builder` still requires drafting a new contract before executing).

### 5-Tier Epistemic × Blast-Radius Budget Matrix

| Tier | Trigger Scope & Hard Disqualifiers | Pipeline & Human `Proceed` Checkpoints | Est. Cost Multiplier |
|------|--------------------------------------|----------------------------------------|----------------------|
| **Tier XS** | Deterministic chore: prose/docs, version/plugin manifests (`plugin.json`/`marketplace.json`/`VERSION`/`version.txt`), lockfiles, repo metadata (`CODEOWNERS`/`LICENSE`/`.gitignore`), static media/fonts, formatting, literal tweaks (no file-count cap; **hard `XS -> S`**: touching executable control flow, regex, `agents/`/`skills/`/`commands/`, or error troubleshooting forbids `XS`) | Direct edit -> lightweight validation (0 `.artifacts/`, 0 `Proceed`, 0 subagents; `isTierXsExemptPath` exempts `Stop` full `gate-check.sh` loop) | **0.8x-1.0x** |
| **Tier S** | Scoped bug fix or local logic: `<= 3` files (incl. tests), `<= 150` lines, intact external contract (`.artifacts/` inactive or archived; **hard `S -> M`**: `> 3` code files, public API change, or design fork escalates to `Tier M`) | Root-cause diagnosis first (`agy-harness:debugging-and-error-recovery`) -> direct TDD (`agy-harness:test-driven-development`: failing repro test `RED -> GREEN`) -> full `bash scripts/gate-check.sh` enforced by `Stop` hook (0 `.artifacts/`, 0 `Proceed`, 0 subagents) | **1.0x** |
| **Tier M** | Standard multi-file feature or refactor | Native direct reads (or CRG if `.agents/rules/crg.md` enabled) -> **`Proceed` #1 (SPEC+PLAN)** -> cohesive `slice-builder` (`send_message` closed loop) -> `gate-check.sh` -> on-demand 4-in-1 `staff-gatekeeper` -> `kill` | **1.3x-1.6x** |
| **Tier L** | Core architecture, public API change, auth/payment/critical path | Native direct reads (CRG if enabled) -> **`Proceed` #1 (SPEC+PLAN)** -> `arch-redteam` (2nd `Proceed` only on `[BLOCKER]`, then `kill`) -> per-slice closed loop (`slice-builder` -> `gate-check.sh` -> 4-in-1 `staff-gatekeeper` via `send_message` -> `kill` on `GO`) | **2.0x-2.4x** |
| **Tier XL** | `>= 3` orthogonal modules with disjoint file subtrees | Native direct reads (CRG if enabled) -> **`Proceed` #1 (SPEC + subtree PLAN)** -> `arch-redteam` (then `kill`) -> parallel `slice-builder` (`Workspace: "share"`) or Native `Swarm` (`workspace: "share"`) -> `gate-check.sh` -> 4-in-1 `staff-gatekeeper` -> `kill` | **2.0x-2.8x** |

### Subagent, Frontmatter `hooks:` & Canonical Tools Matrix

All 3 agents declare canonical AGY tool names (`read_file`; plus `write_file`, `edit_file`, `create_file` on `slice-builder`) alongside legacy aliases (`view_file`, `write_to_file`, `replace_file_content`, `multi_replace_file_content`) for cross-version compatibility, while physically stripping all write tools from read-only roles:

| Subagent (`agents/*.md`) | Model & MCP | Frontmatter `hooks:` & [`harness-subagent-guard.sh`](../scripts/harness-subagent-guard.sh) | Tools & Permission Policy |
|---|---|---|---|
| [`arch-redteam`](../agents/arch-redteam.md) | `inherit`, `mcpServers: []` | None (zero write/exec tools) | **Read-only** (`read_file`, `view_file`, `list_dir`, `grep_search`, `find_by_name`; `commandExecutionPolicy: off`) |
| [`slice-builder`](../agents/slice-builder.md) | `inherit`, `mcpServers: []` | [`slice-builder.hooks.json`](../scripts/hooks/slice-builder.hooks.json) (`--role=slice-builder`): unconditionally locks `.artifacts/{SPEC,CONSTRAINTS,PLAN}.md`; locks `.agents/*` & `scripts/harness-*.sh` in target repos (self-hosting exception when root `plugin.json` has `name: "agy-harness"`); blocks `IsDaemon: true`, `WaitMsBeforeAsync > 10000`, and blacklisted commands with `[HOST_CMD_REQUEST]` guidance | Read + Write (`read_file`, `write_file`, `edit_file`, `create_file` + legacy aliases, `run_command`; `commandExecutionPolicy: sandbox`) |
| [`staff-gatekeeper`](../agents/staff-gatekeeper.md) | `inherit`, `mcpServers: []` | [`staff-gatekeeper.hooks.json`](../scripts/hooks/staff-gatekeeper.hooks.json) (`--role=staff-gatekeeper`): locks `run_command` to short read-only checks (blocks daemon/`> 10000ms`, containers, installs, shell writes) | **Read-only** + `sandbox` (`read_file`, `view_file`, `list_dir`, `grep_search`, `find_by_name`, `run_command`; zero write tools) |

> **Per-Slice Closed-Loop & Empirical Basis**: `slice-builder` and `staff-gatekeeper` stay alive via `send_message` across gate fixes and `NO-GO` rework until Slice `N` passes `GO`, then are immediately terminated via `manage_subagents(Action="kill")` before starting a clean-context Slice `N+1`. Controlled VaultMesh A/B benchmarks showed native direct search outperformed CRG by ~47% wall-clock time (`478.61s` vs `703.52s`), and uniform `model: inherit` outperformed tiered `pro`/`flash` (`652.54s` 6/6 pass vs `1200.03s` timeout)—so CRG is disabled by default unless a workspace explicitly enables `.agents/rules/crg.md`.

### Subagent 5-Second Local Command Guardrail & `[HOST_CMD_REQUEST]` Delegation

To prevent sandboxed subagents (`slice-builder`, `staff-gatekeeper`) from deadlocking on Docker sockets, network fetches, interactive prompts, or long-running processes:
- **5-Second Local Short-Command Boundary**: Subagents may only run deterministic, offline, non-interactive workspace checks expected to exit in `<= 5s` (`WaitMsBeforeAsync <= 5000`, `IsDaemon: false`; hard cap `10000ms` enforced by `harness-subagent-guard.sh`), while `scripts/gate-check.sh` exports `CI=true GIT_PAGER=cat`, passes `git --no-pager diff`, and redirects `< /dev/null`.
- **Zero-Exception Subagent Blacklist**: Containers/virtualization (`docker`, `docker-compose`, `podman`, `colima`, `orbstack`, `kubectl`, `helm`, `kind`, `minikube`, `testcontainers`), dependency installs (`npm/pnpm/yarn/bun install|i|add|ci`, `pip/pip3/poetry/uv install`, `go mod download|tidy`, `flutter pub get`, `pod install`), daemons/watchers/interactive flags (`IsDaemon: true`, `--watch`, `tail -f`, `logs -f`, `-it`/`-ti`), and slow (`> 10s`) builds or E2E suites are physically blocked inside subagents.
- **`[HOST_CMD_REQUEST]` ↔ `send_message` In-Place Resume**: After finishing local edits and fast checks, the subagent batches any required heavy/container commands into a structured `## [HOST_CMD_REQUEST]` block (including the explicit absolute `cwd`, supporting Tier XL `Workspace: "share"` worktrees) and ends its turn. The top-level main session executes the command non-interactively on the host, trims output to exit code + `<= 50` key lines, and calls `send_message(Recipient: "<conversationId>")` to resume the **same** subagent in-place (`<= 2` retry rounds; `slice-builder` reports `DELEGATED_TO_HOST` upon pass).

---

## 4. Validation & Golden Eval (30-Minute A/B Repro)

### Plugin Structural & Harness Validation

```bash
agy plugin validate /path/to/agy-harness
agy --add-dir /path/to/agy-harness agents
node scripts/validate-skills.js && CI=true node --test scripts/harness-test.js && bash scripts/gate-check.sh
```

> **`agy plugin validate .` Expected Output**: Passes with **`0` errors** (`skills 26 · agents 3 · rules 1 · hooks 3 · mcpServers 0 · sidecars 0`). Two informational warnings on root `AGENTS.md` and `commands/` are expected and intentional—those files remain at the repo root for multi-host parity (Claude Code / Gemini CLI / Codex / OpenCode) and CI command validation (`scripts/validate-commands.js`).

### 30-Minute Historical PR A/B Eval

1. Pick a medium-complexity historical PR that previously leaked an edge-case bug, and check out its parent commit in two `git worktree` directories.
2. **Control Group A**: Manually invoke spec, implementation, and review skills in a single main conversation.
3. **Experiment Group B**: Run `/agy-harness:harness-init` and execute the task through the automatic Tier M/L pipeline.
4. Measure three objective metrics:
   - **Pre-code defect interception**: Did `arch-redteam` surface the interface/state edge case before code was written?
   - **Software 1.0 gate saves**: How many compile/lint/test failures did `scripts/gate-check.sh` catch at 0 review tokens?
   - **End-to-end token multiplier vs. human rework rounds**: Verify token overhead stays `< 1.8x-2.6x` while manual `Ctrl+R` rework drops to `0-1` rounds.
