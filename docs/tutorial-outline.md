# 教程大纲：从零造一个 Coding Agent 框架

> 定位：进阶工程教程。读者是泛技术读者（懂编程、会 TypeScript 基础），但没深究过 agent 内部。
> 「什么是 agent / 为什么需要工具循环」属于入门概念，放在**另一个入门课**，本课默认读者已理解 LLM + function calling 的基本概念。
> 形式：**动手实现型**——每期跟着敲出一个能跑的简化模块，最终拼成一个 mini agent 框架（约 800-1200 行 TS）。
> 参考实现：zmzai-agent（真实生产代码，每期对照源码位置）。

---

## 课程总目标

学完这个课程，读者能：

1. 理解一个 coding agent 框架的**核心抽象**（会话、工具、权限、事件、上下文压缩）
2. **亲手实现**每一个核心模块的简化版，且能跑通
3. 把模块拼成一个端到端的 mini agent：能读文件、改文件、跑命令、要权限、压缩上下文
4. 看懂 zmzai-agent（或任何类似框架）的真实生产代码，知道每个设计决策的**为什么**

## 前置知识（读者自备）

- TypeScript 基础（类型、泛型、async/await、Promise）
- 知道 LLM 是什么、调过大模型 API（OpenAI 兼容格式）
- 理解 function calling / tool use 的概念（入门课内容）
- 用过 npm/pnpm，能跑 Node.js 脚本

## 课程产出

一个 `mini-agent/` 项目，结构（最终态）：

```
mini-agent/
├─ types.ts            # 数据模型（Session/Message/Part）
├─ tools.ts            # 工具系统（ToolDef + 6 个内置工具）
├─ permission.ts       # 权限引擎（Ruleset + 三态闸口）
├─ llm.ts              # LLM 调用层（OpenAI 兼容，流式）
├─ loop.ts             # Agent 循环（ReAct + 工具调度）
├─ projector.ts        # 事件投影（LLM 事件 → Part 流）
├─ store.ts            # 会话/消息存储（内存版）
├─ compaction.ts       # 上下文压缩
├─ events.ts           # 事件总线（seq + 订阅）
└─ cli.ts              # 可交互的命令行入口
```

每期产出其中的 1-2 个文件，**每期结束时代码能跑、有可见效果**。

---

## 期数规划（共 8 期）

### 第 1 期：数据模型——为什么 agent 的消息不是一串文本

**产出**：`types.ts`
**核心问题**：为什么不能用 `string[]` 存对话？为什么要 Session/Message/Part 三级？
**讲什么**：
- 真实 agent 一轮回复是多模态混合（思考 + 文本 + 工具调用）
- Part 联合类型的设计（text / reasoning / tool / step 边界）
- ToolState 状态机（pending → running → completed/error）
- 动手：定义全套类型，写一个「把假数据渲染成终端输出」的小函数验证模型自洽
**对照源码**：`zmzai-agent/.../session/types.ts`
**难度**：⭐（纯类型，热身）

---

### 第 2 期：工具系统——让 LLM 长出手脚

**产出**：`tools.ts`
**核心问题**：怎么把「读文件」「跑命令」变成 LLM 能调用的工具？工具的参数怎么校验？输出怎么处理？
**讲什么**：
- ToolDef 抽象（id/参数 schema/execute/权限声明）
- 用 zod 定义参数 + 自动转 JSON Schema（给 LLM 看）
- 实现 6 个内置工具：read / glob / grep / write / edit / bash（简化版，bash 用子进程）
- 输出截断（防止巨量输出撑爆上下文）
- 动手：跑一个工具、看 LLM 怎么收到它的 schema
**对照源码**：`builtins.ts` + `adapter.ts`
**难度**：⭐⭐

---

### 第 3 期：LLM 调用层——流式、工具调用解析、容错

**产出**：`llm.ts`
**核心问题**：怎么调一个 OpenAI 兼容的流式接口？流回来的 chunk 怎么拼成完整回复？工具调用是分片到达的，怎么累积？
**讲什么**：
- SSE 流式解析（data: 行 + [DONE]）
- 三种 delta 的处理：content（文本）/ reasoning_content（思考）/ tool_calls（分片累积）
- 工具调用参数的流式拼接（arguments 是字符串分片，要累积后 JSON.parse）
- 容错：空响应、网络错误的重试策略
- 动手：调一次真实模型，流式打印出「思考 + 文本 + 工具调用」
**对照源码**：`lib/relay-agent-stream.ts`
**难度**：⭐⭐⭐（流式 + 分片累积是这期难点）

---

### 第 4 期：Agent 循环——ReAct 的工程实现

**产出**：`loop.ts` + `projector.ts`
**核心问题**：LLM 调了工具，工具返回结果，怎么把结果喂回 LLM 让它继续？这个循环什么时候停？
**讲什么**：
- ReAct 循环：LLM →（有工具调用？→ 执行工具 → 结果回灌 → 继续）：（无 → 结束）
- 消息格式的来回转换（内部 Part 模型 ↔ OpenAI messages 格式）
- PartProjector：把流式 LLM 事件 fold 成 Part 流（文本缓冲 flush、工具状态机）
- shouldStop：步数上限（防止无限循环）
- 动手：跑一个完整任务「读取文件 → 总结」，看循环怎么转
**对照源码**：`runner.ts` runLoop + `pi-bridge.ts` PartProjector
**难度**：⭐⭐⭐⭐（核心期，概念密度最大）

---

### 第 5 期：权限系统——不能让 agent 乱删文件

**产出**：`permission.ts`
**核心问题**：agent 要跑 `rm -rf` 怎么办？怎么在工具执行前拦住它？用户批准一次后，同样的命令要不要反复问？
**讲什么**：
- Ruleset DSL（permission + pattern + action，last-match-wins）
- 通配匹配（`*` 含路径分隔符，`?` 单字符）
- PermissionEngine：ask → 挂起等回复 → once/always/reject
- once 缓存（同 run 不重复问）+ always 级联（一次批准覆盖同类 pending）
- 把权限闸口接到工具执行前（beforeToolCall 钩子）
- 动手：跑一个会触发权限的 bash 命令，手动批准/拒绝，看 agent 行为变化
**对照源码**：`ruleset.ts` + `engine.ts`
**难度**：⭐⭐⭐

---

### 第 6 期：会话存储与事件流——断线重连怎么续上

**产出**：`store.ts` + `events.ts`
**核心问题**：UI 怎么知道 agent 在干什么？刷新页面后怎么恢复到之前的进度？
**讲什么**：
- 事件溯源：UI 全状态从事件流推导（不直接存「当前状态」）
- 事件 manifest（固定的事件类型 + zod 校验）
- seq 单调递增 + 断点续传（subscribe(sinceSeq)）
- SessionStore 抽象（内存版实现，留 Mongo/JSONL 的口子）
- 动手：订阅一个会话的事件流，实时打印，模拟断线重连
**对照源码**：`manifest.ts` + `bus.ts`
**难度**：⭐⭐⭐

---

### 第 7 期：上下文压缩——对话太长怎么办

**产出**：`compaction.ts`
**核心问题**：对话超过模型窗口了怎么办？哪些该留、哪些该压？压完之后怎么不丢关键信息？
**讲什么**：
- 触发条件（token 估算 + 阈值）
- 压缩策略：head 压成摘要 + tail 保留原文
- 用便宜模型生成摘要（避免主模型又贵又慢）
- 边界标记（compaction part）+ 失败降级
- 动手：构造一个超长对话，触发压缩，看压缩前后上下文变化
**对照源码**：`compaction.ts`
**难度**：⭐⭐

---

### 第 8 期：组装与收尾——拼成一个能用的 mini agent

**产出**：`cli.ts` + 整体串联 + 回顾
**核心问题**：把前 7 期的模块拼起来，做成一个可交互的命令行 agent
**讲什么**：
- 依赖注入组装（store + llm + tools + permission + compaction → runner）
- CLI 交互循环（输入 prompt → 流式输出 → 工具卡片 → 权限询问）
- 回顾整个框架的设计哲学（单一闸口 / 事件溯源 / 声明式权限 / 优雅降级）
- 指向 zmzai-agent 真实代码：mini 版和生产版的差异在哪、为什么
- 进阶方向（子代理、lease 恢复、风暴断路器、缓存优化——作为「下一步」）
**对照源码**：`createServer.ts` + `index.ts`
**难度**：⭐⭐

---

## 难度递进曲线

```
期1 ■□□□□□□□  热身（纯类型）
期2 ■■□□□□□□  工具抽象
期3 ■■■□□□□□  流式解析（第一个硬点）
期4 ■■■■□□□□  ReAct 循环（核心，概念密度峰值）
期5 ■■■□□□□□  权限（有意思但不难）
期6 ■■■□□□□□  事件（概念清晰就好懂）
期7 ■■□□□□□□  压缩（轻松期）
期8 ■■□□□□□□  收尾组装
```

第 3-4 期是难度高峰（流式 + 循环），过了这两期后面会越来越顺。建议在 3、4 期之间可以插一个「休息/复习」的过渡。

## 每期的统一结构

每期按这个模板写，保证系列一致性：

1. **这期解决什么问题**（一句话动机）
2. **先看效果**（这期跑完能看到什么——先给甜头）
3. **原理**（核心概念 + 为什么这么设计，配图）
4. **动手实现**（step by step 敲代码，每段有解释）
5. **跑起来**（怎么测、预期输出）
6. **对照生产代码**（zmzai-agent 对应文件 + mini 版简化了什么、为什么）
7. **小结 + 下期预告**

## 写作原则

- **不假设读者读过前一期就记得细节**：每期开头 2-3 句回顾上期产出
- **代码必须能跑**：每期给完整的可运行代码，不省略 import
- **简化但不失真**：mini 版去掉产品复杂度（多租户/Mongo/relay），但核心机制和生产版一致
- **讲为什么，不只讲怎么做**：每个设计决策都解释取舍
- **对照真实代码**：每期指向 zmzai-agent 的对应文件，让读者能去看生产实现

## 一个要提前定的技术决策

mini-agent 用什么跑 LLM？两个选项：

- **A. 直连 OpenAI 兼容接口**（读者填自己的 base_url + api_key，可接 DeepSeek/OpenAI/任何兼容端点）——最通用，读者零门槛
- **B. 用 zmzai-relay**——和产品一致但要部署 relay，门槛高

我建议 **A**：mini-agent 直连，配置项给 `base_url` + `api_key` + `model`，读者填 DeepSeek 或 OpenAI 都行。这样教程不绑定任何特定平台，受众最广。产品层的 relay/multi-tenant 在第 8 期作为「生产化方向」提一句即可。

---

## 待你确认

1. **8 期的划分和顺序** OK 吗？要不要增删/调整？
2. **难度曲线**（3-4 期是高峰）能接受吗？要不要把第 4 期拆成两期降低密度？
3. **LLM 接入用方案 A（直连）** 可以吗？
4. 确认后我从**第 1 期**开始写，每期一个独立 md 文件放 `muzhi/content/blog/` 或 `muzhi/docs/tutorial/`。
