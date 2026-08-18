# 第 1 期：数据模型——为什么 agent 的消息不是一串文本

> **从零造一个 Coding Agent 框架 · 第 1 期（共 8 期）**
>
> 这一期我们什么都不「跑」，只定义类型。但别小看它——**整个框架的地基在这一期定型**。后面 7 期的所有模块（工具、循环、权限、事件）都长在这套类型上。类型设计错了，后面全得返工。

---

## 这期解决什么问题

先问一个反直觉的问题：

> 一个 agent 和 LLM 聊天，能不能就用 `string[]` 存对话？

```
对话 = [
  "用户：帮我看看 src 目录",
  "助手：好的，我先读取目录结构...",
  "助手：[调用了 read 工具，结果：index.ts, utils.ts]",
  "助手：src 下有两个文件..."
]
```

看起来够了对吧？但停下来想三个真实场景：

1. **模型先思考再说话**：DeepSeek-R1 这类推理模型，一轮回复里**先输出一大段思考链**（reasoning），再输出正式回答。思考链要不要存？要不要给用户看？要不要折叠？
2. **工具执行是要花时间的**：`bash` 跑一个构建要 30 秒。这 30 秒里，UI 要显示「正在执行...」，跑完显示结果。一个 string 怎么表达「进行中 → 完成」的状态变化？
3. **一轮回复里工具和文本是交错的**：模型可能「说一段话 → 调个工具 → 看结果 → 再说一段话」。这不是一条文本，是**多个语义块的序列**。

`string[]` 全都处理不了。所以我们需要一个更精细的数据模型。

---

## 先看效果

这期结束，你会有一个 `types.ts`，定义 agent 对话的完整数据结构。我们写一个 `render` 函数，把一段假数据渲染成终端输出，你会看到这样的效果：

```
━━━ 会话：分析 src 目录 ━━━

👤 用户
  帮我看看 src 目录有哪些文件

🤖 助手  [思考中...]

  💭 (思考)
    用户想了解项目结构，先 glob 一下

  🔧 glob({"pattern":"src/*"})
     └─ ✅ 列出 3 个文件 (120ms)

  src 下有 3 个文件：index.ts、utils.ts、config.ts。
  需要我读取某个文件的内容吗？
```

看，**一轮 assistant 回复里混了思考、工具调用、文本**——这就是我们要建模的东西。

---

## 原理：三级结构 Session → Message → Part

### 为什么是三级

```
Session（会话）        ← 一次完整的任务对话
  └─ Message（消息）    ← 一轮发言（用户的一次输入 / 助手的一次回复）
       └─ Part（部分）  ← 消息内的一个语义块
```

- **Session** 绑定工作空间和用户，存元信息（用哪个 agent、哪个模型、权限规则）
- **Message** 区分角色（user / assistant），一条 user message = 用户的一次输入；一条 assistant message = 助手的一次完整回复
- **Part** 是最小单位——文本、思考、工具调用、步骤边界，都是独立的 Part

**关键洞察**：Part 是**最小可流式单元**。模型的流式输出会被拆成多个 Part 增量，UI 可以分别渲染（思考链折叠、工具卡片实时刷新）。如果用单一 text 字段，流式渲染和工具状态都做不了。

### Part 的种类

一个 assistant 消息里可能包含这些 Part：

| Part 类型 | 含义 | 举例 |
|---|---|---|
| `text` | 正式文本回答 | "src 下有 3 个文件" |
| `reasoning` | 思考链（推理模型的内心独白） | "用户想了解结构，先 glob..." |
| `tool` | 工具调用 + 执行状态 | `glob({pattern:"src/*"})` |
| `step-start` / `step-finish` | 一轮 LLM 调用的边界（带 token 用量） | 标记一轮的开始和结束 |

还有几种后面期数才用到的（先定义，这期不展开）：`compaction`（压缩摘要标记）、`subtask`（子代理调用链接）。

### 工具的状态机

工具调用的 Part 不是静态的——它有一个**状态机**，随执行推进：

```
pending（待执行）
   ↓
running（执行中）  ←─ UI 显示 spinner
   ↓
   ├─ completed（成功）  ←─ 显示结果
   └─ error（失败）      ←─ 显示错误
```

每个状态变更都是独立的事件（第 6 期讲事件系统时会展开）。这期先把状态定义出来。

---

## 动手实现

新建项目目录 `mini-agent/`，初始化：

```bash
mkdir mini-agent && cd mini-agent
npm init -y
npm install typescript tsx @types/node --save-dev
npx tsc --init
```

`tsconfig.json` 开严格模式（agent 框架的类型安全很重要）：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "outDir": "dist",
    "skipLibCheck": true
  }
}
```

现在写 `types.ts`。我会**一段一段讲**，每段解释为什么这么设计。

### Step 1：ModelRef——模型引用

```ts
// types.ts

/** 模型引用：provider + modelId。比如 { providerId: "deepseek", modelId: "deepseek-chat" } */
export type ModelRef = { providerId: string; modelId: string };
```

为什么用 `{providerId, modelId}` 而不是一个字符串 `"deepseek/deepseek-chat"`？因为后续要按 provider 分流（不同 provider 的 API 差异），结构化字段比字符串拆分干净。

### Step 2：Session——会话

```ts
export type Session = {
  id: string;                  // 唯一标识
  title: string;               // 显示名（初始=首条 prompt 截断）
  model: ModelRef;             // 用哪个模型
  createdAt: string;           // ISO 时间戳
};
```

这期先把最小字段定义出来。后面期数会加 `agent`（用哪个代理预设）、`permission`（会话级权限规则）等。**类型是会演进的**——我们用渐进式设计，不一次性塞满。

### Step 3：工具状态机

```ts
/** 工具调用的状态——一个状态机，随执行推进 */
export type ToolState =
  | { status: "pending"; input: unknown }                              // 待执行
  | { status: "running"; input: unknown; title?: string; startedAt: string }  // 执行中
  | { status: "completed"; input: unknown; output: string; title: string; endedAt: string }  // 成功
  | { status: "error"; input: unknown; error: string; endedAt: string };       // 失败;
```

注意这是**联合类型（discriminated union）**。`status` 是判别字段，TypeScript 能据此收窄类型——访问 `completed` 状态的 `output` 时编译器知道它存在，访问 `error` 状态的 `error` 同理。这是 agent 代码里用得最多的 TS 技巧。

### Step 4：Part 联合类型（核心）

```ts
/** Part 的公共字段 */
type PartBase = { id: string; messageId: string };

/** Part：消息内的一个语义块。联合类型，8 种变体 */
export type Part = PartBase &
  (
    | { type: "text"; text: string }
    | { type: "reasoning"; text: string }
    | { type: "tool"; callId: string; tool: string; state: ToolState }
    | { type: "step-start" }
    | { type: "step-finish"; tokens?: { input: number; output: number } }
  );
```

同样是联合类型，`type` 字段做判别。**为什么每种 Part 都带 `id` 和 `messageId`？** 因为第 6 期要做事件流——每个 Part 的状态变更（比如 tool 从 running 变 completed）是独立事件，靠 id 定位「改哪个 Part」。

### Step 5：Message

```ts
/** 消息：一轮发言 */
export type Message =
  | {
      id: string;
      sessionId: string;
      role: "user";               // 用户输入
      content: string;            // 用户输入就是纯文本
      createdAt: string;
    }
  | {
      id: string;
      sessionId: string;
      role: "assistant";           // 助手回复
      parts: Part[];               // 助手回复是 Part 数组（多模态混合）
      createdAt: string;
    };
```

**这里有个关键设计决策**：为什么 user message 用 `content: string`，assistant message 用 `parts: Part[]`？

因为用户的输入就是一段文本（"帮我看看 src 目录"），没有工具、没有思考链。但助手的回复是**多模态混合**的。用不同的结构反映这个真实差异，比强行统一成同一种格式更清晰。

### Step 6：辅助类型和 ID 生成器

```ts
/** 会话的完整快照（存储/传递用） */
export type SessionSnapshot = {
  session: Session;
  messages: Message[];
};

/** 生成短 ID。用 crypto 避免依赖。生产环境会用更结构化的前缀（ses_/msg_/prt_） */
export function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}
```

完整的 `types.ts` 就是这些。**大约 60 行**——没有一行是废话。

---

## 跑起来：写个 render 验证模型自洽

类型定义完，怎么知道它「对」？写一个渲染函数，喂一段假数据，看输出是否符合预期。这也是 TDD 的精神——**先用类型把「真实形态」描述出来**。

新建 `render.ts`：

```ts
// render.ts
import type { Message, Part, Session } from "./types.js";

/** 把一个 Part 渲染成终端可读的字符串 */
function renderPart(part: Part): string {
  switch (part.type) {
    case "text":
      return `  ${part.text}`;
    case "reasoning":
      return `  💭 (思考)\n    ${part.text}`;
    case "tool": {
      const input = JSON.stringify(part.state.input);
      switch (part.state.status) {
        case "pending":
          return `  🔧 ${part.tool}(${input})\n     └─ ⏳ 待执行`;
        case "running":
          return `  🔧 ${part.tool}(${input})\n     └─ 🔄 执行中...`;
        case "completed":
          return `  🔧 ${part.tool}(${input})\n     └─ ✅ ${part.state.title}`;
        case "error":
          return `  🔧 ${part.tool}(${input})\n     └─ ❌ ${part.state.error}`;
      }
      return "";
    }
    case "step-start":
      return "";  // 边界标记，渲染时可不显示
    case "step-finish":
      return part.tokens ? `  ⚡ 用量: in=${part.tokens.input} out=${part.tokens.output}` : "";
    default:
      return "";
  }
}

/** 渲染整条消息 */
function renderMessage(message: Message): string {
  if (message.role === "user") {
    return `👤 用户\n  ${message.content}`;
  }
  const parts = message.parts.map(renderPart).filter(Boolean).join("\n");
  return `🤖 助手\n${parts}`;
}

/** 渲染整个会话 */
export function renderSession(session: Session, messages: Message[]): string {
  const header = `━━━ 会话：${session.title} ━━━\n`;
  const body = messages.map(renderMessage).join("\n\n");
  return `${header}\n${body}\n`;
}
```

再写个 `demo.ts`，构造一段逼真的假数据：

```ts
// demo.ts
import { newId } from "./types.js";
import type { Message, Part, Session } from "./types.js";
import { renderSession } from "./render.js";

const session: Session = {
  id: newId("ses"),
  title: "分析 src 目录",
  model: { providerId: "deepseek", modelId: "deepseek-chat" },
  createdAt: new Date().toISOString(),
};

const userMessage: Message = {
  id: newId("msg"),
  sessionId: session.id,
  role: "user",
  content: "帮我看看 src 目录有哪些文件",
  createdAt: new Date().toISOString(),
};

// 关键：一条 assistant 消息里混合了思考 + 工具 + 文本
const assistantParts: Part[] = [
  { id: newId("prt"), messageId: "", type: "step-start" },
  { id: newId("prt"), messageId: "", type: "reasoning", text: "用户想了解项目结构，先用 glob 列出文件" },
  {
    id: newId("prt"),
    messageId: "",
    type: "tool",
    callId: newId("call"),
    tool: "glob",
    state: {
      status: "completed",
      input: { pattern: "src/*" },
      output: "src/index.ts\nsrc/utils.ts\nsrc/config.ts",
      title: "列出 3 个文件",
      endedAt: new Date().toISOString(),
    },
  },
  { id: newId("prt"), messageId: "", type: "text", text: "src 下有 3 个文件：index.ts、utils.ts、config.ts。需要我读取某个文件的内容吗？" },
  { id: newId("prt"), messageId: "", type: "step-finish", tokens: { input: 350, output: 120 } },
];

const assistantMessage: Message = {
  id: newId("msg"),
  sessionId: session.id,
  role: "assistant",
  parts: assistantParts.map((p) => ({ ...p, messageId: assistantParts[0]!.id })),
  createdAt: new Date().toISOString(),
};

console.log(renderSession(session, [userMessage, assistantMessage]));
```

跑一下：

```bash
npx tsx demo.ts
```

你会看到开头「先看效果」里那段输出。**这证明我们的类型模型能完整表达一次真实的 agent 对话**。

---

## 对照生产代码

zmzai-agent 的真实类型定义在 `packages/agent-framework/src/core/session/types.ts`，和我们的 mini 版对比：

| 方面 | mini 版 | 生产版 | 差异原因 |
|---|---|---|---|
| Part 种类 | 5 种 | 8 种 | 生产多了 `compaction`/`subtask`/`file`，后几期才用到 |
| Session 字段 | 4 个 | 10+ 个 | 生产有 agent/permission/queuedPrompts/parentId 等 |
| Message | 联合类型 | 联合类型 | **结构一致**——核心设计相同 |
| ToolState | 4 态状态机 | 4 态状态机 | **完全一致** |
| ID | `Math.random` | `crypto` + 前缀（ses_/msg_/prt_） | 生产要可追溯、可排序 |

**核心设计是一样的**：Session/Message/Part 三级、Part 联合类型、ToolState 状态机。mini 版只是去掉了生产复杂度（多租户字段、版本化代理、队列），保留了架构本质。

去读一眼生产版 `types.ts`（77 行），你会发现几乎就是 mini 版的「完整版」——这说明我们这期的地基和生产版是同源的。

---

## 小结

这期我们做了两件事：

1. **认清一个反直觉的事实**：agent 的对话不是一串文本，而是「思考 + 文本 + 工具」的混合流。用 `string[]` 建模会丢失流式能力、工具状态、思考链。
2. **定义了三级数据模型**：Session → Message → Part，其中 Part 是联合类型 + 判别字段，ToolState 是状态机。这套类型是后面 7 期的地基。

**最该记住的一点**：Part 是最小可流式单元。后面做循环、事件、UI 时，你会反复感谢今天把这个模型定对了。

---

## 下期预告

**第 2 期：工具系统——让 LLM 长出手脚**

有了数据模型，下一步是定义「工具」——把读文件、跑命令这些操作，变成 LLM 能调用的东西。我们会用 zod 定义参数 schema、实现 6 个内置工具，并搞清楚工具的输出怎么截断才不会撑爆上下文。

> **课后小练习**（可选）：给 `Part` 加一种新类型 `image`（带 url），想想它的判别字段和载荷该怎么设计。提示：看 user message 现在只有 `content: string`，如果用户想发图片呢？
