---
name: harness-init
description: Bootstraps clean-room AGY Harness setup (.agents/rules/agy-harness.md, polyglot fingerprint-deduped scripts/gate-check.sh, and lean .artifacts contracts) while cleaning legacy v0.1-v0.3 guard clutter. Use when initializing agy-harness in a project, upgrading from an older version, scaffolding gate-check.sh, or running /agy-harness:harness-init.
---

# Harness Initialization (`harness-init`)

## Overview

Registers the **AGY Harness v0.4 adaptive generate-and-falsify state machine** cleanly inside a target workspace without polluting `scripts/` with thousands of lines of copied guard code:
- **Clean-room default mode** (when the global `agy-harness` plugin is enabled):
  - Installs/updates `.agents/rules/agy-harness.md` (`trigger: always_on`, `<= 3.5 KB` / `<= 4,096 B` budget) with 3-mode complexity & bug-rigor routing (`Trivial` / `Bug Fix` / `Contract`), pre-confirmation `arch-redteam`, dual-layer anti-hang watchdog (`schedule` 75s + `NotificationTimeoutSeconds: 45`), `<!-- HARNESS_STATUS: PAUSED -->` side-quest support, and warm-cache parent edits post-`Proceed`;
  - Scaffolds polyglot, Git-fingerprint-deduplicated `scripts/gate-check.sh` (auto-detects `pnpm`/`bun`/`yarn`/`npm`, `cargo`, `go`, `ruff`/`pytest`, `dart`/`flutter`, supports `--fast` and `--force`, and skips duplicate full runs on unchanged working trees);
  - Scaffolds lean `.artifacts/{SPEC,CONSTRAINTS,PLAN}.md` templates (gitignored via `.gitignore` and `.artifacts/.gitignore`);
  - **Automatically cleans legacy v0.1–v0.3 clutter**: removes old `scripts/harness-{approval-gate,source-edit-guard,lifecycle-hook,subagent-guard}.sh`, `scripts/hooks/*.hooks.json`, unfilled template `.artifacts/context-brief.md`, harness hook keys from `.agents/hooks.json` (preserving any custom user hooks), and retired/redundant `.agents/agents/*.md` files.
- **Standalone offline mode (`--standalone`, alias `--with-local-agents`)**:
  - For environments without the global `agy-harness` plugin installed, keeps `scripts/` clean and places standalone hook scripts + `lib/harness-core.{js,py}` + `*.hooks.json` inside hidden `.agents/hooks/`, merges `.agents/hooks.json` (`./hooks/harness-*.sh`), and renders `.agents/agents/*.md` pointing to `../hooks/*.hooks.json`.

## When to Use

- Initializing `agy-harness` in a new or existing repository (`/agy-harness:harness-init`)
- Upgrading a workspace from `agy-harness` v0.1–v0.3 to v0.4 clean-room setup (removes legacy `scripts/harness-*.sh` clutter automatically)
- Setting up standalone offline repo hooks and local subagents (`--standalone` / `--with-local-agents`)

- **When NOT to use:** Passing `--force` mid-implementation while `.artifacts/SPEC.md` and `.artifacts/PLAN.md` hold active task contracts. Default mode refreshes `.agents/rules/agy-harness.md` and cleans legacy scripts in-place while preserving active `.artifacts/` contracts, customized `scripts/gate-check.sh`, and custom user hooks in `.agents/hooks.json`.

## The Initialization Process

### Step 1: Inspect Existing Workspace State

Check whether the target repository already contains:
- `.agents/rules/agy-harness.md`, `.agents/hooks.json`, `.agents/hooks/`, `.agents/agents/`
- `scripts/gate-check.sh`, legacy `scripts/harness-*.sh`, legacy `scripts/hooks/*.hooks.json`
- `.artifacts/{SPEC,CONSTRAINTS,PLAN}.md` or legacy `.artifacts/context-brief.md`

### Step 2: Run the Deterministic Scaffolding Script

Execute `skills/harness-init/scripts/init-harness.sh` from the installed `agy-harness` plugin root against the target workspace root (`.`):

```bash
# Default clean-room mode (recommended when agy-harness plugin is enabled globally):
bash <plugin-root>/skills/harness-init/scripts/init-harness.sh .

# Standalone offline mode (installs hooks/core/agents cleanly under .agents/hooks/ and .agents/agents/):
bash <plugin-root>/skills/harness-init/scripts/init-harness.sh . --standalone
```

The script installs/updates and cleans up:
- [harness-rule-template.md](references/harness-rule-template.md) → `.agents/rules/agy-harness.md` (`<= 3.5 KB`)
- `scripts/gate-check.sh` (`0755`, preserved if already customized unless `--force`)
- [spec-template.md](references/spec-template.md) → `.artifacts/SPEC.md`
- [constraints-template.md](references/constraints-template.md) → `.artifacts/CONSTRAINTS.md`
- [plan-template.md](references/plan-template.md) → `.artifacts/PLAN.md`
- Removes legacy `scripts/harness-*.sh`, `scripts/hooks/*.hooks.json`, unfilled `.artifacts/context-brief.md`, and (in default mode) `.agents/hooks.json` harness keys + retired `.agents/agents/*`.

### Step 3: Adapt `scripts/gate-check.sh` If Needed

`scripts/gate-check.sh` auto-detects `pnpm`/`bun`/`yarn`/`npm`, `Cargo.toml`, `go.mod`, `pyproject.toml`/`ruff.toml`/`pytest`, and `pubspec.yaml`. If your repository uses custom monorepo commands or a fast targeted test script (`test:fast`), add them under Gate 2 / Gate 3 while keeping Gate 1 (diff size warning excluding lockfiles), Gate 4 (secret & non-markdown `debugger;` scan), and fingerprint deduplication intact.

### Step 4: Smoke-Test the Software 1.0 Gate

Run `bash scripts/gate-check.sh` in the workspace root and confirm it exits `0` with `ALL SOFTWARE 1.0 GATES PASSED.`

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "I'll hand-write `.agents/rules/agy-harness.md` from memory instead of running the script" | Hand-typed rules drift on 3-mode routing, pre-confirmation `arch-redteam`, anti-hang watchdogs, and `HARNESS_STATUS: PAUSED` semantics. Run `init-harness.sh` for exact parity. |
| "I'll pass `--force` to make sure everything is fresh" | `--force` wipes locked `.artifacts/SPEC.md` and `PLAN.md` contracts and customized `scripts/gate-check.sh`. Default mode already upgrades `.agents/rules/agy-harness.md` and cleans legacy v0.3 files safely. |
| "I'll copy `scripts/harness-*.sh` back into `scripts/` so everything is visible" | Copying 6,600 lines of guard scripts into `scripts/` pollutes target repo diffs; global `hooks.json` handles it automatically, and `--standalone` isolates offline hooks inside `.agents/hooks/`. |

## Red Flags

- Overwriting a populated `.artifacts/SPEC.md` or `.artifacts/PLAN.md` without explicit user confirmation
- Re-introducing legacy `scripts/harness-*.sh` or `scripts/hooks/` into target repositories during default init
- Removing the secret or `debugger;` check from `scripts/gate-check.sh`
- Leaving `scripts/gate-check.sh` non-executable

## Verification

After completing initialization, confirm:

- [ ] `.agents/rules/agy-harness.md` exists (`trigger: always_on`, `<= 3.5 KB` / `<= 4096` bytes) and declares 3-mode routing (`Trivial` / `Bug Fix` / `Contract`), pre-confirmation `arch-redteam`, dual-layer watchdog (`75s` `schedule` + `NotificationTimeoutSeconds: 45`), `HARNESS_STATUS: PAUSED`, and `HARNESS_EXECUTION: SUBAGENT_ONLY`
- [ ] In default clean-room mode: legacy `scripts/harness-*.sh`, `scripts/hooks/*.hooks.json`, unfilled `.artifacts/context-brief.md`, and harness keys in `.agents/hooks.json` are removed while custom user hooks and customized `scripts/gate-check.sh` are preserved
- [ ] If `--standalone` (or `--with-local-agents`) was used: `.agents/hooks/harness-*.sh`, `.agents/hooks/lib/harness-core.{js,py}`, `.agents/hooks/{slice-builder,staff-gatekeeper}.hooks.json`, `.agents/hooks.json`, and `.agents/agents/*.md` (`../hooks/`) are installed
- [ ] `scripts/gate-check.sh` exists, is executable, and supports `--fast` and `--force`
- [ ] `.artifacts/SPEC.md`, `.artifacts/CONSTRAINTS.md`, and `.artifacts/PLAN.md` exist and `.artifacts/` is listed in `.gitignore`
- [ ] `bash scripts/gate-check.sh` completes with exit code `0` (`ALL SOFTWARE 1.0 GATES PASSED.`)
