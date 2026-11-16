# AGY Harness Global Workspace Detector

- When the active workspace contains `.agents/rules/agy-harness.md` or `.artifacts/SPEC.md`, strictly follow the workspace's `trigger: always_on` Coordinator state machine: native parallel direct reads (zero CRG), alignment-first `Proceed` (`RequestFeedback: true`) checkpoints, `.agents/hooks.json` dual Software 1.0 guards (`harness-approval-gate.sh` & `harness-source-edit-guard.sh`), per-slice closed-loop `send_message` reuse followed by `manage_subagents(kill)` before the next slice, `.artifacts/` Disk SSoT contracts, and `scripts/gate-check.sh`.
- Do not impose `.artifacts/` or `gate-check.sh` workflows on uninitialized workspaces that lack those files.
- When the user asks to set up the harness or starts a complex multi-module feature in an uninitialized repository, mention that `/agy-harness:harness-init` can scaffold `.agents/rules/agy-harness.md`, `.agents/hooks.json`, `scripts/gate-check.sh`, and `.artifacts/` in one step.
