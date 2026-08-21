# 第 3 期：调用风暴断路器——烧钱前熔断

> **Agent 健壮性进阶篇 · 第 3 期（共 8 期）**
>
> 上一期的提醒是温柔的：模型大多数时候会听劝，但总有不听的时候——尤其是用户指令本身就在逼它重复（"重试到成功为止"）。温柔无效时，需要硬手段。这期我们实现调用断路器：两条检测线命中任何一条就熔断，熔断后所有工具调用直接拒绝。这是从微服务领域借来的经典模式，装进 agent 循环。

---

## 这期解决什么问题

算一笔账。一个失控循环：每轮工具调用 + 上下文约 2000 tokens，模型每 2 秒一轮，刷 100 轮 = 20 万 tokens ≈ 几块钱——听起来不多？但生产 agent 是并发的，100 个会话同时失控就是几百块一小时，而且产出的全是垃圾。**断路器的职责不是让任务成功，是在方法明显错误时立刻止损。**

两条检测线，对应两种失控形态：

| 检测线 | 失控形态 | 例子 |
|---|---|---|
| **streak（连续失败）** | 方法错了，一直在撞墙 | 同一个编译错误修了 5 次还没过 |
| **heat（签名热度）** | 在原地打转 | 60 秒内同一个 read 调了 10 次 |

streak 针对"失败"，heat 针对"重复"——第 2 期的 RepeatGuard 数重复但只提醒，这里数到更狠的程度直接停。

状态机用电气断路器的经典三态：

```
closed（合闸，正常放行）
   │ 连续失败 ≥ streakLimit 或 热度 ≥ heatLimit
   ▼
open（熔断，一切调用直接拒绝）
   │ 冷却 cooldownMs 后
   ▼
half-open（半开，放行一次试探）
   │ 试探成功 → closed；试探失败 → open（重新计时）
```

---

## Step 1：先给工具一个"失败信号"

写断路器之前，先补一个第一部欠下的债：**工具失败了，循环怎么知道？**

看 `bashTool`：命令退出码非 0 时，它走 catch 分支，返回一个"正常"的 `ToolResult`（title 是"node 失败"），**不抛异常**。这其实是合理的设计——工具本身运转正常，是命令失败了；`error` 状态应该留给工具自身坏掉（文件不存在、权限拒绝）。但循环因此丢失了成败信号。

补一个 metadata 标记即可，改 `tools.ts` 的 bashTool catch 分支：

```ts
      const { text } = trimToolOutput(output, true);
      return {
        title: `${args.program} 失败`,
        output: `$ ${args.program} ${(args.args ?? []).join(" ")}\n${text}`,
        // 【进阶篇第 3 期】失败信号：退出码非 0。断路器的 streak 检测靠它
        metadata: { failed: true },
      };
```

约定：`metadata.failed === true` 表示"工具跑完了，但业务上失败了"。断路器只看这个信号。

---

## Step 2：断路器本体

新建 `breaker.ts`。签名复用上一期的 `callSignature`：

```ts
// breaker.ts
import { callSignature } from "./guards.js";

/** 断路器三态（电气断路器的经典模型） */
export type BreakerState = "closed" | "open" | "half-open";

export type BreakerOptions = {
  streakLimit: number;   // 连续失败几次就熔断
  heatLimit: number;     // 滑动窗口内同签名调用几次算"风暴"
  windowMs: number;      // 热度统计的滑动窗口
  cooldownMs: number;    // 熔断后冷却多久进入 half-open
};

export class BreakerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BreakerError";
  }
}

/**
 * 调用断路器：两条检测线。
 * 1. streak——连续失败 streakLimit 次：方法错了，别再试了
 * 2. heat——窗口内同签名调用超过 heatLimit 次：在原地打转
 * 熔断后所有调用直接抛 BreakerError（工具转为 error 状态），
 * 冷却期后进入 half-open 放行一次试探，成功则合闸。
 */
export class CallBreaker {
  private state: BreakerState = "closed";
  private failureStreak = 0;
  private openedAt = 0;
  private reason = "";
  /** 最近调用记录（签名 + 时刻），滑动窗口用 */
  private recent: { sig: string; at: number }[] = [];

  constructor(private opts: BreakerOptions = {
    streakLimit: 5,
    heatLimit: 10,
    windowMs: 60_000,
    cooldownMs: 30_000,
  }) {}

  getState(): BreakerState {
    return this.state;
  }

  /**
   * 调用前检查。熔断中且未到冷却期 → 抛错；
   * 到了冷却期 → 转 half-open 放行一次试探。
   */
  check(): void {
    if (this.state === "open") {
      if (Date.now() - this.openedAt >= this.opts.cooldownMs) {
        this.state = "half-open";
        return; // 放行试探
      }
      throw new BreakerError(`断路器已熔断（${this.reason}）。请停止当前方法，换一种思路或向用户报告。`);
    }
  }

  /** 调用后记账。ok=false 累计 streak；ok=true 清零并可能合闸 */
  recordResult(ok: boolean, name: string, args: unknown): void {
    const now = Date.now();

    if (this.state === "half-open") {
      // 试探结果决定合闸还是重新熔断
      if (ok) {
        this.state = "closed";
        this.failureStreak = 0;
        this.recent = [];
      } else {
        this.trip("试探调用仍然失败");
      }
      return;
    }

    // streak 检测
    if (ok) {
      this.failureStreak = 0;
    } else {
      this.failureStreak++;
      if (this.failureStreak >= this.opts.streakLimit) {
        this.trip(`连续 ${this.failureStreak} 次调用失败`);
        return;
      }
    }

    // heat 检测：滑动窗口内同签名次数
    const sig = callSignature(name, args);
    this.recent.push({ sig, at: now });
    this.recent = this.recent.filter((r) => now - r.at <= this.opts.windowMs);
    const heat = this.recent.filter((r) => r.sig === sig).length;
    if (heat >= this.opts.heatLimit) {
      this.trip(`${this.opts.windowMs}ms 内同一调用出现 ${heat} 次`);
    }
  }

  private trip(reason: string): void {
    this.state = "open";
    this.reason = reason;
    this.openedAt = Date.now();
  }
}
```

几个设计决策：

- **check/recordResult 分离**：检查在调用前，记账在调用后——和循环的两个位置天然对应，也方便测试时单独驱动
- **滑动窗口用数组 + filter**：O(n) 但窗口内元素极少（几十个），比引入双向链表实在
- **BreakerError 是具名错误类型**：循环要能区分"断路器拦的"和"工具真坏了"，前者文案是引导模型换路，后者是报告异常
- **half-open 的试探成功要清账**：streak 和窗口都清零，否则会带着旧账合闸，下一秒又熔断

---

## Step 3：接入循环

改 `loop.ts`，两个位置：

```ts
// 顶部
import { CallBreaker, BreakerError } from "./breaker.js";

// LoopOptions
  /** 【进阶篇第 3 期新增】不传则用默认参数新建一个断路器 */
  breaker?: CallBreaker;

// runAgent 开头
  const breaker = options.breaker ?? new CallBreaker();
```

**位置一：权限检查之前。** 熔断期间的调用连权限询问都不该触发（用户不想被一堆"是否允许"轰炸一个已经在空转的 agent）：

```ts
        if (toolPart) {
          // 【进阶篇第 3 期新增】断路器检查：熔断中直接转 error，不再执行
          try {
            breaker.check();
          } catch (error) {
            if (error instanceof BreakerError) {
              toolPart.state = {
                status: "error",
                input: call.arguments,
                error: error.message,
                endedAt: new Date().toISOString(),
              };
              onPart?.(toolPart);
              continue;
            }
            throw error;
          }
          // ……后面是第一部原有的权限检查、执行逻辑
```

**位置二：执行之后记账。** 成功失败都要记：

```ts
            try {
              const result = await def.execute(call.arguments as never, { cwd });
              const { advisory } = repeatGuard.record(call.name, call.arguments);
              // 【进阶篇第 3 期新增】断路器记账：metadata.failed 是工具的失败信号
              const failed = result.metadata?.failed === true;
              breaker.recordResult(!failed, call.name, call.arguments);
              // ……组装 completed 状态（略，与上期相同）
            } catch (error) {
              // 【进阶篇第 3 期新增】抛异常也算一次失败
              breaker.recordResult(false, call.name, call.arguments);
              // ……组装 error 状态（略）
```

熔断后的行为链条值得看清楚：断路器不崩溃、不退进程，只是把工具调用变成带引导文案的 error——模型读到"请停止当前方法，换一种思路或向用户报告"，大概率转为纯文本回复，循环自然结束。**硬护栏的出口仍然是软着陆。**

---

## 跑起来看看

demo 逼模型撞断路器：`bad.js` 是个必挂脚本（`throw new Error("boom")`），指令要求"原样重试到成功，不许放弃"。注意我们显式传入一个静默的 RepeatGuard（`thresholds: []`），否则上一期的提醒会先劝停模型，断路器就没机会出场了：

```ts
// demo.ts
import { runAgent } from "./loop.js";
import { PermissionEngine, type PermissionRequest, type Reply } from "./permission.js";
import { CallBreaker } from "./breaker.js";
import { RepeatGuard } from "./guards.js";
import type { Part } from "./types.js";

const autoEngine = new PermissionEngine([], (_r: PermissionRequest): Promise<Reply> => Promise.resolve("once"));

const config = {
  baseUrl: "https://api.deepseek.com/v1",
  apiKey: process.env.API_KEY!,
  model: "deepseek-chat",
};

// bad.js 必挂。指令逼模型一直原样重试，直到断路器出手
const task =
  "运行 node bad.js。如果失败，必须用完全相同的命令重试，一直重试到它成功为止，中途不要放弃、不要换命令、不要修改任何文件。";

const breaker = new CallBreaker({ streakLimit: 5, heatLimit: 10, windowMs: 120_000, cooldownMs: 60_000 });
// 本期只测断路器：把重复提醒静默掉，防止模型被上期护栏提前劝停
const quietGuard = new RepeatGuard({ thresholds: [] });

const onPart = (part: Part) => {
  if (part.type === "tool") {
    const s = part.state;
    if (s.status === "completed") console.log(`  🔧 ${part.tool} ✅ ${s.title}`);
    else if (s.status === "error") console.log(`  🔧 ${part.tool} ❌ ${s.error.slice(0, 60)}...`);
  } else if (part.type === "text") {
    process.stdout.write(`  📝 ${part.text}\n`);
  }
};

const messages = await runAgent([], task, {
  config,
  systemPrompt: "你是助手。严格按要求使用工具。",
  maxSteps: 12,
  cwd: process.cwd(),
  permission: autoEngine,
  repeatGuard: quietGuard,
  breaker,
  onPart,
});

console.log(`\n断路器最终状态：${breaker.getState()}`);
```

实测输出（节选）：

```
  🔧 bash ✅ node 失败
  📝 Failed again. ... Let me continue retrying, and also examine the file.
  🔧 read ✅ 读取 bad.js（56 字符）
  📝 I can see the file always throws an error... per the instructions, I must keep retrying.
  🔧 bash ✅ node 失败
  🔧 bash ✅ node 失败
  🔧 bash ✅ node 失败
  🔧 bash ✅ node 失败
  🔧 bash ✅ node 失败
  🔧 bash ❌ 断路器已熔断（连续 5 次调用失败）。请停止当前方法...
  🔧 bash ❌ 断路器已熔断（连续 5 次调用失败）。请停止当前方法...

断路器最终状态：open
```

这段真实输出里藏着两个教科书级细节：

1. **中间那次 `read bad.js` 成功，把 streak 清零了**。所以熔断不是发生在"总第 5 次失败"，而是发生在 read 之后的"连续第 5 次失败"——这正是"成功清零"规则在真实循环里的样子
2. 熔断后模型又发起了几次调用，全部被**即时拒绝**（没有执行、没有等待），每次只花一条 error 消息的成本。风暴被钉死在原地

---

## 确定性测试

状态机这种东西，必须用测试把每条边都踩一遍。`test-breaker.ts` 共 7 组 11 断言：

```ts
// test-breaker.ts
import { CallBreaker, BreakerError } from "./breaker";

let pass = 0;
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`✓ ${name}`); }
  else { console.error(`✗ ${name}`); process.exitCode = 1; }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 1. 未达 streakLimit 不熔断
{
  const b = new CallBreaker({ streakLimit: 5, heatLimit: 100, windowMs: 60_000, cooldownMs: 1_000 });
  for (let i = 0; i < 4; i++) b.recordResult(false, "bash", { program: "node", args: ["x.js"] });
  assert(b.getState() === "closed", "4 次连续失败不熔断");
}

// 2. 第 5 次失败熔断，check 抛 BreakerError
{
  const b = new CallBreaker({ streakLimit: 5, heatLimit: 100, windowMs: 60_000, cooldownMs: 60_000 });
  for (let i = 0; i < 5; i++) b.recordResult(false, "bash", { program: "node", args: ["x.js"] });
  assert(b.getState() === "open", "第 5 次连续失败触发熔断");
  let threw = false;
  try { b.check(); } catch (e) { threw = e instanceof BreakerError; }
  assert(threw, "熔断后 check 抛 BreakerError");
}

// 3. 成功清零 streak
{
  const b = new CallBreaker({ streakLimit: 5, heatLimit: 100, windowMs: 60_000, cooldownMs: 1_000 });
  for (let i = 0; i < 4; i++) b.recordResult(false, "bash", { program: "node" });
  b.recordResult(true, "bash", { program: "node" });
  for (let i = 0; i < 4; i++) b.recordResult(false, "bash", { program: "node" });
  assert(b.getState() === "closed", "中间一次成功清零 streak");
}

// 4. heat：窗口内同签名达到 heatLimit 熔断
{
  const b = new CallBreaker({ streakLimit: 100, heatLimit: 10, windowMs: 60_000, cooldownMs: 1_000 });
  for (let i = 0; i < 9; i++) b.recordResult(true, "read", { path: "a.txt" });
  assert(b.getState() === "closed", "9 次同签名不熔断");
  b.recordResult(true, "read", { path: "a.txt" });
  assert(b.getState() === "open", "第 10 次同签名触发熔断");
}

// 5. heat：不同签名不累计
{
  const b = new CallBreaker({ streakLimit: 100, heatLimit: 10, windowMs: 60_000, cooldownMs: 1_000 });
  for (let i = 0; i < 12; i++) b.recordResult(true, "read", { path: `file-${i}.txt` });
  assert(b.getState() === "closed", "不同参数的调用不累计热度");
}

// 6. 冷却后进 half-open，试探成功则合闸
{
  const b = new CallBreaker({ streakLimit: 2, heatLimit: 100, windowMs: 60_000, cooldownMs: 20 });
  b.recordResult(false, "bash", { program: "node" });
  b.recordResult(false, "bash", { program: "node" });
  assert(b.getState() === "open", "2 次失败熔断（streakLimit=2）");
  await sleep(30);
  b.check(); // 不该抛，且转 half-open
  assert(b.getState() === "half-open", "冷却期后转 half-open");
  b.recordResult(true, "bash", { program: "node" });
  assert(b.getState() === "closed", "试探成功合闸");
}

// 7. half-open 试探失败 → 重新熔断
{
  const b = new CallBreaker({ streakLimit: 2, heatLimit: 100, windowMs: 60_000, cooldownMs: 20 });
  b.recordResult(false, "bash", { program: "node" });
  b.recordResult(false, "bash", { program: "node" });
  await sleep(30);
  b.check();
  b.recordResult(false, "bash", { program: "node" });
  assert(b.getState() === "open", "试探失败重新熔断");
}

console.log(`\n${pass} 项通过`);
```

`npx tsx test-breaker.ts`，11 项全过。注意第 6、7 组用了 20ms 的超短冷却期——测试状态机时把时间参数调到毫秒级，比 mock 时钟简单得多。

---

## 这期学到了什么

| 机制 | 规则 | 出处 |
|---|---|---|
| streak 检测 | 连续失败 ≥ 5 熔断，任何成功清零 | Reasonix streak 检测 |
| heat 检测 | 滑动窗口内同签名 ≥ 10 熔断 | Reasonix signature 检测 |
| 三态状态机 | closed → open → half-open（试探） | 微服务断路器经典模型 |
| 失败信号 | `metadata.failed` 区分"命令失败"与"工具坏掉" | 工具层与护栏层的契约 |
| 软着陆 | 熔断不崩进程，把调用变成带引导的 error | 硬护栏的出口仍是模型可理解的信号 |

关键心智模型：**护栏的强度要分级——提醒（2 期）→ 熔断（本期）→ 恢复（第 8 期）。每一级都比上一级贵，所以只在上一级失效时才出手。**

---

## 课后练习

1. 现在全局只有一个断路器：bash 连挂 4 次后，一次成功的 read 就清了账。如果给每类工具（bash / edit / read）各一个断路器实例，行为会更合理吗？循环要怎么改？想想代价。
2. 加第三条检测线：**预算轴**。累计 token 或金额超过预算直接熔断（提示：`recordResult` 加一个 `tokens` 参数）。Reasonix 称之为成本控制三轴之一。
3. half-open 放行的"试探"是模型发起的下一次调用——很可能还是那个失败的原命令。如果允许你在 half-open 时改写试探参数（比如加个 `--verbose`），值不值得做？

---

## 下一期

断路器拦的是"风暴"，但还有一种更隐蔽的浪费：**失败后的盲目重试**。模型改了代码再跑测试，失败；再改再跑，还是失败——每次都"看起来不一样"，所以签名和 streak 都拦不住。下一期我们做重复失败守卫：重试前先做一次状态复查，确认目标真的还没达成，再决定放不放行。
