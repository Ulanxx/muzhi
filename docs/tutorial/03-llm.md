# 第 3 期：LLM 调用层——流式、工具调用解析、容错

> **从零造一个 Coding Agent 框架 · 第 3 期（共 8 期）**
>
> 这是系列的**第一个难度高峰**。前两期都是同步逻辑（定义类型、写工具），这期要处理流式数据——文本、思考、工具调用都是**分片到达**的，得把它们正确拼起来。如果这期啃下来，第 4 期的循环就轻松了。

---

## 这期解决什么问题

调一个 LLM 听起来简单——`fetch` 一个接口，拿回结果。但当你想要**流式输出**（用户想看到字一个一个蹦出来），事情就复杂了。

OpenAI 兼容的流式接口返回的是 **SSE（Server-Sent Events）**，一串 `data: {...}` 行，每行是一个增量。问题在于：

1. **三种内容混合**：文本（`content`）、思考链（`reasoning_content`）、工具调用（`tool_calls`），可能在一轮里交替出现
2. **工具调用是分片的**：一个工具调用的参数 JSON 会被切成好几片到达，`{"path":"src` → `/index` → `.ts"}`，你要累积完才能 `JSON.parse`
3. **容错**：网络会断、上游会返回空响应、JSON 会损坏

这期我们写一个 `llm.ts`，把这些问题全解决。

---

## 先看效果

这期结束，你能流式调用一个真实模型，实时看到：

```
💭 思考：用户想读 package.json，调用 read 工具...

🔧 工具调用: read({ path: "package.json" })

📝 文本：这个项目的 package.json 内容如下...
（流式逐字输出）
```

而且工具调用的参数（哪怕是分片到达的）能被正确拼成一个完整 JSON。

---

## 原理

### SSE 流式格式

LLM 流式接口返回的是这样的：

```
data: {"choices":[{"delta":{"content":"你"}}]}
data: {"choices":[{"delta":{"content":"好"}}]}
data: {"choices":[{"delta":{"reasoning_content":"先想想..."}}]}
data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read","arguments":"{\"pa"}}]}}]}
data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\":\"src\"}"}}]}}]}
data: [DONE]
```

每一行 `data:` 是一个 **chunk**，里面有个 `delta`。delta 有三种：
- `content`：文本增量（一个字或几个字）
- `reasoning_content`：思考链增量（推理模型才有）
- `tool_calls`：工具调用增量——**注意这里是按 index 分的，同一个工具调用的 name 和 arguments 会分多次到达**

### 工具调用累积：最难的部分

看上面第 4-5 行：同一个工具调用（index=0）的 `arguments` 被切成了两片：`{"pa` 和 `th\":\"src\"}`。你不能 `JSON.parse("{\"pa")`——那是损坏的。

正确做法：**按 index 累积 arguments 字符串，等流结束（`[DONE]`）再统一 parse**。

```
chunk 1: tool_calls[0].function.arguments = '{"pa'      }   累积
chunk 2: tool_calls[0].function.arguments = 'th":"src"}'   累积
                                                         ↓ [DONE]
拼接: '{"path":"src"}'  → JSON.parse → { path: "src" }
```

这就是为什么需要「累积器」而不是即时解析。

---

## 动手实现

### Step 1：定义输入输出类型

```ts
// llm.ts
import type { ModelRef } from "./types.js";

/** LLM 配置 */
export type LlmConfig = {
  baseUrl: string;       // OpenAI 兼容端点，如 https://api.deepseek.com/v1
  apiKey: string;
  model: string;         // 模型 id，如 deepseek-chat
};

/** 一次 LLM 请求的消息（OpenAI 格式） */
export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: ToolCallWire[] }
  | { role: "tool"; tool_call_id: string; content: string };

/** 工具调用（线缆格式） */
export type ToolCallWire = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

/** 流式事件（我们的 LLM 层发出来的） */
export type StreamEvent =
  | { type: "text"; delta: string }              // 文本增量
  | { type: "reasoning"; delta: string }          // 思考增量
  | { type: "tool_calls"; calls: ParsedToolCall[] }  // 工具调用（流结束时一次性发）
  | { type: "done"; usage?: { input: number; output: number } };

/** 解析后的工具调用（arguments 已 parse） */
export type ParsedToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};
```

**设计要点**：我们把 LLM 的流式输出抽象成自己的 `StreamEvent`——上层（第 4 期循环）不用关心 SSE 细节，只处理这四种事件。这是一个**适配器模式**：屏蔽底层协议差异。

### Step 2：流式调用核心

这是最核心的函数。我会写得很细，每段解释：

```ts
/**
 * 流式调用 LLM。
 * systemPrompt: 系统提示
 * messages: 对话历史
 * tools: 工具 schema 列表（第 2 期的 allToolsToSchema()）
 * onEvent: 每个流事件的回调
 */
export async function streamChat(
  config: LlmConfig,
  input: { systemPrompt: string; messages: ChatMessage[]; tools?: Record<string, unknown>[] },
  onEvent: (event: StreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const { systemPrompt, messages, tools } = input;

  // 组装请求体（OpenAI 兼容格式）
  const body = {
    model: config.model,
    messages: [{ role: "system", content: systemPrompt }, ...messages],
    ...(tools?.length ? { tools, tool_choice: "auto" } : {}),
    stream: true,
  };

  const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`LLM 请求失败：HTTP ${response.status} ${text.slice(0, 200)}`);
  }
  if (!response.body) throw new Error("LLM 返回了空响应体");

  // 进入流式解析
  await consumeStream(response.body, onEvent);
}
```

### Step 3：SSE 流解析 + 累积器（难点）

```ts
/** 累积中的工具调用，按 index 分组 */
type AccumulatingCall = { id: string; name: string; arguments: string };

async function consumeStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: StreamEvent) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";                        // SSE 行缓冲（一个 chunk 可能跨多行/不完整）
  const toolCalls = new Map<number, AccumulatingCall>();  // index → 累积中的工具调用
  let hasContent = false;                 // 是否收到过任何内容（用于空响应检测）

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE 按 \n\n 分隔事件，但 chunk 可能不完整——保留最后一段到下次
    const parts = buffer.split("\n");
    buffer = parts.pop() ?? "";           // 最后一段可能不完整，留着

    for (const line of parts) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") continue;  // 结束标记，循环外处理
      if (!hasContent) hasContent = true;

      // 解析 chunk
      let chunk: any;
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue;  // 损坏的行跳过（不致命）
      }

      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;

      // 1. 文本增量
      if (delta.content) {
        onEvent({ type: "text", delta: delta.content });
      }

      // 2. 思考链增量（DeepSeek 用 reasoning_content，有些模型用 reasoning 或 thinking）
      const reasoning = delta.reasoning_content ?? delta.reasoning ?? delta.thinking;
      if (reasoning) {
        onEvent({ type: "reasoning", delta: reasoning });
      }

      // 3. 工具调用增量——累积，不即时发
      if (delta.tool_calls) {
        for (const call of delta.tool_calls) {
          const index = call.index ?? 0;
          const existing = toolCalls.get(index) ?? { id: "", name: "", arguments: "" };
          if (call.id) existing.id = call.id;
          if (call.function?.name) existing.name = existing.name + call.function.name;  // name 也可能分片
          if (call.function?.arguments) existing.arguments += call.function.arguments;  // arguments 累积
          toolCalls.set(index, existing);
        }
      }

      // usage（通常在最后一个 chunk）
      if (chunk.usage) {
        // 留到 done 事件里发
      }
    }
  }

  // 流结束：发工具调用 + done
  if (toolCalls.size > 0) {
    const calls: ParsedToolCall[] = [];
    for (const acc of toolCalls.values()) {
      let argumentsValue: Record<string, unknown> = {};
      try {
        argumentsValue = JSON.parse(acc.arguments);
      } catch {
        // 参数 JSON 损坏——用一个标记对象，让上层报错给模型看
        argumentsValue = { __parse_error: acc.arguments.slice(0, 200) };
      }
      calls.push({ id: acc.id, name: acc.name, arguments: argumentsValue });
    }
    onEvent({ type: "tool_calls", calls });
  }

  // 空响应检测：整个流没有任何内容
  if (!hasContent && toolCalls.size === 0) {
    throw new Error("LLM 返回了空响应（上游未产出任何内容）");
  }

  onEvent({ type: "done" });
}
```

**逐段解释关键点**：

1. **buffer 切分**：一个网络 chunk 可能包含半个 SSE 行，也可能包含好几行。我们按 `\n` 切，**最后一段留到下次**（它可能不完整）。这是流式解析的标准套路。

2. **工具调用累积**：用 `Map<index, AccumulatingCall>`，arguments 只做字符串拼接，**不 parse**。等整个流结束才统一 parse。为什么？因为中间任何一片都是损坏的 JSON。

3. **name 也可能分片**：`call.function.name` 有些模型会分多次发，所以也用拼接（`existing.name + call.function.name`）。

4. **reasoning 字段兼容**：不同模型字段名不同（`reasoning_content` / `reasoning` / `thinking`），全兼容。

5. **空响应检测**：如果整个流读完了，既没文本、没思考、没工具调用——这是异常（上游出问题了），抛错而不是静默成功。

### Step 4：容错——重试一次

真实环境网络会抖。加一层简单重试：

```ts
/** 可重试的错误（网络/超时类） */
function isRetryable(message: string): boolean {
  const m = message.toLowerCase();
  return m.includes("terminated") || m.includes("econnreset") || m.includes("timeout") || m.includes("socket hang up");
}

/** 带重试的流式调用：网络类错误重试一次 */
export async function streamChatWithRetry(
  config: LlmConfig,
  input: { systemPrompt: string; messages: ChatMessage[]; tools?: Record<string, unknown>[] },
  onEvent: (event: StreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await streamChat(config, input, onEvent, signal);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!isRetryable(message) || signal?.aborted) throw error;
    // 等 250ms 重试一次
    await new Promise((r) => setTimeout(r, 250));
    await streamChat(config, input, onEvent, signal);  // 再失败就抛出去
  }
}
```

**为什么不无限重试？** 因为有些错误是确定性的（鉴权失败、余额不足），重试也没用。只重试网络类错误，且最多一次——生产环境（zmzai-agent）也是这个策略。

---

## 跑起来

写 `demo.ts`，你需要一个真实的 API key。以 DeepSeek 为例（也兼容 OpenAI）：

```ts
// demo.ts
import { streamChatWithRetry } from "./llm.js";
import { allToolsToSchema } from "./tools.js";

const config = {
  baseUrl: "https://api.deepseek.com/v1",  // 换成你的端点
  apiKey: process.env.API_KEY!,             // 环境变量传入
  model: "deepseek-chat",
};

// 一个会触发工具调用的对话
await streamChatWithRetry(
  config,
  {
    systemPrompt: "你是助手。可以用工具读取文件。",
    messages: [{ role: "user", content: "读一下当前目录有哪些 json 文件（用 glob 工具）" }],
    tools: allToolsToSchema(),
  },
  (event) => {
    switch (event.type) {
      case "reasoning":
        process.stdout.write(`\x1b[90m${event.delta}\x1b[0m`);  // 灰色
        break;
      case "text":
        process.stdout.write(event.delta);
        break;
      case "tool_calls":
        console.log("\n\n🔧 工具调用:");
        for (const call of event.calls) {
          console.log(`  ${call.name}(${JSON.stringify(call.arguments)})`);
        }
        break;
      case "done":
        console.log("\n\n✅ 完成");
        break;
    }
  },
);
```

跑：

```bash
API_KEY=sk-xxx npx tsx demo.ts
```

你会看到模型的思考链（灰色）、文本（正常色）流式输出，以及最后解析出的完整工具调用——**参数是正确的完整 JSON**，即使它分片到达。

---

## 对照生产代码

zmzai-agent 的 LLM 层在 `lib/relay-agent-stream.ts`（292 行），对比：

| 方面 | mini 版 | 生产版 | 差异 |
|---|---|---|---|
| 流式解析 | 手写 SSE 切分 | 手写 SSE 切分 | **核心逻辑一致** |
| 工具调用累积 | Map<index> 拼字符串 | Map<index> 拼字符串 | **完全一致** |
| 端点 | 直连模型厂商 | 走 zmzai-relay 网关 | 生产多了鉴权/计费/限流层 |
| 重试 | 网络错误重试 1 次 | 网络错误重试 1 次 + 5xx 重试 + 空响应重试 | 生产更全面 |
| usage 解析 | 留空 | 解析 prompt/completion tokens | 生产要计费 |

**去看生产版 `consumeTurn` 函数**（`relay-agent-stream.ts:188`），你会发现它的骨架和我们的 `consumeStream` 几乎一样——同样的 buffer 切分、同样的 Map 累积、同样的空响应检测。这期你写的就是生产代码的精简版。

---

## 小结

这期我们：

1. **搞懂了 SSE 流式格式**：`data:` 行 + delta 增量 + `[DONE]`
2. **解决了工具调用分片累积**：按 index 累积 arguments 字符串，流结束才 parse——这是整期最关键的技术点
3. **加了容错**：网络错误重试一次、空响应检测

**最该记住的一点**：流式数据「不要即时处理，要累积」。文本可以即时转发（它是自包含的），但工具调用的参数必须等完整了再 parse。这个「累积器」模式在第 4 期的循环里还会用到（累积成一整轮回复）。

---

## 下期预告

**第 4 期：Agent 循环——ReAct 的工程实现**

现在我们有了工具（第 2 期）和 LLM 调用（第 3 期）。下一步把它们拼成循环：LLM 调工具 → 我们执行工具 → 结果喂回 LLM → LLM 继续……直到它不再调工具。这是整个系列的概念密度峰值——PartProjector（流式事件转 Part）、消息格式转换、停止条件全在这期。

> **课后小练习**（可选）：给 `streamChat` 加一个「最大 token」参数（`max_tokens`），传到请求体里。想想：如果 LLM 输出被 max_tokens 截断了（finish_reason 是 "length"），我们的流解析还能正常工作吗？工具调用参数会不会只累积了一半？（提示：这就是为什么生产环境有「JSON 不闭合修复」逻辑。）
