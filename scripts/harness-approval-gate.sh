#!/bin/bash
# harness-approval-gate.sh — Antigravity PreToolUse Software 1.0 Gate
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PLUGIN_MODE="false"
for arg in "$@"; do
  case "$arg" in
    --plugin-mode)
      PLUGIN_MODE="true"
      ;;
  esac
done

if [ -t 0 ]; then
  HOOK_STDIN="{}"
else
  HOOK_STDIN="$(cat || true)"
  [ -z "$HOOK_STDIN" ] && HOOK_STDIN="{}"
fi

export AGY_HARNESS_SCRIPT_DIR="$SCRIPT_DIR"
export AGY_HARNESS_SCRIPT_REPO_ROOT="$SCRIPT_REPO_ROOT"
export AGY_HARNESS_PLUGIN_MODE="$PLUGIN_MODE"
export AGY_HARNESS_HOOK_STDIN="$HOOK_STDIN"

if command -v node >/dev/null 2>&1; then
  exec node -e '
"use strict";
const path = require("node:path");
const core = require(path.join(process.env.AGY_HARNESS_SCRIPT_DIR, "lib", "harness-core.js"));

const emit = (decision, reason) => {
  const out = reason ? { decision, reason } : { decision };
  process.stdout.write(JSON.stringify(out) + "\n");
  process.exit(0);
};

let input = {};
try {
  input = JSON.parse(process.env.AGY_HARNESS_HOOK_STDIN || "{}");
} catch {
  emit("allow");
}

const pluginMode = process.env.AGY_HARNESS_PLUGIN_MODE === "true";
const workspaceRoot = core.resolveWorkspaceRoot(input, pluginMode, process.env.AGY_HARNESS_SCRIPT_REPO_ROOT);

if (pluginMode && !core.hasHarnessInWorkspace(workspaceRoot)) {
  emit("allow");
}

const toolCall = input.toolCall || {};
const toolName = String(toolCall.name || "");
const args = toolCall.args || {};

const subagentType = String(args.TypeName || args.typeName || args.subagent_type || "").trim();
const isExitPlanMode = toolName === "exit_plan_mode";
const isAllowlistedSubagent = toolName === "invoke_subagent" && core.READ_ONLY_SUBAGENTS.has(subagentType);
const isGatedSubagent = toolName === "invoke_subagent" && !core.READ_ONLY_SUBAGENTS.has(subagentType);
const isGatedDefine = toolName === "define_subagent" && args.EnableWriteTools === true;
const isGatedSwarm = toolName === "swarm" && String(args.action || "").trim() === "add";
const isGatedWorkflow = toolName === "run_workflow";
const isGated = isGatedSubagent || isGatedDefine || isGatedSwarm || isGatedWorkflow;

if (!isGated && !isExitPlanMode && !isAllowlistedSubagent) {
  emit("allow");
}

const stateDir = core.getStateDir();
const contract = core.getContractState(
  workspaceRoot,
  stateDir,
  input.conversationId,
  input.transcriptPath ? String(input.transcriptPath) : "",
  input.lastUserInput
);

if (isAllowlistedSubagent) {
  if (contract.isApprovedViaTurn && !contract.isApprovedViaState) {
    contract.saveApprovedState();
  }
  emit("allow");
}

if (isExitPlanMode) {
  const planText = String(args.plan || args.Plan || args.planContent || "");
  if (contract.status !== "INACTIVE") {
    if (contract.isApprovedViaState || contract.isApprovedViaTurn) {
      if (contract.isApprovedViaTurn && !contract.isApprovedViaState) {
        contract.saveApprovedState();
      }
      emit("allow");
    }
    const hasPhase1Stop =
      /(?:\.artifacts[\\/](?:SPEC|PLAN)\.md|harness_plan\.md|RequestFeedback)/i.test(planText) &&
      /(?:Phase\s*1|contract[- ]only|stop(?:\s+your|\s+the)?\s+turn|wait\s+for[\s\S]{0,40}?(?:Proceed|approval|confirm)|await[\s\S]{0,40}?(?:Proceed|approval|confirm)|停轮|等待[\s\S]{0,20}?(?:确认|Proceed)|仅起草契约)/i.test(
        planText
      );
    if (
      contract.isUnapprovedArtifactComment ||
      (!hasPhase1Stop && /\b(?:slice-builder|swarm|run_workflow|edit_file|write_file|create_file)\b/i.test(planText))
    ) {
      emit(
        "force_ask",
        "AGY Harness: Active .artifacts/SPEC.md and .artifacts/PLAN.md are not yet approved by the user. Confirm proceeding with this plan?"
      );
    }
    emit("allow");
  } else {
    const mentionsWriteSubagent = /\b(?:slice-builder|swarm)\b/i.test(planText);
    const hasPhase1Stop =
      /(?:\.artifacts[\\/](?:SPEC|PLAN)\.md|harness_plan\.md|RequestFeedback)/i.test(planText) &&
      /(?:Phase\s*1|contract[- ]only|stop(?:\s+your|\s+the)?\s+turn|wait\s+for[\s\S]{0,40}?(?:Proceed|approval|confirm)|await[\s\S]{0,40}?(?:Proceed|approval|confirm)|停轮|等待[\s\S]{0,20}?(?:确认|Proceed)|仅起草契约)/i.test(
        planText
      );
    if (mentionsWriteSubagent && !hasPhase1Stop) {
      emit(
        "force_ask",
        "AGY Harness: Plan invokes slice-builder/swarm without an active approved contract. Draft .artifacts/{SPEC,PLAN}.md and wait for Proceed first, or confirm continuing?"
      );
    }
    emit("allow");
  }
}

if (!contract.specExists || !contract.planExists) {
  emit(
    "deny",
    "BLOCKED by AGY Harness Approval Gate: .artifacts/SPEC.md and .artifacts/PLAN.md must both exist and be approved by the user before invoking gated subagents or workflows."
  );
}

if (contract.isPaused) {
  emit(
    "deny",
    "BLOCKED by AGY Harness Approval Gate: Current contract is PAUSED (HARNESS_STATUS: PAUSED). Resume the contract or draft a new one before invoking gated subagents or workflows."
  );
}

if (contract.hasTemplatePlaceholder) {
  emit(
    "deny",
    "BLOCKED by AGY Harness Approval Gate: .artifacts/SPEC.md or .artifacts/PLAN.md still contains unfilled template placeholders. Draft the contract, run pre-confirmation arch-redteam, sync <ArtifactDir>/harness_plan.md with ArtifactMetadata.RequestFeedback=true, stop your turn, and wait for the user to click Proceed."
  );
}

if (contract.isArchived) {
  emit(
    "deny",
    "BLOCKED by AGY Harness Approval Gate: Current .artifacts/SPEC.md and .artifacts/PLAN.md are archived or completed. Draft a new contract and obtain user approval before invoking gated subagents or workflows."
  );
}

if (contract.isUnapprovedArtifactComment) {
  emit(
    "deny",
    "BLOCKED by AGY Harness Approval Gate: The user commented on the review artifact without approving it. Revise .artifacts/SPEC.md or .artifacts/PLAN.md as requested, update <ArtifactDir>/harness_plan.md with RequestFeedback=true, end your turn, and wait for user approval."
  );
}

if (contract.isApprovedViaState) {
  emit("allow");
}

if (contract.isModifiedAfterUser) {
  emit(
    "deny",
    "BLOCKED by AGY Harness Approval Gate: .artifacts/SPEC.md or .artifacts/PLAN.md was created or substantively modified after the last user confirmation. Run pre-confirmation arch-redteam if needed, sync <ArtifactDir>/harness_plan.md with ArtifactMetadata.RequestFeedback=true, stop calling tools to end your turn, and wait for the user to click Proceed."
  );
}

if (!contract.isApprovedViaTurn) {
  emit(
    "force_ask",
    "AGY Harness: Confirm starting implementation against current .artifacts/SPEC.md and .artifacts/PLAN.md?"
  );
}

contract.saveApprovedState();
emit("allow");
'
fi

if command -v python3 >/dev/null 2>&1; then
  exec python3 - <<'PY'
import importlib.util, json, os, re, sys

_spec = importlib.util.spec_from_file_location("harness_core", os.path.join(os.environ["AGY_HARNESS_SCRIPT_DIR"], "lib", "harness-core.py"))
core = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(core)

def emit(decision, reason=None):
    out = {"decision": decision}
    if reason:
        out["reason"] = reason
    sys.stdout.write(json.dumps(out, ensure_ascii=False) + "\n")
    sys.exit(0)

try:
    data = json.loads(os.environ.get("AGY_HARNESS_HOOK_STDIN") or "{}")
except Exception:
    emit("allow")

plugin_mode = os.environ.get("AGY_HARNESS_PLUGIN_MODE") == "true"
ws_root = core.resolve_workspace_root(data, plugin_mode, os.environ.get("AGY_HARNESS_SCRIPT_REPO_ROOT"))

if plugin_mode and not core.has_harness_in_ws(ws_root):
    emit("allow")

tc = data.get("toolCall") or {}
tool_name = str(tc.get("name") or "")
args = tc.get("args") or {}

subagent_type = str(args.get("TypeName") or args.get("typeName") or args.get("subagent_type") or "").strip()
is_exit_plan_mode = tool_name == "exit_plan_mode"
is_allowlisted_sub = tool_name == "invoke_subagent" and subagent_type in core.READ_ONLY_SUBAGENTS
is_sub = tool_name == "invoke_subagent" and subagent_type not in core.READ_ONLY_SUBAGENTS
is_def = tool_name == "define_subagent" and args.get("EnableWriteTools") is True
is_swm = tool_name == "swarm" and str(args.get("action") or "").strip() == "add"
is_wf = tool_name == "run_workflow"
is_gated = is_sub or is_def or is_swm or is_wf

if not is_gated and not is_exit_plan_mode and not is_allowlisted_sub:
    emit("allow")

state_dir = core.get_state_dir()
contract = core.get_contract_state(
    ws_root,
    state_dir,
    data.get("conversationId"),
    str(data.get("transcriptPath") or ""),
    data.get("lastUserInput"),
)

if is_allowlisted_sub:
    if contract["isApprovedViaTurn"] and not contract["isApprovedViaState"]:
        contract["saveApprovedState"]()
    emit("allow")

if is_exit_plan_mode:
    plan_text = str(args.get("plan") or args.get("Plan") or args.get("planContent") or "")
    if contract["status"] != "INACTIVE":
        if contract["isApprovedViaState"] or contract["isApprovedViaTurn"]:
            if contract["isApprovedViaTurn"] and not contract["isApprovedViaState"]:
                contract["saveApprovedState"]()
            emit("allow")
        has_phase1_stop = bool(
            re.search(r"(?:\.artifacts[\\/](?:SPEC|PLAN)\.md|harness_plan\.md|RequestFeedback)", plan_text, re.IGNORECASE)
            and re.search(
                r"(?:Phase\s*1|contract[- ]only|stop(?:\s+your|\s+the)?\s+turn|wait\s+for[\s\S]{0,40}?(?:Proceed|approval|confirm)|await[\s\S]{0,40}?(?:Proceed|approval|confirm)|停轮|等待[\s\S]{0,20}?(?:确认|Proceed)|仅起草契约)",
                plan_text,
                re.IGNORECASE,
            )
        )
        if contract["isUnapprovedArtifactComment"] or (
            not has_phase1_stop and re.search(r"\b(?:slice-builder|swarm|run_workflow|edit_file|write_file|create_file)\b", plan_text, re.IGNORECASE)
        ):
            emit("force_ask", "AGY Harness: Active .artifacts/SPEC.md and .artifacts/PLAN.md are not yet approved by the user. Confirm proceeding with this plan?")
        emit("allow")
    else:
        mentions_write_subagent = bool(re.search(r"\b(?:slice-builder|swarm)\b", plan_text, re.IGNORECASE))
        has_phase1_stop = bool(
            re.search(r"(?:\.artifacts[\\/](?:SPEC|PLAN)\.md|harness_plan\.md|RequestFeedback)", plan_text, re.IGNORECASE)
            and re.search(
                r"(?:Phase\s*1|contract[- ]only|stop(?:\s+your|\s+the)?\s+turn|wait\s+for[\s\S]{0,40}?(?:Proceed|approval|confirm)|await[\s\S]{0,40}?(?:Proceed|approval|confirm)|停轮|等待[\s\S]{0,20}?(?:确认|Proceed)|仅起草契约)",
                plan_text,
                re.IGNORECASE,
            )
        )
        if mentions_write_subagent and not has_phase1_stop:
            emit("force_ask", "AGY Harness: Plan invokes slice-builder/swarm without an active approved contract. Draft .artifacts/{SPEC,PLAN}.md and wait for Proceed first, or confirm continuing?")
        emit("allow")

if not contract["specExists"] or not contract["planExists"]:
    emit("deny", "BLOCKED by AGY Harness Approval Gate: .artifacts/SPEC.md and .artifacts/PLAN.md must both exist and be approved by the user before invoking gated subagents or workflows.")

if contract["isPaused"]:
    emit("deny", "BLOCKED by AGY Harness Approval Gate: Current contract is PAUSED (HARNESS_STATUS: PAUSED). Resume the contract or draft a new one before invoking gated subagents or workflows.")

if contract["hasTemplatePlaceholder"]:
    emit("deny", "BLOCKED by AGY Harness Approval Gate: .artifacts/SPEC.md or .artifacts/PLAN.md still contains unfilled template placeholders. Draft the contract, run pre-confirmation arch-redteam, sync <ArtifactDir>/harness_plan.md with ArtifactMetadata.RequestFeedback=true, stop your turn, and wait for the user to click Proceed.")

if contract["isArchived"]:
    emit("deny", "BLOCKED by AGY Harness Approval Gate: Current .artifacts/SPEC.md and .artifacts/PLAN.md are archived or completed. Draft a new contract and obtain user approval before invoking gated subagents or workflows.")

if contract["isUnapprovedArtifactComment"]:
    emit("deny", "BLOCKED by AGY Harness Approval Gate: The user commented on the review artifact without approving it. Revise .artifacts/SPEC.md or .artifacts/PLAN.md as requested, update <ArtifactDir>/harness_plan.md with RequestFeedback=true, end your turn, and wait for user approval.")

if contract["isApprovedViaState"]:
    emit("allow")

if contract["isModifiedAfterUser"]:
    emit("deny", "BLOCKED by AGY Harness Approval Gate: .artifacts/SPEC.md or .artifacts/PLAN.md was created or substantively modified after the last user confirmation. Run pre-confirmation arch-redteam if needed, sync <ArtifactDir>/harness_plan.md with ArtifactMetadata.RequestFeedback=true, stop calling tools to end your turn, and wait for the user to click Proceed.")

if not contract["isApprovedViaTurn"]:
    emit("force_ask", "AGY Harness: Confirm starting implementation against current .artifacts/SPEC.md and .artifacts/PLAN.md?")

contract["saveApprovedState"]()
emit("allow")
PY
fi

echo '{"decision":"force_ask","reason":"AGY Harness: Confirm starting implementation against current .artifacts/SPEC.md and .artifacts/PLAN.md?"}'
