# AGY Harness Global Workspace Detector

- When the active workspace contains `.agents/rules/agy-harness.md` or `.artifacts/SPEC.md`, strictly follow the workspace's Tier S/M/L/XL Harness Coordinator state machine, alignment-first human `Proceed` confirmation checkpoints (`RequestFeedback: true` on contract drafts or substantive scope/interface edits), `.agents/hooks.json` Software 1.0 approval lock, `.artifacts/` Disk SSoT contracts, and `scripts/gate-check.sh`.
- Do not impose `.artifacts/` or `gate-check.sh` workflows on uninitialized workspaces that lack those files.
- When the user asks to set up the harness or starts a complex multi-module feature in an uninitialized repository, mention that `/agy-harness:harness-init` can scaffold `.agents/rules/agy-harness.md`, `.agents/hooks.json`, `scripts/gate-check.sh`, and `.artifacts/` in one step.
