# 第 7 期：上下文压缩——对话太长怎么办

> **从零造一个 Coding Agent 框架 · 第 7 期（共 8 期）**
>
> agent 聊久了会撞墙——对话历史越来越长，直到超过模型的上下文窗口，请求直接报错。这期我们造压缩机制：在撞墙之前，把旧历史压成摘要，保留近期原文。

---

## 这期解决什么问题

每个模型有上下文窗口（DeepSeek 64K，GPT-4 128K）。agent 多轮对话 + 工具结果（尤其 bash 输出可能很长），历史会迅速膨胀。

如果不处理：历史超窗口 → API 报错 → agent 崩。

处理方式：**在接近窗口上限时，把较早的历史压成一段摘要，保留最近几轮原文。** 模型看到的是「摘要 + 近期对话」，而不是全部历史。

---

## 先看效果

这期结束，agent 长对话时会在后台自动压缩。你能看到压缩发生的边界：

```
... 第 8 轮 ...
📐 触发压缩：估算 52000 tokens，窗口 64000，阈值 0.85
   保留最近 6 条消息，将前 14 条压成摘要...
   ✅ 摘要已生成（1800 tokens），上下文降至 12000 tokens

... 第 9 轮（基于压缩后的上下文）...
```

---

## 原理

### 什么时候触发

不能等超窗口了才压（已经报错了）。要在**接近**上限时触发。经验阈值：**85% 窗口**（zmzai 默认 0.85）。

```
估算 tokens / 窗口大小 ≥ 0.85  →  触发压缩
```

token 估算用最简单的 `chars / 4`（英文约 4 字符一个 token）。不精确，但够做阈值判断——精确的让模型端算。

### 压缩策略：head 摘要 + tail 原文

```
全部历史 [msg1, msg2, ..., msg20]
              ↓ 压缩
[摘要(msg1..msg14), msg15, msg16, ..., msg20]
   head 压成摘要         tail 保留原文（最近 N 条）
```

- **head**（较早的）：压成一段摘要（用便宜模型生成）
- **tail**（最近的）：原样保留——最近几轮通常最重要（当前任务的上下文）

### 为什么用便宜模型生成摘要

摘要不需要主模型的推理能力——它是机械的「把对话浓缩」。用便宜/小模型生成，省时省钱。主模型专心干活。

---

## 动手实现

### Step 1：token 估算

```ts
// compaction.ts
import type { Message } from "./types.js";

/** 粗略 token 估算：chars/4。够做阈值判断，精确的交给模型端 */
function estimateTokens(messages: Message[]): number {
  let total = 0;
  for (const msg of messages) {
    if (msg.role === "user") {
      total += Math.ceil(msg.content.length / 4);
    } else {
      for (const part of msg.parts) {
        if (part.type === "text") total += Math.ceil(part.text.length / 4);
        else if (part.type === "tool" && part.state.status === "completed") {
          total += Math.ceil(part.state.output.length / 4);
        }
      }
    }
  }
  return total;
}
```

### Step 2：摘要生成（调便宜模型）

```ts
import { streamChatWithRetry, type LlmConfig } from "./llm.js";

const SUMMARY_INSTRUCTION = `把以下对话压缩成一份工作摘要，保留：任务目标、已完成的关键步骤与工具结果、当前进度、待办事项、重要的文件路径/命令/产物。只输出结构化摘要，不要续写对话。`;

/**
 * 用便宜模型把一段历史压成摘要。
 * 注意：用单独的 config（可以指向更便宜的模型）。
 */
async function summarize(
  config: LlmConfig,
  messages: Message[],
): Promise<string> {
  // 把历史转成纯文本喂给摘要模型
  const transcript = messages.map((m) => {
    if (m.role === "user") return `用户：${m.content}`;
    const text = m.parts
      .filter((p) => p.type === "text" || p.type === "tool")
      .map((p) => p.type === "text" ? p.text : `[工具 ${p.tool}: ${p.state.status === "completed" ? p.state.output.slice(0, 200) : p.state.status}]`)
      .join(" ");
    return `助手：${text}`;
  }).join("\n");

  let summary = "";
  await streamChatWithRetry(
    config,
    {
      systemPrompt: SUMMARY_INSTRUCTION,
      messages: [{ role: "user", content: transcript }],
      // 摘要不需工具
    },
    (event) => {
      if (event.type === "text") summary += event.delta;
    },
  );
  return summary || "（摘要生成失败）";
}
```

### Step 3：压缩变换（核心）

```ts
export type CompactionOptions = {
  contextWindow: number;      // 模型窗口大小（tokens）
  ratio: number;              // 触发阈值（默认 0.85）
  keepRecent: number;         // 保留最近几条消息（默认 6）
  summaryConfig: LlmConfig;   // 摘要用的模型配置（便宜模型）
  onCompacted?: (summary: string, tokensBefore: number) => void;  // 回调
};

/**
 * 上下文压缩变换。
 * 返回压缩后的消息列表。不需要压缩时返回原样。
 */
export async function compactIfNeeded(
  messages: Message[],
  options: CompactionOptions,
): Promise<{ messages: Message[]; compacted: boolean }> {
  const tokens = estimateTokens(messages);
  const threshold = options.contextWindow * options.ratio;

  // 没超阈值：不压
  if (tokens < threshold) return { messages, compacted: false };

  // 消息太少：不值得压
  if (messages.length <= options.keepRecent + 1) return { messages, compacted: false };

  // 切分：head 压摘要，tail 保留
  const tail = messages.slice(-options.keepRecent);
  const head = messages.slice(0, -options.keepRecent);

  // 生成摘要（失败则降级：返回原文，不硬崩）
  let summary: string;
  try {
    summary = await summarize(options.summaryConfig, head);
  } catch (error) {
    // 摘要失败 → 不压缩，用原文（可能超窗口，但比崩掉好）
    console.error("压缩失败，降级为全量上下文：", error);
    return { messages, compacted: false };
  }

  options.onCompacted?.(summary, tokens);

  // 摘要作为一条 user 消息（标记为压缩摘要）
  const summaryMessage: Message = {
    id: `msg_summary_${Date.now()}`,
    sessionId: "",
    role: "user",
    content: `【早期对话摘要】\n${summary}`,
    createdAt: new Date().toISOString(),
  };

  return { messages: [summaryMessage, ...tail], compacted: true };
}
```

**三个设计决策**：

1. **降级而非崩掉**：摘要生成失败时，返回原文（`compacted: false`）。可能超窗口，但让模型端报错比我们自己崩更可恢复——也许下一个请求历史没那么长。

2. **摘要作为 user 消息**：为什么不是 system？因为 system 是固定的（每个会话一样），摘要是动态的。而且「这是之前对话的浓缩」语义上更像用户给的背景。

3. **保留最近 N 条**：tail 是原样保留的——最近几轮是当前任务的直接上下文，压了会丢关键信息。`keepRecent` 默认 6。

### Step 4：接到循环里

在第 4 期的 `runAgent` 循环里，每次调 LLM 前先压缩：

```ts
// loop.ts 的循环内，调 streamChatWithRetry 之前：
const chatMessages = toChatMessages(messages);

// 【新增】压缩检查
const { messages: compactedMessages } = await compactIfNeeded(messages, {
  contextWindow: 64000,        // 按你的模型调
  ratio: 0.85,
  keepRecent: 6,
  summaryConfig: { ...config, model: "deepseek-chat" },  // 可以用更便宜的模型
  onCompacted: (summary, before) => {
    console.log(`📐 压缩：${before} tokens → 摘要 ${Math.ceil(summary.length / 4)} tokens`);
  },
});
const finalChatMessages = toChatMessages(compactedMessages);

await streamChatWithRetry(config, { systemPrompt, messages: finalChatMessages, tools }, /* ... */);
```

**注意**：压缩只影响**发给 LLM 的上下文**，不修改 `messages` 原数组（原始历史保留在 store 里）。这是「投影」思想——模型看到的是压缩投影，存储的是完整真相。

---

## 跑起来

构造一个长对话，观察压缩触发：

```ts
// demo.ts
import { compactIfNeeded } from "./compaction.js";
import type { Message } from "./types.js";

// 模拟一个长历史（20 条消息，每条 12000 字符 ≈ 3000 tokens，共 ≈ 60000 > 阈值 54400）。
// 注意数据量要够：如果每条只有 3000 字符（≈ 750 tokens），总量才 15000 tokens，远达不到阈值，不会触发压缩
const longHistory: Message[] = Array.from({ length: 20 }, (_, i) => ({
  id: `msg_${i}`,
  sessionId: "",
  role: i % 2 === 0 ? "user" : "assistant",
  ...(i % 2 === 0
    ? { content: "x".repeat(12000), createdAt: new Date().toISOString() }
    : { parts: [{ id: `prt_${i}`, messageId: "", type: "text" as const, text: "y".repeat(12000) }], createdAt: new Date().toISOString() }),
})) as Message[];

const result = await compactIfNeeded(longHistory, {
  contextWindow: 64000,
  ratio: 0.85,
  keepRecent: 6,
  summaryConfig: { baseUrl: "...", apiKey: process.env.API_KEY!, model: "deepseek-chat" },
  onCompacted: (summary, before) => console.log(`压缩：${before} tokens → ${summary.length} 字符摘要`),
});

console.log(`压缩前 ${longHistory.length} 条 → 压缩后 ${result.messages.length} 条`);
```

跑（需要 API_KEY，因为真调模型生成摘要）：

```bash
API_KEY=sk-xxx npx tsx demo.ts
```

你会看到 20 条被压成 7 条（1 条摘要 + 6 条原文 tail）。

---

## 对照生产代码

zmzai-agent 的压缩在 `packages/agent-framework/src/core/runtime/compaction.ts`（124 行），对比：

| 方面 | mini 版 | 生产版 | 差异 |
|---|---|---|---|
| 触发 | 85% 窗口 | 85% 窗口（`defaultCompactRatio`） | **一致** |
| token 估算 | chars/4 | chars/4（`fallbackTokPerChar=0.25`） | **一致** |
| 策略 | head 摘要 + tail 原文 | head 摘要 + tail 原文 | **一致** |
| 失败降级 | 返回原文 | 返回原文 | **一致** |
| 摘要模型 | 独立 config | 独立 summaryModel 注入 | 一致 |
| 边界标记 | 无 | 写 `compaction` Part 到 transcript | 生产可审查 |

**生产版的已知局限（我们研究 Reasonix/dsh 后明确的改进方向）**：
- 当前压缩会**重写历史**（head → 摘要消息），这会击穿前缀缓存。Reasonix 的做法是投影式（canonical 不动 + 摘要放投影层）
- 没有按工具结果大小的细粒度压缩（Reasonix 有「失败日志只保留错误行」的智能裁剪）
- 没有并发锁 / 稳定性检查（dsh 有「摘要必须更小才提交」的校验）

这些都是 mini 版和生产版都有的局限，是指引未来演进的方向，不影响当前能跑。

---

## 小结

这期我们：

1. **搞懂了压缩的触发与策略**：85% 阈值触发，head 压摘要 + tail 保留原文
2. **实现了 compactIfNeeded**：估算 token → 切分 → 调便宜模型生成摘要 → 失败降级
3. **接到了循环**：每轮调 LLM 前检查，压缩只影响发给模型的上下文（不动原始历史）

**最该记住的一点**：压缩是「投影」不是「修改」——原始历史永远完整保留在 store 里，压缩只改变「模型看到什么」。这样既控制了上下文大小，又不丢失任何信息（事后能完整回放）。

---

## 下期预告

**第 8 期：组装与收尾——拼成一个能用的 mini agent**

最后一期！我们把前 7 期的模块拼起来，做一个可交互的命令行 agent：输入任务 → 流式输出 → 工具卡片 → 权限询问 → 多轮推理。然后回顾整个框架的设计哲学，指向 zmzai-agent 生产代码。

> **课后小练习**（可选）：现在的压缩是「整体摘要」。试着加一个更细的策略：**工具结果超过一定长度就单独压缩**（比如 bash 输出超 3000 tokens，压成"构建成功，3 个警告"）。提示：这是 Reasonix 的 `failure_snip` 思路——保留失败行，裁掉通过的噪音。想想哪些工具结果值得这样处理？
