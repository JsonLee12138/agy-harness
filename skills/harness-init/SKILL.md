---
name: harness-init
description: Bootstraps and registers the AGY Harness workspace coordinator rule (.agents/rules/agy-harness.md), Software 1.0 gate script (scripts/gate-check.sh), and Disk SSoT contract templates (.artifacts/). Use when initializing agy-harness in a project, scaffolding gate-check.sh and .artifacts contracts, or running /agy-harness:harness-init.
---

# Harness Initialization (`harness-init`)

## Overview

Registers the **AGY Harness generate-and-falsify state machine** inside a target workspace in one deterministic step. Because modern Antigravity surfaces run a fixed top-level conversation agent rather than a user-switched `mainAgent`, this skill installs:
- `.agents/rules/agy-harness.md` — Coordinator rule governing Tier S/M/L/XL routing and native `Proceed` (`RequestFeedback: true`) human confirmation checkpoints on every `SPEC.md` / `PLAN.md` draft or substantive edit;
- `.agents/hooks.json` + `scripts/harness-approval-gate.sh` — Software 1.0 `PreToolUse` physical lock blocking premature `slice-builder` / `swarm` execution until the user confirms the latest contract;
- `scripts/gate-check.sh` — Software 1.0 zero-token build/lint/test/secret pre-review gate;
- `.artifacts/` — Local Disk SSoT contract templates (`context-brief.md`, `SPEC.md`, `CONSTRAINTS.md`, `PLAN.md`), automatically excluded from Git commits via `.gitignore` and `.artifacts/.gitignore` so ephemeral per-task specs never pollute PR diffs or cause merge conflicts.

## When to Use

- Initializing `agy-harness` in a new or existing repository (`/agy-harness:harness-init`)
- Scaffolding `.agents/rules/agy-harness.md`, `.agents/hooks.json`, `scripts/gate-check.sh`, and `.artifacts/` before starting Tier M / L / XL work
- Syncing standalone workspace subagents (`.agents/agents/*.md`) into a repository that will run without a global plugin installation

- **When NOT to use:** Only when passing `--force` mid-implementation while `.artifacts/SPEC.md` and `.artifacts/PLAN.md` hold active task contracts. Running default `init-harness.sh` without `--force` is safe for upgrading `.agents/rules/agy-harness.md` and `scripts/harness-approval-gate.sh` in-place while preserving existing `.artifacts/` contracts, customized `scripts/gate-check.sh`, and sibling entries in `.agents/hooks.json`.

## The Initialization Process

### Step 1: Inspect Existing Workspace State

Check whether the target repository already contains any of the following files:
- `.agents/rules/agy-harness.md`, `.agents/hooks.json`
- `scripts/gate-check.sh`, `scripts/harness-approval-gate.sh`
- `.artifacts/SPEC.md`, `.artifacts/CONSTRAINTS.md`, `.artifacts/PLAN.md`, `.artifacts/context-brief.md`

Re-running without `--force` always updates harness-managed `.agents/rules/agy-harness.md`, `scripts/harness-approval-gate.sh`, `.agents/hooks.json`'s `harness-contract-approval-gate` entry (and `.agents/agents/*.md` when `--with-local-agents` is set) so rule and gate versions stay current, while preserving existing `.artifacts/` contracts, customized `scripts/gate-check.sh`, and sibling hooks in `.agents/hooks.json`. Never pass `--force` unless the user explicitly asks to reset `.artifacts/` contracts or `scripts/gate-check.sh`.

### Step 2: Run the Deterministic Scaffolding Script

Execute `skills/harness-init/scripts/init-harness.sh` from the installed `agy-harness` plugin root against the target workspace root (`.`):

```bash
# Default mode (recommended when agy-harness plugin is enabled globally):
bash <plugin-root>/skills/harness-init/scripts/init-harness.sh .

# Standalone workspace mode (also copies the 5 subagents into .agents/agents/):
bash <plugin-root>/skills/harness-init/scripts/init-harness.sh . --with-local-agents
```

The script installs and merges templates from:
- [harness-rule-template.md](references/harness-rule-template.md) → `.agents/rules/agy-harness.md`
- [hooks-template.json](references/hooks-template.json) → `.agents/hooks.json` (paired with `scripts/harness-approval-gate.sh`)
- [context-brief-template.md](references/context-brief-template.md) → `.artifacts/context-brief.md`
- [spec-template.md](references/spec-template.md) → `.artifacts/SPEC.md`
- [constraints-template.md](references/constraints-template.md) → `.artifacts/CONSTRAINTS.md`
- [plan-template.md](references/plan-template.md) → `.artifacts/PLAN.md`

### Step 3: Adapt `scripts/gate-check.sh` If Needed

Inspect the repository's build/test files (`package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`, `pubspec.yaml`, `Makefile`). If the repository uses a stack-specific test or lint runner not yet invoked by `scripts/gate-check.sh` (for example `pytest` or `flutter analyze && flutter test`), add that deterministic check under Gate 2 / Gate 3 while keeping Gate 1 (diff size warning) and Gate 4 (secret & `debugger;` scan) intact.

### Step 4: Smoke-Test the Software 1.0 Gate

Run `bash scripts/gate-check.sh` in the workspace root and confirm it exits `0` with `ALL SOFTWARE 1.0 GATES PASSED.`

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "I'll hand-write `.agents/rules/agy-harness.md` from memory instead of running the script" | Hand-typed rules drift on subagent names, `agy-harness:*` skill prefixes, human `Proceed` checkpoints, and the `.agents/hooks.json` approval lock. Run `init-harness.sh` for exact parity. |
| "I'll pass `--force` to make sure everything is fresh" | `--force` wipes locked `.artifacts/SPEC.md` and `PLAN.md` contracts and customized `scripts/gate-check.sh`. Default mode already refreshes `.agents/rules/agy-harness.md` and `scripts/harness-approval-gate.sh` automatically while preserving `.artifacts/` and `scripts/gate-check.sh`. |
| "I can skip running `scripts/gate-check.sh` during init" | A broken Gate 1.0 script blocks every downstream `slice-builder` turn. Verify it passes once before starting feature work. |

## Red Flags

- Overwriting a populated `.artifacts/SPEC.md` or `.artifacts/PLAN.md` without explicit user confirmation
- Writing `agent-skills:*` prefixes instead of `agy-harness:*` inside `.agents/rules/agy-harness.md`
- Removing `.agents/hooks.json` or `scripts/harness-approval-gate.sh` to bypass human confirmation on `SPEC.md` / `PLAN.md` edits
- Removing the secret or `debugger;` check from `scripts/gate-check.sh`
- Leaving `scripts/gate-check.sh` or `scripts/harness-approval-gate.sh` non-executable

## Verification

After completing initialization, confirm:

- [ ] `.agents/rules/agy-harness.md` exists and declares Tier S / M / L / XL routing and human `Proceed` confirmation gates
- [ ] `.agents/hooks.json` and executable `scripts/harness-approval-gate.sh` exist
- [ ] `scripts/gate-check.sh` exists and is executable
- [ ] `.artifacts/context-brief.md`, `.artifacts/SPEC.md`, `.artifacts/CONSTRAINTS.md`, and `.artifacts/PLAN.md` exist and `.artifacts/` is listed in `.gitignore`
- [ ] `bash scripts/gate-check.sh` completes with exit code `0` (`ALL SOFTWARE 1.0 GATES PASSED.`)
