# -*- coding: utf-8 -*-
import datetime
import hashlib
import json
import os
import pathlib
import posixpath
import re
import subprocess
import tempfile

EDIT_TOOLS = {
    "write_file",
    "edit_file",
    "create_file",
    "delete_file",
    "sed_file",
    "write_to_file",
    "replace_file_content",
    "multi_replace_file_content",
}

READ_ONLY_SUBAGENTS = {"arch-redteam", "staff-gatekeeper", "research"}

LOCKED_CONTRACTS = {
    ".artifacts/SPEC.md",
    ".artifacts/CONSTRAINTS.md",
    ".artifacts/PLAN.md",
}


def sha256_hex(s):
    return hashlib.sha256(str(s or "").encode("utf-8")).hexdigest()


def resolve_real(target_path, base_dir):
    cur = pathlib.Path(os.path.abspath(os.path.join(str(base_dir), str(target_path or ""))))
    parts = []
    while not cur.exists():
        parent = cur.parent
        if parent == cur:
            break
        parts.insert(0, cur.name)
        cur = parent
    try:
        real_base = pathlib.Path(os.path.realpath(str(cur)))
    except Exception:
        real_base = cur
    return real_base.joinpath(*parts) if parts else real_base


def resolve_workspace_root(data, plugin_mode, fallback_repo_root):
    ws_list = data.get("workspacePaths") or []
    raw_ws = (
        str(ws_list[0])
        if (ws_list and ws_list[0] and os.path.exists(str(ws_list[0])))
        else (
            str(ws_list[0])
            if (ws_list and ws_list[0])
            else (
                str(data.get("cwd") or "")
                or (os.getcwd() if plugin_mode else (fallback_repo_root or os.getcwd()))
            )
        )
    )
    return resolve_real(raw_ws, os.getcwd())


def has_harness_in_ws(ws_root):
    return (
        (ws_root / ".agents" / "rules" / "agy-harness.md").exists()
        or (ws_root / ".artifacts" / "SPEC.md").exists()
        or (ws_root / ".artifacts" / "PLAN.md").exists()
    )


def is_self_hosting_repo(ws_root):
    pj_path = ws_root / "plugin.json"
    if pj_path.exists():
        try:
            pj = json.loads(pj_path.read_text(encoding="utf-8"))
            return isinstance(pj, dict) and pj.get("name") == "agy-harness"
        except Exception:
            pass
    return False


def get_state_dir():
    return pathlib.Path(
        os.environ.get("AGY_HARNESS_STATE_DIR")
        or os.environ.get("PLUGIN_DATA")
        or (pathlib.Path(tempfile.gettempdir()) / "agy-harness-approvals")
    )


def read_json_safe(p):
    if not p.exists():
        return {}
    try:
        parsed = json.loads(p.read_text(encoding="utf-8"))
        return parsed if isinstance(parsed, dict) else {}
    except Exception:
        return {}


def write_json_safe(p, obj):
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(obj, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    except Exception:
        pass


def is_harness_internal(rel_path):
    rel = str(rel_path or "").replace("\\", "/")
    return rel in (".artifacts", ".agents") or rel.startswith(".artifacts/") or rel.startswith(".agents/")


def is_trivial_exempt_path(rel_path):
    rel = re.sub(r"^(?:\./)+", "", str(rel_path or "").replace("\\", "/"))
    if not rel or re.search(r"^(?:agents|skills|commands)(?:/|\Z)", rel):
        return False
    base = posixpath.basename(rel)
    return bool(
        re.search(r"\.(?:md|mdx|txt|rst|adoc)\Z", rel, re.IGNORECASE)
        or re.search(
            r"^(?:LICENSE(?:\.[A-Za-z0-9._-]+)?|NOTICE|AUTHORS|CONTRIBUTORS|PATENTS|CODEOWNERS|\.(?:gitignore|gitattributes|editorconfig|prettierignore|eslintignore|dockerignore|npmrc|nvmrc|node-version|python-version|tool-versions)|\.env\.(?:example|sample|template))\Z",
            base,
            re.IGNORECASE,
        )
        or re.search(r"(?:^|/)(?:plugin|marketplace)\.json\Z", rel, re.IGNORECASE)
        or re.search(r"(?:^|/)(?:version\.txt|VERSION)\Z", rel)
        or re.search(
            r"(?:^|/)(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|go\.sum|pubspec\.lock|Gemfile\.lock|composer\.lock)\Z",
            rel,
        )
        or re.search(r"\.(?:svg|png|jpe?g|gif|webp|ico|woff2?|ttf|otf|eot)\Z", rel, re.IGNORECASE)
        or re.search(r"\.(?:css|scss|sass|less)\Z", rel, re.IGNORECASE)
        or re.search(r"(?:^|/)(?:locales|i18n|messages)/.*\.json\Z", rel, re.IGNORECASE)
    )


def extract_target_path(a):
    if not isinstance(a, dict):
        return ""
    for key in ("Path", "TargetFile", "TargetPath", "File", "path", "file", "file_path", "filePath", "target_file"):
        v = a.get(key)
        if v:
            return str(v).strip('"').strip()
    return ""


def extract_text(val):
    if isinstance(val, str):
        return val
    if isinstance(val, list):
        return "\n".join(extract_text(item) for item in val)
    if isinstance(val, dict):
        if isinstance(val.get("text"), str):
            return val["text"]
        if isinstance(val.get("content"), str):
            return val["content"]
        return json.dumps(val, ensure_ascii=False)
    return ""


def clean_user_message(raw):
    s = re.sub(r"<ADDITIONAL_METADATA>[\s\S]*?</ADDITIONAL_METADATA>", "", str(raw or ""), flags=re.IGNORECASE)
    s = re.sub(r"<USER_SETTINGS_CHANGE>[\s\S]*?</USER_SETTINGS_CHANGE>", "", s, flags=re.IGNORECASE)
    s = re.sub(r"</?USER_REQUEST>", "", s, flags=re.IGNORECASE)
    return s.strip()


def detect_is_parent(tp):
    if not tp or not os.path.exists(tp):
        return False
    try:
        lines = pathlib.Path(tp).read_text(encoding="utf-8", errors="ignore").splitlines()
    except Exception:
        return False
    saw_first_system = False
    has_user_input = False
    for line in lines:
        if not line.strip():
            continue
        try:
            obj = json.loads(line)
        except Exception:
            continue
        if not isinstance(obj, dict):
            continue
        if not saw_first_system and obj.get("type") == "SYSTEM_MESSAGE":
            saw_first_system = True
            c = obj.get("content")
            msg = c if isinstance(c, str) else json.dumps(c or "", ensure_ascii=False)
            if "[Message]" in msg and "sender=" in msg:
                return False
        if obj.get("type") == "USER_INPUT" or obj.get("source") == "USER_EXPLICIT":
            has_user_input = True
    return has_user_input


def strip_fences(text, strip_inline):
    out = []
    in_fence = False
    for line in str(text or "").replace("\r\n", "\n").split("\n"):
        if re.match(r"^\s*```", line):
            in_fence = not in_fence
            out.append("")
            continue
        if in_fence:
            out.append("")
            continue
        out.append(re.sub(r"`[^`]*`", "", line) if strip_inline else line)
    return "\n".join(out)


def strip_non_contract(text):
    cleaned = re.sub(
        r"<!--\s*non-contract\s*-->[\s\S]*?<!--\s*/non-contract\s*-->",
        "",
        str(text or "").replace("\r\n", "\n"),
        flags=re.IGNORECASE,
    )
    non_contract_re = re.compile(
        r"^##\s+(?:Implementation Notes(?:\s*/\s*Guardrails)?|Guardrails|实施备注|风险护栏)\b",
        re.IGNORECASE,
    )
    out = []
    skipping = False
    for ln in cleaned.split("\n"):
        if re.match(r"^##\s+", ln):
            skipping = bool(non_contract_re.match(ln))
        if not skipping:
            out.append(ln)
    return "\n".join(out)


def norm_contract(t):
    lines = []
    for ln in strip_non_contract(t).split("\n"):
        ln = re.sub(r"^(\s*-\s*)\[[ xX/-]\](\s+)", r"\1[ ]\2", ln)
        ln = re.sub(r"^(\s*-\s*\*\*)(?:Status|状态)(:\*\*\s*).+$", r"\1Status\2<STATUS>", ln)
        if ln.strip():
            lines.append(ln)
    return "\n".join(lines)


def has_spec_template_marker(spec_txt):
    if not str(spec_txt or "").strip():
        return True
    stripped = strip_fences(spec_txt, True)
    return bool(
        re.search(r"^\s*-\s+\*\*Goal:\*\*\s+_Describe the concrete user or system problem being solved\._\s*$", stripped, re.MULTILINE)
        or re.search(r"<!--\s*HARNESS_TEMPLATE_UNFILLED\b", stripped, re.IGNORECASE)
    )


def has_plan_template_marker(plan_txt):
    if not str(plan_txt or "").strip():
        return True
    stripped = strip_fences(plan_txt, True)
    return bool(
        re.search(r"^\s*##\s+Slice 1:\s+\[Title\]\s*$", stripped, re.MULTILINE)
        or re.search(r"<!--\s*HARNESS_TEMPLATE_UNFILLED\b", stripped, re.IGNORECASE)
    )


def is_explicit_archive_marker(text):
    return bool(re.search(r"<!--\s*HARNESS_STATUS:\s*(?:ARCHIVED|DONE|PAUSED)\s*-->", strip_fences(text, True), re.IGNORECASE))


def is_explicit_paused_marker(text):
    return bool(re.search(r"<!--\s*HARNESS_STATUS:\s*PAUSED\s*-->", strip_fences(text, True), re.IGNORECASE))


def is_subagent_only_plan(text):
    return bool(re.search(r"<!--\s*HARNESS_EXECUTION:\s*SUBAGENT_ONLY\s*-->", strip_fences(text, True), re.IGNORECASE))


def count_spec_checkboxes(spec_txt):
    body = strip_fences(strip_non_contract(spec_txt), True)
    done, open_cnt = 0, 0
    for ln in body.split("\n"):
        m = re.match(r"^\s*[-*]\s+\[([ xX/])\](?:\s|$)", ln)
        if not m:
            continue
        if m.group(1) in ("x", "X"):
            done += 1
        else:
            open_cnt += 1
    return done, open_cnt


def count_plan_statuses(plan_txt):
    body = strip_fences(strip_non_contract(plan_txt), False)
    done, open_cnt = 0, 0
    for ln in body.split("\n"):
        m = (
            re.match(r"^\s*(?:[-*]\s*)?(?:\*\*)?(?:Status|状态)(?:\*\*)?\s*:\s*(?:\*\*)?\s*`?\[([ xX/])\]", ln, re.IGNORECASE)
            or re.match(r"^\s*[-*]\s+\[([ xX/])\](?:\s|$)", ln)
        )
        if not m:
            continue
        if m.group(1) in ("x", "X"):
            done += 1
        else:
            open_cnt += 1
    return done, open_cnt


def is_explicit_user_approval(msg):
    if not msg:
        return False
    if "The user has approved this document." in msg:
        return True
    if re.search(r"[?？]\s*$", msg):
        return False
    if re.search(r"(?:吗|呢|么)[。.!！?？]*\s*$", msg):
        return False
    if re.search(
        r"\b(?:not\s+(?:approved?|confirmed?)|don'?t\s+(?:approve|proceed|start|execute)|do\s+not\s+(?:approve|proceed|start|execute)|hold\s+on|wait|pause|hesitat\w*|reconsider|revise|modify|change\s+the\s+plan|instead|except|however|but\s+(?:first|before|wait|not)|maybe|not\s+sure|uncertain|let'?s\s+(?:rethink|discuss|wait|pause))\b",
        msg,
        re.IGNORECASE,
    ):
        return False
    if re.search(
        r"(?:不同意|未同意|没同意|不批准|未批准|没批准|未确认|不确认|暂不|别开始|先别|先不要|暂缓|暂停|等一下|等等|再想想|修改|改一下|调整|重写|补充|疑问|不确定|有问题|不过|但是先|不要按|不能)",
        msg,
    ):
        return False
    if re.match(r"^(?:can|could|should|would|why|what|how|when|where|which|who|is|are|do|does|did|will)\b", msg, re.IGNORECASE):
        return False
    return bool(
        re.search(r"\b(?:proceed|approved?|lgtm|confirmed?|go\s+ahead|looks\s+good)\b", msg, re.IGNORECASE)
        or re.search(r"(?:同意|批准|确认|继续执行|按方案执行|可以开始|按此执行|准许)", msg)
        or re.match(r"^(?:yes|ok|okay|好的|可以|行)[.!。！]?$", msg, re.IGNORECASE)
    )


def get_contract_state(ws_root, state_dir, conversation_id, transcript_path, last_user_input):
    spec_path = ws_root / ".artifacts" / "SPEC.md"
    plan_path = ws_root / ".artifacts" / "PLAN.md"
    spec_exists = spec_path.exists()
    plan_exists = plan_path.exists()
    spec_txt = spec_path.read_text(encoding="utf-8") if spec_exists else ""
    plan_txt = plan_path.read_text(encoding="utf-8") if plan_exists else ""

    is_explicitly_archived = (
        (spec_exists and is_explicit_archive_marker(spec_txt))
        or (plan_exists and is_explicit_archive_marker(plan_txt))
    )
    is_paused = (
        (spec_exists and is_explicit_paused_marker(spec_txt))
        or (plan_exists and is_explicit_paused_marker(plan_txt))
    )
    subagent_only = plan_exists and is_subagent_only_plan(plan_txt)

    spec_filled = spec_exists and not has_spec_template_marker(spec_txt)
    plan_filled = plan_exists and not has_plan_template_marker(plan_txt)
    has_template_placeholder = (not spec_filled) or (not plan_filled)
    spec_done, spec_open = count_spec_checkboxes(spec_txt)
    plan_done, plan_open = count_plan_statuses(plan_txt)
    is_auto_archived = (
        spec_filled and plan_filled and spec_done >= 1 and spec_open == 0 and plan_done >= 1 and plan_open == 0
    )
    is_archived = is_explicitly_archived or is_auto_archived

    if is_archived or (not spec_filled and not plan_filled):
        return {
            "status": "INACTIVE",
            "semanticHash": "",
            "isPaused": is_paused,
            "isArchived": is_archived,
            "hasTemplatePlaceholder": has_template_placeholder,
            "subagentOnly": subagent_only,
            "specExists": spec_exists,
            "planExists": plan_exists,
            "isApprovedViaState": False,
            "isApprovedViaTurn": False,
            "isModifiedAfterUser": False,
            "isUnapprovedArtifactComment": False,
            "saveApprovedState": lambda: None,
        }

    if not spec_filled or not plan_filled:
        return {
            "status": "ACTIVE_UNAPPROVED",
            "semanticHash": sha256_hex("PARTIAL\n" + spec_txt + "\n" + plan_txt),
            "isPaused": False,
            "isArchived": False,
            "hasTemplatePlaceholder": True,
            "subagentOnly": subagent_only,
            "specExists": spec_exists,
            "planExists": plan_exists,
            "isApprovedViaState": False,
            "isApprovedViaTurn": False,
            "isModifiedAfterUser": False,
            "isUnapprovedArtifactComment": False,
            "saveApprovedState": lambda: None,
        }

    sem_hash = sha256_hex("SPEC\n" + norm_contract(spec_txt) + "\nPLAN\n" + norm_contract(plan_txt))
    conv_key = sha256_hex(str(ws_root) + "::" + str(conversation_id or "default"))[:24]
    state_path = state_dir / f"{conv_key}.json"
    state = read_json_safe(state_path)

    last_user = None
    mod_after = False
    if transcript_path and pathlib.Path(transcript_path).exists():
        parsed = []
        last_idx = -1
        for raw in pathlib.Path(transcript_path).read_text(encoding="utf-8", errors="ignore").splitlines():
            if not raw.strip():
                continue
            try:
                obj = json.loads(raw)
                parsed.append(obj)
                if isinstance(obj, dict) and (obj.get("type") == "USER_INPUT" or obj.get("source") == "USER_EXPLICIT"):
                    last_idx = len(parsed) - 1
            except Exception:
                pass
        if last_idx >= 0:
            last_user = parsed[last_idx]
            for step in parsed[last_idx + 1:]:
                if not isinstance(step, dict):
                    continue
                for call in (step.get("tool_calls") or []):
                    tc_name = str((call or {}).get("name") or "")
                    tc_args = (call or {}).get("args") or {}
                    if tc_name in EDIT_TOOLS:
                        if re.search(r"\.artifacts[\\/]+(SPEC|PLAN)\.md$", extract_target_path(tc_args)):
                            mod_after = True
                    elif tc_name == "run_command":
                        cmd_s = str(tc_args.get("CommandLine") or tc_args.get("command") or "")
                        if re.search(r"\.artifacts[\\/]+(SPEC|PLAN)\.md", cmd_s) and re.search(
                            r"(?:>|>>|\btee\b|\bsed\b|\bperl\b|\bmv\b|\bcp\b|\brm\b|\bnode\b|\bpython3?\b)", cmd_s
                        ):
                            mod_after = True

    raw_transcript_msg = extract_text(last_user.get("content")) if last_user else ""
    fallback_user_msg = last_user_input if isinstance(last_user_input, str) else ""
    raw_user_msg = raw_transcript_msg if raw_transcript_msg.strip() else fallback_user_msg
    cleaned_user_msg = clean_user_message(raw_user_msg)
    has_artifact_comments = "Comments on artifact URI:" in cleaned_user_msg
    has_doc_approved = "The user has approved this document." in cleaned_user_msg
    is_unapproved_comment = has_artifact_comments and not has_doc_approved

    last_ms = None
    if last_user and last_user.get("created_at"):
        try:
            last_ms = datetime.datetime.fromisoformat(str(last_user["created_at"]).replace("Z", "+00:00")).timestamp() * 1000.0
        except Exception:
            last_ms = None
    max_mtime_ms = max(spec_path.stat().st_mtime, plan_path.stat().st_mtime) * 1000.0
    is_modified_after = bool(mod_after or (last_user is not None and (last_ms is None or max_mtime_ms > last_ms)))

    is_approved_via_state = bool(state and state.get("approvedHash") == sem_hash)
    is_approved_via_turn = bool(
        not is_unapproved_comment
        and not is_modified_after
        and ((last_ms is not None) if last_user is not None else bool(fallback_user_msg.strip()))
        and is_explicit_user_approval(cleaned_user_msg)
    )

    def save_approved_state():
        write_json_safe(
            state_path,
            {
                "approvedHash": sem_hash,
                "approvedAtMs": int(datetime.datetime.now(datetime.timezone.utc).timestamp() * 1000),
                "approvedStepIdx": (last_user or {}).get("step_index", 0),
            },
        )

    return {
        "status": "ACTIVE_APPROVED" if (is_approved_via_state or is_approved_via_turn) else "ACTIVE_UNAPPROVED",
        "semanticHash": sem_hash,
        "isPaused": False,
        "isArchived": False,
        "hasTemplatePlaceholder": False,
        "subagentOnly": subagent_only,
        "specExists": spec_exists,
        "planExists": plan_exists,
        "isApprovedViaState": is_approved_via_state,
        "isApprovedViaTurn": is_approved_via_turn,
        "isModifiedAfterUser": is_modified_after,
        "isUnapprovedArtifactComment": is_unapproved_comment,
        "saveApprovedState": save_approved_state,
    }


def classify_path_target(raw_p, ws_root):
    cleaned = str(raw_p or "").strip().strip("'\"")
    if not cleaned:
        return {"exempt": False, "rel": ""}
    if cleaned == "/dev/null" or re.match(r"^/(?:private/)?tmp(?:/|\Z)", cleaned):
        return {"exempt": True, "rel": ""}
    if cleaned.startswith("$") or cleaned.startswith("~"):
        return {"exempt": False, "rel": ""}
    abs_p = resolve_real(cleaned, ws_root)
    if abs_p == ws_root:
        return {"exempt": False, "rel": ""}
    try:
        rel = abs_p.relative_to(ws_root).as_posix()
    except ValueError:
        return {"exempt": True, "rel": ""}
    if not rel:
        return {"exempt": False, "rel": ""}
    if is_harness_internal(rel) or is_trivial_exempt_path(rel):
        return {"exempt": True, "rel": rel}
    return {"exempt": False, "rel": rel}


def classify_ws_mutation_path(raw_p, ws_root):
    cleaned = str(raw_p or "").strip().strip("'\"")
    if not cleaned:
        return {"exempt": False, "rel": ""}
    if cleaned == "/dev/null" or re.match(r"^/(?:private/)?tmp(?:/|\Z)", cleaned):
        return {"exempt": True, "rel": ""}
    if cleaned.startswith("$") or cleaned.startswith("~"):
        return {"exempt": False, "rel": ""}
    abs_p = resolve_real(cleaned, ws_root)
    if abs_p == ws_root:
        return {"exempt": False, "rel": ""}
    try:
        rel = abs_p.relative_to(ws_root).as_posix()
    except ValueError:
        return {"exempt": True, "rel": ""}
    if not rel:
        return {"exempt": False, "rel": ""}
    if is_harness_internal(rel):
        return {"exempt": True, "rel": ""}
    return {"exempt": False, "rel": rel}


def split_heredocs(cmd):
    lines = str(cmd or "").replace("\r\n", "\n").split("\n")
    items = []
    i = 0
    while i < len(lines):
        line = lines[i]
        m = re.search(r"<<(-?)\s*['\"]?([A-Za-z_][A-Za-z0-9_-]*)['\"]?", line)
        if m:
            strip_tabs = m.group(1) == "-"
            tag = m.group(2)
            body = []
            i += 1
            while i < len(lines):
                cmp_line = lines[i].lstrip("\t") if strip_tabs else lines[i]
                if cmp_line == tag:
                    i += 1
                    break
                body.append(lines[i])
                i += 1
            items.append((line, "\n".join(body)))
        else:
            items.append((line, ""))
            i += 1
    return items


def read_word(s, idx):
    n = len(s)
    while idx < n and s[idx] in (" ", "\t"):
        idx += 1
    out = []
    in_s = False
    in_d = False
    while idx < n:
        ch = s[idx]
        if in_s:
            if ch == "'":
                in_s = False
            else:
                out.append(ch)
            idx += 1
        elif in_d:
            if ch == "\\" and idx + 1 < n:
                out.append(s[idx + 1])
                idx += 2
            elif ch == '"':
                in_d = False
                idx += 1
            else:
                out.append(ch)
                idx += 1
        else:
            if ch == "\\" and idx + 1 < n:
                out.append(s[idx + 1])
                idx += 2
            elif ch == "'":
                in_s = True
                idx += 1
            elif ch == '"':
                in_d = True
                idx += 1
            elif ch in " \t;&|><":
                break
            else:
                out.append(ch)
                idx += 1
    return "".join(out), idx


def tokenize_shell_line(line):
    segs = []
    tokens = []
    redirects = []
    has_hd = False
    piped = False
    cur = []
    cur_q = False
    has_cur = False
    in_s = False
    in_d = False

    def flush_tok():
        nonlocal cur, cur_q, has_cur
        if has_cur:
            tokens.append(("".join(cur), cur_q))
            cur = []
            cur_q = False
            has_cur = False

    def flush_seg(is_pipe):
        nonlocal tokens, redirects, has_hd, piped
        flush_tok()
        if tokens or redirects:
            segs.append((tokens, redirects, has_hd, piped))
        tokens = []
        redirects = []
        has_hd = False
        piped = is_pipe

    i = 0
    n = len(line)
    while i < n:
        ch = line[i]
        if in_s:
            if ch == "'":
                in_s = False
            else:
                cur.append(ch)
            i += 1
            continue
        if in_d:
            if ch == "\\" and i + 1 < n:
                cur.append(line[i + 1])
                i += 2
            elif ch == '"':
                in_d = False
                i += 1
            else:
                cur.append(ch)
                i += 1
            continue
        if ch == "\\" and i + 1 < n:
            has_cur = True
            cur.append(line[i + 1])
            i += 2
            continue
        if ch == "'":
            in_s = True
            cur_q = True
            has_cur = True
            i += 1
            continue
        if ch == '"':
            in_d = True
            cur_q = True
            has_cur = True
            i += 1
            continue
        if ch in (" ", "\t"):
            flush_tok()
            i += 1
            continue
        if ch == ";":
            flush_seg(False)
            i += 1
            continue
        if ch == "&" and i + 1 < n and line[i + 1] == "&":
            flush_seg(False)
            i += 2
            continue
        if ch == "|" and i + 1 < n and line[i + 1] == "|":
            flush_seg(False)
            i += 2
            continue
        if ch == "|":
            flush_seg(True)
            i += 1
            continue
        if ch == "<":
            if i + 1 < n and line[i + 1] == "<":
                flush_tok()
                has_hd = True
                i += 2
                if i < n and line[i] in ("-", "<"):
                    i += 1
                _, i = read_word(line, i)
            else:
                if has_cur and "".join(cur).isdigit():
                    cur = []
                    has_cur = False
                else:
                    flush_tok()
                i += 1
                if i < n and line[i] == "&":
                    i += 1
                    while i < n and (line[i].isdigit() or line[i] == "-"):
                        i += 1
                else:
                    _, i = read_word(line, i)
            continue
        if ch == ">":
            cur_s = "".join(cur)
            if has_cur and cur_s in ("=", "-") and not cur_q:
                cur.append(ch)
                i += 1
                continue
            if has_cur and (cur_s.isdigit() or cur_s == "&") and not cur_q:
                cur = []
                has_cur = False
            else:
                flush_tok()
            i += 1
            if i < n and line[i] == ">":
                i += 1
            if i < n and line[i] == "&":
                i += 1
                while i < n and (line[i].isdigit() or line[i] == "-"):
                    i += 1
            else:
                w, i = read_word(line, i)
                redirects.append(w)
            continue
        if ch == "&" and i + 1 < n and line[i + 1] == ">":
            flush_tok()
            i += 2
            if i < n and line[i] == ">":
                i += 1
            w, i = read_word(line, i)
            redirects.append(w)
            continue
        has_cur = True
        cur.append(ch)
        i += 1
    flush_seg(False)
    return segs


def inspect_node_targets(code):
    write_re = re.compile(
        r"\b(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|rmSync|rm|unlinkSync|unlink|renameSync|rename|copyFileSync|copyFile|cpSync|cp|truncateSync|truncate|openSync)\s*\("
    )
    targets = []
    untargeted = False
    matched = False
    for m in write_re.finditer(code):
        fn = re.sub(r"\s*\($", "", m.group(0))
        open_idx = m.end() - 1
        depth = 1
        j = open_idx + 1
        in_s = in_d = in_b = False
        n = len(code)
        while j < n and depth > 0:
            c = code[j]
            if in_s:
                if c == "\\" and j + 1 < n: j += 2
                elif c == "'": in_s = False; j += 1
                else: j += 1
            elif in_d:
                if c == "\\" and j + 1 < n: j += 2
                elif c == '"': in_d = False; j += 1
                else: j += 1
            elif in_b:
                if c == "\\" and j + 1 < n: j += 2
                elif c == "`": in_b = False; j += 1
                else: j += 1
            else:
                if c == "'": in_s = True
                elif c == '"': in_d = True
                elif c == "`": in_b = True
                elif c == "(": depth += 1
                elif c == ")": depth -= 1
                j += 1
        arg_slice = code[open_idx + 1:max(open_idx + 1, j - 1)]
        if fn == "openSync" and re.search(r"['\"]r", arg_slice) and not re.search(r"['\"][wa+]", arg_slice):
            continue
        matched = True
        lits = [lm.group(1) for lm in re.finditer(r"['\"`]([^'\"`\r\n]+)['\"`]", arg_slice)]
        cands = lits[:2] if fn in ("renameSync", "rename", "copyFileSync", "copyFile", "cpSync", "cp") else lits[:1]
        if not cands:
            untargeted = True
        else:
            targets.extend(cands)
    return {"matched": matched, "targets": targets, "untargeted": untargeted}


def inspect_python_targets(code):
    targets = []
    untargeted = False
    matched = False
    covered = []
    for pm in re.finditer(
        r"Path\s*\(\s*([^\)]*)\)\s*\.\s*(?:write_text|write_bytes|unlink|rename|replace|mkdir|rmdir)\s*\(([^\)]*)\)",
        code,
    ):
        covered.append((pm.start(), pm.end()))
        matched = True
        pl = re.search(r"['\"]([^'\"\r\n]+)['\"]", pm.group(1))
        if pl:
            targets.append(pl.group(1))
        else:
            untargeted = True
        if re.search(r"\.(?:rename|replace)\s*\(", pm.group(0)):
            dl = re.search(r"['\"]([^'\"\r\n]+)['\"]", pm.group(2))
            if dl:
                targets.append(dl.group(1))
            else:
                untargeted = True
    for bw in re.finditer(r"\.\s*(?:write_text|write_bytes|writelines)\s*\(", code):
        if not any(s <= bw.start() <= e for s, e in covered):
            matched = True
            untargeted = True
    for om in re.finditer(r"\bopen\s*\(([^\)]*)\)", code):
        inside = om.group(1)
        mm = re.search(r",\s*(?:mode\s*=\s*)?['\"]([rwaAxbtU+]+)['\"]", inside)
        if mm and not re.search(r"[wax+]", mm.group(1), re.IGNORECASE):
            continue
        if not mm and "," not in inside:
            continue
        matched = True
        pl = re.match(r"^\s*['\"]([^'\"\r\n]+)['\"]", inside)
        if pl:
            targets.append(pl.group(1))
        else:
            untargeted = True
    for sm in re.finditer(
        r"\b(?:shutil\.(?:copy\w*|move|rmtree)|os\.(?:remove|unlink|rename|replace|rmdir|makedirs?))\s*\(([^\)]*)\)",
        code,
    ):
        matched = True
        lits = re.findall(r"['\"]([^'\"\r\n]+)['\"]", sm.group(1))
        if not lits:
            untargeted = True
        else:
            targets.extend(lits)
    return {"matched": matched, "targets": targets, "untargeted": untargeted}


def inspect_shell_mutations(cmd, depth=0):
    writes = []
    mutating_ops = []

    def record_target(raw_p, op):
        cleaned = str(raw_p or "").strip().strip("'\"")
        if cleaned == "/dev/null":
            return
        writes.append({"raw": cleaned, "op": op})

    wrappers = {"command", "sudo", "env", "time", "nohup", "exec"}
    for line, heredoc in split_heredocs(cmd):
        segs = tokenize_shell_line(line)
        for s_idx, (tokens, redirects, has_hd, piped) in enumerate(segs):
            for rt in redirects:
                record_target(rt, "redirection")
            idx = 0
            while idx < len(tokens):
                v = tokens[idx][0]
                if re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", v) or v in wrappers:
                    idx += 1
                    continue
                break
            if idx >= len(tokens):
                continue
            cmd_word = posixpath.basename(tokens[idx][0])
            arg_vals = [t[0] for t in tokens[idx + 1:]]

            if cmd_word == "tee":
                files = [a for a in arg_vals if not a.startswith("-")]
                if not files:
                    mutating_ops.append("tee")
                else:
                    for f in files:
                        record_target(f, "tee")
            elif cmd_word in ("rm", "unlink", "touch", "mkdir", "rmdir"):
                after_dd = False
                files = []
                k = 0
                while k < len(arg_vals):
                    a = arg_vals[k]
                    if not after_dd and a == "--":
                        after_dd = True
                        k += 1
                        continue
                    if not after_dd and a.startswith("-"):
                        if cmd_word == "touch" and a in ("-d", "-t", "-r"):
                            k += 1
                        k += 1
                        continue
                    files.append(a)
                    k += 1
                if not files:
                    mutating_ops.append(cmd_word)
                else:
                    for f in files:
                        record_target(f, cmd_word)
            elif cmd_word in ("mv", "ln"):
                files = []
                k = 0
                while k < len(arg_vals):
                    a = arg_vals[k]
                    if a in ("-t", "-S"):
                        if a == "-t" and k + 1 < len(arg_vals):
                            files.append(arg_vals[k + 1])
                        k += 2
                        continue
                    if a.startswith("--target-directory="):
                        files.append(a[19:])
                        k += 1
                        continue
                    if a.startswith("-"):
                        k += 1
                        continue
                    files.append(a)
                    k += 1
                if not files:
                    mutating_ops.append(cmd_word)
                else:
                    for f in files:
                        record_target(f, cmd_word)
            elif cmd_word in ("cp", "install"):
                target_dir = ""
                files = []
                k = 0
                while k < len(arg_vals):
                    a = arg_vals[k]
                    if a == "-t" and k + 1 < len(arg_vals):
                        target_dir = arg_vals[k + 1]
                        k += 2
                        continue
                    if a.startswith("--target-directory="):
                        target_dir = a[19:]
                        k += 1
                        continue
                    if cmd_word == "install" and a in ("-m", "-o", "-g"):
                        k += 2
                        continue
                    if a.startswith("-"):
                        k += 1
                        continue
                    files.append(a)
                    k += 1
                if target_dir:
                    record_target(target_dir, cmd_word)
                elif files:
                    record_target(files[-1], cmd_word)
                else:
                    mutating_ops.append(cmd_word)
            elif cmd_word == "sed":
                if any(re.match(r"^-[A-Za-z]*i", a) or a == "--in-place" or a.startswith("--in-place=") for a in arg_vals):
                    saw_sf = False
                    pos = []
                    k = 0
                    while k < len(arg_vals):
                        a = arg_vals[k]
                        if a == "-i":
                            if k + 1 < len(arg_vals) and arg_vals[k + 1] == "":
                                k += 1
                            k += 1
                            continue
                        if re.match(r"^-[A-Za-z]*i", a) or a == "--in-place" or a.startswith("--in-place="):
                            k += 1
                            continue
                        if a in ("-e", "-f"):
                            saw_sf = True
                            k += 2
                            continue
                        if a.startswith("--expression=") or a.startswith("--file="):
                            saw_sf = True
                            k += 1
                            continue
                        if a.startswith("-"):
                            k += 1
                            continue
                        pos.append(a)
                        k += 1
                    files = pos if saw_sf else pos[1:]
                    if not files:
                        mutating_ops.append("sed -i")
                    else:
                        for f in files:
                            record_target(f, "sed -i")
            elif cmd_word == "perl":
                if any(re.match(r"^-[A-Za-z]*i", a) or a == "--in-place" or a.startswith("--in-place=") for a in arg_vals):
                    files = []
                    k = 0
                    while k < len(arg_vals):
                        a = arg_vals[k]
                        if a in ("-e", "-E", "-I", "-M"):
                            k += 2
                            continue
                        if a.startswith("-"):
                            k += 1
                            continue
                        files.append(a)
                        k += 1
                    if not files:
                        mutating_ops.append("perl -i")
                    else:
                        for f in files:
                            record_target(f, "perl -i")
            elif cmd_word == "patch":
                if not any(a in ("--dry-run", "-C") for a in arg_vals):
                    dir_target = ""
                    out_target = ""
                    k = 0
                    while k < len(arg_vals):
                        a = arg_vals[k]
                        if a in ("-d", "--directory") and k + 1 < len(arg_vals):
                            dir_target = arg_vals[k + 1]
                            k += 2
                            continue
                        if a.startswith("--directory="):
                            dir_target = a[12:]
                        elif a in ("-o", "--output") and k + 1 < len(arg_vals):
                            out_target = arg_vals[k + 1]
                            k += 2
                            continue
                        k += 1
                    if out_target:
                        record_target(out_target, "patch")
                    elif dir_target:
                        record_target(dir_target, "patch")
                    else:
                        mutating_ops.append("patch")
            elif cmd_word == "dd":
                for a in arg_vals:
                    if a.startswith("of="):
                        record_target(a[3:], "dd of=")
            elif cmd_word == "truncate":
                files = []
                k = 0
                while k < len(arg_vals):
                    a = arg_vals[k]
                    if a in ("-s", "-r", "--size", "--reference"):
                        k += 2
                        continue
                    if a.startswith("-"):
                        k += 1
                        continue
                    files.append(a)
                    k += 1
                if not files:
                    mutating_ops.append("truncate")
                else:
                    for f in files:
                        record_target(f, "truncate")
            elif cmd_word in ("chmod", "chown"):
                mutating_ops.append(cmd_word)
            elif cmd_word == "git":
                git_dir = ""
                k = 0
                while k < len(arg_vals):
                    a = arg_vals[k]
                    if a == "-C" and k + 1 < len(arg_vals):
                        git_dir = arg_vals[k + 1]
                        k += 2
                        continue
                    if a in ("-c", "--git-dir", "--work-tree", "--namespace") and k + 1 < len(arg_vals):
                        k += 2
                        continue
                    if a.startswith("-"):
                        k += 1
                        continue
                    break
                sub = arg_vals[k] if k < len(arg_vals) else ""
                sub_args = arg_vals[k + 1:]
                scope = git_dir or "."
                if sub == "apply":
                    if not any(a in ("--check", "--stat", "--numstat", "--summary") for a in sub_args):
                        record_target(scope, "git apply")
                elif sub == "restore":
                    files = [a for a in sub_args if a != "--" and not a.startswith("-")]
                    if not files:
                        record_target(scope, "git restore")
                    else:
                        for f in files:
                            record_target(posixpath.join(git_dir, f) if git_dir else f, "git restore")
                elif sub == "checkout" and "--" in sub_args:
                    files = sub_args[sub_args.index("--") + 1:]
                    if not files:
                        record_target(scope, "git checkout --")
                    else:
                        for f in files:
                            record_target(posixpath.join(git_dir, f) if git_dir else f, "git checkout --")
                elif sub == "reset" and any(a in ("--hard", "--merge") for a in sub_args):
                    record_target(scope, "git reset --hard")
                elif sub == "clean" and not any(a == "--dry-run" or re.match(r"^-[A-Za-z]*n", a) for a in sub_args):
                    record_target(scope, "git clean")
                elif sub in ("merge", "cherry-pick", "am", "revert", "rebase", "mv", "rm"):
                    record_target(scope, "git " + sub)
                elif sub in ("commit", "push", "add", "stage", "switch", "pull", "fetch", "init", "clone"):
                    mutating_ops.append("git " + sub)
                elif sub == "stash" and (not sub_args or sub_args[0] not in ("list", "show")):
                    mutating_ops.append("git stash")
                elif sub == "branch" and any(re.match(r"^-(?:[dDmMcC]|-delete|-move|-copy)$", a) for a in sub_args):
                    mutating_ops.append("git branch")
                elif sub == "diff" and any(a == "--output" or a.startswith("--output=") for a in sub_args):
                    mutating_ops.append("git diff --output")
            elif cmd_word == "node":
                codes = []
                k = 0
                while k < len(arg_vals):
                    a = arg_vals[k]
                    if a in ("-e", "--eval", "-p", "--print") and k + 1 < len(arg_vals):
                        codes.append(arg_vals[k + 1])
                        k += 2
                        continue
                    if a.startswith("--eval="):
                        codes.append(a[7:])
                    elif a == "-" and heredoc:
                        codes.append(heredoc)
                    k += 1
                if (has_hd or piped) and heredoc:
                    codes.append(heredoc)
                if piped and s_idx > 0:
                    codes.append(" ".join(t[0] for t in segs[s_idx - 1][0]))
                for c in codes:
                    res = inspect_node_targets(c)
                    if res["matched"]:
                        if res["untargeted"] or not res["targets"]:
                            mutating_ops.append("node inline write")
                        else:
                            for t in res["targets"]:
                                record_target(t, "node inline write")
            elif cmd_word in ("python", "python3"):
                codes = []
                k = 0
                while k < len(arg_vals):
                    a = arg_vals[k]
                    if a == "-c" and k + 1 < len(arg_vals):
                        codes.append(arg_vals[k + 1])
                        k += 2
                        continue
                    if a.startswith("-c") and len(a) > 2:
                        codes.append(a[2:])
                    elif a == "-" and heredoc:
                        codes.append(heredoc)
                    k += 1
                if (has_hd or piped) and heredoc:
                    codes.append(heredoc)
                if piped and s_idx > 0:
                    codes.append(" ".join(t[0] for t in segs[s_idx - 1][0]))
                for c in codes:
                    res = inspect_python_targets(c)
                    if res["matched"]:
                        if res["untargeted"] or not res["targets"]:
                            mutating_ops.append("python inline write")
                        else:
                            for t in res["targets"]:
                                record_target(t, "python inline write")
            elif cmd_word in ("sh", "bash", "zsh") and depth < 1:
                for k in range(len(arg_vals) - 1):
                    if arg_vals[k] == "-c":
                        sub_res = inspect_shell_mutations(arg_vals[k + 1], depth + 1)
                        writes.extend(sub_res["writes"])
                        mutating_ops.extend(sub_res["mutatingOps"])
    return {"writes": writes, "mutatingOps": mutating_ops}


def detect_shell_write_bypass(cmd, ws_root):
    mut = inspect_shell_mutations(cmd, 0)
    summaries = []
    targets = []
    untargeted = False
    matched = False
    for w in mut["writes"]:
        cls = classify_ws_mutation_path(w["raw"], ws_root)
        if not cls["exempt"]:
            matched = True
            summaries.append(w["op"])
            if cls["rel"]:
                targets.append(cls["rel"])
            else:
                untargeted = True
    for op in mut["mutatingOps"]:
        if not op.startswith("git "):
            matched = True
            untargeted = True
            summaries.append(op)
    return {"matched": matched, "targets": targets, "untargeted": untargeted, "summaries": summaries}


def analyze_run_command(cmd, ws_root, depth=0):
    saw_edit = False
    saw_full_gate = False
    edit_after_gate = False

    def mark_edit():
        nonlocal saw_edit, edit_after_gate
        saw_edit = True
        edit_after_gate = True

    def mark_gate():
        nonlocal saw_full_gate, edit_after_gate
        saw_full_gate = True
        edit_after_gate = False

    wrappers = {"command", "sudo", "env", "time", "nohup", "exec"}
    for line, heredoc in split_heredocs(cmd):
        segs = tokenize_shell_line(line)
        for tokens, redirects, has_hd, piped in segs:
            idx = 0
            while idx < len(tokens):
                v = tokens[idx][0]
                if re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", v) or v in wrappers:
                    idx += 1
                    continue
                break
            if idx < len(tokens):
                raw_cmd = tokens[idx][0]
                cmd_word = posixpath.basename(raw_cmd)
                arg_vals = [t[0] for t in tokens[idx + 1:]]
                is_direct_gate = bool(re.search(r"(?:^|/)gate-check\.sh$", raw_cmd.replace("\\", "/")))
                is_shell_gate = cmd_word in ("sh", "bash", "zsh") and any(
                    re.search(r"(?:^|/)gate-check\.sh$", a.replace("\\", "/")) for a in arg_vals
                )
                if (is_direct_gate or is_shell_gate) and "--fast" not in arg_vals:
                    mark_gate()
                    continue
                if cmd_word in ("sh", "bash", "zsh") and depth < 1:
                    handled_sub = False
                    for k in range(len(arg_vals) - 1):
                        if arg_vals[k] == "-c":
                            handled_sub = True
                            sub_res = analyze_run_command(arg_vals[k + 1], ws_root, depth + 1)
                            if sub_res["sawEdit"]:
                                saw_edit = True
                                edit_after_gate = sub_res["editAfterGate"]
                            if sub_res["sawFullGate"]:
                                saw_full_gate = True
                                if not sub_res["editAfterGate"]:
                                    edit_after_gate = False
                    if handled_sub:
                        continue

            seg_str = " ".join(json.dumps(t[0]) for t in tokens) + "".join(" > " + json.dumps(r) for r in redirects)
            full_seg = f"{seg_str} <<'EOF'\n{heredoc}\nEOF" if (has_hd and heredoc) else seg_str
            mut = inspect_shell_mutations(full_seg, 0)
            for w in mut["writes"]:
                if not classify_path_target(w["raw"], ws_root)["exempt"]:
                    mark_edit()
            for op in mut["mutatingOps"]:
                if not op.startswith("git "):
                    mark_edit()

    return {"sawEdit": saw_edit, "sawFullGate": saw_full_gate, "editAfterGate": edit_after_gate}


def detect_blacklisted_command(cmd, depth=0):
    container_bins = {"docker", "docker-compose", "podman", "colima", "orbstack", "kubectl", "helm", "kind", "minikube", "testcontainers"}
    search_bins = {"grep", "egrep", "fgrep", "rg", "ag", "ack"}

    def first_non_flag(arg_vals, value_flags):
        out = []
        i = 0
        while i < len(arg_vals):
            a = arg_vals[i]
            if a == "--":
                break
            if a in value_flags and i + 1 < len(arg_vals):
                i += 2
                continue
            if a.startswith("-"):
                i += 1
                continue
            out.append(a)
            i += 1
        return out

    wrappers = {"command", "sudo", "env", "time", "nohup", "exec"}
    for line, _ in split_heredocs(cmd):
        for tokens, _, _, _ in tokenize_shell_line(line):
            idx = 0
            env_toks = []
            while idx < len(tokens):
                v = tokens[idx][0]
                if re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", v):
                    env_toks.append(v)
                    idx += 1
                    continue
                if v in wrappers:
                    idx += 1
                    continue
                break
            if idx >= len(tokens):
                continue
            cmd_word = posixpath.basename(tokens[idx][0])
            arg_vals = [t[0] for t in tokens[idx + 1:]]
            is_search = cmd_word in search_bins

            if cmd_word in container_bins:
                return cmd_word
            if not is_search:
                for t in env_toks + arg_vals:
                    if re.search(r"\btestcontainers\b", t, re.IGNORECASE):
                        return "testcontainers"
                if any(a == "--watch" or (a.startswith("--watch=") and not re.match(r"^--watch=(?:false|0|off|none)$", a, re.IGNORECASE)) for a in arg_vals):
                    return "--watch"
                if any(a in ("-it", "-ti") for a in arg_vals):
                    return "-it"

            if cmd_word in ("npm", "pnpm", "yarn", "bun"):
                pos = first_non_flag(arg_vals, {"--prefix", "-C", "--cwd", "--filter"})
                if pos and re.match(r"^(?:install|i|add|ci)$", pos[0]):
                    return cmd_word + " " + pos[0]
            elif cmd_word in ("pip", "pip3", "poetry"):
                pos = first_non_flag(arg_vals, {"--python", "-C", "--directory"})
                if pos and pos[0] == "install":
                    return cmd_word + " install"
            elif cmd_word == "uv":
                pos = first_non_flag(arg_vals, {"--python", "--directory"})
                if pos and (pos[0] == "install" or (len(pos) >= 2 and pos[0] in ("pip", "pip3") and pos[1] == "install")):
                    return "uv install"
            elif cmd_word in ("python", "python3"):
                for k in range(len(arg_vals) - 2):
                    if arg_vals[k] == "-m" and arg_vals[k + 1] in ("pip", "pip3") and arg_vals[k + 2] == "install":
                        return cmd_word + " -m pip install"
            elif cmd_word == "go":
                pos = first_non_flag(arg_vals, {"-C"})
                if len(pos) >= 2 and pos[0] == "mod" and pos[1] in ("download", "tidy"):
                    return "go mod " + pos[1]
            elif cmd_word == "flutter":
                pos = first_non_flag(arg_vals, set())
                if len(pos) >= 2 and pos[0] == "pub" and pos[1] == "get":
                    return "flutter pub get"
            elif cmd_word == "pod":
                pos = first_non_flag(arg_vals, set())
                if pos and pos[0] == "install":
                    return "pod install"
            elif cmd_word == "tail":
                if any(re.match(r"^-[A-Za-z]*[fF]", a) or re.match(r"^--follow(?:=|$)", a) for a in arg_vals):
                    return "tail -f"
            elif cmd_word == "logs" or (arg_vals and arg_vals[0] == "logs"):
                if any(re.match(r"^-[A-Za-z]*f", a) or re.match(r"^--follow(?:=|$)", a) for a in arg_vals):
                    return "logs -f"
            elif cmd_word in ("sh", "bash", "zsh") and depth < 1:
                for k in range(len(arg_vals) - 1):
                    if arg_vals[k] == "-c":
                        inner = detect_blacklisted_command(arg_vals[k + 1], depth + 1)
                        if inner:
                            return inner
    return ""


def compute_workspace_fingerprint(ws_root):
    try:
        head_proc = subprocess.run(
            ["git", "rev-parse", "--verify", "HEAD"],
            cwd=str(ws_root),
            capture_output=True,
            text=True,
            check=False,
        )
        if head_proc.returncode != 0 or not head_proc.stdout.strip():
            return None
        head_oid = head_proc.stdout.strip()
        st_proc = subprocess.run(
            ["git", "--no-pager", "status", "--porcelain=v1", "-uall"],
            cwd=str(ws_root),
            capture_output=True,
            text=True,
            check=False,
        )
        if st_proc.returncode != 0:
            return None
        lines = []
        for raw in st_proc.stdout.splitlines():
            ln = raw.rstrip("\r")
            if not ln:
                continue
            rp = ln[3:].strip()
            if " -> " in rp:
                rp = rp.split(" -> ")[-1].strip()
            rp = rp.strip('"').replace("\\", "/")
            if is_harness_internal(rp):
                continue
            lines.append(ln)
        lines.sort()
        parts = [f"HEAD:{head_oid}"]
        for ln in lines:
            rp = ln[3:].strip()
            if " -> " in rp:
                rp = rp.split(" -> ")[-1].strip()
            rp = rp.strip('"')
            abs_p = ws_root / rp
            file_hash = "MISSING"
            try:
                if abs_p.exists() and abs_p.is_file():
                    file_hash = hashlib.sha256(abs_p.read_bytes()).hexdigest()
            except Exception:
                pass
            parts.append(f"{ln}::{file_hash}")
        return sha256_hex("\n".join(parts))
    except Exception:
        return None


def get_gate_fingerprint_path(ws_root, state_dir):
    ws_hash = sha256_hex(str(ws_root))[:24]
    return state_dir / f"gate-fp-{ws_hash}.json"


def did_transcript_mutate(transcript_path, ws_root):
    if not transcript_path or not os.path.exists(transcript_path):
        return False
    try:
        lines = pathlib.Path(transcript_path).read_text(encoding="utf-8", errors="ignore").splitlines()
    except Exception:
        return False
    mutated = False
    for raw in lines:
        if not raw.strip():
            continue
        try:
            step = json.loads(raw)
        except Exception:
            continue
        if not isinstance(step, dict):
            continue
        for tc in (step.get("tool_calls") or []):
            tc_name = str((tc or {}).get("name") or "")
            tc_args = (tc or {}).get("args") or {}
            if tc_name in EDIT_TOOLS:
                raw_target = extract_target_path(tc_args)
                if not raw_target:
                    mutated = True
                else:
                    abs_t = resolve_real(raw_target, ws_root)
                    try:
                        rel = abs_t.relative_to(ws_root).as_posix()
                        if rel and not is_harness_internal(rel) and not is_trivial_exempt_path(rel):
                            mutated = True
                    except ValueError:
                        pass
            elif tc_name == "run_command":
                cmd = str(tc_args.get("CommandLine") or tc_args.get("command") or "")
                if cmd.strip():
                    res = analyze_run_command(cmd, ws_root, 0)
                    if res["sawFullGate"] and not res["editAfterGate"]:
                        mutated = False
                    elif res["sawEdit"]:
                        mutated = True
            elif tc_name == "invoke_subagent":
                sub_type = str(tc_args.get("TypeName") or tc_args.get("typeName") or tc_args.get("subagent_type") or "").strip()
                if sub_type not in READ_ONLY_SUBAGENTS:
                    mutated = True
            elif tc_name == "swarm" and str(tc_args.get("action") or "").strip() == "add":
                mutated = True
            elif tc_name == "run_workflow":
                mutated = True
    return mutated
