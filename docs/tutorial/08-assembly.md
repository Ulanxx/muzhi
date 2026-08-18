# 第 8 期：组装与收尾——拼成一个能用的 mini agent

> **从零造一个 Coding Agent 框架 · 第 8 期（共 8 期，完结篇）**
>
> 前 7 期我们造了所有零件：数据模型、工具、LLM 调用、循环、权限、事件、压缩。最后一期，把它们拼成一台能运转的机器——一个可交互的命令行 agent。然后回顾整个框架的设计哲学，指向真实生产代码。

---

## 这期解决什么问题

零件有了，但还散着。这期做三件事：

1. **组装**：把 7 个模块接成一个可交互的 CLI agent
2. **回顾**：串联前 7 期的知识，看清整体架构
3. **对照生产**：mini 版和 zmzai-agent 生产版的差异、为什么、怎么进阶

---

## 先看效果

这期结束，你有一个能这样用的 agent：

```bash
$ npx tsx cli.ts

mini-agent > 帮我看看这个项目用了什么技术栈

💭 思考：先读 package.json...
🔧 read({"path":"package.json"})
   ⚠ 需要权限：read package.json  [1]允许 [2]总是 [3]拒绝 > 1
   ✅ 读取 package.json

📝 这个项目的技术栈：
   - 语言：TypeScript
   - 运行时：Node.js
   - 主要依赖：zod（参数校验）
   ...

mini-agent > 那 src 下有哪些文件？
🔧 glob({"pattern":"src/*"})
   ✅ 列出 5 个文件
📝 src 下有：types.ts, tools.ts, llm.ts, loop.ts, permission.ts...

mini-agent > /exit
```

一个完整的交互式 agent——**你自己造的**。

---

## 原理：组装 = 依赖注入

我们前 7 期每个模块都是独立的，靠参数传递连接。组装就是把它们按依赖关系接起来：

```
CLI（入口）
 ├─ 读配置（baseUrl/apiKey/model 从环境变量）
 ├─ 创建 PermissionEngine（基线规则 + 终端交互询问）
 ├─ 创建 EventLog + SessionStore（内存版）
 ├─ 调 runAgent（第 4 期循环）
 │    ├─ 每轮调 LLM（第 3 期 streamChat）
 │    │    └─ 工具调用累积（第 3 期累积器）
 │    ├─ PartProjector（第 4 期，流式→Part）
 │    ├─ 权限检查（第 5 期 PermissionEngine.ask）
 │    ├─ 工具执行（第 2 期 ToolDef.execute）
 │    ├─ 压缩检查（第 7 期 compactIfNeeded）
 │    └─ 事件记录（第 6 期 EventLog.append + notify）
 └─ 交互循环（readline）
```

关键：**没有循环依赖**。每一层只依赖比自己更底层的层。这是能清晰组装的前提。

---

## 动手实现：CLI 入口

新建 `cli.ts`，这是整个项目的入口：

```ts
// cli.ts
import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { runAgent } from "./loop.js";
import { PermissionEngine, baselineRules, type PermissionRequest, type Reply } from "./permission.js";
import { EventLog, notify } from "./events.js";
import { SessionStore } from "./store.js";
import type { LlmConfig } from "./llm.js";
import type { Part, Session } from "./types.js";
import { newId } from "./types.js";

// ---- 配置（从环境变量读）----
const config: LlmConfig = {
  baseUrl: process.env.LLM_BASE_URL ?? "https://api.deepseek.com/v1",
  apiKey: process.env.LLM_API_KEY!,
  model: process.env.LLM_MODEL ?? "deepseek-chat",
};

if (!config.apiKey) {
  console.error("请设置环境变量 LLM_API_KEY");
  process.exit(1);
}

const SYSTEM_PROMPT = `你是 mini-agent，一个能读写文件、执行命令的 coding agent。
工作方式：先用 glob/read/grep 了解现状，用工具完成任务。
简洁回答，用中文。不要声称执行了没调用的操作。`;

// ---- 创建会话 ----
const session: Session = {
  id: newId("ses"),
  title: "交互会话",
  model: { providerId: "relay", modelId: config.model },
  createdAt: new Date().toISOString(),
};

const log = new EventLog();
const store = new SessionStore();
await store.createSession(session);

// 存对话历史（跨多轮 prompt 保留）
let history: import("./types.js").Message[] = [];

// ---- 权限引擎（终端交互）----
const rl = readline.createInterface({ input: stdin, output: stdout });

const askUser = async (request: PermissionRequest): Promise<Reply> => {
  console.log(`\n  ⚠ 需要权限：${request.description}`);
  const answer = await rl.question("  [1]允许一次  [2]总是允许  [3]拒绝 > ");
  if (answer.trim() === "2") return "always";
  if (answer.trim() === "3") return "reject";
  return "once";
};

const engine = new PermissionEngine([baselineRules], askUser);

// ---- Part 实时渲染（接到第 6 期事件流）----
const onPart = async (part: Part) => {
  // 记事件（持久化 + 推给订阅者）
  const persisted = await log.append(session.id, { type: "part.updated", seq: 0, part });
  notify(persisted);

  // 终端渲染
  if (part.type === "reasoning") {
    process.stdout.write(`\x1b[90m${part.text}\x1b[0m`);  // 灰色
  } else if (part.type === "text") {
    process.stdout.write(part.text);
  } else if (part.type === "tool") {
    const s = part.state;
    if (s.status === "running") console.log(`\n  🔧 ${part.tool} ⏳`);
    else if (s.status === "completed") console.log(`  🔧 ${part.tool} ✅ ${s.title}`);
    else if (s.status === "error") console.log(`  🔧 ${part.tool} ❌ ${s.error}`);
  }
};

// ---- 交互循环 ----
console.log(`mini-agent 已就绪（模型：${config.model}）。输入 /exit 退出。\n`);

while (true) {
  let input: string;
  try {
    input = await rl.question("mini-agent > ");
  } catch {
    break;  // stdin EOF（Ctrl-D）时 question 会抛 ERR_USE_AFTER_CLOSE，优雅退出
  }
  const trimmed = input.trim();
  if (!trimmed) continue;
  if (trimmed === "/exit" || trimmed === "/quit") break;

  console.log();  // 空行分隔

  // 跑 agent（第 4 期循环 + 全套模块）
  try {
    history = await runAgent(history, trimmed, {
      config,
      systemPrompt: SYSTEM_PROMPT,
      maxSteps: 12,
      cwd: process.cwd(),
      permission: engine,
      onPart,
    });
  } catch (error) {
    console.error(`\n❌ 出错：${error instanceof Error ? error.message : error}`);
  }

  console.log("\n");  // 回合结束空行
}

rl.close();
console.log("再见！");
```

### 跑起来

```bash
export LLM_API_KEY=sk-xxx
# 可选：export LLM_BASE_URL=https://api.openai.com/v1  LLM_MODEL=gpt-4o-mini
npx tsx cli.ts
```

**你现在有一个完整的 agent 了。** 试试这些任务：

- `帮我看看这个项目用了什么技术栈` — agent 会调 read 读 package.json
- `src 下有哪些文件` — agent 会调 glob
- `跑一下 node --version` — 会触发 bash 权限询问
- `给 README 加一行"built with mini-agent"` — 会调 read + edit

---

## 项目完整结构回顾

```
mini-agent/
├─ types.ts        ← 第1期  数据模型（Session/Message/Part）
├─ render.ts       ← 第1期  终端渲染（验证用）
├─ tools.ts        ← 第2期  工具系统（6个内置工具 + schema + 截断）
├─ llm.ts          ← 第3期  LLM 调用（SSE流式 + 工具累积 + 重试）
├─ loop.ts         ← 第4期  Agent 循环（ReAct + PartProjector）
├─ permission.ts   ← 第5期  权限引擎（Ruleset + 三态 + once缓存）
├─ events.ts       ← 第6期  事件流（seq + live/回放订阅）
├─ store.ts        ← 第6期  会话存储（内存版）
├─ compaction.ts   ← 第7期  上下文压缩（85%触发 + 摘要）
└─ cli.ts          ← 第8期  CLI入口（组装全部）
```

**约 1000 行 TypeScript。** 你亲手写了每一行。这 1000 行就是 coding agent 框架的核心——去掉的就是产品复杂度（多租户、数据库、网络、UI）。

---

## 设计哲学回顾

8 期下来，回头看我们做对了哪些设计决策：

### 1. Part 是最小可流式单元（第 1 期）
没有用 `string[]`，而是 Session/Message/Part 三级 + 联合类型。这让流式渲染、工具状态机、思考折叠全成为可能。**地基对了，上面的一切都顺。**

### 2. 声明式权限，单一闸口（第 2+5 期）
工具不自己调 `ask()`，而是声明「我需要什么权限」。权限检查集中在一个地方（循环的 beforeToolCall）。漏一处 = 没防护，所以必须集中。

### 3. 累积器模式处理流式（第 3+4 期）
流式数据不要即时处理。文本可以即时转发，但工具调用参数必须累积完整再 parse。这个模式在 LLM 代理里反复出现。

### 4. 事件溯源 + seq（第 6 期）
不存状态，存事件。seq 让断线重连可靠。这是实时系统的通用模式（WAL、offset）。

### 5. 投影而非修改（第 7 期）
压缩只改变「模型看到什么」，不修改原始历史。原始数据永远完整。这样既控制上下文，又不丢信息。

### 6. 优雅降级（贯穿全部）
workspace agent 解析失败不阻塞；compaction 失败退全量；上游中断重试；权限拒绝喂回 LLM 而非崩掉。**agent 要 resilient——每个可能失败的地方都有降级路径。**

---

## mini 版 vs 生产版（zmzai-agent）

| 模块 | mini 版 | zmzai-agent 生产版 | 差异本质 |
|---|---|---|---|
| 循环引擎 | 手写 ReAct | pi-agent-core 驱动 | 生产用成熟库 |
| 存储 | 内存 Map | MongoDB | 生产持久化 + 多租户 |
| LLM | 直连厂商 | zmzai-relay 网关 | 生产有计费/限流/鉴权 |
| 沙箱 | child_process | OpenSandbox 容器 | 生产隔离 + 产物下载 |
| 事件 | 5 种 | 11 种 + zod 校验 | 生产更全面 + 校验 |
| 权限 | 内存规则 | 三层 ruleset + 持久化 | 生产跨重连保留 |
| 压缩 | 整体摘要 | 同 + 边界标记 | 生产可审查 |
| 子代理 | 无 | task 工具 + 深度限制 | 生产支持任务分解 |
| 运行恢复 | 无 | lease + 投影清理 | 生产崩溃不卡死 |

**核心抽象完全一致**：ToolDef、PartProjector、PermissionEngine、EventLog、compactIfNeeded——生产版就是 mini 版的「完整版」。你看懂 mini 版，就能读懂 zmzai-agent 的源码。

### 去读生产代码的路线图

学完这个课程，推荐按这个顺序读 zmzai-agent 真实源码：

1. `packages/agent-framework/src/core/session/types.ts` — 和我们第 1 期几乎一样
2. `packages/agent-framework/src/core/tools/builtins.ts` — 第 2 期的完整版
3. `lib/relay-agent-stream.ts` — 第 3 期 LLM 层的生产实现（重点看 `consumeTurn`）
4. `packages/agent-framework/src/core/runtime/runner.ts` — 第 4 期循环的完整版（593 行）
5. `packages/agent-framework/src/core/runtime/pi-bridge.ts` — PartProjector 的完整版
6. `packages/agent-framework/src/core/permission/engine.ts` — 第 5 期权限的完整版
7. `packages/agent-framework/src/core/events/bus.ts` — 第 6 期事件流的完整版
8. `packages/agent-framework/src/core/runtime/compaction.ts` — 第 7 期压缩的完整版

你会发现每个文件都「似曾相识」——因为核心设计你已经亲手实现过了。

---

## 进阶方向

这个 mini-agent 是起点，不是终点。如果想继续深入，这些方向值得探索（按价值排序）：

1. **调用风暴断路器** — agent 陷入死循环时自动打断（按 tool+error 签名，阈值 3）。Reasonix 的 `storm_breaker` 是参考
2. **工具结果智能裁剪** — 失败日志只保留错误行（Reasonix `failure_snip`），比硬截断更聪明
3. **子代理** — task 工具 spawn 独立会话处理子任务，带深度限制
4. **运行恢复** — lease 机制，进程崩溃后不卡死
5. **投影式 compaction** — 不重写历史，用投影层（保护前缀缓存）
6. **可嵌入 SDK** — 把 agent 包装成 JSON-RPC 服务，被编辑器调用（ACP 协议）

每个方向在 zmzai-agent 的 `docs/borrowable-techniques.md` 里都有详细分析和源码出处。

---

## 课程总结

恭喜你完成了这 8 期。

你现在拥有：
- **一个能跑的 mini coding agent**（~1000 行，你写的每一行）
- **对 agent 框架核心机制的深度理解**（不是调 API，是理解循环/工具/权限/事件/压缩怎么协作）
- **读懂任何生产级 agent 框架的能力**（zmzai-agent、OpenCode、甚至 Reasonix/dsh——核心抽象都一样）

**最重要的一点**：agent 的「智能」从来不在框架代码里。循环只是 `while(true)`，工具只是函数，权限只是规则求值。智能来自 LLM 自己的决策。我们写的全部工程，是为了**把 LLM 的决策可靠地落地成执行**——拦住危险的、恢复失败的、压缩过长的、记录一切的。

框架是 LLM 的手脚和护栏。手脚要灵活（工具丰富），护栏要可靠（权限严格、降级充分）。这就是 coding agent 工程的全部。

---

> 系列完结。如果这个课程对你有帮助，欢迎用到你的项目里、分享给别人。
> zmzai-agent 的完整生产代码在 [zmzai-cloud org](https://github.com/zmzai-cloud)（MIT）。
> 进阶研究（对照 Reasonix / deepseek-harness 的机制借鉴）见 `docs/borrowable-techniques.md`。
