#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
REF_DIR="$PLUGIN_ROOT/skills/harness-init/references"

TARGET_DIR="."
STANDALONE=false
FORCE=false

for arg in "$@"; do
  case "$arg" in
    --standalone|--with-local-agents)
      STANDALONE=true
      ;;
    --force)
      FORCE=true
      ;;
    -h|--help)
      echo "Usage: init-harness.sh [target-dir] [--standalone|--with-local-agents] [--force]" >&2
      exit 0
      ;;
    -*)
      echo "Unknown flag: $arg" >&2
      exit 1
      ;;
    *)
      TARGET_DIR="$arg"
      ;;
  esac
done

mkdir -p "$TARGET_DIR/.agents/rules" "$TARGET_DIR/.artifacts"
TARGET_ABS="$(cd "$TARGET_DIR" && pwd)"

IS_SELF_HOSTING=false
if [ -f "$TARGET_ABS/plugin.json" ]; then
  if command -v node >/dev/null 2>&1; then
    if node -e 'const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.exit(p && p.name === "agy-harness" ? 0 : 1)' "$TARGET_ABS/plugin.json" 2>/dev/null; then
      IS_SELF_HOSTING=true
    fi
  elif grep -q '"name"[[:space:]]*:[[:space:]]*"agy-harness"' "$TARGET_ABS/plugin.json" 2>/dev/null; then
    IS_SELF_HOSTING=true
  fi
fi

TMP_FILE=""
cleanup_tmp() {
  if [ -n "$TMP_FILE" ] && [ -f "$TMP_FILE" ]; then
    rm -f "$TMP_FILE"
  fi
}
trap cleanup_tmp EXIT

copy_if_needed() {
  local src="$1"
  local dst="$2"
  local mode="${3:-0644}"

  mkdir -p "$(dirname "$dst")"
  if [ -e "$dst" ] && [ "$src" -ef "$dst" ]; then
    chmod "$mode" "$dst"
    echo "SKIP (same file): $dst" >&2
    return 0
  fi

  if [ -s "$dst" ] && [ "$FORCE" != "true" ]; then
    echo "SKIP (exists): $dst" >&2
    return 0
  fi

  cp "$src" "$dst"
  chmod "$mode" "$dst"
  echo "WROTE: $dst" >&2
}

copy_always_update() {
  local src="$1"
  local dst="$2"
  local mode="${3:-0644}"

  mkdir -p "$(dirname "$dst")"
  if [ -e "$dst" ] && [ "$src" -ef "$dst" ]; then
    chmod "$mode" "$dst"
    echo "SKIP (same file): $dst" >&2
    return 0
  fi

  if [ -f "$dst" ] && cmp -s "$src" "$dst"; then
    chmod "$mode" "$dst"
    echo "SKIP (up-to-date): $dst" >&2
    return 0
  fi

  local action="WROTE"
  if [ -e "$dst" ]; then
    action="UPDATED"
  fi

  cp "$src" "$dst"
  chmod "$mode" "$dst"
  echo "${action}: $dst" >&2
}

remove_if_exists() {
  local target="$1"
  if [ -f "$target" ]; then
    rm -f "$target"
    echo "REMOVED (legacy): $target" >&2
  fi
}

cleanup_unfilled_context_brief() {
  local brief="$TARGET_ABS/.artifacts/context-brief.md"
  if [ -f "$brief" ]; then
    if grep -qE '_Pending discovery_|^# Context Brief$' "$brief" 2>/dev/null && grep -q '_Pending discovery_' "$brief" 2>/dev/null; then
      rm -f "$brief"
      echo "REMOVED (legacy template): $brief" >&2
    fi
  fi
}

cleanup_legacy_top_level_scripts() {
  [ "$IS_SELF_HOSTING" = "true" ] && return 0

  for old_sh in \
    "$TARGET_ABS/scripts/harness-approval-gate.sh" \
    "$TARGET_ABS/scripts/harness-source-edit-guard.sh" \
    "$TARGET_ABS/scripts/harness-lifecycle-hook.sh" \
    "$TARGET_ABS/scripts/harness-subagent-guard.sh"; do
    remove_if_exists "$old_sh"
  done

  for old_hook in \
    "$TARGET_ABS/scripts/hooks/slice-builder.hooks.json" \
    "$TARGET_ABS/scripts/hooks/staff-gatekeeper.hooks.json"; do
    remove_if_exists "$old_hook"
  done

  if [ -d "$TARGET_ABS/scripts/hooks" ]; then
    rmdir "$TARGET_ABS/scripts/hooks" 2>/dev/null || true
  fi
}

strip_harness_hooks_from_agents_json() {
  local dst="$TARGET_ABS/.agents/hooks.json"
  [ -f "$dst" ] || return 0
  [ "$IS_SELF_HOSTING" = "true" ] && return 0

  if command -v node >/dev/null 2>&1; then
    node - "$dst" <<'EOF'
const fs = require('node:fs');
const dstPath = process.argv[2];
let cur;
try {
  cur = JSON.parse(fs.readFileSync(dstPath, 'utf8'));
} catch {
  process.exit(0);
}
if (!cur || typeof cur !== 'object') process.exit(0);
let changed = false;
for (const key of ['harness-contract-approval-gate', 'harness-parent-source-edit-guard', 'harness-lifecycle-guard']) {
  if (Object.prototype.hasOwnProperty.call(cur, key)) {
    delete cur[key];
    changed = true;
  }
}
if (!changed) process.exit(0);
if (Object.keys(cur).length === 0) {
  fs.unlinkSync(dstPath);
  process.stderr.write(`REMOVED (legacy empty): ${dstPath}\n`);
} else {
  fs.writeFileSync(dstPath, JSON.stringify(cur, null, 2) + '\n');
  process.stderr.write(`CLEANED (legacy harness hooks): ${dstPath}\n`);
}
EOF
  elif command -v python3 >/dev/null 2>&1; then
    python3 - "$dst" <<'PY'
import json, os, sys
dst_path = sys.argv[1]
try:
    with open(dst_path, 'r', encoding='utf-8') as f:
        cur = json.load(f)
except Exception:
    sys.exit(0)
if not isinstance(cur, dict):
    sys.exit(0)
changed = False
for key in ('harness-contract-approval-gate', 'harness-parent-source-edit-guard', 'harness-lifecycle-guard'):
    if key in cur:
        del cur[key]
        changed = True
if not changed:
    sys.exit(0)
if not cur:
    os.unlink(dst_path)
    sys.stderr.write(f'REMOVED (legacy empty): {dst_path}\n')
else:
    with open(dst_path, 'w', encoding='utf-8') as f:
        json.dump(cur, f, indent=2)
        f.write('\n')
    sys.stderr.write(f'CLEANED (legacy harness hooks): {dst_path}\n')
PY
  fi
}

render_standalone_agent_hooks_json() {
  local role="$1"
  local out="$2"
  local matcher
  if [ "$role" = "slice-builder" ]; then
    matcher="write_file|edit_file|create_file|delete_file|sed_file|write_to_file|replace_file_content|multi_replace_file_content|run_command"
  else
    matcher="run_command"
  fi
  cat > "$out" <<EOF
{
  "harness-${role}-guard": {
    "PreToolUse": [
      {
        "matcher": "${matcher}",
        "hooks": [
          {
            "type": "command",
            "command": "./harness-subagent-guard.sh --role=${role}",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
EOF
}

render_standalone_agent_md() {
  local src="$1"
  local out="$2"
  if command -v node >/dev/null 2>&1; then
    node - "$src" "$out" <<'EOF'
const fs = require('node:fs');
const [, , srcPath, outPath] = process.argv;
const raw = fs.readFileSync(srcPath, 'utf8');
const transformed = raw.replace(/(^|[\s'":\-])\.\.\/scripts\/hooks\//gm, '$1../hooks/');
fs.writeFileSync(outPath, transformed);
EOF
  elif command -v python3 >/dev/null 2>&1; then
    python3 - "$src" "$out" <<'EOF'
import re, sys
src_path, out_path = sys.argv[1], sys.argv[2]
with open(src_path, 'r', encoding='utf-8') as f:
    raw = f.read()
transformed = re.sub(r'(^|[\s\'":\-])\.\./scripts/hooks/', r'\1../hooks/', raw, flags=re.MULTILINE)
with open(out_path, 'w', encoding='utf-8') as f:
    f.write(transformed)
EOF
  else
    sed -E 's/(^|[[:space:]'\'':-])\.\.\/scripts\/hooks\//\1..\/hooks\//g' "$src" > "$out"
  fi
}

merge_standalone_hooks_json() {
  local src="$1"
  local dst="$2"

  TMP_FILE="$(mktemp "${TMPDIR:-/tmp}/agy-hooks.XXXXXX")"
  if command -v node >/dev/null 2>&1; then
    node - "$src" "$TMP_FILE" <<'EOF'
const fs = require('node:fs');
const [, , srcPath, tmpPath] = process.argv;
const raw = fs.readFileSync(srcPath, 'utf8').replace(/\.\.\/scripts\//g, './hooks/');
fs.writeFileSync(tmpPath, raw);
EOF
  elif command -v python3 >/dev/null 2>&1; then
    python3 - "$src" "$TMP_FILE" <<'PY'
import sys
with open(sys.argv[1], 'r', encoding='utf-8') as f:
    raw = f.read()
with open(sys.argv[2], 'w', encoding='utf-8') as f:
    f.write(raw.replace('../scripts/', './hooks/'))
PY
  else
    sed 's|\.\./scripts/|./hooks/|g' "$src" > "$TMP_FILE"
  fi

  if [ ! -s "$dst" ]; then
    cp "$TMP_FILE" "$dst"
    chmod 0644 "$dst"
    echo "WROTE: $dst" >&2
    return 0
  fi

  if command -v node >/dev/null 2>&1; then
    node - "$TMP_FILE" "$dst" <<'EOF'
const fs = require('node:fs');
const [, , srcPath, dstPath] = process.argv;
const tpl = JSON.parse(fs.readFileSync(srcPath, 'utf8'));
const cur = JSON.parse(fs.readFileSync(dstPath, 'utf8'));
let changed = false;
for (const [k, v] of Object.entries(tpl)) {
  if (!Object.prototype.hasOwnProperty.call(cur, k) || JSON.stringify(cur[k]) !== JSON.stringify(v)) {
    cur[k] = v;
    changed = true;
  }
}
if (changed) {
  fs.writeFileSync(dstPath, JSON.stringify(cur, null, 2) + '\n');
  process.stderr.write(`MERGED: ${dstPath}\n`);
} else {
  process.stderr.write(`SKIP (up-to-date): ${dstPath}\n`);
}
EOF
  elif command -v python3 >/dev/null 2>&1; then
    python3 - "$TMP_FILE" "$dst" <<'PY'
import json, sys
with open(sys.argv[1], 'r', encoding='utf-8') as f:
    tpl = json.load(f)
with open(sys.argv[2], 'r', encoding='utf-8') as f:
    cur = json.load(f)
changed = False
for k, v in tpl.items():
    if k not in cur or cur[k] != v:
        cur[k] = v
        changed = True
if changed:
    with open(sys.argv[2], 'w', encoding='utf-8') as f:
        json.dump(cur, f, indent=2)
        f.write('\n')
    sys.stderr.write(f'MERGED: {sys.argv[2]}\n')
else:
    sys.stderr.write(f'SKIP (up-to-date): {sys.argv[2]}\n')
PY
  else
    copy_always_update "$TMP_FILE" "$dst" 0644
  fi
}

ensure_artifacts_gitignored() {
  local root_gitignore="$TARGET_ABS/.gitignore"
  local inner_gitignore="$TARGET_ABS/.artifacts/.gitignore"

  if [ ! -f "$inner_gitignore" ] || [ "$FORCE" = "true" ]; then
    printf '# Ephemeral AGY Harness per-task contracts (local Disk SSoT, do not commit)\n*\n' > "$inner_gitignore"
    chmod 0644 "$inner_gitignore"
  fi

  if [ -f "$root_gitignore" ] && grep -qxE '/?\.artifacts/?' "$root_gitignore"; then
    echo "SKIP (already ignored): $root_gitignore (.artifacts/)" >&2
    return 0
  fi

  if [ -f "$root_gitignore" ] && [ -s "$root_gitignore" ]; then
    if [ "$(tail -c 1 "$root_gitignore" | wc -l | tr -d ' ')" = "0" ]; then
      printf '\n' >> "$root_gitignore"
    fi
  fi

  printf '.artifacts/\n' >> "$root_gitignore"
  chmod 0644 "$root_gitignore"
  echo "UPDATED: $root_gitignore (+.artifacts/)" >&2
}

# 1. Core rule, gate-check.sh, and lean .artifacts contracts
copy_always_update "$REF_DIR/harness-rule-template.md" "$TARGET_ABS/.agents/rules/agy-harness.md" 0644
copy_if_needed "$PLUGIN_ROOT/scripts/gate-check.sh" "$TARGET_ABS/scripts/gate-check.sh" 0755
copy_if_needed "$REF_DIR/spec-template.md" "$TARGET_ABS/.artifacts/SPEC.md" 0644
copy_if_needed "$REF_DIR/constraints-template.md" "$TARGET_ABS/.artifacts/CONSTRAINTS.md" 0644
copy_if_needed "$REF_DIR/plan-template.md" "$TARGET_ABS/.artifacts/PLAN.md" 0644
ensure_artifacts_gitignored
cleanup_unfilled_context_brief
cleanup_legacy_top_level_scripts

if [ "$IS_SELF_HOSTING" = "true" ]; then
  # Self-hosting repository preserves root scripts/ and .agents/hooks.json
  copy_always_update "$REF_DIR/hooks-template.json" "$TARGET_ABS/.agents/hooks.json" 0644
elif [ "$STANDALONE" = "true" ]; then
  # Standalone mode: self-contained hidden hooks & subagents under .agents/
  mkdir -p "$TARGET_ABS/.agents/hooks/lib" "$TARGET_ABS/.agents/agents"
  copy_always_update "$PLUGIN_ROOT/scripts/lib/harness-core.js" "$TARGET_ABS/.agents/hooks/lib/harness-core.js" 0644
  copy_always_update "$PLUGIN_ROOT/scripts/lib/harness-core.py" "$TARGET_ABS/.agents/hooks/lib/harness-core.py" 0644
  copy_always_update "$PLUGIN_ROOT/scripts/harness-approval-gate.sh" "$TARGET_ABS/.agents/hooks/harness-approval-gate.sh" 0755
  copy_always_update "$PLUGIN_ROOT/scripts/harness-source-edit-guard.sh" "$TARGET_ABS/.agents/hooks/harness-source-edit-guard.sh" 0755
  copy_always_update "$PLUGIN_ROOT/scripts/harness-lifecycle-hook.sh" "$TARGET_ABS/.agents/hooks/harness-lifecycle-hook.sh" 0755
  copy_always_update "$PLUGIN_ROOT/scripts/harness-subagent-guard.sh" "$TARGET_ABS/.agents/hooks/harness-subagent-guard.sh" 0755

  TMP_FILE="$(mktemp "${TMPDIR:-/tmp}/agy-subhook.XXXXXX")"
  render_standalone_agent_hooks_json "slice-builder" "$TMP_FILE"
  copy_always_update "$TMP_FILE" "$TARGET_ABS/.agents/hooks/slice-builder.hooks.json" 0644
  render_standalone_agent_hooks_json "staff-gatekeeper" "$TMP_FILE"
  copy_always_update "$TMP_FILE" "$TARGET_ABS/.agents/hooks/staff-gatekeeper.hooks.json" 0644

  merge_standalone_hooks_json "$REF_DIR/hooks-template.json" "$TARGET_ABS/.agents/hooks.json"

  for retired_agent in repo-scout.md risk-specialist.md code-reviewer.md security-auditor.md test-engineer.md web-performance-auditor.md; do
    remove_if_exists "$TARGET_ABS/.agents/agents/$retired_agent"
  done
  TMP_FILE="$(mktemp "${TMPDIR:-/tmp}/agy-agent.XXXXXX")"
  for agent_file in "$PLUGIN_ROOT"/agents/*.md; do
    [ -f "$agent_file" ] || continue
    base_name="$(basename "$agent_file")"
    render_standalone_agent_md "$agent_file" "$TMP_FILE"
    copy_always_update "$TMP_FILE" "$TARGET_ABS/.agents/agents/$base_name" 0644
  done
else
  # Default clean-room mode: rely on global plugin hooks.json & clean legacy workspace clutter
  strip_harness_hooks_from_agents_json
  if [ -d "$TARGET_ABS/.agents/hooks" ]; then
    for hfile in \
      harness-approval-gate.sh harness-source-edit-guard.sh harness-lifecycle-hook.sh harness-subagent-guard.sh \
      slice-builder.hooks.json staff-gatekeeper.hooks.json lib/harness-core.js lib/harness-core.py; do
      remove_if_exists "$TARGET_ABS/.agents/hooks/$hfile"
    done
    rmdir "$TARGET_ABS/.agents/hooks/lib" 2>/dev/null || true
    rmdir "$TARGET_ABS/.agents/hooks" 2>/dev/null || true
  fi
  if [ -d "$TARGET_ABS/.agents/agents" ]; then
    for old_agent in \
      repo-scout.md risk-specialist.md code-reviewer.md security-auditor.md test-engineer.md web-performance-auditor.md \
      arch-redteam.md slice-builder.md staff-gatekeeper.md; do
      remove_if_exists "$TARGET_ABS/.agents/agents/$old_agent"
    done
    rmdir "$TARGET_ABS/.agents/agents" 2>/dev/null || true
  fi
fi

printf '{"status":"ok","target":"%s","standalone":%s,"force":%s}\n' \
  "$TARGET_ABS" "$STANDALONE" "$FORCE"
