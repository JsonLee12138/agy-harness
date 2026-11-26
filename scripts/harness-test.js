'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

const EXPECTED_SUBAGENTS = {
  'arch-redteam': { model: 'inherit', mcpServers: '[]', policy: 'off', writable: false },
  'slice-builder': { model: 'inherit', mcpServers: '[]', policy: 'sandbox', writable: true },
  'staff-gatekeeper': { model: 'inherit', mcpServers: '[]', policy: 'sandbox', writable: false },
};

const WRITE_TOOLS = new Set([
  'write_to_file',
  'replace_file_content',
  'multi_replace_file_content',
  'write_file',
  'edit_file',
  'create_file',
  'delete_file',
  'sed_file',
]);

function parseAgentYaml(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  assert.ok(match, 'Expected YAML frontmatter block');
  const data = { tools: [], skills: [], hooks: [] };
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
      if (key === 'tools' || key === 'skills' || key === 'hooks') {
        currentList = key;
        if (val === '[]') {
          data[key] = [];
          currentList = null;
        }
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

function spawnHookAsync(scriptPath, payload, { cwd, env = {}, args = [] }) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [scriptPath, ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => {
      stdout += c;
    });
    child.stderr.on('data', (c) => {
      stderr += c;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      try {
        assert.equal(code, 0, `Expected exit 0 from ${path.basename(scriptPath)}, got ${code}. stderr=${stderr}`);
        resolve(JSON.parse(stdout.trim()));
      } catch (err) {
        reject(new Error(`Invalid JSON from ${path.basename(scriptPath)}: stdout=${stdout} stderr=${stderr} (${err.message})`));
      }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

function findExecutable(name) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const full = path.join(dir, name);
    try {
      fs.accessSync(full, fs.constants.X_OK);
      return full;
    } catch {}
  }
  return null;
}

test('plugin manifests use agy-harness v0.4.0 identity and lightweight 3-mode global rule', () => {
  const pluginJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin.json'), 'utf8'));
  assert.equal(pluginJson.name, 'agy-harness');
  assert.equal(pluginJson.version, '0.4.0');
  assert.equal(pluginJson.logo, 'assets/logo.svg');
  assert.ok(fs.existsSync(path.join(ROOT, 'assets', 'logo.svg')), 'assets/logo.svg must exist');

  const rulePath = path.join(ROOT, 'rules', 'AGENTS.md');
  assert.ok(fs.existsSync(rulePath), 'rules/AGENTS.md must exist');
  const ruleSize = fs.statSync(rulePath).size;
  assert.ok(ruleSize > 20 && ruleSize < 1500, `rules/AGENTS.md must stay lightweight (<1500B), got ${ruleSize}B`);
  const pluginRule = fs.readFileSync(rulePath, 'utf8');
  assert.match(pluginRule, /3-Mode Adaptive Routing/i);
  assert.match(pluginRule, /\bTrivial\b/);
  assert.match(pluginRule, /\bBug Fix\b/);
  assert.match(pluginRule, /\bContract\b/);
  assert.match(pluginRule, /arch-redteam/);
  assert.match(pluginRule, /75s/);
  assert.match(pluginRule, /gate-check\.sh/);

  for (const file of [
    'code-reviewer.md',
    'security-auditor.md',
    'test-engineer.md',
    'web-performance-auditor.md',
    'repo-scout.md',
    'risk-specialist.md',
  ]) {
    assert.ok(!fs.existsSync(path.join(ROOT, 'agents', file)), `legacy persona ${file} must not stay in agents/`);
    assert.ok(
      fs.existsSync(path.join(ROOT, 'docs', 'legacy-personas', file)),
      `legacy persona ${file} must be archived in docs/legacy-personas/`,
    );
  }
});

test('agents/ exposes 3 micro-capsuled subagents (skills: [], manage_task on slice-builder, physical read-write separation)', () => {
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
    assert.equal(fm.model, spec.model);
    assert.equal(fm.mcpServers, spec.mcpServers);
    assert.deepEqual(fm.skills, [], `${name} must use skills: [] micro-capsules to eliminate static preload token waste`);
    assert.equal(fm.commandExecutionPolicy, spec.policy);
    assert.ok(fm.tools.includes('read_file'));
    assert.ok(fm.tools.includes('view_file'));
    assert.ok(!fm.tools.includes('invoke_subagent'));

    const writeToolsPresent = fm.tools.filter((t) => WRITE_TOOLS.has(t));
    if (spec.writable) {
      assert.ok(writeToolsPresent.includes('write_file'));
      assert.ok(writeToolsPresent.includes('edit_file'));
      assert.ok(writeToolsPresent.includes('create_file'));
      assert.ok(fm.tools.includes('manage_task'), 'slice-builder must include manage_task for WS/DB handle cleanup');
      assert.ok(fm.hooks.includes('../scripts/hooks/slice-builder.hooks.json'));
      assert.match(content, /NotificationTimeoutSeconds:\s*45/);
      assert.match(content, /manage_task/);
      assert.match(content, /## \[HOST_CMD_REQUEST\]/);
    } else {
      assert.deepEqual(writeToolsPresent, []);
      if (name === 'staff-gatekeeper') {
        assert.ok(fm.hooks.includes('../scripts/hooks/staff-gatekeeper.hooks.json'));
        assert.match(content, /\[HOST_CMD_REQUEST\]/);
      }
    }
  }
});

test('gate-check.sh supports fingerprint dedup, --force, --fast, lockfile diff exclusion, and secret/debugger scans', async (t) => {
  const repoDir = makeTempDir('agy-harness-gate-v04-');
  const stateDir = makeTempDir('agy-harness-gate-state-');
  t.after(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  const gateScript = path.join(ROOT, 'scripts', 'gate-check.sh');
  const gateEnv = { ...process.env, AGY_HARNESS_STATE_DIR: stateDir };

  execFileSync('git', ['init', '-q'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir });

  const counterPath = path.join(stateDir, 'counter.txt');
  fs.writeFileSync(counterPath, '');
  fs.writeFileSync(
    path.join(repoDir, 'package.json'),
    JSON.stringify(
      {
        name: 'gate-dedup-probe',
        version: '1.0.0',
        scripts: {
          'test:fast': 'node -e "console.log(\'FAST_TEST_RAN\')"',
          test: 'node -e "const fs=require(\'fs\'),path=require(\'path\'); fs.appendFileSync(path.join(process.env.AGY_HARNESS_STATE_DIR,\'counter.txt\'), \'1\\n\'); console.log(\'FULL_TEST_RAN\')"',
        },
      },
      null,
      2,
    ) + '\n',
  );
  execFileSync('git', ['add', '.'], { cwd: repoDir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repoDir });

  // 1. First full pass runs tests and records fingerprint
  const out1 = execFileSync('bash', [gateScript], { cwd: repoDir, encoding: 'utf8', env: gateEnv });
  assert.match(out1, /FULL_TEST_RAN/);
  assert.match(out1, /ALL SOFTWARE 1\.0 GATES PASSED\./);
  assert.equal(fs.readFileSync(counterPath, 'utf8').trim().split('\n').length, 1);

  // 2. Second run on identical tree hits [Gate Dedup] (does NOT re-run full test!)
  const out2 = execFileSync('bash', [gateScript], { cwd: repoDir, encoding: 'utf8', env: gateEnv });
  assert.match(out2, /\[Gate Dedup\]/);
  assert.doesNotMatch(out2, /FULL_TEST_RAN/);
  assert.equal(fs.readFileSync(counterPath, 'utf8').trim().split('\n').length, 1);

  // 3. --force bypasses dedup and runs full test again
  const outForce = execFileSync('bash', [gateScript, '--force'], { cwd: repoDir, encoding: 'utf8', env: gateEnv });
  assert.doesNotMatch(outForce, /\[Gate Dedup\]/);
  assert.match(outForce, /FULL_TEST_RAN/);
  assert.equal(fs.readFileSync(counterPath, 'utf8').trim().split('\n').length, 2);

  // 4. Editing a source file invalidates fingerprint; lockfile >400 lines is excluded from diff warning
  const bigLock = Array.from({ length: 450 }, (_, i) => `pkg-${i}: 1.0.0`).join('\n') + '\n';
  fs.writeFileSync(path.join(repoDir, 'pnpm-lock.yaml'), bigLock);
  const outLock = execFileSync('bash', [gateScript], { cwd: repoDir, encoding: 'utf8', env: gateEnv });
  assert.match(outLock, /FULL_TEST_RAN/);
  assert.doesNotMatch(outLock, /WARN: Diff exceeds 400 lines/);

  // 5. --fast runs test:fast and skips full test
  const fastOut = execFileSync('bash', [gateScript, '--fast'], { cwd: repoDir, encoding: 'utf8', env: gateEnv });
  assert.match(fastOut, /FAST_TEST_RAN/);
  assert.doesNotMatch(fastOut, /FULL_TEST_RAN/);

  // 6. Real source diff >400 lines triggers WARN; debug statements and leaked secrets block Gate 4
  const bigSrc = Array.from({ length: 420 }, (_, i) => `const v_${i} = ${i};`).join('\n') + '\n';
  fs.writeFileSync(path.join(repoDir, 'app.js'), bigSrc);
  execFileSync('git', ['add', 'app.js'], { cwd: repoDir });
  const warnOut = execFileSync('bash', [gateScript, '--force'], { cwd: repoDir, encoding: 'utf8', env: gateEnv });
  assert.match(warnOut, /WARN: Diff exceeds 400 lines/);

  const dbgStmt = 'deb' + 'ugger;';
  fs.writeFileSync(path.join(repoDir, 'app.js'), `const x = 1;\n${dbgStmt}\n`);
  assert.throws(
    () => execFileSync('bash', [gateScript], { cwd: repoDir, encoding: 'utf8', stdio: 'pipe', env: gateEnv }),
    /Potential secret or debugger statement detected/,
  );

  fs.writeFileSync(path.join(repoDir, 'app.js'), 'const x = 1;\n');
  const fakePat = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
  fs.writeFileSync(path.join(repoDir, 'NOTES.md'), `Token: ${fakePat}\n`);
  execFileSync('git', ['add', 'NOTES.md'], { cwd: repoDir });
  assert.throws(
    () => execFileSync('bash', [gateScript, '--force'], { cwd: repoDir, encoding: 'utf8', stdio: 'pipe', env: gateEnv }),
    /Potential secret or debugger statement detected/,
  );
});

test('gate-check.sh injects CI=true, GIT_PAGER=cat, --no-pager, and < /dev/null to prevent hangs', async (t) => {
  const repoDir = makeTempDir('agy-harness-noninteractive-gate-');
  const stateDir = makeTempDir('agy-harness-noninteractive-state-');
  t.after(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  const gateScript = path.join(ROOT, 'scripts', 'gate-check.sh');
  execFileSync('git', ['init', '-q'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir });

  fs.writeFileSync(
    path.join(repoDir, 'probe-stdin.js'),
    [
      "const fs = require('node:fs');",
      "if (process.env.CI !== 'true') process.exit(1);",
      "if (process.env.GIT_PAGER !== 'cat') process.exit(1);",
      "if (fs.readFileSync(0, 'utf8') !== '') process.exit(1);",
    ].join('\n') + '\n',
  );
  fs.writeFileSync(
    path.join(repoDir, 'package.json'),
    JSON.stringify({ name: 'probe', version: '1.0.0', scripts: { typecheck: 'node probe-stdin.js', lint: 'node probe-stdin.js', test: 'node probe-stdin.js' } }) + '\n',
  );
  execFileSync('git', ['add', '.'], { cwd: repoDir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repoDir });

  const result = await new Promise((resolve, reject) => {
    const child = spawn('bash', [gateScript], {
      cwd: repoDir,
      env: { ...process.env, CI: '', GIT_PAGER: '', AGY_HARNESS_STATE_DIR: stateDir },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      child.stdin.destroy();
      reject(new Error('Timed out waiting for gate-check.sh'));
    }, 3000);
    child.on('close', (code) => {
      clearTimeout(timer);
      child.stdin.destroy();
      resolve({ code, stdout, stderr });
    });
  });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /ALL SOFTWARE 1\.0 GATES PASSED\./);
});

test('init-harness.sh uses clean-room defaults, cleans legacy v0.3 clutter, and supports --standalone', (t) => {
  const targetDir = makeTempDir('agy-harness-cleanroom-');
  t.after(() => fs.rmSync(targetDir, { recursive: true, force: true }));

  const initScript = path.join(ROOT, 'scripts', 'init-harness.sh');
  assert.ok(fs.existsSync(initScript));

  // Seed legacy v0.3 artifacts & scripts before upgrading
  fs.mkdirSync(path.join(targetDir, 'scripts', 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(targetDir, '.agents', 'agents'), { recursive: true });
  fs.mkdirSync(path.join(targetDir, '.artifacts'), { recursive: true });
  for (const oldScript of [
    'scripts/harness-approval-gate.sh',
    'scripts/harness-source-edit-guard.sh',
    'scripts/harness-lifecycle-hook.sh',
    'scripts/harness-subagent-guard.sh',
    'scripts/hooks/slice-builder.hooks.json',
    'scripts/hooks/staff-gatekeeper.hooks.json',
    '.agents/agents/repo-scout.md',
    '.agents/agents/slice-builder.md',
  ]) {
    fs.writeFileSync(path.join(targetDir, oldScript), '# legacy v0.3\n');
  }
  fs.writeFileSync(path.join(targetDir, '.artifacts', 'context-brief.md'), '# Context Brief\n- _Pending discovery_\n');
  fs.writeFileSync(path.join(targetDir, '.artifacts', 'SPEC.md'), '# Custom Spec Locked\n');
  fs.writeFileSync(path.join(targetDir, 'scripts', 'gate-check.sh'), '#!/usr/bin/env bash\necho custom-gate\n');
  fs.writeFileSync(
    path.join(targetDir, '.agents', 'hooks.json'),
    JSON.stringify({
      'custom-user-hook': { PostToolUse: [{ matcher: 'run_command', hooks: [{ command: 'echo ok' }] }] },
      'harness-contract-approval-gate': {},
      'harness-parent-source-edit-guard': {},
      'harness-lifecycle-guard': {},
    }, null, 2) + '\n',
  );
  fs.writeFileSync(path.join(targetDir, '.gitignore'), 'node_modules/');

  // Run default clean-room init
  execFileSync('bash', [initScript, targetDir], { encoding: 'utf8' });

  // Clean-room files present
  for (const rel of [
    '.gitignore',
    '.agents/rules/agy-harness.md',
    'scripts/gate-check.sh',
    '.artifacts/.gitignore',
    '.artifacts/SPEC.md',
    '.artifacts/CONSTRAINTS.md',
    '.artifacts/PLAN.md',
  ]) {
    assert.ok(fs.existsSync(path.join(targetDir, rel)), `Expected ${rel}`);
  }
  // Legacy clutter removed!
  for (const removed of [
    'scripts/harness-approval-gate.sh',
    'scripts/harness-source-edit-guard.sh',
    'scripts/harness-lifecycle-hook.sh',
    'scripts/harness-subagent-guard.sh',
    'scripts/hooks/slice-builder.hooks.json',
    'scripts/hooks/staff-gatekeeper.hooks.json',
    'scripts/hooks',
    '.artifacts/context-brief.md',
    '.agents/agents/repo-scout.md',
    '.agents/agents/slice-builder.md',
  ]) {
    assert.ok(!fs.existsSync(path.join(targetDir, removed)), `Legacy ${removed} must be cleaned up`);
  }
  // Customizations preserved!
  assert.equal(fs.readFileSync(path.join(targetDir, '.artifacts', 'SPEC.md'), 'utf8'), '# Custom Spec Locked\n');
  assert.equal(fs.readFileSync(path.join(targetDir, 'scripts', 'gate-check.sh'), 'utf8'), '#!/usr/bin/env bash\necho custom-gate\n');
  const cleanedHooks = JSON.parse(fs.readFileSync(path.join(targetDir, '.agents', 'hooks.json'), 'utf8'));
  assert.ok(cleanedHooks['custom-user-hook'], 'custom-user-hook must be preserved');
  assert.equal(cleanedHooks['harness-lifecycle-guard'], undefined, 'legacy harness hooks must be stripped');
  assert.match(fs.readFileSync(path.join(targetDir, '.gitignore'), 'utf8'), /^node_modules\/\n\.artifacts\/\n/);

  // Test --standalone installs hidden hooks & agents under .agents/ while keeping scripts/ clean
  execFileSync('bash', [initScript, targetDir, '--standalone'], { encoding: 'utf8' });
  for (const stRel of [
    '.agents/hooks/lib/harness-core.js',
    '.agents/hooks/lib/harness-core.py',
    '.agents/hooks/harness-approval-gate.sh',
    '.agents/hooks/harness-source-edit-guard.sh',
    '.agents/hooks/harness-lifecycle-hook.sh',
    '.agents/hooks/harness-subagent-guard.sh',
    '.agents/hooks/slice-builder.hooks.json',
    '.agents/hooks/staff-gatekeeper.hooks.json',
    '.agents/agents/arch-redteam.md',
    '.agents/agents/slice-builder.md',
    '.agents/agents/staff-gatekeeper.md',
  ]) {
    assert.ok(fs.existsSync(path.join(targetDir, stRel)), `Expected standalone file ${stRel}`);
  }
  assert.ok(!fs.existsSync(path.join(targetDir, 'scripts', 'harness-approval-gate.sh')), 'Top-level scripts/ must stay clean in --standalone mode');
  const standaloneHooks = JSON.parse(fs.readFileSync(path.join(targetDir, '.agents', 'hooks.json'), 'utf8'));
  assert.ok(standaloneHooks['custom-user-hook']);
  assert.equal(
    standaloneHooks['harness-contract-approval-gate'].PreToolUse[0].hooks[0].command,
    './hooks/harness-approval-gate.sh',
  );
  const localBuilder = fs.readFileSync(path.join(targetDir, '.agents', 'agents', 'slice-builder.md'), 'utf8');
  assert.match(localBuilder, /\.\.\/hooks\/slice-builder\.hooks\.json/);

  // Verify idempotent SKIP on re-run with --standalone
  const rerun = spawnSync('bash', [initScript, targetDir, '--standalone'], { encoding: 'utf8' });
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.doesNotMatch(rerun.stderr, /\b(?:WROTE|UPDATED|MERGED):/);

  // Switching back to default clean-room mode removes .agents/hooks/ & .agents/agents/
  execFileSync('bash', [initScript, targetDir], { encoding: 'utf8' });
  assert.ok(!fs.existsSync(path.join(targetDir, '.agents', 'hooks')), 'Default clean-room mode must clean standalone .agents/hooks');
  assert.ok(!fs.existsSync(path.join(targetDir, '.agents', 'agents')), 'Default clean-room mode must clean standalone .agents/agents');
});

test('approval gate, source-edit guard (warm-cache vs SUBAGENT_ONLY & PAUSED), subagent anti-hang overwrite, and lifecycle Stop isolation', async (t) => {
  const baseDir = makeTempDir('agy-harness-v04-suite-');
  const stateDir = makeTempDir('agy-harness-v04-state-');
  t.after(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  const approvalGate = path.join(ROOT, 'scripts', 'harness-approval-gate.sh');
  const sourceGuard = path.join(ROOT, 'scripts', 'harness-source-edit-guard.sh');
  const subGuard = path.join(ROOT, 'scripts', 'harness-subagent-guard.sh');
  const lifecycleHook = path.join(ROOT, 'scripts', 'harness-lifecycle-hook.sh');

  const wsDir = path.join(baseDir, 'app-repo');
  fs.mkdirSync(path.join(wsDir, '.artifacts'), { recursive: true });
  fs.mkdirSync(path.join(wsDir, '.agents', 'rules'), { recursive: true });
  fs.mkdirSync(path.join(wsDir, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(wsDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(wsDir, '.agents', 'rules', 'agy-harness.md'), '# rule\n');
  fs.writeFileSync(path.join(wsDir, 'scripts', 'gate-check.sh'), '#!/bin/bash\nexit 0\n');
  fs.writeFileSync(path.join(wsDir, 'src', 'a.js'), 'export const a = 1;\n');
  execFileSync('git', ['init', '-q'], { cwd: wsDir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: wsDir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: wsDir });
  execFileSync('git', ['add', '.'], { cwd: wsDir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: wsDir });

  const specPath = path.join(wsDir, '.artifacts', 'SPEC.md');
  const planPath = path.join(wsDir, '.artifacts', 'PLAN.md');

  const tUnapproved = path.join(baseDir, 't-unapproved.jsonl');
  fs.writeFileSync(tUnapproved, JSON.stringify({ step_index: 1, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2099-01-01T00:00:00.000Z', content: 'Build auth' }) + '\n');

  const tApproved = path.join(baseDir, 't-approved.jsonl');
  fs.writeFileSync(tApproved, JSON.stringify({ step_index: 1, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2099-01-01T00:00:00.000Z', content: 'The user has approved this document.' }) + '\n');

  const tSubagent = path.join(baseDir, 't-subagent.jsonl');
  fs.writeFileSync(tSubagent, JSON.stringify({ step_index: 0, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', content: '<SYSTEM_MESSAGE>[Message] sender=parent</SYSTEM_MESSAGE>' }) + '\n');

  const tReadOnlyQa = path.join(baseDir, 't-qa.jsonl');
  fs.writeFileSync(tReadOnlyQa, [
    JSON.stringify({ step_index: 1, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2099-01-01T00:00:00.000Z', content: 'Explain auth flow' }),
    JSON.stringify({ step_index: 2, source: 'MODEL', type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'read_file', args: { Path: 'src/a.js' } }] }),
  ].join('\n') + '\n');

  const env = { AGY_HARNESS_STATE_DIR: stateDir };

  // 1. exit_plan_mode on plain 6-file refactor (INACTIVE) is allowed without arbitrary 5-file force_ask; slice-builder without Phase 1 stop still force_asks
  assert.equal((await spawnHookAsync(approvalGate, { workspacePaths: [wsDir], transcriptPath: tUnapproved, toolCall: { name: 'exit_plan_mode', args: { plan: 'Edit src/a.js, src/b.js, src/c.js, src/d.js, src/e.js, src/f.js' } } }, { cwd: wsDir, env })).decision, 'allow');
  assert.equal((await spawnHookAsync(approvalGate, { workspacePaths: [wsDir], transcriptPath: tUnapproved, toolCall: { name: 'exit_plan_mode', args: { plan: 'Invoke slice-builder immediately' } } }, { cwd: wsDir, env })).decision, 'force_ask');

  // 2. Active unapproved contract: arch-redteam is allowed pre-confirmation, while parent source edits & slice-builder are blocked
  fs.writeFileSync(specPath, '# SPEC\n- **Goal:** Auth middleware\n- [ ] AC-1: Verify JWT\n');
  fs.writeFileSync(planPath, '# PLAN\n## Slice 1: JWT\n- **Status:** `[ ] Pending`\n');
  assert.equal((await spawnHookAsync(approvalGate, { conversationId: 'c1', workspacePaths: [wsDir], transcriptPath: tUnapproved, toolCall: { name: 'invoke_subagent', args: { TypeName: 'arch-redteam' } } }, { cwd: wsDir, env })).decision, 'allow');
  assert.equal((await spawnHookAsync(approvalGate, { conversationId: 'c1', workspacePaths: [wsDir], transcriptPath: tUnapproved, toolCall: { name: 'invoke_subagent', args: { TypeName: 'slice-builder' } } }, { cwd: wsDir, env })).decision, 'force_ask');
  assert.equal((await spawnHookAsync(sourceGuard, { conversationId: 'c1', workspacePaths: [wsDir], transcriptPath: tUnapproved, toolCall: { name: 'edit_file', args: { Path: 'src/a.js' } } }, { cwd: wsDir, env })).decision, 'deny');

  // 3. After Proceed: warm-cache parent edits are ALLOWED by default; adding SUBAGENT_ONLY locks parent edits again
  assert.equal((await spawnHookAsync(sourceGuard, { conversationId: 'c1', workspacePaths: [wsDir], transcriptPath: tApproved, toolCall: { name: 'edit_file', args: { Path: 'src/a.js' } } }, { cwd: wsDir, env })).decision, 'allow');
  assert.equal((await spawnHookAsync(approvalGate, { conversationId: 'c1', workspacePaths: [wsDir], transcriptPath: tApproved, toolCall: { name: 'invoke_subagent', args: { TypeName: 'slice-builder' } } }, { cwd: wsDir, env })).decision, 'allow');

  fs.writeFileSync(planPath, '# PLAN\n<!-- HARNESS_EXECUTION: SUBAGENT_ONLY -->\n## Slice 1: JWT\n- **Status:** `[ ] Pending`\n');
  assert.equal((await spawnHookAsync(sourceGuard, { conversationId: 'c1', workspacePaths: [wsDir], transcriptPath: tApproved, toolCall: { name: 'edit_file', args: { Path: 'src/a.js' } } }, { cwd: wsDir, env })).decision, 'deny');

  // 4. PAUSED contract unlocks parent edits (for side-quest) and blocks slice-builder until resumed
  fs.writeFileSync(planPath, '# PLAN\n<!-- HARNESS_STATUS: PAUSED -->\n## Slice 1: JWT\n- **Status:** `[ ] Pending`\n');
  assert.equal((await spawnHookAsync(sourceGuard, { conversationId: 'c1', workspacePaths: [wsDir], transcriptPath: tApproved, toolCall: { name: 'edit_file', args: { Path: 'src/a.js' } } }, { cwd: wsDir, env })).decision, 'allow');
  assert.equal((await spawnHookAsync(approvalGate, { conversationId: 'c1', workspacePaths: [wsDir], transcriptPath: tApproved, toolCall: { name: 'invoke_subagent', args: { TypeName: 'slice-builder' } } }, { cwd: wsDir, env })).decision, 'deny');

  // 5. Subagent guard: clamps WaitMsBeforeAsync > 10000 -> 10000 & injects NotificationTimeoutSeconds=45
  const sbCmdDefault = await spawnHookAsync(subGuard, { workspacePaths: [wsDir], toolCall: { name: 'run_command', args: { CommandLine: 'node --test', WaitMsBeforeAsync: 5000, IsDaemon: false } } }, { cwd: wsDir, env, args: ['--role=slice-builder'] });
  assert.equal(sbCmdDefault.decision, 'allow');
  assert.deepEqual(sbCmdDefault.overwrite, { NotificationTimeoutSeconds: 45 });

  const sbCmdSlow = await spawnHookAsync(subGuard, { workspacePaths: [wsDir], toolCall: { name: 'run_command', args: { CommandLine: 'vitest run', WaitMsBeforeAsync: 25000 } } }, { cwd: wsDir, env, args: ['--role=slice-builder'] });
  assert.equal(sbCmdSlow.decision, 'allow');
  assert.deepEqual(sbCmdSlow.overwrite, { WaitMsBeforeAsync: 10000, NotificationTimeoutSeconds: 45 });

  const sbCmdCustomNotify = await spawnHookAsync(subGuard, { workspacePaths: [wsDir], toolCall: { name: 'run_command', args: { CommandLine: 'node --test', WaitMsBeforeAsync: 5000, NotificationTimeoutSeconds: 30 } } }, { cwd: wsDir, env, args: ['--role=slice-builder'] });
  assert.equal(sbCmdCustomNotify.decision, 'allow');
  assert.equal(sbCmdCustomNotify.overwrite, undefined);

  const gkCmd = await spawnHookAsync(subGuard, { workspacePaths: [wsDir], toolCall: { name: 'run_command', args: { CommandLine: 'git status' } } }, { cwd: wsDir, env, args: ['--role=staff-gatekeeper'] });
  assert.equal(gkCmd.decision, 'allow');
  assert.deepEqual(gkCmd.overwrite, { NotificationTimeoutSeconds: 45 });

  // 6. Lifecycle hook: trivial exempt paths (.css, .env.example, locales/*.json), cross-conversation Stop isolation, and Git fingerprint allow
  for (const exemptPath of ['src/styles.css', 'src/theme.scss', '.env.example', 'src/locales/zh.json']) {
    await spawnHookAsync(lifecycleHook, { conversationId: 'conv-exempt', workspacePaths: [wsDir], transcriptPath: tApproved, hookEventName: 'PostToolUse', toolCall: { name: 'edit_file', args: { Path: exemptPath } } }, { cwd: wsDir, env });
  }
  assert.equal(
    (await spawnHookAsync(lifecycleHook, { conversationId: 'conv-exempt', workspacePaths: [wsDir], transcriptPath: tApproved, hookEventName: 'Stop', terminationReason: 'NO_TOOL_CALL', fullyIdle: true }, { cwd: wsDir, env })).decision,
    'allow',
  );

  // Conversation A edits src/a.js on disk -> Conversation A Stop continues, while pure Q&A Conversation B Stop allows!
  fs.writeFileSync(path.join(wsDir, 'src', 'a.js'), 'export const a = 2;\n');
  await spawnHookAsync(lifecycleHook, { conversationId: 'conv-A', workspacePaths: [wsDir], transcriptPath: tApproved, hookEventName: 'PostToolUse', toolCall: { name: 'edit_file', args: { Path: 'src/a.js' } } }, { cwd: wsDir, env });
  assert.equal(
    (await spawnHookAsync(lifecycleHook, { conversationId: 'conv-B', workspacePaths: [wsDir], transcriptPath: tReadOnlyQa, hookEventName: 'Stop', terminationReason: 'NO_TOOL_CALL', fullyIdle: true }, { cwd: wsDir, env })).decision,
    'allow',
    'Pure read-only Conversation B must NOT be hijacked by dirty Conversation A',
  );
  assert.equal(
    (await spawnHookAsync(lifecycleHook, { conversationId: 'conv-A', workspacePaths: [wsDir], transcriptPath: tApproved, hookEventName: 'Stop', terminationReason: 'NO_TOOL_CALL', fullyIdle: true }, { cwd: wsDir, env })).decision,
    'continue',
  );

  // executionNum > 0 stops anti-loop runaway
  assert.equal(
    (await spawnHookAsync(lifecycleHook, { conversationId: 'conv-A', workspacePaths: [wsDir], transcriptPath: tApproved, hookEventName: 'Stop', terminationReason: 'NO_TOOL_CALL', fullyIdle: true, executionNum: 1 }, { cwd: wsDir, env })).decision,
    'allow',
  );

  // Running gate-check.sh directly (e.g. inside subagent) records workspace fingerprint -> parent Stop sees matching fingerprint and allows!
  execFileSync('bash', [path.join(ROOT, 'scripts', 'gate-check.sh')], { cwd: wsDir, env: { ...process.env, AGY_HARNESS_STATE_DIR: stateDir } });
  assert.equal(
    (await spawnHookAsync(lifecycleHook, { conversationId: 'conv-A', workspacePaths: [wsDir], transcriptPath: tApproved, hookEventName: 'Stop', terminationReason: 'NO_TOOL_CALL', fullyIdle: true }, { cwd: wsDir, env })).decision,
    'allow',
    'Stop must allow immediately when workspace Git fingerprint matches passing gate-check.sh',
  );

  // 7. Python3 fallback parity check (without node on PATH)
  const pyBin = findExecutable('python3');
  assert.ok(pyBin, 'python3 must be available');
  const noNodeBin = path.join(baseDir, 'nonode-bin');
  fs.mkdirSync(noNodeBin, { recursive: true });
  for (const binName of ['bash', 'sh', 'cat', 'dirname', 'git', 'python3']) {
    const resolved = findExecutable(binName);
    if (resolved) fs.symlinkSync(resolved, path.join(noNodeBin, binName));
  }
  const pyEnv = { PATH: noNodeBin, AGY_HARNESS_STATE_DIR: stateDir };

  const pySubOverwrite = await spawnHookAsync(subGuard, { workspacePaths: [wsDir], toolCall: { name: 'run_command', args: { CommandLine: 'pytest -q', WaitMsBeforeAsync: 20000 } } }, { cwd: wsDir, env: pyEnv, args: ['--role=slice-builder'] });
  assert.equal(pySubOverwrite.decision, 'allow');
  assert.deepEqual(pySubOverwrite.overwrite, { WaitMsBeforeAsync: 10000, NotificationTimeoutSeconds: 45 });

  const pyQaStop = await spawnHookAsync(lifecycleHook, { conversationId: 'conv-B-py', workspacePaths: [wsDir], transcriptPath: tReadOnlyQa, hookEventName: 'Stop', terminationReason: 'NO_TOOL_CALL', fullyIdle: true }, { cwd: wsDir, env: pyEnv });
  assert.equal(pyQaStop.decision, 'allow');

  const pyPre = await spawnHookAsync(lifecycleHook, { conversationId: 'conv-py-pre', workspacePaths: [wsDir], transcriptPath: tApproved, hookEventName: 'PreInvocation' }, { cwd: wsDir, env: pyEnv });
  assert.equal(pyPre.injectSteps.length, 1);
  assert.match(pyPre.injectSteps[0].systemMessage.systemMessage, /Trivial.*Bug Fix.*Contract/);
});

test('slim rules, docs, SKILL.md, and evals parity stay synced for v0.4.0', () => {
  const activeRule = fs.readFileSync(path.join(ROOT, '.agents', 'rules', 'agy-harness.md'), 'utf8');
  const tplRule = fs.readFileSync(path.join(ROOT, 'skills', 'harness-init', 'references', 'harness-rule-template.md'), 'utf8');
  assert.equal(activeRule, tplRule);
  const byteLen = Buffer.byteLength(activeRule, 'utf8');
  assert.ok(byteLen <= 3500, `Coordinator rule must stay <= 3500B, got ${byteLen}B`);

  for (const pat of [
    /Trivial/,
    /Bug Fix/,
    /Contract/,
    /arch-redteam/,
    /NotificationTimeoutSeconds:\s*45/,
    /DurationSeconds:\s*75/,
    /HARNESS_STATUS:\s*PAUSED/,
    /HARNESS_EXECUTION:\s*SUBAGENT_ONLY/,
    /HARNESS_STATUS:\s*ARCHIVED/,
  ]) {
    assert.match(activeRule, pat);
  }

  const skillMd = fs.readFileSync(path.join(ROOT, 'skills', 'harness-init', 'SKILL.md'), 'utf8');
  assert.match(skillMd, /--standalone/);
  assert.match(skillMd, /HARNESS_STATUS:\s*PAUSED/);
  assert.match(skillMd, /NotificationTimeoutSeconds:\s*45/);

  const coordFormatted = byteLen.toLocaleString('en-US');
  const pluginRuleFormatted = Buffer.byteLength(fs.readFileSync(path.join(ROOT, 'rules', 'AGENTS.md'), 'utf8'), 'utf8').toLocaleString('en-US');

  for (const docRel of ['docs/antigravity-setup.md', 'docs/agents.md', 'README.md', 'README.zh.md']) {
    const txt = fs.readFileSync(path.join(ROOT, docRel), 'utf8');
    assert.ok(txt.includes(`${coordFormatted} B`), `${docRel} must report ${coordFormatted} B`);
    if (docRel.startsWith('docs/')) {
      assert.ok(txt.includes(`${pluginRuleFormatted} B`), `${docRel} must report ${pluginRuleFormatted} B`);
    }
  }

  const agyBin = findExecutable('agy');
  if (agyBin) {
    const report = JSON.parse(execFileSync(agyBin, ['plugin', 'validate', '--json', '.'], { cwd: ROOT, encoding: 'utf8' }));
    const badFindings = (report.findings || []).filter(
      (f) => f.severity === 'error' || (f.severity === 'warning' && /^(?:hooks\.json|agents\/)/.test(String(f.file || ''))),
    );
    assert.deepEqual(badFindings, [], `Unexpected agy plugin validate findings: ${JSON.stringify(badFindings)}`);
  }
});
