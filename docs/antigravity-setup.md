# Using `agy-harness` with Google Antigravity (`agy` CLI, IDE & App 2.0)

`agy-harness` upgrades the 25 upstream `addyosmani/agent-skills` workflows (with **zero lines modified** in upstream `SKILL.md` files) into a budget-governed **Generate-and-Falsify Engineering Harness** for Google Antigravity (`agy` CLI v1.4+, Antigravity IDE, and Antigravity 2.0).

Instead of manually invoking skills one by one—or letting a single polluted context review its own code—`agy-harness` enforces:
1. **Disk SSoT Contracts (`.artifacts/`)**: `context-brief.md`, `SPEC.md`, `CONSTRAINTS.md`, and `PLAN.md`.
2. **Software 1.0 Zero-Token Hard Gate (`scripts/gate-check.sh`)**: Diff-size check, typecheck/lint, deterministic tests, and secret/`debugger;` scan before spending review tokens.
3. **Dual-Layer Rules + `/agy-harness:harness-init` Skill**: Replaces the deprecated UI `mainAgent` switcher by registering `.agents/rules/agy-harness.md` per repository, leaving uninitialized workspaces untouched.
4. **5 Physically Isolated Subagents (`agents/*.md`)**: Hardware-enforced read-only tool allowlists and heterogeneous `flash` / `inherit` / `pro` model tiering.

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

---

## 2. Initializing a Target Project (`/agy-harness:harness-init`)

Open any target project in Antigravity IDE, Antigravity 2.0, or `agy` CLI and run:

```text
/agy-harness:harness-init
```

Or run the deterministic bootstrap script directly:

```bash
# Recommended when agy-harness plugin is installed globally:
bash ~/.gemini/config/plugins/agy-harness/scripts/init-harness.sh /path/to/your-project

# Standalone mode (also copies the 5 subagents into <your-project>/.agents/agents/):
bash /path/to/agy-harness/scripts/init-harness.sh /path/to/your-project --with-local-agents
```

This creates (and refreshes `.agents/rules/agy-harness.md` + `scripts/harness-approval-gate.sh` in-place on future runs so rule/gate updates never go stale):
- `.agents/rules/agy-harness.md` — Workspace Coordinator Rule governing Tier S/M/L/XL routing and alignment-first `Proceed` (`RequestFeedback: true`) confirmation gates.
- `.agents/hooks.json` + `scripts/harness-approval-gate.sh` — Software 1.0 `PreToolUse` lock that physically blocks `slice-builder` and `swarm` whenever `.artifacts/SPEC.md` or `.artifacts/PLAN.md` core contract sections are created or substantively modified without user confirmation in a subsequent turn (while allowing checkbox/status updates and `## Implementation Notes / Guardrails` additions).
- `scripts/gate-check.sh` — Software 1.0 zero-token pre-review gate (supports `--fast` for quick intermediate checks).
- `.artifacts/{context-brief.md,SPEC.md,CONSTRAINTS.md,PLAN.md}` — Local Disk SSoT contract templates, automatically added to `.gitignore` (plus `.artifacts/.gitignore`) so per-task specs and plans stay local and never pollute Git history or `gate-check.sh` diff counts (preserved across re-runs unless `--force` is passed).

---

## 3. Tier S / M / L / XL Budget Routing, Human `Proceed` Gates & Subagent Matrix

### Alignment-First Human Confirmation Protocol (Anti-Runaway Guarantee)

Because workspace files cannot carry `ArtifactMetadata`, the main session mirrors every contract checkpoint to `<ArtifactDir>/harness_plan.md` with `ArtifactMetadata: { UserFacing: true, RequestFeedback: true }` and stops its turn so Antigravity renders the native **`Proceed`** button:
- **Tier S**: **0 `Proceed` clicks** (fast lane up to 3 files / 150 lines, zero subagents).
- **Tier M**: **1 `Proceed` click** (align on concise `SPEC.md + PLAN.md` first -> cohesive/adaptive `slice-builder` -> `gate-check.sh`).
- **Tier L / Tier XL**: **1 `Proceed` click by default** (align on requirements & core plan first -> post-approval `arch-redteam` check; only pauses for a 2nd `Proceed` if a `[BLOCKER]` forces changing the approved scope or public contract).
- **Contract-Only Re-Confirmation (Enforced by `.agents/hooks.json`)**: Substantive edits to `.artifacts/SPEC.md` or `.artifacts/PLAN.md` contract sections re-lock `slice-builder` and `swarm` until confirmed, while status checkboxes and `## Implementation Notes / Guardrails` (`[RISK-NOTE]`s) pass without re-locking.

### Task Budget Tiers

| Tier | Trigger Scope | Pipeline & Human `Proceed` Checkpoints | Est. Cost Multiplier |
|------|---------------|----------------------------------------|----------------------|
| **Tier S** | Up to 3 files (incl. tests), `<= 150` lines, no breaking API or high-risk boundary | Main session TDD -> `scripts/gate-check.sh` -> Done (0 contract prompts, 0 review subagents) | **1.0x** |
| **Tier M** | Standard multi-file feature or refactor | Direct read (or on-demand `repo-scout`) -> **`Proceed` #1 (SPEC+PLAN)** -> adaptive `slice-builder` (cohesive default, `send_message` resume) -> `gate-check.sh` -> diff check (on-demand `staff-gatekeeper`) | **1.3x-1.6x** |
| **Tier L** | Core architecture, public API change, auth/payment/critical path | Direct read / `repo-scout` -> **`Proceed` #1 (SPEC+PLAN)** -> `arch-redteam` (2nd `Proceed` only on `[BLOCKER]`) -> adaptive `slice-builder` -> `gate-check.sh` -> parallel `staff-gatekeeper` & `risk-specialist` | **2.0x-2.4x** |
| **Tier XL** | `>= 3` orthogonal modules with disjoint file subtrees | Direct read / `repo-scout` -> **`Proceed` #1 (SPEC + subtree PLAN)** -> `arch-redteam` (2nd `Proceed` only on `[BLOCKER]`) -> parallel `slice-builder` (`Workspace: "share"`) or Native `Swarm` (`workspace: "share"`) -> `gate-check.sh` -> `staff-gatekeeper` | **2.0x-2.8x** |

### Subagent & Model Matrix

| Subagent (`agents/*.md`) | YAML `model` Tier | Recommended Model Mapping | Mounted `agy-harness:*` Skills | Permission Policy |
|--------------------------|-------------------|---------------------------|--------------------------------|-------------------|
| [`repo-scout`](../agents/repo-scout.md) | `flash` | Gemini 3.8 Flash (Low/Med) | `context-engineering`, `source-driven-development` | **Read-only** (`commandExecutionPolicy: off`) |
| [`arch-redteam`](../agents/arch-redteam.md) | `pro` | Gemini 4 Argon (High) / Claude Thinking | `doubt-driven-development`, `api-and-interface-design` | **Read-only** (`commandExecutionPolicy: off`) |
| [`slice-builder`](../agents/slice-builder.md) | `flash` | Gemini 3.8 Flash (Med/High) | `incremental-implementation`, `test-driven-development`, `debugging-and-error-recovery`, `frontend-ui-engineering` | Read + Write + `sandbox` |
| [`staff-gatekeeper`](../agents/staff-gatekeeper.md) | `pro` | Gemini 4 Argon (Med/High) | `code-review-and-quality`, `code-simplification`, `test-driven-development` | **Read-only** + `sandbox` (`git diff`) |
| [`risk-specialist`](../agents/risk-specialist.md) | `pro` | Gemini 4 Argon (High) | `security-and-hardening`, `performance-optimization`, `browser-testing-with-devtools` | **Read-only** + `sandbox` |

### Subagent 5-Second Local Command Guardrail & `[HOST_CMD_REQUEST]` Delegation

To prevent sandboxed subagents (`slice-builder`, `staff-gatekeeper`, `risk-specialist`) from deadlocking on Docker sockets, network fetches, interactive prompts, or long-running processes:
- **5-Second Local Short-Command Boundary**: Subagents may only run deterministic, offline, non-interactive workspace checks expected to exit in `<= 5s` (`WaitMsBeforeAsync <= 5000`, `IsDaemon: false`; hard cap `10s`), while `scripts/gate-check.sh` exports `CI=true GIT_PAGER=cat`, passes `git --no-pager diff`, and redirects `< /dev/null`.
- **Zero-Exception Subagent Blacklist**: Containers/virtualization (`docker`, `docker compose`, `podman`, `kubectl`, `testcontainers`), dependency installs (`npm/pnpm/yarn/bun/pip/uv/cargo/go/flutter/pod`), daemons/watchers/interactive flags (`IsDaemon: true`, `--watch`, `tail -f`, `-it`), and slow (`> 10s`) builds or E2E suites are strictly forbidden inside subagents.
- **`[HOST_CMD_REQUEST]` ↔ `send_message` In-Place Resume**: After finishing local edits and fast checks, the subagent batches any required heavy/container commands into a structured `## [HOST_CMD_REQUEST]` block (including the explicit absolute `cwd`, supporting Tier XL `Workspace: "share"` worktrees) and ends its turn. The top-level main session executes the command non-interactively on the host, trims output to exit code + `<= 50` key lines, and calls `send_message(Recipient: "<conversationId>")` to resume the **same** subagent in-place (`<= 2` retry rounds; `slice-builder` reports `DELEGATED_TO_HOST` upon pass).

---

## 4. Validation & Golden Eval (30-Minute A/B Repro)

### Plugin Structural Validation

```bash
agy plugin validate /path/to/agy-harness
agy --add-dir /path/to/agy-harness agents
```

### 30-Minute Historical PR A/B Eval

1. Pick a medium-complexity historical PR that previously leaked an edge-case bug, and check out its parent commit in two `git worktree` directories.
2. **Control Group A**: Manually invoke spec, implementation, and review skills in a single main conversation.
3. **Experiment Group B**: Run `/agy-harness:harness-init` and execute the task through the automatic Tier M/L pipeline.
4. Measure three objective metrics:
   - **Pre-code defect interception**: Did `arch-redteam` surface the interface/state edge case before code was written?
   - **Software 1.0 gate saves**: How many compile/lint/test failures did `scripts/gate-check.sh` catch at 0 review tokens?
   - **End-to-end token multiplier vs. human rework rounds**: Verify token overhead stays `< 1.8x-2.6x` while manual `Ctrl+R` rework drops to `0-1` rounds.
