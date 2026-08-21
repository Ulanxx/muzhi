# 第 1 期：什么是 harness——拆解方法论与七家全景

> **Harness 拆解课 · 第 1 期（共 10 期）**
>
> 前两部你亲手造了一个 mini-agent：骨骼（第一部）和护栏（进阶篇）。这一部反过来——拆别人的。Codex CLI、Claude Code、OpenCode、Gemini CLI、Pi、DeepSeek Harness，外加你自己的生产实现 zmzai-agent。第一期不上手术台，先磨刀：什么是 harness、怎么拆、去哪找证据。最后写一个 X 光脚本，给本机装着的 harness 拍一张全景片。

---

## 这期解决什么问题

你可能已经注意到一个怪现象：**同一个模型，套在不同的编程工具里，表现天差地别。** 同一个 DeepSeek，在 A 工具里改代码又准又稳，在 B 工具里连文件都找不对。模型没变，变的是什么？

是 harness。

**Harness = 模型之外的一切。** 具体说，至少包括六件事：

- **系统提示词**：告诉模型它是谁、该怎么干活；
- **工具集**：给模型装上手脚——读文件、改文件、跑命令；
- **循环控制**：ReAct 循环怎么转、什么时候停、转飞了怎么拽回来；
- **权限闸口**：哪些动作要问人、哪些直接放行；
- **上下文管理**：对话太长怎么压缩、压缩时保什么丢什么；
- **会话存储**：历史存在哪、断了怎么续。

第一部你写过的 `llm.ts`、`tools.ts`、`loop.ts`、`permission.ts`、`compaction.ts`、`events.ts`——合起来就是一个 harness。只不过你的是教学版，接下来要拆的六家是生产版。

一个推论值得先记住：**既然 harness 决定行为，那"模型跑分"离开 harness 谈就是空谈。** DeepSeek 官方跑自己模型的 coding 基准时，用的就是自家的 harness（出处：deepseek-ai/deepseek-harness 仓库 README）。以后看到"XX 模型编程能力暴涨"，先问一句：套的是哪层 harness？

---

## Step 1：拆解方法论——三个问题、三处证据、一条纪律

拆任何一个 harness，都问同样三个问题：

**问题一：它喂给模型什么？** 系统提示词多长、分几层？用户指令从哪些文件注入（CLAUDE.md？AGENTS.md？GEMINI.md？）？

**问题二：它给模型装了什么手脚，怎么管？** 工具集有哪些？哪些动作要审批？审批规则写在哪？越权时发生什么？

**问题三：它怎么记住过去？** 会话存在什么格式、什么位置？断线怎么续？上下文满了怎么压？

证据去哪找？按可信度从高到低排三档：

**一档：开源源码。** Codex CLI（openai/codex）、OpenCode（sst/opencode）、Gemini CLI（google-gemini/gemini-cli）、Pi（badlogic/pi-mono）、DeepSeek Harness（deepseek-ai/deepseek-harness）全部开源。源码不会说谎，这是最硬的证据。

**二档：本机真实文件。** 闭源的部分（比如 Claude Code 的内置提示词）虽然看不到源码，但它的行为痕迹全留在你家目录里：配置文件、会话记录、日志。X 光脚本拍的就是这些。

**三档：官方文档与社区拆解。** 用来补全前两档的空白，但必须交叉验证——文档会过时，博客会脑补。

一条纪律：**不凭印象写结论，每条机制都标出处。** 这是本系列和普通"AI 工具评测文"的区别。

---

## Step 2：跑一个 X 光脚本

方法论说完，动手。本期产物是 `xray.ts`：扫描本机各家 harness 的家目录，输出"证据清单"——每家有哪些配置文件、什么格式、会话存在哪。它只做三件事：探测文件是否存在、列目录抽样、读首个文件的首行看格式。**不解析、不打印任何凭证内容**——拆别人的 harness 是学习，顺手把 token 贴进教程是事故。

```ts
// xray.ts（节选：档案定义与目录抽样）

/** 每个 harness 的 X 光档案：家目录 + 关注的关键文件 */
const TARGETS: { name: string; dir: string; keys: string[] }[] = [
  { name: "Codex CLI",  dir: path.join(HOME, ".codex"),
    keys: ["config.toml", "AGENTS.md", "hooks.json", "sessions"] },
  { name: "Claude Code", dir: path.join(HOME, ".claude"),
    keys: ["settings.json", "CLAUDE.md", "projects", "skills"] },
  { name: "OpenCode",   dir: path.join(HOME, ".config", "opencode"),
    keys: ["opencode.json"] },
  { name: "Gemini CLI", dir: path.join(HOME, ".gemini"),
    keys: ["settings.json", "GEMINI.md", "tmp"] },
  { name: "Pi",         dir: path.join(HOME, ".pi", "agent"),
    keys: ["extensions", "skills"] },
];

/** 目录抽样：最多列 N 个子项，并找第一个普通文件样本（用于看存储格式） */
async function sampleDir(dir: string, max = 5) {
  // 深度优先走 4 层，记下子目录名与第一个普通文件
}

/** 读文件首行（限长），只用于展示存储格式，不解析凭证 */
async function firstLine(p: string): Promise<string> {
  const buf = await fs.readFile(p, "utf8");
  return buf.split("\n", 1)[0]!.slice(0, 100);
}
```

两个实现细节值得说：

**为什么只读首行？** 会话文件可能几十 MB，全读浪费；而首行通常就是格式指纹——是 jsonl 还是 sqlite、是事件流还是全量快照，一眼定案。

**为什么档案是"家目录 + 关键文件"而不是写死路径？** 各家的目录结构会变（版本升级、系统差异），探测失败就标"无"，脚本本身要能容错——这是进阶篇"护栏不能自己失控"的老规矩。

`npx tsx xray.ts`，本机实测输出：

```text
══ Harness X 光 ══

【Codex CLI】 ~/.codex ✓ 存在
  · config.toml — 文件 6.1 KB
  · AGENTS.md — 文件 0.0 KB
  · hooks.json — 文件 0.7 KB
  · sessions — 目录，含 2026/、2026/02/、2026/02/27/
    首个文件：sessions/2026/02/27/rollout-2026-02-27T10-25-40-….jsonl
    首行：{"timestamp":"…","type":"session_meta","payload":{"id":"…"}

【Claude Code】 ~/.claude ✓ 存在
  · settings.json — 文件 3.6 KB
  · CLAUDE.md — 文件 0.1 KB
  · projects — 目录，含 -Users-ulanxx--agents-skills/…
    首个文件：projects/-Users-ulanxx--agents-skills/71653dc4-….jsonl
    首行：{"type":"mode","mode":"normal","sessionId":"71653dc4-…"}
  · skills — 目录，含 .claude-plugin/、.git/、CEO审查/

【OpenCode】 ~/.config/opencode ✓ 存在
  · opencode.json — 文件 0.3 KB

【Gemini CLI】 ~/.gemini ✓ 存在
  · settings.json — 文件 1.0 KB
  · GEMINI.md — 文件 0.4 KB

【Pi】 ~/.pi/agent ✓ 存在
  · extensions — 目录，含 文件若干
    首个文件：extensions/superset-hooks.ts
    首行：// Superset pi extension v1
  · skills — 目录，含 brainstorming/、brainstorming/scripts/…
    首个文件：skills/brainstorming/SKILL.md
    首行：---

结论：同一种 agent，各家把「配置 / 指令 / 会话」放在完全不同的地方、用完全不同的格式。
```

光这张清单就能读出不少东西：

- **指令文件一人一个名**：Codex 认 AGENTS.md，Claude Code 认 CLAUDE.md，Gemini 认 GEMINI.md。同一件事（把项目规矩注入上下文），三家三个文件名——后面第 3 期拆 Claude Code 的分层指令时会看到为什么。
- **会话存储的指纹一眼可辨**：Codex 按日期分目录存 `rollout-*.jsonl`（首行是 `session_meta`，事件流风格）；Claude Code 按项目路径分目录存会话 jsonl（目录名就是路径把 `/` 换成 `-`）。同样是 jsonl，组织哲学完全不同——这是第 9 期的主菜。
- **Pi 的家目录里没有 sessions**：它的会话树存在别处，且它只有 extensions 和 skills 两样用户资产——极简到连配置文件的种类都少。
- **一个意外彩蛋**：本机 Claude Code 的 settings 里把模型全部指向了第三方中转，Codex 的 provider 也是自定义的。这恰好是"harness 与模型解耦"的活证据——**harness 是壳，模型是可换的芯**。换芯不换壳，行为模式大体保留；这也解释了为什么"同一个模型在不同工具里表现不同"。

---

## Step 3：七家全景对比表

把 X 光片加上源码与文档证据，七家的全景如下（出处列在表后）：

| 维度 | Codex CLI | Claude Code | OpenCode | Gemini CLI | Pi | DeepSeek Harness | zmzai-agent（你自己） |
|---|---|---|---|---|---|---|---|
| 开放程度 | CLI 开源 | 闭源 | 全开源 | 全开源 | 全开源 | 全开源（2026-08） | 你自己的源码 |
| 实现语言 | Rust | TS（混淆发行版） | TS | TS | TS | TS | TS |
| 指令注入 | AGENTS.md | CLAUDE.md 三级 | AGENTS.md | GEMINI.md | AGENTS.md / 扩展 | 插件注入 | workspace 规则 |
| 默认工具哲学 | 少而专（apply_patch 管所有文件修改） | 多而全 | 多而全 | 多而全 | 极简（4 个工具） | 插件化，按需装 | 中等（读/写/搜/bash） |
| 权限模型 | approval × sandbox 双轴 | 规则匹配 + hooks | 工具级开关 | 审批确认 | 刻意不做弹窗 | 插件化权限 | permission engine + ask/auto 档位 |
| 会话存储 | 按日期 rollout jsonl | 按项目路径 jsonl | sqlite | 本地临时区 | 会话树 | 轨迹（trace） | Mongo 事件流 |
| 一句话气质 | 工程化全家桶 | 生态最大 | 社区驱动的透明全家桶 | 免费额度逼出极致预算 | 极简派的豪赌 | 造 agent 的壳 | 长在自己产品里的 harness |

出处备忘：Codex 工具集（apply_patch / shell / update_plan）见 openai/codex 仓库与官方 prompting guide；Pi "系统提示词 + 工具定义不到 1000 tokens、四个默认工具"见 badlogic/pi-mono 的设计说明；dsh "Model + Harness = Agent、一切皆插件"见 deepseek-ai/deepseek-harness README；后五期的每期都会把对应细节钉到源码行级。

读这张表的正确姿势不是背，是问三个问题：

**哪里殊途同归？** 所有人都是 ReAct 循环 + 工具调用 + 某种形式的权限控制——你第一部造的骨骼是通用解，没有一家逃出去。

**哪里分道扬镳？** 权限模型和会话存储是分歧最大的两处。前者关乎信任（敢不敢让它自动跑），后者关乎记忆（断了能不能续上）。这两处正是第 8、9 两期横切对比的主题。

**谁在赌什么？** Pi 赌"极简即自由"——不做 MCP、不做子代理、不做权限弹窗；dsh 赌"一切皆插件"——连模型都只是插件的一种。赌注不同，代码长相就不同。**看一个 harness 先问它赌什么，比先看代码快十倍。**

---

## 这期学到了什么

| 概念 | 要点 | 出处 |
|---|---|---|
| Harness | 模型之外的一切：提示词、工具、循环、权限、上下文、存储 | 本期定义 |
| 拆解三问 | 喂什么、装什么手脚怎么管、怎么记住过去 | 方法论 Step 1 |
| 证据三档 | 源码 > 本机文件 > 文档博客，交叉验证 | 方法论 Step 1 |
| 格式指纹 | 会话文件首行就能定案存储格式 | xray.ts 实测 |
| 壳芯解耦 | harness 与模型可分离，跑分离不开 harness 谈 | 本机配置实证 |

关键心智模型：**harness 是产品真正的性格。** 模型决定能力上限，harness 决定这份能力兑现成什么样子——稳不稳、省不省、敢不敢放手。

---

## 课后练习

1. 给 `xray.ts` 加第六个档案：DeepSeek Harness（提示：先跑 `npx @deepseek-ai/dsh` 让它自己初始化家目录，再观察它建了什么）。想想为什么它的"家目录"和别家气质不同。
2. 对比 Codex 与 Claude Code 会话文件的首行格式（`session_meta` 开头 vs `mode` 开头），猜一猜两家恢复会话时的读取策略有什么差别。第 9 期回来对答案。
3. 翻出你第一部写的 `loop.ts`，按本期六件事（提示词/工具/循环/权限/上下文/存储）给它做个体检：哪几件是"有"，哪几件是"能用"，哪几件是"欠着"？这份清单在第 10 期要用。

---

## 下期预告

第 2 期拆 Codex CLI：它为什么只用一个 `apply_patch` 工具管所有文件修改，而不是像别人一样 read/write/edit 全家桶？approval policy 和 sandbox mode 两条轴为什么要分开？我们把 apply_patch 解析器亲手写进 mini-agent。
