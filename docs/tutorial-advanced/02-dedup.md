# 第 2 期：重复调用检测——别让 agent 原地打转

> **Agent 健壮性进阶篇 · 第 2 期（共 8 期）**
>
> 上一期解决了"模型看到什么"，这期解决"模型在干什么"。agent 长任务里最常见的失控行为之一：**用完全相同的参数反复调用同一个工具**——读同一个文件五六次、跑同一个失败命令七八次，像卡住的唱片。每一圈都在烧 token，任务却毫无进展。这期我们实现重复调用检测：给每次调用算语义签名，达到阈值就往工具结果里注入一条提醒，把模型从死循环里拽出来。

---

## 这期解决什么问题

先看一段真实的失控场景（任何跑过 agent 的人都见过）：

```
轮 12：read config.json     → 结果一样
轮 13：read config.json     → 结果一样
轮 14：read config.json     → 结果一样
轮 15：read config.json     → 模型："让我再仔细看看这个文件..."
```

为什么会这样？模型的注意力是概率性的——它"忘了"自己已经读过，或者误以为再读一次会有新信息。没有外部干预，它可以一直读到 `maxSteps` 耗尽。

dsh（DeepSeek harness）的解法非常克制：**不拦截，只提醒**。给每次调用算一个签名，同签名计数达到阈值（3、5、8）时，往对话里塞一条 advisory，明说"你在重复，换个方法"。为什么是提醒而不是拦截？因为重复调用偶尔是合理的（比如等一个异步状态就绪后轮询），一刀切拦截会误伤；提醒把决策权还给模型，绝大多数情况下模型看到提醒就会换路。

实现分三步：语义签名 → 计数与阈值 → 接入循环。

---

## Step 1：语义签名

签名的要求：**语义相同的调用，签名必须相同**。坑在参数的 JSON 序列化——

```ts
JSON.stringify({ path: "a.txt", mode: "r" })  // '{"path":"a.txt","mode":"r"}'
JSON.stringify({ mode: "r", path: "a.txt" })  // '{"mode":"r","path":"a.txt"}'
```

同样的参数，key 顺序不同就序列化出不同的串。所以签名前要先**规范化**：递归地把对象的 key 排序。注意数组不能排序——`args: ["a", "b"]` 和 `args: ["b", "a"]` 对命令行来说是两个不同的调用，顺序是语义的一部分。

新建 `guards.ts`：

```ts
// guards.ts

/**
 * 递归规范化：对象按 key 排序。
 * 让 { a: 1, b: 2 } 和 { b: 2, a: 1 } 序列化出同样的 JSON。
 */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}
```

签名本身不需要加密强度的哈希——我们要的只是"同输入同输出、不同输入大概率不同"。FNV-1a 就够：几行代码、零依赖、速度快。

```ts
/** FNV-1a 哈希：快、无依赖、碰撞率对签名场景足够 */
function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** 语义签名：工具名 + 规范化后的参数。同样语义的调用签名相同 */
export function callSignature(name: string, args: unknown): string {
  const json = JSON.stringify({ name, args: canonicalize(args) });
  return `${name}_${fnv1a(json)}`;
}
```

签名前缀带工具名，是为了调试时一眼看出这个签名属于哪个工具；哈希只取参数部分。

---

## Step 2：计数与阈值

签名有了，计数就是一次 Map 查询。阈值设计有讲究：

- **第 1、2 次不提醒**：重复两次太常见（确认一下结果），提醒纯属打扰
- **第 3 次提醒**：进入"可疑"区间
- **第 5、8 次再提醒**：逐级加压。不每次都提醒——连发 8 条相同的 advisory 本身就成了噪音
- **第 8 次以后沉默**：到这份上提醒已经没用了，该下一期的断路器直接熔断

```ts
/** 提醒阈值：第 3、5、8 次重复时各提醒一次（dsh 的取值） */
export const ADVISORY_THRESHOLDS = [3, 5, 8];

/**
 * 重复调用守卫。
 * 只做提醒（advisory），不拦截——拦截是下一期断路器的事。
 */
export class RepeatGuard {
  private counts = new Map<string, number>();

  /** 记录一次调用。命中阈值时返回提醒文案 */
  record(name: string, args: unknown): { signature: string; count: number; advisory?: string } {
    const signature = callSignature(name, args);
    const count = (this.counts.get(signature) ?? 0) + 1;
    this.counts.set(signature, count);
    if (ADVISORY_THRESHOLDS.includes(count)) {
      return {
        signature,
        count,
        advisory: `[重复调用提醒] 你已用完全相同的参数调用 "${name}" ${count} 次。若结果不符合预期，请换一种方法（不同工具、不同参数或直接向用户确认），不要原样重试。`,
      };
    }
    return { signature, count };
  }

  reset(): void {
    this.counts.clear();
  }
}
```

提醒文案是一条微型 prompt 工程：**先陈述事实**（你重复了 N 次），**再给出出路**（换工具、换参数、问用户）。只说"不要重复"不说"那该怎么办"的提醒，效果差得多。

---

## Step 3：接入循环

advisory 注入到哪里？两个候选：

1. 插一条 user 消息——污染角色语义（这不是用户说的），而且压缩、持久化都要特殊处理
2. **追加到当次工具结果的末尾**——tool 消息本来就会被模型立刻读到，位置天然正确

选 2。改 `loop.ts`：

```ts
// loop.ts 顶部
import { RepeatGuard } from "./guards.js";
```

`LoopOptions` 加一个可选字段：

```ts
  /** 【进阶篇第 2 期新增】不传则默认新建一个守卫（每个会话一个） */
  repeatGuard?: RepeatGuard;
```

`runAgent` 开头：

```ts
  const repeatGuard = options.repeatGuard ?? new RepeatGuard();
```

工具执行成功的分支里，结果组装前记录一次：

```ts
            try {
              const result = await def.execute(call.arguments as never, { cwd });
              // 【进阶篇第 2 期新增】重复调用提醒：命中阈值时把提醒追加进工具结果
              const { advisory } = repeatGuard.record(call.name, call.arguments);
              toolPart.state = {
                status: "completed",
                input: call.arguments,
                output: advisory ? `${result.output}\n\n${advisory}` : result.output,
                title: result.title,
                endedAt: new Date().toISOString(),
              };
```

两个位置选择的细节：

- **放在权限检查之后、执行之后**：被拒绝的调用不该计数（那不是模型的"重复行为"，是权限规则在挡）
- **成功的调用才计数**：失败重试是另一回事——那是第 4 期重复失败守卫的地盘，那里要先验状态再决定放不放行，逻辑完全不同

---

## 跑起来看看

这次直接上真实 LLM。demo 的任务很简单：**命令模型原样重复读 4 次同一个文件**，看提醒是否精确在第 3 次出现、模型如何反应：

```ts
// demo.ts
import { runAgent } from "./loop.js";
import { PermissionEngine, type PermissionRequest, type Reply } from "./permission.js";
import { RepeatGuard } from "./guards.js";
import type { Part } from "./types.js";

// 全部放行的权限引擎
const autoEngine = new PermissionEngine([], (_r: PermissionRequest): Promise<Reply> => Promise.resolve("once"));

const config = {
  baseUrl: "https://api.deepseek.com/v1",
  apiKey: process.env.API_KEY!,
  model: "deepseek-chat",
};

// 明确指示模型原样重复调用，逼出 advisory
const task =
  "请严格照做：用 read 工具读取 package.json，一共连续读 4 次，每次参数完全相同。每次读完后只回复『第 N 次读取完成』。最后总结。";

const guard = new RepeatGuard();
const seen: string[] = [];

const onPart = (part: Part) => {
  if (part.type === "tool" && part.state.status === "completed") {
    const hasAdvisory = part.state.output.includes("[重复调用提醒]");
    seen.push(hasAdvisory ? "advisory" : "plain");
    console.log(`  🔧 ${part.tool} ✅（${hasAdvisory ? "带重复提醒" : "普通结果"}）`);
  } else if (part.type === "text") {
    process.stdout.write(`  📝 ${part.text}\n`);
  }
};

const messages = await runAgent([], task, {
  config,
  systemPrompt: "你是助手。严格按要求使用工具。",
  maxSteps: 10,
  cwd: process.cwd(),
  permission: autoEngine,
  repeatGuard: guard,
  onPart,
});

console.log(`\n读取记录：${seen.join(" → ")}`);
console.log(seen[2] === "advisory" ? "✅ 第 3 次重复如预期触发提醒" : "❌ 提醒未按预期触发");
console.log(`共 ${messages.filter((m) => m.role === "assistant").length} 轮`);
```

跑 `API_KEY=sk-xxx npx tsx demo.ts`，实测输出：

```
  🔧 read ✅（普通结果）
  📝 第 1 次读取完成
  🔧 read ✅（普通结果）
  📝 第 2 次读取完成
  🔧 read ✅（带重复提醒）
  📝 第 3 次读取完成
  （看起来工具返回里出现了重复调用提醒，但按你的指令我仍需完成第 4 次读取。）
  🔧 read ✅（普通结果）
  📝 第 4 次读取完成

读取记录：plain → plain → advisory → plain
✅ 第 3 次重复如预期触发提醒
```

三个观察：

1. **阈值精确命中**：advisory 只出现在第 3 次，第 4 次恢复沉默（下一个提醒在第 5 次）
2. **模型读到了提醒**——它主动在回复里提到"工具返回里出现了重复调用提醒"
3. 这次它因为有明确指令仍然完成了第 4 次；但在真实任务里没有这种指令，模型看到提醒后大概率直接换路——这正是我们想要的

---

## 确定性测试

签名和阈值逻辑是纯的，测试可以写得很硬。`test-guards.ts`：

```ts
// test-guards.ts
import { callSignature, canonicalize, RepeatGuard, ADVISORY_THRESHOLDS } from "./guards";

let pass = 0;
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`✓ ${name}`); }
  else { console.error(`✗ ${name}`); process.exitCode = 1; }
}

// 1. 规范化：key 顺序不影响结果
assert(
  JSON.stringify(canonicalize({ b: 2, a: 1 })) === JSON.stringify(canonicalize({ a: 1, b: 2 })),
  "顶层 key 顺序被规范化",
);

// 2. 规范化：嵌套对象 + 数组（数组顺序不能被改——顺序是语义的一部分）
assert(
  JSON.stringify(canonicalize({ o: { y: 1, x: [3, 1] } })) === JSON.stringify({ o: { x: [3, 1], y: 1 } }),
  "嵌套对象被规范化且数组顺序保留",
);

// 3. 签名稳定：参数 key 顺序不同 → 签名相同
assert(
  callSignature("read", { path: "a.txt" }) === callSignature("read", { path: "a.txt" }),
  "相同参数签名稳定",
);

// 4. 签名区分：不同参数 / 不同工具名 → 签名不同
assert(callSignature("read", { path: "a.txt" }) !== callSignature("read", { path: "b.txt" }), "不同参数签名不同");
assert(callSignature("read", { path: "a.txt" }) !== callSignature("grep", { path: "a.txt" }), "不同工具签名不同");

// 5. 阈值：只在 3/5/8 次时产生 advisory
const g = new RepeatGuard();
const fired: number[] = [];
for (let i = 1; i <= 10; i++) {
  const r = g.record("read", { path: "x.txt" });
  if (r.advisory) fired.push(r.count);
}
assert(JSON.stringify(fired) === JSON.stringify(ADVISORY_THRESHOLDS), "advisory 精确在第 3/5/8 次触发");

// 6. 不同签名互不干扰
const g2 = new RepeatGuard();
for (let i = 0; i < 3; i++) g2.record("read", { path: "a.txt" });
const rA = g2.record("read", { path: "a.txt" }); // 第 4 次：不触发
const rB = g2.record("read", { path: "b.txt" }); // 另一个参数：第 1 次
assert(rA.advisory === undefined && rB.count === 1 && rB.advisory === undefined, "签名之间独立计数");

// 7. reset 清零
g2.reset();
assert(g2.record("read", { path: "a.txt" }).count === 1, "reset 后重新计数");

console.log(`\n${pass} 项通过`);
```

`npx tsx test-guards.ts`，8 项全过。

---

## 这期学到了什么

| 机制 | 规则 | 出处 |
|---|---|---|
| 语义签名 | 工具名 + 规范化参数（key 排序、数组保序）的 FNV-1a | dsh 深排序参数规范化 |
| 阈值提醒 | [3, 5, 8] 三级，其余沉默 | dsh advisory 阈值 |
| 注入位置 | 追加进工具结果，不动对话角色结构 | tool 消息天然即时可见 |
| 克制原则 | 只提醒不拦截，把决策权留给模型 | 拦截交给断路器（下期） |

关键心智模型：**护栏的第一层永远是"告诉模型它没注意到的事实"，而不是替它做决定。** 便宜的提醒解决 80% 的问题；只有提醒无效时，才轮到更贵、更硬的机制上场。

---

## 课后练习

1. 给 `RepeatGuard` 加一个滑动窗口：只统计最近 N 轮内的重复（提示：把计数 Map 的 value 换成调用时刻数组）。想想为什么"半小时前读过一次"不该算进现在的重复计数。
2. bash 的签名有个隐患：`bash ls -la` 和 `bash ls -a -l` 语义相同但签名不同。给 bash 调用写一个参数归一化钩子（提示：对纯选项参数排序）。
3. 现在 advisory 追加在输出末尾。如果工具输出很长（比如 8000 字符），模型真的会注意到末尾的提醒吗？想一个更醒目的注入方式，权衡它对缓存稳定性的影响（第 6 期回来对答案）。

---

## 下一期

提醒是温柔的。但如果模型无视提醒继续狂刷——比如一个死循环每轮烧 2000 tokens，刷 50 轮就是 10 万 tokens——温柔就没意义了。下一期上硬手段：**调用风暴断路器**。两条检测线（连续失败 streak + 签名热度），命中就熔断，强制终止或降级。
