# Harness 拆解课（10 期）

> 「从零造 Agent 框架」系列第三部。前两部你亲手造出了 mini-agent 的骨骼（第一部）和生产级护栏（进阶篇）；这一部反过来，拆开看真实产品——Codex CLI、Claude Code、OpenCode、Gemini CLI、Pi、DeepSeek Harness 六家 harness，外加你自己的生产实现 zmzai-agent，看它们在同一批问题上各自做了什么取舍。

## 这门课怎么上

每期三段式：

- **拆**：从一手证据出发（开源源码、本机真实配置文件、官方文档），把一个机制拆到能画图的粒度；
- **比**：对照你的 mini-agent 实现，说清"它为什么这么做、你怎么改"；
- **造**：把值得抄的机制在 `.research/mini-agent/` 沙箱里亲手实现，tsc + 确定性测试 + 真实 LLM 实跑验证。

一手证据来源（按可信度排序）：

**源码级（最硬）**：五家开源仓库已浅克隆到 `.research/harness-src/`，每期引用钉到文件与行级：

- `openai/codex` → harness-src/codex（Codex CLI，Rust）
- `sst/opencode` → harness-src/opencode（TS）
- `google-gemini/gemini-cli` → harness-src/gemini-cli（TS）
- `badlogic/pi-mono` → harness-src/pi-mono（TS）
- `deepseek-ai/deepseek-harness` → harness-src/deepseek-harness（TS）

**本机真实文件（行为痕迹）**：

- `~/.codex/`（config.toml、hooks.json、rules、sessions）
- `~/.claude/`（settings.json、CLAUDE.md、skills、hooks）
- `~/.config/opencode/opencode.json`
- `~/.gemini/`（GEMINI.md、settings.json）
- `~/.pi/agent/`（extensions、skills）
- `zmzai-agent/packages/agent-framework/`——你自己的生产 harness，源码就在工作区

**网络查证（补空白）**：官方文档、官方博客、社区源码拆解文，用于补前两档的空白，必须与前两档交叉验证后才可引用。

## 十期大纲

### 第 1 期 · 什么是 harness：拆解方法论与七家全景

Harness = 模型之外的一切：系统提示词、工具集、循环控制、权限闸口、上下文管理、会话存储。同一个模型换不同 harness，行为天差地别。本期建立拆解方法论（看什么、去哪看、怎么验证），给七家拍一张全景 X 光片，最后落到一张对比表。本期产物：harness X 光脚本。

### 第 2 期 · Codex CLI：apply_patch 与双轴安全模型

拆 Codex 最有特色的两个设计：`apply_patch` 原子补丁工具（一个工具管所有文件修改，可审计可回滚），以及 approval policy × sandbox mode 双轴权限模型（"技术上能做什么"与"什么时候停下来问"分离）。本期实现：mini-agent 的 apply_patch 解析器 + 双轴权限接线，确定性测试全覆盖。

### 第 3 期 · Claude Code：分层指令与钩子系统

拆 Claude Code 的指令分层（系统提示词 → CLAUDE.md 全局/项目/本地三级 → memory）与 hooks（在工具调用前后、会话节点插入用户代码）。对照进阶篇的护栏流水线：hooks 就是给用户开的护栏插槽。本期实现：mini-agent 的配置加载器 + 钩子引擎。

### 第 4 期 · OpenCode：把开源循环读穿

OpenCode 全开源，是最早能逐行读的工业级 harness 之一。本期读穿它的 agent 循环、工具注册、会话存储，重点对照你自己写的 loop.ts——哪些地方殊途同归，哪些地方它多做了、你少做了。本期实现：把 OpenCode 的会话分叉（fork）机制移植进 mini-agent。

### 第 5 期 · Gemini CLI：上下文预算与免费额度工程

Gemini CLI 面向免费额度用户，上下文管理被迫做到极致。拆它的上下文窗口预算、自动压缩触发策略、token 记账。对照进阶篇第 6 期的投影式压缩：同一道题，两种解法。本期实现：给 mini-agent 加 token 预算面板与按成本触发的压缩策略。

### 第 6 期 · Pi：极简派的豪赌

Pi 的系统提示词 + 工具定义合计不到 1000 tokens，只有四个默认工具，没有 MCP、没有子代理、没有权限弹窗、没有 Plan 模式——这些"标配"它刻意全不做。拆它的五包架构（pi-ai / agent-core / coding-agent / tui）、会话树、以及"让工具适应人"的扩展哲学。对照你的 mini-agent：你的骨架和它有多像？本期实现：把 mini-agent 砍成一个"mini-Pi"，量一量砍完之后还剩多少能力。

### 第 7 期 · DeepSeek Harness：一切皆插件

DeepSeek 官方 2026 年 8 月开源的 dsh：定位不是 coding agent，而是"造 agent 的壳"（Model + Harness = Agent）。拆它的插件运行时（模型本身也只是插件）、多 harness 模式、以及 KV 缓存感知设计——历史前缀永不修改、一切变更末尾追加。对照进阶篇第 6 期的投影式压缩与前缀缓存诊断：殊途同归到什么程度。本期实现：给 mini-agent 写第一个"插件"——把护栏做成可插拔件。

### 第 8 期 · 横切对比：权限模型与沙箱七家横评

七家的权限模型放到一张表上：Claude Code 的规则匹配 + hooks、Codex 的双轴策略、OpenCode/Pi 的工具级开关、Gemini 的审批确认、dsh 的插件化权限、以及你自己进阶篇的 permission engine + 自治档位。每种模型回答三个问题：默认值是什么、越权时发生什么、用户想收紧/放宽的成本多大。本期产出：一份"权限模型选型决策树"，并在 mini-agent 上验证决策树的两个分支。

### 第 9 期 · 横切对比：会话存储、resume 与断点续跑

七家怎么存会话、怎么 resume、崩了怎么续：Codex 的按日期 rollout jsonl、Claude Code 的按项目路径 jsonl、OpenCode 的 sqlite、Pi 的会话树。对照第一部第 6 期的事件流存储：谁存全量、谁存增量、谁做 checkpoint。本期实现：给 mini-agent 加 checkpoint 与崩溃恢复（接上进阶篇的 lease，形成完整闭环）。

### 第 10 期 · 毕业改造：zmzai-agent 复盘 + 精华装回 mini-agent

收官两幕。第一幕回头看：拆你自己的生产 harness zmzai-agent（loop-guard、工具裁剪、自治档位、permission engine）——它用了前两部学到的哪些机制，又欠了这七家哪些债，列成清单。第二幕向前看：把十期里每个值得抄的机制（apply_patch、钩子、会话分叉、预算压缩、checkpoint、插件化）逐个装进 mini-agent，跑同一组基准任务，对比改造前后的步数、token、失败率——用数字证明"拆别人轮子"的价值。

## 执行纪律（延续前两部）

- 教程在 `muzhi/docs/tutorial-harness/`，沙箱在 `.research/mini-agent/`；
- 每期：写一期教程 → 沙箱照原文实现 → tsc + 确定性测试 + 真实 LLM 实跑 → 发现偏差修教程（实测输出回填）；
- 引用真实 harness 的机制必须有出处（源码路径 / 配置文件 / 官方文档），不凭印象写；
- 教程中引用本机配置时一律脱敏（token、密钥、内部域名不落进正文）；
- 完成后 seed 脚本入库 HK 生产 Mongo + 线上验证。
