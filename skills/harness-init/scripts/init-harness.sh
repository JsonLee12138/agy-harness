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

mkdir -p "$TARGET_DIR/.agents/rules" "$TARGET_DIR/scripts" "$TARGET_DIR/.artifacts"
TARGET_ABS="$(cd "$TARGET_DIR" && pwd)"

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

copy_always_update "$REF_DIR/harness-rule-template.md" "$TARGET_ABS/.agents/rules/agy-harness.md" 0644
copy_if_needed "$PLUGIN_ROOT/scripts/gate-check.sh" "$TARGET_ABS/scripts/gate-check.sh" 0755
copy_always_update "$PLUGIN_ROOT/scripts/harness-approval-gate.sh" "$TARGET_ABS/scripts/harness-approval-gate.sh" 0755
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

if [ "$WITH_LOCAL_AGENTS" = "true" ]; then
  mkdir -p "$TARGET_ABS/.agents/agents"
  for agent_file in "$PLUGIN_ROOT"/agents/*.md; do
    [ -f "$agent_file" ] || continue
    base_name="$(basename "$agent_file")"
    copy_always_update "$agent_file" "$TARGET_ABS/.agents/agents/$base_name" 0644
  done
fi

printf '{"status":"ok","target":"%s","withLocalAgents":%s,"force":%s}\n' \
  "$TARGET_ABS" "$WITH_LOCAL_AGENTS" "$FORCE"
