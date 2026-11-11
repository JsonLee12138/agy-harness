# Implementation Plan & Vertical Slices (PLAN)

> Ordered vertical slices executed by `slice-builder`. For Tier XL parallel execution, each concurrent slice MUST own a disjoint file subtree.

## Slice 1: [Title]
- **Owned files / subtree:** _e.g. `src/feature/*`, `tests/feature/*`_
- **Dependencies:** None
- **Acceptance criteria:** _Refs AC-1_
- **Verification:** `bash scripts/gate-check.sh`
- **Status:** `[ ] Pending`
