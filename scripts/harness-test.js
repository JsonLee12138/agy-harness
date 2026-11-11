'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

const EXPECTED_SUBAGENTS = {
  'repo-scout': { model: 'flash', policy: 'off', writable: false },
  'arch-redteam': { model: 'pro', policy: 'off', writable: false },
  'slice-builder': { model: 'inherit', policy: 'sandbox', writable: true },
  'staff-gatekeeper': { model: 'pro', policy: 'sandbox', writable: false },
  'risk-specialist': { model: 'pro', policy: 'sandbox', writable: false },
};

const WRITE_TOOLS = new Set([
  'write_to_file',
  'replace_file_content',
  'multi_replace_file_content',
  'write_file',
  'edit_file',
]);

function parseAgentYaml(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  assert.ok(match, 'Expected YAML frontmatter block');
  const data = { tools: [], skills: [] };
  let currentList = null;

  for (const rawLine of match[1].split(/\r?\n/)) {
    if (!rawLine.trim() || /^\s*#/.test(rawLine)) continue;
    const listMatch = rawLine.match(/^\s*-\s+(.+?)\s*$/);
    if (listMatch && currentList) {
      data[currentList].push(listMatch[1].replace(/^['"]|['"]$/g, ''));
      continue;
    }
    const kvMatch = rawLine.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (kvMatch) {
      const [, key, rawVal] = kvMatch;
      const val = rawVal.trim().replace(/^['"]|['"]$/g, '');
      if (key === 'tools' || key === 'skills') {
        currentList = key;
      } else {
        currentList = null;
        data[key] = val;
      }
    }
  }
  return data;
}

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('plugin manifests use agy-harness identity and include logo + lightweight plugin rule', () => {
  const pluginJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin.json'), 'utf8'));
  assert.equal(pluginJson.name, 'agy-harness');
  assert.equal(pluginJson.logo, 'assets/logo.svg');
  assert.ok(fs.existsSync(path.join(ROOT, 'assets', 'logo.svg')), 'assets/logo.svg must exist');

  const rulePath = path.join(ROOT, 'rules', 'AGENTS.md');
  assert.ok(fs.existsSync(rulePath), 'rules/AGENTS.md must exist');
  const ruleSize = fs.statSync(rulePath).size;
  assert.ok(ruleSize > 20 && ruleSize < 1500, `rules/AGENTS.md must stay lightweight (<1500B), got ${ruleSize}B`);

  const legacyPersonas = [
    'code-reviewer.md',
    'security-auditor.md',
    'test-engineer.md',
    'web-performance-auditor.md',
  ];
  for (const file of legacyPersonas) {
    assert.ok(!fs.existsSync(path.join(ROOT, 'agents', file)), `legacy persona ${file} must not stay in agents/`);
    assert.ok(
      fs.existsSync(path.join(ROOT, 'docs', 'legacy-personas', file)),
      `legacy persona ${file} must be archived in docs/legacy-personas/`,
    );
  }
});

test('agents/ exposes exactly the 5 Harness subagents with agy-harness:* skills and physical read-write separation', () => {
  const agentFiles = fs
    .readdirSync(path.join(ROOT, 'agents'))
    .filter((f) => f.endsWith('.md') && !/^readme\.md$/i.test(f))
    .sort();

  assert.deepEqual(
    agentFiles,
    Object.keys(EXPECTED_SUBAGENTS)
      .map((name) => `${name}.md`)
      .sort(),
  );

  for (const [name, spec] of Object.entries(EXPECTED_SUBAGENTS)) {
    const content = fs.readFileSync(path.join(ROOT, 'agents', `${name}.md`), 'utf8');
    const fm = parseAgentYaml(content);

    assert.equal(fm.name, name);
    assert.equal(fm.mainAgent, 'false', `${name} must have mainAgent: false`);
    assert.equal(fm.subagent, 'true', `${name} must have subagent: true`);
    assert.equal(fm.model, spec.model, `${name} model mismatch`);
    assert.equal(fm.commandExecutionPolicy, spec.policy, `${name} commandExecutionPolicy mismatch`);

    assert.ok(fm.skills.length > 0, `${name} must mount at least one skill`);
    for (const skillRef of fm.skills) {
      assert.match(skillRef, /^agy-harness:[a-z0-9-]+$/, `${name} skill '${skillRef}' must use agy-harness: prefix`);
      const skillDir = skillRef.slice('agy-harness:'.length);
      assert.ok(
        fs.existsSync(path.join(ROOT, 'skills', skillDir, 'SKILL.md')),
        `${name} references missing skill directory skills/${skillDir}/SKILL.md`,
      );
    }

    const writeToolsPresent = fm.tools.filter((t) => WRITE_TOOLS.has(t));
    if (spec.writable) {
      assert.ok(writeToolsPresent.includes('write_to_file'), `${name} must include write_to_file`);
      assert.ok(writeToolsPresent.includes('replace_file_content'), `${name} must include replace_file_content`);
      assert.ok(!fm.tools.includes('invoke_subagent'), `${name} must not spawn nested subagents`);
    } else {
      assert.deepEqual(
        writeToolsPresent,
        [],
        `Read-only subagent ${name} MUST NOT have write tools, found: ${writeToolsPresent.join(', ')}`,
      );
      assert.ok(!fm.tools.includes('invoke_subagent'), `${name} must not spawn nested subagents`);
    }
  }
});

test('gate-check.sh passes clean repos, warns on >400 changed lines, and blocks secrets or debugger statements', (t) => {
  const repoDir = makeTempDir('agy-harness-gate-test-');
  t.after(() => fs.rmSync(repoDir, { recursive: true, force: true }));

  const gateScript = path.join(ROOT, 'scripts', 'gate-check.sh');
  assert.ok(fs.existsSync(gateScript), 'scripts/gate-check.sh must exist');

  execFileSync('git', ['init', '-q'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir });
  fs.writeFileSync(path.join(repoDir, 'app.js'), 'const x = 1;\n');
  execFileSync('git', ['add', 'app.js'], { cwd: repoDir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repoDir });

  // 1. Clean working tree passes
  const cleanOut = execFileSync('bash', [gateScript], { cwd: repoDir, encoding: 'utf8' });
  assert.match(cleanOut, /ALL SOFTWARE 1\.0 GATES PASSED\./);

  // 2. >400 lines triggers WARN but still passes
  const bigLines = Array.from({ length: 420 }, (_, i) => `const line_${i} = ${i};`).join('\n') + '\n';
  fs.writeFileSync(path.join(repoDir, 'app.js'), bigLines);
  const warnOut = execFileSync('bash', [gateScript], { cwd: repoDir, encoding: 'utf8' });
  assert.match(warnOut, /WARN: Diff exceeds 400 lines/);

  // 3. Staged debugger statement fails Gate 4
  const dbgStmt = 'deb' + 'ugger;';
  fs.writeFileSync(path.join(repoDir, 'app.js'), `const x = 1;\n${dbgStmt}\n`);
  execFileSync('git', ['add', 'app.js'], { cwd: repoDir });
  assert.throws(
    () => execFileSync('bash', [gateScript], { cwd: repoDir, encoding: 'utf8', stdio: 'pipe' }),
    /Potential secret or debugger statement detected/,
  );

  // 4. Unstaged API secret fails Gate 4 too (even in markdown), whereas prose debug keyword in markdown is allowed
  execFileSync('git', ['reset', '-q', 'HEAD', 'app.js'], { cwd: repoDir });
  fs.writeFileSync(path.join(repoDir, 'app.js'), 'const x = 1;\n');
  fs.writeFileSync(path.join(repoDir, 'NOTES.md'), `Zero leftover \`${dbgStmt}\` allowed.\n`);
  execFileSync('git', ['add', 'NOTES.md'], { cwd: repoDir });
  const mdOut = execFileSync('bash', [gateScript], { cwd: repoDir, encoding: 'utf8' });
  assert.match(mdOut, /ALL SOFTWARE 1\.0 GATES PASSED\./);

  const fakeKey = 'sk-' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3';
  fs.writeFileSync(path.join(repoDir, 'NOTES.md'), `Leaked key: ${fakeKey}\n`);
  assert.throws(
    () => execFileSync('bash', [gateScript], { cwd: repoDir, encoding: 'utf8', stdio: 'pipe' }),
    /Potential secret or debugger statement detected/,
  );
});

test('init-harness.sh scaffolds rules, gate-check.sh, and .artifacts idempotently and supports --with-local-agents', (t) => {
  const targetDir = makeTempDir('agy-harness-init-test-');
  t.after(() => fs.rmSync(targetDir, { recursive: true, force: true }));

  const initScript = path.join(ROOT, 'scripts', 'init-harness.sh');
  assert.ok(fs.existsSync(initScript), 'scripts/init-harness.sh must exist');

  execFileSync('bash', [initScript, targetDir], { encoding: 'utf8' });

  const expectedPaths = [
    '.gitignore',
    '.agents/rules/agy-harness.md',
    '.agents/hooks.json',
    'scripts/gate-check.sh',
    'scripts/harness-approval-gate.sh',
    '.artifacts/.gitignore',
    '.artifacts/context-brief.md',
    '.artifacts/SPEC.md',
    '.artifacts/CONSTRAINTS.md',
    '.artifacts/PLAN.md',
  ];
  for (const rel of expectedPaths) {
    assert.ok(fs.existsSync(path.join(targetDir, rel)), `Expected scaffolded file ${rel}`);
  }

  // Verify .gitignore handles missing trailing newline, stays idempotent across re-runs, and hides .artifacts from git status
  const gitignorePath = path.join(targetDir, '.gitignore');
  fs.writeFileSync(gitignorePath, 'node_modules/'); // intentionally no trailing newline
  execFileSync('bash', [initScript, targetDir], { encoding: 'utf8' });
  execFileSync('bash', [initScript, targetDir, '--force'], { encoding: 'utf8' });
  const gitignoreLines = fs
    .readFileSync(gitignorePath, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim() === '.artifacts/');
  assert.equal(gitignoreLines.length, 1, '.artifacts/ must appear exactly once in .gitignore without corrupting prior line');
  assert.match(fs.readFileSync(gitignorePath, 'utf8'), /^node_modules\/\n\.artifacts\/\n/);

  execFileSync('git', ['init', '-q'], { cwd: targetDir });
  assert.equal(
    execFileSync('git', ['status', '--porcelain', '.artifacts'], { cwd: targetDir, encoding: 'utf8' }).trim(),
    '',
    '.artifacts/ must be completely ignored by Git',
  );

  // Verify idempotency: custom SPEC.md and custom sibling hooks in .agents/hooks.json are preserved without --force
  const specPath = path.join(targetDir, '.artifacts', 'SPEC.md');
  fs.writeFileSync(specPath, '# Custom Spec Locked\n');
  const hooksPath = path.join(targetDir, '.agents', 'hooks.json');
  const existingHooks = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
  existingHooks['custom-user-hook'] = { PostToolUse: [{ matcher: 'run_command', hooks: [{ command: 'echo ok' }] }] };
  delete existingHooks['harness-contract-approval-gate'];
  fs.writeFileSync(hooksPath, JSON.stringify(existingHooks, null, 2) + '\n');

  execFileSync('bash', [initScript, targetDir], { encoding: 'utf8' });
  assert.equal(fs.readFileSync(specPath, 'utf8'), '# Custom Spec Locked\n');
  const mergedHooks = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
  assert.ok(mergedHooks['custom-user-hook'], 'Existing custom-user-hook must be preserved in .agents/hooks.json');
  assert.ok(
    mergedHooks['harness-contract-approval-gate'],
    'harness-contract-approval-gate must be merged into existing .agents/hooks.json',
  );

  // Verify --with-local-agents copies the 5 subagents and --force refreshes templates
  execFileSync('bash', [initScript, targetDir, '--with-local-agents', '--force'], { encoding: 'utf8' });
  assert.notEqual(fs.readFileSync(specPath, 'utf8'), '# Custom Spec Locked\n');
  for (const name of Object.keys(EXPECTED_SUBAGENTS)) {
    assert.ok(
      fs.existsSync(path.join(targetDir, '.agents', 'agents', `${name}.md`)),
      `Expected local agent .agents/agents/${name}.md`,
    );
  }
});

test('harness-approval-gate.sh enforces human confirmation on SPEC/PLAN creation and every substantive edit while allowing checkbox updates', (t) => {
  const wsDir = makeTempDir('agy-harness-approval-ws-');
  const stateDir = makeTempDir('agy-harness-approval-state-');
  t.after(() => {
    fs.rmSync(wsDir, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  const initScript = path.join(ROOT, 'scripts', 'init-harness.sh');
  execFileSync('bash', [initScript, wsDir], { encoding: 'utf8' });

  const approvalGate = path.join(wsDir, 'scripts', 'harness-approval-gate.sh');
  const specPath = path.join(wsDir, '.artifacts', 'SPEC.md');
  const planPath = path.join(wsDir, '.artifacts', 'PLAN.md');
  const transcriptPath = path.join(wsDir, 'transcript.jsonl');

  const runHook = (toolName, args, extra = {}) => {
    const payload = JSON.stringify({
      conversationId: 'conv-approval-test-1',
      workspacePaths: [wsDir],
      transcriptPath,
      stepIdx: 10,
      toolCall: { name: toolName, args },
      ...extra,
    });
    const out = execFileSync('bash', [approvalGate], {
      cwd: path.join(wsDir, '.agents'),
      input: payload,
      encoding: 'utf8',
      env: { ...process.env, AGY_HARNESS_STATE_DIR: stateDir },
    });
    return JSON.parse(out.trim());
  };

  const setMtime = (filePath, isoTime) => {
    const dt = new Date(isoTime);
    fs.utimesSync(filePath, dt, dt);
  };

  // 1. Read-only subagents (repo-scout, arch-redteam, staff-gatekeeper) are ALWAYS allowed
  assert.equal(runHook('invoke_subagent', { TypeName: 'repo-scout' }).decision, 'allow');
  assert.equal(runHook('invoke_subagent', { TypeName: 'arch-redteam' }).decision, 'allow');
  assert.equal(runHook('swarm', { action: 'status' }).decision, 'allow');

  // 2. Unfilled template SPEC.md / PLAN.md is denied even if a later user turn exists
  setMtime(specPath, '2026-11-11T10:00:00.000Z');
  setMtime(planPath, '2026-11-11T10:00:00.000Z');
  fs.writeFileSync(
    transcriptPath,
    JSON.stringify({
      step_index: 1,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      created_at: '2026-11-11T10:01:00.000Z',
      content: '<USER_REQUEST>Build login</USER_REQUEST>',
    }) + '\n',
  );
  const templateRes = runHook('invoke_subagent', { TypeName: 'slice-builder' });
  assert.equal(templateRes.decision, 'deny');
  assert.match(templateRes.reason, /template|placeholder/i);

  // 3. Same-turn runaway blocked: SPEC.md and PLAN.md drafted AFTER latest USER_INPUT -> deny!
  const lockedSpecV1 = '# Spec: Login\n\n## 1. Objective\n- **Goal:** Passkey login\n- [ ] AC-1: Verify login\n';
  const lockedPlanV1 =
    '# Plan: Login\n\n## Slice 1: Auth endpoint\n- **Owned files / subtree:** `src/auth/*`\n- **Status:** `[ ] Pending`\n\n## Slice 2: UI form\n- **Owned files / subtree:** `src/ui/*`\n- **Status:** `[ ] Pending`\n';
  fs.writeFileSync(specPath, lockedSpecV1);
  fs.writeFileSync(planPath, lockedPlanV1);
  setMtime(specPath, '2026-11-11T10:01:30.000Z');
  setMtime(planPath, '2026-11-11T10:01:45.000Z');

  const sameTurnSubagent = runHook('invoke_subagent', { TypeName: 'slice-builder' });
  assert.equal(sameTurnSubagent.decision, 'deny');
  const sameTurnSwarm = runHook('swarm', { action: 'add', name: 'author-1', brief: 'Build slice 1' });
  assert.equal(sameTurnSwarm.decision, 'deny');

  // 4. Unapproved artifact review comment (user left comments without clicking Proceed) -> deny!
  fs.appendFileSync(
    transcriptPath,
    JSON.stringify({
      step_index: 2,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      created_at: '2026-11-11T10:02:00.000Z',
      content: 'Comments on artifact URI: file:///tmp/harness_plan.md\n\nPlease use WebAuthn v2 instead.\n',
    }) + '\n',
  );
  assert.equal(runHook('invoke_subagent', { TypeName: 'slice-builder' }).decision, 'deny');

  // 5. User clicks Proceed ("The user has approved this document.") in a later turn -> allow!
  //    Real Antigravity runtime flushes the current PLANNER_RESPONSE (invoke_subagent mentioning
  //    .artifacts/SPEC.md and .artifacts/PLAN.md in Prompt, or read_file) to transcript.jsonl BEFORE
  //    PreToolUse executes; read-only/orchestration tool_calls must NOT trigger a false-positive self-lock!
  fs.appendFileSync(
    transcriptPath,
    JSON.stringify({
      step_index: 3,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      created_at: '2026-11-11T10:03:00.000Z',
      content: 'Comments on artifact URI: file:///tmp/harness_plan.md\n\nThe user has approved this document.\n',
    }) +
      '\n' +
      JSON.stringify({
        step_index: 4,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-11T10:03:02.000Z',
        tool_calls: [
          { name: 'read_file', args: { Path: specPath } },
          {
            name: 'edit_file',
            args: {
              Path: path.join(wsDir, 'scripts', 'other-test.js'),
              Target: 'old',
              Replacement: ' mentions .artifacts/SPEC.md in test body ',
            },
          },
          {
            name: 'invoke_subagent',
            args: {
              TypeName: 'slice-builder',
              Prompt: 'Implement Slice 1 per .artifacts/SPEC.md and .artifacts/PLAN.md',
            },
          },
        ],
      }) +
      '\n',
  );
  assert.equal(runHook('invoke_subagent', { TypeName: 'slice-builder' }).decision, 'allow');

  // 6. Checkbox/status progress updates between Slice 1 and Slice 2 do NOT re-lock execution!
  const planSlice1Done = lockedPlanV1.replace('`[ ] Pending`', '`[x] Completed`');
  const specAc1Checked = lockedSpecV1.replace('- [ ] AC-1:', '- [x] AC-1:');
  fs.writeFileSync(planPath, planSlice1Done);
  fs.writeFileSync(specPath, specAc1Checked);
  setMtime(planPath, '2026-11-11T10:04:00.000Z');
  setMtime(specPath, '2026-11-11T10:04:00.000Z');
  assert.equal(runHook('invoke_subagent', { TypeName: 'slice-builder' }).decision, 'allow');

  // 7. Substantive mid-flight modification to PLAN.md or SPEC.md IMMEDIATELY re-locks until user confirms again!
  const modifiedPlanV2 = planSlice1Done + '\n## Slice 3: Add Redis session store\n- **Status:** `[ ] Pending`\n';
  fs.writeFileSync(planPath, modifiedPlanV2);
  setMtime(planPath, '2026-11-11T10:05:00.000Z');
  const midFlightEditRes = runHook('invoke_subagent', { TypeName: 'slice-builder' });
  assert.equal(midFlightEditRes.decision, 'deny');

  // 8. Once user confirms the revised plan in a subsequent turn -> allow again!
  fs.appendFileSync(
    transcriptPath,
    JSON.stringify({
      step_index: 6,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      created_at: '2026-11-11T10:06:00.000Z',
      content: '<USER_REQUEST>同意新增 Slice 3，继续执行</USER_REQUEST>',
    }) + '\n',
  );
  assert.equal(runHook('invoke_subagent', { TypeName: 'slice-builder' }).decision, 'allow');

  // 9. Coordinator rule template and active workspace rule stay synced and declare tiered Proceed gates
  const tplRule = fs.readFileSync(
    path.join(ROOT, 'skills', 'harness-init', 'references', 'harness-rule-template.md'),
    'utf8',
  );
  const activeRule = fs.readFileSync(path.join(ROOT, '.agents', 'rules', 'agy-harness.md'), 'utf8');
  assert.equal(activeRule, tplRule, '.agents/rules/agy-harness.md must match harness-rule-template.md');
  assert.match(tplRule, /RequestFeedback:\s*true/);
  assert.match(tplRule, /harness_plan\.md/);
  assert.match(tplRule, /合并 1 次点击 `Proceed`/);
  assert.match(tplRule, /分 2 次点击 `Proceed`/);
});

test('subagents enforce 5s local command guardrails and [HOST_CMD_REQUEST] <-> send_message delegation protocol', () => {
  // AC-1: slice-builder local short-command boundary, blacklist, [HOST_CMD_REQUEST] template, and DELEGATED_TO_HOST
  const sliceBuilder = fs.readFileSync(path.join(ROOT, 'agents', 'slice-builder.md'), 'utf8');
  assert.match(sliceBuilder, /WaitMsBeforeAsync\s*<=\s*5000/);
  assert.match(sliceBuilder, /IsDaemon:\s*false/);
  assert.match(sliceBuilder, /IsDaemon:\s*true/);
  for (const banned of ['docker', 'podman', 'kubectl', 'testcontainers', 'install', '--watch', 'tail -f']) {
    assert.ok(sliceBuilder.includes(banned), `slice-builder.md must explicitly blacklist '${banned}'`);
  }
  assert.match(sliceBuilder, /## \[HOST_CMD_REQUEST\]/);
  assert.match(sliceBuilder, /Working directory \(`cwd`\):/);
  assert.match(sliceBuilder, /Commands to run:/);
  assert.match(sliceBuilder, /Purpose & expected signal:/);
  assert.match(sliceBuilder, /PASS \| DELEGATED_TO_HOST \| BLOCKED/);

  // AC-2: staff-gatekeeper & risk-specialist read-only short-command restriction and [HOST_CMD_REQUEST] fallback
  for (const reviewer of ['staff-gatekeeper.md', 'risk-specialist.md']) {
    const content = fs.readFileSync(path.join(ROOT, 'agents', reviewer), 'utf8');
    assert.match(content, /WaitMsBeforeAsync\s*<=\s*5000/, `${reviewer} must cap WaitMsBeforeAsync <= 5000`);
    assert.match(content, /git status/, `${reviewer} must scope run_command to fast read-only git checks`);
    assert.match(content, /docker/, `${reviewer} must forbid container commands`);
    assert.match(content, /\[HOST_CMD_REQUEST\]/, `${reviewer} must delegate heavy runtime checks via [HOST_CMD_REQUEST]`);
  }

  // AC-3: Coordinator rule & template stay byte-identical and establish [HOST_CMD_REQUEST] -> send_message loop
  const tplRule = fs.readFileSync(
    path.join(ROOT, 'skills', 'harness-init', 'references', 'harness-rule-template.md'),
    'utf8',
  );
  const activeRule = fs.readFileSync(path.join(ROOT, '.agents', 'rules', 'agy-harness.md'), 'utf8');
  assert.equal(activeRule, tplRule, '.agents/rules/agy-harness.md must stay byte-identical to harness-rule-template.md');
  assert.match(activeRule, /\[HOST_CMD_REQUEST\]/);
  assert.match(activeRule, /send_message\(Recipient:/);
  assert.match(activeRule, /conversationId/);
  assert.match(activeRule, /<=\s*50/);
  assert.match(activeRule, /`cwd`/);
});

test('gate-check.sh injects CI=true, GIT_PAGER=cat, --no-pager, and < /dev/null to prevent non-interactive hangs', async (t) => {
  const repoDir = makeTempDir('agy-harness-noninteractive-gate-');
  t.after(() => fs.rmSync(repoDir, { recursive: true, force: true }));

  const gateScript = path.join(ROOT, 'scripts', 'gate-check.sh');

  execFileSync('git', ['init', '-q'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir });

  const probePath = path.join(repoDir, 'probe-stdin.js');
  fs.writeFileSync(
    probePath,
    [
      "const fs = require('node:fs');",
      "if (process.env.CI !== 'true') {",
      "  console.error('Expected CI=true, got:', process.env.CI);",
      '  process.exit(1);',
      '}',
      "if (process.env.GIT_PAGER !== 'cat') {",
      "  console.error('Expected GIT_PAGER=cat, got:', process.env.GIT_PAGER);",
      '  process.exit(1);',
      '}',
      "const stdinData = fs.readFileSync(0, 'utf8');",
      "if (stdinData !== '') {",
      "  console.error('Expected empty stdin from /dev/null, got:', stdinData);",
      '  process.exit(1);',
      '}',
    ].join('\n') + '\n',
  );

  fs.writeFileSync(
    path.join(repoDir, 'package.json'),
    JSON.stringify(
      {
        name: 'noninteractive-probe',
        version: '1.0.0',
        scripts: {
          typecheck: 'node probe-stdin.js',
          lint: 'node probe-stdin.js',
          test: 'node probe-stdin.js',
        },
      },
      null,
      2,
    ) + '\n',
  );

  execFileSync('git', ['add', '.'], { cwd: repoDir });
  execFileSync('git', ['commit', '-q', '-m', 'init probe'], { cwd: repoDir });

  // Run gate-check.sh with stripped CI/GIT_PAGER and an intentionally OPEN stdin pipe (never closed by parent)
  const result = await new Promise((resolve, reject) => {
    const child = spawn('bash', [gateScript], {
      cwd: repoDir,
      env: { ...process.env, CI: '', GIT_PAGER: '' },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
      child.stdin.destroy();
      reject(new Error(`Timed out waiting for gate-check.sh (open stdin hung without < /dev/null). stdout=${stdout} stderr=${stderr}`));
    }, 3000);

    child.on('error', (err) => {
      clearTimeout(timer);
      child.stdin.destroy();
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      child.stdin.destroy();
      resolve({ code, stdout, stderr });
    });
  });

  assert.equal(
    result.code,
    0,
    `Expected gate-check.sh exit 0 under stripped env + open stdin, got code=${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  assert.match(result.stdout, /ALL SOFTWARE 1\.0 GATES PASSED\./);

  const gateSource = fs.readFileSync(gateScript, 'utf8');
  assert.match(gateSource, /export\s+CI=true\s+GIT_PAGER=cat/);
  assert.match(gateSource, /git\s+--no-pager\s+diff/);
  assert.doesNotMatch(gateSource, /\bgit\s+diff\b/, 'All git diff invocations in gate-check.sh must pass --no-pager');
});
