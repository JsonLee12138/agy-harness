<p align="center">
  <img src="assets/logo.svg" width="128" height="128" alt="AGY Harness Logo" />
</p>

<h1 align="center">AGY Harness</h1>

<p align="center">
  <a href="README.md">English</a> | <b>简体中文</b>
</p>

<p align="center">
  <a href="https://github.com/JsonLee12138/agy-harness/releases/tag/v0.1.0"><img src="https://img.shields.io/badge/release-v0.1.0-blue.svg" alt="Release v0.1.0" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green.svg" alt="License: MIT" /></a>
  <a href="https://github.com/JsonLee12138/agy-harness"><img src="https://img.shields.io/badge/Google%20Antigravity-ready-8A2BE2.svg" alt="Google Antigravity" /></a>
  <a href="https://github.com/JsonLee12138/agy-harness"><img src="https://img.shields.io/badge/Claude%20Code-compatible-orange.svg" alt="Claude Code" /></a>
  <a href="https://github.com/JsonLee12138/agy-harness"><img src="https://img.shields.io/badge/Codex-ready-000000.svg" alt="Codex" /></a>
</p>

**面向 Google Antigravity (`agy`)、Claude Code、Codex 及现代多智能体编程环境的预算受控与“生成-证伪”工程脚手架。**

底层搭载 25 个原汁原味、零侵入的上游 [Addy Osmani Agent Skills](https://github.com/addyosmani/agent-skills)，结合一键脚手架注入技能 `/agy-harness:harness-init`。

> [!IMPORTANT]
> **独立版本发布说明**：`agy-harness` 从 **`v0.1.0`** 正式起步。为了避免与上游 `agent-skills` 的 `0.6.x` 版本混淆，本项目采用完全独立的语义化版本体系，专注演进 Antigravity 脚手架调度、磁盘契约与代码门禁。

---

## 为什么需要 AGY Harness？

在没有严格约束的情况下，AI 编码智能体往往倾向于“走阻力最小的捷径”：单轮提示直接暴走写代码、跳过需求规格与边界分析、缺少测试、并在已经被污染的单一会话上下文中“自己审查自己的幻觉代码”，导致严重的质量滑坡与 Token 浪费。

`agy-harness` 将随意散漫的生成式会话，彻底重构为严密的 **磁盘单一事实来源（Disk SSoT: `.artifacts/`） + Software 1.0 确定性门禁（`scripts/gate-check.sh`） + 物理隔离的空白上下文子代理（Subagents）** 确定性状态机：

- **一键脚手架注入 (`/agy-harness:harness-init`) + 插件根 `hooks.json` 全局兜底**：注入瘦身至 **`3,484 B`（`<= 3.5 KB`）** 的协调者规则 `.agents/rules/agy-harness.md`（远低于 AGY `20,000` Token 的 `defaultRulesBudget`，避免降级为路径指针）、三组钩子 [`.agents/hooks.json`](.agents/hooks.json)、`scripts/gate-check.sh` 与本地契约 `.artifacts/{context-brief,SPEC,CONSTRAINTS,PLAN}.md`；插件根 [`hooks.json`](hooks.json)（`--plugin-mode`）对未初始化仓库保持零侵入放行，并在工作区已注册 `harness-lifecycle-guard` 时自动让渡防重复注入。
- **三组物理门禁与 Orchestrator Plan Mode 适配**：`harness-contract-approval-gate` 仅白名单放行只读子代理并拦截 `define_subagent`/`run_workflow`/`swarm(add)` 与必要场景的 `exit_plan_mode`（无契约计划仅在未停轮且涉及 `>= 5` 个非 `isTierXsExemptPath` 代码路径或 `Tier M/L/XL` 时提示确认）；`harness-parent-source-edit-guard` 补齐 `sed_file` 匹配、`INACTIVE` 状态立即解锁脏工作树（不再因 `git status` 累计锁定 `XS/S`），并在契约激活时通过 2 条确定性规则识别 `isParent` 及拦截 `run_command` Shell 写绕过；`harness-lifecycle-guard` 提供 `PreInvocation` 去重 5 级分流提示（`INACTIVE_ROUTING_5TIER`）、`PostToolUse` 门禁追踪与基于 `isTierXsExemptPath` 的差异化 `Stop` 强收口校验。
- **先对齐后校验、自动归档解禁 `Tier XS` / `Tier S`**：Tier M/L/XL 默认先对齐并确认 **1 次 `Proceed`**，高风险触发 `arch-redteam` 后即刻 `kill`；进度勾选与 `## Implementation Notes / Guardrails` 免重锁；出现 `<!-- HARNESS_STATUS: ARCHIVED -->`/`DONE` 或 `SPEC.md` + `PLAN.md` 全部 `[x]` 时自动归档并释放后续 `Tier XS` / `Tier S` 任务。
- **独立命名空间 `agy-harness:*` 与上游无缝同步**：完整保留上游 25 个生命周期技能，不改动任何一行上游逻辑，安装后禁用原版 `agent-skills` 即可消除重复 Token 开销。
- **3 大精简隔离子代理（`model: inherit`, `mcpServers: []`）**：补齐新版 canonical 工具名（`read_file`、`write_file`、`edit_file`、`create_file`）与只读隔离；挂载 Agent Frontmatter `hooks:`（[`slice-builder.hooks.json`](scripts/hooks/slice-builder.hooks.json) 与 [`staff-gatekeeper.hooks.json`](scripts/hooks/staff-gatekeeper.hooks.json) -> [`harness-subagent-guard.sh`](scripts/harness-subagent-guard.sh)）；默认原生直读且与 `.agents/rules/crg.md` 共存；按 Slice 闭环 `send_message` 原地复用后 `kill` 清场。
- **五级（`Tier XS / S / M / L / XL`）认知×影响面路由**：从零契约 `Tier XS` 确定性杂务（豁免 `Stop` 全量 `gate-check.sh`）与“先查根因 + `RED -> GREEN` TDD”的 `Tier S` 局部修复，平滑扩展至多工作区并行切片开发（`Tier XL`）。

```
  定义 (DEFINE)     规划 (PLAN)     构建 (BUILD)    验证 (VERIFY)   评审 (REVIEW)    发布 (SHIP)
 ┌──────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌────────────┐
 │  需求深挖    │─▶│  规格契约   │─▶│  TDD 施工   │─▶│  门禁自检   │─▶│  四合一评审 │─▶│  生产发布  │
 │ interview-me │  │  SPEC/PLAN  │  │slice-builder│  │ gate-check  │  │gatekeeper/QA│  │   上线     │
 └──────────────┘  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘  └────────────┘
     /spec             /plan            /build           /test           /review          /ship
```

完整 Antigravity 安装架构、原生 `Permissions` 分层治理、`agy plugin validate` 说明与黄金评测指南，请参阅 **[docs/antigravity-setup.md](docs/antigravity-setup.md)** 与 **[docs/agents.md](docs/agents.md)**。

---

## 快速上手

### 1. 安装 `agy-harness` 插件

<details open>
<summary><b>Google Antigravity (CLI, IDE & 2.0) —— 官方推荐宿主</b></summary>

直接从 GitHub 远程仓库安装：

```bash
agy plugin install https://github.com/JsonLee12138/agy-harness.git
```

或从本地克隆目录安装：

```bash
git clone https://github.com/JsonLee12138/agy-harness.git
agy plugin install ./agy-harness
```

> [!TIP]
> **排重优化建议**：由于 `agy-harness` 已经完整内置了上游 25 个技能，如果您之前安装过原版 `agent-skills`，建议将其禁用，以避免会话首轮由于技能清单重复累加带来约 2.5K Token 的不必要前缀开销：
> ```bash
> agy plugin disable agent-skills
> ```

</details>

<details>
<summary><b>Claude Code</b></summary>

**通过市场源安装：**

```bash
/plugin marketplace add JsonLee12138/agy-harness
/plugin install agy-harness@agy-harness
```

**本地开发加载：**

```bash
git clone https://github.com/JsonLee12138/agy-harness.git
claude --plugin-dir /path/to/agy-harness
```

</details>

<details>
<summary><b>Codex</b></summary>

作为 Codex 原生插件安装（Codex CLI v0.122+）：

```bash
codex plugin marketplace add JsonLee12138/agy-harness
codex plugin add agy-harness@agy-harness
```

Codex 通过 `.codex-plugin/plugin.json` 自动解析根目录的 `skills/`。在对话中使用 `@` 即可唤起（例如 `@spec-driven-development`）。

</details>

<details>
<summary><b>Skills CLI（支持 70+ 种 AI 编程工具）</b></summary>

使用开源 [skills CLI](https://github.com/vercel-labs/skills)：

```bash
npx skills add JsonLee12138/agy-harness            # 安装全部技能
npx skills add JsonLee12138/agy-harness --list     # 安装前查看列表
```

</details>

<details>
<summary><b>Cursor、Windsurf 及其他环境</b></summary>

- **Cursor**：将技能文件放入 `.cursor/skills/`（从 `skills/` 同步）。详见 [docs/cursor-setup.md](docs/cursor-setup.md)。
- **Windsurf**：将核心规范加入规则配置。详见 [docs/windsurf-setup.md](docs/windsurf-setup.md)。
- **Gemini CLI**：执行 `gemini skills install https://github.com/JsonLee12138/agy-harness.git --path skills`。详见 [docs/gemini-cli-setup.md](docs/gemini-cli-setup.md)。
- **OpenCode**：复制技能目录至 `.opencode/skills/`。详见 [docs/opencode-setup.md](docs/opencode-setup.md)。
- **GitHub Copilot**：将子代理规范添加至 `.github/agents/`。详见 [docs/copilot-setup.md](docs/copilot-setup.md)。

</details>

---

### 2. 在目标代码仓库中初始化脚手架

在你要开发的任何代码仓库中，只需在 Antigravity 聊天窗口中执行：

```text
/agy-harness:harness-init
```

或者直接在终端中运行初始化脚本：

```bash
# 全局已安装 agy-harness 插件时：
bash ~/.gemini/config/plugins/agy-harness/scripts/init-harness.sh /path/to/your-project

# 或使用包含独立本地子代理的模式（自动将 .agents/agents/*.md 中的 ../scripts/hooks/ 改写为 ../../scripts/hooks/）：
bash /path/to/agy-harness/scripts/init-harness.sh /path/to/your-project --with-local-agents
```

该命令将在目标工程自动生成并原地升级以下基础设施（再次执行无需 `--force` 即可更新规则、全部钩子脚本与本地代理，同时保留既有 `.artifacts/` 契约与自定义 `gate-check.sh`）：
1. `.agents/rules/agy-harness.md`（`3,484 B`，`<= 3.5 KB` / 上限 `4,096 B`）— 瘦身版 `trigger: always_on` 协调者规则，涵盖五级（`Tier XS` / `Tier S` / `Tier M` / `Tier L` / `Tier XL`）路由、Orchestrator Plan Mode（`exit_plan_mode`）协同、CRG 共存（默认原生直读；开启 `.agents/rules/crg.md` 时按规则启用）、自动归档解禁与 `Proceed` 检查点；
2. `.agents/hooks.json` + `scripts/harness-{approval-gate,source-edit-guard,lifecycle-hook,subagent-guard}.sh` + `scripts/hooks/{slice-builder,staff-gatekeeper}.hooks.json` — 完整三组 Software 1.0 生命周期与物理隔离守卫（覆盖 `sed_file` 匹配、`INACTIVE` 脏树解禁与 `isTierXsExemptPath` 差异化 `Stop` 门禁，无全局插件的离线仓库亦与根 `hooks.json` 同等生效）；
3. `scripts/gate-check.sh` — Software 1.0 零 Token 确定性质量门禁；
4. `.artifacts/{context-brief,SPEC,CONSTRAINTS,PLAN}.md` — 磁盘单一事实契约模板（自动加入 `.gitignore`，不污染代码历史与门禁统计）。

> [!TIP]
> - **原生 `Permissions` 与 Hooks 分层治理**：建议将 AGY 原生静态 `Permissions`（`Deny > Ask > Allow`，如禁止读写 `.env*` 凭据文件、拦截 `git push --force`）与 `agy-harness` 动态 Hooks（`.artifacts/` 契约状态、`INACTIVE` 脏树解禁配合 `isTierXsExemptPath` `Stop` 差异化门禁、`PreInvocation` 5 级分流及子代理隔离）搭配使用。
> - **`agy plugin validate .` 说明**：校验以 **`0` errors** 通过（`skills 26 · agents 3 · rules 1 · hooks 3 · mcpServers 0 · sidecars 0`）；根目录 `AGENTS.md` 与 `commands/` 会触发 2 条已知多宿主提示警告，因需保持对 Claude Code / Gemini CLI / Codex / OpenCode 及 CI `validate-commands.js` 的兼容而刻意保留。

---

## 五级任务预算路由体系 (`Tier XS / S / M / L / XL`)

为了兼顾开发效率、认知边界与推理成本，`agy-harness` 预设了五级预算与路由矩阵：

| 任务等级 (Tier) | 适用范围与强升级红线 | 执行流水线与人类检查点 | 预估 Token 消耗倍数 |
|----------------|---------------------|----------------------|--------------------|
| **Tier XS** | 确定性微操作：文档/注释、版本与插件清单（`plugin.json`/`marketplace.json`/`VERSION`）、锁文件、仓库元数据（`CODEOWNERS`/`LICENSE`/`.gitignore`）、静态媒体字体、格式与字面微调（不限文件数；**红线 `XS -> S`**：触及可执行控制流、正则、`agents/`/`skills/`/`commands/` 或报错排障严禁定级 `XS`） | 直接编辑 -> 轻量校验（0 `.artifacts/`、0 人类确认、0 子代理；`isTierXsExemptPath` 豁免 `Stop` 全量 `gate-check.sh` 死循环） | **0.8x - 1.0x** |
| **Tier S** | 局部 Bug 修复或小逻辑：`<= 3` 文件（含测试）、`<= 150` 行、外契约不变（`.artifacts/` 未激活或已归档/全 `[x]`；**红线 `S -> M`**：`> 3` 源码文件、改公共 API 或方案二选一分歧时升 `Tier M`） | **先查根因**（`agy-harness:debugging-and-error-recovery`）-> 原位 TDD（`agy-harness:test-driven-development`：复现红灯 `RED -> GREEN`）-> `Stop` 钩子强保运行全量 `scripts/gate-check.sh` -> 交付（0 `.artifacts/`，0 子代理，0 确认） | **1.0x**（基准） |
| **Tier M** | 常规跨文件特性开发或业务逻辑重构 | 原生直读（若启用 `.agents/rules/crg.md` 则兼容 CRG）-> **人类点击 `Proceed` #1（确认需求与方案一致）** -> 内聚 `slice-builder`（`send_message` 原地闭环）-> 运行 `gate-check.sh` -> 大改动按需唤醒 4 合 1 `staff-gatekeeper` -> `kill` 清场 | **1.3x - 1.6x** |
| **Tier L** | 核心架构重构、公共 API 变更、涉及鉴权/支付等高危路径 | 原生直读（兼容 CRG 共存）-> **人类点击 `Proceed` #1（确认需求与方案一致）** -> `arch-redteam` 校验（落地后立即 `kill`；仅 `[BLOCKER]` 二次确认）-> 按 Slice 闭环（`slice-builder` -> `gate-check.sh` -> 4 合 1 `staff-gatekeeper` -> `GO` 后 `kill`） | **2.0x - 2.4x** |
| **Tier XL** | 包含 >= 3 个独立且互不干涉模块的大型史诗任务 | 原生直读（兼容 CRG 共存）-> **人类 `Proceed` #1（确认需求与模块边界）** -> `arch-redteam` 校验（后立即 `kill`）-> 并行 `slice-builder`（`Workspace: "share"`）-> 运行 `gate-check.sh` -> 4 合 1 `staff-gatekeeper` 验收 -> `kill` 清场 | **2.0x - 2.8x** |

---

## 三大精简核心隔离子代理 (Harness Subagents)

全员采用 **`model: inherit` + `mcpServers: []`**，补齐新版 canonical 工具名（`read_file`、`write_file`、`edit_file`、`create_file`）并保留旧别名，按“单个 Slice 闭环常驻复用 → 彻底 `GO` 后清场销毁”运行：

| 子代理 | 模型与 MCP | 工具权限、Frontmatter `hooks:` 与隔离机制 | 职责与产出物 |
|--------|------------|----------------------------------------|--------------|
| [arch-redteam](agents/arch-redteam.md) | `inherit` (`mcpServers: []`) | 只读工具集（`read_file` 及旧只读别名；无任何写工具，`policy: off`） | 架构与方案红队审校官。在方案对齐后执行对抗校验，拦截过度设计与隐含假设，落地后即被 `kill` |
| [slice-builder](agents/slice-builder.md) | `inherit` (`mcpServers: []`) | 完整读写沙箱（`read_file`、`write_file`、`edit_file`、`create_file` + 旧别名，`policy: sandbox`）+ [`slice-builder.hooks.json`](scripts/hooks/slice-builder.hooks.json) | 垂直切片 TDD 施工员；通过 [`harness-subagent-guard.sh`](scripts/harness-subagent-guard.sh) 物理锁死 `.artifacts/{SPEC,CONSTRAINTS,PLAN}.md`（目标仓库同时锁 `.agents/*` 与 `scripts/harness-*.sh`，仅当根目录 `plugin.json` `name: "agy-harness"` 时豁免自宿主施工）并拦截黑名单/守护/慢速命令 |
| [staff-gatekeeper](agents/staff-gatekeeper.md) | `inherit` (`mcpServers: []`) | 只读工具集（`read_file`、旧只读别名、`run_command`，无写工具，`policy: sandbox`）+ [`staff-gatekeeper.hooks.json`](scripts/hooks/staff-gatekeeper.hooks.json) | **4 合 1** 统一门禁审校官：一次性完成五轴质量审查、复杂度修剪、假测试变异检查及安全/性能风险审计；`run_command` 物理限定为短时只读命令 |

> 注：原版单维度 Persona 以及合并下线的历史角色（[`repo-scout`](docs/legacy-personas/repo-scout.md)、[`risk-specialist`](docs/legacy-personas/risk-specialist.md) 等）已归档至 [docs/legacy-personas/](docs/legacy-personas/)，使 Antigravity `/agents` 列表严格聚焦于上述 3 大核心角色。

---

## 26 个专业工程技能全览 (Skills)

包含完整的 25 个上游生命周期技能，加上 1 个脚手架注入技能 `harness-init`：

### 元认知与脚手架注入 (Meta & Bootstrap)

| 技能名称 | 功能概述 | 适用场景 |
|---------|---------|----------|
| [harness-init](skills/harness-init/SKILL.md) | 注入 `.agents/rules/agy-harness.md`、审批门禁、`gate-check.sh` 和 `.artifacts/` 契约模板 | 初始化目标工程（`/agy-harness:harness-init`） |
| [using-agent-skills](skills/using-agent-skills/SKILL.md) | 意图识别与技能映射，维护通用的工程准则 | 会话启动或判断当前任务适用何种流程 |

### 定义阶段 (Define) — 明确要做什么

| 技能名称 | 功能概述 | 适用场景 |
|---------|---------|----------|
| [interview-me](skills/interview-me/SKILL.md) | 单次单问的苏格拉底式提问，挖掘真实诉求直至 ~95% 置信度 | 需求模糊、缺少细节，或用户明确要求“盘问我/拷问我” |
| [idea-refine](skills/idea-refine/SKILL.md) | 发散/收敛结构化思考，将粗糙想法提炼为切实可行的方案 | 处于概念初期需要发散探索与收敛论证 |
| [spec-driven-development](skills/spec-driven-development/SKILL.md) | 在写代码前撰写包含目标、接口、测试策略的 PRD 规范 | 新项目开工、重大特性开发或跨模块调整 |
| [constraint-driven-development](skills/constraint-driven-development/SKILL.md) | 将质量门槛写入 `CONSTRAINTS.md`，杜绝 Agent 擅自压低标准 | 建立质量基线，防止 Agent 逃避测试或滥用跳过注释 |

### 规划阶段 (Plan) — 任务拆解与契约

| 技能名称 | 功能概述 | 适用场景 |
|---------|---------|----------|
| [planning-and-task-breakdown](skills/planning-and-task-breakdown/SKILL.md) | 将 PRD 规格拆解为带验收标准的原子切片任务并理顺依赖顺序 | 规格已确立，需要拆解为细粒度可执行工单 |

### 构建阶段 (Build) — 规范实施

| 技能名称 | 功能概述 | 适用场景 |
|---------|---------|----------|
| [incremental-implementation](skills/incremental-implementation/SKILL.md) | 极细垂直切片交付：实现、测试、验证、提交，保持变更易回滚 | 涉及跨多个文件的任何修改 |
| [test-driven-development](skills/test-driven-development/SKILL.md) | 红绿重构循环、测试金字塔、Beyonce 准则、确定性单元测试 | 编写业务逻辑、修复 Bug 或调整既有行为 |
| [context-engineering](skills/context-engineering/SKILL.md) | 上下文卫生学管理，修剪 Prompt 冗余与提升有效载荷信噪比 | 会话开启、任务切换或输出质量劣化时 |
| [source-driven-development](skills/source-driven-development/SKILL.md) | 坚持以权威官方文档为基准并注明引用来源，消除模型过时幻觉 | 依赖外部三方库或新版框架进行架构设计时 |
| [doubt-driven-development](skills/doubt-driven-development/SKILL.md) | 空白上下文对抗审校关键决策（声明->提取->质疑->调和） | 高风险操作（鉴权改动、数据迁移、不可逆变更） |
| [frontend-ui-engineering](skills/frontend-ui-engineering/SKILL.md) | 组件解耦设计、响应式布局、状态机流转、WCAG 2.1 AA 无障碍支持 | 前端交互、页面构建与设计系统实现 |
| [api-and-interface-design](skills/api-and-interface-design/SKILL.md) | 契约优先接口设计、Hyrum 定律防御、严格边界校验与版本兼容 | 设计 RESTful/GraphQL 接口、公共 SDK 或跨模块边界 |

### 验证阶段 (Verify) — 拿证据证明可用

| 技能名称 | 功能概述 | 适用场景 |
|---------|---------|----------|
| [browser-testing-with-devtools](skills/browser-testing-with-devtools/SKILL.md) | 结合 Chrome DevTools MCP 进行实时运行时排查（DOM、网络、控制台、CWV） | 构建或调试需要在浏览器中运行的 Web 应用 |
| [debugging-and-error-recovery](skills/debugging-and-error-recovery/SKILL.md) | 五步系统排错：复现、定位、精简、修复、守卫，严格拒绝猜测修复 | 测试红灯、构建报错或运行时行为偏离预期 |

### 评审阶段 (Review) — 合并前的多维质量把关

| 技能名称 | 功能概述 | 适用场景 |
|---------|---------|----------|
| [code-review-and-quality](skills/code-review-and-quality/SKILL.md) | 五轴代码审查、控制单次评审规模（~100 行）、分级严重度标签 | 合并任何 PR 或代码变更前 |
| [code-simplification](skills/code-simplification/SKILL.md) | 切斯特顿围栏原则、死代码清理、在保持完全等价行为下消减代码认知复杂度 | 代码能跑但晦涩冗长、难以维护时 |
| [security-and-hardening](skills/security-and-hardening/SKILL.md) | OWASP Top 10 防范、安全鉴权模型、依赖安全漏洞审计与三层防御边界 | 处理未受信任输入、用户凭据或调用外部服务时 |
| [performance-optimization](skills/performance-optimization/SKILL.md) | 数据先行性能优化、Core Web Vitals 指标达标、消除 N+1 慢查询 | 存在明确性能指标要求或怀疑出现性能退化时 |

### 交付阶段 (Ship) — 安全可控的生产发布

| 技能名称 | 功能概述 | 适用场景 |
|---------|---------|----------|
| [git-workflow-and-versioning](skills/git-workflow-and-versioning/SKILL.md) | 主干开发、原子化 Commit、语义化版本（SemVer）与面向用户的更新日志 | 日常提交、分支管理、打 Tag 及版本发布 |
| [ci-cd-and-automation](skills/ci-cd-and-automation/SKILL.md) | 测试左移、流水线门禁编排、失败反馈闭环与特性开关（Feature Flag） | 搭建或优化 CI/CD 自动化部署工作流 |
| [deprecation-and-migration](skills/deprecation-and-migration/SKILL.md) | “代码即负债”思维、平滑扩缩（Expand/Contract）迁移、零停机数据库架构演进 | 下线老接口、跨版本迁移用户或移除废弃逻辑 |
| [documentation-and-adrs](skills/documentation-and-adrs/SKILL.md) | 架构决策记录（ADR）、接口文档、内联注释准则，记录决策背后的“为什么” | 调整系统架构基石、修改公共 API 或交付里程碑 |
| [observability-and-instrumentation](skills/observability-and-instrumentation/SKILL.md) | 结构化日志、RED/USE 监控指标、OpenTelemetry 链路追踪与基于症状告警 | 补齐可观测性设施，为生产环境保驾护航 |
| [shipping-and-launch](skills/shipping-and-launch/SKILL.md) | 发布前核查清单、灰度放量策略、一键回滚预案与生产冒烟验证 | 准备向生产环境部署功能或发布大版本 |

---

## 常用常备核查清单 (References)

各技能在执行时按需调用的权威技术参考：

- [definition-of-done.md](references/definition-of-done.md) — 团队通用的“完成定义”（DoD）。
- [testing-patterns.md](references/testing-patterns.md) — 测试分级规范、命名约定、Mock 实践与反模式。
- [security-checklist.md](references/security-checklist.md) — 提交前安全排查、鉴权设计、输入验证与 OWASP 防御。
- [performance-checklist.md](references/performance-checklist.md) — Web 核心指标、数据库优化与性能分析工具。
- [accessibility-checklist.md](references/accessibility-checklist.md) — 键盘导航、屏幕阅读器适配、ARIA 属性与对比度。
- [observability-checklist.md](references/observability-checklist.md) — 结构化日志输出、指标收集、链路追踪与线上演练。
- [orchestration-patterns.md](references/orchestration-patterns.md) — 多代理协同模式、并行扇出与规避层层转述的反模式指南。

---

## 致谢与上游渊源

`agy-harness` 深度受益于 **Addy Osmani** 以及开源项目 [`addyosmani/agent-skills`](https://github.com/addyosmani/agent-skills) 的卓越设计：

- **Addy Osmani** ([@addyosmani](https://github.com/addyosmani)) — Agent Skills 发起者与作者
- **Federico Bartoli** ([@federicobartoli](https://github.com/federicobartoli)) — 核心协作者
- **Joan León** ([@nucliweb](https://github.com/nucliweb)) — 核心协作者

`agy-harness` 由 **JsonLee12138** ([@JsonLee12138](https://github.com/JsonLee12138)) 适配并维护，在保证上游核心技能 100% 原样兼容的前提下，针对 Google Antigravity 环境扩展了工作区状态机、Software 1.0 确定性门禁、磁盘事实契约与物理隔离的子代理架构。

---

## 开源协议

MIT 许可证。详情请参阅 [LICENSE](LICENSE) 文件。
