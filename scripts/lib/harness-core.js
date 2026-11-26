'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const EDIT_TOOLS = new Set([
  'write_file',
  'edit_file',
  'create_file',
  'delete_file',
  'sed_file',
  'write_to_file',
  'replace_file_content',
  'multi_replace_file_content',
]);

const READ_ONLY_SUBAGENTS = new Set(['arch-redteam', 'staff-gatekeeper', 'research']);

const LOCKED_CONTRACTS = new Set([
  '.artifacts/SPEC.md',
  '.artifacts/CONSTRAINTS.md',
  '.artifacts/PLAN.md',
]);

function sha256(s) {
  return crypto.createHash('sha256').update(String(s || '')).digest('hex');
}

function resolveReal(targetPath, baseDir) {
  const parts = [];
  let cur = path.resolve(baseDir, String(targetPath || ''));
  while (!fs.existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    parts.unshift(path.basename(cur));
    cur = parent;
  }
  let realBase = cur;
  try {
    realBase = fs.realpathSync(cur);
  } catch {}
  return parts.length ? path.join(realBase, ...parts) : realBase;
}

function resolveWorkspaceRoot(input, pluginMode, fallbackRepoRoot) {
  const wsList = Array.isArray(input && input.workspacePaths) ? input.workspacePaths : [];
  const rawWs =
    (wsList[0] && fs.existsSync(String(wsList[0])) && String(wsList[0])) ||
    (wsList[0] && String(wsList[0])) ||
    (input && input.cwd && String(input.cwd)) ||
    (pluginMode ? process.cwd() : fallbackRepoRoot) ||
    process.cwd();
  return resolveReal(rawWs, process.cwd());
}

function hasHarnessInWorkspace(workspaceRoot) {
  return (
    fs.existsSync(path.join(workspaceRoot, '.agents', 'rules', 'agy-harness.md')) ||
    fs.existsSync(path.join(workspaceRoot, '.artifacts', 'SPEC.md')) ||
    fs.existsSync(path.join(workspaceRoot, '.artifacts', 'PLAN.md'))
  );
}

function isSelfHostingRepo(workspaceRoot) {
  try {
    const pjPath = path.join(workspaceRoot, 'plugin.json');
    if (fs.existsSync(pjPath)) {
      const pj = JSON.parse(fs.readFileSync(pjPath, 'utf8'));
      return Boolean(pj && pj.name === 'agy-harness');
    }
  } catch {}
  return false;
}

function getStateDir() {
  return (
    process.env.AGY_HARNESS_STATE_DIR ||
    process.env.PLUGIN_DATA ||
    path.join(os.tmpdir(), 'agy-harness-approvals')
  );
}

function readJsonSafe(p) {
  if (!fs.existsSync(p)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeJsonSafe(p, obj) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
  } catch {}
}

function isHarnessInternal(relPath) {
  const rel = String(relPath || '').replace(/\\/g, '/');
  return (
    rel === '.artifacts' ||
    rel.startsWith('.artifacts/') ||
    rel === '.agents' ||
    rel.startsWith('.agents/')
  );
}

function isTrivialExemptPath(relPath) {
  const rel = String(relPath || '').replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
  if (!rel || /^(?:agents|skills|commands)(?:\/|$)/.test(rel)) return false;
  const base = path.posix.basename(rel);
  return (
    /\.(?:md|mdx|txt|rst|adoc)$/i.test(rel) ||
    /^(?:LICENSE(?:\.[A-Za-z0-9._-]+)?|NOTICE|AUTHORS|CONTRIBUTORS|PATENTS|CODEOWNERS|\.(?:gitignore|gitattributes|editorconfig|prettierignore|eslintignore|dockerignore|npmrc|nvmrc|node-version|python-version|tool-versions)|\.env\.(?:example|sample|template))$/i.test(base) ||
    /(?:^|\/)(?:plugin|marketplace)\.json$/i.test(rel) ||
    /(?:^|\/)(?:version\.txt|VERSION)$/.test(rel) ||
    /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|go\.sum|pubspec\.lock|Gemfile\.lock|composer\.lock)$/.test(rel) ||
    /\.(?:svg|png|jpe?g|gif|webp|ico|woff2?|ttf|otf|eot)$/i.test(rel) ||
    /\.(?:css|scss|sass|less)$/i.test(rel) ||
    /(?:^|\/)(?:locales|i18n|messages)\/.*\.json$/i.test(rel)
  );
}

function extractTargetPath(args) {
  if (!args || typeof args !== 'object') return '';
  return String(
    args.Path ||
      args.TargetFile ||
      args.TargetPath ||
      args.File ||
      args.path ||
      args.file ||
      args.file_path ||
      args.filePath ||
      args.target_file ||
      ''
  )
    .replace(/^"+|"+$/g, '')
    .trim();
}

function extractText(val) {
  if (typeof val === 'string') return val;
  if (Array.isArray(val)) return val.map(extractText).join('\n');
  if (val && typeof val === 'object') {
    if (typeof val.text === 'string') return val.text;
    if (typeof val.content === 'string') return val.content;
    return JSON.stringify(val);
  }
  return '';
}

function cleanUserMessage(raw) {
  return String(raw || '')
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '')
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, '')
    .replace(/<\/?USER_REQUEST>/gi, '')
    .trim();
}

function detectIsParent(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return false;
  let content = '';
  try {
    content = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    return false;
  }
  let sawFirstSystem = false;
  let hasUserInput = false;
  for (const rawLine of content.split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(rawLine);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== 'object') continue;
    if (!sawFirstSystem && obj.type === 'SYSTEM_MESSAGE') {
      sawFirstSystem = true;
      const msg = typeof obj.content === 'string' ? obj.content : JSON.stringify(obj.content || '');
      if (msg.includes('[Message]') && msg.includes('sender=')) {
        return false;
      }
    }
    if (obj.type === 'USER_INPUT' || obj.source === 'USER_EXPLICIT') {
      hasUserInput = true;
    }
  }
  return hasUserInput;
}

function stripFences(text, stripInlineBackticks) {
  const out = [];
  let inFence = false;
  for (const line of String(text || '').replace(/\r\n/g, '\n').split('\n')) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      out.push('');
      continue;
    }
    if (inFence) {
      out.push('');
      continue;
    }
    out.push(stripInlineBackticks ? line.replace(/`[^`]*`/g, '') : line);
  }
  return out.join('\n');
}

function stripNonContractSections(text) {
  const cleaned = String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/<!--\s*non-contract\s*-->[\s\S]*?<!--\s*\/non-contract\s*-->/gi, '');
  const nonContractHeadingRe =
    /^##\s+(?:Implementation Notes(?:\s*\/\s*Guardrails)?|Guardrails|实施备注|风险护栏)\b/i;
  const out = [];
  let skipping = false;
  for (const rawLine of cleaned.split('\n')) {
    if (/^##\s+/.test(rawLine)) {
      skipping = nonContractHeadingRe.test(rawLine);
    }
    if (!skipping) out.push(rawLine);
  }
  return out.join('\n');
}

function normalizeContract(text) {
  const contractOnly = stripNonContractSections(text);
  const out = [];
  for (const rawLine of contractOnly.split('\n')) {
    const normalized = rawLine
      .replace(/^(\s*-\s*)\[[ xX\/-]\](\s+)/, '$1[ ]$2')
      .replace(/^(\s*-\s*\*\*)(?:Status|状态)(:\*\*\s*).+$/, '$1Status$2<STATUS>');
    if (normalized.trim().length > 0) {
      out.push(normalized);
    }
  }
  return out.join('\n');
}

function hasSpecTemplateMarker(specTxt) {
  if (!String(specTxt || '').trim()) return true;
  const stripped = stripFences(specTxt, true);
  return (
    /^\s*-\s+\*\*Goal:\*\*\s+_Describe the concrete user or system problem being solved\._\s*$/m.test(stripped) ||
    /<!--\s*HARNESS_TEMPLATE_UNFILLED\b/i.test(stripped)
  );
}

function hasPlanTemplateMarker(planTxt) {
  if (!String(planTxt || '').trim()) return true;
  const stripped = stripFences(planTxt, true);
  return (
    /^\s*##\s+Slice 1:\s+\[Title\]\s*$/m.test(stripped) ||
    /<!--\s*HARNESS_TEMPLATE_UNFILLED\b/i.test(stripped)
  );
}

function isExplicitArchiveMarker(text) {
  return /<!--\s*HARNESS_STATUS:\s*(?:ARCHIVED|DONE|PAUSED)\s*-->/i.test(stripFences(text, true));
}

function isExplicitPausedMarker(text) {
  return /<!--\s*HARNESS_STATUS:\s*PAUSED\s*-->/i.test(stripFences(text, true));
}

function isSubagentOnlyPlan(text) {
  return /<!--\s*HARNESS_EXECUTION:\s*SUBAGENT_ONLY\s*-->/i.test(stripFences(text, true));
}

function countSpecCheckboxes(specTxt) {
  const body = stripFences(stripNonContractSections(specTxt), true);
  let done = 0;
  let open = 0;
  for (const line of body.split('\n')) {
    const m = line.match(/^\s*[-*]\s+\[([ xX\/])\](?:\s|$)/);
    if (!m) continue;
    if (m[1] === 'x' || m[1] === 'X') done++;
    else open++;
  }
  return { done, open };
}

function countPlanStatuses(planTxt) {
  const body = stripFences(stripNonContractSections(planTxt), false);
  let done = 0;
  let open = 0;
  for (const line of body.split('\n')) {
    const m =
      line.match(/^\s*(?:[-*]\s*)?(?:\*\*)?(?:Status|状态)(?:\*\*)?\s*:\s*(?:\*\*)?\s*`?\[([ xX\/])\]/i) ||
      line.match(/^\s*[-*]\s+\[([ xX\/])\](?:\s|$)/);
    if (!m) continue;
    if (m[1] === 'x' || m[1] === 'X') done++;
    else open++;
  }
  return { done, open };
}

function isExplicitUserApproval(msg) {
  if (!msg) return false;
  if (msg.includes('The user has approved this document.')) return true;
  if (/[?？]\s*$/.test(msg)) return false;
  if (/(?:吗|呢|么)[。.!！?？]*\s*$/.test(msg)) return false;
  if (
    /\b(?:not\s+(?:approved?|confirmed?)|don\x27?t\s+(?:approve|proceed|start|execute)|do\s+not\s+(?:approve|proceed|start|execute)|hold\s+on|wait|pause|hesitat\w*|reconsider|revise|modify|change\s+the\s+plan|instead|except|however|but\s+(?:first|before|wait|not)|maybe|not\s+sure|uncertain|let\x27?s\s+(?:rethink|discuss|wait|pause))\b/i.test(
      msg
    )
  ) {
    return false;
  }
  if (
    /(?:不同意|未同意|没同意|不批准|未批准|没批准|未确认|不确认|暂不|别开始|先别|先不要|暂缓|暂停|等一下|等等|再想想|修改|改一下|调整|重写|补充|疑问|不确定|有问题|不过|但是先|不要按|不能)/.test(
      msg
    )
  ) {
    return false;
  }
  if (/^(?:can|could|should|would|why|what|how|when|where|which|who|is|are|do|does|did|will)\b/i.test(msg)) {
    return false;
  }
  return (
    /\b(?:proceed|approved?|lgtm|confirmed?|go\s+ahead|looks\s+good)\b/i.test(msg) ||
    /(?:同意|批准|确认|继续执行|按方案执行|可以开始|按此执行|准许)/.test(msg) ||
    /^(?:yes|ok|okay|好的|可以|行)[.!。！]?$/i.test(msg)
  );
}

function getContractState(workspaceRoot, stateDir, conversationId, transcriptPath, lastUserInput) {
  const specPath = path.join(workspaceRoot, '.artifacts', 'SPEC.md');
  const planPath = path.join(workspaceRoot, '.artifacts', 'PLAN.md');
  const specExists = fs.existsSync(specPath);
  const planExists = fs.existsSync(planPath);
  const specTxt = specExists ? fs.readFileSync(specPath, 'utf8') : '';
  const planTxt = planExists ? fs.readFileSync(planPath, 'utf8') : '';

  const isExplicitlyArchived =
    (specExists && isExplicitArchiveMarker(specTxt)) ||
    (planExists && isExplicitArchiveMarker(planTxt));
  const isPaused =
    (specExists && isExplicitPausedMarker(specTxt)) ||
    (planExists && isExplicitPausedMarker(planTxt));
  const subagentOnly = planExists && isSubagentOnlyPlan(planTxt);

  const specFilled = specExists && !hasSpecTemplateMarker(specTxt);
  const planFilled = planExists && !hasPlanTemplateMarker(planTxt);
  const hasTemplatePlaceholder = !specFilled || !planFilled;
  const specCounts = countSpecCheckboxes(specTxt);
  const planCounts = countPlanStatuses(planTxt);
  const isAutoArchived =
    specFilled &&
    planFilled &&
    specCounts.done >= 1 &&
    specCounts.open === 0 &&
    planCounts.done >= 1 &&
    planCounts.open === 0;
  const isArchived = isExplicitlyArchived || isAutoArchived;

  if (isArchived || (!specFilled && !planFilled)) {
    return {
      status: 'INACTIVE',
      semanticHash: '',
      isPaused,
      isArchived,
      hasTemplatePlaceholder,
      subagentOnly,
      specExists,
      planExists,
      isApprovedViaState: false,
      isApprovedViaTurn: false,
      isModifiedAfterUser: false,
      isUnapprovedArtifactComment: false,
      saveApprovedState: () => {},
    };
  }

  if (!specFilled || !planFilled) {
    return {
      status: 'ACTIVE_UNAPPROVED',
      semanticHash: sha256('PARTIAL\n' + specTxt + '\n' + planTxt),
      isPaused: false,
      isArchived: false,
      hasTemplatePlaceholder: true,
      subagentOnly,
      specExists,
      planExists,
      isApprovedViaState: false,
      isApprovedViaTurn: false,
      isModifiedAfterUser: false,
      isUnapprovedArtifactComment: false,
      saveApprovedState: () => {},
    };
  }

  const semanticHash = sha256(
    'SPEC\n' + normalizeContract(specTxt) + '\nPLAN\n' + normalizeContract(planTxt)
  );
  const convKey = sha256(workspaceRoot + '::' + String(conversationId || 'default')).slice(0, 24);
  const statePath = path.join(stateDir, convKey + '.json');
  const state = readJsonSafe(statePath);

  let lastUserStep = null;
  let modifiedAfterUserInTranscript = false;
  if (transcriptPath && fs.existsSync(transcriptPath)) {
    const lines = fs.readFileSync(transcriptPath, 'utf8').split(/\r?\n/).filter(Boolean);
    let lastUserIdx = -1;
    const parsed = [];
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        parsed.push(obj);
        if (obj && (obj.type === 'USER_INPUT' || obj.source === 'USER_EXPLICIT')) {
          lastUserIdx = parsed.length - 1;
        }
      } catch {}
    }
    if (lastUserIdx >= 0) {
      lastUserStep = parsed[lastUserIdx];
      for (let j = lastUserIdx + 1; j < parsed.length; j++) {
        const step = parsed[j];
        if (!step || !Array.isArray(step.tool_calls)) continue;
        for (const tc of step.tool_calls) {
          const tcName = String((tc && tc.name) || '');
          const tcArgs = (tc && tc.args) || {};
          if (EDIT_TOOLS.has(tcName)) {
            if (/\.artifacts[\\/]+(SPEC|PLAN)\.md$/.test(extractTargetPath(tcArgs))) {
              modifiedAfterUserInTranscript = true;
            }
          } else if (tcName === 'run_command') {
            const cmd = String(tcArgs.CommandLine || tcArgs.command || '');
            if (
              /\.artifacts[\\/]+(SPEC|PLAN)\.md/.test(cmd) &&
              /(?:>|>>|\btee\b|\bsed\b|\bperl\b|\bmv\b|\bcp\b|\brm\b|\bnode\b|\bpython3?\b)/.test(cmd)
            ) {
              modifiedAfterUserInTranscript = true;
            }
          }
        }
      }
    }
  }

  const rawTranscriptMsg = lastUserStep ? extractText(lastUserStep.content) : '';
  const fallbackUserMsg = typeof lastUserInput === 'string' ? lastUserInput : '';
  const rawUserMsg = rawTranscriptMsg.trim() ? rawTranscriptMsg : fallbackUserMsg;
  const cleanedUserMsg = cleanUserMessage(rawUserMsg);

  const hasArtifactComments = cleanedUserMsg.includes('Comments on artifact URI:');
  const hasDocApproved = cleanedUserMsg.includes('The user has approved this document.');
  const isUnapprovedArtifactComment = hasArtifactComments && !hasDocApproved;

  const lastUserTimeMs =
    lastUserStep && lastUserStep.created_at ? Date.parse(lastUserStep.created_at) : NaN;
  const maxContractMtimeMs = Math.max(
    fs.statSync(specPath).mtimeMs,
    fs.statSync(planPath).mtimeMs
  );
  const isModifiedAfterUser = Boolean(
    modifiedAfterUserInTranscript ||
      (lastUserStep && (!Number.isFinite(lastUserTimeMs) || maxContractMtimeMs > lastUserTimeMs))
  );

  const isApprovedViaState = Boolean(state && state.approvedHash === semanticHash);
  const isApprovedViaTurn = Boolean(
    !isUnapprovedArtifactComment &&
      !isModifiedAfterUser &&
      (lastUserStep ? Number.isFinite(lastUserTimeMs) : Boolean(fallbackUserMsg.trim())) &&
      isExplicitUserApproval(cleanedUserMsg)
  );

  const saveApprovedState = () => {
    writeJsonSafe(statePath, {
      approvedHash: semanticHash,
      approvedAtMs: Date.now(),
      approvedStepIdx: (lastUserStep && lastUserStep.step_index) ?? 0,
    });
  };

  return {
    status: isApprovedViaState || isApprovedViaTurn ? 'ACTIVE_APPROVED' : 'ACTIVE_UNAPPROVED',
    semanticHash,
    isPaused: false,
    isArchived: false,
    hasTemplatePlaceholder: false,
    subagentOnly,
    specExists,
    planExists,
    isApprovedViaState,
    isApprovedViaTurn,
    isModifiedAfterUser,
    isUnapprovedArtifactComment,
    saveApprovedState,
  };
}

function classifyPathTarget(rawP, workspaceRoot) {
  const cleaned = String(rawP || '').trim().replace(/^[\x27"]|[\x27"]$/g, '');
  if (!cleaned) return { exempt: false, rel: '' };
  if (cleaned === '/dev/null' || /^\/(?:private\/)?tmp(?:\/|$)/.test(cleaned)) {
    return { exempt: true, rel: '' };
  }
  if (cleaned.startsWith('$') || cleaned.startsWith('~')) return { exempt: false, rel: '' };
  const abs = resolveReal(cleaned, workspaceRoot);
  if (abs === workspaceRoot) return { exempt: false, rel: '' };
  if (!abs.startsWith(workspaceRoot + path.sep)) return { exempt: true, rel: '' };
  const r = path.relative(workspaceRoot, abs).replace(/\\/g, '/');
  if (!r) return { exempt: false, rel: '' };
  if (isHarnessInternal(r) || isTrivialExemptPath(r)) return { exempt: true, rel: r };
  return { exempt: false, rel: r };
}

function classifyWorkspaceMutationPath(rawP, workspaceRoot) {
  const cleaned = String(rawP || '').trim().replace(/^[\x27"]|[\x27"]$/g, '');
  if (!cleaned) return { exempt: false, rel: '' };
  if (cleaned === '/dev/null' || /^\/(?:private\/)?tmp(?:\/|$)/.test(cleaned)) {
    return { exempt: true, rel: '' };
  }
  if (cleaned.startsWith('$') || cleaned.startsWith('~')) return { exempt: false, rel: '' };
  const abs = resolveReal(cleaned, workspaceRoot);
  if (abs === workspaceRoot) return { exempt: false, rel: '' };
  if (!abs.startsWith(workspaceRoot + path.sep)) return { exempt: true, rel: '' };
  const r = path.relative(workspaceRoot, abs).replace(/\\/g, '/');
  if (!r) return { exempt: false, rel: '' };
  if (isHarnessInternal(r)) return { exempt: true, rel: '' };
  return { exempt: false, rel: r };
}

function splitHeredocs(cmd) {
  const lines = String(cmd || '').replace(/\r\n/g, '\n').split('\n');
  const items = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(/<<(-?)\s*[\x27"]?([A-Za-z_][A-Za-z0-9_-]*)[\x27"]?/);
    if (m) {
      const stripTabs = m[1] === '-';
      const tag = m[2];
      const bodyLines = [];
      i++;
      while (i < lines.length) {
        const cmp = stripTabs ? lines[i].replace(/^\t+/, '') : lines[i];
        if (cmp === tag) {
          i++;
          break;
        }
        bodyLines.push(lines[i]);
        i++;
      }
      items.push({ line, heredoc: bodyLines.join('\n') });
    } else {
      items.push({ line, heredoc: '' });
      i++;
    }
  }
  return items;
}

function readWord(s, startIdx) {
  let i = startIdx;
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
  let out = '';
  let inS = false;
  let inD = false;
  while (i < s.length) {
    const ch = s[i];
    if (inS) {
      if (ch === '\x27') inS = false;
      else out += ch;
      i++;
    } else if (inD) {
      if (ch === '\\' && i + 1 < s.length) {
        out += s[i + 1];
        i += 2;
      } else if (ch === '"') {
        inD = false;
        i++;
      } else {
        out += ch;
        i++;
      }
    } else {
      if (ch === '\\' && i + 1 < s.length) {
        out += s[i + 1];
        i += 2;
      } else if (ch === '\x27') {
        inS = true;
        i++;
      } else if (ch === '"') {
        inD = true;
        i++;
      } else if (' \t;&|><'.includes(ch)) {
        break;
      } else {
        out += ch;
        i++;
      }
    }
  }
  return { word: out, nextIdx: i };
}

function tokenizeShellLine(line) {
  const segments = [];
  let tokens = [];
  let redirects = [];
  let hasHeredoc = false;
  let pipedFromPrev = false;
  let cur = '';
  let curQuoted = false;
  let hasCur = false;
  let inS = false;
  let inD = false;

  const flushToken = () => {
    if (hasCur) {
      tokens.push({ value: cur, quoted: curQuoted });
      cur = '';
      curQuoted = false;
      hasCur = false;
    }
  };
  const flushSegment = (isPipe) => {
    flushToken();
    if (tokens.length > 0 || redirects.length > 0) {
      segments.push({ tokens, redirects, hasHeredoc, pipedFromPrev });
    }
    tokens = [];
    redirects = [];
    hasHeredoc = false;
    pipedFromPrev = isPipe;
  };

  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (inS) {
      if (ch === '\x27') inS = false;
      else cur += ch;
      i++;
      continue;
    }
    if (inD) {
      if (ch === '\\' && i + 1 < line.length) {
        cur += line[i + 1];
        i += 2;
      } else if (ch === '"') {
        inD = false;
        i++;
      } else {
        cur += ch;
        i++;
      }
      continue;
    }
    if (ch === '\\' && i + 1 < line.length) {
      hasCur = true;
      cur += line[i + 1];
      i += 2;
      continue;
    }
    if (ch === '\x27') {
      inS = true;
      curQuoted = true;
      hasCur = true;
      i++;
      continue;
    }
    if (ch === '"') {
      inD = true;
      curQuoted = true;
      hasCur = true;
      i++;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      flushToken();
      i++;
      continue;
    }
    if (ch === ';') {
      flushSegment(false);
      i++;
      continue;
    }
    if (ch === '&' && line[i + 1] === '&') {
      flushSegment(false);
      i += 2;
      continue;
    }
    if (ch === '|' && line[i + 1] === '|') {
      flushSegment(false);
      i += 2;
      continue;
    }
    if (ch === '|') {
      flushSegment(true);
      i++;
      continue;
    }
    if (ch === '<') {
      if (line[i + 1] === '<') {
        flushToken();
        hasHeredoc = true;
        i += 2;
        if (line[i] === '-' || line[i] === '<') i++;
        const w = readWord(line, i);
        i = w.nextIdx;
      } else {
        if (hasCur && /^\d+$/.test(cur)) {
          cur = '';
          hasCur = false;
        } else {
          flushToken();
        }
        i++;
        if (line[i] === '&') {
          i++;
          while (i < line.length && /[0-9-]/.test(line[i])) i++;
        } else {
          const w = readWord(line, i);
          i = w.nextIdx;
        }
      }
      continue;
    }
    if (ch === '>') {
      if (hasCur && (cur === '=' || cur === '-') && !curQuoted) {
        cur += ch;
        i++;
        continue;
      }
      if (hasCur && (/^\d+$/.test(cur) || cur === '&') && !curQuoted) {
        cur = '';
        hasCur = false;
      } else {
        flushToken();
      }
      i++;
      if (line[i] === '>') i++;
      if (line[i] === '&') {
        i++;
        while (i < line.length && /[0-9-]/.test(line[i])) i++;
      } else {
        const w = readWord(line, i);
        redirects.push(w.word);
        i = w.nextIdx;
      }
      continue;
    }
    if (ch === '&' && line[i + 1] === '>') {
      flushToken();
      i += 2;
      if (line[i] === '>') i++;
      const w = readWord(line, i);
      redirects.push(w.word);
      i = w.nextIdx;
      continue;
    }
    hasCur = true;
    cur += ch;
    i++;
  }
  flushSegment(false);
  return segments;
}

function inspectNodeTargets(code) {
  const writeCallRe =
    /\b(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|rmSync|rm|unlinkSync|unlink|renameSync|rename|copyFileSync|copyFile|cpSync|cp|truncateSync|truncate|openSync)\s*\(/g;
  const targets = [];
  let untargeted = false;
  let matched = false;
  let m;
  while ((m = writeCallRe.exec(code)) !== null) {
    const fn = m[0].replace(/\s*\($/, '');
    const openIdx = m.index + m[0].length - 1;
    let depth = 1;
    let j = openIdx + 1;
    let inS = false;
    let inD = false;
    let inB = false;
    while (j < code.length && depth > 0) {
      const c = code[j];
      if (inS) {
        if (c === '\\' && j + 1 < code.length) j += 2;
        else if (c === '\x27') { inS = false; j++; }
        else j++;
      } else if (inD) {
        if (c === '\\' && j + 1 < code.length) j += 2;
        else if (c === '"') { inD = false; j++; }
        else j++;
      } else if (inB) {
        if (c === '\\' && j + 1 < code.length) j += 2;
        else if (c === '`') { inB = false; j++; }
        else j++;
      } else {
        if (c === '\x27') inS = true;
        else if (c === '"') inD = true;
        else if (c === '`') inB = true;
        else if (c === '(') depth++;
        else if (c === ')') depth--;
        j++;
      }
    }
    const argSlice = code.slice(openIdx + 1, Math.max(openIdx + 1, j - 1));
    if (fn === 'openSync' && /[\x27"]r/.test(argSlice) && !/[\x27"][wa+]/.test(argSlice)) {
      continue;
    }
    matched = true;
    const literals = [];
    const litRe = /[\x27"`]([^\x27"`\r\n]+)[\x27"`]/g;
    let lm;
    while ((lm = litRe.exec(argSlice)) !== null) {
      literals.push(lm[1]);
    }
    const cands =
      fn === 'renameSync' || fn === 'rename' || fn === 'copyFileSync' || fn === 'copyFile' || fn === 'cpSync' || fn === 'cp'
        ? literals.slice(0, 2)
        : literals.slice(0, 1);
    if (cands.length === 0) untargeted = true;
    else targets.push(...cands);
  }
  return { matched, targets, untargeted };
}

function inspectPythonTargets(code) {
  const targets = [];
  let untargeted = false;
  let matched = false;
  const covered = [];
  const pathMethodRe =
    /Path\s*\(\s*([^\)]*)\)\s*\.\s*(?:write_text|write_bytes|unlink|rename|replace|mkdir|rmdir)\s*\(([^\)]*)\)/g;
  let pm;
  while ((pm = pathMethodRe.exec(code)) !== null) {
    covered.push([pm.index, pm.index + pm[0].length]);
    matched = true;
    const pLit = pm[1].match(/[\x27"]([^\x27"\r\n]+)[\x27"]/);
    if (pLit) targets.push(pLit[1]);
    else untargeted = true;
    if (/\.(?:rename|replace)\s*\(/.test(pm[0])) {
      const dLit = pm[2].match(/[\x27"]([^\x27"\r\n]+)[\x27"]/);
      if (dLit) targets.push(dLit[1]);
      else untargeted = true;
    }
  }
  const bareWriteRe = /\.\s*(?:write_text|write_bytes|writelines)\s*\(/g;
  let bw;
  while ((bw = bareWriteRe.exec(code)) !== null) {
    if (!covered.some(([s, e]) => bw.index >= s && bw.index <= e)) {
      matched = true;
      untargeted = true;
    }
  }
  const openRe = /\bopen\s*\(([^\)]*)\)/g;
  let om;
  while ((om = openRe.exec(code)) !== null) {
    const inside = om[1];
    const modeMatch = inside.match(/,\s*(?:mode\s*=\s*)?[\x27"]([rwaAxbtU+]+)[\x27"]/);
    if (modeMatch && !/[wax+]/i.test(modeMatch[1])) continue;
    if (!modeMatch && !/,/.test(inside)) continue;
    matched = true;
    const pLit = inside.match(/^\s*[\x27"]([^\x27"\r\n]+)[\x27"]/);
    if (pLit) targets.push(pLit[1]);
    else untargeted = true;
  }
  const osShutilRe = /\b(?:shutil\.(?:copy\w*|move|rmtree)|os\.(?:remove|unlink|rename|replace|rmdir|makedirs?))\s*\(([^\)]*)\)/g;
  let sm;
  while ((sm = osShutilRe.exec(code)) !== null) {
    matched = true;
    const lits = [...sm[1].matchAll(/[\x27"]([^\x27"\r\n]+)[\x27"]/g)].map((x) => x[1]);
    if (lits.length === 0) untargeted = true;
    else targets.push(...lits);
  }
  return { matched, targets, untargeted };
}

function inspectShellMutations(cmd, depth = 0) {
  const writes = [];
  const mutatingOps = [];
  const recordTarget = (rawP, op) => {
    const cleaned = String(rawP || '').trim().replace(/^[\x27"]|[\x27"]$/g, '');
    if (cleaned === '/dev/null') return;
    writes.push({ raw: cleaned, op });
  };

  for (const item of splitHeredocs(cmd)) {
    const segs = tokenizeShellLine(item.line);
    for (let sIdx = 0; sIdx < segs.length; sIdx++) {
      const seg = segs[sIdx];
      for (const rTarget of seg.redirects) {
        recordTarget(rTarget, 'redirection');
      }

      let idx = 0;
      const WRAPPERS = new Set(['command', 'sudo', 'env', 'time', 'nohup', 'exec']);
      while (idx < seg.tokens.length) {
        const val = seg.tokens[idx].value;
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(val) || WRAPPERS.has(val)) {
          idx++;
          continue;
        }
        break;
      }
      if (idx >= seg.tokens.length) continue;

      const cmdWord = path.posix.basename(seg.tokens[idx].value);
      const argTokens = seg.tokens.slice(idx + 1);
      const argVals = argTokens.map((t) => t.value);

      if (cmdWord === 'tee') {
        const files = argVals.filter((a) => !a.startsWith('-'));
        if (files.length === 0) mutatingOps.push('tee');
        else files.forEach((f) => recordTarget(f, 'tee'));
      } else if (cmdWord === 'rm' || cmdWord === 'unlink' || cmdWord === 'touch' || cmdWord === 'mkdir' || cmdWord === 'rmdir') {
        let afterDd = false;
        const files = [];
        for (let k = 0; k < argVals.length; k++) {
          const a = argVals[k];
          if (!afterDd && a === '--') { afterDd = true; continue; }
          if (!afterDd && a.startsWith('-')) {
            if (cmdWord === 'touch' && (a === '-d' || a === '-t' || a === '-r')) k++;
            continue;
          }
          files.push(a);
        }
        if (files.length === 0) mutatingOps.push(cmdWord);
        else files.forEach((f) => recordTarget(f, cmdWord));
      } else if (cmdWord === 'mv' || cmdWord === 'ln') {
        const files = [];
        for (let k = 0; k < argVals.length; k++) {
          const a = argVals[k];
          if (a === '-t' || a === '-S') {
            if (a === '-t' && k + 1 < argVals.length) files.push(argVals[k + 1]);
            k++;
            continue;
          }
          if (a.startsWith('--target-directory=')) { files.push(a.slice(19)); continue; }
          if (a.startsWith('-')) continue;
          files.push(a);
        }
        if (files.length === 0) mutatingOps.push(cmdWord);
        else files.forEach((f) => recordTarget(f, cmdWord));
      } else if (cmdWord === 'cp' || cmdWord === 'install') {
        let targetDir = '';
        const files = [];
        for (let k = 0; k < argVals.length; k++) {
          const a = argVals[k];
          if (a === '-t' && k + 1 < argVals.length) { targetDir = argVals[++k]; continue; }
          if (a.startsWith('--target-directory=')) { targetDir = a.slice(19); continue; }
          if (cmdWord === 'install' && (a === '-m' || a === '-o' || a === '-g')) { k++; continue; }
          if (a.startsWith('-')) continue;
          files.push(a);
        }
        if (targetDir) recordTarget(targetDir, cmdWord);
        else if (files.length > 0) recordTarget(files[files.length - 1], cmdWord);
        else mutatingOps.push(cmdWord);
      } else if (cmdWord === 'sed') {
        if (argVals.some((a) => /^-[A-Za-z]*i/.test(a) || a === '--in-place' || a.startsWith('--in-place='))) {
          let sawSf = false;
          const pos = [];
          for (let k = 0; k < argVals.length; k++) {
            const a = argVals[k];
            if (a === '-i') {
              if (k + 1 < argVals.length && argVals[k + 1] === '') k++;
              continue;
            }
            if (/^-[A-Za-z]*i/.test(a) || a === '--in-place' || a.startsWith('--in-place=')) continue;
            if (a === '-e' || a === '-f') { sawSf = true; k++; continue; }
            if (a.startsWith('--expression=') || a.startsWith('--file=')) { sawSf = true; continue; }
            if (a.startsWith('-')) continue;
            pos.push(a);
          }
          const files = sawSf ? pos : pos.slice(1);
          if (files.length === 0) mutatingOps.push('sed -i');
          else files.forEach((f) => recordTarget(f, 'sed -i'));
        }
      } else if (cmdWord === 'perl') {
        if (argVals.some((a) => /^-[A-Za-z]*i/.test(a) || a === '--in-place' || a.startsWith('--in-place='))) {
          const files = [];
          for (let k = 0; k < argVals.length; k++) {
            const a = argVals[k];
            if (a === '-e' || a === '-E' || a === '-I' || a === '-M') { k++; continue; }
            if (a.startsWith('-')) continue;
            files.push(a);
          }
          if (files.length === 0) mutatingOps.push('perl -i');
          else files.forEach((f) => recordTarget(f, 'perl -i'));
        }
      } else if (cmdWord === 'patch') {
        if (!argVals.some((a) => a === '--dry-run' || a === '-C')) {
          let dirTarget = '';
          let outTarget = '';
          for (let k = 0; k < argVals.length; k++) {
            const a = argVals[k];
            if ((a === '-d' || a === '--directory') && k + 1 < argVals.length) dirTarget = argVals[++k];
            else if (a.startsWith('--directory=')) dirTarget = a.slice(12);
            else if ((a === '-o' || a === '--output') && k + 1 < argVals.length) outTarget = argVals[++k];
          }
          if (outTarget) recordTarget(outTarget, 'patch');
          else if (dirTarget) recordTarget(dirTarget, 'patch');
          else mutatingOps.push('patch');
        }
      } else if (cmdWord === 'dd') {
        for (const a of argVals) {
          if (a.startsWith('of=')) recordTarget(a.slice(3), 'dd of=');
        }
      } else if (cmdWord === 'truncate') {
        const files = [];
        for (let k = 0; k < argVals.length; k++) {
          const a = argVals[k];
          if (a === '-s' || a === '-r' || a === '--size' || a === '--reference') { k++; continue; }
          if (a.startsWith('-')) continue;
          files.push(a);
        }
        if (files.length === 0) mutatingOps.push('truncate');
        else files.forEach((f) => recordTarget(f, 'truncate'));
      } else if (cmdWord === 'chmod' || cmdWord === 'chown') {
        mutatingOps.push(cmdWord);
      } else if (cmdWord === 'git') {
        let gitDirOpt = '';
        let k = 0;
        while (k < argVals.length) {
          const a = argVals[k];
          if (a === '-C' && k + 1 < argVals.length) { gitDirOpt = argVals[++k]; k++; continue; }
          if ((a === '-c' || a === '--git-dir' || a === '--work-tree' || a === '--namespace') && k + 1 < argVals.length) { k += 2; continue; }
          if (a.startsWith('-')) { k++; continue; }
          break;
        }
        const sub = argVals[k] || '';
        const subArgs = argVals.slice(k + 1);
        const targetScope = gitDirOpt || '.';
        if (sub === 'apply') {
          if (!subArgs.some((a) => a === '--check' || a === '--stat' || a === '--numstat' || a === '--summary')) {
            recordTarget(targetScope, 'git apply');
          }
        } else if (sub === 'restore') {
          const files = subArgs.filter((a) => a !== '--' && !a.startsWith('-'));
          if (files.length === 0) recordTarget(targetScope, 'git restore');
          else files.forEach((f) => recordTarget(gitDirOpt ? path.posix.join(gitDirOpt, f) : f, 'git restore'));
        } else if (sub === 'checkout' && subArgs.includes('--')) {
          const files = subArgs.slice(subArgs.indexOf('--') + 1);
          if (files.length === 0) recordTarget(targetScope, 'git checkout --');
          else files.forEach((f) => recordTarget(gitDirOpt ? path.posix.join(gitDirOpt, f) : f, 'git checkout --'));
        } else if (sub === 'reset' && subArgs.some((a) => a === '--hard' || a === '--merge')) {
          recordTarget(targetScope, 'git reset --hard');
        } else if (sub === 'clean' && !subArgs.some((a) => a === '--dry-run' || /^-[A-Za-z]*n/.test(a))) {
          recordTarget(targetScope, 'git clean');
        } else if (sub === 'merge' || sub === 'cherry-pick' || sub === 'am' || sub === 'revert' || sub === 'rebase' || sub === 'mv' || sub === 'rm') {
          recordTarget(targetScope, 'git ' + sub);
        } else if (
          sub === 'commit' || sub === 'push' || sub === 'add' || sub === 'stage' ||
          sub === 'switch' || sub === 'pull' || sub === 'fetch' || sub === 'init' || sub === 'clone'
        ) {
          mutatingOps.push('git ' + sub);
        } else if (sub === 'stash' && subArgs[0] !== 'list' && subArgs[0] !== 'show') {
          mutatingOps.push('git stash');
        } else if (sub === 'branch' && subArgs.some((a) => /^-(?:[dDmMcC]|-delete|-move|-copy)$/.test(a))) {
          mutatingOps.push('git branch');
        } else if (sub === 'diff' && subArgs.some((a) => a === '--output' || a.startsWith('--output='))) {
          mutatingOps.push('git diff --output');
        }
      } else if (cmdWord === 'node') {
        const codes = [];
        for (let k = 0; k < argVals.length; k++) {
          const a = argVals[k];
          if ((a === '-e' || a === '--eval' || a === '-p' || a === '--print') && k + 1 < argVals.length) codes.push(argVals[++k]);
          else if (a.startsWith('--eval=')) codes.push(a.slice(7));
          else if (a === '-' && item.heredoc) codes.push(item.heredoc);
        }
        if ((seg.hasHeredoc || seg.pipedFromPrev) && item.heredoc) codes.push(item.heredoc);
        if (seg.pipedFromPrev && sIdx > 0) codes.push(segs[sIdx - 1].tokens.map((t) => t.value).join(' '));
        for (const c of codes) {
          const res = inspectNodeTargets(c);
          if (res.matched) {
            if (res.untargeted || res.targets.length === 0) mutatingOps.push('node inline write');
            else res.targets.forEach((t) => recordTarget(t, 'node inline write'));
          }
        }
      } else if (cmdWord === 'python' || cmdWord === 'python3') {
        const codes = [];
        for (let k = 0; k < argVals.length; k++) {
          const a = argVals[k];
          if (a === '-c' && k + 1 < argVals.length) codes.push(argVals[++k]);
          else if (a.startsWith('-c') && a.length > 2) codes.push(a.slice(2));
          else if (a === '-' && item.heredoc) codes.push(item.heredoc);
        }
        if ((seg.hasHeredoc || seg.pipedFromPrev) && item.heredoc) codes.push(item.heredoc);
        if (seg.pipedFromPrev && sIdx > 0) codes.push(segs[sIdx - 1].tokens.map((t) => t.value).join(' '));
        for (const c of codes) {
          const res = inspectPythonTargets(c);
          if (res.matched) {
            if (res.untargeted || res.targets.length === 0) mutatingOps.push('python inline write');
            else res.targets.forEach((t) => recordTarget(t, 'python inline write'));
          }
        }
      } else if ((cmdWord === 'sh' || cmdWord === 'bash' || cmdWord === 'zsh') && depth < 1) {
        for (let k = 0; k < argVals.length - 1; k++) {
          if (argVals[k] === '-c') {
            const subRes = inspectShellMutations(argVals[k + 1], depth + 1);
            writes.push(...subRes.writes);
            mutatingOps.push(...subRes.mutatingOps);
          }
        }
      }
    }
  }
  return { writes, mutatingOps };
}

function detectShellWriteBypass(cmd, workspaceRoot) {
  const mut = inspectShellMutations(cmd, 0);
  const summaries = [];
  const targets = [];
  let untargeted = false;
  let matched = false;

  for (const w of mut.writes) {
    const cls = classifyWorkspaceMutationPath(w.raw, workspaceRoot);
    if (!cls.exempt) {
      matched = true;
      summaries.push(w.op);
      if (cls.rel) targets.push(cls.rel);
      else untargeted = true;
    }
  }
  for (const op of mut.mutatingOps) {
    // Only treat inline file-mutating / patch / mkdir / chmod / chown ops as workspace write bypasses (not git commit/push/add/branch)
    if (!op.startsWith('git ')) {
      matched = true;
      untargeted = true;
      summaries.push(op);
    }
  }
  return { matched, targets, untargeted, summaries };
}

function analyzeRunCommand(cmd, workspaceRoot, depth = 0) {
  let sawEdit = false;
  let sawFullGate = false;
  let editAfterGate = false;
  const markEdit = () => {
    sawEdit = true;
    editAfterGate = true;
  };
  const markGate = () => {
    sawFullGate = true;
    editAfterGate = false;
  };

  for (const item of splitHeredocs(cmd)) {
    const segs = tokenizeShellLine(item.line);
    for (let sIdx = 0; sIdx < segs.length; sIdx++) {
      const seg = segs[sIdx];
      let idx = 0;
      const WRAPPERS = new Set(['command', 'sudo', 'env', 'time', 'nohup', 'exec']);
      while (idx < seg.tokens.length) {
        const val = seg.tokens[idx].value;
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(val) || WRAPPERS.has(val)) {
          idx++;
          continue;
        }
        break;
      }
      if (idx < seg.tokens.length) {
        const rawCmd = seg.tokens[idx].value;
        const cmdWord = path.posix.basename(rawCmd);
        const argVals = seg.tokens.slice(idx + 1).map((t) => t.value);
        const isDirectGate = /(?:^|\/)gate-check\.sh$/.test(rawCmd.replace(/\\/g, '/'));
        const isShellGate =
          (cmdWord === 'sh' || cmdWord === 'bash' || cmdWord === 'zsh') &&
          argVals.some((a) => /(?:^|\/)gate-check\.sh$/.test(a.replace(/\\/g, '/')));
        if ((isDirectGate || isShellGate) && !argVals.includes('--fast')) {
          markGate();
          continue;
        }
        if ((cmdWord === 'sh' || cmdWord === 'bash' || cmdWord === 'zsh') && depth < 1) {
          let handledSub = false;
          for (let k = 0; k < argVals.length - 1; k++) {
            if (argVals[k] === '-c') {
              handledSub = true;
              const subRes = analyzeRunCommand(argVals[k + 1], workspaceRoot, depth + 1);
              if (subRes.sawEdit) {
                sawEdit = true;
                editAfterGate = subRes.editAfterGate;
              }
              if (subRes.sawFullGate) {
                sawFullGate = true;
                if (!subRes.editAfterGate) editAfterGate = false;
              }
            }
          }
          if (handledSub) continue;
        }
      }

      const segStr = seg.tokens.map((t) => JSON.stringify(t.value)).join(' ') +
        seg.redirects.map((r) => ' > ' + JSON.stringify(r)).join('');
      const mut = inspectShellMutations(
        seg.hasHeredoc && item.heredoc ? `${segStr} <<'EOF'\n${item.heredoc}\nEOF` : segStr,
        0
      );
      for (const w of mut.writes) {
        if (!classifyPathTarget(w.raw, workspaceRoot).exempt) {
          markEdit();
        }
      }
      for (const op of mut.mutatingOps) {
        if (!op.startsWith('git ')) {
          markEdit();
        }
      }
    }
  }
  return { sawEdit, sawFullGate, editAfterGate };
}

function detectBlacklistedCommand(cmd, depth = 0) {
  const CONTAINER_BINS = new Set([
    'docker', 'docker-compose', 'podman', 'colima', 'orbstack',
    'kubectl', 'helm', 'kind', 'minikube', 'testcontainers',
  ]);
  const SEARCH_BINS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack']);
  const firstNonFlagArgs = (argVals, valueFlags) => {
    const out = [];
    for (let i = 0; i < argVals.length; i++) {
      const a = argVals[i];
      if (a === '--') break;
      if (valueFlags.has(a) && i + 1 < argVals.length) { i++; continue; }
      if (a.startsWith('-')) continue;
      out.push(a);
    }
    return out;
  };

  for (const item of splitHeredocs(cmd)) {
    const segs = tokenizeShellLine(item.line);
    for (const seg of segs) {
      let idx = 0;
      const WRAPPERS = new Set(['command', 'sudo', 'env', 'time', 'nohup', 'exec']);
      const envTokens = [];
      while (idx < seg.tokens.length) {
        const val = seg.tokens[idx].value;
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(val)) { envTokens.push(val); idx++; continue; }
        if (WRAPPERS.has(val)) { idx++; continue; }
        break;
      }
      if (idx >= seg.tokens.length) continue;
      const cmdWord = path.posix.basename(seg.tokens[idx].value);
      const argVals = seg.tokens.slice(idx + 1).map((t) => t.value);
      const isSearch = SEARCH_BINS.has(cmdWord);

      if (CONTAINER_BINS.has(cmdWord)) return cmdWord;
      if (!isSearch) {
        for (const t of [...envTokens, ...argVals]) {
          if (/\btestcontainers\b/i.test(t)) return 'testcontainers';
        }
        if (argVals.some((a) => a === '--watch' || (/^--watch=/.test(a) && !/^--watch=(?:false|0|off|none)$/i.test(a)))) {
          return '--watch';
        }
        if (argVals.some((a) => a === '-it' || a === '-ti')) return '-it';
      }

      if (cmdWord === 'npm' || cmdWord === 'pnpm' || cmdWord === 'yarn' || cmdWord === 'bun') {
        const pos = firstNonFlagArgs(argVals, new Set(['--prefix', '-C', '--cwd', '--filter']));
        if (pos[0] && /^(?:install|i|add|ci)$/.test(pos[0])) return cmdWord + ' ' + pos[0];
      } else if (cmdWord === 'pip' || cmdWord === 'pip3' || cmdWord === 'poetry') {
        const pos = firstNonFlagArgs(argVals, new Set(['--python', '-C', '--directory']));
        if (pos[0] === 'install') return cmdWord + ' install';
      } else if (cmdWord === 'uv') {
        const pos = firstNonFlagArgs(argVals, new Set(['--python', '--directory']));
        if (pos[0] === 'install' || ((pos[0] === 'pip' || pos[0] === 'pip3') && pos[1] === 'install')) return 'uv install';
      } else if (cmdWord === 'python' || cmdWord === 'python3') {
        for (let k = 0; k < argVals.length - 2; k++) {
          if (argVals[k] === '-m' && (argVals[k + 1] === 'pip' || argVals[k + 1] === 'pip3') && argVals[k + 2] === 'install') {
            return cmdWord + ' -m pip install';
          }
        }
      } else if (cmdWord === 'go') {
        const pos = firstNonFlagArgs(argVals, new Set(['-C']));
        if (pos[0] === 'mod' && (pos[1] === 'download' || pos[1] === 'tidy')) return 'go mod ' + pos[1];
      } else if (cmdWord === 'flutter') {
        const pos = firstNonFlagArgs(argVals, new Set([]));
        if (pos[0] === 'pub' && pos[1] === 'get') return 'flutter pub get';
      } else if (cmdWord === 'pod') {
        const pos = firstNonFlagArgs(argVals, new Set([]));
        if (pos[0] === 'install') return 'pod install';
      } else if (cmdWord === 'tail') {
        if (argVals.some((a) => /^-[A-Za-z]*[fF]/.test(a) || /^--follow(?:=|$)/.test(a))) return 'tail -f';
      } else if (cmdWord === 'logs' || argVals[0] === 'logs') {
        if (argVals.some((a) => /^-[A-Za-z]*f/.test(a) || /^--follow(?:=|$)/.test(a))) return 'logs -f';
      } else if ((cmdWord === 'sh' || cmdWord === 'bash' || cmdWord === 'zsh') && depth < 1) {
        for (let k = 0; k < argVals.length - 1; k++) {
          if (argVals[k] === '-c') {
            const inner = detectBlacklistedCommand(argVals[k + 1], depth + 1);
            if (inner) return inner;
          }
        }
      }
    }
  }
  return '';
}

function computeWorkspaceFingerprint(workspaceRoot) {
  try {
    const headOid = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: workspaceRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!headOid) return null;

    const statusOut = execFileSync('git', ['--no-pager', 'status', '--porcelain=v1', '-uall'], {
      cwd: workspaceRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const lines = statusOut
      .split(/\r?\n/)
      .map((l) => l.replace(/\r$/, ''))
      .filter(Boolean)
      .filter((line) => {
        let rawPath = line.slice(3).trim();
        if (rawPath.includes(' -> ')) rawPath = rawPath.split(' -> ').pop().trim();
        rawPath = rawPath.replace(/^"+|"+$/g, '').replace(/\\/g, '/');
        return !isHarnessInternal(rawPath);
      })
      .sort();

    const parts = [`HEAD:${headOid}`];
    for (const line of lines) {
      let rawPath = line.slice(3).trim();
      if (rawPath.includes(' -> ')) rawPath = rawPath.split(' -> ').pop().trim();
      rawPath = rawPath.replace(/^"+|"+$/g, '');
      const absPath = path.join(workspaceRoot, rawPath);
      let fileHash = 'MISSING';
      try {
        if (fs.existsSync(absPath) && fs.statSync(absPath).isFile()) {
          fileHash = crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
        }
      } catch {}
      parts.push(`${line}::${fileHash}`);
    }
    return sha256(parts.join('\n'));
  } catch {
    return null;
  }
}

function getGateFingerprintPath(workspaceRoot, stateDir) {
  const wsHash = sha256(workspaceRoot).slice(0, 24);
  return path.join(stateDir, `gate-fp-${wsHash}.json`);
}

function didTranscriptMutate(transcriptPath, workspaceRoot) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return false;
  let content = '';
  try {
    content = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    return false;
  }
  let mutated = false;
  for (const rawLine of content.split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    let step;
    try {
      step = JSON.parse(rawLine);
    } catch {
      continue;
    }
    if (!step || !Array.isArray(step.tool_calls)) continue;
    for (const tc of step.tool_calls) {
      const tcName = String((tc && tc.name) || '');
      const tcArgs = (tc && tc.args) || {};
      if (EDIT_TOOLS.has(tcName)) {
        const rawTarget = extractTargetPath(tcArgs);
        if (!rawTarget) {
          mutated = true;
        } else {
          const absTarget = resolveReal(rawTarget, workspaceRoot);
          if (absTarget.startsWith(workspaceRoot + path.sep) || absTarget === workspaceRoot) {
            const rel = path.relative(workspaceRoot, absTarget).replace(/\\/g, '/');
            if (rel && !isHarnessInternal(rel) && !isTrivialExemptPath(rel)) {
              mutated = true;
            }
          }
        }
      } else if (tcName === 'run_command') {
        const cmd = String(tcArgs.CommandLine || tcArgs.command || '');
        if (cmd.trim()) {
          const res = analyzeRunCommand(cmd, workspaceRoot, 0);
          if (res.sawFullGate && !res.editAfterGate) {
            mutated = false;
          } else if (res.sawEdit) {
            mutated = true;
          }
        }
      } else if (tcName === 'invoke_subagent') {
        const subType = String(tcArgs.TypeName || tcArgs.typeName || tcArgs.subagent_type || '').trim();
        if (!READ_ONLY_SUBAGENTS.has(subType)) {
          mutated = true;
        }
      } else if (tcName === 'swarm' && String(tcArgs.action || '').trim() === 'add') {
        mutated = true;
      } else if (tcName === 'run_workflow') {
        mutated = true;
      }
    }
  }
  return mutated;
}

module.exports = {
  EDIT_TOOLS,
  READ_ONLY_SUBAGENTS,
  LOCKED_CONTRACTS,
  sha256,
  resolveReal,
  resolveWorkspaceRoot,
  hasHarnessInWorkspace,
  isSelfHostingRepo,
  getStateDir,
  readJsonSafe,
  writeJsonSafe,
  isHarnessInternal,
  isTrivialExemptPath,
  isTierXsExemptPath: isTrivialExemptPath,
  extractTargetPath,
  extractText,
  cleanUserMessage,
  detectIsParent,
  stripFences,
  stripNonContractSections,
  normalizeContract,
  hasSpecTemplateMarker,
  hasPlanTemplateMarker,
  isExplicitArchiveMarker,
  isExplicitPausedMarker,
  isSubagentOnlyPlan,
  countSpecCheckboxes,
  countPlanStatuses,
  isExplicitUserApproval,
  getContractState,
  classifyPathTarget,
  classifyWorkspaceMutationPath,
  splitHeredocs,
  tokenizeShellLine,
  inspectNodeTargets,
  inspectPythonTargets,
  inspectShellMutations,
  detectShellWriteBypass,
  analyzeRunCommand,
  detectBlacklistedCommand,
  computeWorkspaceFingerprint,
  getGateFingerprintPath,
  didTranscriptMutate,
};
