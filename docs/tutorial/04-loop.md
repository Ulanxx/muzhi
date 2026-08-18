# 第 4 期：Agent 循环——ReAct 的工程实现

> **从零造一个 Coding Agent 框架 · 第 4 期（共 8 期）**
>
> 这是整个系列的**核心**。前三期我们造了零件（数据模型、工具、LLM 调用），这期把它们组装成一台能运转的机器——**Agent 循环**。概念密度最大，但只要这期通了，agent 在你眼里就不再神秘了。

---

## 这期解决什么问题

到目前为止，我们的 LLM 调用是**一次性的**：发消息 → 收回复 → 结束。但真正的 agent 不是这样的。

想象用户说「帮我读一下 package.json 然后总结」。agent 要做的是：

```
第 1 轮：LLM 说「我要调 read({path:"package.json"})」
         ↓ 我们执行 read，拿到文件内容
第 2 轮：LLM 看到内容，说「这个项目是...」（不再调工具）
         ↓ 循环结束
```

这个「LLM 决定调工具 → 我们执行 → 结果喂回去 → LLM 继续」的过程，就是 **ReAct 循环**（Reason + Act）。这期我们要把它实现出来。

同时还有一个配套问题：LLM 的流式输出（第 3 期的 `StreamEvent`）怎么变成我们第 1 期的 Part 模型？这需要一个「投影器」。

---

## 先看效果

这期结束，你能跑一个**真正的多轮 agent 任务**：

```
$ npx tsx demo.ts "读 package.json 然后总结这个项目"

━━━ 第 1 轮 ━━━
💭 用户想读配置文件...
🔧 read({"path":"package.json"})  ✅ 读取 package.json

━━━ 第 2 轮 ━━━
📝 这是一个 TypeScript 项目，名为 mini-agent...
   主要依赖 zod，开发依赖 typescript 和 tsx。

✅ 任务完成（2 轮）
```

看，agent 自己决定调工具、看到结果后自己总结、然后停止——**没有人工干预**。这就是 agent 的本质。

---

## 原理

### ReAct 循环的结构

```
         ┌─────────────────────────────────┐
         │                                  │
         ▼                                  │
    ┌─────────┐    有工具调用?    ┌─────┐   │
    │ 调 LLM  │ ──────────────► │ 执行 │   │
    │ (流式)  │                  │ 工具 │   │
    └─────────┘                  └─────┘   │
         │                          │       │
         │ 无工具调用               │ 结果   │
         ▼                          ▼       │
    ┌─────────┐              ┌──────────┐   │
    │ 结束    │              │ 结果回灌  │───┘
    │ (最终回复)│             │ 到消息历史│
    └─────────┘              └──────────┘
```

每一轮：
1. 把对话历史（含之前的工具调用 + 结果）发给 LLM
2. LLM 流式返回——可能是纯文本（结束），也可能带工具调用
3. 如果有工具调用：执行工具 → 把「assistant 调了工具」+「工具结果」加到历史 → 进下一轮
4. 如果没有：循环结束，这条文本就是最终回复

### 为什么需要「停止条件」

如果 LLM 一直调工具（陷入循环），程序会永远跑下去。所以要加上限：**最多 N 轮**（生产环境叫 `shouldStopAfterTurn`，zmzai 默认 12 轮）。

### PartProjector：流式事件 → Part

第 3 期的 LLM 层发出 `StreamEvent`（text delta / reasoning delta / tool_calls / done）。但第 1 期我们定义的数据模型是 `Part`（text / reasoning / tool / step-start / step-finish）。

这两个模型不一样——`StreamEvent` 是**面向流的**（delta 增量），`Part` 是**面向状态的**（完整内容 + 工具状态机）。需要一个投影器把前者 fold 成后者：

```
StreamEvent                    PartProjector              Part 流
───────────                    ─────────────              ────────
text("你")          ─┐
text("好")           ├─ 累积到 text part ──────────► text part ("你好")
text("世界")        ─┘
tool_calls([...])   ──────────► 新建 tool part        tool part (completed)
done                ──────────► 关闭 step-finish     step-finish
```

UI 看到的是 Part 流——它可以分别渲染思考（折叠）、文本（流式）、工具卡片（状态机）。

---

## 动手实现

### Step 1：消息格式转换

LLM 需要的是 OpenAI 格式的消息（`role` + `content`），我们的数据模型是 `Message`（第 1 期）。写个转换：

```ts
// loop.ts
import type { Message, Part } from "./types.js";
import type { ChatMessage, ToolCallWire } from "./llm.js";

/** 把内部的 Message[] 转成 LLM 要的 ChatMessage[] */
export function toChatMessages(messages: Message[]): ChatMessage[] {
  const result: ChatMessage[] = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      result.push({ role: "user", content: msg.content });
    } else {
      // assistant：从 parts 里提取文本 + 工具调用
      const text = msg.parts
        .filter((p): p is Extract<Part, { type: "text" }> => p.type === "text")
        .map((p) => p.text)
        .join("\n");
      const toolCalls = msg.parts
        .filter((p): p is Extract<Part, { type: "tool" }> => p.type === "tool" && p.state.status === "completed")
        .map<ToolCallWire>((p) => ({
          id: p.callId,
          type: "function" as const,
          function: { name: p.tool, arguments: JSON.stringify(p.state.input) },
        }));
      result.push({
        role: "assistant",
        content: text,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
      // 工具结果：每个 completed 的 tool part 对应一条 tool 消息
      for (const p of msg.parts) {
        if (p.type === "tool" && p.state.status === "completed") {
          result.push({ role: "tool", tool_call_id: p.callId, content: p.state.output });
        }
      }
    }
  }
  return result;
}
```

**关键点**：工具调用的结果必须作为 `role: "tool"` 消息回灌，且 `tool_call_id` 要和调用时的 id 对应。LLM 靠这个 id 把「我调的工具」和「返回的结果」匹配上。

### Step 2：PartProjector（流式 → Part）

```ts
import { newId } from "./types.js";

/**
 * 把一轮 LLM 的流式事件 fold 成 Part 数组。
 * 纯函数式：喂 StreamEvent，产出 Part 变更。
 */
export class PartProjector {
  private parts: Part[] = [];
  private textBuffer = "";
  private reasoningBuffer = "";

  /** 处理一个流事件，返回这步新增/变更的 Part */
  onEvent(event: StreamEvent): Part[] {
    switch (event.type) {
      case "text":
        // 累积文本，攒到一定量再 flush（避免逐字符产出太多 Part）
        this.textBuffer += event.delta;
        if (this.textBuffer.length >= 100) return this.flushText();
        return [];

      case "reasoning":
        this.reasoningBuffer += event.delta;
        return [];

      case "tool_calls": {
        // 流结束才一次性拿到完整工具调用
        const flushed = [...this.flushText(), ...this.flushReasoning()];
        for (const call of event.calls) {
          const part: Part = {
            id: newId("prt"),
            messageId: "",
            type: "tool",
            callId: call.id,
            tool: call.name,
            state: {
              status: "pending",
              input: call.arguments,
            },
          };
          this.parts.push(part);
          flushed.push(part);
        }
        return flushed;
      }

      case "done":
        // 流结束：flush 剩余缓冲
        return [...this.flushText(), ...this.flushReasoning()];
    }
    return [];
  }

  private flushText(): Part[] {
    if (!this.textBuffer) return [];
    const part: Part = {
      id: newId("prt"),
      messageId: "",
      type: "text",
      text: this.textBuffer,
    };
    this.parts.push(part);
    this.textBuffer = "";
    return [part];
  }

  private flushReasoning(): Part[] {
    if (!this.reasoningBuffer) return [];
    const part: Part = {
      id: newId("prt"),
      messageId: "",
      type: "reasoning",
      text: this.reasoningBuffer,
    };
    this.parts.push(part);
    this.reasoningBuffer = "";
    return [part];
  }

  /** 获取这轮产生的所有 Part（流结束后调用） */
  getParts(): Part[] {
    return [...this.parts];
  }
}
```

**为什么文本要缓冲？** 如果每个 delta（可能就一个字）都产出一个 Part，Part 数量爆炸。攒到 100 字符再 flush，平衡了实时性和数量。生产版（zmzai-agent）用 2KB 阈值，道理一样。

### Step 3：Agent 循环

这是核心。一步步来：

```ts
import { streamChatWithRetry, type LlmConfig, type StreamEvent } from "./llm.js";
import { findTool, allToolsToSchema } from "./tools.js";

export type LoopOptions = {
  config: LlmConfig;
  systemPrompt: string;
  maxSteps: number;            // 最多几轮（停止条件）
  cwd: string;                 // 工作目录
  /** 每个 Part 变更的回调（UI 实时渲染用） */
  onPart?: (part: Part) => void;
};

/**
 * Agent 循环：prompt → ReAct 循环 → 最终回复。
 * 返回完整的 assistant Message（含所有 Part）。
 */
export async function runAgent(
  history: Message[],          // 已有对话历史（会被追加）
  userPrompt: string,
  options: LoopOptions,
): Promise<Message[]> {
  const { config, systemPrompt, maxSteps, cwd, onPart } = options;

  // 1. 把用户输入加入历史
  const messages: Message[] = [
    ...history,
    { id: newId("msg"), sessionId: "", role: "user", content: userPrompt, createdAt: new Date().toISOString() },
  ];

  const tools = allToolsToSchema();

  // 2. ReAct 循环
  for (let step = 0; step < maxSteps; step++) {
    // 2a. 调 LLM（流式）
    const projector = new PartProjector();
    const chatMessages = toChatMessages(messages);

    let hasToolCalls = false;
    let toolCalls: import("./llm.js").ParsedToolCall[] = [];

    await streamChatWithRetry(
      config,
      { systemPrompt, messages: chatMessages, tools },
      (event: StreamEvent) => {
        const newParts = projector.onEvent(event);
        for (const part of newParts) onPart?.(part);  // 实时回调 UI
        if (event.type === "tool_calls") {
          hasToolCalls = true;
          toolCalls = event.calls;
        }
      },
    );

    // 2b. 收集这轮的 Part，组装 assistant message
    const parts = projector.getParts();
    const assistantMessage: Message = {
      id: newId("msg"),
      sessionId: "",
      role: "assistant",
      parts,
      createdAt: new Date().toISOString(),
    };

    // 2c. 如果有工具调用：执行工具，更新 tool part 状态，把结果加入历史
    if (hasToolCalls) {
      for (const call of toolCalls) {
        const toolPart = parts.find(
          (p): p is Extract<Part, { type: "tool" }> => p.type === "tool" && p.callId === call.id,
        );
        if (toolPart) {
          // 执行工具
          toolPart.state = { status: "running", input: call.arguments, startedAt: new Date().toISOString() };
          onPart?.(toolPart);

          const def = findTool(call.name);
          if (!def) {
            toolPart.state = {
              status: "error",
              input: call.arguments,
              error: `未知工具：${call.name}`,
              endedAt: new Date().toISOString(),
            };
          } else {
            try {
              const result = await def.execute(call.arguments as never, { cwd });
              toolPart.state = {
                status: "completed",
                input: call.arguments,
                output: result.output,
                title: result.title,
                endedAt: new Date().toISOString(),
              };
            } catch (error) {
              toolPart.state = {
                status: "error",
                input: call.arguments,
                error: error instanceof Error ? error.message : String(error),
                endedAt: new Date().toISOString(),
              };
            }
          }
          onPart?.(toolPart);  // 通知 UI 工具执行完了
        }
      }
      messages.push(assistantMessage);
      continue;  // 进下一轮
    }

    // 2d. 没有工具调用：循环结束，这条就是最终回复
    messages.push(assistantMessage);
    break;
  }

  return messages;
}
```

**循环的三种结局**：
1. LLM 不调工具了 → 正常结束（break）
2. 达到 maxSteps → 强制结束（for 循环跑完）
3. 抛异常（网络/上游错误）→ 向上传播

### Step 4：补充——处理 LLM 多轮工具调用

注意一个细节：一轮 LLM 回复里可能包含**多个工具调用**（比如同时 read 两个文件）。我们的循环已经处理了——`for (const call of toolCalls)` 遍历执行所有调用，全完成后才进下一轮。生产环境里这是**串行执行**（zmzai-agent 也是串行，出于权限和一致性的考虑）。

---

## 跑起来

写 `demo.ts`，跑一个真实的多轮任务：

```ts
// demo.ts
import { runAgent } from "./loop.js";
import type { Part } from "./types.js";

const config = {
  baseUrl: "https://api.deepseek.com/v1",
  apiKey: process.env.API_KEY!,
  model: "deepseek-chat",
};

const task = process.argv[2] ?? "读 package.json 然后总结这个项目";

// 实时打印每个 Part
const onPart = (part: Part) => {
  if (part.type === "text") process.stdout.write(`  📝 ${part.text}\n`);
  else if (part.type === "reasoning") process.stdout.write(`  💭 ${part.text.slice(0, 100)}...\n`);
  else if (part.type === "tool") {
    const state = part.state;
    if (state.status === "completed") console.log(`  🔧 ${part.tool} ✅ ${state.title}`);
    else if (state.status === "error") console.log(`  🔧 ${part.tool} ❌ ${state.error}`);
    else if (state.status === "running") console.log(`  🔧 ${part.tool} ⏳ 执行中...`);
  }
};

console.log(`任务：${task}\n`);
const messages = await runAgent([], task, {
  config,
  systemPrompt: "你是助手。用工具完成任务。简洁回答。",
  maxSteps: 8,
  cwd: process.cwd(),
  onPart,
});

console.log(`\n✅ 完成（${messages.filter((m) => m.role === "assistant").length} 轮）`);
```

跑：

```bash
API_KEY=sk-xxx npx tsx demo.ts "读 package.json 然后总结"
```

你会看到 agent 第 1 轮调 `read`、第 2 轮总结——**一个完整的多轮 agent 就跑起来了**。

---

## 对照生产代码

zmzai-agent 的循环在 `runner.ts` 的 `runLoop`（593 行），投影器在 `pi-bridge.ts` 的 `PartProjector`（281 行）。对比：

| 方面 | mini 版 | 生产版 | 差异 |
|---|---|---|---|
| 循环结构 | for + break | for + shouldStopAfterTurn + 队列续跑 | 生产支持运行中排队新 prompt |
| 投影器 | 手写 fold | 手写 fold（PartProjector） | **核心一致** |
| 工具执行 | 直接调 execute | beforeToolCall 权限闸 → execute → afterToolCall | 生产多了权限（第 5 期） |
| 重试 | LLM 层重试（第 3 期） | LLM 层 + 循环层双重重试 | 生产更全面 |
| 底层引擎 | 手写循环 | PI agent-core 驱动 | 生产用成熟库，mini 手写理解原理 |

**去看生产版 `pi-bridge.ts` 的 `PartProjector`**，它的 `onTextDelta` / `onToolExecutionStart` / `onToolExecutionEnd` 和我们的 `onEvent` 是同一个模式——流式事件 fold 成 Part 状态。`serializeEmit`（顺序保证）是 mini 版没做的增强（异步持久化时保证事件顺序）。

---

## 小结

这期我们：

1. **实现了 ReAct 循环**：LLM → 有工具？执行+回灌 → 继续 ：结束
2. **写了 PartProjector**：把流式 StreamEvent fold 成 Part（文本缓冲、工具状态机）
3. **搞定了消息格式转换**：内部 Message ↔ OpenAI ChatMessage（含 tool_calls + tool 结果回灌）

**最该记住的一点**：agent 的「智能」不在循环代码里——循环只是一个 `while(true)` 加停止条件。智能来自 LLM 自己决定「要不要调工具、调哪个、看完结果怎么办」。我们写的全部是**把 LLM 的决策落地成执行**的 plumbing。

到这期为止，你已经有一个**能用的 agent 了**——它能读文件、跑命令、多轮推理。后面 4 期是给它加上「护栏」（权限、存储、事件、压缩），让它从「能用」变成「可靠」。

---

## 下期预告

**第 5 期：权限系统——不能让 agent 乱删文件**

现在我们的 agent 能跑 bash 命令，但没有任何拦截——如果 LLM 决定跑 `rm -rf /`，它就真跑了。第 5 期我们造一道权限闸口：工具执行前先问「这个操作允许吗」，用户批准了才执行。涉及 Ruleset DSL、通配匹配、三态审批（once/always/reject）。

> **课后小练习**（可选）：现在我们的循环里，工具执行是「直接调 execute」。如果某个工具执行抛异常，循环会怎样？（提示：看 `catch` 块——错误变成 tool part 的 error 状态，喂回 LLM。LLM 看到错误会怎么做？试着让 agent 调一个不存在的工具，观察它的反应。）
