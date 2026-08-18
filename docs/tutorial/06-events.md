# 第 6 期：会话存储与事件流——断线重连怎么续上

> **从零造一个 Coding Agent 框架 · 第 6 期（共 8 期）**
>
> 前几期我们的 agent 跑完，结果就散在内存里——关掉终端就没了。而且如果有个 UI，它怎么知道 agent 此刻在调工具？这期我们解决两件事：**持久化**（会话存下来）和**实时通知**（状态变化推给 UI）。用一套机制同时解决——事件溯源。

---

## 这期解决什么问题

两个问题，一个解法。

**问题 1：持久化。** 会话要存下来——刷新页面、重启服务后能恢复。

**问题 2：实时性。** UI 要实时知道 agent 在干什么（"正在读文件""工具执行完了"）。轮询太蠢，要推送。

**一个解法：事件溯源（Event Sourcing）。** 不存"当前状态"，而是存"发生过的所有事件"。UI 的状态全从事件流推导。事件既负责持久化（存下来就是历史），又负责实时性（新事件推给 UI）。

而且事件带**递增序号（seq）**——UI 断线重连时，只要报上"我最后看到第 N 条"，服务端就从 N+1 开始补。这就是可靠的断线续传。

---

## 先看效果

这期结束，你能订阅一个会话的事件流，实时看到 agent 的每一步：

```
[evt 1] session.created  { title: "分析项目" }
[evt 2] message.user     { content: "读 package.json" }
[evt 3] message.assistant.start
[evt 4] part.tool        { tool: "read", status: "running" }
[evt 5] part.tool        { tool: "read", status: "completed", output: "..." }
[evt 6] message.assistant.end
[evt 7] session.idle
```

每条带 `seq`。模拟断线：跳过 evt 4-5，从 evt 6 订阅——会先补齐错过的 4-5，再继续。

---

## 原理

### 事件 vs 状态

传统做法：存"当前状态"（比如一个 `Session` 对象，里面有 `currentTool` 字段）。问题：状态被覆盖了，历史就丢了；实时通知要单独搞一套。

事件溯源：只存事件（"工具开始""工具完成"），当前状态是**事件流的投影**。想看"当前在干什么"？replay 事件流算出来。想看历史？事件全在。

```
事件流（存这个）          状态（算出来的，不存）
────────────             ────────────
evt: tool.start    ──┐
evt: tool.complete ├──► 当前：没有运行中的工具
evt: text.delta    ──┘    最后输出："xxx"
```

### 为什么事件要带 seq

因为 UI 会断线。重连时，UI 报"我最后看到 seq=5"，服务端 `read(sinceSeq=5)` 把 6 之后的全补上。没有 seq，没法做可靠的续传——你不知道哪条送过了哪条没送。

seq 是 **per-session 单调递增**的（不是全局的）——每个会话独立计数。

---

## 动手实现

### Step 1：事件定义

```ts
// events.ts
import type { Message, Part, Session } from "./types.js";

/** 框架事件类型（联合类型） */
export type FrameworkEvent =
  | { type: "session.created"; seq: number; session: Session }
  | { type: "session.status"; seq: number; status: "idle" | "running" }
  | { type: "message.appended"; seq: number; message: Message }
  | { type: "part.updated"; seq: number; part: Part }     // Part 新增或状态变更
  | { type: "part.delta"; seq: number; partId: string; delta: string };  // 文本流式增量

/** 持久化的事件（带额外元数据） */
export type PersistedEvent = FrameworkEvent & {
  id: string;
  sessionId: string;
  at: string;  // ISO 时间
};
```

**设计要点**：
- `part.updated` 同时管"新增"和"变更"——一个 tool part 从 running 变 completed，就是一条 `part.updated`。UI 靠 `part.id` 定位"改哪个 Part"。
- `part.delta` 是文本流式增量——避免每个字都产出一个完整 Part（太重），只发增量字符串。

### Step 2：EventLog（事件存储）

```ts
/** 事件日志：负责持久化 + 分配 seq */
export class EventLog {
  private events = new Map<string, PersistedEvent[]>();  // sessionId → 事件列表

  /** 追加事件，自动分配下一个 seq */
  async append(sessionId: string, event: FrameworkEvent): Promise<PersistedEvent> {
    const list = this.events.get(sessionId) ?? [];
    const seq = list.length + 1;  // per-session 单调递增
    const persisted: PersistedEvent = {
      ...event,
      seq,   // 关键：用算出的 seq 覆盖调用方传入的占位值，否则所有事件 seq 相同，订阅永远收不到
      id: `evt_${Math.random().toString(36).slice(2, 10)}`,
      sessionId,
      at: new Date().toISOString(),
    };
    list.push(persisted);
    this.events.set(sessionId, list);
    return persisted;
  }

  /** 读取 seq > sinceSeq 的事件（断线续传用） */
  async read(sessionId: string, sinceSeq: number, limit = 100): Promise<PersistedEvent[]> {
    const list = this.events.get(sessionId) ?? [];
    return list.filter((e) => e.seq > sinceSeq).slice(0, limit);
  }
}
```

这是内存版。生产环境换 Mongo——接口一样，实现不同。这就是存储抽象的好处。

### Step 3：实时订阅（live + 回放合并）

```ts
/** 活跃订阅者（同进程内） */
const listeners = new Map<string, Set<(event: PersistedEvent) => void>>();

/**
 * 订阅一个会话的事件流。
 * 先回放历史（sinceSeq 之后），再 live 合并新事件。
 * 这是 AsyncGenerator——调用方 for-await 遍历。
 */
export async function* subscribe(
  log: EventLog,
  sessionId: string,
  options: { sinceSeq?: number; signal?: AbortSignal } = {},
): AsyncGenerator<PersistedEvent> {
  let cursor = options.sinceSeq ?? 0;
  const queue: PersistedEvent[] = [];
  let wake: (() => void) | null = null;

  // 注册 live listener
  const listener = (event: PersistedEvent) => {
    if (event.seq <= cursor) return;  // 已送过的跳过
    queue.push(event);
    wake?.();
  };
  const set = listeners.get(sessionId) ?? new Set();
  set.add(listener);
  listeners.set(sessionId, set);

  const onAbort = () => { wake?.(); };
  options.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    while (!options.signal?.aborted) {
      // 1. 先从持久化日志补齐错过的（断线期间产生的）
      const missed = await log.read(sessionId, cursor, 500);
      for (const e of missed) {
        if (e.seq <= cursor) continue;
        queue.push(e);
      }
      // 2. 按 seq 排序后逐条 yield。
      // 注意：遇到 seq <= cursor 的（重复/过期）要丢弃而不是停摆——
      // live 推送和回放可能重复进 queue，停摆会让队头旧事件永远堵住后面的新事件
      queue.sort((a, b) => a.seq - b.seq);
      while (queue.length) {
        const event = queue.shift()!;
        if (event.seq <= cursor) continue;
        cursor = event.seq;
        yield event;
      }
      // 3. 没有新事件了，等一会儿（live listener 会唤醒，或超时再轮询）
      if (options.signal?.aborted) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1000);  // 兜底轮询
        wake = () => { clearTimeout(timer); resolve(); };
      });
    }
  } finally {
    set.delete(listener);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

/** 通知 live 订阅者（append 后调用） */
export function notify(event: PersistedEvent): void {
  for (const listener of listeners.get(event.sessionId) ?? []) {
    try { listener(event); } catch { /* 一个订阅者出错不能影响其他 */ }
  }
}
```

**这段最精妙的地方**：**live 和回放合并到一个流里**。订阅时：
1. 先 `log.read(sinceSeq)` 补齐断线期间错过的事件
2. 再监听 live 新事件
3. 两者进同一个 queue，按 seq 排序后 yield

为什么需要轮询兜底（`setTimeout 1000ms`）？因为生产环境是多进程的——另一个进程写的事件，本进程的 live listener 收不到，只能靠轮询 `log.read` 去持久化日志里捞。单进程内存版其实不需要，但加上它让代码跨进程正确。

### Step 4：SessionStore（会话/消息存储）

```ts
// store.ts
import type { Message, Part, Session } from "./types.js";

/** 会话存储（抽象。内存版如下，生产换 Mongo/JSONL） */
export class SessionStore {
  private sessions = new Map<string, Session>();
  private messages = new Map<string, Message[]>();

  async createSession(session: Session) { this.sessions.set(session.id, { ...session }); }
  async getSession(id: string) { const s = this.sessions.get(id); return s ? { ...s } : null; }
  async appendMessage(sessionId: string, message: Message) {
    const list = this.messages.get(sessionId) ?? [];
    list.push(message);
    this.messages.set(sessionId, list);
  }
  async getMessages(sessionId: string) { return [...(this.messages.get(sessionId) ?? [])]; }
  async updatePart(sessionId: string, partId: string, patch: Partial<Part>) {
    const msgs = this.messages.get(sessionId) ?? [];
    for (const msg of msgs) {
      if (msg.role !== "assistant") continue;
      const idx = msg.parts.findIndex((p) => p.id === partId);
      if (idx >= 0) { msg.parts[idx] = { ...msg.parts[idx]!, ...patch } as Part; return; }
    }
  }
}
```

`SessionStore` 存"快照"（方便快速读取当前状态），`EventLog` 存"历史"（可靠重放）。两者互补——生产环境也是这个双轨设计。

---

## 跑起来

写 `demo.ts`，订阅事件流看 agent 实时活动：

```ts
// demo.ts
import { EventLog, subscribe, notify } from "./events.js";
import { runAgent } from "./loop.js";
import { PermissionEngine, baselineRules } from "./permission.js";

const log = new EventLog();
const engine = new PermissionEngine([baselineRules], async () => "once");

const config = { baseUrl: "...", apiKey: process.env.API_KEY!, model: "deepseek-chat" };

// 后台订阅事件流，实时打印（用 AbortController，agent 跑完后停掉订阅，否则轮询会让进程不退出）
const controller = new AbortController();
const session = { id: "ses_demo", title: "读文件", model: { providerId: "x", modelId: "x" }, createdAt: new Date().toISOString() };
await log.append(session.id, { type: "session.created", seq: 0, session });

const sub = (async () => {
  for await (const event of subscribe(log, session.id, { signal: controller.signal })) {
    console.log(`[evt ${event.seq}] ${event.type}`, "status" in event ? (event as any).status ?? (event as any).part?.tool ?? "" : "");
  }
})();

// 跑 agent，每个 Part 变更都记事件
await runAgent([], "读 package.json", {
  config, systemPrompt: "你是助手。", maxSteps: 6, cwd: process.cwd(), permission: engine,
  onPart: async (part) => {
    const persisted = await log.append(session.id, { type: "part.updated", seq: 0, part });
    notify(persisted);  // 推给 live 订阅者
  },
});

controller.abort();
await sub;
```

你会看到事件按 seq 顺序实时打印。模拟断线：把 `subscribe` 的 `sinceSeq` 设成 3（跳过前 3 条），你会看到它先补齐 4+，再继续。

---

## 对照生产代码

zmzai-agent 的事件在 `packages/agent-framework/src/core/events/`（manifest.ts + bus.ts），对比：

| 方面 | mini 版 | 生产版 | 差异 |
|---|---|---|---|
| 事件种类 | 5 种 | 11 种 | 生产多了 permission/file.edited/artifact 等 |
| seq 分配 | list.length+1 | store 原子分配 | 生产支持并发 |
| 订阅 | live+回放合并 | live+回放合并（pollIntervalMs 兜底） | **核心算法一致** |
| 校验 | 无 | 每条事件 zod schema 校验 | 生产防畸形事件 |
| 存储 | 内存 Map | Mongo（生产）/ JSONL（CLI） | 抽象一致，实现可换 |

**去看生产版 `bus.ts` 的 `subscribeEventLog`**（64 行），它和我们的 `subscribe` 是同一个算法：`read(sinceSeq)` 补齐 → live listener 合并 → 按 seq 排序 yield。生产版多了 `pollIntervalMs` 参数（跨进程兜底）和 `AbortSignal` 处理，骨架完全一致。

zmzai 的 11 种事件（`manifest.ts`）都有 zod schema——每条事件 append 时校验，畸形事件直接拒绝。这是 mini 版省掉的健壮性。

---

## 小结

这期我们：

1. **理解了事件溯源**：不存状态，存事件；状态是事件流的投影
2. **实现了 EventLog + subscribe**：持久化 + seq + live/回放合并订阅
3. **搞定了断线续传**：靠 seq，UI 报"最后看到 N"，服务端从 N+1 补

**最该记住的一点**：seq 是实时性的基石。没有 seq，你不知道"哪条送过了"——要么重复送（UI 闪烁），要么漏送（状态不一致）。事件 + seq 是所有实时系统的标配（数据库的 WAL、消息队列的 offset，都是这个模式）。

---

## 下期预告

**第 7 期：上下文压缩——对话太长怎么办**

agent 聊久了，对话历史会超过模型的上下文窗口。下期我们造压缩机制：把旧历史压成摘要，保留近期原文。涉及触发条件、摘要生成、边界标记。

> **课后小练习**（可选）：现在事件 `append` 时 `seq` 用 `list.length+1`。如果是多线程并发 append，这会有什么问题？（提示：两个 append 同时读到 length=5，都分配 seq=6。生产环境怎么解决？想想数据库的自增 id 或原子操作。）
