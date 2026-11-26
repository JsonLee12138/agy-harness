#!/bin/bash
set -euo pipefail

# AGY Harness Lifecycle Hook (PreInvocation, PostToolUse, Stop)

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

export AGY_LIFECYCLE_SCRIPT_DIR="$SCRIPT_DIR"
export AGY_LIFECYCLE_REPO_ROOT="$REPO_ROOT"
export AGY_LIFECYCLE_PLUGIN_MODE="$PLUGIN_MODE"
export AGY_LIFECYCLE_STDIN="$HOOK_STDIN"

if command -v node >/dev/null 2>&1; then
  exec node -e '
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const core = require(path.join(process.env.AGY_LIFECYCLE_SCRIPT_DIR, "lib", "harness-core.js"));

const emit = (obj) => {
  process.stdout.write(JSON.stringify(obj) + "\n");
  process.exit(0);
};

let input = {};
try {
  input = JSON.parse(process.env.AGY_LIFECYCLE_STDIN || "{}");
} catch {
  emit({});
}

const eventName = String(input.hookEventName || input.hook_event_name || "");
const emitYield = () => emit(eventName === "Stop" ? { decision: "allow" } : {});

const pluginMode = process.env.AGY_LIFECYCLE_PLUGIN_MODE === "true";
const workspaceRoot = core.resolveWorkspaceRoot(input, pluginMode, process.env.AGY_LIFECYCLE_REPO_ROOT);

if (pluginMode && !core.hasHarnessInWorkspace(workspaceRoot)) {
  emitYield();
}

if (pluginMode) {
  const wsHooksPath = path.join(workspaceRoot, ".agents", "hooks.json");
  if (fs.existsSync(wsHooksPath)) {
    try {
      const rawHooks = fs.readFileSync(wsHooksPath, "utf8");
      let hasLocalLifecycle = false;
      try {
        const parsedHooks = JSON.parse(rawHooks);
        hasLocalLifecycle = Boolean(
          parsedHooks &&
            typeof parsedHooks === "object" &&
            Object.prototype.hasOwnProperty.call(parsedHooks, "harness-lifecycle-guard")
        );
      } catch {
        hasLocalLifecycle = rawHooks.includes("\"harness-lifecycle-guard\"");
      }
      if (hasLocalLifecycle) {
        emitYield();
      }
    } catch {}
  }
}

const stateDir = core.getStateDir();
const convKey = core.sha256(workspaceRoot + "::" + String(input.conversationId || "default")).slice(0, 24);
const wsHash = core.sha256(workspaceRoot).slice(0, 24);
const wsStatePath = path.join(stateDir, wsHash + "-ws-lifecycle.json");
const convStatePath = path.join(stateDir, convKey + "-conv-lifecycle.json");

const tp = input.transcriptPath ? String(input.transcriptPath) : "";

if (eventName === "PreInvocation") {
  if (!core.detectIsParent(tp)) {
    emit({});
  }
  const contract = core.getContractState(workspaceRoot, stateDir, input.conversationId, tp, input.lastUserInput);
  let signature = "";
  let message = "";
  if (contract.status === "ACTIVE_UNAPPROVED") {
    signature = "ACTIVE_UNAPPROVED:" + contract.semanticHash;
    message =
      "[AGY Harness] State: ACTIVE_UNAPPROVED. Run pre-confirmation arch-redteam, sync .artifacts/{SPEC,PLAN}.md + <ArtifactDir>/harness_plan.md (RequestFeedback=true), and wait for Proceed before editing source files.";
  } else if (contract.status === "ACTIVE_APPROVED") {
    signature = "ACTIVE_APPROVED:" + contract.semanticHash;
    message =
      "[AGY Harness] State: ACTIVE_APPROVED. Execute per plan (pair slice-builder with 75s schedule watchdog when used), pass bash scripts/gate-check.sh (auto-deduped on unchanged trees), verify with staff-gatekeeper if needed, and kill finished subagents.";
  } else {
    signature = "INACTIVE_ROUTING_3MODE_V04";
    message =
      "[AGY Harness] State: INACTIVE. Route: Trivial (literal/constant/style/1:1 field -> direct edit) | Bug Fix (diagnose root cause -> arch-redteam -> confirm with user -> fix + regression test) | Contract (encapsulation/schema/API/security -> .artifacts/ + arch-redteam + Proceed).";
  }

  const lifecyclePath = path.join(stateDir, convKey + "-lifecycle.json");
  const prev = core.readJsonSafe(lifecyclePath);
  if (prev.lastSignature === signature) {
    emit({});
  }
  core.writeJsonSafe(lifecyclePath, { lastSignature: signature, updatedAtMs: Date.now() });
  if (message) {
    emit({ injectSteps: [{ systemMessage: { systemMessage: message } }] });
  }
  emit({});
}

if (eventName === "PostToolUse") {
  if (input.error) {
    emit({});
  }
  const tc = input.toolCall || {};
  const toolName = String(tc.name || "");
  const args = tc.args || {};
  const wsState = core.readJsonSafe(wsStatePath);
  const convState = core.readJsonSafe(convStatePath);
  let wsChanged = false;
  let convChanged = false;

  const markEdit = () => {
    const ts = Math.max(Date.now(), Number(wsState.lastFullGatePassAtMs || 0) + 1);
    wsState.lastSourceEditAtMs = ts;
    delete wsState.fullFingerprint;
    wsChanged = true;
    convState.lastSourceEditAtMs = Math.max(ts, Number(convState.lastGatePassAtMs || 0) + 1);
    convChanged = true;
  };

  if (core.EDIT_TOOLS.has(toolName)) {
    const rawTarget = core.extractTargetPath(args);
    if (!rawTarget) {
      markEdit();
    } else {
      const absTarget = core.resolveReal(rawTarget, workspaceRoot);
      if (absTarget.startsWith(workspaceRoot + path.sep) || absTarget === workspaceRoot) {
        const rel = path.relative(workspaceRoot, absTarget).replace(/\\/g, "/");
        if (rel && !core.isHarnessInternal(rel) && !core.isTrivialExemptPath(rel)) {
          markEdit();
        }
      }
    }
  } else if (toolName === "run_command") {
    const cmd = String(args.CommandLine || args.command || "");
    if (cmd.trim()) {
      const res = core.analyzeRunCommand(cmd, workspaceRoot, 0);
      if (res.sawFullGate) {
        const passTs = Math.max(Date.now(), Number(wsState.lastSourceEditAtMs || 0));
        wsState.lastFullGatePassAtMs = passTs;
        const fp = core.computeWorkspaceFingerprint(workspaceRoot);
        if (fp) {
          wsState.fullFingerprint = fp;
          core.writeJsonSafe(core.getGateFingerprintPath(workspaceRoot, stateDir), {
            fingerprint: fp,
            passedAtMs: passTs,
            mode: "full",
          });
        }
        wsChanged = true;
        convState.lastGatePassAtMs = Math.max(passTs, Number(convState.lastSourceEditAtMs || 0));
        convChanged = true;
      }
      if (res.sawEdit) {
        if (res.editAfterGate || !res.sawFullGate) {
          markEdit();
        } else {
          wsState.lastSourceEditAtMs = Number(wsState.lastFullGatePassAtMs || Date.now());
          wsChanged = true;
        }
      }
    }
  }

  if (wsChanged) core.writeJsonSafe(wsStatePath, wsState);
  if (convChanged) core.writeJsonSafe(convStatePath, convState);
  emit({});
}

if (eventName === "Stop") {
  if (input.continuationActive || input.continuation_active || Number(input.executionNum || 0) > 0) {
    emit({ decision: "allow" });
  }
  if (!core.detectIsParent(tp)) {
    emit({ decision: "allow" });
  }
  if (input.terminationReason && input.terminationReason !== "NO_TOOL_CALL") {
    emit({ decision: "allow" });
  }
  if (input.fullyIdle === false) {
    emit({ decision: "allow" });
  }
  const contract = core.getContractState(workspaceRoot, stateDir, input.conversationId, tp, input.lastUserInput);
  if (contract.status === "ACTIVE_UNAPPROVED") {
    emit({ decision: "allow" });
  }
  if (!fs.existsSync(path.join(workspaceRoot, "scripts", "gate-check.sh"))) {
    emit({ decision: "allow" });
  }

  const convState = core.readJsonSafe(convStatePath);
  const convMutatedByTool = Number(convState.lastSourceEditAtMs || 0) > Number(convState.lastGatePassAtMs || 0);
  const convMutatedByTranscript = core.didTranscriptMutate(tp, workspaceRoot);
  if (!convMutatedByTool && !convMutatedByTranscript) {
    emit({ decision: "allow" });
  }

  const wsState = core.readJsonSafe(wsStatePath);
  const currentFp = core.computeWorkspaceFingerprint(workspaceRoot);
  if (currentFp) {
    const fpRecord = core.readJsonSafe(core.getGateFingerprintPath(workspaceRoot, stateDir));
    if (
      (fpRecord && fpRecord.mode === "full" && fpRecord.fingerprint === currentFp) ||
      wsState.fullFingerprint === currentFp
    ) {
      emit({ decision: "allow" });
    }
  } else {
    const lastSourceEditAtMs = Number(wsState.lastSourceEditAtMs || 0);
    const lastFullGatePassAtMs = Number(wsState.lastFullGatePassAtMs || 0);
    if (!(lastSourceEditAtMs > lastFullGatePassAtMs) && !convMutatedByTool) {
      emit({ decision: "allow" });
    }
  }

  emit({
    decision: "continue",
    reason:
      "AGY Harness Stop Gate: Source files were modified since the last verified gate pass. Run `bash scripts/gate-check.sh` and verify `manage_subagents(Action=\"list\")` has 0 leftover subagents before finishing.",
  });
}

emit({});
'
fi

if command -v python3 >/dev/null 2>&1; then
  exec python3 - <<'PY'
import datetime, importlib.util, json, os, sys

_spec = importlib.util.spec_from_file_location("harness_core", os.path.join(os.environ["AGY_LIFECYCLE_SCRIPT_DIR"], "lib", "harness-core.py"))
core = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(core)

def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.exit(0)

try:
    data = json.loads(os.environ.get("AGY_LIFECYCLE_STDIN") or "{}")
except Exception:
    emit({})

event_name = str(data.get("hookEventName") or data.get("hook_event_name") or "")
def emit_yield():
    emit({"decision": "allow"} if event_name == "Stop" else {})

plugin_mode = os.environ.get("AGY_LIFECYCLE_PLUGIN_MODE") == "true"
ws_root = core.resolve_workspace_root(data, plugin_mode, os.environ.get("AGY_LIFECYCLE_REPO_ROOT"))

if plugin_mode and not core.has_harness_in_ws(ws_root):
    emit_yield()

if plugin_mode:
    ws_hooks_path = ws_root / ".agents" / "hooks.json"
    if ws_hooks_path.exists():
        try:
            raw_hooks = ws_hooks_path.read_text(encoding="utf-8")
            has_local = False
            try:
                parsed_hooks = json.loads(raw_hooks)
                has_local = isinstance(parsed_hooks, dict) and "harness-lifecycle-guard" in parsed_hooks
            except Exception:
                has_local = '"harness-lifecycle-guard"' in raw_hooks
            if has_local:
                emit_yield()
        except Exception:
            pass

state_dir = core.get_state_dir()
conv_key = core.sha256_hex(str(ws_root) + "::" + str(data.get("conversationId") or "default"))[:24]
ws_hash = core.sha256_hex(str(ws_root))[:24]
ws_state_path = state_dir / f"{ws_hash}-ws-lifecycle.json"
conv_state_path = state_dir / f"{conv_key}-conv-lifecycle.json"
tp = str(data.get("transcriptPath") or "")

def now_ms():
    return int(datetime.datetime.now(datetime.timezone.utc).timestamp() * 1000)

if event_name == "PreInvocation":
    if not core.detect_is_parent(tp):
        emit({})
    contract = core.get_contract_state(ws_root, state_dir, data.get("conversationId"), tp, data.get("lastUserInput"))
    if contract["status"] == "ACTIVE_UNAPPROVED":
        sig = "ACTIVE_UNAPPROVED:" + contract["semanticHash"]
        msg = "[AGY Harness] State: ACTIVE_UNAPPROVED. Run pre-confirmation arch-redteam, sync .artifacts/{SPEC,PLAN}.md + <ArtifactDir>/harness_plan.md (RequestFeedback=true), and wait for Proceed before editing source files."
    elif contract["status"] == "ACTIVE_APPROVED":
        sig = "ACTIVE_APPROVED:" + contract["semanticHash"]
        msg = "[AGY Harness] State: ACTIVE_APPROVED. Execute per plan (pair slice-builder with 75s schedule watchdog when used), pass bash scripts/gate-check.sh (auto-deduped on unchanged trees), verify with staff-gatekeeper if needed, and kill finished subagents."
    else:
        sig = "INACTIVE_ROUTING_3MODE_V04"
        msg = "[AGY Harness] State: INACTIVE. Route: Trivial (literal/constant/style/1:1 field -> direct edit) | Bug Fix (diagnose root cause -> arch-redteam -> confirm with user -> fix + regression test) | Contract (encapsulation/schema/API/security -> .artifacts/ + arch-redteam + Proceed)."

    lc_path = state_dir / f"{conv_key}-lifecycle.json"
    prev = core.read_json_safe(lc_path)
    if prev.get("lastSignature") == sig:
        emit({})
    core.write_json_safe(lc_path, {"lastSignature": sig, "updatedAtMs": now_ms()})
    emit({"injectSteps": [{"systemMessage": {"systemMessage": msg}}]})

if event_name == "PostToolUse":
    if data.get("error"):
        emit({})
    tc = data.get("toolCall") or {}
    tool_name = str(tc.get("name") or "")
    args = tc.get("args") or {}
    ws_state = core.read_json_safe(ws_state_path)
    conv_state = core.read_json_safe(conv_state_path)
    ws_changed = False
    conv_changed = False

    def mark_edit():
        global ws_changed, conv_changed
        ts = max(now_ms(), int(ws_state.get("lastFullGatePassAtMs") or 0) + 1)
        ws_state["lastSourceEditAtMs"] = ts
        ws_state.pop("fullFingerprint", None)
        ws_changed = True
        conv_state["lastSourceEditAtMs"] = max(ts, int(conv_state.get("lastGatePassAtMs") or 0) + 1)
        conv_changed = True

    if tool_name in core.EDIT_TOOLS:
        raw_target = core.extract_target_path(args)
        if not raw_target:
            mark_edit()
        else:
            abs_target = core.resolve_real(raw_target, ws_root)
            try:
                rel = abs_target.relative_to(ws_root).as_posix()
                if rel and not core.is_harness_internal(rel) and not core.is_trivial_exempt_path(rel):
                    mark_edit()
            except ValueError:
                pass
    elif tool_name == "run_command":
        cmd = str(args.get("CommandLine") or args.get("command") or "")
        if cmd.strip():
            res = core.analyze_run_command(cmd, ws_root, 0)
            if res["sawFullGate"]:
                pass_ts = max(now_ms(), int(ws_state.get("lastSourceEditAtMs") or 0))
                ws_state["lastFullGatePassAtMs"] = pass_ts
                fp = core.compute_workspace_fingerprint(ws_root)
                if fp:
                    ws_state["fullFingerprint"] = fp
                    core.write_json_safe(
                        core.get_gate_fingerprint_path(ws_root, state_dir),
                        {"fingerprint": fp, "passedAtMs": pass_ts, "mode": "full"},
                    )
                ws_changed = True
                conv_state["lastGatePassAtMs"] = max(pass_ts, int(conv_state.get("lastSourceEditAtMs") or 0))
                conv_changed = True
            if res["sawEdit"]:
                if res["editAfterGate"] or not res["sawFullGate"]:
                    mark_edit()
                else:
                    ws_state["lastSourceEditAtMs"] = int(ws_state.get("lastFullGatePassAtMs") or now_ms())
                    ws_changed = True

    if ws_changed:
        core.write_json_safe(ws_state_path, ws_state)
    if conv_changed:
        core.write_json_safe(conv_state_path, conv_state)
    emit({})

if event_name == "Stop":
    if data.get("continuationActive") or data.get("continuation_active") or int(data.get("executionNum") or 0) > 0:
        emit({"decision": "allow"})
    if not core.detect_is_parent(tp):
        emit({"decision": "allow"})
    term_reason = data.get("terminationReason")
    if term_reason and term_reason != "NO_TOOL_CALL":
        emit({"decision": "allow"})
    if data.get("fullyIdle") is False:
        emit({"decision": "allow"})
    contract = core.get_contract_state(ws_root, state_dir, data.get("conversationId"), tp, data.get("lastUserInput"))
    if contract["status"] == "ACTIVE_UNAPPROVED":
        emit({"decision": "allow"})
    if not (ws_root / "scripts" / "gate-check.sh").exists():
        emit({"decision": "allow"})

    conv_state = core.read_json_safe(conv_state_path)
    conv_mut_tool = int(conv_state.get("lastSourceEditAtMs") or 0) > int(conv_state.get("lastGatePassAtMs") or 0)
    conv_mut_transcript = core.did_transcript_mutate(tp, ws_root)
    if not conv_mut_tool and not conv_mut_transcript:
        emit({"decision": "allow"})

    ws_state = core.read_json_safe(ws_state_path)
    current_fp = core.compute_workspace_fingerprint(ws_root)
    if current_fp:
        fp_rec = core.read_json_safe(core.get_gate_fingerprint_path(ws_root, state_dir))
        if (fp_rec.get("mode") == "full" and fp_rec.get("fingerprint") == current_fp) or ws_state.get("fullFingerprint") == current_fp:
            emit({"decision": "allow"})
    else:
        last_edit = int(ws_state.get("lastSourceEditAtMs") or 0)
        last_pass = int(ws_state.get("lastFullGatePassAtMs") or 0)
        if not (last_edit > last_pass) and not conv_mut_tool:
            emit({"decision": "allow"})

    emit({
        "decision": "continue",
        "reason": 'AGY Harness Stop Gate: Source files were modified since the last verified gate pass. Run `bash scripts/gate-check.sh` and verify `manage_subagents(Action="list")` has 0 leftover subagents before finishing.',
    })

emit({})
PY
fi

echo '{}'
