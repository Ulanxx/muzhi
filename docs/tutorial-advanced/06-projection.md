# 第 6 期：投影式压缩——canonical 历史不可变

> **Agent 健壮性进阶篇 · 第 6 期（共 8 期）**
>
> 第一部我们做过上下文压缩：超过阈值就把旧历史摘成一段摘要。那期的实现能跑，但有两个隐患——压缩是"无状态变换"，同样的历史段可能被反复摘；摘要消息每次现造，前缀永远在漂移。这期把它重构成**投影式压缩**：canonical 历史永远完整，压缩只是发给 LLM 前的一个投影。顺便解决一个生产级问题：怎么用前缀哈希诊断你的提示词缓存为什么命中率低。

---

## 这期解决什么问题

回忆第一部的 `compactIfNeeded`：

```ts
// 第一部的做法：无状态变换
export async function compactIfNeeded(messages, options) {
  if (tokens < threshold) return { messages, compacted: false };
  const tail = messages.slice(-options.keepRecent);
  const summary = await summarize(config, head);
  const summaryMessage: Message = {
    id: `msg_summary_${Date.now()}`,   // ← 每次现造一个新 id
    ...
  };
  return { messages: [summaryMessage, ...tail], compacted: true };
}
```

三个问题：

1. **无状态**。它不知道自己压过没有。只要上下文还超阈值，每次调用都会重新摘一遍——摘要段可能高度重叠，摘要模型的钱白烧。
2. **摘要消息每次现造**。新 id、新时间戳、摘要措辞还有随机性——发给 LLM 的前缀逐字节漂移。
3. **看不见代价**。LLM 服务商的提示词缓存（prompt caching）按"最长相同前缀"命中：前缀里任何一条消息变了，从它开始往后全部重算、按全价计费。前缀在漂移，缓存命中率就是个谜——你以为压缩省了钱，其实缓存失效亏得更多。

解法是把"压缩"从一个**变换**改成一个**状态**：引入 `ContextProjector`，它记住折叠线在哪、摘要是什么；每次调用只是做投影。再加一个 `CacheProbe`，逐条消息哈希，把"缓存从哪条消息开始失效"钉出来。

---

## Step 1：ContextProjector——折叠线 + 增量摘要

重写 `compaction.ts`。核心状态只有两个：

- `anchor`（折叠线）：canonical 历史的前 `anchor` 条已被折进摘要
- `summary`：这些条目的当前摘要

投影永远是：`[摘要消息?, ...messages.slice(anchor)]`。canonical 历史一根毛都不动。

```ts
// compaction.ts（重写）

export class ContextProjector {
  private summary: string | null = null;
  /** canonical 历史的前 anchor 条已被折叠进摘要 */
  private anchor = 0;
  /** 上次压缩完成时尾部的 token 数（滞回带用，Step 4 讲） */
  private tailTokensAtLastCompaction = -1;
  private readonly summarize: (transcript: string) => Promise<string>;

  constructor(private readonly options: ProjectionOptions) {
    // 摘要器可注入：测试用假实现，生产用真实 LLM
    this.summarize = options.summarize ?? makeLlmSummarizer(options.summaryConfig);
  }

  async project(messages: Message[]): Promise<{ projection: Message[]; compacted: boolean }> {
    const { contextWindow, ratio, keepRecent } = this.options;

    // 估算：canonical 尾部 + 已有摘要
    const tailTokens = estimateTokens(messages.slice(this.anchor));
    const summaryTokens = this.summary ? Math.ceil(this.summary.length / 4) : 0;
    const tokens = tailTokens + summaryTokens;

    let compacted = false;
    // grownEnough 是滞回带条件，先跑通再补——Step 4 实跑踩坑后讲
    if (tokens >= contextWindow * ratio && grownEnough) {
      // 折叠线：保留最近 keepRecent 条，其余（anchor 之后的部分）折进摘要
      const cut = messages.length - keepRecent;
      const toFold = messages.slice(this.anchor, cut);
      if (toFold.length > 0 && cut > this.anchor) {
        try {
          this.summary = await summarizeIncremental(this.summarize, this.summary, toFold);
          this.anchor = cut;
          this.tailTokensAtLastCompaction = estimateTokens(messages.slice(cut));
          compacted = true;
          this.options.onCompacted?.(this.summary, this.anchor);
        } catch (error) {
          // 摘要失败 → 不折叠，用全量尾部（可能超窗口，但比崩掉好）
          console.error("压缩失败，本轮保持全量上下文：", error);
        }
      }
    }

    const tail = messages.slice(this.anchor);
    const projection = this.summary !== null ? [this.summaryMessage(), ...tail] : tail;
    return { projection, compacted };
  }
}
```

注意三个设计决策：

**增量摘要。** 第二次压缩时不是把整段历史重摘一遍，而是"旧摘要 + 新折叠段"一起喂给摘要模型：

```ts
export async function summarizeIncremental(
  summarize: (transcript: string) => Promise<string>,
  prevSummary: string | null,
  toFold: Message[],
): Promise<string> {
  const transcript = prevSummary
    ? `【已有摘要】\n${prevSummary}\n\n【新增对话】\n${toTranscript(toFold)}`
    : toTranscript(toFold);
  return summarize(transcript);
}
```

每段历史只被摘要模型"读"一次，之后它以摘要的形式滚动传递。这是长会话压缩成本可控的关键。

**摘要消息逐字节稳定。** id 固定、时间戳固定——内容只在真压缩事件时变：

```ts
/** 摘要消息用固定 id：id 稳定 + 内容只在真压缩时变 → 投影前缀才可能稳定 */
const SUMMARY_MESSAGE_ID = "msg_summary_root";

private summaryMessage(): Message {
  return {
    id: SUMMARY_MESSAGE_ID,
    sessionId: "",
    role: "user",
    content: `【早期对话摘要】\n${this.summary}`,
    createdAt: new Date(0).toISOString(), // 固定时间戳：投影要逐字节稳定
  };
}
```

第一部用 `Date.now()` 造 id 是随手写的；在投影式压缩里，这种随手就是缓存命中率的杀手。

**摘要器可注入。** `summarize` 走构造参数，测试塞假实现，生产走真实 LLM——这期的确定性测试全靠它。

---

## Step 2：CacheProbe——逐条哈希钉出分歧点

新建 `prefix-cache.ts`。提示词缓存的命中条件是"请求前缀逐字节相同"，那诊断思路就很直接：把每次请求的消息逐条哈希，和上一次比，找到第一个不同的位置。

第 2 期的 FNV-1a 哈希在这里复用（`guards.ts` 里把它导出来）：

```ts
// prefix-cache.ts
import { fnv1a } from "./guards.js";
import type { ChatMessage } from "./llm.js";

/** 单条消息的指纹：JSON 序列化后取 FNV-1a */
export function fingerprintMessage(msg: ChatMessage): string {
  return fnv1a(JSON.stringify(msg));
}

export class CacheProbe {
  private prev: string[] = [];

  record(messages: ChatMessage[]): ProbeResult {
    const cur = messages.map(fingerprintMessage);

    let divergedAt: number | null = null;
    const minLen = Math.min(cur.length, this.prev.length);
    for (let i = 0; i < minLen; i++) {
      if (cur[i] !== this.prev[i]) {
        divergedAt = i;
        break;
      }
    }

    const sharedPrefix = divergedAt === null ? minLen : divergedAt;
    const first = this.prev.length === 0;
    this.prev = cur;
    return { prefixIntact: divergedAt === null, divergedAt, sharedPrefix, first };
  }
}
```

语义要说清楚：**尾部追加不算破坏**——`[a, b]` 变成 `[a, b, c]`，前缀完好，缓存从第 3 条开始续写。真正的破坏是**已有消息变了**：`[a, b, c]` 变成 `[a, x, c]`，从第 2 条起重算。探针只报后者。

为什么 `JSON.stringify` 够用？`ChatMessage` 由我们的 `toChatMessages` 构造，字段顺序固定，序列化逐字节确定。如果哪天你在消息里加了动态字段（时间戳、随机 id），探针会第一时间把它揪出来——这正是它的用途。

---

## Step 3：接入循环

`loop.ts` 里替换第一部的调用点。关键是 **projector 和 probe 都要跨轮持有**——状态在它们身上积累：

```ts
// LoopOptions 新增
/** 【进阶篇第 6 期新增】投影式压缩器：跨轮持有（anchor+摘要是状态） */
projector?: ContextProjector;
/** 【进阶篇第 6 期新增】前缀缓存探针：跨轮持有才有对比对象 */
cacheProbe?: CacheProbe;
```

```ts
// runAgent 每步开头，替换原来的 compactIfNeeded
// 【进阶篇第 6 期】投影式压缩：canonical 历史（messages）不动，
// 投影只影响发给 LLM 的上下文
const { projection, compacted } = await projector.project(messages);
if (compacted) {
  console.log(`📐 压缩：折叠线推进到第 ${projector.getAnchor()} 条，摘要 ${Math.ceil((projector.getSummary() ?? "").length / 4)} tokens`);
}
const chatMessages = toChatMessages(projection);

// 【进阶篇第 6 期】前缀缓存诊断：钉出缓存从哪条消息开始失效
const probe = cacheProbe.record(chatMessages);
if (!probe.first && !probe.prefixIntact) {
  console.log(`📐 缓存警报：前缀从第 ${probe.divergedAt} 条消息起失效（共有前缀 ${probe.sharedPrefix} 条）`);
}
```

---

## Step 4：实跑踩坑——滞回带

`demo-adv-06.ts` 把窗口故意调到 120 tokens（阈值 60），跑三轮真实对话。第一次实跑的输出很有教育意义——**每一步都在压缩**：

```text
📐 压缩事件：折叠线推进到第 5 条 ……
📐 缓存警报：前缀从第 0 条消息起失效（共有前缀 0 条）
📐 压缩事件：折叠线推进到第 6 条 ……
📐 缓存警报：前缀从第 0 条消息起失效（共有前缀 0 条）
📐 压缩事件：折叠线推进到第 7 条 ……
……
```

原因：窗口太小、摘要本身很长（~200 tokens），摘要 + 尾部**永远**超阈值，折叠线每一步都往前挪一格。每次压缩事件摘要内容必变 → 前缀从第 0 条起重算 → 缓存命中率恒为 0。压缩把自己压成了负优化。

这是经典的**抖动（thrashing）**：触发条件和收益条件没有间隔。修法是加一条滞回带（hysteresis）——压过一次之后，尾部新增量要够得上摘要体量的一半，才值得再压：

```ts
// 滞回带：从没压缩过随时可压；压过一次后，
// 尾部新增量要够得上摘要体量的一半才值得再压——
// 否则窗口小、摘要长时每一步都触发压缩事件，前缀缓存永远在重算，比不压还亏。
const grownEnough =
  this.summary === null ||
  tailTokens >= this.tailTokensAtLastCompaction + Math.ceil(summaryTokens / 2);

if (tokens >= contextWindow * ratio && grownEnough) { /* 压缩 */ }
```

加上滞回带后重跑，输出变成干净的三幕剧：

```text
════ 第 1 轮：用 bash 运行 ls -la，然后用 read 读 buggy.js 和 check.js，分别一句话说它们的作用。
📐 压缩事件：折叠线推进到第 1 条，摘要 330 字符：
📐 压缩：折叠线推进到第 1 条，摘要 83 tokens
📐 缓存警报：前缀从第 0 条消息起失效（共有前缀 0 条）
── 轮末盘点：canonical 4 条 | 折叠线 1 | 摘要已生成
════ 第 2 轮：用 bash 运行 node check.js，把完整输出告诉我。再用 write 把你对输出的分析写进 report.md。
📐 压缩事件：折叠线推进到第 3 条，摘要 612 字符：
📐 压缩：折叠线推进到第 3 条，摘要 153 tokens
📐 缓存警报：前缀从第 0 条消息起失效（共有前缀 0 条）
── 轮末盘点：canonical 8 条 | 折叠线 3 | 摘要已生成
════ 第 3 轮：根据前面看到的内容，一句话指出 bug 在哪。直接回答，不要调用任何工具。
── 轮末盘点：canonical 10 条 | 折叠线 3 | 摘要已生成
最终：canonical 历史 10 条一条不少；发给 LLM 的只是投影。
```

读法：

- 两次压缩事件各触发一次缓存警报——**这是预期的代价**：摘要内容变了，前缀必然从第 0 条重算。压缩用一次全量重算换之后所有请求的短前缀。
- 第 2 轮内部有多个 ReAct 步骤（bash、write），步骤之间探针全程安静——前缀完好，缓存正常续写。
- 第 3 轮超阈值但滞回带拦住了：折叠线停在 3，摘要没变，前缀没动。
- 轮末盘点那行是本期主题：**canonical 10 条一条不少，发给 LLM 的只是投影**。

顺带记录一个花絮：第一次实跑时，模型把任务里"不要修改文件"的约束抛在脑后，顺手把 buggy.js 修好了。我们在 system prompt 里加了"严禁修改任何已有文件"才拦住。这不影响本期主题，但提醒我们：压缩会丢掉细节，**模型对旧约束的记忆本来就靠不住**——护栏该硬就硬（第 4 期的失败守卫、第 7 期的路径权限，都是干这个的）。

---

## 确定性测试

`test-projection.ts` 用假摘要器把压缩行为钉死，12 组 21 断言。节选关键几组：

```ts
/** 假摘要器：记录被调次数与收到的 transcript */
function fakeSummarizer() {
  const calls: string[] = [];
  const fn = async (transcript: string) => {
    calls.push(transcript);
    return `摘要(${calls.length})：共 ${transcript.length} 字符`;
  };
  return { fn, calls };
}

// canonical 历史不被修改
const messages = [userMsg(1, 200), userMsg(2, 200), userMsg(3, 200), userMsg(4, 200)];
const lenBefore = messages.length;
const { projection, compacted } = await p.project(messages);
assert(compacted, "超阈值：触发压缩");
assert(messages.length === lenBefore, "canonical 历史不被修改");

// 已压缩且无新消息：投影逐字节一致，且不重复调摘要器
await p.project(messages);
const n = calls.length;
const a = await p.project(messages);
const b = await p.project(messages);
assert(calls.length === n, "已压缩且无新消息：不重复调摘要器");
const fa = toChatMessages(a.projection).map(fingerprintMessage);
const fb = toChatMessages(b.projection).map(fingerprintMessage);
assert(JSON.stringify(fa) === JSON.stringify(fb), "两次投影逐字节一致（前缀缓存的前提）");

// 增量摘要：第二次压缩时 transcript 里带上了旧摘要
assert(calls[0]!.includes("第 1 条") && !calls[0]!.includes("【已有摘要】"), "首次摘要：纯历史");
assert(calls[1]!.includes("【已有摘要】") && calls[1]!.includes("第 4 条"), "增量摘要：旧摘要+新折叠段");

// CacheProbe：中间消息被改 → 钉出分歧点
const tampered = [...base];
tampered[1] = { role: "user", content: "被篡改了" };
const r = probe.record(tampered);
assert(!r.prefixIntact && r.divergedAt === 1 && r.sharedPrefix === 1, "中间篡改：分歧点钉在第 1 条");

// 滞回带：新增量不足时忍住不压
messages.push(userMsg(4, 10));
const r = await p.project(messages);
assert(!r.compacted && p.getAnchor() === anchor1 && calls.length === 1, "滞回带：新增量不足时忍住不压");
```

`npx tsx test-projection.ts`，21 项全过。全套回归（前五期 + 本期共 6 个测试文件）：14 + 8 + 11 + 9 + 18 + 21 = **81 断言全绿**。

---

## 这期学到了什么

| 机制 | 规则 | 出处 |
|---|---|---|
| 投影式压缩 | canonical 不可变，折叠线 + 摘要是唯一状态 | "压缩是状态，不是变换" |
| 增量摘要 | 旧摘要 + 新折叠段滚动压缩，每段历史只被读一次 | 长会话压缩成本控制 |
| 摘要消息稳定 | 固定 id + 固定时间戳，内容只随压缩事件变 | 前缀缓存的逐字节契约 |
| 前缀哈希诊断 | 逐条消息指纹链对比，钉出分歧点 | CacheProbe |
| 滞回带 | 压过一次后，新增量够半份摘要才再压 | 防压缩抖动（实跑踩出来的） |

关键心智模型：**压缩是对历史的"投影"，不是对历史的"修改"。** canonical 历史是你的账本，永远完整可审计；投影是发给 LLM 的视图，可以丢细节。视图的所有变化都应该是**有意的、稀少的、可诊断的**——前缀缓存本质上是一份"逐字节稳定"的契约，CacheProbe 就是这份契约的守门人。

---

## 课后练习

1. 现在摘要失败时降级为全量尾部，可能直接撞模型的窗口上限报错。加一个最终兜底：摘要失败且仍超阈值时，机械丢弃 anchor 之前最旧的消息（不调 LLM），并打一条醒目的日志。
2. `CacheProbe` 只报分歧点，不统计账。给它加一个 `stats()` 方法：返回累计请求数、前缀完好次数、平均共有前缀长度——这就是你的缓存命中率看板。
3. 滞回带的"半份摘要"是个拍脑袋的常数。思考一个更讲究的方案：按 `contextWindow × ratio − 摘要 tokens` 的剩余空间比例来决定何时再压，并说明它在"摘要特别长"和"摘要特别短"两个极端下的行为。

---

## 下一期

护栏都装在主循环里，但真实的 Agent 会派**子代理**干活：让一个独立的循环去跑子任务，主循环只收一份结论。子代理一旦有工具权限，问题就来了——它往主代理的目录里乱写文件怎么办？下一期做 `task.ts` 子代理工具：**写路径就是权限边界**，子代理被圈在自己的沙箱目录里，跨界的写操作直接拒绝。
