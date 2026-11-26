# AGY Harness Global Workspace Detector

- **Zero-intrusion on uninitialized repos**: Do not impose `.artifacts/`, `gate-check.sh`, or `--plugin-mode` hooks on uninitialized workspaces lacking `.agents/rules/agy-harness.md` and `.artifacts/{SPEC,PLAN}.md`. Suggest `/agy-harness:harness-init` when setup is requested.
- **Initialized workspace (3-Mode Adaptive Routing)**: Follow `.agents/rules/agy-harness.md`:
  - **Trivial**: Literal/constant/style/copy/1:1 field pass-through (zero logic/encapsulation change) -> direct warm-cache edit + fast check.
  - **Bug Fix**: Non-literal defects -> read-only root-cause diagnosis -> pre-confirmation `arch-redteam` -> user confirms **[Root Cause + Proposal]** -> fix + regression test + `gate-check.sh`.
  - **Contract**: Encapsulation/schema/API/high-risk security -> `.artifacts/{SPEC,PLAN}.md` + pre-confirmation `arch-redteam` -> `Proceed` -> build (75s watchdog on `slice-builder`) + deduped `gate-check.sh` + `staff-gatekeeper`.
