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
  const pluginRule = fs.readFileSync(rulePath, 'utf8');
  assert.match(pluginRule, /hooks\.json/);
  assert.match(pluginRule, /harness-lifecycle-hook\.sh/);
  assert.match(pluginRule, /Plan Mode/i);
  assert.match(pluginRule, /uninitialized/i);
  assert.doesNotMatch(pluginRule, /\bzero CRG\b/i);
  assert.match(pluginRule, /Tier XS/);
  assert.match(pluginRule, /Tier S/);
  assert.match(pluginRule, /Tier M\/L\/XL/);
  assert.match(pluginRule, /root[- ]cause|debugging-and-error-recovery/i);
  assert.match(pluginRule, /TDD|RED\s*->\s*GREEN|test-driven-development/i);
  assert.match(pluginRule, /Stop/i);
  assert.match(pluginRule, /INACTIVE/i);

  const legacyPersonas = [
    'code-reviewer.md',
    'security-auditor.md',
    'test-engineer.md',
    'web-performance-auditor.md',
    'repo-scout.md',
    'risk-specialist.md',
  ];
  for (const file of legacyPersonas) {
    assert.ok(!fs.existsSync(path.join(ROOT, 'agents', file)), `legacy persona ${file} must not stay in agents/`);
    assert.ok(
      fs.existsSync(path.join(ROOT, 'docs', 'legacy-personas', file)),
      `legacy persona ${file} must be archived in docs/legacy-personas/`,
    );
  }
});

test('agents/ exposes exactly the 3 Lean Harness subagents with model: inherit, mcpServers: [], agy-harness:* skills, and physical read-write separation', () => {
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
    assert.equal(fm.mcpServers, spec.mcpServers, `${name} must explicitly disable mcpServers ([])`);
    assert.equal(fm.commandExecutionPolicy, spec.policy, `${name} commandExecutionPolicy mismatch`);

    if (name === 'staff-gatekeeper') {
      assert.ok(
        fm.skills.includes('agy-harness:security-and-hardening'),
        '4-in-1 staff-gatekeeper must include agy-harness:security-and-hardening',
      );
      assert.ok(
        fm.skills.includes('agy-harness:performance-optimization'),
        '4-in-1 staff-gatekeeper must include agy-harness:performance-optimization',
      );
    }

    assert.ok(fm.skills.length > 0, `${name} must mount at least one skill`);
    for (const skillRef of fm.skills) {
      assert.match(skillRef, /^agy-harness:[a-z0-9-]+$/, `${name} skill '${skillRef}' must use agy-harness: prefix`);
      const skillDir = skillRef.slice('agy-harness:'.length);
      assert.ok(
        fs.existsSync(path.join(ROOT, 'skills', skillDir, 'SKILL.md')),
        `${name} references missing skill directory skills/${skillDir}/SKILL.md`,
      );
    }

    assert.ok(fm.tools.includes('read_file'), `${name} must include canonical read_file tool`);
    assert.ok(fm.tools.includes('view_file'), `${name} must keep legacy view_file alias`);

    const writeToolsPresent = fm.tools.filter((t) => WRITE_TOOLS.has(t));
    if (spec.writable) {
      assert.ok(writeToolsPresent.includes('write_file'), `${name} must include write_file`);
      assert.ok(writeToolsPresent.includes('edit_file'), `${name} must include edit_file`);
      assert.ok(writeToolsPresent.includes('create_file'), `${name} must include create_file`);
      assert.ok(writeToolsPresent.includes('write_to_file'), `${name} must include write_to_file`);
      assert.ok(writeToolsPresent.includes('replace_file_content'), `${name} must include replace_file_content`);
      assert.ok(!fm.tools.includes('invoke_subagent'), `${name} must not spawn nested subagents`);
      assert.ok(
        fm.hooks.includes('../scripts/hooks/slice-builder.hooks.json'),
        `${name} must declare ../scripts/hooks/slice-builder.hooks.json in hooks:`,
      );
    } else {
      assert.deepEqual(
        writeToolsPresent,
        [],
        `Read-only subagent ${name} MUST NOT have write tools, found: ${writeToolsPresent.join(', ')}`,
      );
      assert.ok(!fm.tools.includes('invoke_subagent'), `${name} must not spawn nested subagents`);
      if (name === 'staff-gatekeeper') {
        assert.ok(
          fm.hooks.includes('../scripts/hooks/staff-gatekeeper.hooks.json'),
          `${name} must declare ../scripts/hooks/staff-gatekeeper.hooks.json in hooks:`,
        );
      }
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
    'scripts/harness-source-edit-guard.sh',
    'scripts/harness-lifecycle-hook.sh',
    'scripts/harness-subagent-guard.sh',
    'scripts/hooks/slice-builder.hooks.json',
    'scripts/hooks/staff-gatekeeper.hooks.json',
    '.artifacts/.gitignore',
    '.artifacts/context-brief.md',
    '.artifacts/SPEC.md',
    '.artifacts/CONSTRAINTS.md',
    '.artifacts/PLAN.md',
  ];
  for (const rel of expectedPaths) {
    assert.ok(fs.existsSync(path.join(targetDir, rel)), `Expected scaffolded file ${rel}`);
  }
  for (const exeRel of [
    'scripts/gate-check.sh',
    'scripts/harness-approval-gate.sh',
    'scripts/harness-source-edit-guard.sh',
    'scripts/harness-lifecycle-hook.sh',
    'scripts/harness-subagent-guard.sh',
  ]) {
    const st = fs.statSync(path.join(targetDir, exeRel));
    assert.ok((st.mode & 0o111) !== 0, `${exeRel} must be executable`);
  }
  assert.match(
    fs.readFileSync(path.join(targetDir, '.agents', 'rules', 'agy-harness.md'), 'utf8'),
    /^---\r?\ntrigger:\s*always_on\r?\n---/,
    '.agents/rules/agy-harness.md must declare trigger: always_on frontmatter for CLI auto-injection',
  );

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

  // Verify upgrade semantics: outdated rules and approval gate are ALWAYS updated without --force,
  // while custom SPEC.md, custom gate-check.sh, and custom sibling hooks in .agents/hooks.json are preserved
  const specPath = path.join(targetDir, '.artifacts', 'SPEC.md');
  fs.writeFileSync(specPath, '# Custom Spec Locked\n');
  const ruleDstPath = path.join(targetDir, '.agents', 'rules', 'agy-harness.md');
  fs.writeFileSync(ruleDstPath, '# Outdated Rule v0.1.0\n');
  const gateDstPath = path.join(targetDir, 'scripts', 'gate-check.sh');
  fs.writeFileSync(gateDstPath, '#!/usr/bin/env bash\necho custom-gate\n');
  const approvalGateDstPath = path.join(targetDir, 'scripts', 'harness-approval-gate.sh');
  fs.writeFileSync(approvalGateDstPath, '#!/bin/bash\n# outdated gate\n');
  const sourceGuardDstPath = path.join(targetDir, 'scripts', 'harness-source-edit-guard.sh');
  fs.writeFileSync(sourceGuardDstPath, '#!/bin/bash\n# outdated guard\n');
  const lifecycleHookDstPath = path.join(targetDir, 'scripts', 'harness-lifecycle-hook.sh');
  fs.writeFileSync(lifecycleHookDstPath, '#!/bin/bash\n# outdated lifecycle\n');
  const subagentGuardDstPath = path.join(targetDir, 'scripts', 'harness-subagent-guard.sh');
  fs.writeFileSync(subagentGuardDstPath, '#!/bin/bash\n# outdated subagent guard\n');
  const builderHookDstPath = path.join(targetDir, 'scripts', 'hooks', 'slice-builder.hooks.json');
  fs.writeFileSync(builderHookDstPath, '{}\n');
  const gatekeeperHookDstPath = path.join(targetDir, 'scripts', 'hooks', 'staff-gatekeeper.hooks.json');
  fs.writeFileSync(gatekeeperHookDstPath, '{}\n');

  // Seed legacy local agents directory to verify automatic upgrade & retired persona cleanup without --force
  const localAgentsDir = path.join(targetDir, '.agents', 'agents');
  fs.mkdirSync(localAgentsDir, { recursive: true });
  fs.writeFileSync(path.join(localAgentsDir, 'slice-builder.md'), '# outdated local builder\n');
  fs.writeFileSync(path.join(localAgentsDir, 'staff-gatekeeper.md'), '# outdated local gatekeeper\n');
  fs.writeFileSync(path.join(localAgentsDir, 'repo-scout.md'), '# retired scout\n');
  fs.writeFileSync(path.join(localAgentsDir, 'risk-specialist.md'), '# retired risk specialist\n');

  const hooksPath = path.join(targetDir, '.agents', 'hooks.json');
  const existingHooks = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
  existingHooks['custom-user-hook'] = { PostToolUse: [{ matcher: 'run_command', hooks: [{ command: 'echo ok' }] }] };
  delete existingHooks['harness-contract-approval-gate'];
  delete existingHooks['harness-parent-source-edit-guard'];
  delete existingHooks['harness-lifecycle-guard'];
  fs.writeFileSync(hooksPath, JSON.stringify(existingHooks, null, 2) + '\n');

  execFileSync('bash', [initScript, targetDir], { encoding: 'utf8' });
  assert.equal(fs.readFileSync(specPath, 'utf8'), '# Custom Spec Locked\n');
  assert.equal(fs.readFileSync(gateDstPath, 'utf8'), '#!/usr/bin/env bash\necho custom-gate\n');
  assert.equal(
    fs.readFileSync(ruleDstPath, 'utf8'),
    fs.readFileSync(path.join(ROOT, 'skills', 'harness-init', 'references', 'harness-rule-template.md'), 'utf8'),
    'init-harness.sh must replace outdated .agents/rules/agy-harness.md without --force',
  );
  assert.equal(
    fs.readFileSync(approvalGateDstPath, 'utf8'),
    fs.readFileSync(path.join(ROOT, 'scripts', 'harness-approval-gate.sh'), 'utf8'),
    'init-harness.sh must replace outdated scripts/harness-approval-gate.sh without --force',
  );
  assert.equal(
    fs.readFileSync(sourceGuardDstPath, 'utf8'),
    fs.readFileSync(path.join(ROOT, 'scripts', 'harness-source-edit-guard.sh'), 'utf8'),
    'init-harness.sh must replace outdated scripts/harness-source-edit-guard.sh without --force',
  );
  assert.equal(
    fs.readFileSync(lifecycleHookDstPath, 'utf8'),
    fs.readFileSync(path.join(ROOT, 'scripts', 'harness-lifecycle-hook.sh'), 'utf8'),
    'init-harness.sh must replace outdated scripts/harness-lifecycle-hook.sh without --force',
  );
  assert.equal(
    fs.readFileSync(subagentGuardDstPath, 'utf8'),
    fs.readFileSync(path.join(ROOT, 'scripts', 'harness-subagent-guard.sh'), 'utf8'),
    'init-harness.sh must replace outdated scripts/harness-subagent-guard.sh without --force',
  );
  assert.equal(
    fs.readFileSync(builderHookDstPath, 'utf8'),
    fs.readFileSync(path.join(ROOT, 'scripts', 'hooks', 'slice-builder.hooks.json'), 'utf8'),
    'init-harness.sh must replace outdated scripts/hooks/slice-builder.hooks.json without --force',
  );
  assert.equal(
    fs.readFileSync(gatekeeperHookDstPath, 'utf8'),
    fs.readFileSync(path.join(ROOT, 'scripts', 'hooks', 'staff-gatekeeper.hooks.json'), 'utf8'),
    'init-harness.sh must replace outdated scripts/hooks/staff-gatekeeper.hooks.json without --force',
  );
  const rewriteHookPaths = (txt) => txt.replace(/(^|[\s'"-])\.\.\/scripts\/hooks\//gm, '$1../../scripts/hooks/');
  const localBuilderTxt = fs.readFileSync(path.join(localAgentsDir, 'slice-builder.md'), 'utf8');
  const localGatekeeperTxt = fs.readFileSync(path.join(localAgentsDir, 'staff-gatekeeper.md'), 'utf8');
  assert.equal(
    localBuilderTxt,
    rewriteHookPaths(fs.readFileSync(path.join(ROOT, 'agents', 'slice-builder.md'), 'utf8')),
    'init-harness.sh must refresh existing .agents/agents/slice-builder.md with ../../scripts/hooks/ path',
  );
  assert.equal(
    localGatekeeperTxt,
    rewriteHookPaths(fs.readFileSync(path.join(ROOT, 'agents', 'staff-gatekeeper.md'), 'utf8')),
    'init-harness.sh must refresh existing .agents/agents/staff-gatekeeper.md with ../../scripts/hooks/ path',
  );
  assert.match(localBuilderTxt, /\.\.\/\.\.\/scripts\/hooks\/slice-builder\.hooks\.json/);
  assert.match(localGatekeeperTxt, /\.\.\/\.\.\/scripts\/hooks\/staff-gatekeeper\.hooks\.json/);
  assert.doesNotMatch(localBuilderTxt, /(?:^|[\s'":\-])\.\.\/scripts\/hooks\//m);
  assert.doesNotMatch(localGatekeeperTxt, /(?:^|[\s'":\-])\.\.\/scripts\/hooks\//m);
  assert.ok(!fs.existsSync(path.join(localAgentsDir, 'repo-scout.md')), 'retired repo-scout.md must be removed from .agents/agents/');
  assert.ok(!fs.existsSync(path.join(localAgentsDir, 'risk-specialist.md')), 'retired risk-specialist.md must be removed from .agents/agents/');
  const mergedHooks = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
  const tplHooks = JSON.parse(fs.readFileSync(path.join(ROOT, 'skills', 'harness-init', 'references', 'hooks-template.json'), 'utf8'));
  assert.ok(mergedHooks['custom-user-hook'], 'Existing custom-user-hook must be preserved in .agents/hooks.json');
  for (const group of [
    'harness-contract-approval-gate',
    'harness-parent-source-edit-guard',
    'harness-lifecycle-guard',
  ]) {
    assert.deepEqual(mergedHooks[group], tplHooks[group], `${group} must be merged into existing .agents/hooks.json`);
  }

  // Verify --with-local-agents copies the 3 core subagents and --force refreshes templates
  execFileSync('bash', [initScript, targetDir, '--with-local-agents', '--force'], { encoding: 'utf8' });
  assert.notEqual(fs.readFileSync(specPath, 'utf8'), '# Custom Spec Locked\n');
  for (const name of Object.keys(EXPECTED_SUBAGENTS)) {
    const localAgentFile = path.join(targetDir, '.agents', 'agents', `${name}.md`);
    assert.ok(fs.existsSync(localAgentFile), `Expected local agent .agents/agents/${name}.md`);
    const content = fs.readFileSync(localAgentFile, 'utf8');
    assert.doesNotMatch(content, /(?:^|[\s'":\-])\.\.\/scripts\/hooks\//m);
    for (const hookRel of parseAgentYaml(content).hooks) {
      assert.ok(
        fs.existsSync(path.resolve(localAgentsDir, hookRel)),
        `Local agent ${name}.md hook path ${hookRel} must resolve relative to .agents/agents/`,
      );
    }
  }

  // Verify idempotent SKIP (up-to-date) semantics on re-run with --with-local-agents
  const rerun = spawnSync('bash', [initScript, targetDir, '--with-local-agents'], { encoding: 'utf8' });
  assert.equal(rerun.status, 0, `Re-run failed: ${rerun.stderr}`);
  for (const expectedSkip of [
    '.agents/rules/agy-harness.md',
    'scripts/harness-approval-gate.sh',
    'scripts/harness-source-edit-guard.sh',
    'scripts/harness-lifecycle-hook.sh',
    'scripts/harness-subagent-guard.sh',
    'scripts/hooks/slice-builder.hooks.json',
    'scripts/hooks/staff-gatekeeper.hooks.json',
    '.agents/hooks.json',
    '.agents/agents/arch-redteam.md',
    '.agents/agents/slice-builder.md',
    '.agents/agents/staff-gatekeeper.md',
  ]) {
    assert.ok(
      rerun.stderr.includes(`SKIP (up-to-date): ${path.join(targetDir, expectedSkip)}`),
      `Expected SKIP (up-to-date) for ${expectedSkip} in stderr:\n${rerun.stderr}`,
    );
  }
  assert.doesNotMatch(rerun.stderr, /\b(?:WROTE|UPDATED|MERGED):/);

  // Verify Python3 fallback in init-harness.sh (no node on PATH) merges hooks and rewrites agent hook paths
  const pyBin = findExecutable('python3');
  if (pyBin) {
    const noNodeBin = makeTempDir('agy-harness-init-nonode-');
    const pyWs = makeTempDir('agy-harness-init-pyws-');
    t.after(() => {
      fs.rmSync(noNodeBin, { recursive: true, force: true });
      fs.rmSync(pyWs, { recursive: true, force: true });
    });
    for (const cmd of [
      'bash', 'sh', 'mkdir', 'cp', 'chmod', 'cmp', 'rm', 'grep', 'tail', 'wc', 'tr', 'basename', 'dirname', 'mktemp', 'cat', 'python3',
    ]) {
      const resolved = findExecutable(cmd);
      if (resolved) fs.symlinkSync(resolved, path.join(noNodeBin, cmd));
    }
    fs.mkdirSync(path.join(pyWs, '.agents'), { recursive: true });
    fs.writeFileSync(
      path.join(pyWs, '.agents', 'hooks.json'),
      JSON.stringify({ 'custom-py-hook': { Stop: [{ command: 'echo ok' }] } }, null, 2) + '\n',
    );
    const pyRes = spawnSync('bash', [initScript, pyWs, '--with-local-agents'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: noNodeBin },
    });
    assert.equal(pyRes.status, 0, `Python3 fallback init-harness failed: ${pyRes.stderr}`);
    const pyMergedHooks = JSON.parse(fs.readFileSync(path.join(pyWs, '.agents', 'hooks.json'), 'utf8'));
    assert.ok(pyMergedHooks['custom-py-hook'], 'Python3 fallback must preserve custom user hooks');
    assert.deepEqual(pyMergedHooks['harness-lifecycle-guard'], tplHooks['harness-lifecycle-guard']);
    const pyBuilder = fs.readFileSync(path.join(pyWs, '.agents', 'agents', 'slice-builder.md'), 'utf8');
    assert.match(pyBuilder, /\.\.\/\.\.\/scripts\/hooks\/slice-builder\.hooks\.json/);
    assert.doesNotMatch(pyBuilder, /(?:^|[\s'":\-])\.\.\/scripts\/hooks\//m);
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

  // 1. Read-only subagents (arch-redteam, staff-gatekeeper) are ALWAYS allowed
  assert.equal(runHook('invoke_subagent', { TypeName: 'staff-gatekeeper' }).decision, 'allow');
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

  // 6. Post-Proceed arch-redteam + non-contract Guardrails / Implementation Notes / checkbox / Chinese status updates
  //    do NOT re-lock slice-builder execution!
  const preRedteamStateDir = makeTempDir('agy-harness-redteam-state-');
  t.after(() => fs.rmSync(preRedteamStateDir, { recursive: true, force: true }));

  // Simulate post-Proceed turn where arch-redteam runs BEFORE slice-builder, then guardrails are appended to PLAN.md
  setMtime(specPath, '2026-11-11T10:02:30.000Z');
  setMtime(planPath, '2026-11-11T10:02:30.000Z');
  const redteamProceedTranscript = path.join(wsDir, 'transcript-redteam.jsonl');
  fs.writeFileSync(
    redteamProceedTranscript,
    JSON.stringify({
      step_index: 3,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      created_at: '2026-11-11T10:03:00.000Z',
      content: 'Comments on artifact URI: file:///tmp/harness_plan.md\n\nThe user has approved this document.\n',
    }) + '\n',
  );
  const runRedteamTurnHook = (toolName, args) => {
    const payload = JSON.stringify({
      conversationId: 'conv-approval-test-redteam',
      workspacePaths: [wsDir],
      transcriptPath: redteamProceedTranscript,
      stepIdx: 12,
      toolCall: { name: toolName, args },
    });
    const out = execFileSync('bash', [approvalGate], {
      cwd: path.join(wsDir, '.agents'),
      input: payload,
      encoding: 'utf8',
      env: { ...process.env, AGY_HARNESS_STATE_DIR: preRedteamStateDir },
    });
    return JSON.parse(out.trim());
  };
  assert.equal(runRedteamTurnHook('invoke_subagent', { TypeName: 'arch-redteam' }).decision, 'allow');

  const planWithGuardrails =
    lockedPlanV1.replace('`[ ] Pending`', '`[x] Completed`') +
    '\n<!-- non-contract -->\nAdded test edge case note\n<!-- /non-contract -->\n' +
    '\n## Implementation Notes / Guardrails\n- [RISK-NOTE] Verify expired WebAuthn challenge returns 401.\n';
  const specAc1Checked = lockedSpecV1.replace('- [ ] AC-1:', '- [x] AC-1:');
  fs.writeFileSync(planPath, planWithGuardrails);
  fs.writeFileSync(specPath, specAc1Checked);
  setMtime(planPath, '2026-11-11T10:04:00.000Z');
  setMtime(specPath, '2026-11-11T10:04:00.000Z');
  fs.appendFileSync(
    redteamProceedTranscript,
    JSON.stringify({
      step_index: 4,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-11T10:04:01.000Z',
      tool_calls: [{ name: 'edit_file', args: { Path: planPath } }],
    }) + '\n',
  );
  assert.equal(runRedteamTurnHook('invoke_subagent', { TypeName: 'slice-builder' }).decision, 'allow');

  // Also verify existing conv-approval-test-1 allows checkbox/guardrail/Chinese status updates
  fs.writeFileSync(planPath, planWithGuardrails.replace('**Status:**', '**状态:**'));
  setMtime(planPath, '2026-11-11T10:04:30.000Z');
  assert.equal(runHook('invoke_subagent', { TypeName: 'slice-builder' }).decision, 'allow');

  // 7. Substantive mid-flight modification to PLAN.md or SPEC.md IMMEDIATELY re-locks until user confirms again!
  const modifiedPlanV2 = planWithGuardrails + '\n## Slice 3: Add Redis session store\n- **Status:** `[ ] Pending`\n';
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

  // 9. Coordinator rule template and active workspace rule stay synced and declare alignment-first Proceed + elastic slice-builder
  const tplRule = fs.readFileSync(
    path.join(ROOT, 'skills', 'harness-init', 'references', 'harness-rule-template.md'),
    'utf8',
  );
  const activeRule = fs.readFileSync(path.join(ROOT, '.agents', 'rules', 'agy-harness.md'), 'utf8');
  assert.equal(activeRule, tplRule, '.agents/rules/agy-harness.md must match harness-rule-template.md');
  assert.match(tplRule, /^---\r?\ntrigger:\s*always_on\r?\n---/);
  assert.match(tplRule, /RequestFeedback:\s*true/);
  assert.match(tplRule, /harness_plan\.md/);
  assert.match(tplRule, /<= 3` 个文件/);
  assert.match(tplRule, /Implementation Notes \/ Guardrails/);
  assert.match(tplRule, /确认需求与(核心)?方案完全符合/);
  assert.match(tplRule, /弹性 `slice-builder`/);
  assert.match(tplRule, /send_message\(Recipient:/);
  assert.match(tplRule, /manage_subagents\(Action="kill"/);
  assert.match(tplRule, /manage_subagents\(Action="list"\)/);
  assert.doesNotMatch(tplRule, /严禁调用 CRG/);
  assert.match(tplRule, /\.agents\/rules\/crg\.md/);
  assert.match(tplRule, /harness-source-edit-guard\.sh/);
  assert.match(tplRule, /4 合 1 `staff-gatekeeper`/);
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

  // AC-2: 4-in-1 staff-gatekeeper read-only short-command restriction and [HOST_CMD_REQUEST] fallback
  for (const reviewer of ['staff-gatekeeper.md']) {
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

test('gate-check.sh --fast skips full npm test while running test:fast and Gate 4 secret scans', (t) => {
  const repoDir = makeTempDir('agy-harness-fast-gate-');
  t.after(() => fs.rmSync(repoDir, { recursive: true, force: true }));

  const gateScript = path.join(ROOT, 'scripts', 'gate-check.sh');

  execFileSync('git', ['init', '-q'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir });

  fs.writeFileSync(
    path.join(repoDir, 'package.json'),
    JSON.stringify(
      {
        name: 'fast-gate-probe',
        version: '1.0.0',
        scripts: {
          'test:fast': 'node -e "console.log(\'FAST_TEST_RAN\')"',
          test: 'node -e "console.error(\'FULL_TEST_SHOULD_NOT_RUN\'); process.exit(1)"',
        },
      },
      null,
      2,
    ) + '\n',
  );
  execFileSync('git', ['add', '.'], { cwd: repoDir });
  execFileSync('git', ['commit', '-q', '-m', 'init fast gate'], { cwd: repoDir });

  const fastOut = execFileSync('bash', [gateScript, '--fast'], { cwd: repoDir, encoding: 'utf8' });
  assert.match(fastOut, /FAST_TEST_RAN/);
  assert.match(fastOut, /ALL SOFTWARE 1\.0 GATES PASSED\./);

  const dbgStmt = 'deb' + 'ugger;';
  fs.writeFileSync(path.join(repoDir, 'index.js'), `const a = 1;\n${dbgStmt}\n`);
  execFileSync('git', ['add', 'index.js'], { cwd: repoDir });
  assert.throws(
    () => execFileSync('bash', [gateScript, '--fast'], { cwd: repoDir, encoding: 'utf8', stdio: 'pipe' }),
    /Potential secret or debugger statement detected/,
  );
});

test('harness-source-edit-guard.sh enforces parent delegation outside unactivated Tier S while allowing subagents and .artifacts/.agents', (t) => {
  const baseDir = makeTempDir('agy-harness-source-guard-');
  const wsDir = path.join(baseDir, 'real-repo');
  const wsLink = path.join(baseDir, 'link-repo');
  t.after(() => fs.rmSync(baseDir, { recursive: true, force: true }));

  fs.mkdirSync(wsDir, { recursive: true });
  fs.symlinkSync(wsDir, wsLink);

  execFileSync('git', ['init', '-q'], { cwd: wsDir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: wsDir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: wsDir });
  fs.mkdirSync(path.join(wsDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(wsDir, 'src', 'a.js'), 'export const a = 1;\n');
  execFileSync('git', ['add', '.'], { cwd: wsDir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: wsDir });

  const initScript = path.join(ROOT, 'scripts', 'init-harness.sh');
  execFileSync('bash', [initScript, wsDir], { encoding: 'utf8' });

  const guardScript = path.join(wsDir, 'scripts', 'harness-source-edit-guard.sh');
  const parentTranscript = path.join(baseDir, 'parent-transcript.jsonl');
  const subagentTranscript = path.join(baseDir, 'subagent-transcript.jsonl');
  fs.writeFileSync(parentTranscript, JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT' }) + '\n');
  fs.writeFileSync(subagentTranscript, JSON.stringify({ step_index: 0, source: 'SYSTEM', type: 'SYSTEM_MESSAGE' }) + '\n');

  const runGuard = (toolName, args, opts = {}) => {
    const payload = JSON.stringify({
      workspacePaths: [opts.workspacePath || wsLink],
      transcriptPath: opts.transcriptPath || parentTranscript,
      toolCall: { name: toolName, args },
    });
    const out = execFileSync('bash', [guardScript], {
      cwd: path.join(wsDir, '.agents'),
      input: payload,
      encoding: 'utf8',
    });
    return JSON.parse(out.trim());
  };

  // 1. Non-edit tools and paths outside repoRoot are allowed
  assert.equal(runGuard('read_file', { Path: path.join(wsDir, 'src', 'a.js') }).decision, 'allow');
  assert.equal(runGuard('write_file', { Path: path.join(baseDir, 'outside.md'), Content: 'ok\n' }).decision, 'allow');

  // 2. INACTIVE (unfilled templates) allows direct edits including >150 lines, 5+ manifests, dirty repos, and run_command
  assert.equal(runGuard('edit_file', { Path: 'src/a.js', Target: '1', Replacement: '2' }).decision, 'allow');

  const bigContent = Array.from({ length: 160 }, (_, i) => `const x${i} = ${i};`).join('\n') + '\n';
  assert.equal(runGuard('write_file', { Path: 'src/big.js', Content: bigContent }).decision, 'allow');

  for (let idx = 1; idx <= 10; idx++) {
    fs.writeFileSync(path.join(wsDir, 'src', `f${idx}.js`), `export const f${idx} = ${idx};\n`);
  }
  assert.equal(runGuard('write_file', { Path: 'src/f11.js', Content: 'export const f11 = 11;\n' }).decision, 'allow');
  for (const manifest of ['README.md', 'docs/a.md', 'plugin.json', '.claude-plugin/marketplace.json', 'pnpm-lock.yaml']) {
    assert.equal(runGuard('sed_file', { File: manifest }).decision, 'allow');
  }
  assert.equal(runGuard('run_command', { CommandLine: 'echo 12 > src/f12.js' }).decision, 'allow');

  // Clean extra untracked files and activate a real SPEC/PLAN contract
  for (let idx = 1; idx <= 10; idx++) {
    fs.rmSync(path.join(wsDir, 'src', `f${idx}.js`));
  }
  fs.writeFileSync(
    path.join(wsDir, '.artifacts', 'SPEC.md'),
    '# SPEC\n\n## 1. Objective\n- Real goal\n\n## 4. Acceptance Criteria\n- [ ] AC-1\n',
  );
  fs.writeFileSync(
    path.join(wsDir, '.artifacts', 'PLAN.md'),
    '# PLAN\n\n## Slice 1: Core API\n- **Status:** `[ ] Pending`\n',
  );

  // 3. Active contract allows .artifacts/ and .agents/ edits by parent, and allows subagents on source files
  assert.equal(runGuard('edit_file', { Path: '.artifacts/PLAN.md', Target: 'Pending', Replacement: 'Done' }).decision, 'allow');
  assert.equal(runGuard('edit_file', { Path: '.agents/rules/agy-harness.md', Target: 'Tier S', Replacement: 'Tier S' }).decision, 'allow');
  assert.equal(
    runGuard('write_to_file', { TargetFile: 'src/nested/new-file.js', Content: 'export const n = 1;\n' }, { transcriptPath: subagentTranscript }).decision,
    'allow',
  );

  // 4. Active contract blocks parent source/scripts edits including non-existent subdirectories via symlinked workspace root
  const blockedSrc = runGuard('write_file', { Path: 'src/nested/new-file.js', Content: 'export const n = 1;\n' });
  assert.equal(blockedSrc.decision, 'deny');
  assert.match(blockedSrc.reason, /Active contract found/);

  const blockedScripts = runGuard('edit_file', { Path: 'scripts/gate-check.sh', Target: 'Gate', Replacement: 'Gate' });
  assert.equal(blockedScripts.decision, 'deny');
  assert.match(blockedScripts.reason, /scripts\/gate-check\.sh/);
});

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

test('Slice 1 P0+P2 gate hardening suite', async (t) => {
  await Promise.all([
    t.test('harness-approval-gate.sh enforces allowlist, new gated tools, strict user approval, exit_plan_mode routing, archive locking, and --plugin-mode', async (t) => {
  const baseDir = makeTempDir('agy-harness-approval-p0-');
  const stateDir = makeTempDir('agy-harness-approval-p0-state-');
  t.after(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  const gateScript = path.join(ROOT, 'scripts', 'harness-approval-gate.sh');
  const uninitWs = path.join(baseDir, 'uninit-ws');
  const ruleOnlyWs = path.join(baseDir, 'rule-only-ws');
  const activeWs = path.join(baseDir, 'active-ws');
  const archivedWs = path.join(baseDir, 'archived-ws');
  const autoArchivedWs = path.join(baseDir, 'auto-archived-ws');

  for (const dir of [uninitWs, ruleOnlyWs, activeWs, archivedWs, autoArchivedWs]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.mkdirSync(path.join(ruleOnlyWs, '.agents', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(ruleOnlyWs, '.agents', 'rules', 'agy-harness.md'), '# rule\n');

  const backtickSafeSpec = [
    '# SPEC',
    '- **Goal:** Harden approval gate',
    'Note: ignore `_Describe the concrete user or system problem being solved._` and `<!-- HARNESS_TEMPLATE_UNFILLED` and `<!-- HARNESS_STATUS: ARCHIVED -->` in prose.',
    '- [ ] AC-1: Gate works',
  ].join('\n');
  const backtickSafePlan = [
    '# PLAN',
    'Note: ignore `## Slice 1: [Title]` in prose.',
    '## Slice 1: Core',
    '- **Status:** `[ ] Pending`',
  ].join('\n');

  for (const dir of [activeWs, archivedWs, autoArchivedWs]) {
    fs.mkdirSync(path.join(dir, '.artifacts'), { recursive: true });
  }
  fs.writeFileSync(path.join(activeWs, '.artifacts', 'SPEC.md'), backtickSafeSpec);
  fs.writeFileSync(path.join(activeWs, '.artifacts', 'PLAN.md'), backtickSafePlan);

  fs.writeFileSync(path.join(archivedWs, '.artifacts', 'SPEC.md'), backtickSafeSpec + '\n<!-- HARNESS_STATUS: ARCHIVED -->\n');
  fs.writeFileSync(path.join(archivedWs, '.artifacts', 'PLAN.md'), backtickSafePlan);

  fs.writeFileSync(path.join(autoArchivedWs, '.artifacts', 'SPEC.md'), backtickSafeSpec.replace('- [ ] AC-1:', '- [x] AC-1:'));
  fs.writeFileSync(path.join(autoArchivedWs, '.artifacts', 'PLAN.md'), backtickSafePlan.replace('`[ ] Pending`', '`[x] Completed`'));

  const makeTranscript = (name, lines) => {
    const p = path.join(baseDir, name);
    fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    return p;
  };

  const tUnapprovedPrompt = makeTranscript('t-prompt.jsonl', [
    { step_index: 1, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2026-11-20T10:00:00.000Z', content: 'Build login' },
  ]);
  const tQuestion = makeTranscript('t-question.jsonl', [
    { step_index: 1, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2099-01-01T00:00:00.000Z', content: '为什么用 Redis？' },
  ]);
  const tHesitate = makeTranscript('t-hesitate.jsonl', [
    { step_index: 1, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2099-01-01T00:00:00.000Z', content: 'I approve in principle, but revise Slice 2 first' },
  ]);
  const tZhNegate = makeTranscript('t-zh-negate.jsonl', [
    { step_index: 1, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2099-01-01T00:00:00.000Z', content: '暂不确认，先等等' },
  ]);
  const tMetaApprove = makeTranscript('t-meta-approve.jsonl', [
    {
      step_index: 1,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      created_at: '2099-01-01T00:00:00.000Z',
      content: '<ADDITIONAL_METADATA>please approve proceed</ADDITIONAL_METADATA>\nWhat does Slice 1 do?',
    },
  ]);
  const tMetaQuestionOk = makeTranscript('t-meta-q-ok.jsonl', [
    {
      step_index: 1,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      created_at: '2099-01-01T00:00:00.000Z',
      content: '<ADDITIONAL_METADATA>status?</ADDITIONAL_METADATA><USER_SETTINGS_CHANGE>theme=dark?</USER_SETTINGS_CHANGE>\n<USER_REQUEST>LGTM, proceed</USER_REQUEST>',
    },
  ]);
  const tArtifactComment = makeTranscript('t-comment.jsonl', [
    {
      step_index: 1,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      created_at: '2099-01-01T00:00:00.000Z',
      content: 'Comments on artifact URI: file:///tmp/harness_plan.md\n\nFix AC-1.',
    },
  ]);

  const call = (ws, toolName, toolArgs, opts = {}) =>
    spawnHookAsync(
      gateScript,
      {
        conversationId: opts.conversationId || 'conv-p0-' + Math.random().toString(36).slice(2),
        workspacePaths: [ws],
        transcriptPath: opts.transcriptPath || '',
        lastUserInput: opts.lastUserInput,
        toolCall: { name: toolName, args: toolArgs },
      },
      { cwd: ws, env: { AGY_HARNESS_STATE_DIR: stateDir }, args: opts.pluginMode ? ['--plugin-mode'] : [] },
    );

  // Batch independent checks concurrently for speed
  const results = await Promise.all([
    // --plugin-mode zero-intrusion on uninit workspace
    call(uninitWs, 'invoke_subagent', { TypeName: 'slice-builder' }, { pluginMode: true }),
    call(uninitWs, 'run_workflow', { name: 'deploy' }, { pluginMode: true }),
    call(uninitWs, 'exit_plan_mode', { plan: 'Tier M plan with slice-builder' }, { pluginMode: true }),
    // --plugin-mode active when .agents/rules/agy-harness.md exists
    call(ruleOnlyWs, 'invoke_subagent', { TypeName: 'slice-builder' }, { pluginMode: true }),

    // Read-only allowlist & new gated tools
    call(uninitWs, 'invoke_subagent', { TypeName: 'research' }),
    call(activeWs, 'invoke_subagent', { TypeName: 'custom-writer' }, { transcriptPath: tUnapprovedPrompt }),
    call(activeWs, 'define_subagent', { Name: 'reader', EnableWriteTools: false }, { transcriptPath: tUnapprovedPrompt }),
    call(activeWs, 'define_subagent', { Name: 'writer', EnableWriteTools: true }, { transcriptPath: tUnapprovedPrompt }),
    call(activeWs, 'run_workflow', { WorkflowName: 'build' }, { transcriptPath: tUnapprovedPrompt }),

    // Archived / auto-archived deny gated execution tools
    call(archivedWs, 'invoke_subagent', { TypeName: 'slice-builder' }, { transcriptPath: tMetaQuestionOk }),
    call(autoArchivedWs, 'invoke_subagent', { TypeName: 'slice-builder' }, { transcriptPath: tMetaQuestionOk }),

    // Strict user approval detection (backtick-safe active contract)
    call(activeWs, 'invoke_subagent', { TypeName: 'slice-builder' }, { transcriptPath: tQuestion }),
    call(activeWs, 'invoke_subagent', { TypeName: 'slice-builder' }, { transcriptPath: tHesitate }),
    call(activeWs, 'invoke_subagent', { TypeName: 'slice-builder' }, { transcriptPath: tZhNegate }),
    call(activeWs, 'invoke_subagent', { TypeName: 'slice-builder' }, { transcriptPath: tMetaApprove }),
    call(activeWs, 'invoke_subagent', { TypeName: 'slice-builder' }, { transcriptPath: tArtifactComment }),
    call(activeWs, 'invoke_subagent', { TypeName: 'slice-builder' }, { transcriptPath: tMetaQuestionOk }),
    call(activeWs, 'define_subagent', { Name: 'writer', EnableWriteTools: true }, { transcriptPath: tMetaQuestionOk }),
    call(activeWs, 'run_workflow', { WorkflowName: 'build' }, { transcriptPath: tMetaQuestionOk }),
    call(activeWs, 'invoke_subagent', { TypeName: 'custom-writer' }, { transcriptPath: tMetaQuestionOk }),
    call(activeWs, 'invoke_subagent', { TypeName: 'slice-builder' }, { lastUserInput: 'why?' }),
    call(activeWs, 'invoke_subagent', { TypeName: 'slice-builder' }, { lastUserInput: 'approved' }),

    // exit_plan_mode routing (never deny)
    call(activeWs, 'exit_plan_mode', { plan: 'Step 1' }, { transcriptPath: tArtifactComment }),
    call(activeWs, 'exit_plan_mode', { plan: 'Invoke slice-builder now' }, { transcriptPath: tQuestion }),
    call(activeWs, 'exit_plan_mode', { plan: 'Draft .artifacts/SPEC.md and wait for Proceed' }, { transcriptPath: tQuestion }),
    call(activeWs, 'exit_plan_mode', { plan: 'Invoke slice-builder now' }, { transcriptPath: tMetaQuestionOk }),
    call(autoArchivedWs, 'exit_plan_mode', { plan: 'Edit src/a.js and src/a.test.js' }),
    call(autoArchivedWs, 'exit_plan_mode', { plan: 'Edit src/a.js, src/b.js, src/c.js, and src/d.js' }),
    call(autoArchivedWs, 'exit_plan_mode', { plan: 'Update docs/a.md, docs/b.md, .github/CODEOWNERS, .claude-plugin/marketplace.json, and assets/logo.svg' }),
    call(autoArchivedWs, 'exit_plan_mode', { plan: 'Modify agents/a.md, skills/x/SKILL.md, commands/c.md, evals/cases/a.json, and scripts/hooks/a.hooks.json' }),
    call(autoArchivedWs, 'exit_plan_mode', { plan: 'Edit src/a.js, src/b.js, src/c.js, src/d.js, and src/e.js' }),
    call(autoArchivedWs, 'exit_plan_mode', { plan: 'Tier M refactor across auth module' }),
    call(autoArchivedWs, 'exit_plan_mode', { plan: 'Tier M execution using slice-builder' }),
    call(autoArchivedWs, 'exit_plan_mode', {
      plan: 'Tier M Phase 1: draft .artifacts/SPEC.md & .artifacts/PLAN.md, sync harness_plan.md (RequestFeedback=true), stop turn and wait for Proceed before editing src/a.js, src/b.js, src/c.js, src/d.js, and src/e.js.',
    }),
  ]);

  const expected = [
    'allow', 'allow', 'allow', 'deny',
    'allow', 'deny', 'allow', 'deny', 'deny',
    'deny', 'deny',
    'force_ask', 'force_ask', 'force_ask', 'force_ask', 'deny', 'allow', 'allow', 'allow', 'allow', 'force_ask', 'allow',
    'force_ask', 'force_ask', 'allow', 'allow', 'allow', 'allow', 'allow', 'force_ask', 'force_ask', 'force_ask', 'force_ask', 'allow',
  ];
  assert.equal(results.length, expected.length);
  results.forEach((res, idx) => {
    assert.equal(res.decision, expected[idx], `Case #${idx} mismatch: got ${JSON.stringify(res)}, expected ${expected[idx]}`);
  });

  // Verify sed_file modifying .artifacts/PLAN.md after last user turn triggers re-lock
  const tSedPlanAfter = makeTranscript('t-sed-plan.jsonl', [
    { step_index: 1, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2099-01-01T00:00:00.000Z', content: 'The user has approved this document.' },
    { step_index: 2, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2099-01-01T00:00:01.000Z', tool_calls: [{ name: 'sed_file', args: { File: '.artifacts/PLAN.md' } }] },
  ]);
  const sedModifiedRes = await call(activeWs, 'invoke_subagent', { TypeName: 'slice-builder' }, { transcriptPath: tSedPlanAfter });
  assert.equal(sedModifiedRes.decision, 'deny');

  // Verify question does NOT poison state cache
  const qConv = 'conv-no-cache-question';
  const q1 = await call(activeWs, 'invoke_subagent', { TypeName: 'slice-builder' }, { transcriptPath: tQuestion, conversationId: qConv });
  const q2 = await call(activeWs, 'invoke_subagent', { TypeName: 'slice-builder' }, { transcriptPath: tQuestion, conversationId: qConv });
  assert.equal(q1.decision, 'force_ask');
  assert.equal(q2.decision, 'force_ask');
    }),

    t.test('harness-source-edit-guard.sh enforces 2-rule isParent, expanded edit tools, run_command write guard, archive unlock, and --plugin-mode', async (t) => {
  const baseDir = makeTempDir('agy-harness-guard-p0-');
  t.after(() => fs.rmSync(baseDir, { recursive: true, force: true }));

  const guardScript = path.join(ROOT, 'scripts', 'harness-source-edit-guard.sh');
  const uninitWs = path.join(baseDir, 'uninit-ws');
  const activeWs = path.join(baseDir, 'active-ws');
  const archivedWs = path.join(baseDir, 'archived-ws');
  const doneWs = path.join(baseDir, 'done-ws');
  const autoArchivedWs = path.join(baseDir, 'auto-archived-ws');
  const inProgressWs = path.join(baseDir, 'in-progress-ws');
  const tierSWs = path.join(baseDir, 'tier-s-ws');

  for (const dir of [uninitWs, activeWs, archivedWs, doneWs, autoArchivedWs, inProgressWs, tierSWs]) {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'export const a = 1;\n');
  }

  const activeSpec = [
    '# SPEC',
    '- **Goal:** Guard test',
    'Prose: `_Describe the concrete user or system problem being solved._` `<!-- HARNESS_STATUS: DONE -->`',
    '- [x] AC-1: First',
    '- [ ] AC-2: Second',
  ].join('\n');
  const activePlan = [
    '# PLAN',
    'Prose: `## Slice 1: [Title]`',
    '## Slice 1: Core',
    '- **Status:** `[ ] Pending`',
  ].join('\n');

  for (const dir of [activeWs, archivedWs, doneWs, autoArchivedWs, inProgressWs]) {
    fs.mkdirSync(path.join(dir, '.artifacts'), { recursive: true });
  }
  fs.writeFileSync(path.join(activeWs, '.artifacts', 'SPEC.md'), activeSpec);
  fs.writeFileSync(path.join(activeWs, '.artifacts', 'PLAN.md'), activePlan);

  fs.writeFileSync(path.join(archivedWs, '.artifacts', 'SPEC.md'), activeSpec);
  fs.writeFileSync(path.join(archivedWs, '.artifacts', 'PLAN.md'), activePlan + '\n<!-- HARNESS_STATUS: ARCHIVED -->\n');

  fs.writeFileSync(path.join(doneWs, '.artifacts', 'SPEC.md'), activeSpec + '\n<!-- HARNESS_STATUS: DONE -->\n');
  fs.writeFileSync(path.join(doneWs, '.artifacts', 'PLAN.md'), activePlan);

  fs.writeFileSync(path.join(autoArchivedWs, '.artifacts', 'SPEC.md'), activeSpec.replace('- [ ] AC-2:', '- [x] AC-2:'));
  fs.writeFileSync(path.join(autoArchivedWs, '.artifacts', 'PLAN.md'), activePlan.replace('`[ ] Pending`', '`[x] Completed`'));

  fs.writeFileSync(path.join(inProgressWs, '.artifacts', 'SPEC.md'), activeSpec.replace('- [ ] AC-2:', '- [x] AC-2:'));
  fs.writeFileSync(path.join(inProgressWs, '.artifacts', 'PLAN.md'), activePlan.replace('`[ ] Pending`', '`[/] In Progress`'));

  // Init git in tierSWs with 10 dirty files (INACTIVE mode must still allow direct edits & run_command)
  execFileSync('git', ['init', '-q'], { cwd: tierSWs });
  execFileSync('git', ['add', '.'], { cwd: tierSWs });
  execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-q', '-m', 'init'], { cwd: tierSWs });
  for (let i = 1; i <= 10; i++) {
    fs.writeFileSync(path.join(tierSWs, 'src', `f${i}.js`), `${i}\n`);
  }

  const tSessionStartParent = path.join(baseDir, 't-session-parent.jsonl');
  fs.writeFileSync(
    tSessionStartParent,
    [
      JSON.stringify({ step_index: 0, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', content: 'SessionStart hook initialized' }),
      JSON.stringify({ step_index: 1, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'Implement feature' }),
    ].join('\n') + '\n',
  );
  const tSubagentMsg = path.join(baseDir, 't-subagent-msg.jsonl');
  fs.writeFileSync(
    tSubagentMsg,
    [
      JSON.stringify({ step_index: 0, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', content: '<SYSTEM_MESSAGE>[Message] sender=parent-123</SYSTEM_MESSAGE>' }),
      JSON.stringify({ step_index: 2, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'synthetic' }),
    ].join('\n') + '\n',
  );

  const call = (ws, toolName, toolArgs, opts = {}) =>
    spawnHookAsync(
      guardScript,
      {
        workspacePaths: [ws],
        transcriptPath: opts.transcriptPath === undefined ? tSessionStartParent : opts.transcriptPath,
        toolCall: { name: toolName, args: toolArgs },
      },
      { cwd: ws, args: opts.pluginMode ? ['--plugin-mode'] : [] },
    );

  const results = await Promise.all([
    // --plugin-mode zero-intrusion
    call(uninitWs, 'write_file', { Path: 'src/a.js', Content: 'x' }, { pluginMode: true }),
    call(uninitWs, 'run_command', { CommandLine: 'sed -i "" "s/1/2/" src/a.js' }, { pluginMode: true }),
    call(activeWs, 'write_file', { Path: 'src/a.js', Content: 'x' }, { pluginMode: true }),

    // 2-rule deterministic isParent
    call(activeWs, 'edit_file', { Path: 'src/a.js' }),
    call(activeWs, 'edit_file', { Path: 'src/a.js' }, { transcriptPath: tSubagentMsg }),
    call(activeWs, 'edit_file', { Path: 'src/a.js' }, { transcriptPath: '' }),
    call(activeWs, 'edit_file', { Path: 'src/a.js' }, { transcriptPath: path.join(baseDir, 'missing.jsonl') }),

    // Expanded edit tools (including sed_file & File/TargetPath) & missing path fail-closed force_ask
    call(activeWs, 'create_file', { file_path: 'src/new.js' }),
    call(activeWs, 'delete_file', { filePath: 'src/a.js' }),
    call(activeWs, 'edit_file', { target_file: 'src/a.js' }),
    call(activeWs, 'sed_file', { File: 'src/a.js' }),
    call(activeWs, 'sed_file', { TargetPath: 'src/a.js' }),
    call(activeWs, 'edit_file', {}),

    // Archive / auto-archive unlocks INACTIVE; [/] keeps contract active
    call(archivedWs, 'edit_file', { Path: 'src/a.js' }),
    call(doneWs, 'edit_file', { Path: 'src/a.js' }),
    call(autoArchivedWs, 'edit_file', { Path: 'src/a.js' }),
    call(inProgressWs, 'edit_file', { Path: 'src/a.js' }),

    // run_command shell write-bypass blocked under active contract (including '.' target via git -C . / cp .)
    call(activeWs, 'run_command', { CommandLine: 'echo x > src/a.js' }),
    call(activeWs, 'run_command', { CommandLine: 'echo x >> "src/a.js"' }),
    call(activeWs, 'run_command', { CommandLine: "cat <<'EOF' > src/a.js\nhi\nEOF" }),
    call(activeWs, 'run_command', { CommandLine: 'echo x | tee src/a.js' }),
    call(activeWs, 'run_command', { CommandLine: "sed -i '' 's/1/2/' src/a.js" }),
    call(activeWs, 'run_command', { CommandLine: "perl -i -pe 's/1/2/' src/a.js" }),
    call(activeWs, 'run_command', { CommandLine: 'patch -p1 < fix.patch' }),
    call(activeWs, 'run_command', { CommandLine: 'dd if=/dev/zero of=src/a.bin bs=1 count=1' }),
    call(activeWs, 'run_command', { CommandLine: 'truncate -s 0 src/a.js' }),
    call(activeWs, 'run_command', { CommandLine: 'install -m 755 /tmp/x scripts/x.sh' }),
    call(activeWs, 'run_command', { CommandLine: 'mv src/a.js src/b.js' }),
    call(activeWs, 'run_command', { CommandLine: 'cp /tmp/x src/a.js' }),
    call(activeWs, 'run_command', { CommandLine: 'cp /tmp/x .' }),
    call(activeWs, 'run_command', { CommandLine: 'rm src/a.js' }),
    call(activeWs, 'run_command', { CommandLine: 'git apply fix.patch' }),
    call(activeWs, 'run_command', { CommandLine: 'git checkout -- src/a.js' }),
    call(activeWs, 'run_command', { CommandLine: 'git restore src/a.js' }),
    call(activeWs, 'run_command', { CommandLine: 'git reset --hard' }),
    call(activeWs, 'run_command', { CommandLine: 'git -C . reset --hard' }),
    call(activeWs, 'run_command', { CommandLine: 'git clean -fd' }),
    call(activeWs, 'run_command', { CommandLine: 'git merge feat' }),
    call(activeWs, 'run_command', { CommandLine: 'git cherry-pick abc123' }),
    call(activeWs, 'run_command', { CommandLine: 'git am foo.patch' }),
    call(activeWs, 'run_command', { CommandLine: "node -e \"require('fs').writeFileSync('src/a.js','x')\"" }),
    call(activeWs, 'run_command', { CommandLine: "node - <<'EOF'\nrequire('fs').writeFileSync('src/a.js','x')\nEOF" }),
    call(activeWs, 'run_command', { CommandLine: "python3 -c \"open('src/a.js','w').write('x')\"" }),
    call(activeWs, 'run_command', { CommandLine: "python3 - <<'PY'\nimport pathlib; pathlib.Path('src/a.js').write_text('x')\nPY" }),

    // run_command zero-false-positive read-only / test / gate / exempt writes & subagent allow
    call(activeWs, 'run_command', { CommandLine: 'git status && git --no-pager diff' }),
    call(activeWs, 'run_command', { CommandLine: 'git log --grep="a => b" -n 5' }),
    call(activeWs, 'run_command', { CommandLine: 'rg "sed -i" scripts/' }),
    call(activeWs, 'run_command', { CommandLine: 'CI=true node --test scripts/harness-test.js 2>&1' }),
    call(activeWs, 'run_command', { CommandLine: 'bash scripts/gate-check.sh --fast < /dev/null' }),
    call(activeWs, 'run_command', { CommandLine: "node -e \"console.log('1 > 0')\"" }),
    call(activeWs, 'run_command', { CommandLine: 'echo ok > .artifacts/notes.md' }),
    call(activeWs, 'run_command', { CommandLine: 'echo ok > .agents/rules/x.md' }),
    call(activeWs, 'run_command', { CommandLine: 'echo ok > /tmp/ok.txt' }),
    call(activeWs, 'run_command', { CommandLine: 'dd if=/dev/zero of=/dev/null bs=1 count=1' }),
    call(activeWs, 'run_command', { CommandLine: "sed -i '' 's/Pending/Done/' .artifacts/PLAN.md" }),
    call(activeWs, 'run_command', { CommandLine: 'rm -f /tmp/ok.txt' }),
    call(activeWs, 'run_command', { CommandLine: "node -e \"require('fs').writeFileSync('/tmp/ok.txt','x')\"" }),
    call(activeWs, 'run_command', { CommandLine: 'git -C /tmp/other-repo reset --hard' }),
    call(activeWs, 'run_command', { CommandLine: "sed -i '' 's/1/2/' src/a.js" }, { transcriptPath: tSubagentMsg }),

    // INACTIVE allows dirty repos (10+ dirty files), 5+ manifest edits, sed_file, and run_command
    call(tierSWs, 'run_command', { CommandLine: 'echo 11 > src/f11.js' }),
    call(tierSWs, 'write_file', { Path: 'src/f12.js', Content: '12\n' }),
    call(tierSWs, 'sed_file', { File: 'plugin.json' }),
    call(tierSWs, 'sed_file', { TargetPath: 'README.md' }),
  ]);

  const expected = [
    'allow', 'allow', 'deny',
    'deny', 'allow', 'allow', 'allow',
    'deny', 'deny', 'deny', 'deny', 'deny', 'force_ask',
    'allow', 'allow', 'allow', 'deny',
    'deny', 'deny', 'deny', 'deny', 'deny', 'deny', 'deny', 'deny', 'deny', 'deny',
    'deny', 'deny', 'deny', 'deny', 'deny', 'deny', 'deny', 'deny', 'deny', 'deny', 'deny',
    'deny', 'deny', 'deny', 'deny', 'deny', 'deny',
    'allow', 'allow', 'allow', 'allow', 'allow', 'allow', 'allow', 'allow', 'allow', 'allow',
    'allow', 'allow', 'allow', 'allow', 'allow',
    'allow', 'allow', 'allow', 'allow',
  ];
  assert.equal(results.length, expected.length);
  results.forEach((res, idx) => {
    assert.equal(res.decision, expected[idx], `Guard case #${idx} mismatch: got ${JSON.stringify(res)}, expected ${expected[idx]}`);
  });
    }),

    t.test('Python3 fallback matches Node.js behavior when node is absent from PATH', async (t) => {
  const pyBin = findExecutable('python3');
  assert.ok(pyBin, 'python3 must be available for fallback verification');
  const baseDir = makeTempDir('agy-harness-py-fallback-');
  const noNodeBin = path.join(baseDir, 'bin');
  const stateDir = path.join(baseDir, 'state');
  const wsDir = path.join(baseDir, 'ws');
  t.after(() => fs.rmSync(baseDir, { recursive: true, force: true }));

  fs.mkdirSync(noNodeBin, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(path.join(wsDir, '.artifacts'), { recursive: true });
  fs.mkdirSync(path.join(wsDir, 'src'), { recursive: true });

  for (const binName of ['bash', 'sh', 'cat', 'dirname', 'git', 'python3']) {
    const resolved = findExecutable(binName);
    if (resolved) {
      fs.symlinkSync(resolved, path.join(noNodeBin, binName));
    }
  }

  fs.writeFileSync(path.join(wsDir, '.artifacts', 'SPEC.md'), '# SPEC\n- **Goal:** Py fallback\n- [ ] AC-1: Works\n');
  fs.writeFileSync(path.join(wsDir, '.artifacts', 'PLAN.md'), '# PLAN\n## Slice 1: One\n- **Status:** `[ ] Pending`\n');
  fs.writeFileSync(path.join(wsDir, 'src', 'a.js'), 'const a = 1;\n');

  const tParentQ = path.join(baseDir, 't-q.jsonl');
  fs.writeFileSync(
    tParentQ,
    [
      JSON.stringify({ step_index: 0, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', content: 'SessionStart' }),
      JSON.stringify({ step_index: 1, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2099-01-01T00:00:00.000Z', content: 'Proceed?' }),
    ].join('\n') + '\n',
  );
  const tParentOk = path.join(baseDir, 't-ok.jsonl');
  fs.writeFileSync(
    tParentOk,
    [
      JSON.stringify({ step_index: 0, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', content: 'SessionStart' }),
      JSON.stringify({ step_index: 1, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2099-01-01T00:00:00.000Z', content: 'The user has approved this document.' }),
    ].join('\n') + '\n',
  );
  const tSedPlanAfter = path.join(baseDir, 't-py-sed-plan.jsonl');
  fs.writeFileSync(
    tSedPlanAfter,
    [
      JSON.stringify({ step_index: 0, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', content: 'SessionStart' }),
      JSON.stringify({ step_index: 1, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2099-01-01T00:00:00.000Z', content: 'The user has approved this document.' }),
      JSON.stringify({ step_index: 2, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2099-01-01T00:00:01.000Z', tool_calls: [{ name: 'sed_file', args: { TargetPath: '.artifacts/PLAN.md' } }] }),
    ].join('\n') + '\n',
  );
  const tSub = path.join(baseDir, 't-sub.jsonl');
  fs.writeFileSync(
    tSub,
    JSON.stringify({ step_index: 0, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', content: '[Message] sender=parent' }) + '\n',
  );

  const approvalGate = path.join(ROOT, 'scripts', 'harness-approval-gate.sh');
  const sourceGuard = path.join(ROOT, 'scripts', 'harness-source-edit-guard.sh');
  const pyEnv = { PATH: noNodeBin, AGY_HARNESS_STATE_DIR: stateDir };

  const wsAutoArchived = path.join(baseDir, 'ws-auto-archived');
  fs.mkdirSync(path.join(wsAutoArchived, '.artifacts'), { recursive: true });
  fs.mkdirSync(path.join(wsAutoArchived, 'src'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: wsAutoArchived });
  for (let i = 1; i <= 10; i++) {
    fs.writeFileSync(path.join(wsAutoArchived, 'src', `d${i}.js`), `${i}\n`);
  }
  fs.writeFileSync(path.join(wsAutoArchived, '.artifacts', 'SPEC.md'), '# SPEC\n- **Goal:** Done\n- [x] AC-1: Done\n');
  fs.writeFileSync(path.join(wsAutoArchived, '.artifacts', 'PLAN.md'), '# PLAN\n## Slice 1: One\n- **Status:** `[x] Completed`\n');

  const [
    aResearch, aQuestion, aApprove, aExitPlan, aArchivedDeny, aSedPlanDeny,
    aPlan5Docs, aPlan5NonJsCode, aPlan4Code, aPlan5Code, aPlan5Phase1, aPlanTierM,
    gParentEdit, gParentSedFile, gSubEdit, gSedBypass, gGitDotReset, gGitStatus, gArchivedUnlock, gInactiveDirtyCmd,
  ] = await Promise.all([
    spawnHookAsync(approvalGate, { conversationId: 'py-1', workspacePaths: [wsDir], transcriptPath: tParentQ, toolCall: { name: 'invoke_subagent', args: { TypeName: 'research' } } }, { cwd: wsDir, env: pyEnv }),
    spawnHookAsync(approvalGate, { conversationId: 'py-2', workspacePaths: [wsDir], transcriptPath: tParentQ, toolCall: { name: 'invoke_subagent', args: { TypeName: 'slice-builder' } } }, { cwd: wsDir, env: pyEnv }),
    spawnHookAsync(approvalGate, { conversationId: 'py-3', workspacePaths: [wsDir], transcriptPath: tParentOk, toolCall: { name: 'run_workflow', args: { WorkflowName: 'ship' } } }, { cwd: wsDir, env: pyEnv }),
    spawnHookAsync(approvalGate, { conversationId: 'py-4', workspacePaths: [wsDir], transcriptPath: tParentQ, toolCall: { name: 'exit_plan_mode', args: { plan: 'Invoke slice-builder' } } }, { cwd: wsDir, env: pyEnv }),
    spawnHookAsync(approvalGate, { conversationId: 'py-5', workspacePaths: [wsAutoArchived], transcriptPath: tParentOk, toolCall: { name: 'invoke_subagent', args: { TypeName: 'slice-builder' } } }, { cwd: wsAutoArchived, env: pyEnv }),
    spawnHookAsync(approvalGate, { conversationId: 'py-6', workspacePaths: [wsDir], transcriptPath: tSedPlanAfter, toolCall: { name: 'invoke_subagent', args: { TypeName: 'slice-builder' } } }, { cwd: wsDir, env: pyEnv }),
    spawnHookAsync(approvalGate, { conversationId: 'py-7', workspacePaths: [wsAutoArchived], transcriptPath: tParentOk, toolCall: { name: 'exit_plan_mode', args: { plan: 'Update docs/a.md, docs/b.md, .github/CODEOWNERS, .claude-plugin/marketplace.json, and assets/logo.svg' } } }, { cwd: wsAutoArchived, env: pyEnv }),
    spawnHookAsync(approvalGate, { conversationId: 'py-12', workspacePaths: [wsAutoArchived], transcriptPath: tParentOk, toolCall: { name: 'exit_plan_mode', args: { plan: 'Modify agents/a.md, skills/x/SKILL.md, commands/c.md, evals/cases/a.json, and scripts/hooks/a.hooks.json' } } }, { cwd: wsAutoArchived, env: pyEnv }),
    spawnHookAsync(approvalGate, { conversationId: 'py-8', workspacePaths: [wsAutoArchived], transcriptPath: tParentOk, toolCall: { name: 'exit_plan_mode', args: { plan: 'Edit src/a.js, src/b.js, src/c.js, and src/d.js' } } }, { cwd: wsAutoArchived, env: pyEnv }),
    spawnHookAsync(approvalGate, { conversationId: 'py-9', workspacePaths: [wsAutoArchived], transcriptPath: tParentOk, toolCall: { name: 'exit_plan_mode', args: { plan: 'Edit src/a.js, src/b.js, src/c.js, src/d.js, and src/e.js' } } }, { cwd: wsAutoArchived, env: pyEnv }),
    spawnHookAsync(approvalGate, { conversationId: 'py-10', workspacePaths: [wsAutoArchived], transcriptPath: tParentOk, toolCall: { name: 'exit_plan_mode', args: { plan: 'Tier M Phase 1: draft .artifacts/SPEC.md & .artifacts/PLAN.md, sync harness_plan.md (RequestFeedback=true), stop turn and wait for Proceed before editing src/a.js, src/b.js, src/c.js, src/d.js, and src/e.js.' } } }, { cwd: wsAutoArchived, env: pyEnv }),
    spawnHookAsync(approvalGate, { conversationId: 'py-11', workspacePaths: [wsAutoArchived], transcriptPath: tParentOk, toolCall: { name: 'exit_plan_mode', args: { plan: 'Tier M refactor across auth module' } } }, { cwd: wsAutoArchived, env: pyEnv }),
    spawnHookAsync(sourceGuard, { workspacePaths: [wsDir], transcriptPath: tParentOk, toolCall: { name: 'create_file', args: { file_path: 'src/b.js' } } }, { cwd: wsDir, env: pyEnv }),
    spawnHookAsync(sourceGuard, { workspacePaths: [wsDir], transcriptPath: tParentOk, toolCall: { name: 'sed_file', args: { File: 'src/a.js' } } }, { cwd: wsDir, env: pyEnv }),
    spawnHookAsync(sourceGuard, { workspacePaths: [wsDir], transcriptPath: tSub, toolCall: { name: 'create_file', args: { file_path: 'src/b.js' } } }, { cwd: wsDir, env: pyEnv }),
    spawnHookAsync(sourceGuard, { workspacePaths: [wsDir], transcriptPath: tParentOk, toolCall: { name: 'run_command', args: { CommandLine: "sed -i '' 's/1/2/' src/a.js" } } }, { cwd: wsDir, env: pyEnv }),
    spawnHookAsync(sourceGuard, { workspacePaths: [wsDir], transcriptPath: tParentOk, toolCall: { name: 'run_command', args: { CommandLine: 'git -C . reset --hard' } } }, { cwd: wsDir, env: pyEnv }),
    spawnHookAsync(sourceGuard, { workspacePaths: [wsDir], transcriptPath: tParentOk, toolCall: { name: 'run_command', args: { CommandLine: 'git status' } } }, { cwd: wsDir, env: pyEnv }),
    spawnHookAsync(sourceGuard, { workspacePaths: [wsAutoArchived], transcriptPath: tParentOk, toolCall: { name: 'edit_file', args: { Path: 'src/a.js' } } }, { cwd: wsAutoArchived, env: pyEnv }),
    spawnHookAsync(sourceGuard, { workspacePaths: [wsAutoArchived], transcriptPath: tParentOk, toolCall: { name: 'run_command', args: { CommandLine: 'echo 11 > src/d11.js' } } }, { cwd: wsAutoArchived, env: pyEnv }),
  ]);

  assert.equal(aResearch.decision, 'allow');
  assert.equal(aQuestion.decision, 'force_ask');
  assert.equal(aApprove.decision, 'allow');
  assert.equal(aExitPlan.decision, 'force_ask');
  assert.equal(aArchivedDeny.decision, 'deny');
  assert.equal(aSedPlanDeny.decision, 'deny');
  assert.equal(aPlan5Docs.decision, 'allow');
  assert.equal(aPlan5NonJsCode.decision, 'force_ask');
  assert.equal(aPlan4Code.decision, 'allow');
  assert.equal(aPlan5Code.decision, 'force_ask');
  assert.equal(aPlan5Phase1.decision, 'allow');
  assert.equal(aPlanTierM.decision, 'force_ask');
  assert.equal(gParentEdit.decision, 'deny');
  assert.equal(gParentSedFile.decision, 'deny');
  assert.equal(gSubEdit.decision, 'allow');
  assert.equal(gSedBypass.decision, 'deny');
  assert.equal(gGitDotReset.decision, 'deny');
  assert.equal(gGitStatus.decision, 'allow');
  assert.equal(gArchivedUnlock.decision, 'allow');
  assert.equal(gInactiveDirtyCmd.decision, 'allow');
    }),
  ]);
});

test('Slice 2 lifecycle, plugin hooks, and subagent guard suite', async (t) => {
  await Promise.all([
    t.test('hooks.json, .agents/hooks.json, hooks-template.json, and scripts/hooks/*.hooks.json match AGY schema and pass agy plugin validate', () => {
      const rootHooksPath = path.join(ROOT, 'hooks.json');
      const wsHooksPath = path.join(ROOT, '.agents', 'hooks.json');
      const tplHooksPath = path.join(ROOT, 'skills', 'harness-init', 'references', 'hooks-template.json');
      const builderHooksPath = path.join(ROOT, 'scripts', 'hooks', 'slice-builder.hooks.json');
      const gatekeeperHooksPath = path.join(ROOT, 'scripts', 'hooks', 'staff-gatekeeper.hooks.json');

      for (const p of [rootHooksPath, wsHooksPath, tplHooksPath, builderHooksPath, gatekeeperHooksPath]) {
        assert.ok(fs.existsSync(p), `Missing hooks config: ${path.relative(ROOT, p)}`);
      }

      const rootHooksRaw = fs.readFileSync(rootHooksPath, 'utf8');
      const wsHooksRaw = fs.readFileSync(wsHooksPath, 'utf8');
      const tplHooksRaw = fs.readFileSync(tplHooksPath, 'utf8');
      assert.equal(wsHooksRaw, tplHooksRaw, '.agents/hooks.json must stay byte-identical to hooks-template.json');

      const rootHooks = JSON.parse(rootHooksRaw);
      const wsHooks = JSON.parse(wsHooksRaw);
      const tplHooks = JSON.parse(tplHooksRaw);
      assert.deepEqual(wsHooks, tplHooks, '.agents/hooks.json must stay identical to hooks-template.json');

      const expectedApprovalMatcher = 'invoke_subagent|define_subagent|swarm|run_workflow|exit_plan_mode';
      const expectedEditMatcher =
        'write_file|edit_file|create_file|delete_file|sed_file|write_to_file|replace_file_content|multi_replace_file_content|run_command';

      for (const [label, cfg, isRoot] of [
        ['hooks.json', rootHooks, true],
        ['.agents/hooks.json', wsHooks, false],
      ]) {
        for (const group of [
          'harness-contract-approval-gate',
          'harness-parent-source-edit-guard',
          'harness-lifecycle-guard',
        ]) {
          assert.ok(cfg[group], `${label} must define ${group}`);
        }

        const prefix = isRoot ? './scripts/' : '../scripts/';
        const suffix = isRoot ? ' --plugin-mode' : '';

        const approvalPre = cfg['harness-contract-approval-gate'].PreToolUse;
        assert.equal(approvalPre.length, 1);
        assert.equal(approvalPre[0].matcher, expectedApprovalMatcher);
        assert.equal(approvalPre[0].hooks[0].command, `${prefix}harness-approval-gate.sh${suffix}`);

        const editPre = cfg['harness-parent-source-edit-guard'].PreToolUse;
        assert.equal(editPre.length, 1);
        assert.equal(editPre[0].matcher, expectedEditMatcher);
        assert.equal(editPre[0].hooks[0].command, `${prefix}harness-source-edit-guard.sh${suffix}`);

        const lifecycle = cfg['harness-lifecycle-guard'];
        assert.ok(Array.isArray(lifecycle.PreInvocation) && lifecycle.PreInvocation.length === 1);
        assert.equal(lifecycle.PreInvocation[0].matcher, undefined, `${label} PreInvocation must be flat`);
        assert.equal(lifecycle.PreInvocation[0].command, `${prefix}harness-lifecycle-hook.sh${suffix}`);

        assert.ok(Array.isArray(lifecycle.PostToolUse) && lifecycle.PostToolUse.length === 1);
        assert.equal(lifecycle.PostToolUse[0].matcher, expectedEditMatcher);
        assert.equal(lifecycle.PostToolUse[0].hooks[0].command, `${prefix}harness-lifecycle-hook.sh${suffix}`);

        assert.ok(Array.isArray(lifecycle.Stop) && lifecycle.Stop.length === 1);
        assert.equal(lifecycle.Stop[0].matcher, undefined, `${label} Stop must be flat`);
        assert.equal(lifecycle.Stop[0].command, `${prefix}harness-lifecycle-hook.sh${suffix}`);
      }

      const builderHooks = JSON.parse(fs.readFileSync(builderHooksPath, 'utf8'));
      const gatekeeperHooks = JSON.parse(fs.readFileSync(gatekeeperHooksPath, 'utf8'));
      assert.equal(builderHooks['harness-slice-builder-guard'].PreToolUse[0].matcher, expectedEditMatcher);
      assert.equal(
        builderHooks['harness-slice-builder-guard'].PreToolUse[0].hooks[0].command,
        '../harness-subagent-guard.sh --role=slice-builder',
      );
      assert.equal(builderHooks['harness-slice-builder-guard'].PreToolUse[0].hooks[0].timeout, 10);
      assert.equal(
        gatekeeperHooks['harness-staff-gatekeeper-guard'].PreToolUse[0].hooks[0].command,
        '../harness-subagent-guard.sh --role=staff-gatekeeper',
      );
      assert.equal(gatekeeperHooks['harness-staff-gatekeeper-guard'].PreToolUse[0].hooks[0].timeout, 10);

      for (const shRel of ['scripts/harness-lifecycle-hook.sh', 'scripts/harness-subagent-guard.sh']) {
        const st = fs.statSync(path.join(ROOT, shRel));
        assert.ok((st.mode & 0o111) !== 0, `${shRel} must be executable`);
      }

      const agyBin = findExecutable('agy');
      if (agyBin) {
        const validateOut = execFileSync(agyBin, ['plugin', 'validate', '--json', '.'], {
          cwd: ROOT,
          encoding: 'utf8',
        });
        const report = JSON.parse(validateOut);
        assert.ok(report.components && report.components.hooks >= 3, `Expected hooks >= 3, got ${JSON.stringify(report)}`);
        const badFindings = (report.findings || []).filter(
          (f) =>
            f.severity === 'error' ||
            (f.severity === 'warning' && /^(?:hooks\.json|agents\/)/.test(String(f.file || ''))),
        );
        assert.deepEqual(badFindings, [], `Unexpected agy plugin validate findings: ${JSON.stringify(badFindings)}`);
      }
    }),

    t.test('harness-lifecycle-hook.sh handles --plugin-mode, PreInvocation injection/dedup, PostToolUse tracking, and Stop anti-loop gate', async (t) => {
      const baseDir = makeTempDir('agy-harness-lifecycle-');
      const stateDir = makeTempDir('agy-harness-lifecycle-state-');
      t.after(() => {
        fs.rmSync(baseDir, { recursive: true, force: true });
        fs.rmSync(stateDir, { recursive: true, force: true });
      });

      const lifecycleHook = path.join(ROOT, 'scripts', 'harness-lifecycle-hook.sh');
      const uninitWs = path.join(baseDir, 'uninit-ws');
      const wsWithLocalHooks = path.join(baseDir, 'local-hooks-ws');
      const activeWs = path.join(baseDir, 'active-ws');
      const tierSWs = path.join(baseDir, 'tier-s-ws');

      for (const d of [uninitWs, wsWithLocalHooks, activeWs, tierSWs]) {
        fs.mkdirSync(path.join(d, 'src'), { recursive: true });
        fs.writeFileSync(path.join(d, 'src', 'a.js'), 'export const a = 1;\n');
      }

      fs.mkdirSync(path.join(wsWithLocalHooks, '.agents', 'rules'), { recursive: true });
      fs.writeFileSync(path.join(wsWithLocalHooks, '.agents', 'rules', 'agy-harness.md'), '# rule\n');
      fs.writeFileSync(
        path.join(wsWithLocalHooks, '.agents', 'hooks.json'),
        JSON.stringify({ 'harness-lifecycle-guard': { Stop: [] } }) + '\n',
      );

      fs.mkdirSync(path.join(activeWs, '.artifacts'), { recursive: true });
      fs.mkdirSync(path.join(activeWs, 'scripts'), { recursive: true });
      fs.writeFileSync(
        path.join(activeWs, '.artifacts', 'SPEC.md'),
        '# SPEC\n- **Goal:** Lifecycle hook\n- [ ] AC-1: Works\n',
      );
      fs.writeFileSync(
        path.join(activeWs, '.artifacts', 'PLAN.md'),
        '# PLAN\n## Slice 1: Core\n- **Status:** `[ ] Pending`\n',
      );
      fs.writeFileSync(path.join(activeWs, 'scripts', 'gate-check.sh'), '#!/bin/bash\nexit 0\n');

      execFileSync('git', ['init', '-q'], { cwd: tierSWs });
      execFileSync('git', ['add', '.'], { cwd: tierSWs });
      execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-q', '-m', 'init'], {
        cwd: tierSWs,
      });
      fs.mkdirSync(path.join(tierSWs, '.artifacts'), { recursive: true });
      fs.mkdirSync(path.join(tierSWs, 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(tierSWs, 'scripts', 'gate-check.sh'), '#!/bin/bash\nexit 0\n');
      fs.writeFileSync(
        path.join(tierSWs, '.artifacts', 'SPEC.md'),
        '- **Goal:** _Describe the concrete user or system problem being solved._\n',
      );
      fs.writeFileSync(path.join(tierSWs, '.artifacts', 'PLAN.md'), '## Slice 1: [Title]\n');

      const tParentPending = path.join(baseDir, 't-parent-pending.jsonl');
      fs.writeFileSync(
        tParentPending,
        [
          JSON.stringify({ step_index: 0, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', content: 'SessionStart' }),
          JSON.stringify({
            step_index: 1,
            source: 'USER_EXPLICIT',
            type: 'USER_INPUT',
            created_at: '2099-01-01T00:00:00.000Z',
            content: 'Draft spec and wait',
          }),
        ].join('\n') + '\n',
      );
      const tParentApproved = path.join(baseDir, 't-parent-approved.jsonl');
      fs.writeFileSync(
        tParentApproved,
        [
          JSON.stringify({ step_index: 0, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', content: 'SessionStart' }),
          JSON.stringify({
            step_index: 1,
            source: 'USER_EXPLICIT',
            type: 'USER_INPUT',
            created_at: '2099-01-01T00:00:00.000Z',
            content: 'The user has approved this document.',
          }),
        ].join('\n') + '\n',
      );
      const tSubagent = path.join(baseDir, 't-subagent.jsonl');
      fs.writeFileSync(
        tSubagent,
        [
          JSON.stringify({ step_index: 0, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', content: '<SYSTEM_MESSAGE>[Message] sender=parent-1</SYSTEM_MESSAGE>' }),
          JSON.stringify({ step_index: 1, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'synthetic' }),
        ].join('\n') + '\n',
      );

      const call = (ws, eventName, extra = {}, opts = {}) =>
        spawnHookAsync(
          lifecycleHook,
          {
            conversationId: opts.conversationId || 'conv-lc-1',
            workspacePaths: [ws],
            transcriptPath: opts.transcriptPath === undefined ? tParentPending : opts.transcriptPath,
            hookEventName: eventName,
            ...extra,
          },
          { cwd: ws, env: { AGY_HARNESS_STATE_DIR: stateDir }, args: opts.pluginMode ? ['--plugin-mode'] : [] },
        );

      // 1. --plugin-mode zero-intrusion & yield when workspace .agents/hooks.json already registers harness-lifecycle-guard
      assert.deepEqual(await call(uninitWs, 'PreInvocation', {}, { pluginMode: true }), {});
      assert.deepEqual(await call(uninitWs, 'Stop', { terminationReason: 'NO_TOOL_CALL' }, { pluginMode: true }), {
        decision: 'allow',
      });
      assert.deepEqual(await call(wsWithLocalHooks, 'PreInvocation', {}, { pluginMode: true }), {});
      assert.deepEqual(await call(wsWithLocalHooks, 'Stop', { terminationReason: 'NO_TOOL_CALL' }, { pluginMode: true }), {
        decision: 'allow',
      });

      // 2. PreInvocation: skip subagents & missing-parent transcripts; inject & dedup for parent
      assert.deepEqual(await call(activeWs, 'PreInvocation', {}, { transcriptPath: tSubagent, conversationId: 'lc-sub' }), {});
      assert.deepEqual(await call(activeWs, 'PreInvocation', {}, { transcriptPath: '', conversationId: 'lc-empty' }), {});

      const preUnapproved1 = await call(activeWs, 'PreInvocation', {}, { conversationId: 'lc-parent-1' });
      assert.equal(preUnapproved1.injectSteps.length, 1);
      assert.match(preUnapproved1.injectSteps[0].systemMessage.systemMessage, /ACTIVE_UNAPPROVED|Proceed/i);
      const preUnapproved2 = await call(activeWs, 'PreInvocation', {}, { conversationId: 'lc-parent-1' });
      assert.deepEqual(preUnapproved2, {});

      const preApproved1 = await call(
        activeWs,
        'PreInvocation',
        {},
        { transcriptPath: tParentApproved, conversationId: 'lc-parent-1' },
      );
      assert.equal(preApproved1.injectSteps.length, 1);
      assert.match(preApproved1.injectSteps[0].systemMessage.systemMessage, /ACTIVE_APPROVED|slice-builder/i);
      const preApproved2 = await call(
        activeWs,
        'PreInvocation',
        {},
        { transcriptPath: tParentApproved, conversationId: 'lc-parent-1' },
      );
      assert.deepEqual(preApproved2, {});

      // INACTIVE 5-tier routing reminder (injects once on 0 or dirty files, then deduplicates)
      const preInactive1 = await call(tierSWs, 'PreInvocation', {}, { conversationId: 'lc-inactive' });
      assert.equal(preInactive1.injectSteps.length, 1);
      const inactiveMsg = preInactive1.injectSteps[0].systemMessage.systemMessage;
      assert.match(inactiveMsg, /State: INACTIVE/);
      assert.match(inactiveMsg, /Tier XS/);
      assert.match(inactiveMsg, /Tier S/);
      assert.match(inactiveMsg, /Tier M\/L\/XL/);
      assert.deepEqual(await call(tierSWs, 'PreInvocation', {}, { conversationId: 'lc-inactive' }), {});

      // Tier XS exempt edits/commands in INACTIVE workspace do NOT arm Stop(continue)
      await Promise.all([
        call(tierSWs, 'PostToolUse', { toolCall: { name: 'edit_file', args: { Path: 'README.md' } } }),
        call(tierSWs, 'PostToolUse', { toolCall: { name: 'edit_file', args: { Path: 'docs/a.md' } } }),
        call(tierSWs, 'PostToolUse', { toolCall: { name: 'edit_file', args: { Path: 'plugin.json' } } }),
        call(tierSWs, 'PostToolUse', { toolCall: { name: 'edit_file', args: { Path: '.claude-plugin/marketplace.json' } } }),
        call(tierSWs, 'PostToolUse', { toolCall: { name: 'edit_file', args: { Path: '.github/CODEOWNERS' } } }),
        call(tierSWs, 'PostToolUse', { toolCall: { name: 'edit_file', args: { Path: 'pnpm-lock.yaml' } } }),
        call(tierSWs, 'PostToolUse', { toolCall: { name: 'edit_file', args: { Path: 'assets/logo.svg' } } }),
        call(tierSWs, 'PostToolUse', { toolCall: { name: 'sed_file', args: { File: 'README.md' } } }),
        call(tierSWs, 'PostToolUse', { toolCall: { name: 'run_command', args: { CommandLine: "sed -i '' 's/a/b/' README.md" } } }),
        call(tierSWs, 'PostToolUse', { toolCall: { name: 'run_command', args: { CommandLine: "node -e \"require('fs').writeFileSync('plugin.json','{}')\"" } } }),
      ]);
      assert.equal(
        (await call(tierSWs, 'Stop', { terminationReason: 'NO_TOOL_CALL', fullyIdle: true }, { transcriptPath: tParentApproved })).decision,
        'allow',
      );

      // Non-exempt paths, sed_file on code, missing rawTarget, and '.' / shell writes DO arm Stop(continue) until gate-check.sh
      const nonExemptPayloads = [
        { toolCall: { name: 'edit_file', args: { Path: 'src/a.js' } } },
        { toolCall: { name: 'edit_file', args: { Path: 'hooks.json' } } },
        { toolCall: { name: 'edit_file', args: { Path: 'package.json' } } },
        { toolCall: { name: 'edit_file', args: { Path: 'agents/slice-builder.md' } } },
        { toolCall: { name: 'edit_file', args: { Path: 'skills/foo/SKILL.md' } } },
        { toolCall: { name: 'edit_file', args: { Path: 'evals/cases/a.json' } } },
        { toolCall: { name: 'sed_file', args: { TargetPath: 'src/a.js' } } },
        { toolCall: { name: 'edit_file', args: {} } },
        { toolCall: { name: 'run_command', args: { CommandLine: 'echo hi > src/a.js' } } },
        { toolCall: { name: 'run_command', args: { CommandLine: 'cp /tmp/x .' } } },
        { toolCall: { name: 'run_command', args: { CommandLine: 'git -C . reset --hard' } } },
      ];
      await Promise.all(
        nonExemptPayloads.map(async (pl, idx) => {
          const wsProbe = path.join(baseDir, `ws-ne-${idx}`);
          fs.mkdirSync(path.join(wsProbe, 'scripts'), { recursive: true });
          fs.writeFileSync(path.join(wsProbe, 'scripts', 'gate-check.sh'), '#!/bin/bash\nexit 0\n');
          await call(wsProbe, 'PostToolUse', pl);
          const s1 = await call(wsProbe, 'Stop', { terminationReason: 'NO_TOOL_CALL', fullyIdle: true }, { transcriptPath: tParentApproved });
          assert.equal(s1.decision, 'continue', `Non-exempt payload #${idx} (${JSON.stringify(pl)}) must arm Stop(continue)`);
          await call(wsProbe, 'PostToolUse', { toolCall: { name: 'run_command', args: { CommandLine: 'bash scripts/gate-check.sh' } } });
          const s2 = await call(wsProbe, 'Stop', { terminationReason: 'NO_TOOL_CALL', fullyIdle: true }, { transcriptPath: tParentApproved });
          assert.equal(s2.decision, 'allow', `Full gate pass must clear Stop(continue) for payload #${idx}`);
        }),
      );

      // 3. PostToolUse ignores failed calls, harness files, and --fast; tracks subagent source edits & full gate pass
      await call(activeWs, 'PostToolUse', {
        error: 'exit status 1',
        toolCall: { name: 'edit_file', args: { Path: 'src/a.js' } },
      });
      await call(activeWs, 'PostToolUse', {
        toolCall: { name: 'edit_file', args: { Path: '.artifacts/PLAN.md' } },
      });
      await call(activeWs, 'PostToolUse', {
        toolCall: { name: 'run_command', args: { CommandLine: 'git status' } },
      });
      assert.equal(
        (await call(activeWs, 'Stop', { terminationReason: 'NO_TOOL_CALL', fullyIdle: true }, { transcriptPath: tParentApproved }))
          .decision,
        'allow',
      );

      // Subagent edits source file -> workspace-scoped Stop sees it
      await call(
        activeWs,
        'PostToolUse',
        { toolCall: { name: 'edit_file', args: { Path: 'src/a.js' } } },
        { transcriptPath: tSubagent, conversationId: 'sub-conv' },
      );
      // --fast gate does NOT clear Stop requirement; failed full gate does NOT clear it
      await call(activeWs, 'PostToolUse', {
        toolCall: { name: 'run_command', args: { CommandLine: 'bash scripts/gate-check.sh --fast' } },
      });
      await call(activeWs, 'PostToolUse', {
        error: 'exit status 1',
        toolCall: { name: 'run_command', args: { CommandLine: 'bash scripts/gate-check.sh' } },
      });

      // Anti-loop & exemptions before firing Stop(continue)
      assert.equal(
        (
          await call(
            activeWs,
            'Stop',
            { terminationReason: 'NO_TOOL_CALL', fullyIdle: true, continuationActive: true },
            { transcriptPath: tParentApproved },
          )
        ).decision,
        'allow',
      );
      assert.equal(
        (
          await call(
            activeWs,
            'Stop',
            { terminationReason: 'NO_TOOL_CALL', fullyIdle: true, continuation_active: true },
            { transcriptPath: tParentApproved },
          )
        ).decision,
        'allow',
      );
      assert.equal(
        (
          await call(activeWs, 'Stop', { terminationReason: 'NO_TOOL_CALL', fullyIdle: true }, { transcriptPath: tSubagent })
        ).decision,
        'allow',
      );
      assert.equal(
        (
          await call(activeWs, 'Stop', { terminationReason: 'ERROR', fullyIdle: true }, { transcriptPath: tParentApproved })
        ).decision,
        'allow',
      );
      assert.equal(
        (
          await call(activeWs, 'Stop', { terminationReason: 'NO_TOOL_CALL', fullyIdle: false }, { transcriptPath: tParentApproved })
        ).decision,
        'allow',
      );
      assert.equal(
        (
          await call(activeWs, 'Stop', { terminationReason: 'NO_TOOL_CALL', fullyIdle: true }, { transcriptPath: tParentPending })
        ).decision,
        'allow',
      );

      // Now parent Stop fires continue!
      const stopContinue = await call(
        activeWs,
        'Stop',
        { terminationReason: 'NO_TOOL_CALL', fullyIdle: true },
        { transcriptPath: tParentApproved },
      );
      assert.equal(stopContinue.decision, 'continue');
      assert.match(stopContinue.reason, /scripts\/gate-check\.sh/);
      assert.match(stopContinue.reason, /manage_subagents/);

      // Full gate pass clears Stop(continue)
      await call(activeWs, 'PostToolUse', {
        toolCall: { name: 'run_command', args: { CommandLine: 'bash scripts/gate-check.sh' } },
      });
      assert.equal(
        (
          await call(activeWs, 'Stop', { terminationReason: 'NO_TOOL_CALL', fullyIdle: true }, { transcriptPath: tParentApproved })
        ).decision,
        'allow',
      );

      // Subsequent mutating run_command re-arms Stop(continue)
      await call(activeWs, 'PostToolUse', {
        toolCall: { name: 'run_command', args: { CommandLine: 'echo hi > src/a.js' } },
      });
      assert.equal(
        (
          await call(activeWs, 'Stop', { terminationReason: 'NO_TOOL_CALL', fullyIdle: true }, { transcriptPath: tParentApproved })
        ).decision,
        'continue',
      );

      // Missing gate-check.sh exempts Stop
      fs.rmSync(path.join(activeWs, 'scripts', 'gate-check.sh'));
      assert.equal(
        (
          await call(activeWs, 'Stop', { terminationReason: 'NO_TOOL_CALL', fullyIdle: true }, { transcriptPath: tParentApproved })
        ).decision,
        'allow',
      );
    }),

    t.test('harness-subagent-guard.sh isolates slice-builder and staff-gatekeeper across edit tools and run_command', async (t) => {
      const baseDir = makeTempDir('agy-harness-subguard-');
      t.after(() => fs.rmSync(baseDir, { recursive: true, force: true }));

      const subGuard = path.join(ROOT, 'scripts', 'harness-subagent-guard.sh');
      const targetWs = path.join(baseDir, 'target-ws');
      const selfHostWs = path.join(baseDir, 'selfhost-ws');

      for (const d of [targetWs, selfHostWs]) {
        fs.mkdirSync(path.join(d, '.artifacts'), { recursive: true });
        fs.mkdirSync(path.join(d, '.agents'), { recursive: true });
        fs.mkdirSync(path.join(d, 'scripts'), { recursive: true });
        fs.mkdirSync(path.join(d, 'src'), { recursive: true });
      }
      fs.writeFileSync(path.join(selfHostWs, 'plugin.json'), JSON.stringify({ name: 'agy-harness' }) + '\n');
      fs.writeFileSync(path.join(targetWs, 'plugin.json'), JSON.stringify({ name: 'other-app' }) + '\n');

      const call = (role, ws, toolName, toolArgs) =>
        spawnHookAsync(
          subGuard,
          { workspacePaths: [ws], toolCall: { name: toolName, args: toolArgs } },
          { cwd: path.join(ROOT, 'scripts', 'hooks'), args: role ? [`--role=${role}`] : [] },
        );

      const builderCases = await Promise.all([
        // Unknown role defaults to allow
        call('unknown-role', targetWs, 'write_file', { Path: '.artifacts/SPEC.md' }),
        // Normal source edit (including sed_file) & outside-workspace edit allowed
        call('slice-builder', targetWs, 'edit_file', { file_path: 'src/app.js' }),
        call('slice-builder', targetWs, 'sed_file', { File: 'src/app.js' }),
        call('slice-builder', targetWs, 'write_file', { Path: path.join(baseDir, 'outside.txt') }),
        // Contract files unconditionally denied (even in self-hosting agy-harness, including sed_file)
        call('slice-builder', targetWs, 'write_file', { Path: '.artifacts/SPEC.md' }),
        call('slice-builder', targetWs, 'edit_file', { filePath: '.artifacts/CONSTRAINTS.md' }),
        call('slice-builder', targetWs, 'create_file', { target_file: '.artifacts/PLAN.md' }),
        call('slice-builder', targetWs, 'sed_file', { File: '.artifacts/SPEC.md' }),
        call('slice-builder', selfHostWs, 'edit_file', { Path: '.artifacts/SPEC.md' }),
        call('slice-builder', selfHostWs, 'delete_file', { Path: '.artifacts/PLAN.md' }),
        call('slice-builder', targetWs, 'run_command', { CommandLine: 'echo x > .artifacts/SPEC.md' }),
        // Target repo locks .agents/* & scripts/harness-*.sh; self-hosting unlocks them ([GUARDRAIL-1])
        call('slice-builder', targetWs, 'edit_file', { Path: '.agents/hooks.json' }),
        call('slice-builder', targetWs, 'sed_file', { TargetPath: '.agents/hooks.json' }),
        call('slice-builder', targetWs, 'edit_file', { Path: 'scripts/harness-approval-gate.sh' }),
        call('slice-builder', selfHostWs, 'edit_file', { Path: '.agents/rules/agy-harness.md' }),
        call('slice-builder', selfHostWs, 'edit_file', { Path: 'scripts/harness-lifecycle-hook.sh' }),
        // Daemon, >10000ms timeout, and blacklisted commands denied with [HOST_CMD_REQUEST]
        call('slice-builder', targetWs, 'run_command', { CommandLine: 'npm test', IsDaemon: true }),
        call('slice-builder', targetWs, 'run_command', { CommandLine: 'npm test', WaitMsBeforeAsync: 10001 }),
        call('slice-builder', targetWs, 'run_command', { CommandLine: 'docker compose up -d' }),
        call('slice-builder', targetWs, 'run_command', { CommandLine: 'docker-compose ps' }),
        call('slice-builder', targetWs, 'run_command', { CommandLine: 'podman run alpine' }),
        call('slice-builder', targetWs, 'run_command', { CommandLine: 'colima start' }),
        call('slice-builder', targetWs, 'run_command', { CommandLine: 'orbstack status' }),
        call('slice-builder', targetWs, 'run_command', { CommandLine: 'kubectl get pods' }),
        call('slice-builder', targetWs, 'run_command', { CommandLine: 'helm upgrade my-app .' }),
        call('slice-builder', targetWs, 'run_command', { CommandLine: 'kind create cluster' }),
        call('slice-builder', targetWs, 'run_command', { CommandLine: 'minikube start' }),
        call('slice-builder', targetWs, 'run_command', { CommandLine: 'npx testcontainers' }),
        call('slice-builder', targetWs, 'run_command', { CommandLine: 'npm install' }),
        call('slice-builder', targetWs, 'run_command', { CommandLine: 'pnpm add zod' }),
        call('slice-builder', targetWs, 'run_command', { CommandLine: 'yarn i' }),
        call('slice-builder', targetWs, 'run_command', { CommandLine: 'bun ci' }),
        call('slice-builder', targetWs, 'run_command', { CommandLine: 'pip install requests' }),
        call('slice-builder', targetWs, 'run_command', { CommandLine: 'pip3 install pytest' }),
        call('slice-builder', targetWs, 'run_command', { CommandLine: 'uv pip install ruff' }),
        call('slice-builder', targetWs, 'run_command', { CommandLine: 'poetry install' }),
        call('slice-builder', targetWs, 'run_command', { CommandLine: 'go mod tidy' }),
        call('slice-builder', targetWs, 'run_command', { CommandLine: 'flutter pub get' }),
        call('slice-builder', targetWs, 'run_command', { CommandLine: 'pod install' }),
        call('slice-builder', targetWs, 'run_command', { CommandLine: 'vitest --watch' }),
        call('slice-builder', targetWs, 'run_command', { CommandLine: 'tail -f app.log' }),
        call('slice-builder', targetWs, 'run_command', { CommandLine: 'pm2 logs -f' }),
        call('slice-builder', targetWs, 'run_command', { CommandLine: 'bash -it' }),
        // Safe local short commands allowed (including grep mentioning blacklisted words & sed -i on src)
        call('slice-builder', targetWs, 'run_command', { CommandLine: 'CI=true node --test scripts/harness-test.js', WaitMsBeforeAsync: 5000, IsDaemon: false }),
        call('slice-builder', targetWs, 'run_command', { CommandLine: 'rg "docker" agents/' }),
        call('slice-builder', targetWs, 'run_command', { CommandLine: "sed -i '' 's/a/b/' src/a.js" }),
      ]);

      const expectedBuilder = [
        'allow',
        'allow', 'allow', 'allow',
        'deny', 'deny', 'deny', 'deny', 'deny', 'deny', 'deny',
        'deny', 'deny', 'deny', 'allow', 'allow',
        'deny', 'deny', 'deny', 'deny', 'deny', 'deny', 'deny', 'deny', 'deny', 'deny', 'deny', 'deny',
        'deny', 'deny', 'deny', 'deny', 'deny', 'deny', 'deny', 'deny', 'deny', 'deny', 'deny',
        'deny', 'deny', 'deny', 'deny',
        'allow', 'allow', 'allow',
      ];
      assert.equal(builderCases.length, expectedBuilder.length);
      builderCases.forEach((res, idx) => {
        assert.equal(res.decision, expectedBuilder[idx], `Builder case #${idx} mismatch: ${JSON.stringify(res)}`);
        if (idx >= 16 && idx <= 42) {
          assert.match(res.reason, /\[HOST_CMD_REQUEST\]/);
        }
      });

      const gatekeeperCases = await Promise.all([
        call('staff-gatekeeper', targetWs, 'run_command', { CommandLine: 'git status && git --no-pager diff', WaitMsBeforeAsync: 5000, IsDaemon: false }),
        call('staff-gatekeeper', targetWs, 'run_command', { CommandLine: 'git rev-parse --verify HEAD >/dev/null 2>&1' }),
        call('staff-gatekeeper', targetWs, 'run_command', { CommandLine: 'CI=true node --test scripts/harness-test.js' }),
        call('staff-gatekeeper', targetWs, 'sed_file', { File: 'src/app.js' }),
        call('staff-gatekeeper', targetWs, 'run_command', { CommandLine: 'git status', IsDaemon: true }),
        call('staff-gatekeeper', targetWs, 'run_command', { CommandLine: 'git status', WaitMsBeforeAsync: 12000 }),
        call('staff-gatekeeper', targetWs, 'run_command', { CommandLine: 'docker ps' }),
        call('staff-gatekeeper', targetWs, 'run_command', { CommandLine: 'npm install' }),
        call('staff-gatekeeper', targetWs, 'run_command', { CommandLine: 'echo x > src/a.js' }),
        call('staff-gatekeeper', targetWs, 'run_command', { CommandLine: 'echo x > /tmp/out.txt' }),
        call('staff-gatekeeper', targetWs, 'run_command', { CommandLine: "sed -i '' 's/a/b/' src/a.js" }),
        call('staff-gatekeeper', targetWs, 'run_command', { CommandLine: 'rm src/a.js' }),
        call('staff-gatekeeper', targetWs, 'run_command', { CommandLine: 'mv src/a.js src/b.js' }),
        call('staff-gatekeeper', targetWs, 'run_command', { CommandLine: 'cp src/a.js src/b.js' }),
        call('staff-gatekeeper', targetWs, 'run_command', { CommandLine: 'git commit -m "bad"' }),
        call('staff-gatekeeper', targetWs, 'run_command', { CommandLine: 'git push origin main' }),
        call('staff-gatekeeper', targetWs, 'run_command', { CommandLine: 'git reset --hard' }),
        call('staff-gatekeeper', targetWs, 'run_command', { CommandLine: 'git checkout -- src/a.js' }),
        call('staff-gatekeeper', targetWs, 'run_command', { CommandLine: 'git restore src/a.js' }),
        call('staff-gatekeeper', targetWs, 'run_command', { CommandLine: 'git apply fix.patch' }),
        call('staff-gatekeeper', targetWs, 'run_command', { CommandLine: 'git merge feat' }),
        call('staff-gatekeeper', targetWs, 'run_command', { CommandLine: 'git cherry-pick abc123' }),
        call('staff-gatekeeper', targetWs, 'run_command', { CommandLine: 'git am fix.patch' }),
      ]);

      const expectedGatekeeper = [
        'allow', 'allow', 'allow',
        'deny', 'deny', 'deny', 'deny', 'deny', 'deny', 'deny', 'deny', 'deny', 'deny', 'deny',
        'deny', 'deny', 'deny', 'deny', 'deny', 'deny', 'deny', 'deny', 'deny',
      ];
      assert.equal(gatekeeperCases.length, expectedGatekeeper.length);
      gatekeeperCases.forEach((res, idx) => {
        assert.equal(res.decision, expectedGatekeeper[idx], `Gatekeeper case #${idx} mismatch: ${JSON.stringify(res)}`);
      });
    }),

    t.test('Slice 2 Python3 fallback matches Node.js behavior when node is absent from PATH', async (t) => {
      const pyBin = findExecutable('python3');
      assert.ok(pyBin, 'python3 must be available for fallback verification');
      const baseDir = makeTempDir('agy-harness-slice2-py-');
      const noNodeBin = path.join(baseDir, 'bin');
      const stateDir = path.join(baseDir, 'state');
      const wsDir = path.join(baseDir, 'ws');
      const inactiveWs = path.join(baseDir, 'inactive-ws');
      t.after(() => fs.rmSync(baseDir, { recursive: true, force: true }));

      fs.mkdirSync(noNodeBin, { recursive: true });
      fs.mkdirSync(stateDir, { recursive: true });
      fs.mkdirSync(path.join(wsDir, '.artifacts'), { recursive: true });
      fs.mkdirSync(path.join(wsDir, 'scripts'), { recursive: true });
      fs.mkdirSync(path.join(wsDir, 'src'), { recursive: true });
      fs.mkdirSync(path.join(inactiveWs, 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(inactiveWs, 'scripts', 'gate-check.sh'), '#!/bin/bash\nexit 0\n');

      for (const binName of ['bash', 'sh', 'cat', 'dirname', 'git', 'python3']) {
        const resolved = findExecutable(binName);
        if (resolved) fs.symlinkSync(resolved, path.join(noNodeBin, binName));
      }

      fs.writeFileSync(path.join(wsDir, '.artifacts', 'SPEC.md'), '# SPEC\n- **Goal:** Py lifecycle\n- [ ] AC-1: Ok\n');
      fs.writeFileSync(path.join(wsDir, '.artifacts', 'PLAN.md'), '# PLAN\n## Slice 1: One\n- **Status:** `[ ] Pending`\n');
      fs.writeFileSync(path.join(wsDir, 'scripts', 'gate-check.sh'), '#!/bin/bash\nexit 0\n');

      const tParentOk = path.join(baseDir, 't-ok.jsonl');
      fs.writeFileSync(
        tParentOk,
        [
          JSON.stringify({ step_index: 0, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', content: 'SessionStart' }),
          JSON.stringify({
            step_index: 1,
            source: 'USER_EXPLICIT',
            type: 'USER_INPUT',
            created_at: '2099-01-01T00:00:00.000Z',
            content: 'The user has approved this document.',
          }),
        ].join('\n') + '\n',
      );
      const tSub = path.join(baseDir, 't-sub.jsonl');
      fs.writeFileSync(
        tSub,
        JSON.stringify({ step_index: 0, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', content: '[Message] sender=parent' }) + '\n',
      );

      const lifecycleHook = path.join(ROOT, 'scripts', 'harness-lifecycle-hook.sh');
      const subGuard = path.join(ROOT, 'scripts', 'harness-subagent-guard.sh');
      const pyEnv = { PATH: noNodeBin, AGY_HARNESS_STATE_DIR: stateDir };

      const pyPreSub = await spawnHookAsync(
        lifecycleHook,
        { conversationId: 'py-lc', workspacePaths: [wsDir], transcriptPath: tSub, hookEventName: 'PreInvocation' },
        { cwd: wsDir, env: pyEnv },
      );
      const pyPreParent1 = await spawnHookAsync(
        lifecycleHook,
        { conversationId: 'py-lc', workspacePaths: [wsDir], transcriptPath: tParentOk, hookEventName: 'PreInvocation' },
        { cwd: wsDir, env: pyEnv },
      );
      const pyPreParent2 = await spawnHookAsync(
        lifecycleHook,
        { conversationId: 'py-lc', workspacePaths: [wsDir], transcriptPath: tParentOk, hookEventName: 'PreInvocation' },
        { cwd: wsDir, env: pyEnv },
      );
      const pyPreInactive1 = await spawnHookAsync(
        lifecycleHook,
        { conversationId: 'py-lc-in', workspacePaths: [inactiveWs], transcriptPath: tParentOk, hookEventName: 'PreInvocation' },
        { cwd: inactiveWs, env: pyEnv },
      );
      const pyPreInactive2 = await spawnHookAsync(
        lifecycleHook,
        { conversationId: 'py-lc-in', workspacePaths: [inactiveWs], transcriptPath: tParentOk, hookEventName: 'PreInvocation' },
        { cwd: inactiveWs, env: pyEnv },
      );
      // XS-exempt edits in Python3 fallback do NOT arm Stop(continue)
      await Promise.all([
        spawnHookAsync(lifecycleHook, { conversationId: 'py-lc-in', workspacePaths: [inactiveWs], transcriptPath: tParentOk, hookEventName: 'PostToolUse', toolCall: { name: 'edit_file', args: { Path: 'README.md' } } }, { cwd: inactiveWs, env: pyEnv }),
        spawnHookAsync(lifecycleHook, { conversationId: 'py-lc-in', workspacePaths: [inactiveWs], transcriptPath: tParentOk, hookEventName: 'PostToolUse', toolCall: { name: 'edit_file', args: { Path: 'docs/a.md' } } }, { cwd: inactiveWs, env: pyEnv }),
        spawnHookAsync(lifecycleHook, { conversationId: 'py-lc-in', workspacePaths: [inactiveWs], transcriptPath: tParentOk, hookEventName: 'PostToolUse', toolCall: { name: 'edit_file', args: { Path: 'plugin.json' } } }, { cwd: inactiveWs, env: pyEnv }),
        spawnHookAsync(lifecycleHook, { conversationId: 'py-lc-in', workspacePaths: [inactiveWs], transcriptPath: tParentOk, hookEventName: 'PostToolUse', toolCall: { name: 'edit_file', args: { Path: '.claude-plugin/marketplace.json' } } }, { cwd: inactiveWs, env: pyEnv }),
        spawnHookAsync(lifecycleHook, { conversationId: 'py-lc-in', workspacePaths: [inactiveWs], transcriptPath: tParentOk, hookEventName: 'PostToolUse', toolCall: { name: 'edit_file', args: { Path: '.github/CODEOWNERS' } } }, { cwd: inactiveWs, env: pyEnv }),
        spawnHookAsync(lifecycleHook, { conversationId: 'py-lc-in', workspacePaths: [inactiveWs], transcriptPath: tParentOk, hookEventName: 'PostToolUse', toolCall: { name: 'edit_file', args: { Path: 'pnpm-lock.yaml' } } }, { cwd: inactiveWs, env: pyEnv }),
        spawnHookAsync(lifecycleHook, { conversationId: 'py-lc-in', workspacePaths: [inactiveWs], transcriptPath: tParentOk, hookEventName: 'PostToolUse', toolCall: { name: 'edit_file', args: { Path: 'assets/logo.svg' } } }, { cwd: inactiveWs, env: pyEnv }),
        spawnHookAsync(lifecycleHook, { conversationId: 'py-lc-in', workspacePaths: [inactiveWs], transcriptPath: tParentOk, hookEventName: 'PostToolUse', toolCall: { name: 'run_command', args: { CommandLine: "sed -i '' 's/a/b/' README.md" } } }, { cwd: inactiveWs, env: pyEnv }),
      ]);
      const pyStopXsAllow = await spawnHookAsync(
        lifecycleHook,
        { conversationId: 'py-lc-in', workspacePaths: [inactiveWs], transcriptPath: tParentOk, hookEventName: 'Stop', terminationReason: 'NO_TOOL_CALL', fullyIdle: true },
        { cwd: inactiveWs, env: pyEnv },
      );

      // Non-exempt paths & sed_file & !rawTarget DO arm Stop(continue) in Python3 fallback
      const pyNonExemptPayloads = [
        { name: 'edit_file', args: { Path: 'src/a.js' } },
        { name: 'edit_file', args: { Path: 'hooks.json' } },
        { name: 'edit_file', args: { Path: 'package.json' } },
        { name: 'edit_file', args: { Path: 'agents/slice-builder.md' } },
        { name: 'edit_file', args: { Path: 'skills/foo/SKILL.md' } },
        { name: 'edit_file', args: { Path: 'evals/cases/a.json' } },
        { name: 'sed_file', args: { TargetPath: 'src/a.js' } },
        { name: 'edit_file', args: {} },
        { name: 'run_command', args: { CommandLine: 'echo hi > src/a.js' } },
      ];
      await Promise.all(
        pyNonExemptPayloads.map(async (tc, idx) => {
          const pyNeWs = path.join(baseDir, `py-ne-${idx}`);
          fs.mkdirSync(path.join(pyNeWs, 'scripts'), { recursive: true });
          fs.writeFileSync(path.join(pyNeWs, 'scripts', 'gate-check.sh'), '#!/bin/bash\nexit 0\n');
          await spawnHookAsync(
            lifecycleHook,
            { conversationId: `py-ne-${idx}`, workspacePaths: [pyNeWs], transcriptPath: tParentOk, hookEventName: 'PostToolUse', toolCall: tc },
            { cwd: pyNeWs, env: pyEnv },
          );
          const s1 = await spawnHookAsync(
            lifecycleHook,
            { conversationId: `py-ne-${idx}`, workspacePaths: [pyNeWs], transcriptPath: tParentOk, hookEventName: 'Stop', terminationReason: 'NO_TOOL_CALL', fullyIdle: true },
            { cwd: pyNeWs, env: pyEnv },
          );
          assert.equal(s1.decision, 'continue', `Python3 non-exempt payload #${idx} must arm Stop(continue)`);
        }),
      );

      await spawnHookAsync(
        lifecycleHook,
        {
          conversationId: 'py-lc',
          workspacePaths: [wsDir],
          transcriptPath: tSub,
          hookEventName: 'PostToolUse',
          toolCall: { name: 'edit_file', args: { Path: 'src/a.js' } },
        },
        { cwd: wsDir, env: pyEnv },
      );
      const pyStopContinue = await spawnHookAsync(
        lifecycleHook,
        {
          conversationId: 'py-lc',
          workspacePaths: [wsDir],
          transcriptPath: tParentOk,
          hookEventName: 'Stop',
          terminationReason: 'NO_TOOL_CALL',
          fullyIdle: true,
        },
        { cwd: wsDir, env: pyEnv },
      );
      const pyStopLoop = await spawnHookAsync(
        lifecycleHook,
        {
          conversationId: 'py-lc',
          workspacePaths: [wsDir],
          transcriptPath: tParentOk,
          hookEventName: 'Stop',
          terminationReason: 'NO_TOOL_CALL',
          fullyIdle: true,
          continuationActive: true,
        },
        { cwd: wsDir, env: pyEnv },
      );
      await spawnHookAsync(
        lifecycleHook,
        {
          conversationId: 'py-lc',
          workspacePaths: [wsDir],
          transcriptPath: tParentOk,
          hookEventName: 'PostToolUse',
          toolCall: { name: 'run_command', args: { CommandLine: 'bash scripts/gate-check.sh' } },
        },
        { cwd: wsDir, env: pyEnv },
      );
      const pyStopAllow = await spawnHookAsync(
        lifecycleHook,
        {
          conversationId: 'py-lc',
          workspacePaths: [wsDir],
          transcriptPath: tParentOk,
          hookEventName: 'Stop',
          terminationReason: 'NO_TOOL_CALL',
          fullyIdle: true,
        },
        { cwd: wsDir, env: pyEnv },
      );

      const [pyBuilderContract, pyBuilderSedContract, pyBuilderDocker, pyBuilderSrc, pyGkMutate, pyGkSed, pyGkRead] = await Promise.all([
        spawnHookAsync(
          subGuard,
          { workspacePaths: [wsDir], toolCall: { name: 'write_file', args: { Path: '.artifacts/SPEC.md' } } },
          { cwd: wsDir, env: pyEnv, args: ['--role=slice-builder'] },
        ),
        spawnHookAsync(
          subGuard,
          { workspacePaths: [wsDir], toolCall: { name: 'sed_file', args: { File: '.artifacts/SPEC.md' } } },
          { cwd: wsDir, env: pyEnv, args: ['--role=slice-builder'] },
        ),
        spawnHookAsync(
          subGuard,
          { workspacePaths: [wsDir], toolCall: { name: 'run_command', args: { CommandLine: 'docker ps' } } },
          { cwd: wsDir, env: pyEnv, args: ['--role=slice-builder'] },
        ),
        spawnHookAsync(
          subGuard,
          { workspacePaths: [wsDir], toolCall: { name: 'edit_file', args: { file_path: 'src/a.js' } } },
          { cwd: wsDir, env: pyEnv, args: ['--role=slice-builder'] },
        ),
        spawnHookAsync(
          subGuard,
          { workspacePaths: [wsDir], toolCall: { name: 'run_command', args: { CommandLine: 'git commit -m x' } } },
          { cwd: wsDir, env: pyEnv, args: ['--role=staff-gatekeeper'] },
        ),
        spawnHookAsync(
          subGuard,
          { workspacePaths: [wsDir], toolCall: { name: 'sed_file', args: { TargetPath: 'src/a.js' } } },
          { cwd: wsDir, env: pyEnv, args: ['--role=staff-gatekeeper'] },
        ),
        spawnHookAsync(
          subGuard,
          { workspacePaths: [wsDir], toolCall: { name: 'run_command', args: { CommandLine: 'git status' } } },
          { cwd: wsDir, env: pyEnv, args: ['--role=staff-gatekeeper'] },
        ),
      ]);

      assert.deepEqual(pyPreSub, {});
      assert.equal(pyPreParent1.injectSteps.length, 1);
      assert.deepEqual(pyPreParent2, {});
      assert.equal(pyPreInactive1.injectSteps.length, 1);
      assert.match(pyPreInactive1.injectSteps[0].systemMessage.systemMessage, /State: INACTIVE/);
      assert.match(pyPreInactive1.injectSteps[0].systemMessage.systemMessage, /Tier XS/);
      assert.deepEqual(pyPreInactive2, {});
      assert.equal(pyStopXsAllow.decision, 'allow');
      assert.equal(pyStopContinue.decision, 'continue');
      assert.equal(pyStopLoop.decision, 'allow');
      assert.equal(pyStopAllow.decision, 'allow');
      assert.equal(pyBuilderContract.decision, 'deny');
      assert.equal(pyBuilderSedContract.decision, 'deny');
      assert.equal(pyBuilderDocker.decision, 'deny');
      assert.equal(pyBuilderSrc.decision, 'allow');
      assert.equal(pyGkMutate.decision, 'deny');
      assert.equal(pyGkSed.decision, 'deny');
      assert.equal(pyGkRead.decision, 'allow');
    }),
  ]);
});

test('Slice 3 slim rules, Orchestrator/CRG coexistence, skill docs, and evals parity', () => {
  const activeRulePath = path.join(ROOT, '.agents', 'rules', 'agy-harness.md');
  const tplRulePath = path.join(ROOT, 'skills', 'harness-init', 'references', 'harness-rule-template.md');
  const activeRule = fs.readFileSync(activeRulePath, 'utf8');
  const tplRule = fs.readFileSync(tplRulePath, 'utf8');

  assert.equal(activeRule, tplRule, '.agents/rules/agy-harness.md must be byte-identical to harness-rule-template.md');
  const byteLen = Buffer.byteLength(activeRule, 'utf8');
  assert.ok(byteLen <= 3500, `Coordinator rule must stay <= 3500 bytes (hard cap 4096B), got ${byteLen}B`);
  assert.match(activeRule, /^---\r?\ntrigger:\s*always_on\r?\n---/);

  // Orchestrator / Plan Mode compatibility
  assert.match(activeRule, /Plan Mode/i);
  assert.match(activeRule, /exit_plan_mode/);
  assert.match(activeRule, /RequestFeedback:\s*true/);
  assert.match(activeRule, /Proceed/);

  // Alignment-First Proceed, Contract-Only Re-Confirmation, and Auto-Archive
  assert.match(activeRule, /确认需求与(?:核心)?方案完全符合/);
  assert.match(activeRule, /Contract-Only Re-Confirmation/i);
  assert.match(activeRule, /Implementation Notes \/ Guardrails/);
  assert.match(activeRule, /<!-- non-contract -->/);
  assert.match(activeRule, /HARNESS_STATUS:\s*ARCHIVED/);
  assert.match(activeRule, /\[x\]/);

  // CRG coexistence (no absolute ban; allow CRG when .agents/rules/crg.md is enabled)
  assert.doesNotMatch(activeRule, /严禁调用 CRG/);
  assert.match(activeRule, /read_file/);
  assert.match(activeRule, /\.agents\/rules\/crg\.md/);

  // 5-tier (XS / S / M / L / XL) routing, hard disqualifiers, Tier S root-cause + TDD, & Software 1.0 backing
  for (const pat of [
    /\(XS\s*\/\s*S\s*\/\s*M\s*\/\s*L\s*\/\s*XL\)/,
    /Tier XS/,
    /Tier S/,
    /Tier M/,
    /Tier L/,
    /Tier XL/,
    /XS\s*->\s*S/,
    /S\s*->\s*M/,
    /agy-harness:debugging-and-error-recovery/,
    /agy-harness:test-driven-development/,
    /RED\s*->\s*GREEN/,
    /\bStop\b/,
    /`<= 3` 个文件/,
    /150/,
    /弹性 `slice-builder`/,
    /arch-redteam/,
    /4 合 1 `staff-gatekeeper`/,
    /Workspace:\s*"share"/,
    /\bswarm\b/,
    /send_message\(Recipient:/,
    /conversationId/,
    /manage_subagents\(Action="kill"/,
    /manage_subagents\(Action="list"\)/,
    /\[HOST_CMD_REQUEST\]/,
    /`cwd`/,
    /<=\s*50/,
    /Max Retries\s*=\s*2/i,
    /hooks\.json/,
    /harness-approval-gate\.sh/,
    /harness-source-edit-guard\.sh/,
    /harness-lifecycle-hook\.sh/,
    /harness-subagent-guard\.sh/,
    /scripts\/gate-check\.sh/,
  ]) {
    assert.match(activeRule, pat, `Slim coordinator rule missing pattern ${pat}`);
  }

  // .artifacts/ templates parity (5-tier SPEC + CRG-coexistent Context Brief)
  const specTpl = fs.readFileSync(path.join(ROOT, 'skills', 'harness-init', 'references', 'spec-template.md'), 'utf8');
  const briefTpl = fs.readFileSync(path.join(ROOT, 'skills', 'harness-init', 'references', 'context-brief-template.md'), 'utf8');
  assert.match(specTpl, /^- \*\*Goal:\*\* _Describe the concrete user or system problem being solved\._$/m);
  assert.match(specTpl, /^- \*\*Tier Classification:\*\* `Tier M \| Tier L \| Tier XL \(escalated Tier S optional\)`$/m);
  assert.doesNotMatch(briefTpl, /Zero CRG/i);
  assert.match(briefTpl, /\.agents\/rules\/crg\.md/);

  // harness-init SKILL.md, docs, READMEs, and evals parity
  const skillMd = fs.readFileSync(path.join(ROOT, 'skills', 'harness-init', 'SKILL.md'), 'utf8');
  for (const requiredRef of [
    'harness-lifecycle-hook.sh',
    'harness-subagent-guard.sh',
    'scripts/hooks/slice-builder.hooks.json',
    'scripts/hooks/staff-gatekeeper.hooks.json',
    'hooks.json',
    '../../scripts/hooks/',
    'Tier XS',
    'Tier S',
    'Tier M',
    'Tier L',
    'Tier XL',
    'isTierXsExemptPath',
    'sed_file',
    '<= 3.5 KB',
  ]) {
    assert.ok(skillMd.includes(requiredRef), `skills/harness-init/SKILL.md must mention '${requiredRef}'`);
  }

  const coordBytesFormatted = byteLen.toLocaleString('en-US');
  const pluginRuleBytesFormatted = Buffer.byteLength(
    fs.readFileSync(path.join(ROOT, 'rules', 'AGENTS.md'), 'utf8'),
    'utf8',
  ).toLocaleString('en-US');

  for (const docRel of ['docs/antigravity-setup.md', 'docs/agents.md', 'README.md', 'README.zh.md']) {
    const docText = fs.readFileSync(path.join(ROOT, docRel), 'utf8');
    for (const token of ['Tier XS', 'Tier S', 'Tier M', 'Tier L', 'Tier XL', 'isTierXsExemptPath', 'sed_file']) {
      assert.ok(docText.includes(token), `${docRel} must document '${token}'`);
    }
    assert.ok(
      docText.includes(`${coordBytesFormatted} B`),
      `${docRel} must report exact coordinator rule size (${coordBytesFormatted} B)`,
    );
    if (docRel.startsWith('docs/')) {
      assert.ok(
        docText.includes(`${pluginRuleBytesFormatted} B`),
        `${docRel} must report exact plugin rule size (${pluginRuleBytesFormatted} B)`,
      );
    }
    assert.match(docText, /exit_plan_mode|>= 5/);
  }
  assert.match(fs.readFileSync(path.join(ROOT, 'docs', 'antigravity-setup.md'), 'utf8'), />=\s*5/);
  assert.match(fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8'), />=\s*5/);
  assert.match(fs.readFileSync(path.join(ROOT, 'README.zh.md'), 'utf8'), />=\s*5/);

  const evalCase = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals', 'cases', 'harness-init.json'), 'utf8'));
  const evalBlob = JSON.stringify(evalCase.evals || []);
  for (const requiredRef of ['harness-lifecycle-hook.sh', 'harness-subagent-guard.sh', 'scripts/hooks/']) {
    assert.ok(evalBlob.includes(requiredRef), `evals/cases/harness-init.json must reference '${requiredRef}'`);
  }
});
