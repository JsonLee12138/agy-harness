#!/bin/bash
set -euo pipefail

# AGY Harness Software 1.0 PreToolUse Parent Source-Edit Guard.
# - INACTIVE / PAUSED / ARCHIVED / DONE: allows parent direct edits.
# - ACTIVE_UNAPPROVED: blocks parent edits & shell write bypasses until user Proceed.
# - ACTIVE_APPROVED: allows warm-cache parent edits unless PLAN.md declares
#   <!-- HARNESS_EXECUTION: SUBAGENT_ONLY -->.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

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

export AGY_GUARD_SCRIPT_DIR="$SCRIPT_DIR"
export AGY_GUARD_REPO_ROOT="$REPO_ROOT"
export AGY_GUARD_PLUGIN_MODE="$PLUGIN_MODE"
export AGY_GUARD_STDIN="$HOOK_STDIN"

if command -v node >/dev/null 2>&1; then
  exec node -e '
"use strict";
const path = require("node:path");
const core = require(path.join(process.env.AGY_GUARD_SCRIPT_DIR, "lib", "harness-core.js"));

const emit = (decision, reason) => {
  process.stdout.write(JSON.stringify(reason ? { decision, reason } : { decision }) + "\n");
  process.exit(0);
};

let input = {};
try {
  input = JSON.parse(process.env.AGY_GUARD_STDIN || "{}");
} catch {
  emit("allow");
}

const pluginMode = process.env.AGY_GUARD_PLUGIN_MODE === "true";
const repoRoot = core.resolveWorkspaceRoot(input, pluginMode, process.env.AGY_GUARD_REPO_ROOT);

if (pluginMode && !core.hasHarnessInWorkspace(repoRoot)) {
  emit("allow");
}

const tc = input.toolCall || {};
const toolName = String(tc.name || "");
const args = tc.args || {};

const isEditTool = core.EDIT_TOOLS.has(toolName);
const isRunCommand = toolName === "run_command";

if (!isEditTool && !isRunCommand) {
  emit("allow");
}

let rawTarget = "";
let rel = "";
if (isEditTool) {
  rawTarget = core.extractTargetPath(args);
  if (rawTarget) {
    const absTarget = core.resolveReal(rawTarget, repoRoot);
    if (!absTarget.startsWith(repoRoot + path.sep)) {
      emit("allow");
    }
    rel = path.relative(repoRoot, absTarget).replace(/\\/g, "/");
    if (!rel || core.isHarnessInternal(rel)) {
      emit("allow");
    }
  }
}

const tp = input.transcriptPath ? String(input.transcriptPath) : "";
if (!core.detectIsParent(tp)) {
  emit("allow");
}

const contract = core.getContractState(
  repoRoot,
  core.getStateDir(),
  input.conversationId,
  tp,
  input.lastUserInput
);

if (contract.status === "INACTIVE") {
  emit("allow");
}

if (contract.status === "ACTIVE_APPROVED" && !contract.subagentOnly) {
  emit("allow");
}

const modeReason =
  contract.status === "ACTIVE_UNAPPROVED"
    ? "Unapproved contract in .artifacts/SPEC.md or .artifacts/PLAN.md. Wait for user Proceed/confirmation before editing source files."
    : "PLAN.md enforces SUBAGENT_ONLY parallel isolation. Delegate source/test edits to `slice-builder`.";

if (isEditTool) {
  if (!rawTarget) {
    emit(
      "force_ask",
      "AGY Harness Source-Edit Guard: Edit tool `" +
        toolName +
        "` has no recognizable target path while a contract is locked. Confirm allowing this edit?"
    );
  }
  emit(
    "deny",
    "BLOCKED by AGY Harness Source-Edit Guard: Cannot directly edit `" + rel + "`. " + modeReason
  );
}

const cmd = String(args.CommandLine || args.command || "");
if (!cmd.trim()) {
  emit("allow");
}

const bypass = core.detectShellWriteBypass(cmd, repoRoot);
if (!bypass.matched) {
  emit("allow");
}

const detail = bypass.summaries[0] || "shell write";
emit(
  "deny",
  "BLOCKED by AGY Harness Source-Edit Guard: Cannot bypass via `run_command` (" + detail + "). " + modeReason
);
'
fi

if command -v python3 >/dev/null 2>&1; then
  exec python3 - <<'PY'
import importlib.util, json, os, sys

_spec = importlib.util.spec_from_file_location("harness_core", os.path.join(os.environ["AGY_GUARD_SCRIPT_DIR"], "lib", "harness-core.py"))
core = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(core)

def emit(decision, reason=None):
    out = {"decision": decision}
    if reason:
        out["reason"] = reason
    sys.stdout.write(json.dumps(out, ensure_ascii=False) + "\n")
    sys.exit(0)

try:
    data = json.loads(os.environ.get("AGY_GUARD_STDIN") or "{}")
except Exception:
    emit("allow")

plugin_mode = os.environ.get("AGY_GUARD_PLUGIN_MODE") == "true"
repo_root = core.resolve_workspace_root(data, plugin_mode, os.environ.get("AGY_GUARD_REPO_ROOT"))

if plugin_mode and not core.has_harness_in_ws(repo_root):
    emit("allow")

tc = data.get("toolCall") or {}
tool_name = str(tc.get("name") or "")
args = tc.get("args") or {}

is_edit_tool = tool_name in core.EDIT_TOOLS
is_run_command = tool_name == "run_command"

if not is_edit_tool and not is_run_command:
    emit("allow")

raw_target = ""
rel = ""
if is_edit_tool:
    raw_target = core.extract_target_path(args)
    if raw_target:
        abs_target = core.resolve_real(raw_target, repo_root)
        try:
            rel = abs_target.relative_to(repo_root).as_posix()
        except ValueError:
            emit("allow")
        if not rel or core.is_harness_internal(rel):
            emit("allow")

tp = str(data.get("transcriptPath") or "")
if not core.detect_is_parent(tp):
    emit("allow")

contract = core.get_contract_state(
    repo_root,
    core.get_state_dir(),
    data.get("conversationId"),
    tp,
    data.get("lastUserInput"),
)

if contract["status"] == "INACTIVE":
    emit("allow")

if contract["status"] == "ACTIVE_APPROVED" and not contract["subagentOnly"]:
    emit("allow")

mode_reason = (
    "Unapproved contract in .artifacts/SPEC.md or .artifacts/PLAN.md. Wait for user Proceed/confirmation before editing source files."
    if contract["status"] == "ACTIVE_UNAPPROVED"
    else "PLAN.md enforces SUBAGENT_ONLY parallel isolation. Delegate source/test edits to `slice-builder`."
)

if is_edit_tool:
    if not raw_target:
        emit("force_ask", f"AGY Harness Source-Edit Guard: Edit tool `{tool_name}` has no recognizable target path while a contract is locked. Confirm allowing this edit?")
    emit("deny", f"BLOCKED by AGY Harness Source-Edit Guard: Cannot directly edit `{rel}`. {mode_reason}")

cmd = str(args.get("CommandLine") or args.get("command") or "")
if not cmd.strip():
    emit("allow")

bypass = core.detect_shell_write_bypass(cmd, repo_root)
if not bypass["matched"]:
    emit("allow")

detail = bypass["summaries"][0] if bypass["summaries"] else "shell write"
emit("deny", f"BLOCKED by AGY Harness Source-Edit Guard: Cannot bypass via `run_command` ({detail}). {mode_reason}")
PY
fi

echo '{"decision":"allow"}'
