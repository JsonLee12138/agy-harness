# AGENTS.md

This file provides guidance to AI coding agents (Claude Code, Cursor, Copilot, Antigravity, etc.) when working with code in this repository.

> **Scope:** This file configures agents working on the [`addyosmani/agent-skills`](https://github.com/addyosmani/agent-skills) repository itself. It is not meant to be copied into other projects or into a global agent configuration; the reusable assets are the skills in `skills/`, not this file.

## Repository Overview

A collection of skills for Claude.ai and Claude Code for senior software engineers. Skills are packaged instructions and scripts that extend Claude and your coding agents capabilities.

## OpenCode Integration

OpenCode uses a **skill-driven execution model** powered by the `skill` tool and this repository's `/skills` directory.

### Core Rules

- If a task matches a skill, you MUST invoke it
- Skills are located in `skills/<skill-name>/SKILL.md`
- Never implement directly if a skill applies
- Always follow the skill instructions exactly (do not partially apply them)

### Intent → Skill Mapping

The agent should automatically map user intent to skills:

- Feature / new functionality → `spec-driven-development`, then `incremental-implementation`, `test-driven-development`
- Planning / breakdown → `planning-and-task-breakdown`
- Bug / failure / unexpected behavior → `debugging-and-error-recovery`
- Code review → `code-review-and-quality`
- Refactoring / simplification → `code-simplification`
- API or interface design → `api-and-interface-design`
- UI work → `frontend-ui-engineering`

### Lifecycle Mapping (Implicit Commands)

OpenCode does not support slash commands like `/spec` or `/plan`.

Instead, the agent must internally follow this lifecycle:

- DEFINE → `spec-driven-development`
- PLAN → `planning-and-task-breakdown`
- BUILD → `incremental-implementation` + `test-driven-development`
- VERIFY → `debugging-and-error-recovery`
- REVIEW → `code-review-and-quality`
- SHIP → `shipping-and-launch`

### Execution Model

For every request:

1. Determine if any skill applies (even 1% chance)
2. Invoke the appropriate skill using the `skill` tool
3. Follow the skill workflow strictly
4. Only proceed to implementation after required steps (spec, plan, etc.) are complete

### Anti-Rationalization

The following thoughts are incorrect and must be ignored:

- "This is too small for a skill"
- "I can just quickly implement this"
- "I’ll gather context first"

Correct behavior:

- Always check for and use skills first

This ensures OpenCode behaves similarly to Claude Code with full workflow enforcement.

## Orchestration: Personas, Skills, and Commands

This repo has three composable layers. They have different jobs and should not be confused:

- **Skills** (`skills/<name>/SKILL.md`) — workflows with steps and exit criteria. The *how*. Mandatory hops when an intent matches.
- **Personas** (`agents/<role>.md`) — roles with a perspective and an output format. The *who*.
- **Slash commands** (`.claude/commands/*.md`) — user-facing entry points. The *when*. The orchestration layer.

Composition rule: **the user (or a slash command) is the orchestrator. Personas do not invoke other personas.** A persona may invoke skills.

The only multi-persona orchestration pattern this repo endorses is **parallel fan-out with a merge step** — used by `/ship` to run `code-reviewer`, `security-auditor`, and `test-engineer` concurrently and synthesize their reports. Do not build a "router" persona that decides which other persona to call; that's the job of slash commands and intent mapping.

See [docs/agents.md](docs/agents.md) for the decision matrix and [references/orchestration-patterns.md](references/orchestration-patterns.md) for the full pattern catalog.

**Claude Code interop:** the personas in `agents/` work as Claude Code subagents (auto-discovered from this plugin's `agents/` directory) and as Agent Teams teammates (referenced by name when spawning). Two platform constraints align with our rules: subagents cannot spawn other subagents, and teams cannot nest. Plugin agents silently ignore the `hooks`, `mcpServers`, and `permissionMode` frontmatter fields.

## Creating a New Skill

> **Before you start:** run the pre-flight checks in [CONTRIBUTING.md](CONTRIBUTING.md#before-proposing-a-new-skill), search the catalog, check open PRs (`gh pr list --state open`), confirm the idea fits [docs/skill-anatomy.md](docs/skill-anatomy.md), and justify the gap in your PR description. Most new-skill ideas overlap an existing skill or an open PR; prefer extending an existing skill over adding a near-duplicate. CONTRIBUTING.md is the single source of truth for this workflow.

Skills in this repo are markdown-first: each lives at `skills/<kebab-case-name>/SKILL.md` with YAML frontmatter (`name`, `description`) and follows the section anatomy (Overview, When to Use, Process, Common Rationalizations, Red Flags, Verification). Add a `scripts/` directory only when the skill ships runnable helpers; most skills are markdown only, and there are no per-skill zip packages.

For the full format, naming conventions, frontmatter rules, supporting-file thresholds, and writing principles, see [docs/skill-anatomy.md](docs/skill-anatomy.md), the single source of truth for skill structure. Do not restate that guidance here, link to it.


# Karpathy AI Research

以 Andrej Karpathy 的第一性原理（`micrograd` / `nanoGPT` 极简还原思维）、`LLM OS` 系统映射、`Context Engineering` 与实证评测（`Evals over Vibe Checks`）为核心框架，对任何 AI 技术、论文、模型或工程框架进行去魅拆解与全景调研。

## When to Use

- 用户要求深度调研、拆解或评估某个 AI 模型、论文、Agent 框架、上下文管理方案或工程工具链。
- 用户面临 AI 架构技术选型（如自研极简循环 vs 引入重型开源框架、RAG vs 长上下文、微调 vs 上下文工程）。
- 用户希望剥离行业营销黑话（Hype），从底层 Token 流、计算预算与工程投入产出比看清某项 AI 技术的真实边界。
- 用户明确提及使用 Karpathy 思维、第一性原理或系统级视角做技术调研与实战指南输出。

## Core Research Lenses

调研任何 AI 技术时，依次用以下六个心智滤镜穿透表象：

1. **极简第一性原理还原（The `nanoGPT` Strip-Down）**：拒绝复读官方 PR 造词。剥掉所有面向对象封装与营销术语后，追问它的最小核心循环是什么？如果只用 100 行纯 Python + 基础 API 重写，它本质上是怎么拼装输入、调用模型和解析输出的？
2. **LLM OS 栈层精准定位（LLM OS Mapping）**：将该技术映射到操作系统隐喻中审视其真实生态位 - 它是在改造 CPU（架构权重与推理期计算分配 Test-time Compute）、管理 RAM（Context Window 信噪比与 KV Cache）、扩展 Disk（外部知识索引与持久化），还是增强外设调用（确定性代码沙箱与外部 API 协同）？
3. **Software 1.0 与 2.0 职责边界审计**：检查架构职责是否错位。凡是算术、精确解析、状态机流转、权限控制等确定性逻辑，应归属 Software 1.0（传统代码）；凡是语义归纳、意图映射、模糊生成，才交给 Software 2.0/3.0（模型权重与上下文调度）。警惕用概率模型硬扛确定性任务，或用脆弱正则硬捆语义推理。
4. **上下文卫生学与代币经济学（Context Hygiene & Token Economics）**：追踪每一轮推理实际塞入 Context Window 的真实 Payload。评估该技术是否引入了隐藏的系统提示词膨胀、历史噪音堆积（Lost in the Middle）或高昂的思考代币放大倍数（Token Multiplier），核算真实延迟与推理成本。
5. **凹凸能力边界与红队去魅（Jagged Frontier & Anti-Sycophancy）**：摒弃迎合式吹捧，主动扮演严格同行评审（Red Teamer）。明确刻画该技术的凹凸边界：它在哪类标准 Demo 中表现惊艳，又在哪类真实生产长尾中瞬间坍塌？重点排查幻觉失锚（Dream Machine 无依据生成）、提示注入面（控制指令与不可信外部数据混流）以及多步级联误差。
6. **实证评估闭环（Evals over Vibe Checks）**：拒绝凭 2 个手工样例拍脑袋下结论。任何调研报告都需给出可落地的最小验证实验（Minimal Repro）和黄金测试集（Golden Eval Suite）设计方案，明确自动化打分指标与 Bad Case 归因飞轮。

## Steps

### 1. 界定调研范围与一手信源溯源

优先检索并锚定高信噪比的一手材料，按可信度降序排列：核心源码实现（GitHub 核心执行文件与 Prompt 模板）、原始技术报告或论文（实验设置、消融实验与 Limitations 章节）、作者公开技术复盘与真实生产环境踩坑记录。将二手营销软文与跑分刷榜宣传视为待核验假设而非事实。

### 2. 拆解底层机制与数据流（Token-Level Trace）

忽略高层概念图，直接追踪一次完整请求的数据形态变化：

- **输入构造**：系统指令、检索片段、工具 Schema 与用户输入是如何拼接成最终上下文序列的？
- **计算分配**：模型是在单步直出结论，还是通过草稿纸（Scratchpad / Reasoning Tokens）消耗额外推理算力换取准确率？
- **反馈闭环**：外部环境（编译器报错、测试结果、搜索返回）如何裁剪并回注到下一轮 RAM 中？

### 3. 开展架构权衡与极简替代对比（Build vs Buy Audit）

针对任何引入复杂抽象的框架或方案，强制进行奥卡姆剃刀拷问：

- **抽象税评估**：引入该技术带来了多少隐蔽状态、调试黑盒与依赖耦合？
- **基准对照**：与“直接写一个清晰的 `while` 循环 + 原生工具调用 + 严格修剪的上下文”相比，它的净收益在哪里？什么规模下值得引入，什么场景下属于过度工程（Over-engineering）？

### 4. 压力测试缺陷与安全边界

逐项排查生产落地时的结构性隐患并给出工程对策：

- **长程退化**：对话或任务超过 10 轮后，上下文信噪比如何维持？何时触发摘要压缩或清空重置？
- **幻觉与越界**：缺乏外部事实时是否有明确的退出路径（Escape Hatch）与引用锚定（Grounding）？
- **安全隔离**：当处理外部网页、文档或第三方数据时，是否通过结构化边界将控制指令与不可信数据隔离以缓解提示注入？

### 5. 设计最小验证实验与 Golden Eval

为调研对象制定一套去伪存真的工程验证清单：

- **30 分钟最小验证（Toy Repro）**：设计 1 个能暴露核心机制优劣的极简实验脚本或对比实验（如同用 `micrograd` 验证反向传播）。
- **黄金评测集（20-50 题）**：定义覆盖常规路径、边界歧义与对抗样本的测试用例，明确确定性校验（AST/Schema/单测）与模型裁判（LLM-as-a-Judge）的组合打分逻辑。

### 6. 输出全景调研与实战指南

采用高信息密度、结构化的技术文档格式输出结论：先给直击本质的判断，再用架构图（Mermaid）、对比矩阵与可操作清单支撑，杜绝空洞形容词堆砌。

## Output Template

除非用户指定其他简短格式，全景技术调研默认按以下模块化结构组织：

1. **调研范围与一句话本质定义**：说明覆盖的一手信源范围，并用一句不含黑话的工程大白话定义该技术的本质（如：“本质上是一个在推理期用树搜索展开多条草稿链并由验证器剪枝的上下文调度器”）。
2. **第一性原理机制拆解（含 Mermaid 架构/数据流图）**：展示在 `LLM OS` 中的位置及端到端 Token 流转路径。
3. **核心增益与代币经济学账本**：量化分析准确率/能力上限提升的来源，以及对应的延迟、Token 消耗倍数与维护复杂度代价。
4. **凹凸边界、认知陷阱与工程对策**：直指真实失效模式（幻觉、注入、长上下文稀释、级联报错）及对应的防御性设计（Grounding、工具卸载、外科手术式小步迭代）。
5. **极简选型建议与实战落地指南**：给出清晰的“何时直接手写 50 行代码 vs 何时采用该方案”决策表，附带最小配置范式。
6. **科学验证方案（Golden Eval 设计）**：列出上线前必测的典型 Case 类型、评估指标与迭代飞轮。
7. **一手信源索引**：汇总核心论文、关键源码路径或基准实现链接。

## Gotchas

- **警惕把比喻当机制**：拟人化词汇（“智能体思考”、“自主规划”、“记忆觉醒”）容易掩盖工程真相。调研时始终将其还原为概率分布采样、上下文窗口拼接与外部循环控制。
- **不要被榜单 SOTA 迷惑**：公开基准测试常存在数据污染或特定 Prompt 过拟合。重点审视消融实验（Ablation Study）中到底是哪个具体改动贡献了主要增益。
- **避免堆砌大而全的平庸综述**：不要罗列几十个同质化工具的表面功能列表。聚焦核心原语差异、系统权衡（Trade-offs）与可验证的工程结论。
- **区分模型能力演进红利与脚手架红利**：评估一项中间层技术时，始终追问：当下一代基座模型原生推理更强、上下文更准时，这套复杂的工程脚手架会升值还是会瞬间沦为技术债？
