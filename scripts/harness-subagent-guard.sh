#!/bin/bash
set -euo pipefail

# AGY Harness Subagent PreToolUse Guard.
# - slice-builder: locks .artifacts/{SPEC,CONSTRAINTS,PLAN}.md (and .agents/* &
#   scripts/harness-*.sh outside self-hosting); blocks IsDaemon=true and container/
#   install/watch/streaming/interactive commands; clamps WaitMsBeforeAsync > 10000
#   to 10000 and auto-injects NotificationTimeoutSeconds=45 via overwrite.
# - staff-gatekeeper: read-only + short read-only checks with anti-hang overwrite.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

ROLE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --role=*)
      ROLE="${1#--role=}"
      shift
      ;;
    --role)
      ROLE="${2:-}"
      shift 2 || break
      ;;
    *)
      shift
      ;;
  esac
done

if [ -t 0 ]; then
  HOOK_STDIN="{}"
else
  HOOK_STDIN="$(cat || true)"
  [ -z "$HOOK_STDIN" ] && HOOK_STDIN="{}"
fi

export AGY_SUBAGENT_SCRIPT_DIR="$SCRIPT_DIR"
export AGY_SUBAGENT_REPO_ROOT="$REPO_ROOT"
export AGY_SUBAGENT_ROLE="$ROLE"
export AGY_SUBAGENT_STDIN="$HOOK_STDIN"

if command -v node >/dev/null 2>&1; then
  exec node -e '
"use strict";
const path = require("node:path");
const core = require(path.join(process.env.AGY_SUBAGENT_SCRIPT_DIR, "lib", "harness-core.js"));

const emit = (decision, reason, overwrite) => {
  const out = { decision };
  if (reason) out.reason = reason;
  if (overwrite && Object.keys(overwrite).length > 0) out.overwrite = overwrite;
  process.stdout.write(JSON.stringify(out) + "\n");
  process.exit(0);
};

let input = {};
try {
  input = JSON.parse(process.env.AGY_SUBAGENT_STDIN || "{}");
} catch {
  emit("allow");
}

const role = String(process.env.AGY_SUBAGENT_ROLE || "").trim();
if (role !== "slice-builder" && role !== "staff-gatekeeper") {
  emit("allow");
}

const workspaceRoot = core.resolveWorkspaceRoot(input, false, process.env.AGY_SUBAGENT_REPO_ROOT);
const isSelfHosting = core.isSelfHostingRepo(workspaceRoot);

const tc = input.toolCall || {};
const toolName = String(tc.name || "");
const args = tc.args || {};

const isForbiddenForBuilder = (relPath) => {
  if (!relPath) return "";
  if (core.LOCKED_CONTRACTS.has(relPath)) return "contract";
  if (
    !isSelfHosting &&
    (relPath === ".agents" ||
      relPath.startsWith(".agents/") ||
      /^scripts\/harness-[^/]*\.sh$/.test(relPath))
  ) {
    return "harness";
  }
  return "";
};

const resolveWorkspaceRel = (rawPath) => {
  const cleaned = String(rawPath || "").trim().replace(/^[\x27"]|[\x27"]$/g, "");
  if (!cleaned || cleaned === "/dev/null" || cleaned.startsWith("$") || cleaned.startsWith("~")) {
    return { inside: false, rel: "" };
  }
  const abs = core.resolveReal(cleaned, workspaceRoot);
  if (!abs.startsWith(workspaceRoot + path.sep) && abs !== workspaceRoot) {
    return { inside: false, rel: "" };
  }
  const rel = path.relative(workspaceRoot, abs).replace(/\\/g, "/");
  return { inside: true, rel };
};

if (core.EDIT_TOOLS.has(toolName)) {
  if (role === "staff-gatekeeper") {
    emit(
      "deny",
      "BLOCKED by AGY Subagent Guard (staff-gatekeeper): staff-gatekeeper is strictly read-only and cannot execute `" +
        toolName +
        "`."
    );
  }
  const rawTarget = core.extractTargetPath(args);
  if (!rawTarget) emit("allow");
  const info = resolveWorkspaceRel(rawTarget);
  if (!info.inside) emit("allow");
  const kind = isForbiddenForBuilder(info.rel);
  if (kind === "contract") {
    emit(
      "deny",
      "BLOCKED by AGY Subagent Guard (slice-builder): Locked contract `" +
        info.rel +
        "` is read-only for slice-builder. Report contract gaps to the parent coordinator instead."
    );
  }
  if (kind === "harness") {
    emit(
      "deny",
      "BLOCKED by AGY Subagent Guard (slice-builder): Harness control file `" +
        info.rel +
        "` cannot be modified by slice-builder in target workspaces."
    );
  }
  emit("allow");
}

if (toolName !== "run_command") {
  emit("allow");
}

if (args.IsDaemon === true) {
  emit(
    "deny",
    "BLOCKED by AGY Subagent Guard (" +
      role +
      "): IsDaemon=true is forbidden. Stop and emit ## [HOST_CMD_REQUEST] to delegate background/daemon commands."
  );
}

const cmdLine = String(args.CommandLine || args.command || "");
if (cmdLine.trim()) {
  const blacklisted = core.detectBlacklistedCommand(cmdLine, 0);
  if (blacklisted) {
    emit(
      "deny",
      "BLOCKED by AGY Subagent Guard (" +
        role +
        "): Blacklisted command `" +
        blacklisted +
        "`. Stop and emit ## [HOST_CMD_REQUEST] to delegate container, install, watch/streaming, or interactive commands to the parent coordinator."
    );
  }

  const mutations = core.inspectShellMutations(cmdLine, 0);
  if (role === "staff-gatekeeper") {
    if (mutations.mutatingOps.length > 0 || mutations.writes.length > 0) {
      const op = mutations.mutatingOps[0] || (mutations.writes[0] && mutations.writes[0].op) || "write";
      emit(
        "deny",
        "BLOCKED by AGY Subagent Guard (staff-gatekeeper): Mutating command (`" +
          op +
          "`) is forbidden. staff-gatekeeper may only execute short read-only checks; delegate mutating or heavy checks via ## [HOST_CMD_REQUEST]."
      );
    }
  } else {
    for (const w of mutations.writes) {
      const info = resolveWorkspaceRel(w.raw);
      if (!info.inside) continue;
      const kind = isForbiddenForBuilder(info.rel);
      if (kind === "contract") {
        emit(
          "deny",
          "BLOCKED by AGY Subagent Guard (slice-builder): run_command (" +
            w.op +
            ") MUST NOT modify locked contract `" +
            info.rel +
            "`."
        );
      }
      if (kind === "harness") {
        emit(
          "deny",
          "BLOCKED by AGY Subagent Guard (slice-builder): run_command (" +
            w.op +
            ") MUST NOT modify harness control file `" +
            info.rel +
            "` in target workspaces."
        );
      }
    }
  }
}

const overwrite = {};
const waitMsRaw = args.WaitMsBeforeAsync;
if (waitMsRaw !== undefined && waitMsRaw !== null && waitMsRaw !== "" && Number(waitMsRaw) > 10000) {
  overwrite.WaitMsBeforeAsync = 10000;
}
const notifyRaw = args.NotificationTimeoutSeconds;
if (notifyRaw === undefined || notifyRaw === null || notifyRaw === "" || Number(notifyRaw) <= 0) {
  overwrite.NotificationTimeoutSeconds = 45;
}

emit("allow", null, overwrite);
'
fi

if command -v python3 >/dev/null 2>&1; then
  exec python3 - <<'PY'
import importlib.util, json, os, re, sys

_spec = importlib.util.spec_from_file_location("harness_core", os.path.join(os.environ["AGY_SUBAGENT_SCRIPT_DIR"], "lib", "harness-core.py"))
core = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(core)

def emit(decision, reason=None, overwrite=None):
    out = {"decision": decision}
    if reason:
        out["reason"] = reason
    if overwrite:
        out["overwrite"] = overwrite
    sys.stdout.write(json.dumps(out, ensure_ascii=False) + "\n")
    sys.exit(0)

try:
    data = json.loads(os.environ.get("AGY_SUBAGENT_STDIN") or "{}")
except Exception:
    emit("allow")

role = str(os.environ.get("AGY_SUBAGENT_ROLE") or "").strip()
if role not in ("slice-builder", "staff-gatekeeper"):
    emit("allow")

ws_root = core.resolve_workspace_root(data, False, os.environ.get("AGY_SUBAGENT_REPO_ROOT"))
is_self_hosting = core.is_self_hosting_repo(ws_root)

tc = data.get("toolCall") or {}
tool_name = str(tc.get("name") or "")
args = tc.get("args") or {}

def is_forbidden_for_builder(rel_path):
    if not rel_path:
        return ""
    if rel_path in core.LOCKED_CONTRACTS:
        return "contract"
    if not is_self_hosting and (rel_path == ".agents" or rel_path.startswith(".agents/") or re.match(r"^scripts/harness-[^/]*\.sh$", rel_path)):
        return "harness"
    return ""

def resolve_ws_rel(raw_p):
    cleaned = str(raw_p or "").strip().strip("'\"")
    if not cleaned or cleaned == "/dev/null" or cleaned.startswith("$") or cleaned.startswith("~"):
        return False, ""
    abs_p = core.resolve_real(cleaned, ws_root)
    try:
        rel = abs_p.relative_to(ws_root).as_posix()
        return True, rel
    except ValueError:
        return False, ""

if tool_name in core.EDIT_TOOLS:
    if role == "staff-gatekeeper":
        emit("deny", f"BLOCKED by AGY Subagent Guard (staff-gatekeeper): staff-gatekeeper is strictly read-only and cannot execute `{tool_name}`.")
    raw_target = core.extract_target_path(args)
    if not raw_target:
        emit("allow")
    inside, rel = resolve_ws_rel(raw_target)
    if not inside:
        emit("allow")
    kind = is_forbidden_for_builder(rel)
    if kind == "contract":
        emit("deny", f"BLOCKED by AGY Subagent Guard (slice-builder): Locked contract `{rel}` is read-only for slice-builder. Report contract gaps to the parent coordinator instead.")
    if kind == "harness":
        emit("deny", f"BLOCKED by AGY Subagent Guard (slice-builder): Harness control file `{rel}` cannot be modified by slice-builder in target workspaces.")
    emit("allow")

if tool_name != "run_command":
    emit("allow")

if args.get("IsDaemon") is True:
    emit("deny", f"BLOCKED by AGY Subagent Guard ({role}): IsDaemon=true is forbidden. Stop and emit ## [HOST_CMD_REQUEST] to delegate background/daemon commands.")

cmd_line = str(args.get("CommandLine") or args.get("command") or "")
if cmd_line.strip():
    blacklisted = core.detect_blacklisted_command(cmd_line, 0)
    if blacklisted:
        emit("deny", f"BLOCKED by AGY Subagent Guard ({role}): Blacklisted command `{blacklisted}`. Stop and emit ## [HOST_CMD_REQUEST] to delegate container, install, watch/streaming, or interactive commands to the parent coordinator.")
    mutations = core.inspect_shell_mutations(cmd_line, 0)
    if role == "staff-gatekeeper":
        if mutations["mutatingOps"] or mutations["writes"]:
            op = mutations["mutatingOps"][0] if mutations["mutatingOps"] else mutations["writes"][0]["op"]
            emit("deny", f"BLOCKED by AGY Subagent Guard (staff-gatekeeper): Mutating command (`{op}`) is forbidden. staff-gatekeeper may only execute short read-only checks; delegate mutating or heavy checks via ## [HOST_CMD_REQUEST].")
    else:
        for w in mutations["writes"]:
            inside, rel = resolve_ws_rel(w["raw"])
            if not inside:
                continue
            kind = is_forbidden_for_builder(rel)
            if kind == "contract":
                emit("deny", f"BLOCKED by AGY Subagent Guard (slice-builder): run_command ({w['op']}) MUST NOT modify locked contract `{rel}`.")
            if kind == "harness":
                emit("deny", f"BLOCKED by AGY Subagent Guard (slice-builder): run_command ({w['op']}) MUST NOT modify harness control file `{rel}` in target workspaces.")

overwrite = {}
wait_ms = args.get("WaitMsBeforeAsync")
if wait_ms not in (None, "") and float(wait_ms) > 10000:
    overwrite["WaitMsBeforeAsync"] = 10000
notify = args.get("NotificationTimeoutSeconds")
if notify in (None, "") or float(notify) <= 0:
    overwrite["NotificationTimeoutSeconds"] = 45

emit("allow", None, overwrite if overwrite else None)
PY
fi

echo '{"decision":"allow"}'
