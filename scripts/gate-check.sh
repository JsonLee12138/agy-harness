#!/usr/bin/env bash
set -euo pipefail
export CI=true GIT_PAGER=cat

FAST_MODE=false
FORCE_MODE=false
for arg in "$@"; do
  case "$arg" in
    --fast)
      FAST_MODE=true
      ;;
    --force)
      FORCE_MODE=true
      ;;
    *)
      echo "Unknown option: $arg" >&2
      exit 1
      ;;
  esac
done

compute_fp_info() {
  if command -v node >/dev/null 2>&1; then
    node -e '
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
let wsRoot = process.cwd();
try { wsRoot = fs.realpathSync(wsRoot); } catch {}
const stateDir = process.env.AGY_HARNESS_STATE_DIR || process.env.PLUGIN_DATA || path.join(os.tmpdir(), "agy-harness-approvals");
const fpPath = path.join(stateDir, "gate-fp-" + sha(wsRoot).slice(0, 24) + ".json");

let fp = "";
try {
  const head = execFileSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: wsRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  if (head) {
    const statusOut = execFileSync("git", ["--no-pager", "status", "--porcelain=v1", "-uall"], { cwd: wsRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const lines = statusOut.split(/\r?\n/).map((l) => l.replace(/\r$/, "")).filter(Boolean).filter((line) => {
      let rp = line.slice(3).trim();
      if (rp.includes(" -> ")) rp = rp.split(" -> ").pop().trim();
      rp = rp.replace(/^"+|"+$/g, "").replace(/\\/g, "/");
      return !(rp === ".artifacts" || rp.startsWith(".artifacts/") || rp === ".agents" || rp.startsWith(".agents/"));
    }).sort();
    const parts = ["HEAD:" + head];
    for (const line of lines) {
      let rp = line.slice(3).trim();
      if (rp.includes(" -> ")) rp = rp.split(" -> ").pop().trim();
      rp = rp.replace(/^"+|"+$/g, "");
      const abs = path.join(wsRoot, rp);
      let fh = "MISSING";
      try {
        if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
          fh = crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
        }
      } catch {}
      parts.push(line + "::" + fh);
    }
    fp = sha(parts.join("\n"));
  }
} catch {}

let matched = false;
if (fp && fs.existsSync(fpPath)) {
  try {
    const prev = JSON.parse(fs.readFileSync(fpPath, "utf8"));
    if (prev && prev.mode === "full" && prev.fingerprint === fp) matched = true;
  } catch {}
}
process.stdout.write(fp + "|" + fpPath + "|" + (matched ? "1" : "0") + "\n");
'
  elif command -v python3 >/dev/null 2>&1; then
    python3 - <<'PY'
import hashlib, json, os, pathlib, subprocess, tempfile

def sha(s):
    return hashlib.sha256(s.encode("utf-8")).hexdigest()

ws_root = pathlib.Path(os.path.realpath(os.getcwd()))
state_dir = pathlib.Path(os.environ.get("AGY_HARNESS_STATE_DIR") or os.environ.get("PLUGIN_DATA") or (pathlib.Path(tempfile.gettempdir()) / "agy-harness-approvals"))
fp_path = state_dir / f"gate-fp-{sha(str(ws_root))[:24]}.json"
fp = ""
try:
    h = subprocess.run(["git", "rev-parse", "--verify", "HEAD"], cwd=str(ws_root), capture_output=True, text=True, check=False)
    head = h.stdout.strip() if h.returncode == 0 else ""
    if head:
        st = subprocess.run(["git", "--no-pager", "status", "--porcelain=v1", "-uall"], cwd=str(ws_root), capture_output=True, text=True, check=False)
        lines = []
        for raw in st.stdout.splitlines():
            ln = raw.rstrip("\r")
            if not ln:
                continue
            rp = ln[3:].strip()
            if " -> " in rp:
                rp = rp.split(" -> ")[-1].strip()
            rp = rp.strip('"').replace("\\", "/")
            if rp in (".artifacts", ".agents") or rp.startswith(".artifacts/") or rp.startswith(".agents/"):
                continue
            lines.append(ln)
        lines.sort()
        parts = [f"HEAD:{head}"]
        for ln in lines:
            rp = ln[3:].strip()
            if " -> " in rp:
                rp = rp.split(" -> ")[-1].strip()
            rp = rp.strip('"')
            abs_p = ws_root / rp
            fh = "MISSING"
            try:
                if abs_p.exists() and abs_p.is_file():
                    fh = hashlib.sha256(abs_p.read_bytes()).hexdigest()
            except Exception:
                pass
            parts.append(f"{ln}::{fh}")
        fp = sha("\n".join(parts))
except Exception:
    fp = ""

matched = False
if fp and fp_path.exists():
    try:
        prev = json.loads(fp_path.read_text(encoding="utf-8"))
        if isinstance(prev, dict) and prev.get("mode") == "full" and prev.get("fingerprint") == fp:
            matched = True
    except Exception:
        pass
print(f"{fp}|{fp_path}|{'1' if matched else '0'}")
PY
  else
    echo "||0"
  fi
}

FP_INFO="$(compute_fp_info)"
CURRENT_FP="${FP_INFO%%|*}"
REST_FP="${FP_INFO#*|}"
FP_PATH="${REST_FP%%|*}"
FP_MATCHED="${REST_FP##*|}"

if [ "$FAST_MODE" = "false" ] && [ "$FORCE_MODE" = "false" ] && [ "$FP_MATCHED" = "1" ]; then
  echo "[Gate Dedup] Working tree unchanged since last passing gate check."
  echo "ALL SOFTWARE 1.0 GATES PASSED."
  exit 0
fi

detect_js_runner() {
  if [ -f pnpm-lock.yaml ] && command -v pnpm >/dev/null 2>&1; then
    echo "pnpm"
  elif { [ -f bun.lock ] || [ -f bun.lockb ]; } && command -v bun >/dev/null 2>&1; then
    echo "bun"
  elif [ -f yarn.lock ] && command -v yarn >/dev/null 2>&1; then
    echo "yarn"
  elif command -v npm >/dev/null 2>&1; then
    echo "npm"
  else
    echo ""
  fi
}

has_pkg_script() {
  local script_name="$1"
  [ -f package.json ] || return 1
  if command -v node >/dev/null 2>&1; then
    node -e "const p=JSON.parse(require('fs').readFileSync('package.json','utf8')); process.exit(p.scripts && p.scripts['$script_name'] ? 0 : 1)" 2>/dev/null
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c "import json,sys; p=json.load(open('package.json')); sys.exit(0 if '$script_name' in (p.get('scripts') or {}) else 1)" 2>/dev/null
  else
    return 0
  fi
}

run_pkg_script() {
  local runner="$1"
  local script_name="$2"
  case "$runner" in
    pnpm) pnpm run "$script_name" < /dev/null ;;
    bun) bun run "$script_name" < /dev/null ;;
    yarn) yarn "$script_name" < /dev/null ;;
    npm) npm run "$script_name" --if-present < /dev/null ;;
  esac
}

echo "[Gate 1/4] Checking diff size guideline..."
if git rev-parse --verify HEAD >/dev/null 2>&1; then
  CHANGED_LINES=$(git --no-pager diff --numstat HEAD -- . ':!*.lock' ':!*-lock.*' ':!go.sum' ':!.artifacts/*' | awk '{add+=$1; del+=$2} END {print add+del+0}')
else
  CHANGED_LINES=$(git --no-pager diff --cached --numstat -- . ':!*.lock' ':!*-lock.*' ':!go.sum' ':!.artifacts/*' | awk '{add+=$1; del+=$2} END {print add+del+0}')
fi

if [ "${CHANGED_LINES:-0}" -gt 400 ]; then
  echo "WARN: Diff exceeds 400 lines ($CHANGED_LINES). Verify slice granularity."
fi

JS_RUNNER="$(detect_js_runner)"

echo "[Gate 2/4] Typecheck & Lint..."
if [ -f package.json ] && [ -n "$JS_RUNNER" ]; then
  if has_pkg_script "typecheck"; then
    run_pkg_script "$JS_RUNNER" "typecheck"
  fi
  if has_pkg_script "lint"; then
    run_pkg_script "$JS_RUNNER" "lint"
  fi
fi
if [ -f Cargo.toml ] && command -v cargo >/dev/null 2>&1; then
  cargo check --quiet < /dev/null
fi
if [ -f go.mod ] && command -v go >/dev/null 2>&1; then
  go vet ./... < /dev/null
fi
if { [ -f pyproject.toml ] || [ -f ruff.toml ]; } && command -v ruff >/dev/null 2>&1; then
  ruff check . < /dev/null
fi
if [ -f pubspec.yaml ] && command -v dart >/dev/null 2>&1; then
  dart analyze < /dev/null
fi

echo "[Gate 3/4] Deterministic Test Suite..."
if [ "$FAST_MODE" = "true" ]; then
  echo "Fast mode enabled: running fast checks (run full scripts/gate-check.sh before final delivery)."
  if [ -f package.json ] && [ -n "$JS_RUNNER" ]; then
    if has_pkg_script "test:fast"; then
      run_pkg_script "$JS_RUNNER" "test:fast"
    elif [ -x ./node_modules/.bin/vitest ]; then
      ./node_modules/.bin/vitest related --run < /dev/null
    elif [ -x ./node_modules/.bin/jest ]; then
      ./node_modules/.bin/jest --onlyChanged --passWithNoTests < /dev/null
    fi
  fi
else
  if [ -f package.json ] && [ -n "$JS_RUNNER" ]; then
    if [ "$JS_RUNNER" = "npm" ]; then
      npm test --if-present < /dev/null
    elif has_pkg_script "test"; then
      run_pkg_script "$JS_RUNNER" "test"
    fi
  fi
  if [ -f Cargo.toml ] && command -v cargo >/dev/null 2>&1; then
    cargo test --quiet < /dev/null
  fi
  if [ -f go.mod ] && command -v go >/dev/null 2>&1; then
    go test ./... < /dev/null
  fi
  if { [ -f pyproject.toml ] || [ -f pytest.ini ] || [ -f setup.py ]; } && command -v pytest >/dev/null 2>&1; then
    pytest -q < /dev/null
  fi
  if [ -f pubspec.yaml ] && command -v flutter >/dev/null 2>&1; then
    flutter test < /dev/null
  fi
fi
if [ -f scripts/validate-skills.js ] && command -v node >/dev/null 2>&1; then
  node scripts/validate-skills.js < /dev/null
fi

echo "[Gate 4/4] Basic Secret & Debug Leftover Scan..."
SECRET_ONLY_PATTERN='^\+.*(AKIA[0-9A-Z]{16}|sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{36}|github_pat_[a-zA-Z0-9_]{22,})'
DEBUGGER_PATTERN='^\+.*debugger[;]'
if { git --no-pager diff --cached -U0; git --no-pager diff -U0; } | grep -v '^+++' | grep -E "$SECRET_ONLY_PATTERN"; then
  echo "FAIL: Potential secret or debugger statement detected in diff." >&2
  exit 1
fi
if { git --no-pager diff --cached -U0 -- . ':!*.md'; git --no-pager diff -U0 -- . ':!*.md'; } | grep -v '^+++' | grep -E "$DEBUGGER_PATTERN"; then
  echo "FAIL: Potential secret or debugger statement detected in diff." >&2
  exit 1
fi

if [ "$FAST_MODE" = "false" ]; then
  POST_FP_INFO="$(compute_fp_info)"
  FINAL_FP="${POST_FP_INFO%%|*}"
  if [ -n "$FINAL_FP" ] && [ -n "$FP_PATH" ]; then
    if command -v node >/dev/null 2>&1; then
      node -e "const fs=require('fs'),path=require('path'); const p=process.argv[1], fp=process.argv[2]; fs.mkdirSync(path.dirname(p),{recursive:true}); fs.writeFileSync(p, JSON.stringify({fingerprint:fp,passedAtMs:Date.now(),mode:'full'},null,2)+'\n');" "$FP_PATH" "$FINAL_FP"
    elif command -v python3 >/dev/null 2>&1; then
      python3 -c "import json,pathlib,sys,time; p=pathlib.Path(sys.argv[1]); p.parent.mkdir(parents=True,exist_ok=True); p.write_text(json.dumps({'fingerprint':sys.argv[2],'passedAtMs':int(time.time()*1000),'mode':'full'},indent=2)+'\n')" "$FP_PATH" "$FINAL_FP"
    fi
  fi
fi

echo "ALL SOFTWARE 1.0 GATES PASSED."
