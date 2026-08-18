# 第 5 期：权限系统——不能让 agent 乱删文件

> **从零造一个 Coding Agent 框架 · 第 5 期（共 8 期）**
>
> 上期我们的 agent 已经能跑 bash 命令了——但有个问题：如果 LLM 决定跑 `rm -rf /`，它会毫不犹豫地执行。这期我们造一道闸口，在工具执行前拦住它，问用户「这个操作允许吗」。

---

## 这期解决什么问题

一个能跑命令的 agent 是危险的。LLM 不可控——它可能误删文件、执行危险命令、改不该改的东西。我们需要：

1. **拦截**：工具执行前先判断「这个操作要不要问用户」
2. **细粒度**：读文件和删文件的危险等级不同；`npm run build` 和 `rm -rf` 不同
3. **不烦人**：用户批准过一次 `npm run build`，同样的命令不要反复问

这三点合起来就是权限系统。zmzai-agent 的设计是：**声明式规则 + 单一闸口 + 三态审批**。

---

## 先看效果

这期结束，agent 跑 bash 前会先问你：

```
🔧 bash({"program":"npm","args":["run","build"]})
⚠️  需要权限：bash > npm run build
   [1] 允许一次  [2] 总是允许  [3] 拒绝
> 1

  ⏳ 执行中...
  ✅ npm 完成
```

选「总是允许」后，同会话内再跑 `npm run build` 直接放行，不再打断。

---

## 原理

### Ruleset：声明式权限规则

权限用一条条规则表达：

```
{ permission: "bash", pattern: "npm *", action: "allow" }   // npm 开头的命令放行
{ permission: "bash", pattern: "rm *",   action: "ask" }    // rm 开头的命令要问
{ permission: "read", pattern: "*.env",  action: "ask" }    // 读 env 文件要问
```

- **permission**：权限键（`bash` / `edit` / `read` / ...），对应工具类别
- **pattern**：通配模式，匹配具体操作（命令、文件路径等）
- **action**：`allow`（放行）/ `deny`（拒绝）/ `ask`（问用户）

**求值规则**：多条规则按顺序匹配，**最后一条匹配的胜出**，都不匹配默认 `ask`。

为什么「最后匹配胜出」而不是「第一匹配」？因为规则是叠加的——基线规则先放行，特定规则再收紧。比如基线 `read: * → allow`，但 `read: *.env → ask` 覆盖它。后写的规则优先级更高，符合直觉。

### 三态审批

当 action 是 `ask` 时，挂起执行，问用户。用户三选一：

- **once**：这次允许，同会话内同操作不再问（但下次新会话还会问）
- **always**：永远允许这类操作（写入会话规则集）
- **reject**：拒绝，工具返回错误给 LLM

---

## 动手实现

### Step 1：Ruleset 类型 + 通配匹配

```ts
// permission.ts

/** 权限动作 */
export type Action = "allow" | "deny" | "ask";

/** 一条权限规则 */
export type Rule = { permission: string; pattern: string; action: Action };

/** 规则集（有序数组） */
export type Ruleset = Rule[];

/**
 * 通配匹配：* 匹配任意字符序列（含空格/路径分隔符），? 匹配单字符。
 * 比如 "npm *" 匹配 "npm run build"；"*.env" 匹配 "prod.env"。
 */
export function wildcardMatch(pattern: string, value: string): boolean {
  let p = 0, v = 0;
  let star = -1, starValue = 0;
  while (v < value.length) {
    if (p < pattern.length && (pattern[p] === "?" || pattern[p] === value[v])) {
      p++; v++;
    } else if (p < pattern.length && pattern[p] === "*") {
      star = p++; starValue = v;
    } else if (star !== -1) {
      p = star + 1; v = ++starValue;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === "*") p++;
  return p === pattern.length;
}

/** 求值：多条规则集叠加，最后匹配的胜出，无匹配默认 ask */
export function evaluate(rulesets: Ruleset[], permission: string, pattern: string): Action {
  let result: Action = "ask";
  for (const ruleset of rulesets) {
    for (const rule of ruleset) {
      if (wildcardMatch(rule.permission, permission) && wildcardMatch(rule.pattern, pattern)) {
        result = rule.action;
      }
    }
  }
  return result;
}
```

**通配匹配的算法**：这是经典的「带星号的字符串匹配」，用回溯（`star` 记录上次星号位置，匹配失败时回退）。和正则等价但更轻——不需要编译正则。

### Step 2：基线规则

```ts
/** 基线规则：所有 agent 都适用的默认权限 */
export const baselineRules: Ruleset = [
  { permission: "*", pattern: "*", action: "allow" },          // 默认放行
  { permission: "read", pattern: "*.env", action: "ask" },     // env 文件要问
  { permission: "read", pattern: "*.env.*", action: "ask" },
  { permission: "bash", pattern: "*", action: "ask" },         // 所有命令默认要问
  { permission: "edit", pattern: "*", action: "allow" },       // 编辑文件放行
];
```

这个基线的设计哲学：**默认安全，显式放行**。读普通文件、编辑文件放行（低风险高频），但 bash 命令和敏感文件要问。

### Step 3：PermissionEngine（单一闸口）

```ts
/** 三态回复 */
export type Reply = "once" | "always" | "reject";

/** 权限请求 */
export type PermissionRequest = {
  id: string;
  permission: string;
  pattern: string;       // 具体操作（命令/路径）
  description: string;   // 给用户看的人话描述
};

/** 拒绝时抛的错（喂回 LLM） */
export class RejectedError extends Error {
  constructor(message: string) { super(message); this.name = "RejectedError"; }
}

/**
 * 权限引擎：单一闸口。
 * 工具执行前调 ask()，根据规则决定放行/拒绝/问用户。
 */
export class PermissionEngine {
  private sessionRules: Ruleset = [];                    // always 批准落这里
  private onceAllowed = new Set<string>();               // once 缓存（permission\0pattern）

  constructor(
    private readonly rulesets: Ruleset[],                // 基线 + agent 预设
    private readonly askUser: (request: PermissionRequest) => Promise<Reply>,
  ) {
    this.rulesets = [...rulesets, this.sessionRules];    // session 规则优先级最高
  }

  /** 工具执行前调用。返回则放行，抛 RejectedError 则拒绝 */
  async ask(permission: string, pattern: string, description: string): Promise<void> {
    const action = evaluate(this.rulesets, permission, pattern);

    if (action === "allow") return;
    if (action === "deny") throw new RejectedError(`权限被拒绝：${permission} ${pattern}`);
    // action === "ask"

    // once 缓存：同会话内已批准过同操作，直接放行
    const key = `${permission}\0${pattern}`;
    if (this.onceAllowed.has(key)) return;

    // 问用户
    const request: PermissionRequest = {
      id: `${permission}_${Math.random().toString(36).slice(2, 8)}`,
      permission, pattern, description,
    };
    const reply = await this.askUser(request);

    if (reply === "reject") throw new RejectedError(`用户拒绝了：${description}`);
    if (reply === "once") this.onceAllowed.add(key);
    if (reply === "always") {
      // 写入会话规则集：以后同类操作自动放行
      this.sessionRules.push({ permission, pattern, action: "allow" });
    }
  }
}
```

**三个设计要点**：

1. **once 缓存**：用户批准一次 `npm run build`，同会话再调不重复问。用 `Set<permission\0pattern>` 记录。`\0`（null 字符）做分隔符避免 pattern 里有冒号混淆。

2. **always 级联**：用户对 `npm *` 选 always，规则 `{bash, "npm *", allow}` 入栈。之后 evaluate 时这条覆盖基线的 `bash: * → ask`。同类 pending 请求自动被覆盖放行。

3. **RejectedError 喂回 LLM**：拒绝不是终止 agent，而是把错误作为工具结果给 LLM 看——LLM 会知道「这个操作不被允许」，改用别的方法。这是比「直接崩掉」更优雅的处理。

### Step 4：把权限接到循环里

改第 4 期的 `runAgent`，在工具执行前加权限检查：

```ts
// 在 loop.ts 的工具执行部分（Step 3 的 for (const call of toolCalls) 循环里）
// 改成：

for (const call of toolCalls) {
  const toolPart = parts.find(/* ... 同上 ... */);
  if (toolPart) {
    // 【新增】权限检查
    try {
      // 根据 tool id 决定权限键 + pattern
      const permKey = call.name === "bash" ? "bash"
        : (call.name === "write" || call.name === "edit") ? "edit"
        : (call.name === "read" || call.name === "glob" || call.name === "grep") ? "read"
        : "*";
      const pattern = call.name === "bash"
        ? `${(call.arguments as { program?: string }).program ?? ""} ${((call.arguments as { args?: string[] }).args ?? []).join(" ")}`
        : (call.arguments as { path?: string }).path ?? "*";

      await options.permission.ask(permKey, pattern, `${call.name}: ${pattern}`);
    } catch (error) {
      // 权限被拒：工具直接置为 error 状态
      toolPart.state = {
        status: "error",
        input: call.arguments,
        error: error instanceof Error ? error.message : "权限被拒绝",
        endedAt: new Date().toISOString(),
      };
      onPart?.(toolPart);
      continue;  // 这个工具跳过，继续下一个
    }

    // 权限通过：执行工具（同第 4 期）
    toolPart.state = { status: "running", input: call.arguments, startedAt: new Date().toISOString() };
    onPart?.(toolPart);
    // ... execute ...
  }
}
```

`LoopOptions` 加上 permission 字段：

```ts
export type LoopOptions = {
  config: LlmConfig;
  systemPrompt: string;
  maxSteps: number;
  cwd: string;
  permission: PermissionEngine;   // 【新增】
  onPart?: (part: Part) => void;
};
```

---

## 跑起来

写 `demo.ts`，这次 bash 命令会触发权限询问：

```ts
// demo.ts
import { runAgent } from "./loop.js";
import { PermissionEngine, baselineRules, type PermissionRequest, type Reply } from "./permission.js";
import * as readline from "node:readline/promises";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

// 权限询问：终端交互
const askUser = async (request: PermissionRequest): Promise<Reply> => {
  console.log(`\n⚠️  需要权限：${request.description}`);
  const answer = await rl.question("   [1] 允许一次  [2] 总是允许  [3] 拒绝\n> ");
  // 注意：不要在每次回答后 rl.close()——关掉后后续权限询问会全部报 "readline was closed"
  return answer === "2" ? "always" : answer === "3" ? "reject" : "once";
};

const engine = new PermissionEngine([baselineRules], askUser);

const config = {
  baseUrl: "https://api.deepseek.com/v1",
  apiKey: process.env.API_KEY!,
  model: "deepseek-chat",
};

const messages = await runAgent([], "用 npm 看一下当前项目装了哪些包", {
  config,
  systemPrompt: "你是助手。用工具完成任务。",
  maxSteps: 6,
  cwd: process.cwd(),
  permission: engine,
  onPart: (part) => {
    if (part.type === "tool") {
      const s = part.state;
      if (s.status === "completed") console.log(`  ✅ ${part.tool}: ${s.title}`);
      else if (s.status === "error") console.log(`  ❌ ${part.tool}: ${s.error}`);
    }
  },
});
```

跑：

```bash
API_KEY=sk-xxx npx tsx demo.ts
```

agent 想跑 `npm list` 时，会弹出权限询问。你选「允许」，它才执行。

---

## 对照生产代码

zmzai-agent 的权限在 `packages/agent-framework/src/core/permission/`，对比：

| 方面 | mini 版 | 生产版 | 差异 |
|---|---|---|---|
| Ruleset 求值 | 最后匹配胜出 | 最后匹配胜出 | **完全一致** |
| 通配匹配 | 手写回溯 | 手写回溯（同算法） | **完全一致** |
| 三态 | once/always/reject | once/always/reject | **一致** |
| 闸口位置 | 循环里手动调 | PI 的 beforeToolCall 钩子 | 生产用成熟钩子 |
| always 持久化 | 内存（会话结束丢） | 写入 session permission + 持久化到 DB | 生产跨重连保留 |
| 并发请求 | 逐个问 | always 级联自动放行同类 pending | 生产处理了并发批 |

**去看生产版 `engine.ts` 的 `ask` 方法**，它的 once 缓存 + always 级联 + dispose 拒绝一切，和我们的实现是同一个思路，只是多了持久化和并发处理。zmzai 还有个巧妙设计：`always` 批准后，会扫描其他正在 pending 的请求，凡是现在被新规则覆盖的全部自动放行——用户不用逐个点。

---

## 小结

这期我们：

1. **定义了 Ruleset DSL**：permission + pattern + action，最后匹配胜出
2. **实现了 PermissionEngine**：allow 直接过 / deny 拒绝 / ask 挂起问用户 + once 缓存 + always 持久化
3. **接到了循环里**：工具执行前的单一闸口

**最该记住的一点**：权限检查必须在**一个统一的地方**做（单一闸口），不能散在各工具内部。因为：① 漏一个地方就等于没防护；② 规则的叠加逻辑（基线 → agent → session）需要集中求值。生产版把闸口放在 PI 的 `beforeToolCall` 钩子——所有工具必过这一关，没有例外。

---

## 下期预告

**第 6 期：会话存储与事件流——断线重连怎么续上**

现在 agent 跑完，结果就丢了——没有持久化。而且 UI 怎么知道 agent 正在调工具？第 6 期我们造事件系统：每个状态变更是独立事件，带递增序号（seq），UI 靠它做断线重连。

> **课后小练习**（可选）：现在的权限规则是写死在代码里的。试着改成从配置文件读（比如 `.mini-agent/permission.json`）。提示：规则顺序很重要——配置文件里的规则应该叠在基线之上还是之下？想想「最后匹配胜出」的语义。
