#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
REF_DIR="$PLUGIN_ROOT/skills/harness-init/references"

TARGET_DIR="."
WITH_LOCAL_AGENTS=false
FORCE=false

for arg in "$@"; do
  case "$arg" in
    --with-local-agents)
      WITH_LOCAL_AGENTS=true
      ;;
    --force)
      FORCE=true
      ;;
    -h|--help)
      echo "Usage: init-harness.sh [target-dir] [--with-local-agents] [--force]" >&2
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

mkdir -p "$TARGET_DIR/.agents/rules" "$TARGET_DIR/scripts/hooks" "$TARGET_DIR/.artifacts"
TARGET_ABS="$(cd "$TARGET_DIR" && pwd)"

TMP_AGENT_FILE=""
cleanup_tmp() {
  if [ -n "$TMP_AGENT_FILE" ] && [ -f "$TMP_AGENT_FILE" ]; then
    rm -f "$TMP_AGENT_FILE"
  fi
}
trap cleanup_tmp EXIT

copy_if_needed() {
  local src="$1"
  local dst="$2"
  local mode="${3:-0644}"

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

render_local_agent() {
  local src="$1"
  local out="$2"

  if command -v node >/dev/null 2>&1; then
    node - "$src" "$out" <<'EOF'
const fs = require('node:fs');
const [, , srcPath, outPath] = process.argv;
const raw = fs.readFileSync(srcPath, 'utf8');
const transformed = raw.replace(/(^|[\s'":\-])\.\.\/scripts\/hooks\//gm, '$1../../scripts/hooks/');
fs.writeFileSync(outPath, transformed);
EOF
  elif command -v python3 >/dev/null 2>&1; then
    python3 - "$src" "$out" <<'EOF'
import re
import sys

src_path, out_path = sys.argv[1], sys.argv[2]
with open(src_path, 'r', encoding='utf-8') as f:
    raw = f.read()
transformed = re.sub(r'(^|[\s\'":\-])\.\./scripts/hooks/', r'\1../../scripts/hooks/', raw, flags=re.MULTILINE)
with open(out_path, 'w', encoding='utf-8') as f:
    f.write(transformed)
EOF
  else
    sed -E 's/(^|[[:space:]'\'':-])\.\.\/scripts\/hooks\//\1..\/..\/scripts\/hooks\//g' "$src" > "$out"
  fi
}

copy_always_update "$REF_DIR/harness-rule-template.md" "$TARGET_ABS/.agents/rules/agy-harness.md" 0644
copy_if_needed "$PLUGIN_ROOT/scripts/gate-check.sh" "$TARGET_ABS/scripts/gate-check.sh" 0755
copy_always_update "$PLUGIN_ROOT/scripts/harness-approval-gate.sh" "$TARGET_ABS/scripts/harness-approval-gate.sh" 0755
copy_always_update "$PLUGIN_ROOT/scripts/harness-source-edit-guard.sh" "$TARGET_ABS/scripts/harness-source-edit-guard.sh" 0755
copy_always_update "$PLUGIN_ROOT/scripts/harness-lifecycle-hook.sh" "$TARGET_ABS/scripts/harness-lifecycle-hook.sh" 0755
copy_always_update "$PLUGIN_ROOT/scripts/harness-subagent-guard.sh" "$TARGET_ABS/scripts/harness-subagent-guard.sh" 0755
copy_always_update "$PLUGIN_ROOT/scripts/hooks/slice-builder.hooks.json" "$TARGET_ABS/scripts/hooks/slice-builder.hooks.json" 0644
copy_always_update "$PLUGIN_ROOT/scripts/hooks/staff-gatekeeper.hooks.json" "$TARGET_ABS/scripts/hooks/staff-gatekeeper.hooks.json" 0644
copy_if_needed "$REF_DIR/context-brief-template.md" "$TARGET_ABS/.artifacts/context-brief.md" 0644
copy_if_needed "$REF_DIR/spec-template.md" "$TARGET_ABS/.artifacts/SPEC.md" 0644
copy_if_needed "$REF_DIR/constraints-template.md" "$TARGET_ABS/.artifacts/CONSTRAINTS.md" 0644
copy_if_needed "$REF_DIR/plan-template.md" "$TARGET_ABS/.artifacts/PLAN.md" 0644

merge_or_copy_hooks() {
  local src="$1"
  local dst="$2"

  if [ ! -s "$dst" ]; then
    cp "$src" "$dst"
    chmod 0644 "$dst"
    echo "WROTE: $dst" >&2
    return 0
  fi

  if command -v node >/dev/null 2>&1; then
    node - "$src" "$dst" <<'EOF'
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
    return 0
  elif command -v python3 >/dev/null 2>&1; then
    python3 - "$src" "$dst" <<'EOF'
import json
import sys

src_path, dst_path = sys.argv[1], sys.argv[2]
with open(src_path, 'r', encoding='utf-8') as f:
    tpl = json.load(f)
with open(dst_path, 'r', encoding='utf-8') as f:
    cur = json.load(f)
changed = False
for k, v in tpl.items():
    if k not in cur or cur[k] != v:
        cur[k] = v
        changed = True
if changed:
    with open(dst_path, 'w', encoding='utf-8') as f:
        json.dump(cur, f, indent=2)
        f.write('\n')
    sys.stderr.write(f'MERGED: {dst_path}\n')
else:
    sys.stderr.write(f'SKIP (up-to-date): {dst_path}\n')
EOF
    return 0
  fi

  copy_always_update "$src" "$dst" 0644
}

merge_or_copy_hooks "$REF_DIR/hooks-template.json" "$TARGET_ABS/.agents/hooks.json"

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

ensure_artifacts_gitignored

if [ "$WITH_LOCAL_AGENTS" = "true" ] || [ -d "$TARGET_ABS/.agents/agents" ]; then
  mkdir -p "$TARGET_ABS/.agents/agents"
  for retired_agent in repo-scout.md risk-specialist.md code-reviewer.md security-auditor.md test-engineer.md web-performance-auditor.md; do
    if [ -f "$TARGET_ABS/.agents/agents/$retired_agent" ]; then
      rm -f "$TARGET_ABS/.agents/agents/$retired_agent"
      echo "REMOVED (retired agent): $TARGET_ABS/.agents/agents/$retired_agent" >&2
    fi
  done
  TMP_AGENT_FILE="$(mktemp "${TMPDIR:-/tmp}/agy-agent.XXXXXX")"
  for agent_file in "$PLUGIN_ROOT"/agents/*.md; do
    [ -f "$agent_file" ] || continue
    base_name="$(basename "$agent_file")"
    if [ "$WITH_LOCAL_AGENTS" = "true" ] || [ -f "$TARGET_ABS/.agents/agents/$base_name" ]; then
      render_local_agent "$agent_file" "$TMP_AGENT_FILE"
      copy_always_update "$TMP_AGENT_FILE" "$TARGET_ABS/.agents/agents/$base_name" 0644
    fi
  done
fi

printf '{"status":"ok","target":"%s","withLocalAgents":%s,"force":%s}\n' \
  "$TARGET_ABS" "$WITH_LOCAL_AGENTS" "$FORCE"
