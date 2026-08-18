# 第 2 期：工具系统——让 LLM 长出手脚

> **从零造一个 Coding Agent 框架 · 第 2 期（共 8 期）**
>
> 上期我们定义了数据模型（Session/Message/Part）。但一个光会说话的 LLM 没什么用——它读不了文件、跑不了命令、改不了代码。这期我们给它「长出手脚」：定义一套工具系统，让 LLM 能调用真实操作。

---

## 这期解决什么问题

LLM 本质上是个文本输入、文本输出的函数。它能「说」要读文件，但没法真去读。怎么办？

答案是 **function calling**（工具调用）：我们告诉 LLM「你有这些工具可用」（每个工具有名字、描述、参数 schema），LLM 决定调哪个、传什么参数，**实际的执行由我们的代码来做**，结果再喂回 LLM。

这听起来简单，但工程上有几个要解决的问题：

1. **怎么定义工具？** 参数怎么校验？怎么转成 LLM 能理解的 JSON Schema？
2. **工具的输出可能巨大**（比如读了一个 10 万行的文件），怎么防止撑爆上下文？
3. **权限怎么声明？** 读文件和删文件的危险程度不同，框架怎么知道哪些调用要拦？

这期解决前两个，第三个留到第 5 期（权限系统）。

---

## 先看效果

这期结束，你会有一套工具系统，能这样用：

```ts
const result = await readTool.execute({ path: "package.json" }, ctx);
console.log(result);
// { title: "读取 package.json", output: '{\n  "name": "mini-agent",...\n}' }

// 工具的 JSON Schema（给 LLM 看的）
const schema = readTool.toJSONSchema();
// { type: "function", function: { name: "read", description: "...", parameters: {...} } }
```

而且我们会在终端跑一个真实的工具调用，看到 `glob` 列出文件、`read` 读出内容。

---

## 原理

### 工具调用的完整流程

```
LLM 收到工具列表（JSON Schema）
  ↓
LLM 决定调用：read({ path: "src/index.ts" })
  ↓
我们的代码：
  1. 校验参数（path 是不是合法字符串？）
  2. [权限检查——第 5 期]
  3. 执行真实操作（fs.readFile）
  4. 截断输出（防止太大）
  ↓
结果喂回 LLM："文件内容是 ..."
  ↓
LLM 基于结果继续回复
```

这期我们实现 1、3、4 三步（权限留第 5 期）。

### 为什么用 zod 定义参数

工具参数需要两样东西：
- **运行时校验**：LLM 传了 `{path: 123}`（数字）要能拒绝
- **JSON Schema**：给 LLM 看的参数说明

如果手写 JSON Schema，校验和 schema 是两套代码，容易不一致。用 [zod](https://zod.dev) 定义一次，**既能运行时校验，又能自动转 JSON Schema**，单一数据源。

```ts
// 定义一次
const params = z.object({ path: z.string().min(1) });

// 校验
params.parse({ path: "foo" });  // ✅
params.parse({ path: 123 });    // ❌ 抛错

// 转 schema（给 LLM）
z.toJSONSchema(params);  // { type:"object", properties:{ path:{type:"string"} } }
```

---

## 动手实现

先装依赖：

```bash
npm install zod
```

### Step 1：ToolDef 抽象

新建 `tools.ts`。先定义「一个工具长什么样」：

```ts
// tools.ts
import { z } from "zod";

/** 工具执行需要的上下文（这期先空着，后面期数会加权限、沙箱等） */
export type ToolContext = {
  cwd: string;  // 当前工作目录
};

/** 工具执行结果 */
export type ToolResult = {
  title: string;      // 一句话摘要（UI 显示）
  output: string;     // 正文（喂回 LLM + UI 显示）
  metadata?: Record<string, unknown>;  // 附加数据（不喂 LLM）
};

/** 工具定义（默认泛型用 z.ZodType<any>，否则 z.output 退化成 unknown，execute 里拿不到参数类型） */
export type ToolDef<TSchema extends z.ZodType = z.ZodType<any>> = {
  id: string;
  description: string;           // 给 LLM 看的说明
  parameters: TSchema;           // zod schema
  execute(args: z.output<TSchema>, ctx: ToolContext): Promise<ToolResult>;
};
```

**关键设计**：

- `id` 就是工具名（LLM 调用时用这个名字）
- `description` 极其重要——LLM 靠它判断「什么时候该用这个工具」。写得不好，LLM 就不会调或乱调
- `parameters` 是 zod schema，同时负责校验和生成 JSON Schema
- `execute` 返回 `{title, output}` 分开——`title` 给 UI 当摘要，`output` 是喂回 LLM 的正文

### Step 2：JSON Schema 转换 + 输出截断

写两个辅助函数。先处理输出截断——这是个常被忽略但极重要的点：

```ts
/** 最大输出字节数。超了就截断，防止巨量输出撑爆 LLM 上下文 */
const MAX_OUTPUT_BYTES = 48 * 1024;

/** 截断工具输出，返回截断后的文本 + 是否截断了 */
function truncate(text: string): { text: string; truncated: boolean } {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= MAX_OUTPUT_BYTES) return { text, truncated: false };
  // 按字节截断（注意 UTF-8 多字节字符）
  let cut = text;
  while (Buffer.byteLength(cut, "utf8") > MAX_OUTPUT_BYTES) cut = cut.slice(0, -1);
  return { text: cut + "\n...(输出过长，已截断)", truncated: true };
}

/** 把 ToolDef 转成 OpenAI 兼容的 JSON Schema（给 LLM 看） */
export function toolToSchema(def: ToolDef): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: def.id,
      description: def.description,
      parameters: z.toJSONSchema(def.parameters),
    },
  };
}
```

**为什么是 48KB？** 这是经验值——既足够大（多数文件输出能完整保留），又不至于让单个工具结果吃掉太多上下文窗口。生产环境（zmzai-agent）用的也是 48KB。

### Step 3：实现 read / glob / grep（只读工具）

```ts
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";

/** 通配匹配：* 匹配任意字符序列，? 匹配单字符 */
function wildcard(pattern: string, value: string): boolean {
  const re = "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$";
  return new RegExp(re).test(value);
}

export const readTool: ToolDef = {
  id: "read",
  description: "读取一个文本文件的内容。路径相对工作目录。",
  parameters: z.object({ path: z.string().min(1) }),
  async execute(args, ctx) {
    const fullPath = join(ctx.cwd, args.path);
    const content = await readFile(fullPath, "utf8");
    const { text, truncated } = truncate(content);
    return {
      title: `读取 ${args.path}（${content.length} 字符）`,
      output: text,
      ...(truncated ? { metadata: { truncated: true } } : {}),
    };
  },
};

export const globTool: ToolDef = {
  id: "glob",
  description: "按通配模式列出文件路径。不传 pattern 则列出全部。最多返回 200 个。",
  parameters: z.object({ pattern: z.string().optional() }),
  async execute(args, ctx) {
    // 简化版：只列一层。生产版会递归遍历。
    const entries = await readdir(ctx.cwd, { withFileTypes: true });
    const files = entries.filter((e) => e.isFile()).map((e) => e.name);
    const matched = args.pattern ? files.filter((f) => wildcard(args.pattern!, f)) : files;
    const limited = matched.slice(0, 200);
    return {
      title: `列出 ${limited.length} 个文件`,
      output: limited.length ? limited.join("\n") : "没有匹配的文件。",
      metadata: { count: limited.length, total: matched.length },
    };
  },
};

export const grepTool: ToolDef = {
  id: "grep",
  description: "在文件内容中搜索关键词，返回 path:line: 内容 格式。最多 50 条。",
  parameters: z.object({ query: z.string().min(1), pattern: z.string().optional() }),
  async execute(args, ctx) {
    const entries = await readdir(ctx.cwd, { withFileTypes: true });
    const files = entries.filter((e) => e.isFile()).map((e) => e.name);
    const candidates = args.pattern ? files.filter((f) => wildcard(args.pattern!, f)) : files;
    const matches: { path: string; line: number; text: string }[] = [];
    for (const file of candidates) {
      if (matches.length >= 50) break;
      const content = await readFile(join(ctx.cwd, file), "utf8").catch(() => null);
      if (!content) continue;
      const lines = content.split("\n");
      for (let i = 0; i < lines.length && matches.length < 50; i++) {
        if (lines[i]!.includes(args.query)) {
          matches.push({ path: file, line: i + 1, text: lines[i]!.slice(0, 200) });
        }
      }
    }
    return {
      title: `搜索 "${args.query}"：${matches.length} 条命中`,
      output: matches.length ? matches.map((m) => `${m.path}:${m.line}: ${m.text}`).join("\n") : "没有命中。",
    };
  },
};
```

### Step 4：实现 write / edit（写入工具）

```ts
export const writeTool: ToolDef = {
  id: "write",
  description: "创建或完整覆盖一个文件。",
  parameters: z.object({
    path: z.string().min(1),
    content: z.string(),
    summary: z.string().max(200).optional(),  // 改动说明（UI 显示）
  }),
  async execute(args, ctx) {
    const fullPath = join(ctx.cwd, args.path);
    await writeFile(fullPath, args.content, "utf8");
    return {
      title: args.summary ?? `写入 ${args.path}`,
      output: `已写入 ${args.path}（${args.content.length} 字符）。`,
      metadata: { path: args.path, bytes: Buffer.byteLength(args.content, "utf8") },
    };
  },
};

export const editTool: ToolDef = {
  id: "edit",
  description: "对文件做精确替换。oldText 必须在文件中唯一出现，否则失败。",
  parameters: z.object({
    path: z.string().min(1),
    oldText: z.string().min(1),
    newText: z.string(),
    summary: z.string().max(200).optional(),
  }),
  async execute(args, ctx) {
    const fullPath = join(ctx.cwd, args.path);
    const content = await readFile(fullPath, "utf8");
    const count = content.split(args.oldText).length - 1;
    if (count === 0) throw new Error(`找不到要替换的文本：${args.oldText.slice(0, 50)}...`);
    if (count > 1) throw new Error(`要替换的文本出现了 ${count} 次，必须唯一。请提供更多上下文。`);
    await writeFile(fullPath, content.replace(args.oldText, args.newText), "utf8");
    return {
      title: args.summary ?? `编辑 ${args.path}`,
      output: `已编辑 ${args.path}。`,
    };
  },
};
```

**注意 editTool 的「唯一性」约束**：`oldText` 必须在文件里只出现一次。这是生产代码（zmzai-agent `editTool`）的同款设计——防止模型误改多处。如果不唯一，直接报错让模型重试（提供更多上下文）。

### Step 5：实现 bash（命令执行）

mini 版用 `child_process`，不搞隔离沙箱（那太重了）：

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

// 程序白名单——只允许这些命令，防止 LLM 乱跑危险命令
const ALLOWED = new Set(["node", "npm", "npx", "ls", "cat", "grep", "find", "git", "echo", "python3"]);

export const bashTool: ToolDef = {
  id: "bash",
  description: "执行一条命令（程序必须在允许列表内）。返回 stdout/stderr 和退出码。",
  parameters: z.object({
    program: z.string().min(1),
    args: z.array(z.string()).optional(),
  }),
  async execute(args, ctx) {
    if (!ALLOWED.has(args.program)) {
      throw new Error(`程序 "${args.program}" 不在允许列表：${[...ALLOWED].join(", ")}`);
    }
    try {
      const { stdout, stderr } = await exec(args.program, args.args ?? [], {
        cwd: ctx.cwd,
        maxBuffer: 1024 * 1024,  // 1MB 上限
        timeout: 30_000,
      });
      const output = [stdout, stderr].filter(Boolean).join("\n");
      const { text, truncated } = truncate(output);
      return {
        title: `${args.program} 完成`,
        output: `$ ${args.program} ${(args.args ?? []).join(" ")}\n${text}`,
        ...(truncated ? { metadata: { truncated: true } } : {}),
      };
    } catch (error) {
      // execFile 失败时 error 里有 stdout/stderr
      const e = error as { stdout?: string; stderr?: string; message: string };
      const output = [e.stdout, e.stderr].filter(Boolean).join("\n") || e.message;
      return {
        title: `${args.program} 失败`,
        output: `$ ${args.program} ${(args.args ?? []).join(" ")}\n${output}`,
      };
    }
  },
};
```

**两个安全设计**：
1. **程序白名单**——只放行常用安全命令。生产版（zmzai-agent）也用白名单，且可通过环境变量覆盖。
2. **超时 + buffer 上限**——防止命令挂死或输出爆炸。

### Step 6：汇总导出

```ts
/** 所有内置工具 */
export const builtinTools: ToolDef[] = [readTool, globTool, grepTool, writeTool, editTool, bashTool];

/** 按名字查找 */
export function findTool(name: string): ToolDef | undefined {
  return builtinTools.find((t) => t.id === name);
}

/** 把所有工具转成 LLM 的 schema 列表 */
export function allToolsToSchema(): Record<string, unknown>[] {
  return builtinTools.map(toolToSchema);
}
```

别忘了顶部补上 import：

```ts
import { writeFile } from "node:fs/promises";
```

---

## 跑起来

写个 `demo.ts` 测试工具系统：

```ts
// demo.ts
import { readTool, globTool, bashTool, toolToSchema } from "./tools.js";

const ctx = { cwd: process.cwd() };

console.log("=== read 工具的 JSON Schema（给 LLM 看的）===");
console.log(JSON.stringify(toolToSchema(readTool), null, 2));

console.log("\n=== 执行 glob ===");
const files = await globTool.execute({ pattern: "*.json" }, ctx);
console.log(files.title);
console.log(files.output);

console.log("\n=== 执行 read ===");
const pkg = await readTool.execute({ path: "package.json" }, ctx);
console.log(pkg.title);
console.log(pkg.output.slice(0, 200) + "...");

console.log("\n=== 执行 bash ===");
const ver = await bashTool.execute({ program: "node", args: ["--version"] }, ctx);
console.log(ver.output);
```

跑：

```bash
npx tsx demo.ts
```

你会看到工具的 JSON Schema、glob 列出的文件、读出的 package.json、node 版本号。**LLM 现在有了 6 个工具可用**。

---

## 对照生产代码

zmzai-agent 的工具在 `packages/agent-framework/src/core/tools/`，对比：

| 方面 | mini 版 | 生产版 | 差异 |
|---|---|---|---|
| 工具数 | 6 个 | 8 个 | 生产多了 `todo`（任务清单）+ `task`（子代理） |
| 文件操作 | 直连 fs | WorkspaceFiles 抽象 | 生产可接 Mongo，每次写生成不可变版本 + diff |
| bash | child_process | OpenSandbox 隔离容器 | 生产基于 snapshot，产物可下载 |
| 权限 | 无 | 每个工具有 `permission(args)` 声明 | 第 5 期实现 |
| 白名单 | 写死 Set | 环境变量可配 + 命令拆分（`splitProgram`） | 生产处理了 LLM 把整条命令塞进 program 的 case |

**核心抽象一致**：ToolDef（id + zod parameters + execute + 返回 title/output）是和 zmzai-agent 同源的。生产版 `adapter.ts` 的 `adaptTool` 就是把 ToolDef 转成 PI 引擎能用的 `AgentTool`——结构几乎一样，只是多包了一层权限检查和输出截断的细节。

---

## 小结

这期我们：

1. **定义了 ToolDef 抽象**：zod 参数（校验 + schema 二合一）+ execute + title/output 分离
2. **实现了 6 个工具**：read/glob/grep（只读）+ write/edit（写入）+ bash（执行）
3. **两个关键工程点**：输出截断（48KB 上限）、程序白名单（bash 安全）

**最该记住的一点**：工具的 `description` 是写给 LLM 看的「说明书」——它直接决定 LLM 会不会用、用得对不对。写工具时花时间打磨 description，比优化执行逻辑更影响 agent 的实际表现。

---

## 下期预告

**第 3 期：LLM 调用层——流式、工具调用解析、容错**

有了工具，下一步是真正去调 LLM。但「调一个流式接口」远比想象复杂：文本是分片到达的、思考链是分片到达的、**工具调用的参数也是分片到达的**——怎么把它们正确拼起来？这期是整个系列的第一个难度高峰。

> **课后小练习**（可选）：给工具系统加一个 `todo` 工具（更新任务清单）。它不需要文件系统，参数是 `{ todos: [{content, status}] }`，execute 只需把数据打印出来。提示：这个工具的输出怎么截断？它有没有危险操作需要权限？
